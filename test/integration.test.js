// Integration regression for the contributor walkthrough (docs/walkthrough.md).
// Two kinds of coverage live here: HTTP-level tests exercise the documented
// journeys and data lifecycle SEMANTICALLY (same operations and outcomes,
// not literal shell), while the documented backup/restore/reset shell blocks
// are extracted from the walkthrough and executed VERBATIM (npm start is
// stubbed through PATH so the blocks run unmodified). The unit suites
// (api/storage/ui) cover field-level behavior; this file covers the
// lifecycle a contributor actually performs. Each test owns one unique temp
// root and removes only that root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// The documented shell blocks, executed verbatim. The backup (§5) and
// restore (§7) blocks are extracted from docs/walkthrough.md and run exactly
// as printed, so the snippets cannot drift from tested behavior. These
// regressions exist because the review round found the exact defect family
// they cover: a zero-byte "backup" left behind when there is nothing to back
// up or the copy fails, and a restore that could truncate the live store.
// Deterministic copy failures are injected through a PATH shim (partial
// write, then nonzero exit), so every case runs for any user, root included.
// ---------------------------------------------------------------------------

function documentedShellBlock(sectionStart, sectionEnd, needle) {
  const doc = readFileSync(join(repoRoot, 'docs/walkthrough.md'), 'utf8');
  const section = doc.slice(doc.indexOf(sectionStart), doc.indexOf(sectionEnd));
  const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
  const block = blocks.find((candidate) => candidate.includes(needle));
  assert.ok(block, `documented shell block containing ${needle} found between ${sectionStart} and ${sectionEnd}`);
  return block;
}

// A `cp` stand-in that partially writes the destination and then fails, so
// the documented cleanup paths are exercised deterministically on any UID.
async function makeFailingCpShim(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'cp'), '#!/bin/sh\nprintf abc > "$2"\nexit 1\n', { mode: 0o755 });
}

const issueBackups = (cwd) =>
  readdir(join(cwd, '.local', 'issue-backups')).catch(() => []);

test('documented backup block: no fake backup on missing/empty data, unique success, clean failure', async () => {
  const block = documentedShellBlock('## 5. Backup', '## 6.', 'mktemp');
  const run = (cwd, env = process.env) => spawnSync('sh', ['-c', block], { cwd, encoding: 'utf8', env });
  const validStore = JSON.stringify({ issues: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Kept', description: '', status: 'open', createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z' }] }, null, 2) + '\n';

  // Missing store file (fresh checkout or after a reset): message only, nothing created.
  const missingRoot = await mkdtemp(join(tmpdir(), 'doc-backup-missing-'));
  try {
    const missing = run(missingRoot);
    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /Nothing to back up: .*missing or empty/);
    assert.deepEqual(await issueBackups(missingRoot), [], 'no backup file appears without data');
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }

  // Empty store file: equally refused, no zero-byte placeholder.
  const emptyRoot = await mkdtemp(join(tmpdir(), 'doc-backup-empty-'));
  try {
    await mkdir(join(emptyRoot, '.data'));
    await writeFile(join(emptyRoot, '.data', 'issues.json'), '', 'utf8');
    const empty = run(emptyRoot);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /Nothing to back up/);
    assert.deepEqual(await issueBackups(emptyRoot), [], 'an empty store produces no backup file');
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }

  // Success: exactly one non-empty, byte-identical backup; path reported.
  const goodRoot = await mkdtemp(join(tmpdir(), 'doc-backup-good-'));
  try {
    await mkdir(join(goodRoot, '.data'));
    await writeFile(join(goodRoot, '.data', 'issues.json'), validStore, 'utf8');
    const good = run(goodRoot);
    assert.equal(good.status, 0);
    assert.match(good.stdout, /Backup written: .*\(\s*\d+ bytes\)/);
    const [name] = await issueBackups(goodRoot);
    assert.match(name, /^issues-/, 'unique mktemp name');
    const backup = await readFile(join(goodRoot, '.local', 'issue-backups', name), 'utf8');
    assert.equal(backup, validStore, 'backup is byte-identical');
    assert.notEqual(backup.length, 0);
  } finally {
    await rm(goodRoot, { recursive: true, force: true });
  }

  // Failed copy (shimmed partial write): nonzero status, no placeholder kept.
  const failRoot = await mkdtemp(join(tmpdir(), 'doc-backup-fail-'));
  try {
    await mkdir(join(failRoot, '.data'));
    await writeFile(join(failRoot, '.data', 'issues.json'), validStore, 'utf8');
    await makeFailingCpShim(join(failRoot, 'shim'));
    const failed = run(failRoot, { ...process.env, PATH: join(failRoot, 'shim') + ':' + (process.env.PATH || '') });
    assert.notEqual(failed.status, 0, 'a failed backup exits nonzero');
    assert.match(failed.stdout + failed.stderr, /Backup failed; no backup file was kept/);
    assert.deepEqual(await issueBackups(failRoot), [], 'no half-made backup remains');
  } finally {
    await rm(failRoot, { recursive: true, force: true });
  }

  // Inherited BACKUP variable with mkdir failing before assignment: the
  // cleanup branch must remove only this attempt's temp file — never the
  // earlier real backup the inherited variable points at.
  const staleRoot = await mkdtemp(join(tmpdir(), 'doc-backup-stale-'));
  try {
    await mkdir(join(staleRoot, '.data'));
    await writeFile(join(staleRoot, '.data', 'issues.json'), validStore, 'utf8');
    const earlierBackup = join(staleRoot, 'earlier-issues-real');
    await writeFile(earlierBackup, validStore, 'utf8');
    await writeFile(join(staleRoot, '.local'), 'not a directory', 'utf8'); // makes mkdir -p fail
    const stale = run(staleRoot, { ...process.env, BACKUP: earlierBackup });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stdout + stale.stderr, /Backup failed; no backup file was kept/);
    assert.equal(await readFile(earlierBackup, 'utf8'), validStore, 'an inherited BACKUP value is never deleted by cleanup');
  } finally {
    await rm(staleRoot, { recursive: true, force: true });
  }
});

