// Completion-priority regressions for the weekly-summary feedback-2 release:
// completion events snapshot the resulting issue priority at completion time,
// and the weekly report buckets a week's completed issues by their earliest
// in-week event at full timestamp precision (distinct sub-millisecond
// instants never collapse into ties; append order breaks only true ties).
// Covers priority edits after completion, simultaneous done+priority
// changes, same-week repeats with different priorities, next-week snapshots,
// out-of-order legacy events and equal-time ties, mixed string/object
// history, all-unknown and no-event history, UTC edges and extreme years,
// atomic failed writes, reload, corruption rejection, client-forged history
// and defensive copies. Store tests drive IssueStore directly; HTTP tests
// boot the real server. Every test uses an isolated temp DATA_DIR; no live
// data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueStore, StoreError } from '../src/store.js';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK = '2026-10-05'; // a Monday; independent of the other suites' weeks
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// ---------------------------------------------------------------------------
// Store level
// ---------------------------------------------------------------------------

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'completion-priority-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('new events are immutable {at, priority} snapshots of the resulting priority', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const born = await store.create({ title: 'Born done', status: 'done', priority: 'high' });
    assert.deepEqual(born.completions, [{ at: born.createdAt, priority: 'high' }]);

    const issue = await store.create({ title: 'Grows up', priority: 'normal' });
    // A simultaneous status+priority change is captured in one event.
    const done = await store.update(issue.id, { status: 'done', priority: 'urgent' });
    assert.equal(done.completions.length, 1);
    assert.equal(done.completions[0].priority, 'urgent', 'the snapshot records the resulting priority');
    assert.equal(done.completions[0].at, done.updatedAt);

    // Later edits — including priority — never touch recorded snapshots.
    await store.update(issue.id, { priority: 'low' });
    const listed = await store.list();
    assert.equal(listed[0].completions[0].priority, 'urgent');

    const stored = JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8'));
    assert.deepEqual(stored.issues[1].completions, [{ at: done.updatedAt, priority: 'urgent' }]);
  });
});

test('string events stay strings forever; mixed history loads unchanged', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'issues.json'), JSON.stringify({
      issues: [{
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Mixed history',
        description: '',
        status: 'open',
        priority: 'high',
        createdAt: '2026-09-01T08:00:00.000Z',
        updatedAt: '2026-10-06T08:00:00.000Z',
        completions: ['2026-10-05T10:00:00.000Z', { at: '2026-10-07T10:00:00.000Z', priority: 'low' }],
      }],
    }, null, 2) + '\n', 'utf8');
    const bytesBefore = await readFile(join(dir, 'issues.json'), 'utf8');

    const store = new IssueStore(dir);
    const listed = await store.list();
    assert.deepEqual(
      listed[0].completions,
      ['2026-10-05T10:00:00.000Z', { at: '2026-10-07T10:00:00.000Z', priority: 'low' }],
      'strings and objects load exactly as stored',
    );
    assert.equal(await readFile(join(dir, 'issues.json'), 'utf8'), bytesBefore, 'reads never rewrite');

    // The next successful write persists the mixed list unchanged: the
    // string is not "upgraded" to a snapshot.
    await store.update('11111111-1111-4111-8111-111111111111', { title: 'Mixed, renamed' });
    const stored = JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8'));
    assert.equal(stored.issues[0].completions[0], '2026-10-05T10:00:00.000Z');
    assert.deepEqual(stored.issues[0].completions[1], { at: '2026-10-07T10:00:00.000Z', priority: 'low' });
  });
});

test('defensive copies: mutating returned history cannot change storage', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const issue = await store.create({ title: 'Snapshot safety', priority: 'normal' });
    await store.update(issue.id, { status: 'done', priority: 'high' });

    const first = await store.list();
    first[0].completions[0].priority = 'low'; // mutate the handed-out copy
    first[0].completions.push('2099-01-01T00:00:00.000Z');
    const second = await store.list();
    assert.equal(second[0].completions.length, 1);
    assert.equal(second[0].completions[0].priority, 'high');

    // Mutating a create/update reply changes nothing either.
    const created = await store.create({ title: 'Born done', status: 'done', priority: 'urgent' });
    created.completions[0].at = '2000-01-01T00:00:00.000Z';
    created.completions.pop();
    const after = await store.list();
    const born = after.find((item) => item.title === 'Born done');
    assert.equal(born.completions.length, 1);
    assert.match(born.completions[0].at, ISO_UTC);
    assert.notEqual(born.completions[0].at, '2000-01-01T00:00:00.000Z');

    const stored = JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8'));
    for (const item of stored.issues) {
      for (const event of item.completions) {
        if (typeof event !== 'string') assert.notEqual(event.priority, 'low', 'no mutated priority reached disk');
      }
    }
  });
});

