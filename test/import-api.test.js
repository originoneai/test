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

// ---------------------------------------------------------------------------
// Explicit "import only the valid rows" (mode valid_rows). Default stays
// all-or-nothing; the subset is committed only on explicit request with the
// exact excluded lines the preview showed.
// ---------------------------------------------------------------------------
const MIXED_CSV = 'title,description,status,priority\nKeep open,,open,low\n,missing title,open,low\nKeep done,"closed, long ago",done,urgent\nBad priority,,open,critical\nBad status,,closed,\n';
const MIXED_EXCLUDED = [3, 5, 6];
const validRows = (importKey, csv = MIXED_CSV, excludedLines = MIXED_EXCLUDED) => ({ importKey, csv, mode: 'valid_rows', excludedLines });

test('by default a file with some invalid rows is still refused whole, with line, column and reason', () =>
  withTracker(async (t) => {
    const importKey = randomUUID();
    const res = await t.commit({ importKey, csv: MIXED_CSV });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IMPORT_INVALID');
    assert.deepEqual(
      res.body.error.details.rowErrors.map((row) => [row.line, row.problems.map((entry) => entry.column)]),
      [[3, ['title']], [5, ['priority']], [6, ['status']]],
    );
    assert.match(res.body.error.details.rowErrors[1].problems[0].reason, /priority "critical"/);
    assert.equal((await t.list()).body.items.length, 0);
    assert.equal((await t.lookup(importKey)).status, 404);
    // an explicit mode "all" behaves exactly like the default
    assert.equal((await t.commit({ importKey, csv: MIXED_CSV, mode: 'all' })).body.error.code, 'IMPORT_INVALID');
  }));

test('mode valid_rows commits exactly the valid rows atomically and records the excluded ones', () =>
  withTracker(async (t) => {
    await t.request('/api/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Existing' }) });
    const importKey = randomUUID();
    const res = await t.commit(validRows(importKey));
    assert.equal(res.status, 201);
    assert.equal(res.body.replayed, false);
    assert.equal(res.body.import.mode, 'valid_rows');
    assert.equal(res.body.import.issueCount, 2);
    assert.deepEqual(res.body.import.excludedRows.map((row) => row.line), MIXED_EXCLUDED);
    assert.deepEqual(res.body.import.excludedRows[0].problems, [{ column: 'title', reason: 'title is required.' }]);
    const list = (await t.list()).body.items;
    assert.deepEqual(list.map((issue) => issue.title).sort(), ['Existing', 'Keep done', 'Keep open']);
    const imported = list.filter((issue) => res.body.import.issueIds.includes(issue.id));
    assert.equal(imported.length, 2);
    for (const issue of imported) assert.equal(issue.createdAt, res.body.import.createdAt); // server-assigned time
    const stored = JSON.parse(await readFile(t.storePath, 'utf8'));
    const done = stored.issues.find((issue) => issue.title === 'Keep done');
    assert.deepEqual(done.completions, [{ at: done.createdAt, priority: 'urgent' }]);
    assert.equal(stored.imports[0].mode, 'valid_rows');
    // the weekly summary is computed from the persisted import
    const weekly = await t.request('/api/reports/weekly');
    assert.equal(weekly.status, 200);
    // Existing + the two imported rows; only the imported done row completed.
    assert.equal(weekly.body.created.total, 3);
    assert.deepEqual(weekly.body.created.byStatus, { open: 2, in_progress: 0, done: 1 });
    assert.equal(weekly.body.completed.total, 1);
    assert.equal(weekly.body.completed.byPriority.urgent, 1);
    const lookup = await t.lookup(importKey);
    assert.equal(lookup.status, 200);
    assert.deepEqual(lookup.body.import, res.body.import);
  }));

test('a whole-file import reports mode all and no excluded rows', () =>
  withTracker(async (t) => {
    const res = await t.commit({ importKey: randomUUID(), csv: VALID_CSV });
    assert.equal(res.body.import.mode, 'all');
    assert.deepEqual(res.body.import.excludedRows, []);
    const stored = JSON.parse(await readFile(t.storePath, 'utf8'));
    assert.deepEqual(Object.keys(stored.imports[0]).sort(), ['createdAt', 'digest', 'importKey', 'issueIds']);
  }));

