// Unit tests for the shared historical-import CSV parser and validator
// (specs/historical-issue-import.md). Fixtures are inline synthetic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, validateImportCsv, validRowsSelection, describeProblem, MAX_CSV_BYTES, MAX_IMPORT_ROWS, isImportKey } from '../public/csv-import.js';

const BOM = '\uFEFF';

test('parses quoted commas, multi-line fields, escaped quotes, BOM and CRLF', () => {
  const text = BOM + 'title,description\r\n"登录失败","用户说：""无法登录"", 请检查"\r\n"Line breaks","first line\r\nsecond, line"\r\n';
  const { records, error } = parseCsv(text);
  assert.equal(error, undefined);
  assert.deepEqual(records.map((r) => r.fields), [
    ['title', 'description'],
    ['登录失败', '用户说："无法登录", 请检查'],
    ['Line breaks', 'first line\nsecond, line'],
  ]);
  assert.deepEqual(records.map((r) => r.line), [1, 2, 3]);
});

test('record line numbers point at where a multi-line record starts', () => {
  const { records } = parseCsv('title,description\n"a","x\ny\nz"\nb,c\n');
  assert.deepEqual(records.map((r) => r.line), [1, 2, 5]);
});

test('an unterminated quote or a stray quote is a file error, not a guess', () => {
  assert.match(parseCsv('title\n"open').error, /never closed/);
  assert.match(parseCsv('title\nab"c"\n').error, /quote may only start/);
  assert.match(parseCsv('title\n"a"b\n').error, /after a closing quote/);
});

test('valid file normalizes rows with defaults and trims title/status/priority', () => {
  const v = validateImportCsv('Title,Description,Status,Priority\n  修复 导出  ,"含逗号, 和\n换行",,\nDone one,,done,urgent\n');
  assert.equal(v.valid, true);
  assert.deepEqual(v.rows.map((r) => r.issue), [
    { title: '修复 导出', description: '含逗号, 和\n换行', status: 'open', priority: 'normal' },
    { title: 'Done one', description: '', status: 'done', priority: 'urgent' },
  ]);
});

test('header may be a subset in any order; title is required', () => {
  const v = validateImportCsv('priority,title\nhigh,Only title\n');
  assert.equal(v.valid, true);
  assert.deepEqual(v.rows[0].issue, { title: 'Only title', description: '', status: 'open', priority: 'high' });
  const noTitle = validateImportCsv('description\nx\n');
  assert.equal(noTitle.valid, false);
  assert.match(noTitle.fileErrors.join(' '), /must include a title column/);
});

test('credential, id, timestamp and history columns reject the whole file', () => {
  for (const column of ['token', 'password', 'id', 'createdAt', 'completions', 'api_key']) {
    const v = validateImportCsv(`title,${column}\nA,secret\n`);
    assert.equal(v.valid, false, column);
    assert.match(v.fileErrors.join(' '), /Unsupported column/);
    assert.deepEqual(v.rows, [], 'no row preview for a refused header');
  }
  assert.match(validateImportCsv('title,title\nA,B\n').fileErrors.join(' '), /Repeated column/);
});

test('row errors are reported per line and make the batch invalid', () => {
  const v = validateImportCsv('title,status,priority\nGood,open,low\n   ,open,low\nBad prio,open,critical\nBad status,closed,low\nToo,many,fields,here\n');
  assert.equal(v.valid, false);
  const byLine = Object.fromEntries(v.rows.filter((r) => r.errors.length).map((r) => [r.line, r.errors.join(' ')]));
  assert.deepEqual(Object.keys(byLine).map(Number), [3, 4, 5, 6]);
  assert.match(byLine[3], /title is required/);
  assert.match(byLine[4], /priority "critical"/);
  assert.match(byLine[5], /status "closed"/);
  assert.match(byLine[6], /expected 3 field/);
  assert.deepEqual(v.rows[0].errors, []);
});

