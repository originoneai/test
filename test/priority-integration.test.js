// End-to-end priority journey over the real server process and the board's
// real HTTP adapter: create with priority, filtered reads, restart
// durability, and unknown-outcome recovery for a priority edit. The adapter
// currently drops the priority filter and save confirmation does not compare
// priority, so the checks describing those behaviors fail until the frontend
// provides them; the legs the server alone determines hold today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpAdapter, matchesSubmitted } from '../public/app.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(repoRoot, 'src/server.js');
const NO_UI_YET = 'public/app.js has no priority support yet';

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
        NO_UI_YET + ': the adapter currently drops the priority filter',
      );

      const composed = await adapter.list({ priority: 'high', status: 'open', q: 'shared' });
      assert.deepEqual(composed.map((issue) => issue.title), ['Journey high'], NO_UI_YET + ': priority must compose with status and q');
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
        NO_UI_YET + ': post-restart filtering still needs the adapter to forward priority',
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
        NO_UI_YET + ': refresh-and-compare must distinguish priority values',
      );
    } finally {
      await one.stop();
    }
  });
});