test('a stale preview (different excluded lines) is refused and writes nothing', () =>
  withTracker(async (t) => {
    const importKey = randomUUID();
    const res = await t.commit(validRows(importKey, MIXED_CSV, [3, 5]));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IMPORT_PREVIEW_MISMATCH');
    assert.deepEqual(res.body.error.details.excludedLines, MIXED_EXCLUDED);
    assert.equal((await t.list()).body.items.length, 0);
    assert.equal((await t.lookup(importKey)).status, 404);
    // the corrected request then commits once
    assert.equal((await t.commit(validRows(importKey))).status, 201);
  }));

test('malformed valid-rows requests are refused', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const bad = [
      { importKey: key, csv: MIXED_CSV, mode: 'subset' },
      { importKey: key, csv: MIXED_CSV, mode: 'valid_rows' },
      { importKey: key, csv: MIXED_CSV, mode: 'valid_rows', excludedLines: [] },
      { importKey: key, csv: MIXED_CSV, mode: 'valid_rows', excludedLines: [5, 3, 6] },
      { importKey: key, csv: MIXED_CSV, mode: 'valid_rows', excludedLines: [1, 3] },
      { importKey: key, csv: MIXED_CSV, mode: 'valid_rows', excludedLines: ['3'] },
      { importKey: key, csv: MIXED_CSV, mode: 'all', excludedLines: [3] },
      { importKey: key, csv: MIXED_CSV, excludedLines: [3] },
    ];
    for (const payload of bad) {
      const res = await t.commit(payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal((await t.list()).body.items.length, 0);
  }));

test('valid_rows never overrides file-level problems, limits, an all-valid or an all-invalid file', () =>
  withTracker(async (t) => {
    const cases = [
      ['title,password\nA,x\n,y\n', [3], /cannot be imported/],
      ['title\n' + Array.from({ length: 500 }, (_, i) => `T${i}`).join('\n') + '\n,\n', [502], /cannot be imported/],
      [VALID_CSV, [2], /Every row is valid/],
      ['title,priority\n,low\nX,critical\n', [2, 3], /No row of this file/],
    ];
    for (const [csv, excludedLines, message] of cases) {
      const res = await t.commit(validRows(randomUUID(), csv, excludedLines));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'IMPORT_INVALID');
      assert.match(res.body.error.message, message);
    }
    const huge = 'title\n' + 'x'.repeat(256 * 1024) + '\n,\n';
    assert.equal((await t.commit(validRows(randomUUID(), huge, [3]))).body.error.code, 'IMPORT_INVALID');
    assert.equal((await t.list()).body.items.length, 0);
  }));

test('repeating a valid-rows commit replays it; reusing its key for another file or choice conflicts', () =>
  withTracker(async (t) => {
    const importKey = randomUUID();
    const first = await t.commit(validRows(importKey));
    const again = await t.commit(validRows(importKey, MIXED_CSV.replace(/\n/g, '\r\n')));
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.import, first.body.import);
    const other = MIXED_CSV.replace('Keep open', 'Different');
    const conflict = await t.commit(validRows(importKey, other));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IMPORT_CONFLICT');
    // a whole-file key cannot be replayed as a valid-rows choice either
    const wholeKey = randomUUID();
    assert.equal((await t.commit({ importKey: wholeKey, csv: 'title\nOnly\n' })).status, 201);
    assert.equal((await t.commit(validRows(wholeKey, 'title,priority\nOnly,\n,low\n', [3]))).status, 409);
    assert.equal((await t.list()).body.items.length, 3);
    // the same file under a new key is a new, deliberate import
    assert.equal((await t.commit(validRows(randomUUID()))).status, 201);
    assert.equal((await t.list()).body.items.length, 5);
  }));

test('a valid-rows import and its excluded rows survive a restart and still replay', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'import-valid-rows-restart-'));
  try {
    const importKey = randomUUID();
    let t = await boot(dataDir);
    const first = await t.commit(validRows(importKey));
    await t.close();
    t = await boot(dataDir);
    const lookup = await t.lookup(importKey);
    assert.equal(lookup.status, 200);
    assert.deepEqual(lookup.body.import, first.body.import);
    const replay = await t.commit(validRows(importKey));
    assert.equal(replay.body.replayed, true);
    assert.equal((await t.list()).body.items.length, 2);
    await t.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('failed persistence of a valid-rows import leaves everything unchanged', { skip: isRoot && 'root ignores permissions' }, () =>
  withTracker(async (t, dataDir) => {
    await t.request('/api/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Existing' }) });
    const before = await readFile(t.storePath, 'utf8');
    const importKey = randomUUID();
    await chmod(dataDir, 0o500);
    let res;
    try {
      res = await t.commit(validRows(importKey));
    } finally {
      await chmod(dataDir, 0o700);
    }
    assert.equal(res.status, 500);
    assert.equal(await readFile(t.storePath, 'utf8'), before);
    assert.equal((await t.lookup(importKey)).status, 404);
    assert.equal((await t.commit(validRows(importKey))).status, 201);
    assert.equal((await t.list()).body.items.length, 3);
  }));

