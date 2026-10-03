// Regression tests for the weekly summary report (specs/weekly-delivery-summary.md):
// GET /api/reports/weekly?weekStart=YYYY-MM-DD. Covers week selection and
// boundaries, the exact zero-inclusive response shape, validation of the single
// parameter, 405 handling, calendar edge years, corrupt-store failure without
// rewrite, and that issue mutations keep working alongside the report. Every
// test uses an isolated temp DATA_DIR; no live data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function bootTracker(dataDir) {
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const tracker = {
        dataDir,
        base,
        storePath: join(dataDir, 'issues.json'),
        async request(path, options = {}) {
          const response = await fetch(base + path, options);
          const text = await response.text();
          let body = text;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              /* keep raw text */
            }
          }
          return { status: response.status, body, text, headers: response.headers };
        },
        async report(query = '') {
          return this.request('/api/reports/weekly' + query);
        },
        async postIssue(title, extra = {}) {
          return this.request('/api/issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, ...extra }),
          });
        },
        async patchIssue(id, payload) {
          return this.request('/api/issues/' + id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
        },
        async stop() {
          await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          });
        },
      };
      resolve(tracker);
    });
  });
}

async function withTracker(run, seed) {
  const dataDir = await mkdtemp(join(tmpdir(), 'weekly-report-'));
  if (seed) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'issues.json'), JSON.stringify({ issues: seed }, null, 2) + '\n');
  }
  const tracker = await bootTracker(dataDir);
  try {
    await run(tracker);
  } finally {
    await tracker.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function assertErrorBody(body) {
  assert.ok(body && typeof body === 'object' && body.error, 'error body has error object: ' + JSON.stringify(body));
  assert.equal(typeof body.error.code, 'string', 'error code is a string');
  assert.equal(typeof body.error.message, 'string', 'error message is a string');
  assert.equal('stack' in body.error, false, 'error body has no stack trace');
}

function assertValidationError(body) {
  assertErrorBody(body);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
}

function zeroReport(weekStart, weekEndExclusive) {
  return {
    schemaVersion: 1,
    weekStart,
    weekEndExclusive,
    created: {
      total: 0,
      byStatus: { open: 0, in_progress: 0, done: 0 },
      byPriority: { low: 0, normal: 0, high: 0, urgent: 0 },
    },
  };
}

// The Monday 00:00 UTC of the given instant, mirroring the server's rule.
function mondayOf(ms) {
  const date = new Date(ms);
  const midnight = new Date(0);
  midnight.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS;
}

function formatIsoDate(ms) {
  const date = new Date(ms);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

// Stored-record fixture: defaults match a freshly created issue; every
// override (status, priority, updatedAt, id, ...) replaces the default. The
// slot only feeds the id/title and is never stored as a field.
function issue(overrides) {
  const { slot, createdAt, updatedAt, ...rest } = overrides;
  return {
    id: '11111111-1111-4111-8111-00000000000' + slot,
    title: 'Issue ' + slot,
    description: '',
    status: 'open',
    priority: 'normal',
    createdAt,
    updatedAt: updatedAt || createdAt,
    ...rest,
  };
}

test('empty store: omitted weekStart reports the current UTC week, all keys zero', async () => {
  await withTracker(async (tracker) => {
    const before = mondayOf(Date.now());
    const response = await tracker.report();
    const after = mondayOf(Date.now());
    // A UTC Sunday->Monday midnight between the two clock reads is the only
    // way these differ; the answer must still be one of the two Mondays.
    assert.ok(
      response.body.weekStart === formatIsoDate(before) || response.body.weekStart === formatIsoDate(after),
      'weekStart is the current UTC Monday: ' + JSON.stringify(response.body),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.body.weekStart, ISO_DATE);
    assert.match(response.body.weekEndExclusive, ISO_DATE);
    const startMs = Date.parse(response.body.weekStart + 'T00:00:00.000Z');
    assert.equal(new Date(startMs).getUTCDay(), 1, 'weekStart is a Monday');
    assert.equal(response.body.weekEndExclusive, formatIsoDate(startMs + 7 * DAY_MS));
    assert.deepEqual(response.body, zeroReport(response.body.weekStart, response.body.weekEndExclusive));
  });
});

test('omitted weekStart counts an issue created now in its creation week', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue('Fresh intake', { priority: 'high' });
    assert.equal(created.status, 201);
    const weekOfCreation = formatIsoDate(mondayOf(Date.parse(created.body.createdAt)));
    const response = await tracker.report();
    assert.equal(response.status, 200);
    assert.equal(response.body.weekStart, weekOfCreation);
    assert.deepEqual(response.body.created, {
      total: 1,
      byStatus: { open: 1, in_progress: 0, done: 0 },
      byPriority: { low: 0, normal: 0, high: 1, urgent: 0 },
    });
  });
});

