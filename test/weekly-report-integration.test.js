// Integration regression for the weekly summary on the assembled feedback-1
// product: the real server (issue APIs and the version-2 weekly report), the
// real HTTP adapter from public/app.js and the real mounted board UI, driven
// through a minimal fake DOM. Fixtures are independent of the other suites
// (week 2026-08-31, records with recorded completion histories, repeats,
// earlier-created completions and a legacy done issue). No live data is
// touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';
import { createHttpAdapter, mountApp } from '../public/app.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK = '2026-08-31'; // a Monday; independent of the other suites' weeks

// ---------------------------------------------------------------------------
// Minimal fake DOM (text stays data, like real textContent)
// ---------------------------------------------------------------------------

class FakeText {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.parentNode = null; }
  get textContent() { return this.data; }
}

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeType = 1;
    this.children = []; this.attributes = new Map(); this.listeners = new Map();
    this.parentNode = null; this.disabled = false; this.hidden = false; this.className = '';
    this.style = {};
    this.classList = {
      toggle: (name, force) => {
        const set = new Set(this.className ? this.className.split(/\s+/).filter(Boolean) : []);
        const on = force === undefined ? !set.has(name) : Boolean(force);
        if (on) set.add(name); else set.delete(name);
        this.className = [...set].join(' ');
        return on;
      },
    };
  }
  get isConnected() {
    let node = this;
    while (node) { if (node === this.ownerDocument.root) return true; node = node.parentNode; }
    return false;
  }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const options = elementsOf(this).filter((el) => el.tagName === 'OPTION');
      const marked = options.find((el) => el.getAttribute('selected') !== null || el.selected === true);
      const shown = marked ?? options[0];
      if (shown) return shown.getAttribute('value') ?? shown.textContent;
    }
    return '';
  }
  set value(next) { this._value = next; }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) {
    for (const old of this.children) old.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(key, val) { this.attributes.set(key, val === true ? '' : String(val)); }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    if (!('preventDefault' in event)) event.preventDefault = () => {};
    return Promise.all([...(this.listeners.get(type) ?? [])].map((fn) => fn(event)));
  }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.setAttribute('open', ''); }
  close() { this.removeAttribute('open'); }
  get textContent() { return this.children.map((child) => child.textContent).join(''); }
  set textContent(text) {
    for (const old of this.children) old.parentNode = null;
    this.children = text === '' ? [] : [this.ownerDocument.createTextNode(text)];
  }
}

class FakeDocument {
  constructor() { this.activeElement = null; this.root = null; }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(text); }
}

function elementsOf(node, out = []) {
  for (const child of node.children ?? []) {
    if (child.nodeType === 1) { out.push(child); elementsOf(child, out); }
  }
  return out;
}
const byRole = (root, role) => elementsOf(root).find((el) => el.getAttribute('data-role') === role);
const byId = (root, id) => elementsOf(root).find((el) => el.getAttribute('id') === id);
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await tick(10);
  }
  assert.ok(condition(), 'timed out waiting for ' + what);
}

// ---------------------------------------------------------------------------
// Independent fixtures for the completed-throughput half of the summary.
// ---------------------------------------------------------------------------

function fixtureIssues() {
  const record = (slot, createdAt, extra = {}) => {
    return {
      id: '33333333-3333-4333-8333-00000000000' + slot,
      title: 'Fixture ' + slot,
      description: '',
      status: 'open',
      priority: 'normal',
      createdAt,
      updatedAt: createdAt,
      completions: [],
      ...extra,
    };
  };
  return [
    // Created in an earlier week, completed twice inside the selected week:
    // one completed task, one repeat, counted as created-earlier.
    record(1, '2026-08-20T10:00:00.000Z', { status: 'open', priority: 'high', completions: ['2026-08-31T00:00:00.000Z', '2026-09-02T09:00:00.000Z'] }),
    // Created and completed inside the week, currently done.
    record(2, '2026-09-01T09:00:00.000Z', { status: 'done', priority: 'urgent', completions: ['2026-09-05T23:59:59.999Z'] }),
    // Reopened work: completed in the selected week, currently open again.
    record(3, '2026-08-25T08:00:00.000Z', { status: 'open', priority: 'low', completions: ['2026-09-03T12:00:00.000Z'] }),
    // Legacy seven-field done issue: completion time unknown, no week.
    {
      id: '33333333-3333-4333-8333-000000000004',
      title: 'Legacy done fixture',
      description: '',
      status: 'done',
      priority: 'normal',
      createdAt: '2026-08-28T08:00:00.000Z',
      updatedAt: '2026-08-28T08:00:00.000Z',
    },
    // Completion event exactly at the exclusive end: outside the week.
    record(5, '2026-08-20T10:00:00.000Z', { priority: 'low', completions: ['2026-09-07T00:00:00.000Z'] }),
    // Completion event on the Sunday before the week: belongs to that week.
    record(6, '2026-08-05T10:00:00.000Z', { priority: 'normal', completions: ['2026-08-30T23:59:59.999Z'] }),
    // Created this week, never completed: intake only.
    record(7, '2026-09-02T11:00:00.000Z', { status: 'in_progress', priority: 'normal' }),
  ];
}