test('a corrupt valid-rows record is reported, never rewritten', async () => {
  for (const extra of [{ mode: 'valid_rows' }, { mode: 'other', excludedRows: [{ line: 3, problems: [{ column: 'title', reason: 'x' }] }] }, { mode: 'valid_rows', excludedRows: [{ line: 3, problems: [] }] }]) {
    const dataDir = await mkdtemp(join(tmpdir(), 'import-corrupt-subset-'));
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const corrupt = JSON.stringify({
        issues: [{ id, title: 'T', description: '', status: 'open', priority: 'normal', createdAt: now, updatedAt: now, completions: [] }],
        imports: [{ importKey: randomUUID(), digest: 'a'.repeat(64), createdAt: now, issueIds: [id], ...extra }],
      });
      await writeFile(join(dataDir, 'issues.json'), corrupt);
      const t = await boot(dataDir);
      assert.equal((await t.list()).status, 500, JSON.stringify(extra));
      assert.equal(await readFile(join(dataDir, 'issues.json'), 'utf8'), corrupt);
      await t.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Already-imported content lookup (POST /api/imports/match): read-only,
// matched by the same digest as a commit (content + mode + excluded lines).
// ---------------------------------------------------------------------------
test('match finds an earlier import of the same content, mode and excluded lines, with its stored skipped rows', () =>
  withTracker(async (t) => {
    const match = (payload) => t.request('/api/imports/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const before = await match({ csv: MIXED_CSV, mode: 'valid_rows', excludedLines: MIXED_EXCLUDED });
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, { matches: [] });
    const key = randomUUID();
    const committed = await t.commit(validRows(key));
    assert.equal(committed.status, 201);
    const storeBefore = await readFile(t.storePath, 'utf8');
    // the same file re-saved with CRLF still matches (normalized content)
    const found = await match({ csv: MIXED_CSV.replace(/\n/g, '\r\n'), mode: 'valid_rows', excludedLines: MIXED_EXCLUDED });
    assert.equal(found.status, 200);
    assert.equal(found.body.matches.length, 1);
    assert.deepEqual(found.body.matches[0], committed.body.import);
    assert.deepEqual(found.body.matches[0].excludedRows.map((row) => row.line), MIXED_EXCLUDED);
    assert.equal(found.body.matches[0].excludedRows[0].problems[0].column, 'title');
    // a whole-file import of other content does not match; nothing was written
    const whole = await match({ csv: VALID_CSV });
    assert.deepEqual(whole.body, { matches: [] });
    assert.equal(await readFile(t.storePath, 'utf8'), storeBefore);
    // a stale preview is refused exactly like a commit would be
    const stale = await match({ csv: MIXED_CSV, mode: 'valid_rows', excludedLines: [3, 5] });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error.code, 'IMPORT_PREVIEW_MISMATCH');
    // unknown fields and wrong methods are refused
    assert.equal((await match({ csv: VALID_CSV, importKey: key })).status, 400);
    assert.equal((await t.request('/api/imports/match')).status, 405);
  }));

test('match finds a whole-file import and survives a restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'import-api-'));
  let t = null;
  try {
    t = await boot(dataDir);
    const key = randomUUID();
    const committed = await t.commit({ importKey: key, csv: VALID_CSV });
    await t.close();
    t = null;
    t = await boot(dataDir);
    const found = await t.request('/api/imports/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv: VALID_CSV }) });
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.matches, [committed.body.import]);
  } finally {
    if (t) await t.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2: the external_ref column and duplicate external-reference handling.
// Repeated batch imports of the same history must flag duplicates inside one
// file and against already imported issues, require an explicit
// skip-or-import decision per flagged row, never overwrite an existing issue,
// and still commit at most once per importKey and decision.
// ---------------------------------------------------------------------------
const REF_CSV = 'title,description,status,priority,external_ref\nOld one,,open,low,OPS-1\nOld two,,done,urgent,OPS-2\n';
const DUP_IN_FILE = 'title,external_ref\nFirst,OPS-9\nSecond,OPS-9\nThird,OPS-8\n';
const LATER_FILE = 'title,external_ref\nFresh,OPS-7\nOld again,OPS-1\n';
const precheck = (t, payload) =>
  t.request('/api/imports/precheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const matchBody = (t, payload) =>
  t.request('/api/imports/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

test('a file with an external_ref column imports rows that retain the old-system reference', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const res = await t.commit({ importKey: key, csv: REF_CSV });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 2);
    const items = (await t.list()).body.items;
    const byRef = Object.fromEntries(items.map((issue) => [issue.externalRef, issue]));
    assert.equal(byRef['OPS-1'].title, 'Old one');
    assert.equal(byRef['OPS-2'].status, 'done');
    // A manually created issue keeps the exact legacy resource shape.
    await t.request('/api/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Manual' }) });
    const manual = (await t.list()).body.items.find((issue) => issue.title === 'Manual');
    assert.equal('externalRef' in manual, false);
    // The stored whole-file record keeps the exact four-field shape.
    const stored = JSON.parse(await readFile(t.storePath, 'utf8'));
    assert.deepEqual(Object.keys(stored.imports[0]).sort(), ['createdAt', 'digest', 'importKey', 'issueIds']);
    // The same request replays once.
    const again = await t.commit({ importKey: key, csv: REF_CSV });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal((await t.list()).body.items.length, 3);
  }));