test('explicit weekStart tallies only that week using current stored status and priority', async () => {
  await withTracker(
    async (tracker) => {
      const response = await tracker.report('?weekStart=2026-09-28');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        schemaVersion: 1,
        weekStart: '2026-09-28',
        weekEndExclusive: '2026-10-05',
        created: {
          total: 4,
          byStatus: { open: 2, in_progress: 1, done: 1 },
          byPriority: { low: 1, normal: 1, high: 1, urgent: 1 },
        },
      });
    },
    [
      // Inside the week: inclusive Monday midnight, mid-week, last millisecond
      // of Sunday, and a legacy six-field record (reads as normal priority).
      issue({ slot: 1, createdAt: '2026-09-28T00:00:00.000Z', priority: 'low' }),
      issue({ slot: 2, createdAt: '2026-09-30T09:15:30.123Z', status: 'in_progress', priority: 'urgent' }),
      issue({ slot: 3, createdAt: '2026-10-04T23:59:59.999Z', status: 'done', priority: 'high', updatedAt: '2026-12-31T10:00:00.000Z' }),
      {
        id: '11111111-1111-4111-8111-000000000004',
        title: 'Legacy issue',
        description: '',
        status: 'open',
        createdAt: '2026-10-01T12:00:00.000Z',
        updatedAt: '2026-10-01T12:00:00.000Z',
      },
      // Outside the week: exactly the exclusive end, and the previous Sunday.
      issue({ slot: 5, createdAt: '2026-10-05T00:00:00.000Z', status: 'done', priority: 'urgent' }),
      issue({ slot: 6, createdAt: '2026-09-27T23:59:59.999Z', status: 'in_progress', priority: 'high' }),
    ],
  );
});

test('later mutations move an issue between buckets; updatedAt is never used', async () => {
  await withTracker(async (tracker) => {
    const first = await tracker.postIssue('Grows up fast', { priority: 'low' });
    const second = await tracker.postIssue('Stays put');
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const patched = await tracker.patchIssue(first.body.id, { status: 'done', priority: 'urgent' });
    assert.equal(patched.status, 200);
    const week = formatIsoDate(mondayOf(Date.parse(first.body.createdAt)));
    const response = await tracker.report('?weekStart=' + week);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.created, {
      total: 2,
      byStatus: { open: 1, in_progress: 0, done: 1 },
      byPriority: { low: 0, normal: 1, high: 0, urgent: 1 },
    });
  });
});

test('non-Monday, impossible and malformed weekStart values are validation errors', async () => {
  await withTracker(async (tracker) => {
    const bad = ['2026-09-27', '2026-10-01', '2026-02-30', '2026-13-01', '2026-00-10', '2026-9-28', '20260928', 'not-a-date', '2026-09-28T00:00:00Z', '', '99999-01-06'];
    for (const value of bad) {
      const response = await tracker.report('?weekStart=' + encodeURIComponent(value));
      assert.equal(response.status, 400, 'rejects weekStart=' + JSON.stringify(value));
      assertValidationError(response.body);
    }
  });
});

test('unknown and repeated query parameters are validation errors', async () => {
  await withTracker(async (tracker) => {
    const bad = ['?foo=1', '?weekStart=2026-09-28&foo=2', '?weekStart=2026-09-28&weekStart=2026-10-05', '?foo=1&bar=2'];
    for (const query of bad) {
      const response = await tracker.report(query);
      assert.equal(response.status, 400, 'rejects ' + query);
      assertValidationError(response.body);
    }
  });
});

test('low-year Mondays keep four-digit boundaries (0099, 0100, 0999)', async () => {
  await withTracker(async (tracker) => {
    const cases = [
      ['0099-01-05', '0099-01-12'],
      ['0100-01-04', '0100-01-11'],
      ['0999-01-07', '0999-01-14'],
    ];
    for (const [weekStart, weekEndExclusive] of cases) {
      const response = await tracker.report('?weekStart=' + weekStart);
      assert.equal(response.status, 200, weekStart + ' is accepted');
      assert.deepEqual(response.body, zeroReport(weekStart, weekEndExclusive));
    }
  });
});

test('upper boundary: 9999-12-20 is the last selectable week, 9999-12-27 is rejected', async () => {
  await withTracker(async (tracker) => {
    const ok = await tracker.report('?weekStart=9999-12-20');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, zeroReport('9999-12-20', '9999-12-27'));
    const rejected = await tracker.report('?weekStart=9999-12-27');
    assert.equal(rejected.status, 400);
    assertValidationError(rejected.body);
  });
});

test('unsupported methods on the report path get 405 with Allow: GET', async () => {
  await withTracker(async (tracker) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await tracker.request('/api/reports/weekly', { method });
      assert.equal(response.status, 405, method + ' is rejected');
      assert.equal(response.headers.get('allow'), 'GET');
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
    }
  });
});

test('corrupt store: report answers STORAGE_ERROR and never rewrites the file', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'weekly-report-'));
  const garbage = '{not json at all';
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'issues.json'), garbage);
  const tracker = await bootTracker(dataDir);
  try {
    const response = await tracker.report('?weekStart=2026-09-28');
    assert.equal(response.status, 500);
    assertErrorBody(response.body);
    assert.equal(response.body.error.code, 'STORAGE_ERROR');
    assert.equal(await readFile(tracker.storePath, 'utf8'), garbage, 'store file is untouched');
  } finally {
    await tracker.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('reading the report leaves issue APIs and stored bytes intact', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue('Survives reporting');
    assert.equal(created.status, 201);
    const before = await readFile(tracker.storePath, 'utf8');
    const week = formatIsoDate(mondayOf(Date.parse(created.body.createdAt)));
    const response = await tracker.report('?weekStart=' + week);
    assert.equal(response.status, 200);
    assert.equal(response.body.created.total, 1);
    assert.equal(await readFile(tracker.storePath, 'utf8'), before, 'report is read-only');
    const list = await tracker.request('/api/issues');
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.deepEqual(list.body.items[0], created.body);
  });
});