test('documented restore block: verified source, atomic replace, start only on success', async () => {
  const block = documentedShellBlock('## 7. Recovery', '## Where to go next', 'RESTORE_TMP');
  const backupBytes = JSON.stringify({ issues: [{ id: '22222222-2222-4222-8222-222222222222', title: 'From backup', description: '', status: 'done', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }] }, null, 2) + '\n';
  const otherBytes = JSON.stringify({ issues: [] }, null, 2) + '\n';

  // `npm start` on the success path is neutralized with a PATH shim that
  // records the invocation, so the block runs verbatim without a server.
  async function withRestoreRoot(run) {
    const root = await mkdtemp(join(tmpdir(), 'doc-restore-'));
    const shimDir = join(root, 'shim');
    await mkdir(shimDir);
    await writeFile(join(shimDir, 'npm'), '#!/bin/sh\necho "start $@" >> "$RECORD_NPM"\n', { mode: 0o755 });
    const baseEnv = { ...process.env, PATH: shimDir + ':' + (process.env.PATH || ''), RECORD_NPM: join(root, 'npm-start.log') };
    const runBlock = (env = baseEnv) => spawnSync('sh', ['-c', block], { cwd: root, encoding: 'utf8', env });
    const store = () => readFile(join(root, '.data', 'issues.json'), 'utf8').catch(() => null);
    const dataFiles = () => readdir(join(root, '.data')).catch(() => []);
    const started = () => readFile(join(root, 'npm-start.log'), 'utf8').catch(() => null);
    try {
      await run(root, runBlock, store, dataFiles, started, baseEnv);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Success: the documented source name is byte-copied into place, the store
  // it replaces is preserved in a unique replaced-* archive, and only then
  // is npm started; no temp file is left behind.
  await withRestoreRoot(async (root, runBlock, store, dataFiles, started) => {
    await mkdir(join(root, '.local', 'issue-backups'), { recursive: true });
    await writeFile(join(root, '.local', 'issue-backups', 'issues-a1B2c3'), backupBytes, 'utf8');
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), otherBytes, 'utf8');
    const done = runBlock();
    assert.equal(done.status, 0);
    assert.equal(await store(), backupBytes, 'store now equals the backup byte-for-byte');
    assert.match(done.stdout, /Restored from:/);
    const [archive] = (await readdir(join(root, '.local', 'issue-backups'))).filter((n) => n.startsWith('replaced-'));
    assert.ok(archive, 'a replaced-* archive was created');
    assert.equal(await readFile(join(root, '.local', 'issue-backups', archive), 'utf8'), otherBytes, 'archive holds the exact bytes that were replaced');
    assert.match(await started(), /start/, 'npm start ran exactly on success');
    assert.deepEqual(await dataFiles(), ['issues.json'], 'no restore temp file remains');
  });

  // Refusal: an empty source is rejected with a nonzero status, the store is
  // untouched, no archive, no start.
  await withRestoreRoot(async (root, runBlock, store, _files, started) => {
    await mkdir(join(root, '.local', 'issue-backups'), { recursive: true });
    await writeFile(join(root, '.local', 'issue-backups', 'issues-a1B2c3'), '', 'utf8');
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), otherBytes, 'utf8');
    const refused = runBlock();
    assert.notEqual(refused.status, 0, 'refusal returns a nonzero shell status');
    assert.match(refused.stderr, /Refusing: .*empty or missing/);
    assert.equal(await store(), otherBytes, 'refusal leaves the store untouched');
    assert.deepEqual((await issueBackups(root)).filter((n) => n.startsWith('replaced-')), [], 'no replaced-* archive on refusal');
    assert.equal(await started(), null, 'no start after refusal');
  });

  // Fail-closed archival (first cp fails via shim): the store is never
  // replaced, no replaced-* debris, no start, nonzero status.
  await withRestoreRoot(async (root, runBlock, store, _dataFiles, started, baseEnv) => {
    await mkdir(join(root, '.local', 'issue-backups'), { recursive: true });
    await writeFile(join(root, '.local', 'issue-backups', 'issues-a1B2c3'), backupBytes, 'utf8');
    await makeFailingCpShim(join(root, 'cpshim'));
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), otherBytes, 'utf8');
    const failed = runBlock({ ...baseEnv, PATH: join(root, 'cpshim') + ':' + baseEnv.PATH });
    assert.notEqual(failed.status, 0, 'failed archival exits nonzero');
    assert.match(failed.stderr, /Archiving the current store failed; refusing to replace it/);
    assert.equal(await store(), otherBytes, 'fail-closed: the store was not replaced');
    assert.deepEqual((await issueBackups(root)).filter((n) => n.startsWith('replaced-')), [], 'no half-made replaced-* archive remains');
    assert.equal(await started(), null, 'no start after failed archival');
  });

  // Corrupt CURRENT store replaced by a known-good backup: the corrupt
  // bytes survive byte-for-byte inside the replaced-* archive.
  await withRestoreRoot(async (root, runBlock, store, _dataFiles, started) => {
    const corrupt = '{"issues": [{"id": "x"';
    await mkdir(join(root, '.local', 'issue-backups'), { recursive: true });
    await writeFile(join(root, '.local', 'issue-backups', 'issues-a1B2c3'), backupBytes, 'utf8');
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), corrupt, 'utf8');
    const done = runBlock();
    assert.equal(done.status, 0);
    assert.equal(await store(), backupBytes, 'store now equals the good backup');
    const [archive] = (await issueBackups(root)).filter((n) => n.startsWith('replaced-'));
    assert.ok(archive, 'replaced-* archive exists');
    assert.equal(await readFile(join(root, '.local', 'issue-backups', archive), 'utf8'), corrupt, 'the exact corrupt bytes that were replaced are archived');
    assert.match(await started(), /start/);
  });

  // Empty CURRENT store replaced by a known-good backup: exactly one
  // replaced-* archive exists, holding the zero bytes that were replaced.
  await withRestoreRoot(async (root, runBlock, store, _dataFiles, started) => {
    await mkdir(join(root, '.local', 'issue-backups'), { recursive: true });
    await writeFile(join(root, '.local', 'issue-backups', 'issues-a1B2c3'), backupBytes, 'utf8');
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), '', 'utf8');
    const done = runBlock();
    assert.equal(done.status, 0);
    assert.equal(await store(), backupBytes, 'store now equals the good backup');
    const replaced = (await issueBackups(root)).filter((n) => n.startsWith('replaced-'));
    assert.equal(replaced.length, 1, 'exactly one replaced-* archive');
    assert.equal(await readFile(join(root, '.local', 'issue-backups', replaced[0], ), 'utf8'), '', 'the archived bytes are the zero bytes that were replaced');
    assert.match(await started(), /start/);
  });

  // Selective second-cp failure (archival succeeds, the restore copy fails):
  // original store AND its archive survive, temp cleaned, nonzero, no start.
  await withRestoreRoot(async (root, runBlock, store, dataFiles, started, baseEnv) => {
    await mkdir(join(root, '.local', 'issue-backups'), { recursive: true });
    await writeFile(join(root, '.local', 'issue-backups', 'issues-a1B2c3'), backupBytes, 'utf8');
    const cpShim = join(root, 'cp2shim');
    await mkdir(cpShim);
    await writeFile(join(cpShim, 'cp'), '#!/bin/sh\nn=$(cat "$SHIM_COUNT" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "$SHIM_COUNT"\nif [ "$n" -ge 2 ]; then printf abc > "$2"; exit 1; fi\nexec /bin/cp "$@"\n', { mode: 0o755 });
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), otherBytes, 'utf8');
    const failed = runBlock({ ...baseEnv, PATH: cpShim + ':' + baseEnv.PATH, SHIM_COUNT: join(root, 'cp-count') });
    assert.notEqual(failed.status, 0, 'restore-copy failure exits nonzero');
    assert.equal(await store(), otherBytes, 'original store untouched');
    const [archive] = (await issueBackups(root)).filter((n) => n.startsWith('replaced-'));
    assert.ok(archive, 'successful archival is preserved');
    assert.equal(await readFile(join(root, '.local', 'issue-backups', archive), 'utf8'), otherBytes, 'archive holds the original bytes');
    assert.deepEqual(await dataFiles(), ['issues.json'], 'restore temp cleaned');
    assert.equal(await started(), null, 'no start after failure');
  });

  // Final mv failure (archival and restore copy succeed): original store AND
  // archive preserved, temp cleaned, nonzero, no start.
  await withRestoreRoot(async (root, runBlock, store, dataFiles, started, baseEnv) => {
    await mkdir(join(root, '.local', 'issue-backups'), { recursive: true });
    await writeFile(join(root, '.local', 'issue-backups', 'issues-a1B2c3'), backupBytes, 'utf8');
    const mvShim = join(root, 'mvshim');
    await mkdir(mvShim);
    await writeFile(join(mvShim, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), otherBytes, 'utf8');
    const failed = runBlock({ ...baseEnv, PATH: mvShim + ':' + baseEnv.PATH });
    assert.notEqual(failed.status, 0, 'mv failure exits nonzero');
    assert.equal(await store(), otherBytes, 'original store untouched');
    const [archive] = (await issueBackups(root)).filter((n) => n.startsWith('replaced-'));
    assert.ok(archive, 'successful archival is preserved');
    assert.equal(await readFile(join(root, '.local', 'issue-backups', archive), 'utf8'), otherBytes, 'archive holds the original bytes');
    assert.deepEqual(await dataFiles(), ['issues.json'], 'restore temp cleaned');
    assert.equal(await started(), null, 'no start after failure');
  });
});