test('duplicate external references inside one file need an explicit decision', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const res = await t.commit({ importKey: key, csv: DUP_IN_FILE });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IMPORT_DUPLICATES_UNDECIDED');
    const duplicates = res.body.error.details.duplicates;
    assert.deepEqual(duplicates.map((entry) => entry.line), [2, 3]);
    for (const entry of duplicates) {
      assert.equal(entry.externalRef, 'OPS-9');
      assert.equal(entry.kind, 'in_file');
    }
    assert.equal((await t.list()).body.items.length, 0);
    assert.equal((await t.lookup(key)).status, 404);
  }));

test('skipping a duplicate imports the rest and records the skipped line with its reason', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const res = await t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: { 2: 'import', 3: 'skip' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 2);
    assert.deepEqual(res.body.import.excludedRows.map((row) => row.line), [3]);
    assert.equal(res.body.import.excludedRows[0].problems[0].column, 'external_ref');
    assert.match(res.body.import.excludedRows[0].problems[0].reason, /OPS-9/);
    assert.match(res.body.import.excludedRows[0].problems[0].reason, /skipped by your choice/);
    const items = (await t.list()).body.items;
    assert.equal(items.filter((issue) => issue.externalRef === 'OPS-9').length, 1);
    assert.equal(items.filter((issue) => issue.externalRef === 'OPS-8').length, 1);
    assert.deepEqual((await t.lookup(key)).body.import, res.body.import);
  }));

test('an external reference already imported is flagged with the earlier issue and never overwritten', () =>
  withTracker(async (t) => {
    await t.commit({ importKey: randomUUID(), csv: REF_CSV });
    const earlier = (await t.list()).body.items.find((issue) => issue.externalRef === 'OPS-1');
    const key = randomUUID();
    const undecided = await t.commit({ importKey: key, csv: LATER_FILE });
    assert.equal(undecided.status, 400);
    assert.equal(undecided.body.error.code, 'IMPORT_DUPLICATES_UNDECIDED');
    const entry = undecided.body.error.details.duplicates.find((dup) => dup.externalRef === 'OPS-1');
    assert.equal(entry.line, 3);
    assert.equal(entry.kind, 'already_imported');
    assert.equal(entry.issueId, earlier.id);
    const res = await t.commit({ importKey: key, csv: LATER_FILE, duplicateDecisions: { 2: 'import', 3: 'skip' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 1);
    const items = (await t.list()).body.items;
    assert.equal(items.filter((issue) => issue.externalRef === 'OPS-1').length, 1);
    const unchanged = items.find((issue) => issue.id === earlier.id);
    assert.equal(unchanged.updatedAt, earlier.updatedAt);
    assert.equal(unchanged.title, earlier.title);
  }));

test('importing a duplicate anyway is an explicit second copy, never an update', () =>
  withTracker(async (t) => {
    await t.commit({ importKey: randomUUID(), csv: REF_CSV });
    const earlier = (await t.list()).body.items.find((issue) => issue.externalRef === 'OPS-1');
    const res = await t.commit({ importKey: randomUUID(), csv: LATER_FILE, duplicateDecisions: { 2: 'import', 3: 'import' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 2);
    const items = (await t.list()).body.items;
    const withRef = items.filter((issue) => issue.externalRef === 'OPS-1');
    assert.equal(withRef.length, 2);
    assert.notEqual(withRef[0].id, withRef[1].id);
    assert.equal(items.find((issue) => issue.id === earlier.id).updatedAt, earlier.updatedAt);
  }));

test('the same key replays the same decision; a different decision is a conflict', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const decisions = { 2: 'import', 3: 'skip' };
    await t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: decisions });
    const again = await t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: decisions });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal((await t.list()).body.items.length, 2);
    const conflict = await t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: { 2: 'import', 3: 'import' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IMPORT_CONFLICT');
    assert.equal((await t.list()).body.items.length, 2);
  }));