function bootServer(dataDir) {
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: 'http://127.0.0.1:' + server.address().port,
        stop() {
          return new Promise((done) => {
            server.close(done);
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

async function withIntegration(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'weekly-fb1-int-'));
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'issues.json'), JSON.stringify({ issues: fixtureIssues() }, null, 2) + '\n');
  const service = await bootServer(dataDir);
  const adapter = createHttpAdapter({ base: service.base });
  const doc = new FakeDocument();
  const root = new FakeElement(doc, 'div');
  doc.root = root;
  // The board clock is pinned inside the fixture week, so the default summary
  // is that week; real server timestamps still come from the real clock.
  const app = mountApp(root, { adapter, doc, searchDelayMs: 0, reports: adapter, now: () => new Date('2026-09-02T10:00:00.000Z') });
  try {
    await run({ service, adapter, doc, root, app });
  } finally {
    await service.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const countOf = (root, role) => byRole(root, role).textContent;
function shownCreated(root) {
  return {
    total: countOf(root, 'weekly-total'),
    byStatus: ['open', 'in_progress', 'done'].map((k) => countOf(root, `weekly-status-${k}`)).join(','),
    byPriority: ['low', 'normal', 'high', 'urgent'].map((k) => countOf(root, `weekly-priority-${k}`)).join(','),
  };
}
function shownCompleted(root) {
  return {
    total: countOf(root, 'weekly-completed-total'),
    byPriority: ['low', 'normal', 'high', 'urgent'].map((k) => countOf(root, `weekly-completed-priority-${k}`)).join(','),
    createdThisWeek: countOf(root, 'weekly-completed-created-this-week'),
    createdEarlier: countOf(root, 'weekly-completed-created-earlier'),
    repeatCompletions: countOf(root, 'weekly-repeat'),
  };
}
function realMonday() {
  const now = new Date();
  const midnight = new Date(0);
  midnight.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  midnight.setUTCHours(0, 0, 0, 0);
  const monday = new Date(midnight.getTime() - ((now.getUTCDay() + 6) % 7) * DAY_MS);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(monday.getUTCFullYear(), 4)}-${pad(monday.getUTCMonth() + 1, 2)}-${pad(monday.getUTCDate(), 2)}`;
}

test('mounted board renders intake and completed throughput as separate numbers', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, WEEK);
    // Intake: fixtures 2 and 7 were created inside the week.
    assert.deepEqual(shownCreated(root), { total: '2', byStatus: '0,1,1', byPriority: '0,1,0,1' });
    // Throughput: fixtures 1, 2 and 3 hold events inside the week — fixture 1
    // once with one repeat, fixture 2 once, fixture 3 once although reopened.
    assert.deepEqual(shownCompleted(root), {
      total: '3',
      byPriority: '1,0,1,1',
      createdThisWeek: '1',
      createdEarlier: '2',
      repeatCompletions: '1',
    });
    // The legacy done issue is explicit, belongs to no week.
    assert.equal(byRole(root, 'weekly-unknown').hidden, false);
    assert.match(byRole(root, 'weekly-unknown-text').textContent, /1 done issue has no recorded completion time/);
    // The unrelated board is intact: four open, one in progress, two done.
    assert.equal(byRole(root, 'count-open').textContent, '4');
    assert.equal(byRole(root, 'count-in_progress').textContent, '1');
    assert.equal(byRole(root, 'count-done').textContent, '2');
  });
});

test('board search filters the list but leaves both summary statistics alone', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    const before = { created: shownCreated(root), completed: shownCompleted(root) };
    const search = byId(root, 'search');
    search.value = 'Fixture 7';
    await search.dispatch('input');
    await until(() => byRole(root, 'board-status').textContent.includes('1 issue shown'), 'filtered board');
    assert.equal(elementsOf(root).filter((el) => el.getAttribute('data-role') === 'card').length, 1);
    assert.deepEqual(shownCreated(root), before.created);
    assert.deepEqual(shownCompleted(root), before.completed);
    assert.equal(app.weekly.state.week, WEEK);
    search.value = '';
    await search.dispatch('input');
    await until(() => byRole(root, 'board-status').textContent.includes('7 issues shown'), 'unfiltered board');
  });
});

test('an inline priority change moves the completed bucket to the current priority', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    const control = elementsOf(root).find(
      (el) => el.getAttribute('data-role') === 'card-priority-control' && el.getAttribute('data-issue-id') === '33333333-3333-4333-8333-000000000003',
    );
    control.value = 'urgent';
    await control.dispatch('change');
    await app.weekly.idle();
    await until(() => countOf(root, 'weekly-completed-priority-urgent') === '2', 'completed bucket moves to the current priority');
    // Both statistics follow the currently stored priority: fixtures 1 high,
    // 2 urgent, 3 now urgent.
    assert.deepEqual(shownCompleted(root).byPriority.split(','), ['0', '0', '1', '2']);
  });
});

test('a completion recorded now appears in the real current week, not the pinned one', async () => {
  await withIntegration(async ({ root, app, adapter }) => {
    await app.ready;
    await app.weekly.idle();
    await adapter.update('33333333-3333-4333-8333-000000000007', { status: 'done' });
    await byRole(root, 'refresh').dispatch('click');
    await app.weekly.idle();
    // The pinned fixture week is untouched by an October event.
    assert.equal(countOf(root, 'weekly-completed-total'), '3');
    // Selecting the real current week shows exactly the new event: fixture 7
    // was created in late August, so it counts as created-earlier there.
    const picker = byRole(root, 'weekly-week');
    picker.value = realMonday();
    await picker.dispatch('change');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, realMonday());
    assert.equal(countOf(root, 'weekly-completed-total'), '1');
    assert.equal(countOf(root, 'weekly-repeat'), '0', 'a first completion adds no repeat');
    assert.equal(countOf(root, 'weekly-completed-created-this-week'), '0');
    assert.equal(countOf(root, 'weekly-completed-created-earlier'), '1');
    assert.equal(countOf(root, 'weekly-total'), '0', 'no fixture was created in the real week');
    // Back on the pinned week everything historical is unchanged.
    await byRole(root, 'weekly-this').dispatch('click');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, WEEK);
    assert.equal(countOf(root, 'weekly-completed-total'), '3');
    assert.equal(byRole(root, 'weekly-unknown').hidden, false, 'legacy unknown timing stays explicit');
  });
});

test('creating through the form auto-refreshes the selected real week without manual reload', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    // Select the real current week first: the fixtures leave it empty, so any
    // count that appears after the create can only come from the automatic
    // refresh a board change must trigger.
    const picker = byRole(root, 'weekly-week');
    picker.value = realMonday();
    await picker.dispatch('change');
    await app.weekly.idle();
    assert.equal(countOf(root, 'weekly-total'), '0', 'the real week starts empty');
    const title = byId(root, 'new-title');
    title.value = 'Born during the workflow';
    await byRole(root, 'create-form').dispatch('submit');
    await until(() => byRole(root, 'board-status').textContent.includes('8 issues shown'), 'created issue on the board');
    // No week switch, no Refresh click: the summary updates by itself.
    await until(() => countOf(root, 'weekly-total') === '1', 'the summary auto-refreshed after the board change');
    assert.deepEqual(shownCreated(root), { total: '1', byStatus: '1,0,0', byPriority: '0,1,0,0' });
    assert.equal(countOf(root, 'weekly-completed-total'), '0', 'creating alone completes nothing');
    // Switching back shows the pinned fixture week untouched.
    await byRole(root, 'weekly-this').dispatch('click');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, WEEK);
    assert.equal(countOf(root, 'weekly-total'), '2');
  });
});

test('the previous week holds only the Sunday-before completion; an empty week shows zeros', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    await byRole(root, 'weekly-prev').dispatch('click');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, '2026-08-24');
    assert.equal(countOf(root, 'weekly-completed-total'), '1');
    assert.equal(countOf(root, 'weekly-completed-created-earlier'), '1');
    assert.equal(byRole(root, 'weekly-unknown').hidden, false, 'unknown count is week-independent');
    // 2026-07-27 holds neither a creation nor a completion event.
    const picker = byRole(root, 'weekly-week');
    picker.value = '2026-07-27';
    await picker.dispatch('change');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, '2026-07-27');
    assert.deepEqual(shownCreated(root), { total: '0', byStatus: '0,0,0', byPriority: '0,0,0,0' });
    assert.deepEqual(shownCompleted(root), {
      total: '0',
      byPriority: '0,0,0,0',
      createdThisWeek: '0',
      createdEarlier: '0',
      repeatCompletions: '0',
    });
  });
});

test('the adapter validates the version-2 report and rejects a non-Monday week over the wire', async () => {
  await withIntegration(async ({ adapter }) => {
    const report = await adapter.weeklyReport(WEEK);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.weekStart, WEEK);
    assert.equal(report.weekEndExclusive, '2026-09-07');
    assert.equal(report.completed.total, 3);
    assert.equal(report.completed.repeatCompletions, 1);
    assert.equal(report.completedTimingUnknown, 1);
    await assert.rejects(adapter.weeklyReport('2026-08-30'), (err) => {
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.match(err.message, /Monday/);
      return true;
    }, 'the real server rejects a Sunday weekStart');
  });
});