test('title and description length limits match the issue contract', () => {
  assert.equal(validateImportCsv(`title\n${'题'.repeat(120)}\n`).valid, true);
  assert.equal(validateImportCsv(`title\n${'题'.repeat(121)}\n`).valid, false);
  assert.equal(validateImportCsv(`title,description\nA,${'d'.repeat(4000)}\n`).valid, true);
  assert.equal(validateImportCsv(`title,description\nA,${'d'.repeat(4001)}\n`).valid, false);
});

test('size and row-count limits refuse the file instead of truncating it', () => {
  const atLimit = 'title\n' + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `Row ${i}`).join('\n') + '\n';
  assert.equal(validateImportCsv(atLimit).rows.length, MAX_IMPORT_ROWS);
  assert.equal(validateImportCsv(atLimit).valid, true);
  const over = atLimit + 'One more\n';
  const v = validateImportCsv(over);
  assert.equal(v.valid, false);
  assert.match(v.fileErrors.join(' '), new RegExp(`has ${MAX_IMPORT_ROWS + 1} issues`));
  assert.deepEqual(v.rows, []);
  const big = 'title,description\nA,"' + 'x'.repeat(MAX_CSV_BYTES) + '"\n';
  assert.match(validateImportCsv(big).fileErrors.join(' '), /limit is 262144 bytes/);
});

test('empty and header-only files are refused', () => {
  assert.match(validateImportCsv('').fileErrors.join(' '), /empty/);
  assert.match(validateImportCsv(BOM + 'title\n').fileErrors.join(' '), /no issues/);
  assert.equal(validateImportCsv(null).valid, false);
});

test('import keys must be UUIDs', () => {
  assert.equal(isImportKey('5b0f0d2a-3c1e-4a7b-9f00-1234567890ab'), true);
  assert.equal(isImportKey('not-a-key'), false);
  assert.equal(isImportKey(42), false);
});

test('every row problem names its line, its column (or the whole row) and a reason', () => {
  const result = validateImportCsv('title,status,priority\nOk,open,low\n,open,critical\nShort,open\nBad,closed,\n');
  assert.equal(result.valid, false);
  const byLine = Object.fromEntries(result.rows.map((row) => [row.line, row.problems]));
  assert.deepEqual(byLine[2], []);
  assert.deepEqual(byLine[3], [
    { column: 'title', reason: 'title is required.' },
    { column: 'priority', reason: 'priority "critical" is not one of: low, normal, high, urgent.' },
  ]);
  assert.deepEqual(byLine[4], [{ column: null, reason: 'expected 3 field(s) like the header, found 2.' }]);
  assert.deepEqual(byLine[5], [{ column: 'status', reason: 'status "closed" is not one of: open, in_progress, done.' }]);
  // errors keeps the same reason texts for message-only callers
  assert.deepEqual(result.rows[1].errors, ['title is required.', 'priority "critical" is not one of: low, normal, high, urgent.']);
  assert.equal(describeProblem(3, byLine[3][0]), 'Line 3, column title: title is required.');
  assert.equal(describeProblem(4, byLine[4][0]), 'Line 4, whole row: expected 3 field(s) like the header, found 2.');
});

test('the valid-rows choice exists only for an acceptable file with both valid and invalid rows', () => {
  const mixed = validRowsSelection(validateImportCsv('title,priority\nA,low\n,low\nB,\nC,critical\n'));
  assert.deepEqual(mixed.valid.map((row) => row.line), [2, 4]);
  assert.deepEqual(mixed.excludedLines, [3, 5]);
  assert.equal(validRowsSelection(validateImportCsv('title\nA\nB\n')), null, 'nothing to exclude: import the whole file');
  assert.equal(validRowsSelection(validateImportCsv('title,priority\n,low\nX,critical\n')), null, 'no valid row');
  assert.equal(validRowsSelection(validateImportCsv('title,password\nA,x\n,y\n')), null, 'file-level problem');
  const tooMany = 'title\n' + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `T${i}`).join('\n') + '\n\n';
  assert.equal(validRowsSelection(validateImportCsv(tooMany)), null, 'over the row limit even with an invalid row');
  assert.equal(validRowsSelection(null), null);
});
