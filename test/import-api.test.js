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
