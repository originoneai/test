// Integration regression for the weekly summary on the assembled product: the
// real server (GET/POST/PATCH /api/issues and GET /api/reports/weekly), the
// real HTTP adapter from public/app.js and the real mounted board UI, driven
// through a minimal fake DOM. Fixtures are independent of the API and UI test
// files (a different week and different records, written straight to an
// isolated store before boot). No live data is touched.
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
// Independent fixtures: week 2026-08-31, mixed buckets, one legacy record,
// and both sides of the week boundaries.
// ---------------------------------------------------------------------------

function fixtureIssues() {
  const record = (slot, createdAt, extra = {}, legacy = false) => {
    const base = {
      id: '22222222-2222-4222-8222-00000000000' + slot,
      title: 'Fixture ' + slot,
      description: '',
      status: 'open',
      createdAt,
      updatedAt: createdAt,
    };
    return legacy ? base : { ...base, priority: 'normal', ...extra };
  };
  return [
    record(1, '2026-08-31T00:00:00.000Z', { priority: 'low' }), // inclusive Monday midnight
    record(2, '2026-09-02T12:30:45.123Z', { status: 'in_progress', priority: 'urgent' }),
    record(3, '2026-09-06T23:59:59.999Z', { status: 'done', priority: 'high' }), // last ms of Sunday
    record(4, '2026-09-04T08:00:00.000Z', {}, true), // legacy six-field record -> normal
    record(5, '2026-09-07T00:00:00.000Z', { status: 'done', priority: 'urgent' }), // exclusive end, outside
    record(6, '2026-08-30T23:59:59.999Z', { status: 'done', priority: 'high' }), // previous Sunday, outside
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
  const dataDir = await mkdtemp(join(tmpdir(), 'weekly-int-'));
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

const countOf = (root, key, value) => byRole(root, `weekly-${key}-${value}`).textContent;
function shownCounts(root) {
  return {
    total: byRole(root, 'weekly-total').textContent,
    byStatus: ['open', 'in_progress', 'done'].map((k) => countOf(root, 'status', k)).join(','),
    byPriority: ['low', 'normal', 'high', 'urgent'].map((k) => countOf(root, 'priority', k)).join(','),
  };
}

test('mounted board renders the real weekly report for the default UTC week', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, WEEK, 'default week comes from the board clock');
    assert.deepEqual(shownCounts(root), { total: '4', byStatus: '2,1,1', byPriority: '1,1,1,1' });
    assert.equal(byRole(root, 'weekly-total-label').textContent, 'issues created in this week');
    assert.equal(app.weekly.state.data.weekStart, WEEK);
    assert.equal(app.weekly.state.data.weekEndExclusive, '2026-09-07');
    // The unrelated board is intact: six seeded cards in their columns.
    assert.equal(byRole(root, 'count-open').textContent, '2');
    assert.equal(byRole(root, 'count-in_progress').textContent, '1');
    assert.equal(byRole(root, 'count-done').textContent, '3');
  });
});

test('board search filters the list but leaves the weekly summary alone', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    const before = shownCounts(root);
    const search = byId(root, 'search');
    search.value = 'Fixture 2';
    await search.dispatch('input');
    await until(() => byRole(root, 'board-status').textContent.includes('1 issue shown'), 'filtered board');
    assert.equal(elementsOf(root).filter((el) => el.getAttribute('data-role') === 'card').length, 1);
    assert.deepEqual(shownCounts(root), before, 'summary counts and week are unchanged by board filters');
    assert.equal(app.weekly.state.week, WEEK);
    search.value = '';
    await search.dispatch('input');
    await until(() => byRole(root, 'board-status').textContent.includes('6 issues shown'), 'unfiltered board');
  });
});

test('an inline priority change refreshes the summary with current stored values', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    const control = elementsOf(root).find(
      (el) => el.getAttribute('data-role') === 'card-priority-control' && el.getAttribute('data-issue-id') === '22222222-2222-4222-8222-000000000001',
    );
    control.value = 'urgent';
    await control.dispatch('change');
    await app.weekly.idle();
    await until(() => countOf(root, 'priority', 'urgent') === '2', 'priority bucket moves');
    assert.deepEqual(shownCounts(root), { total: '4', byStatus: '2,1,1', byPriority: '0,1,1,2' });
  });
});

test('creating an issue and selecting the real current week shows it alone', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    const title = byId(root, 'new-title');
    title.value = 'Integration created issue';
    await byRole(root, 'create-form').dispatch('submit');
    await until(() => byRole(root, 'board-status').textContent.includes('7 issues shown'), 'created issue on the board');
    // The server stamped it with the real clock: jump to that real week.
    const now = new Date();
    const midnight = new Date(0);
    midnight.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    midnight.setUTCHours(0, 0, 0, 0);
    const realMonday = new Date(midnight.getTime() - ((now.getUTCDay() + 6) % 7) * DAY_MS);
    const picker = byRole(root, 'weekly-week');
    picker.value = realMonday.toISOString().slice(0, 10);
    await picker.dispatch('change');
    await app.weekly.idle();
    assert.deepEqual(shownCounts(root), { total: '1', byStatus: '1,0,0', byPriority: '0,1,0,0' });
    // "This week" returns to the board-clock week and its current values.
    await byRole(root, 'weekly-this').dispatch('click');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, WEEK);
    assert.equal(byRole(root, 'weekly-total').textContent, '4');
  });
});

test('the previous week holds only the Sunday-before issue; a truly empty week renders zero', async () => {
  await withIntegration(async ({ root, app }) => {
    await app.ready;
    await app.weekly.idle();
    await byRole(root, 'weekly-prev').dispatch('click');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, '2026-08-24');
    // Fixture 6 (2026-08-30, the Sunday before the fixture week) is this
    // week's only intake, at its current stored status and priority.
    assert.deepEqual(shownCounts(root), { total: '1', byStatus: '0,0,1', byPriority: '0,0,1,0' });
    // 2026-08-17 has no intake at all: every bucket renders an explicit zero.
    const picker = byRole(root, 'weekly-week');
    picker.value = '2026-08-17';
    await picker.dispatch('change');
    await app.weekly.idle();
    assert.equal(app.weekly.state.week, '2026-08-17');
    assert.deepEqual(shownCounts(root), { total: '0', byStatus: '0,0,0', byPriority: '0,0,0,0' });
    assert.match(byRole(root, 'weekly-status').textContent, /No issues were created in this week/);
    assert.equal(app.weekly.state.data.created.total, 0);
    assert.deepEqual(app.weekly.state.data.created.byPriority, { low: 0, normal: 0, high: 0, urgent: 0 });
  });
});

test('the adapter surfaces server validation for a non-Monday week over the wire', async () => {
  await withIntegration(async ({ adapter }) => {
    await assert.rejects(adapter.weeklyReport('2026-08-30'), (err) => {
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.match(err.message, /Monday/);
      return true;
    }, 'the real server rejects a Sunday weekStart');
    const report = await adapter.weeklyReport(WEEK);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.weekStart, WEEK);
    assert.equal(report.weekEndExclusive, '2026-09-07');
  });
});
