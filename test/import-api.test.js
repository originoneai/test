// API tests for historical CSV import (specs/historical-issue-import.md):
// whole-batch validation, atomic commit, idempotent retry, result lookup,
// restart durability, failed persistence and backwards-compatible storage.
// Every test uses an isolated temp DATA_DIR and inline synthetic CSV text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const VALID_CSV =
  '\uFEFFtitle,description,status,priority\r\n' +
  '历史问题：登录失败,"用户反馈：""点击登录没反应"", 需要排查",open,high\r\n' +
  'Export report,"Steps:\r\n1. open, then\r\n2. export",in_progress,\r\n' +
  'Closed long ago,,done,urgent\r\n' +
  'Café München,Umlaut ä ö ü,,low\r\n';
const INVALID_CSV = 'title,status,priority\nFine,open,low\n,open,low\nAlso fine,open,critical\n';

async function boot(dataDir) {
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, options);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    base,
    request,
    storePath: join(dataDir, 'issues.json'),
    commit: (payload) =>
      request('/api/imports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    lookup: (key) => request('/api/imports/' + key),
    list: () => request('/api/issues'),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withTracker(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'import-api-'));
  const tracker = await boot(dataDir);
  try {
    await fn(tracker, dataDir);
  } finally {
    await tracker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('a valid file commits every row with server-owned fields and a queryable result', () =>
  withTracker(async (t) => {
    const importKey = randomUUID();
    const res = await t.commit({ importKey, csv: VALID_CSV });
    assert.equal(res.status, 201);
    assert.equal(res.body.replayed, false);
    assert.equal(res.body.import.importKey, importKey);
    assert.equal(res.body.import.status, 'committed');
    assert.equal(res.body.import.issueCount, 4);
    const list = (await t.list()).body.items;
    assert.equal(list.length, 4);
    const byTitle = Object.fromEntries(list.map((issue) => [issue.title, issue]));
    assert.equal(byTitle['历史问题：登录失败'].description, '用户反馈："点击登录没反应", 需要排查');
    assert.equal(byTitle['历史问题：登录失败'].priority, 'high');
    assert.equal(byTitle['Export report'].description, 'Steps:\n1. open, then\n2. export');
    assert.equal(byTitle['Export report'].priority, 'normal');
    assert.equal(byTitle['Café München'].status, 'open');
    assert.deepEqual(new Set(res.body.import.issueIds), new Set(list.map((issue) => issue.id)));
    for (const issue of list) assert.equal(issue.createdAt, res.body.import.createdAt);
    const lookup = await t.lookup(importKey);
    assert.equal(lookup.status, 200);
    assert.deepEqual(lookup.body.import, res.body.import);
    // The done row gets the same immutable completion snapshot as a create in done.
    const stored = JSON.parse(await readFile(t.storePath, 'utf8'));
    const done = stored.issues.find((issue) => issue.title === 'Closed long ago');
    assert.deepEqual(done.completions, [{ at: done.createdAt, priority: 'urgent' }]);
    assert.equal(stored.imports.length, 1);
  }));

test('an invalid file is rejected as a whole with row errors and writes nothing', () =>
  withTracker(async (t) => {
    await t.request('/api/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Existing' }) });
    const before = await readFile(t.storePath, 'utf8');
    const importKey = randomUUID();
    const res = await t.commit({ importKey, csv: INVALID_CSV });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IMPORT_INVALID');
    assert.deepEqual(res.body.error.details.rowErrors.map((row) => row.line), [3, 4]);
    assert.equal(await readFile(t.storePath, 'utf8'), before);
    assert.equal((await t.list()).body.items.length, 1);
    assert.equal((await t.lookup(importKey)).status, 404);
  }));

test('credential or history columns and unknown body fields are refused', () =>
  withTracker(async (t) => {
    const bad = await t.commit({ importKey: randomUUID(), csv: 'title,token\nA,s3cret\n' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.details.fileErrors.join(' '), /Unsupported column/);
    const extra = await t.commit({ importKey: randomUUID(), csv: 'title\nA\n', issues: [{ id: 'x' }] });
    assert.equal(extra.status, 400);
    assert.match(extra.body.error.message, /Unknown field/);
    const noKey = await t.commit({ csv: 'title\nA\n' });
    assert.equal(noKey.status, 400);
    assert.match(noKey.body.error.message, /importKey/);
    assert.equal((await t.list()).body.items.length, 0);
  }));

test('retrying the same import reuses the stored outcome and never duplicates', () =>
  withTracker(async (t) => {
    const importKey = randomUUID();
    const first = await t.commit({ importKey, csv: VALID_CSV });
    // Same rows re-saved with LF and no BOM: same normalized batch.
    const again = await t.commit({ importKey, csv: VALID_CSV.replace('\uFEFF', '').replace(/\r\n/g, '\n') });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.import, first.body.import);
    const concurrent = await Promise.all([1, 2, 3].map(() => t.commit({ importKey, csv: VALID_CSV })));
    for (const res of concurrent) assert.deepEqual(res.body.import, first.body.import);
    assert.equal((await t.list()).body.items.length, 4);
  }));