test('documented reset block: absent source, clean archive, no debris on failure', async () => {
  const block = documentedShellBlock('## 6. Reset', '## 7.', 'data-old');
  const dataBytes = JSON.stringify({ issues: [{ id: '33333333-3333-4333-8333-333333333333', title: 'Before reset', description: '', status: 'open', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }] }, null, 2) + '\n';

  async function withResetRoot(run) {
    const root = await mkdtemp(join(tmpdir(), 'doc-reset-'));
    const shimDir = join(root, 'shim');
    await mkdir(shimDir);
    await writeFile(join(shimDir, 'npm'), '#!/bin/sh\necho "start $@" >> "$RECORD_NPM"\n', { mode: 0o755 });
    const baseEnv = { ...process.env, PATH: shimDir + ':' + (process.env.PATH || ''), RECORD_NPM: join(root, 'npm-start.log') };
    const runBlock = (env = baseEnv) => spawnSync('sh', ['-c', block], { cwd: root, encoding: 'utf8', env });
    const store = () => readFile(join(root, '.data', 'issues.json'), 'utf8').catch(() => null);
    const started = () => readFile(join(root, 'npm-start.log'), 'utf8').catch(() => null);
    const archives = () => issueBackups(root);
    try {
      await run(root, runBlock, store, started, archives, baseEnv);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Absent .data: stated explicitly, fresh start still runs, nothing archived.
  await withResetRoot(async (_root, runBlock, store, started, archives) => {
    const absent = runBlock();
    assert.equal(absent.status, 0);
    assert.match(absent.stdout, /Nothing to reset: \.data does not exist/);
    assert.equal(await store(), null);
    assert.deepEqual(await archives(), [], 'no archive created for absent data');
    assert.match(await started(), /start/, 'fresh start runs anyway');
  });

  // Success: data moved intact into a unique archive, fresh start runs.
  await withResetRoot(async (root, runBlock, store, started, archives) => {
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), dataBytes, 'utf8');
    const done = runBlock();
    assert.equal(done.status, 0);
    assert.match(done.stdout, /data archived at:/);
    assert.equal(await store(), null, 'live .data is gone after the move');
    const [archive] = await archives();
    assert.match(archive, /^data-old-/, 'unique archive directory');
    assert.equal(await readFile(join(root, '.local', 'issue-backups', archive, 'data', 'issues.json'), 'utf8'), dataBytes, 'archived bytes intact');
    assert.match(await started(), /start/);
  });

  // Failed move (shimmed mv): nonzero, .data left in place, no empty debris.
  await withResetRoot(async (root, runBlock, store, started, archives, baseEnv) => {
    const mvShim = join(root, 'mvshim');
    await mkdir(mvShim);
    await writeFile(join(mvShim, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'issues.json'), dataBytes, 'utf8');
    const failed = runBlock({ ...baseEnv, PATH: mvShim + ':' + baseEnv.PATH });
    assert.notEqual(failed.status, 0, 'failed move exits nonzero');
    assert.match(failed.stderr, /Reset failed: \.data was left in place/);
    assert.equal(await store(), dataBytes, '.data untouched after failed move');
    assert.deepEqual(await archives(), [], 'no empty archive debris remains');
    assert.equal(await started(), null, 'no start after failure');
  });
});
