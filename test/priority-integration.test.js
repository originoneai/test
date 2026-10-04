// End-to-end priority journey over the real server process and the board's
// real HTTP adapter: create with priority, filtered reads, restart
// durability, and unknown-outcome recovery for a priority edit. These checks
// state the adapter and save-confirmation behavior the board must provide; a
// failure identifies priority forwarding or verification the board module
// does not provide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpAdapter, matchesSubmitted } from '../public/app.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(repoRoot, 'src/server.js');

// Borrow a free port, then boot the real `node src/server.js` the way a
// contributor does (same contract as test/integration.test.js).
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function startTracker(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  const logText = () => Buffer.concat(chunks).toString('utf8');
  const closedPromise = new Promise((resolveClosed) =>
    child.once('close', (code, signal) => resolveClosed({ code, signal })),
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    let killTimer = null;
    try {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }
      await closedPromise;
    } finally {
      if (killTimer !== null) clearTimeout(killTimer);
    }
  };
  try {
    await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        child.removeListener('close', onClose);
        child.removeListener('error', onError);
        if (error) rejectReady(error);
        else resolveReady();
      };
      const timeout = setTimeout(
        () => finish(new Error('server did not announce readiness; log: ' + logText())),
        10_000,
      );
      const poll = setInterval(() => {
        if (logText().includes(`http://127.0.0.1:${port}`)) finish();
      }, 25);
      const onClose = (code) => finish(new Error('server closed before readiness with ' + code + '; log: ' + logText()));
      const onError = (error) => finish(new Error('server failed to start: ' + error.message));
      child.once('close', onClose);
      child.once('error', onError);
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { base: `http://127.0.0.1:${port}`, stop };
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'priority-int-'));
  try {
    await run(root, join(root, 'live'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('adapter journey: create with priority, filter through the adapter, restart keeps it', async () => {
  await withRoot(async (root, dataDir) => {
    let createdHigh;
    const one = await startTracker(dataDir);
    try {
      const adapter = createHttpAdapter({ base: one.base });
      createdHigh = await adapter.create({ title: 'Journey high', description: 'shared body', priority: 'high' });
      await adapter.create({ title: 'Journey low', description: 'shared body', priority: 'low' });

      assert.equal(createdHigh.priority, 'high', 'the adapter-created record echoes priority');
      assert.deepEqual(
        Object.keys(createdHigh).sort(),
        ['createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt'],
        'full seven-field record through the adapter',
      );

      const onlyHigh = await adapter.list({ priority: 'high' });
      assert.deepEqual(
        onlyHigh.map((issue) => issue.title),
        ['Journey high'],
        'the adapter must forward the priority filter to the server',
      );

      const composed = await adapter.list({ priority: 'high', status: 'open', q: 'shared' });
      assert.deepEqual(composed.map((issue) => issue.title), ['Journey high'], 'the priority filter must compose with status and q');
    } finally {
      await one.stop();
    }

    const raw = JSON.parse(await readFile(join(dataDir, 'issues.json'), 'utf8'));
    assert.deepEqual(
      raw.issues.map((issue) => issue.priority),
      ['high', 'low'],
      'the durable file holds the priorities before restart',
    );

    const two = await startTracker(dataDir);
    try {
      const adapter = createHttpAdapter({ base: two.base });
      const after = await adapter.list({ priority: 'high' });
      assert.deepEqual(
        after.map((issue) => issue.id),
        [createdHigh.id],
        'the adapter must forward the priority filter after a restart too',
      );
    } finally {
      await two.stop();
    }
  });
});

test('unknown-outcome priority save recovers by refresh-and-compare, never blind retry', async () => {
  await withRoot(async (root, dataDir) => {
    const one = await startTracker(dataDir);
    try {
      const client = () => createHttpAdapter({ base: one.base });
      const current = async (id) => (await client().list({})).find((item) => item.id === id);
      const dropAfterSend = (...args) =>
        globalThis.fetch(...args).then((res) => {
          if (res.body && typeof res.body.cancel === 'function') res.body.cancel();
          throw new TypeError('simulated connection drop after the request was sent');
        });
      const dropping = () => createHttpAdapter({ base: one.base, fetchImpl: dropAfterSend });

      const landed = await client().create({ title: 'Dropped priority save', priority: 'low' });
      await assert.rejects(
        dropping().update(landed.id, { priority: 'urgent' }),
        (err) => err instanceof Error && err.outcomeUnknown === true,
        'a dropped save reports an unknown outcome',
      );
      const seenAfterDrop = await current(landed.id);
      assert.equal(seenAfterDrop.priority, 'urgent', 'the server did land the priority change');
      assert.equal(
        matchesSubmitted(seenAfterDrop, { priority: 'urgent' }),
        true,
        'the landed change confirms the submitted priority',
      );
      assert.equal(
        matchesSubmitted(seenAfterDrop, { priority: 'low' }),
        false,
        'refresh-and-compare must distinguish priority values',
      );
    } finally {
      await one.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Six-field legacy journey over the real server and adapter (second feedback)
// ---------------------------------------------------------------------------

// Case-unique pre-priority fixture for the adapter journey; its own UUID
// namespace, separate from the store-level and API-level legacy fixtures.
const LEGACY_INT_ID_A = 'd4c3b2a1-6f5e-4d7c-9b8a-1e3f5a7c9e1f';
const LEGACY_INT_ID_B = 'd4c3b2a1-6f5e-4d7c-9b8a-1e3f5a7c9e20';
const SEVEN_FIELDS = ['createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt'];
const legacyIntegrationBytes = () =>
  JSON.stringify({
    issues: [
      {
        id: LEGACY_INT_ID_A,
        title: 'Adapter legacy open card',
        description: 'pre-priority text',
        status: 'open',
        createdAt: '2024-02-29T08:00:00Z',
        updatedAt: '2024-02-29T09:30:00Z',
      },
      {
        id: LEGACY_INT_ID_B,
        title: 'Adapter legacy doing card',
        description: '',
        status: 'in_progress',
        createdAt: '2026-02-28T12:34:56Z',
        updatedAt: '2026-02-28T12:34:56.250Z',
      },
    ],
  });

test('legacy journey: the adapter reads a legacy board as Normal and its first save upgrades it', async () => {
  await withRoot(async (root, dataDir) => {
    const bytes = legacyIntegrationBytes();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'issues.json'), bytes, 'utf8');
    const one = await startTracker(dataDir);
    try {
      const adapter = createHttpAdapter({ base: one.base });

      const legacyList = await adapter.list({});
      assert.deepEqual(
        legacyList.map((issue) => [issue.title, issue.priority]),
        [
          ['Adapter legacy doing card', 'normal'],
          ['Adapter legacy open card', 'normal'],
        ],
        'the board adapter serves legacy records as Normal',
      );
      assert.ok(
        legacyList.every((issue) => SEVEN_FIELDS.every((field) => field in issue)),
        'served legacy records carry the full contract shape',
      );

      const onlyNormal = await adapter.list({ priority: 'normal', q: 'adapter' });
      assert.equal(onlyNormal.length, 2, 'the adapter composes the priority filter with search over legacy data');
      const noneUrgent = await adapter.list({ priority: 'urgent' });
      assert.deepEqual(noneUrgent, [], 'an urgent filter over legacy data is honestly empty');

      assert.equal(await readFile(join(dataDir, 'issues.json'), 'utf8'), bytes, 'adapter reads rewrote nothing');

      const saved = await adapter.update(LEGACY_INT_ID_A, { priority: 'low' });
      assert.equal(saved.priority, 'low', 'the first adapter save accepts a chosen priority');
    } finally {
      await one.stop();
    }

    // The file keeps creation order, so assert by id, never by array position.
    const raw = JSON.parse(await readFile(join(dataDir, 'issues.json'), 'utf8'));
    assert.equal(raw.issues.length, 2);
    for (const issue of raw.issues) {
      assert.deepEqual(
        Object.keys(issue).sort(),
        ['completions', ...SEVEN_FIELDS],
        'the adapter save upgraded every record in one write',
      );
    }
    const savedRecord = raw.issues.find((issue) => issue.id === LEGACY_INT_ID_A);
    assert.equal(savedRecord.priority, 'low', 'the saved record keeps the chosen priority');
    assert.ok(
      Date.parse(savedRecord.updatedAt) > Date.parse('2024-02-29T09:30:00Z'),
      'the successful save advances the saved record updatedAt',
    );
    const untouched = raw.issues.find((issue) => issue.id === LEGACY_INT_ID_B);
    assert.equal(untouched.priority, 'normal', 'the untouched legacy record upgraded to normal in the same write');
    assert.equal(untouched.updatedAt, '2026-02-28T12:34:56.250Z', 'the untouched record keeps its timestamps');

    const two = await startTracker(dataDir);
    try {
      const adapter = createHttpAdapter({ base: two.base });
      const lowAfterRestart = await adapter.list({ priority: 'low' });
      assert.deepEqual(lowAfterRestart.map((issue) => issue.id), [LEGACY_INT_ID_A], 'the chosen priority survives the restart');
      const normalAfterRestart = await adapter.list({ priority: 'normal' });
      assert.deepEqual(normalAfterRestart.map((issue) => issue.id), [LEGACY_INT_ID_B], 'and so does the upgraded default');
    } finally {
      await two.stop();
    }
  });
});