test('match answers for ref-carrying files with the same content and decisions', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const committed = await t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: { 2: 'import', 3: 'skip' } });
    const storeBefore = await readFile(t.storePath, 'utf8');
    const found = await matchBody(t, { csv: DUP_IN_FILE, duplicateDecisions: { 2: 'import', 3: 'skip' } });
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.matches, [committed.body.import]);
    // Without the decisions the digest names a different choice: no match,
    // never a history-dependent rejection. Nothing is written either way.
    const withoutDecisions = await matchBody(t, { csv: DUP_IN_FILE });
    assert.equal(withoutDecisions.status, 200);
    assert.deepEqual(withoutDecisions.body, { matches: [] });
    const otherChoice = await matchBody(t, { csv: DUP_IN_FILE, duplicateDecisions: { 2: 'skip', 3: 'import' } });
    assert.deepEqual(otherChoice.body, { matches: [] });
    assert.equal(await readFile(t.storePath, 'utf8'), storeBefore);
  }));

test('decisions for rows that are not duplicates are ignored and still replay', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const res = await t.commit({ importKey: key, csv: REF_CSV, duplicateDecisions: { 2: 'skip' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 2); // the stray decision changed nothing
    assert.deepEqual(res.body.import.excludedRows, []);
    const items = (await t.list()).body.items;
    assert.equal(items.length, 2);
    // The same request — stray decision included — replays the same digest.
    const again = await t.commit({ importKey: key, csv: REF_CSV, duplicateDecisions: { 2: 'skip' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal((await t.list()).body.items.length, 2);
  }));

test('duplicate external references on multi-digit lines are decided by their exact numbers', () =>
  withTracker(async (t) => {
    // OPS-DUP repeats on physical lines 10 and 100; every other row keeps a
    // unique reference of its own (including line 9).
    const rows = ['title,external_ref'];
    for (let i = 2; i <= 100; i += 1) rows.push(i === 10 || i === 100 ? `Row ${i},OPS-DUP` : `Row ${i},OPS-${i}`);
    const csv = rows.join('\n') + '\n';
    const undecided = await t.commit({ importKey: randomUUID(), csv });
    assert.equal(undecided.status, 400);
    assert.equal(undecided.body.error.code, 'IMPORT_DUPLICATES_UNDECIDED');
    assert.deepEqual(undecided.body.error.details.duplicates.map((entry) => entry.line), [10, 100]);
    for (const entry of undecided.body.error.details.duplicates) assert.equal(entry.externalRef, 'OPS-DUP');
    const res = await t.commit({ importKey: randomUUID(), csv, duplicateDecisions: { 10: 'import', 100: 'skip' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 98); // 99 rows, one skipped
    assert.deepEqual(res.body.import.excludedRows.map((row) => row.line), [100]);
    const items = (await t.list()).body.items;
    assert.equal(items.filter((issue) => issue.externalRef === 'OPS-DUP').length, 1);
    assert.equal(items.filter((issue) => issue.externalRef === 'OPS-9').length, 1); // line 9 is its own unique row
  }));

test('a reference shared with an invalid row does not block the healthy row', () =>
  withTracker(async (t) => {
    // Line 2 has no title and carries OPS-5; line 3 is healthy with the same
    // reference. Only lines that could ever be imported count as duplicates,
    // so the healthy row commits through the valid-rows choice with no
    // decision, stores exactly once, and the invalid row stays out.
    const csv = 'title,external_ref\n,OPS-5\nHealthy,OPS-5\n';
    const res = await t.commit({ importKey: randomUUID(), csv, mode: 'valid_rows', excludedLines: [2] });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 1);
    assert.deepEqual(res.body.import.excludedRows.map((row) => row.line), [2]);
    assert.equal(res.body.import.excludedRows[0].problems[0].column, 'title');
    const items = (await t.list()).body.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Healthy');
    assert.equal(items[0].externalRef, 'OPS-5');
    // A second healthy row with the same reference IS a real duplicate now.
    const again = await t.commit({ importKey: randomUUID(), csv: 'title,external_ref\nAgain,OPS-5\n' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'IMPORT_DUPLICATES_UNDECIDED');
  }));

test('a replay and a match never depend on later imported history', () =>
  withTracker(async (t) => {
    // Baseline: the reference is unique when this import lands, so it needs
    // no decisions at all.
    const key = randomUUID();
    const baseline = await t.commit({ importKey: key, csv: REF_CSV });
    assert.equal(baseline.status, 201);
    // Later, another file explicitly imports OPS-1 again.
    const later = await t.commit({ importKey: randomUUID(), csv: LATER_FILE, duplicateDecisions: { 2: 'import', 3: 'import' } });
    assert.equal(later.status, 201);
    // Replaying the original request — no decisions, same key and file —
    // must still answer from the stored record, and matching it must still
    // find it: which references exist right now changes neither answer.
    const replay = await t.commit({ importKey: key, csv: REF_CSV });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.import, baseline.body.import);
    const found = await matchBody(t, { csv: REF_CSV });
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.matches, [baseline.body.import]);
    // A NEW import of the now-taken reference still has to decide explicitly.
    const fresh = await t.commit({ importKey: randomUUID(), csv: 'title,external_ref\nThird copy,OPS-1\n' });
    assert.equal(fresh.status, 400);
    assert.equal(fresh.body.error.code, 'IMPORT_DUPLICATES_UNDECIDED');
    assert.equal(fresh.body.error.details.duplicates[0].line, 2);
    assert.equal((await t.list()).body.items.length, 4); // nothing was added by any of the above
  }));

test('concurrent first commits of one ref-carrying key create exactly one batch', () =>
  withTracker(async (t) => {
    const key = randomUUID();
    const decisions = { 2: 'import', 3: 'skip' };
    const results = await Promise.all([1, 2, 3, 4].map(() => t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: decisions })));
    assert.deepEqual(
      results.map((r) => r.status).sort(),
      [200, 200, 200, 201],
    );
    const items = (await t.list()).body.items;
    assert.equal(items.length, 2);
    assert.equal(items.filter((issue) => issue.externalRef === 'OPS-9').length, 1);
  }));

test('precheck reports exactly the duplicates a commit would decide, and none for invalid rows', () =>
  withTracker(async (t) => {
    await t.commit({ importKey: randomUUID(), csv: REF_CSV });
    const earlier = (await t.list()).body.items.find((issue) => issue.externalRef === 'OPS-1');
    // Line 2 has no title (invalid); lines 3 and 4 share OPS-5; line 5 reuses OPS-1.
    const csv = 'title,external_ref\n,OPS-5\nFirst,OPS-5\nSecond,OPS-5\nOld again,OPS-1\n';
    const res = await precheck(t, { csv });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.duplicates.map((entry) => [entry.line, entry.externalRef, entry.kind]),
      [
        [3, 'OPS-5', 'in_file'],
        [4, 'OPS-5', 'in_file'],
        [5, 'OPS-1', 'already_imported'],
      ],
    );
    assert.equal(res.body.duplicates[0].lines.length, 2);
    assert.equal(res.body.duplicates[2].issueId, earlier.id);
    // the invalid line 2 shares OPS-5 but can never be imported: no flag for it
    assert.equal(res.body.duplicates.some((entry) => entry.line === 2), false);
  }));