test('concurrent first commits of one key create exactly one batch', () =>
  withTracker(async (t) => {
    const importKey = randomUUID();
    const results = await Promise.all([1, 2, 3, 4].map(() => t.commit({ importKey, csv: VALID_CSV })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 201]);
    assert.equal((await t.list()).body.items.length, 4);
  }));

test('reusing a key for a different file is a conflict and writes nothing', () =>
  withTracker(async (t) => {
    const importKey = randomUUID();
    await t.commit({ importKey, csv: VALID_CSV });
    const before = await readFile(t.storePath, 'utf8');
    const res = await t.commit({ importKey, csv: 'title\nSomething else\n' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'IMPORT_CONFLICT');
    assert.equal(await readFile(t.storePath, 'utf8'), before);
  }));

test('a different key for the same file is a new, deliberate import', () =>
  withTracker(async (t) => {
    await t.commit({ importKey: randomUUID(), csv: 'title\nOne\n' });
    const second = await t.commit({ importKey: randomUUID(), csv: 'title\nOne\n' });
    assert.equal(second.status, 201);
    assert.equal((await t.list()).body.items.length, 2);
  }));

test('imports and their results survive a restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'import-restart-'));
  try {
    const importKey = randomUUID();
    let t = await boot(dataDir);
    const first = await t.commit({ importKey, csv: VALID_CSV });
    await t.close();
    t = await boot(dataDir);
    const lookup = await t.lookup(importKey);
    assert.equal(lookup.status, 200);
    assert.deepEqual(lookup.body.import, first.body.import);
    const replay = await t.commit({ importKey, csv: VALID_CSV });
    assert.equal(replay.body.replayed, true);
    assert.equal((await t.list()).body.items.length, 4);
    await t.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('failed persistence leaves issues and import metadata unchanged', { skip: isRoot && 'root ignores permissions' }, () =>
  withTracker(async (t, dataDir) => {
    await t.request('/api/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Existing' }) });
    const before = await readFile(t.storePath, 'utf8');
    const importKey = randomUUID();
    await chmod(dataDir, 0o500);
    let res;
    try {
      res = await t.commit({ importKey, csv: VALID_CSV });
    } finally {
      await chmod(dataDir, 0o700);
    }
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'STORAGE_ERROR');
    assert.equal(await readFile(t.storePath, 'utf8'), before);
    assert.equal((await t.lookup(importKey)).status, 404);
    assert.equal((await t.list()).body.items.length, 1);
    // The same import can then be committed for real, exactly once.
    assert.equal((await t.commit({ importKey, csv: VALID_CSV })).status, 201);
    assert.equal((await t.list()).body.items.length, 5);
  }));

test('a store that never imported keeps the exact original file format', () =>
  withTracker(async (t) => {
    await t.request('/api/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Plain' }) });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(t.storePath, 'utf8'))), ['issues']);
  }));

test('a corrupt import record is reported, never rewritten', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'import-corrupt-'));
  try {
    const corrupt = JSON.stringify({ issues: [], imports: [{ importKey: randomUUID(), digest: 'x', createdAt: 'y', issueIds: [] }] });
    await writeFile(join(dataDir, 'issues.json'), corrupt);
    const t = await boot(dataDir);
    const res = await t.list();
    assert.equal(res.status, 500);
    assert.equal(await readFile(join(dataDir, 'issues.json'), 'utf8'), corrupt);
    await t.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('lookup validates the key; wrong methods get 405', () =>
  withTracker(async (t) => {
    assert.equal((await t.lookup('nope')).status, 400);
    assert.equal((await t.lookup(randomUUID())).status, 404);
    assert.equal((await t.request('/api/imports')).status, 405);
    assert.equal((await t.request('/api/imports/' + randomUUID(), { method: 'DELETE' })).status, 405);
  }));

test('an oversized request body is refused with 413 and writes nothing', () =>
  withTracker(async (t) => {
    const res = await t.commit({ importKey: randomUUID(), csv: 'title\n' + 'x'.repeat(1024 * 1024) });
    assert.equal(res.status, 413);
    assert.equal((await t.list()).body.items.length, 0);
  }));

test('the page serves the shared import module as JavaScript', () =>
  withTracker(async (t) => {
    const res = await fetch(t.base + '/csv-import.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match(await res.text(), /export function validateImportCsv/);
  }));
