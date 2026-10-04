// Completion-history regressions for the weekly-summary feedback release:
// server-owned append-only events recorded atomically with the accepting
// mutation. Covers creation directly as done, transitions into and out of
// done, repeated completion, unchanged-done edits, client-forged history,
// process reload, failed writes, and the legacy unknown-timing path. Store
// tests drive IssueStore directly; HTTP tests boot the real server. Every
// test uses an isolated temp DATA_DIR; no live data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueStore, StoreError } from '../src/store.js';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// ---------------------------------------------------------------------------
// Store level
// ---------------------------------------------------------------------------

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'completion-history-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('creation directly as done records exactly one completion event', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const issue = await store.create({ title: 'Born done', status: 'done', priority: 'high' });
    assert.equal(issue.completions.length, 1);
    assert.match(issue.completions[0], ISO_UTC);
    const open = await store.create({ title: 'Born open' });
    assert.deepEqual(open.completions, [], 'an open creation records nothing');
    const stored = JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8'));
    assert.equal(stored.issues[0].completions.length, 1);
    assert.deepEqual(stored.issues[1].completions, []);
  });
});

test('each accepted arrival in done appends one event; edits and staying done do not', async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const issue = await store.create({ title: 'Lifecycle', priority: 'low' });
    assert.deepEqual(issue.completions, []);

    await store.update(issue.id, { status: 'in_progress' });
    let listed = await store.list();
    assert.equal(listed[0].completions.length, 0, 'reaching in_progress records nothing');

    await store.update(issue.id, { status: 'done' });
    listed = await store.list();
    assert.equal(listed[0].completions.length, 1, 'the arrival in done appends one event');
    const firstEvent = listed[0].completions[0];

    await store.update(issue.id, { status: 'done', title: 'Renamed while done' });
    listed = await store.list();
    assert.equal(listed[0].completions.length, 1, 'staying done appends nothing');
    assert.equal(listed[0].title, 'Renamed while done');

    await store.update(issue.id, { priority: 'urgent' });
    listed = await store.list();
    assert.equal(listed[0].completions.length, 1, 'editing other fields appends nothing');

    await store.update(issue.id, { status: 'open' });
    listed = await store.list();
    assert.equal(listed[0].completions.length, 1, 'reopening never erases the past event');
    assert.equal(listed[0].completions[0], firstEvent);

    await store.update(issue.id, { status: 'done' });
    listed = await store.list();
    assert.equal(listed[0].completions.length, 2, 'a later real completion appends its own event');
    // Two transitions can land in the same clock millisecond, so the second
    // event may equal the first; it is never earlier and never skipped.
    assert.ok(listed[0].completions[1] >= firstEvent, 'the new event is not before the recorded one');
  });
});

test('events survive a process reload exactly as recorded', async () => {
  await withDir(async (dir) => {
    const first = new IssueStore(dir);
    const issue = await first.create({ title: 'Durable history' });
    await first.update(issue.id, { status: 'done' });
    await first.update(issue.id, { status: 'open' });
    await first.update(issue.id, { status: 'done' });
    const before = (await first.list())[0].completions.slice();

    const reloaded = new IssueStore(dir);
    const after = (await reloaded.list())[0].completions;
    assert.deepEqual(after, before);
    assert.equal(after.length, 2);
  });
});

test('a failed write appends no event and leaves the committed history intact', { skip: isRoot }, async () => {
  await withDir(async (dir) => {
    const store = new IssueStore(dir);
    const issue = await store.create({ title: 'Kept' });
    await store.update(issue.id, { status: 'done' });
    const bytesBefore = await readFile(join(dir, 'issues.json'), 'utf8');
    const committed = (await store.list())[0].completions.slice();

    await chmod(dir, 0o555);
    try {
      await assert.rejects(store.update(issue.id, { status: 'open' }), (err) => err instanceof StoreError);
      const listed = await store.list();
      assert.equal(listed[0].status, 'done', 'memory still shows the committed state');
      assert.deepEqual(listed[0].completions, committed, 'no smuggled or lost events');
    } finally {
      await chmod(dir, 0o755);
    }
    assert.equal(await readFile(join(dir, 'issues.json'), 'utf8'), bytesBefore, 'disk bytes unchanged');
  });
});

