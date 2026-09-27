// Integration regression for the contributor walkthrough (docs/walkthrough.md).
// Unlike the in-process suites, these tests run the REAL server as a child
// process (node src/server.js) from clean, isolated data directories and
// mirror the documented journey exactly: clean setup → start → everyday use →
// restart persistence → backup → corrupt-store refusal → restore → reset.
// The unit suites (api/storage/ui) cover field-level behavior; this file
// covers the lifecycle a contributor actually performs. Each test owns one
// unique temp root and removes only that root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(repoRoot, 'src/server.js');

// The server prints its CONFIGURED port, so an OS-assigned port cannot be
// discovered from stdout; borrow a free port instead (tiny, accepted race).
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

// Boots the real server the way a contributor does (`node src/server.js`) and
// resolves once it announces readiness. The returned stop() terminates this
// child (SIGTERM, then SIGKILL after a bound grace period) and must run in a
// finally block.
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
  // 'close' (not 'exit') is the authoritative end: it also fires after a
  // spawn 'error', and only once stdio has finished, so a failed spawn cannot
  // leave stop() waiting forever and nothing is reaped prematurely.
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

  // If readiness never arrives (or the child dies at boot), reap this child
  // before rethrowing so a failed start can never leak a process.
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

async function request(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: response.status, body, text };
}

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// One unique root per test; everything created lives inside it and only the
// root is removed, so parallel runs can never touch each other's data.
async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'issue-integration-'));
  try {
    await run(root, join(root, 'live'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('walkthrough journey: clean start, everyday use, restart keeps data', async () => {
  await withRoot(async (root, dataDir) => {
    let beforeRestart; // full records from the first process, compared after restart
    const one = await startTracker(dataDir);
    try {
      // Section 2: sanity checks on a clean checkout.
      const health = await request(one.base, '/healthz');
      assert.equal(health.status, 200);
      assert.equal(health.body.ok, true);
      const empty = await request(one.base, '/api/issues');
      assert.deepEqual(empty.body, { items: [] });

      // Section 3: create (title echoed trimmed), edit a subset, filter.
      const created = await request(one.base, '/api/issues', json('POST', {
        title: '  Fix login flow  ',
        description: 'Session expires too early.',
      }));
      assert.equal(created.status, 201);
      assert.equal(created.body.title, 'Fix login flow');
      assert.equal(created.body.status, 'open');

      const second = await request(one.base, '/api/issues', json('POST', { title: 'Second issue' }));
      assert.equal(second.status, 201);

      const patched = await request(one.base, '/api/issues/' + created.body.id, json('PATCH', { status: 'done' }));
      assert.equal(patched.status, 200);
      assert.equal(patched.body.status, 'done');
      assert.equal(patched.body.title, 'Fix login flow', 'untouched fields are kept');

      const filtered = await request(one.base, '/api/issues?status=done&q=login');
      assert.deepEqual(filtered.body.items.map((issue) => issue.id), [created.body.id]);

      const all = await request(one.base, '/api/issues');
      assert.deepEqual(
        all.body.items.map((issue) => issue.title),
        ['Second issue', 'Fix login flow'],
        'newest first',
      );
      beforeRestart = all.body.items;
      for (const issue of beforeRestart) {
        assert.deepEqual(
          Object.keys(issue).sort(),
          ['createdAt', 'description', 'id', 'status', 'title', 'updatedAt'],
          'full record shape as documented',
        );
      }
    } finally {
      await one.stop();
    }

    // Section 4: restart (a brand-new process) keeps every accepted change.
    const two = await startTracker(dataDir);
    try {
      const after = await request(two.base, '/api/issues');
      assert.deepEqual(after.body.items, beforeRestart, 'identical full records after restart');
      const appended = await request(two.base, '/api/issues', json('POST', { title: 'After restart' }));
      assert.equal(appended.status, 201);
    } finally {
      await two.stop();
    }
  });
});

test('data lifecycle: backup, corrupt store refused untouched, restore, reset', async () => {
  await withRoot(async (root, dataDir) => {
    const storePath = join(dataDir, 'issues.json');
    const backupPath = join(root, 'issues.backup.json');
    const asidePath = join(root, 'reset-aside');

    // Make one durable issue, capture its full record, stop the server, take
    // the documented backup.
    const one = await startTracker(dataDir);
    let originalItems;
    try {
      const created = await request(one.base, '/api/issues', json('POST', { title: 'Precious issue' }));
      assert.equal(created.status, 201);
      const listed = await request(one.base, '/api/issues');
      originalItems = listed.body.items;
      assert.equal(originalItems.length, 1);
      assert.deepEqual(
        Object.keys(originalItems[0]).sort(),
        ['createdAt', 'description', 'id', 'status', 'title', 'updatedAt'],
      );
    } finally {
      await one.stop();
    }
    await cp(storePath, backupPath);
    const goodBytes = await readFile(storePath, 'utf8');
    assert.equal(await readFile(backupPath, 'utf8'), goodBytes, 'backup copies the exact bytes');

    // Corrupt the store (e.g. a truncated write by another tool).
    const corruptBytes = '{"issues": [{"id": "x"';
    await writeFile(storePath, corruptBytes, 'utf8');

    const two = await startTracker(dataDir);
    try {
      const refused = await request(two.base, '/api/issues');
      assert.equal(refused.status, 500);
      assert.equal(refused.body.error.code, 'STORAGE_ERROR');
      const write = await request(two.base, '/api/issues', json('POST', { title: 'Must not persist' }));
      assert.equal(write.status, 500);
      assert.equal(write.body.error.code, 'STORAGE_ERROR');
    } finally {
      await two.stop();
    }
    assert.equal(await readFile(storePath, 'utf8'), corruptBytes, 'the refused store is never rewritten');

    // Restore the backup exactly as documented: byte-identical file back in
    // place, and the API serves the exact original records again.
    await cp(backupPath, storePath);
    assert.equal(await readFile(storePath, 'utf8'), goodBytes, 'restore puts the exact backup bytes back');
    const three = await startTracker(dataDir);
    try {
      const list = await request(three.base, '/api/issues');
      assert.deepEqual(list.body.items, originalItems, 'full original records after restore');
    } finally {
      await three.stop();
    }

    // Reset: move the data directory aside (the documented mv), verify the
    // moved directory kept its bytes, then start fresh on a recreated path.
    await rename(dataDir, asidePath);
    assert.equal(await readFile(join(asidePath, 'issues.json'), 'utf8'), goodBytes, 'moved-aside data is intact');
    const four = await startTracker(dataDir);
    try {
      const fresh = await request(four.base, '/api/issues');
      assert.deepEqual(fresh.body, { items: [] });
      const created = await request(four.base, '/api/issues', json('POST', { title: 'Fresh start' }));
      assert.equal(created.status, 201);
      assert.deepEqual(await readdir(dataDir), ['issues.json'], 'data dir recreated with only the store');
    } finally {
      await four.stop();
    }
  });
});