test('a failed write publishes no issue or event change', { skip: isRoot }, async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const issue = await store.create({ title: 'Kept', priority: 'normal' });
    await store.update(issue.id, { status: 'done', priority: 'high' });
    const bytesBefore = await readFile(join(dir, 'issues.json'), 'utf8');
    const committed = (await store.list())[0];

    await chmod(dir, 0o555);
    try {
      // A reopening edit would change the committed issue; the failed write
      // must publish none of it — neither state nor event history.
      await assert.rejects(store.update(issue.id, { status: 'open', priority: 'urgent' }), (err) => err instanceof StoreError);
    } finally {
      await chmod(dir, 0o755);
    }
    const listed = await store.list();
    assert.equal(listed[0].status, committed.status, 'committed issue state unchanged');
    assert.deepEqual(listed[0].completions, committed.completions, 'no event smuggled or lost');
    assert.equal(await readFile(join(dir, 'issues.json'), 'utf8'), bytesBefore, 'disk bytes unchanged');
  });
});

test('corrupt snapshot objects are refused like any corruption', async () => {
  await withDir(async (dir) => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Stored item',
      description: '',
      status: 'done',
      priority: 'normal',
      createdAt: '2026-10-05T08:00:00.000Z',
      updatedAt: '2026-10-05T08:00:00.000Z',
    };
    const cases = [
      ['extra key', { ...base, completions: [{ at: '2026-10-05T09:00:00.000Z', priority: 'low', note: 'x' }] }],
      ['missing priority', { ...base, completions: [{ at: '2026-10-05T09:00:00.000Z' }] }],
      ['non-enum priority', { ...base, completions: [{ at: '2026-10-05T09:00:00.000Z', priority: 'critical' }] }],
      ['non-UTC at', { ...base, completions: [{ at: '2026-10-05T09:00:00+01:00', priority: 'low' }] }],
      ['impossible at', { ...base, completions: [{ at: '2026-02-30T09:00:00.000Z', priority: 'low' }] }],
      ['event not an object', { ...base, completions: [7] }],
      ['events not a list', { ...base, completions: '2026-10-05T09:00:00.000Z' }],
    ];
    for (const [label, record] of cases) {
      const content = JSON.stringify({ issues: [record] }, null, 2) + '\n';
      await writeFile(join(dir, 'issues.json'), content, 'utf8');
      const store = new IssueStore(dir);
      await assert.rejects(store.list(), (err) => {
        assert.ok(err instanceof StoreError, label);
        assert.equal(err.code, 'STORE_ERROR');
        return true;
      }, label);
      assert.equal(await readFile(join(dir, 'issues.json'), 'utf8'), content, 'bytes untouched: ' + label);
    }
  });
});

test('events survive a process reload exactly as recorded', async () => {
  await withDir(async (dir) => {
    const first = new IssueStore(dir);
    const a = await first.create({ title: 'A', priority: 'low' });
    await first.update(a.id, { status: 'done', priority: 'high' });
    await first.update(a.id, { status: 'open' });
    await first.update(a.id, { status: 'done', priority: 'normal' });
    const before = (await first.list()).find((item) => item.title === 'A').completions;

    const reloaded = new IssueStore(dir);
    const after = (await reloaded.list()).find((item) => item.title === 'A').completions;
    assert.deepEqual(after, before);
    assert.equal(after[0].priority, 'high');
    assert.equal(after[1].priority, 'normal');
  });
});

// ---------------------------------------------------------------------------
// HTTP level: the frozen report v3 (real server)
// ---------------------------------------------------------------------------