test('skipping every importable row saves nothing', () =>
  withTracker(async (t) => {
    await t.commit({ importKey: randomUUID(), csv: REF_CSV });
    const res = await t.commit({ importKey: randomUUID(), csv: 'title,external_ref\nOld again,OPS-1\n', duplicateDecisions: { 2: 'skip' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IMPORT_INVALID');
    assert.match(res.body.error.message, /nothing was saved/i);
    assert.equal((await t.list()).body.items.length, 2);
  }));

test('valid_rows combines excluded invalid rows and skipped duplicates', () =>
  withTracker(async (t) => {
    // Lines: 2 and 3 share OPS-5; line 4 has no title; line 5 is clean.
    const csv = 'title,external_ref,status\nA,OPS-5,open\nB,OPS-5,open\n,OPS-6,open\nC,,open\n';
    const res = await t.commit({
      importKey: randomUUID(),
      csv,
      mode: 'valid_rows',
      excludedLines: [4],
      duplicateDecisions: { 2: 'import', 3: 'skip' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.import.issueCount, 2);
    assert.deepEqual(res.body.import.excludedRows.map((row) => row.line), [3, 4]);
    assert.equal(res.body.import.excludedRows[0].problems[0].column, 'external_ref');
    assert.equal(res.body.import.excludedRows[1].problems[0].column, 'title');
    const items = (await t.list()).body.items;
    assert.deepEqual(items.map((issue) => issue.title).sort(), ['A', 'C']);
    assert.equal(items.find((issue) => issue.title === 'A').externalRef, 'OPS-5');
  }));

test('precheck lists in-file and already-imported duplicates without writing', () =>
  withTracker(async (t) => {
    await t.commit({ importKey: randomUUID(), csv: REF_CSV });
    const earlier = (await t.list()).body.items.find((issue) => issue.externalRef === 'OPS-1');
    const storeBefore = await readFile(t.storePath, 'utf8');
    const history = await precheck(t, { csv: LATER_FILE });
    assert.equal(history.status, 200);
    assert.equal(history.body.duplicates.length, 1);
    assert.deepEqual(history.body.duplicates[0], { line: 3, externalRef: 'OPS-1', kind: 'already_imported', issueId: earlier.id, createdAt: earlier.createdAt });
    const inFile = await precheck(t, { csv: DUP_IN_FILE });
    assert.equal(inFile.status, 200);
    assert.deepEqual(
      inFile.body.duplicates.map((entry) => [entry.line, entry.externalRef, entry.kind]),
      [
        [2, 'OPS-9', 'in_file'],
        [3, 'OPS-9', 'in_file'],
      ],
    );
    const clean = await precheck(t, { csv: 'title,external_ref\nNew,OPS-42\n' });
    assert.deepEqual(clean.body, { duplicates: [] });
    assert.equal((await precheck(t, { csv: REF_CSV, extra: 1 })).status, 400);
    assert.equal((await t.request('/api/imports/precheck')).status, 405);
    assert.equal(await readFile(t.storePath, 'utf8'), storeBefore);
  }));

test('the lookup 404 message keeps the not-yet-confirmed meaning', () =>
  withTracker(async (t) => {
    const res = await t.lookup(randomUUID());
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'IMPORT_NOT_FOUND');
    assert.match(res.body.error.message, /No committed import is stored under this importKey yet/);
    assert.match(res.body.error.message, /may still be in flight/);
    assert.match(res.body.error.message, /does not prove that nothing was saved/);
    assert.doesNotMatch(res.body.error.message, /nothing was saved under it/i); // the old absolute claim is gone
  }));

test('a ref-carrying import with a skipped duplicate survives a restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'import-dup-restart-'));
  let t = null;
  try {
    const key = randomUUID();
    t = await boot(dataDir);
    const first = await t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: { 2: 'import', 3: 'skip' } });
    assert.equal(first.status, 201);
    await t.close();
    t = null;
    t = await boot(dataDir);
    const lookup = await t.lookup(key);
    assert.equal(lookup.status, 200);
    assert.deepEqual(lookup.body.import, first.body.import);
    const replay = await t.commit({ importKey: key, csv: DUP_IN_FILE, duplicateDecisions: { 2: 'import', 3: 'skip' } });
    assert.equal(replay.body.replayed, true);
    const items = (await t.list()).body.items;
    assert.equal(items.filter((issue) => issue.externalRef === 'OPS-9').length, 1);
    await t.close();
    t = null;
  } finally {
    if (t) await t.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an oversized external reference is a row problem naming the column', () =>
  withTracker(async (t) => {
    const csv = 'title,external_ref\nA,' + 'x'.repeat(101) + '\n';
    const res = await t.commit({ importKey: randomUUID(), csv });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'IMPORT_INVALID');
    assert.equal(res.body.error.details.rowErrors[0].problems[0].column, 'external_ref');
    assert.equal((await t.list()).body.items.length, 0);
  }));