test('a legacy done issue stays unknown until a real completion happens', async () => {
  await withDir(async (dir) => {
    const runStartedAt = new Date().toISOString(); // runtime bound for fresh events
    await writeFile(join(dir, 'issues.json'), JSON.stringify({
      issues: [{
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Done before history existed',
        description: '',
        status: 'done',
        priority: 'normal',
        createdAt: '2026-01-05T09:00:00Z',
        updatedAt: '2026-01-06T09:00:00Z',
      }],
    }, null, 2) + '\n', 'utf8');

    const store = new IssueStore(dir);
    let listed = await store.list();
    assert.deepEqual(listed[0].completions, [], 'no event is invented for the legacy done issue');

    // Editing it does not turn into a completion.
    await store.update('11111111-1111-4111-8111-111111111111', { title: 'Edited, still done' });
    listed = await store.list();
    assert.equal(listed[0].status, 'done');
    assert.deepEqual(listed[0].completions, [], 'staying done through an edit records nothing');

    // Reopening and completing again records only the real new event.
    await store.update('11111111-1111-4111-8111-111111111111', { status: 'open' });
    await store.update('11111111-1111-4111-8111-111111111111', { status: 'done' });
    listed = await store.list();
    assert.equal(listed[0].completions.length, 1, 'exactly the one real event, no imagined history');
    assert.ok(listed[0].completions[0] >= runStartedAt, 'the event is a fresh server-clock instant from this run');
    assert.ok(listed[0].completions[0] <= new Date().toISOString(), 'and not from the future');
  });
});

// ---------------------------------------------------------------------------
// HTTP level (real server)
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
          return { status: response.status, body, headers: response.headers };
        },
        async postIssue(payload) {
          return this.request('/api/issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
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

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'completion-http-'));
  const tracker = await bootTracker(dataDir);
  try {
    await run(tracker);
  } finally {
    await tracker.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function mondayOf(ms) {
  const date = new Date(ms);
  const midnight = new Date(0);
  midnight.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight.getTime() - ((date.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000;
}
function formatIsoDate(ms) {
  const date = new Date(ms);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

test('accepted transitions through the API append history the report can see', async () => {
  await withServer(async (tracker) => {
    const created = await tracker.postIssue({ title: 'HTTP lifecycle', priority: 'normal' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const week = formatIsoDate(mondayOf(Date.parse(created.body.createdAt)));

    const done = await tracker.patchIssue(id, { status: 'done' });
    assert.equal(done.status, 200);
    let report = await tracker.report(week);
    assert.equal(report.body.completed.total, 1);
    assert.equal(report.body.completed.repeatCompletions, 0);

    const reopened = await tracker.patchIssue(id, { status: 'open' });
    assert.equal(reopened.status, 200);
    report = await tracker.report(week);
    assert.equal(report.body.completed.total, 1, 'reopening keeps the completion credit');

    const again = await tracker.patchIssue(id, { status: 'done' });
    assert.equal(again.status, 200);
    report = await tracker.report(week);
    assert.equal(report.body.completed.total, 1, 'same task, same week: still one completed task');
    assert.equal(report.body.completed.repeatCompletions, 1, 'the repeat is represented separately');

    // The stored record holds exactly two events; the issue resource never
    // exposes them.
    const stored = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.equal(stored.issues[0].completions.length, 2);
  });
});

test('clients cannot supply or edit completion history through any endpoint', async () => {
  await withServer(async (tracker) => {
    const created = await tracker.postIssue({ title: 'Forging attempt', completions: ['2020-01-01T00:00:00Z'] });
    assert.equal(created.status, 400);
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');

    const ok = await tracker.postIssue({ title: 'Real issue' });
    assert.equal(ok.status, 201);
    assert.equal('completions' in ok.body, false, 'the resource never carries the history');

    const patch = await tracker.patchIssue(ok.body.id, { completions: [] });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.code, 'VALIDATION_ERROR');

    const listed = await tracker.request('/api/issues');
    assert.equal(listed.status, 200);
    for (const issue of listed.body.items) {
      assert.deepEqual(
        Object.keys(issue).sort(),
        ['createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt'],
      );
    }

    const stored = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.deepEqual(stored.issues[0].completions, [], 'no forged event reached the disk');
  });
});

test('POST still rejects status, and creation as done is a store-level capability only', async () => {
  await withServer(async (tracker) => {
    const created = await tracker.postIssue({ title: 'Try direct done', status: 'done' });
    assert.equal(created.status, 400, 'the HTTP creation contract still refuses status');
    assert.equal(created.body.error.code, 'VALIDATION_ERROR');
  });
});