function bootTracker(dataDir) {
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const tracker = {
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
          return { status: response.status, body };
        },
        async patchIssue(id, payload) {
          return this.request('/api/issues/' + id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
        },
        async report(weekStart) {
          return this.request('/api/reports/weekly?weekStart=' + weekStart);
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

async function withServer(run, seed) {
  const dataDir = await mkdtemp(join(tmpdir(), 'completion-priority-http-'));
  if (seed) {
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

// Live PATCH transitions happen at the real clock, so live-created
// completions land in the real current week.
function realMonday() {
  const now = new Date();
  const midnight = new Date(0);
  midnight.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  midnight.setUTCHours(0, 0, 0, 0);
  const monday = new Date(midnight.getTime() - ((now.getUTCDay() + 6) % 7) * DAY_MS);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(monday.getUTCFullYear(), 4)}-${pad(monday.getUTCMonth() + 1, 2)}-${pad(monday.getUTCDate(), 2)}`;
}

function v3Completed(report) {
  const { total, byPriority, priorityUnknown, createdThisWeek, createdEarlier, repeatCompletions } = report.completed;
  return { total, byPriority, priorityUnknown, createdThisWeek, createdEarlier, repeatCompletions };
}

test('a priority edit after completion never moves the completed distribution', async () => {
  await withServer(async (tracker) => {
    const created = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Stable history', priority: 'high' }),
    });
    const id = created.body.id;
    await tracker.patchIssue(id, { status: 'done' });
    const week = realMonday();
    let report = await tracker.report(week);
    assert.equal(report.body.schemaVersion, 3);
    assert.deepEqual(v3Completed(report.body), {
      total: 1,
      byPriority: { low: 0, normal: 0, high: 1, urgent: 0 },
      priorityUnknown: 0,
      createdThisWeek: 1,
      createdEarlier: 0,
      repeatCompletions: 0,
    });

    // Reprioritize the completed issue twice; the week's bucket never moves.
    await tracker.patchIssue(id, { priority: 'urgent' });
    report = await tracker.report(week);
    assert.equal(report.body.completed.byPriority.high, 1);
    assert.equal(report.body.completed.byPriority.urgent, 0);
    await tracker.patchIssue(id, { priority: 'low' });
    report = await tracker.report(week);
    assert.equal(report.body.completed.byPriority.high, 1, 'first snapshot wins forever');
  });
});

test('simultaneous done+priority change and same-week repeats snapshot each arrival', async () => {
  await withServer(async (tracker) => {
    const created = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Journey', priority: 'normal' }),
    });
    const id = created.body.id;
    await tracker.patchIssue(id, { status: 'done', priority: 'urgent' });
    await tracker.patchIssue(id, { status: 'open' });
    await tracker.patchIssue(id, { status: 'done', priority: 'low' });
    const report = await tracker.report(realMonday());
    assert.deepEqual(v3Completed(report.body), {
      total: 1,
      // The earliest in-week event (urgent) fixes the bucket; the later
      // low-priority completion is an extra event, not a re-bucketing.
      byPriority: { low: 0, normal: 0, high: 0, urgent: 1 },
      priorityUnknown: 0,
      createdThisWeek: 1,
      createdEarlier: 0,
      repeatCompletions: 1,
    });
  });
});

test('fixture week: earliest event wins, ties by append order, strings are unknown', async () => {
  await withServer(
    async (tracker) => {
      const report = await tracker.report(WEEK);
      assert.equal(report.status, 200);
      // Slot 1: two snapshot events; the earliest (Tuesday) is high, the
      // later Friday urgent event is only an extra. Slot 2: equal-time
      // snapshots — the first appended (normal) fixes the bucket. Slot 3: a
      // string event earlier in the week than its snapshot; the string is
      // the earliest, so the issue is priorityUnknown, and its snapshot is
      // an extra same-week event. Slot 4: snapshot event exactly at the
      // exclusive end — outside. Slot 5: string event on the Sunday before —
      // belongs to the previous week. Three issues with two in-week events
      // each: three repeats.
      assert.deepEqual(v3Completed(report.body), {
        total: 3,
        byPriority: { low: 0, normal: 1, high: 1, urgent: 0 },
        priorityUnknown: 1,
        createdThisWeek: 1,
        createdEarlier: 2,
        repeatCompletions: 3,
      });
      assert.equal(report.body.completedTimingUnknown, 1, 'legacy done issue with no events at all');
      // Four buckets plus unknown always sum to total.
      const b = report.body.completed.byPriority;
      assert.equal(b.low + b.normal + b.high + b.urgent + report.body.completed.priorityUnknown, report.body.completed.total);
    },
    [
      {
        id: '55555555-5555-4555-8555-000000000001',
        title: 'Two snapshots',
        description: '',
        status: 'open',
        priority: 'urgent',
        createdAt: '2026-09-20T08:00:00.000Z',
        updatedAt: '2026-10-09T08:00:00.000Z',
        completions: [
          { at: '2026-10-06T08:00:00.000Z', priority: 'high' },
          { at: '2026-10-09T08:00:00.000Z', priority: 'urgent' },
        ],
      },
      {
        id: '55555555-5555-4555-8555-000000000002',
        title: 'Equal-time snapshots',
        description: '',
        status: 'done',
        priority: 'low',
        createdAt: '2026-10-07T08:00:00.000Z',
        updatedAt: '2026-10-08T08:00:00.000Z',
        completions: [
          { at: '2026-10-08T08:00:00.000Z', priority: 'normal' },
          { at: '2026-10-08T08:00:00.000Z', priority: 'high' },
        ],
      },
      {
        // Out-of-order list: the snapshot is earlier in append order but the
        // string holds the week's earliest instant.
        id: '55555555-5555-4555-8555-000000000003',
        title: 'String beats later snapshot',
        description: '',
        status: 'open',
        priority: 'high',
        createdAt: '2026-09-25T08:00:00.000Z',
        updatedAt: '2026-10-10T08:00:00.000Z',
        completions: [
          { at: '2026-10-09T08:00:00.000Z', priority: 'high' },
          '2026-10-05T00:00:00.000Z',
        ],
      },
      {
        id: '55555555-5555-4555-8555-000000000004',
        title: 'Exclusive end',
        description: '',
        status: 'open',
        priority: 'low',
        createdAt: '2026-09-20T08:00:00.000Z',
        updatedAt: '2026-10-12T08:00:00.000Z',
        completions: [{ at: '2026-10-12T00:00:00.000Z', priority: 'low' }],
      },
      {
        id: '55555555-5555-4555-8555-000000000005',
        title: 'Sunday before',
        description: '',
        status: 'open',
        priority: 'low',
        createdAt: '2026-09-20T08:00:00.000Z',
        updatedAt: '2026-10-04T08:00:00.000Z',
        completions: ['2026-10-04T23:59:59.999Z'],
      },
      {
        // Done with no events anywhere: timing unknown, week-independent.
        id: '55555555-5555-4555-8555-000000000006',
        title: 'Legacy done',
        description: '',
        status: 'done',
        priority: 'normal',
        createdAt: '2026-09-01T08:00:00.000Z',
        updatedAt: '2026-09-01T08:00:00.000Z',
      },
    ],
  );
});

test('a later week is bucketed by its own first event, UTC edges included', async () => {
  await withServer(
    async (tracker) => {
      // Week 2026-10-05 holds the Monday-midnight event (high); week
      // 2026-10-12 holds the Sunday-last-millisecond event (low); week
      // 2026-10-19 holds its own Monday midnight (urgent). The 10-19
      // instant is exactly week 2's exclusive end and week 3's start.
      let report = await tracker.report(WEEK);
      assert.deepEqual(v3Completed(report.body), {
        total: 1,
        byPriority: { low: 0, normal: 0, high: 1, urgent: 0 },
        priorityUnknown: 0,
        createdThisWeek: 0,
        createdEarlier: 1,
        repeatCompletions: 0,
      });
      report = await tracker.report('2026-10-12');
      assert.deepEqual(v3Completed(report.body), {
        total: 1,
        byPriority: { low: 1, normal: 0, high: 0, urgent: 0 },
        priorityUnknown: 0,
        createdThisWeek: 0,
        createdEarlier: 1,
        repeatCompletions: 0,
      });
      report = await tracker.report('2026-10-19');
      assert.deepEqual(v3Completed(report.body), {
        total: 1,
        byPriority: { low: 0, normal: 0, high: 0, urgent: 1 },
        priorityUnknown: 0,
        createdThisWeek: 0,
        createdEarlier: 1,
        repeatCompletions: 0,
      });
    },
    [{
      id: '55555555-5555-4555-8555-000000000011',
      title: 'Weekly ladder',
      description: '',
      status: 'open',
      priority: 'urgent',
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-10-25T08:00:00.000Z',
      completions: [
        { at: '2026-10-05T00:00:00.000Z', priority: 'high' },   // week 1 Monday midnight
        { at: '2026-10-18T23:59:59.999Z', priority: 'low' },     // week 2 Sunday last ms
        { at: '2026-10-19T00:00:00.000Z', priority: 'urgent' },  // week 3 Monday midnight
      ],
    }],
  );
});

test('sub-millisecond precision: the earliest instant wins regardless of append order', async () => {
  await withServer(
    async (tracker) => {
      const report = await tracker.report(WEEK);
      assert.deepEqual(v3Completed(report.body), {
        // Issue 1: two events sharing the same first three fractional digits
        // (.1234 and .1235 both truncate to .123 milliseconds). The .1234
        // string sits later in the array but is the earliest distinct
        // instant, so the issue counts as priorityUnknown — not the .1235
        // high snapshot appended first. Issue 2: the same instant written
        // differently (.5 vs .50); a true tie, so append order picks the
        // first (urgent). Each issue holds two in-week events, so two
        // repeats in total.
        total: 2,
        byPriority: { low: 0, normal: 0, high: 0, urgent: 1 },
        priorityUnknown: 1,
        createdThisWeek: 0,
        createdEarlier: 2,
        repeatCompletions: 2,
      });
    },
    [
      {
        id: '55555555-5555-4555-8555-000000000031',
        title: 'Reverse-append sub-millisecond',
        description: '',
        status: 'open',
        priority: 'low',
        createdAt: '2026-09-20T08:00:00.000Z',
        updatedAt: '2026-10-06T08:00:00.000Z',
        completions: [
          { at: '2026-10-06T08:00:00.1235Z', priority: 'high' },
          '2026-10-06T08:00:00.1234Z',
        ],
      },
      {
        id: '55555555-5555-4555-8555-000000000032',
        title: 'Equal instant, different precision',
        description: '',
        status: 'open',
        priority: 'low',
        createdAt: '2026-09-20T08:00:00.000Z',
        updatedAt: '2026-10-07T08:00:00.000Z',
        completions: [
          { at: '2026-10-07T08:00:00.5Z', priority: 'urgent' },
          { at: '2026-10-07T08:00:00.50Z', priority: 'normal' },
        ],
      },
    ],
  );
});

test('extreme years keep the v3 shape and the at-completion basis', async () => {
  await withServer(
    async (tracker) => {
      const report = await tracker.report('0099-01-05');
      assert.equal(report.status, 200);
      assert.equal(report.body.schemaVersion, 3);
      assert.deepEqual(v3Completed(report.body), {
        total: 2,
        byPriority: { low: 0, normal: 0, high: 0, urgent: 1 },
        priorityUnknown: 1,
        createdThisWeek: 0,
        createdEarlier: 2,
        repeatCompletions: 0,
      });
      assert.equal(report.body.completedTimingUnknown, 0);
    },
    [
      {
        id: '55555555-5555-4555-8555-000000000021',
        title: 'Snapshot in 0099',
        description: '',
        status: 'open',
        priority: 'low',
        createdAt: '0098-06-01T00:00:00.000Z',
        updatedAt: '0099-01-06T00:00:00.000Z',
        completions: [{ at: '0099-01-05T00:00:00.000Z', priority: 'urgent' }],
      },
      {
        id: '55555555-5555-4555-8555-000000000022',
        title: 'String in 0099',
        description: '',
        status: 'open',
        priority: 'high',
        createdAt: '0098-06-01T00:00:00.000Z',
        updatedAt: '0099-01-07T00:00:00.000Z',
        completions: ['0099-01-06T00:00:00.000Z'],
      },
    ],
  );
});

test('clients still cannot forge or erase history through any endpoint', async () => {
  await withServer(async (tracker) => {
    const created = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Forge guard', completions: [{ at: '2020-01-01T00:00:00.000Z', priority: 'low' }] }),
    });
    assert.equal(created.status, 400);
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');

    const ok = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Real issue' }),
    });
    assert.equal(ok.status, 201);
    assert.equal('completions' in ok.body, false);

    const patch = await tracker.patchIssue(ok.body.id, { completions: [] });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.code, 'VALIDATION_ERROR');

    const stored = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.deepEqual(stored.issues[0].completions, [], 'no forged event reached the disk');
  });
});
