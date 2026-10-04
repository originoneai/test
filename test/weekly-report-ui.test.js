// Frontend coverage for the Weekly summary: UTC week helpers, the version-3
// report shape check (version-1, version-2 and malformed replies refused), the live HTTP
// adapter's report read, and the mounted summary (default current UTC week,
// week selection, created and completed shown separately, repeat completions,
// priority at completion (with its separate unknown bucket for completions
// recorded before priority was stored), unknown completion timing, independence from the
// board's search and filters, refresh after board changes, loading, empty,
// failure and stale-reply handling). The report endpoint is stubbed here with
// synthetic responses that follow the agreed version-3 contract
// (GET /api/reports/weekly?weekStart=YYYY-MM-DD), not a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, FIRST_WEEK_START, LAST_WEEK_START, addUtcDays, createHttpAdapter, formatUtcDay,
  isSupportedWeek, isValidWeeklyReport, mountApp, parseIsoDate, utcWeekStart, weeklyReportProblem,
} from '../public/app.js';

const STATUSES = ['open', 'in_progress', 'done'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

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
const allByRole = (root, role) => elementsOf(root).filter((el) => el.getAttribute('data-role') === role);
const byId = (root, id) => elementsOf(root).find((el) => el.getAttribute('id') === id);
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ---------------------------------------------------------------------------
// Fixtures: an issue store shared by the board adapter, a completion history
// the stub server keeps (append-only, server clock), and a report stub that
// counts like the version-3 contract. A completion event is either an object
// {at, priority} (priority recorded with the completion) or a bare timestamp
// string (an old event recorded before priority was stored with it).
// ---------------------------------------------------------------------------

const WEEK = '2026-09-28'; // a Monday
const PREV_WEEK = '2026-09-21';
const SERVER_NOW = '2026-10-02T00:00:00.000Z'; // the stub server's clock for changes

function fixtureIssues() {
  const at = (iso) => ({ createdAt: iso, updatedAt: iso });
  return [
    { id: 'wk-0001', title: 'Printer jam', description: '', status: 'open', priority: 'urgent', ...at('2026-09-28T00:00:00.000Z') },
    { id: 'wk-0002', title: '<b>Markup</b> title', description: 'needle', status: 'in_progress', priority: 'high', ...at('2026-09-30T12:00:00.000Z') },
    { id: 'wk-0003', title: 'Login needle', description: '', status: 'open', priority: 'normal', ...at('2026-10-04T23:59:59.999Z') },
    { id: 'wk-0004', title: 'Done thing', description: '', status: 'done', priority: 'low', ...at('2026-10-01T08:00:00.000Z') },
    // Created outside the week: the Sunday before and the Monday after.
    { id: 'wk-0005', title: 'Before', description: '', status: 'open', priority: 'normal', ...at('2026-09-27T23:59:59.999Z') },
    { id: 'wk-0006', title: 'After', description: '', status: 'open', priority: 'normal', ...at('2026-10-05T00:00:00.000Z') },
    // Created earlier, completed in the last millisecond of the week.
    { id: 'wk-0007', title: 'Old report', description: '', status: 'done', priority: 'high', ...at('2026-09-10T09:00:00.000Z') },
    // Completed on both sides of the week, never inside it.
    { id: 'wk-0008', title: 'Edge completions', description: '', status: 'done', priority: 'normal', ...at('2026-09-01T09:00:00.000Z') },
    // Legacy: done before completion times were recorded (updated in the week,
    // which must not be read as a completion time).
    { id: 'wk-0009', title: 'Legacy done', description: '', status: 'done', priority: 'normal', createdAt: '2026-08-01T09:00:00.000Z', updatedAt: '2026-09-30T09:00:00.000Z' },
  ];
}

// Recorded completion events (server-clock UTC), oldest first.
const done = (at, priority) => ({ at, priority });
function fixtureCompletions() {
  return {
    // Completed, then reopened: the completion stays in the week.
    'wk-0001': [done('2026-09-29T10:00:00.000Z', 'urgent')],
    // Completed three times in the week (reopened twice): one issue, two extra.
    'wk-0004': [done('2026-10-01T09:00:00.000Z', 'low'), done('2026-10-02T10:00:00.000Z', 'low'), done('2026-10-03T11:00:00.000Z', 'low')],
    'wk-0007': [done('2026-10-04T23:59:59.999Z', 'high')],
    'wk-0008': [done('2026-09-27T23:59:59.999Z', 'normal'), done('2026-10-05T00:00:00.000Z', 'normal')],
  };
}
const eventAt = (event) => (typeof event === 'string' ? event : event.at);
const eventPriority = (event) => (typeof event === 'string' ? null : event.priority);

function boardAdapter(store, history) {
  const calls = { list: [], create: [], update: [] };
  return {
    mode: 'recording', calls,
    async list(filters = {}) {
      calls.list.push({ ...filters });
      const needle = String(filters.q || '').toLowerCase();
      return [...store.values()]
        .filter((issue) => (!filters.status || issue.status === filters.status)
          && (!filters.priority || issue.priority === filters.priority)
          && (!needle || issue.title.toLowerCase().includes(needle) || issue.description.toLowerCase().includes(needle)))
        .map((issue) => ({ ...issue }));
    },
    async create(input) {
      calls.create.push({ ...input });
      const stamp = '2026-09-29T10:00:00.000Z';
      const issue = { id: 'wk-new-' + calls.create.length, title: String(input.title).trim(), description: input.description ?? '',
        status: 'open', priority: input.priority ?? 'normal', createdAt: stamp, updatedAt: stamp };
      store.set(issue.id, issue);
      return { ...issue };
    },
    async update(id, patch) {
      calls.update.push({ id, patch: { ...patch } });
      const prev = store.get(id);
      const next = { ...prev, ...patch, updatedAt: SERVER_NOW };
      // Like the server: a move into done from another status appends one event.
      // The event records the priority the issue has as it is completed.
      if (next.status === 'done' && prev.status !== 'done') history.set(id, [...(history.get(id) ?? []), done(SERVER_NOW, next.priority)]);
      store.set(id, next);
      return { ...next };
    },
  };
}

function countReport(store, weekStart, history = new Map()) {
  const start = Date.parse(weekStart + 'T00:00:00.000Z');
  const end = start + 7 * 24 * 60 * 60 * 1000;
  const inWeek = (event) => { const t = Date.parse(eventAt(event)); return t >= start && t < end; };
  const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
  const created = { total: 0, byStatus: zeros(STATUSES), byPriority: zeros(PRIORITIES) };
  const completed = { total: 0, byPriority: zeros(PRIORITIES), priorityUnknown: 0, createdThisWeek: 0, createdEarlier: 0, repeatCompletions: 0 };
  let completedTimingUnknown = 0;
  for (const issue of store.values()) {
    if (inWeek(issue.createdAt)) { created.total += 1; created.byStatus[issue.status] += 1; created.byPriority[issue.priority] += 1; }
    // Earliest completion in the week first; a stable sort keeps append order for ties.
    const events = (history.get(issue.id) ?? []).filter(inWeek)
      .sort((a, b) => Date.parse(eventAt(a)) - Date.parse(eventAt(b)));
    if (events.length > 0) {
      completed.total += 1;
      completed.repeatCompletions += events.length - 1;
      // The bucket is the priority recorded with that first completion, never
      // the current priority; an old bare-timestamp event is unknown.
      const atCompletion = eventPriority(events[0]);
      if (atCompletion === null) completed.priorityUnknown += 1; else completed.byPriority[atCompletion] += 1;
      if (inWeek(issue.createdAt)) completed.createdThisWeek += 1; else completed.createdEarlier += 1;
    }
    if (issue.status === 'done' && (history.get(issue.id) ?? []).length === 0) completedTimingUnknown += 1;
  }
  return { schemaVersion: 3, weekStart, weekEndExclusive: addUtcDays(weekStart, 7), created, completed, completedTimingUnknown };
}

const fixtureStore = () => new Map(fixtureIssues().map((i) => [i.id, i]));
const fixtureHistory = () => new Map(Object.entries(fixtureCompletions()));
const emptyReport = (weekStart, weekEndExclusive = addUtcDays(weekStart, 7)) => ({ schemaVersion: 3, weekStart, weekEndExclusive,
  created: { total: 0, byStatus: { open: 0, in_progress: 0, done: 0 }, byPriority: { low: 0, normal: 0, high: 0, urgent: 0 } },
  completed: { total: 0, byPriority: { low: 0, normal: 0, high: 0, urgent: 0 }, priorityUnknown: 0, createdThisWeek: 0, createdEarlier: 0, repeatCompletions: 0 },
  completedTimingUnknown: 0 });

// What a version-2 server would send for the same data: completed issues by
// their current priority, no priorityUnknown.
function version2Of(report) {
  const { priorityUnknown: _p, ...completed } = report.completed;
  return { ...report, schemaVersion: 2, completed: { ...completed, byPriority: { ...completed.byPriority, normal: completed.byPriority.normal + report.completed.priorityUnknown } } };
}

// A report source over the store; `next` (if set) answers the next read.
function reportStub(store, history) {
  const stub = {
    calls: [],
    next: [],
    async weeklyReport(weekStart) {
      stub.calls.push(weekStart);
      const custom = stub.next.shift();
      if (custom) return custom(weekStart);
      return countReport(store, weekStart, history);
    },
  };
  return stub;
}

async function mountSummary({ now = new Date('2026-09-30T15:00:00.000Z'), issues = fixtureIssues(), completions = fixtureCompletions(), withReports = true } = {}) {
  const store = new Map(issues.map((issue) => [issue.id, { ...issue }]));
  const history = new Map(Object.entries(completions).map(([id, events]) => [id, [...events]]));
  const adapter = boardAdapter(store, history);
  const reports = reportStub(store, history);
  const doc = new FakeDocument();
  const root = new FakeElement(doc, 'div');
  doc.root = root;
  const app = mountApp(root, { adapter, doc, searchDelayMs: 0, reports: withReports ? reports : null, now: () => now });
  await app.ready;
  await app.weekly.idle();
  return { doc, root, app, adapter, reports, store, history };
}

const countOf = (root, key, value) => byRole(root, `weekly-${key}-${value}`).textContent;
function shownCounts(root) {
  return {
    total: byRole(root, 'weekly-total').textContent,
    byStatus: Object.fromEntries(STATUSES.map((k) => [k, countOf(root, 'status', k)])),
    byPriority: Object.fromEntries(PRIORITIES.map((k) => [k, countOf(root, 'priority', k)])),
  };
}
const text = (root, role) => byRole(root, role).textContent;
function shownCompleted(root) {
  return {
    total: text(root, 'weekly-completed-total'),
    repeat: text(root, 'weekly-repeat'),
    createdThisWeek: text(root, 'weekly-completed-created-this-week'),
    createdEarlier: text(root, 'weekly-completed-created-earlier'),
    byPriority: Object.fromEntries(PRIORITIES.map((k) => [k, countOf(root, 'completed-priority', k)])),
    priorityUnknown: countOf(root, 'completed-priority', 'unknown'),
  };
}

// ---------------------------------------------------------------------------
// Week helpers and report shape
// ---------------------------------------------------------------------------

test('UTC week helpers name the Monday of the UTC week and only accept real dates', () => {
  assert.equal(utcWeekStart(new Date('2026-09-28T00:00:00.000Z')), WEEK, 'Monday 00:00 UTC starts its own week');
  assert.equal(utcWeekStart(new Date('2026-10-04T23:59:59.999Z')), WEEK, 'Sunday 23:59 UTC is still that week');
  assert.equal(utcWeekStart(new Date('2026-10-05T00:00:00.000Z')), '2026-10-05', 'the next Monday starts the next week');
  // 2026-10-04 20:30 in New York (UTC-4) is already Monday 00:30 UTC.
  assert.equal(utcWeekStart(new Date('2026-10-04T20:30:00-04:00')), '2026-10-05', 'weeks follow UTC, not the local clock');
  assert.equal(utcWeekStart('2026-10-01'), WEEK, 'a picked day maps to its Monday');
  assert.equal(utcWeekStart('2026-02-30'), null, 'an impossible date names no week');
  assert.equal(utcWeekStart(''), null);
  assert.equal(parseIsoDate('2026-9-28'), null, 'only YYYY-MM-DD is accepted');
  assert.equal(addUtcDays('2026-12-28', 7), '2027-01-04', 'weeks cross year ends');
  assert.equal(addUtcDays('2024-02-26', 7), '2024-03-04', 'leap years are calendar-correct');
  assert.equal(formatUtcDay(WEEK), 'Mon 28 Sep 2026', 'labels name the weekday, day, month and year');
});

test('only a complete version-3 report for the requested week is accepted', () => {
  const good = countReport(fixtureStore(), WEEK, fixtureHistory());
  assert.equal(isValidWeeklyReport(good, WEEK), true);
  assert.equal(weeklyReportProblem(good, WEEK), null);
  assert.equal(good.created.total, 4, 'fixture sanity: four issues created in the week');
  assert.deepEqual(good.completed, { total: 3, byPriority: { low: 1, normal: 0, high: 1, urgent: 1 }, priorityUnknown: 0, createdThisWeek: 2, createdEarlier: 1, repeatCompletions: 2 },
    'fixture sanity: three distinct completed issues, two extra completions');
  assert.equal(good.completedTimingUnknown, 1, 'fixture sanity: one legacy done issue');
  const c = good.created;
  const d = good.completed;
  const { completed: _drop, ...noCompleted } = good;
  const { completedTimingUnknown: _drop2, ...noUnknown } = good;
  const variants = {
    'another week': { ...good, weekStart: PREV_WEEK, weekEndExclusive: WEEK },
    'schema version 4': { ...good, schemaVersion: 4 },
    'schema version as text': { ...good, schemaVersion: '3' },
    'non-Monday week': { ...good, weekStart: '2026-09-29', weekEndExclusive: '2026-10-06' },
    'wrong end': { ...good, weekEndExclusive: '2026-10-04' },
    'missing status key': { ...good, created: { ...c, byStatus: { open: 2, in_progress: 1 } } },
    'missing priority key': { ...good, created: { ...c, byPriority: { low: 1, normal: 1, high: 1 } } },
    'negative count': { ...good, created: { ...c, total: -1 } },
    'fractional count': { ...good, created: { ...c, byStatus: { ...c.byStatus, done: 0.5 } } },
    'created counts not adding up': { ...good, created: { ...c, total: 5 } },
    'text count': { ...good, created: { ...c, total: '4' } },
    'no completed part (version-1 body labelled 2)': noCompleted,
    'completed as an array': { ...good, completed: [] },
    'no unknown-timing count': noUnknown,
    'unknown-timing as null': { ...good, completedTimingUnknown: null },
    'unknown-timing negative': { ...good, completedTimingUnknown: -1 },
    'completed priority key missing': { ...good, completed: { ...d, byPriority: { low: 1, high: 1, urgent: 1 } } },
    'completed priorities not adding up': { ...good, completed: { ...d, total: 4 } },
    'priority-unknown missing': { ...good, completed: (({ priorityUnknown: _p, ...rest }) => rest)(d) },
    'priority-unknown as null': { ...good, completed: { ...d, priorityUnknown: null } },
    'priority-unknown as text': { ...good, completed: { ...d, priorityUnknown: '0' } },
    'priority-unknown negative': { ...good, completed: { ...d, priorityUnknown: -1 } },
    'priority-unknown fractional': { ...good, completed: { ...d, priorityUnknown: 0.5 } },
    'priority-unknown not adding up': { ...good, completed: { ...d, priorityUnknown: 1 } },
    'priority-unknown inside byPriority instead': { ...good, completed: { ...d, byPriority: { ...d.byPriority, unknown: 0 }, priorityUnknown: undefined } },
    'unknown counted on top of a full byPriority': { ...good, completed: { ...d, total: 3, byPriority: { low: 1, normal: 0, high: 1, urgent: 1 }, priorityUnknown: 1, createdThisWeek: 2, createdEarlier: 1 } },
    'origin not adding up': { ...good, completed: { ...d, createdEarlier: 2 } },
    'origin missing': { ...good, completed: { ...d, createdThisWeek: undefined } },
    'repeat missing': { ...good, completed: { ...d, repeatCompletions: undefined } },
    'repeat fractional': { ...good, completed: { ...d, repeatCompletions: 1.5 } },
    'more completed-this-week than created': { ...good, created: { total: 1, byStatus: { open: 1, in_progress: 0, done: 0 }, byPriority: { low: 0, normal: 0, high: 0, urgent: 1 } } },
    'repeats without any completed issue': { ...emptyReport(WEEK), completed: { ...emptyReport(WEEK).completed, repeatCompletions: 1 } },
  };
  for (const [name, report] of Object.entries(variants)) {
    assert.equal(isValidWeeklyReport(report, WEEK), false, name);
    assert.equal(weeklyReportProblem(report, WEEK).code, 'INVALID_RESPONSE', name);
  }
  assert.equal(isValidWeeklyReport(null, WEEK), false);
  assert.equal(isValidWeeklyReport([], WEEK), false);
  assert.equal(isValidWeeklyReport(emptyReport(WEEK), WEEK), true, 'a real all-zero week is valid');
});

test('a version-1 report is refused with its own message, never shown as version 3', () => {
  const v1 = { schemaVersion: 1, weekStart: WEEK, weekEndExclusive: '2026-10-05',
    created: { total: 4, byStatus: { open: 2, in_progress: 1, done: 1 }, byPriority: { low: 1, normal: 1, high: 1, urgent: 1 } } };
  assert.equal(isValidWeeklyReport(v1, WEEK), false);
  const problem = weeklyReportProblem(v1, WEEK);
  assert.equal(problem.code, 'UNSUPPORTED_REPORT_VERSION');
  assert.match(problem.message, /older weekly report \(version 1\) without completion data/);
  // Even with version-3 parts bolted on, a version-1 label is not version 3.
  assert.equal(weeklyReportProblem({ ...countReport(fixtureStore(), WEEK, fixtureHistory()), schemaVersion: 1 }, WEEK).code, 'UNSUPPORTED_REPORT_VERSION');
});

// ---------------------------------------------------------------------------
// Live HTTP adapter (fetch stubbed)
// ---------------------------------------------------------------------------

test('the adapter reads GET /api/reports/weekly?weekStart= and keeps the error envelope', async () => {
  const calls = [];
  const good = countReport(fixtureStore(), WEEK, fixtureHistory());
  const api = createHttpAdapter({ fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, good); } });
  assert.deepEqual(await api.weeklyReport(WEEK), good);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/reports/weekly?weekStart=2026-09-28');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined, 'a report read sends no body');

  const invalid = createHttpAdapter({ fetchImpl: async () => jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'weekStart must be a Monday.' } }) });
  await assert.rejects(invalid.weeklyReport('2026-09-29'),
    (e) => e instanceof ApiError && e.code === 'VALIDATION_ERROR' && e.status === 400 && e.message === 'weekStart must be a Monday.');

  const otherWeek = createHttpAdapter({ fetchImpl: async () => jsonResponse(200, { ...good, weekStart: PREV_WEEK, weekEndExclusive: WEEK }) });
  await assert.rejects(otherWeek.weeklyReport(WEEK), (e) => e.code === 'INVALID_RESPONSE', 'a report for another week is unreadable');

  const html = createHttpAdapter({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('html'); } }) });
  await assert.rejects(html.weeklyReport(WEEK), (e) => e.code === 'HTTP_404', 'a server without the endpoint is a clear read failure');

  const offline = createHttpAdapter({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.weeklyReport(WEEK), (e) => e.code === 'NETWORK_ERROR');

  const { completed: _c, completedTimingUnknown: _u, ...createdOnly } = good;
  const v1 = createHttpAdapter({ fetchImpl: async () => jsonResponse(200, { ...createdOnly, schemaVersion: 1 }) });
  await assert.rejects(v1.weeklyReport(WEEK), (e) => e instanceof ApiError && e.code === 'UNSUPPORTED_REPORT_VERSION' && e.status === 200,
    'a version-1 reply is refused explicitly');
  const v2 = createHttpAdapter({ fetchImpl: async () => jsonResponse(200, version2Of(good)) });
  await assert.rejects(v2.weeklyReport(WEEK), (e) => e instanceof ApiError && e.code === 'UNSUPPORTED_REPORT_VERSION' && e.status === 200,
    'a version-2 reply (current-priority basis) is refused explicitly');
  const halfV3 = createHttpAdapter({ fetchImpl: async () => jsonResponse(200, { ...createdOnly, schemaVersion: 3 }) });
  await assert.rejects(halfV3.weeklyReport(WEEK), (e) => e.code === 'INVALID_RESPONSE', 'a version-3 label without completion data is unreadable');
});

// ---------------------------------------------------------------------------
// Mounted summary
// ---------------------------------------------------------------------------

test('the summary is a labelled section showing the current UTC week, its total and both distributions', async () => {
  const { root, reports } = await mountSummary();
  const section = byRole(root, 'weekly');
  assert.ok(section, 'the board has a Weekly summary section');
  assert.equal(section.getAttribute('aria-labelledby'), 'weekly-heading');
  assert.equal(byId(root, 'weekly-heading').textContent, 'Weekly summary');
  const week = byRole(root, 'weekly-week');
  const label = elementsOf(root).find((el) => el.tagName === 'LABEL' && el.getAttribute('for') === 'weekly-week');
  assert.match(label.textContent, /Week \(UTC\)/, 'the week picker has a visible label naming UTC');
  assert.equal(week.getAttribute('type'), 'date');
  assert.equal(week.value, WEEK, 'the picker defaults to the current UTC Monday');
  assert.deepEqual(reports.calls, [WEEK], 'one report read for the current week on load');
  assert.match(byRole(root, 'weekly-range').textContent, /^Week of Mon 28 Sep 2026 to Sun 4 Oct 2026 \(UTC\)$/);
  assert.deepEqual(shownCounts(root), {
    total: '4',
    byStatus: { open: '2', in_progress: '1', done: '1' },
    byPriority: { low: '1', normal: '1', high: '1', urgent: '1' },
  });
  assert.equal(byRole(root, 'weekly-result').hidden, false);
  assert.equal(byRole(root, 'weekly-error').hidden, true);
  assert.equal(section.getAttribute('aria-busy'), 'false');
});

test('created and completed are separate, labelled parts with their own totals (never one merged number)', async () => {
  const { root } = await mountSummary();
  const created = byRole(root, 'weekly-created');
  const completed = byRole(root, 'weekly-completed');
  assert.ok(created && completed && created !== completed, 'two parts');
  assert.equal(created.tagName, 'SECTION');
  assert.equal(completed.tagName, 'SECTION');
  assert.equal(byId(root, created.getAttribute('aria-labelledby')).textContent, 'Created this week');
  assert.equal(byId(root, completed.getAttribute('aria-labelledby')).textContent, 'Completed this week');
  assert.match(created.textContent, /Counted by when each issue was created\./);
  assert.match(completed.textContent, /Counted by recorded completion time\./);
  assert.equal(text(root, 'weekly-total'), '4');
  assert.equal(text(root, 'weekly-total-label'), 'issues created in this week');
  assert.equal(text(root, 'weekly-completed-total'), '3', 'distinct issues with a completion in the week');
  assert.equal(text(root, 'weekly-completed-total-label'), 'issues completed in this week');
  assert.ok(elementsOf(created).includes(byRole(root, 'weekly-total')), 'the created total sits in the created part');
  assert.ok(elementsOf(completed).includes(byRole(root, 'weekly-completed-total')), 'the completed total sits in the completed part');
  assert.ok(!elementsOf(created).includes(byRole(root, 'weekly-completed-total')));
  assert.ok(!elementsOf(root).some((el) => el.textContent === '7'), 'no element shows created + completed as one number');
});

test('repeat completions are shown apart; a reopened issue keeps its completion; origin and priority at completion are labelled', async () => {
  const { root } = await mountSummary();
  assert.deepEqual(shownCompleted(root), {
    total: '3', repeat: '2', createdThisWeek: '2', createdEarlier: '1',
    byPriority: { low: '1', normal: '0', high: '1', urgent: '1' }, priorityUnknown: '0',
  });
  assert.match(text(root, 'weekly-repeat-label'), /^extra completions of the same issues \(completed again after being reopened; not added to the count above\)$/);
  // wk-0001 was completed this week and is open again now: it still counts.
  assert.equal(countOf(root, 'completed-priority', 'urgent'), '1', 'the reopened urgent issue is still completed this week');
  assert.equal(countOf(root, 'status', 'open'), '2', 'while the created part shows it at its current status');
  const priorityHeading = byId(root, 'weekly-completed-priority-heading');
  assert.equal(priorityHeading.textContent, 'By priority at completion');
  assert.equal(text(root, 'weekly-completed-priority-hint'),
    'Each issue counts under the priority it had when it was first completed in this week. Changing its priority later does not move it.');
  assert.match(byRole(root, 'weekly-by-completed-priority').getAttribute('aria-describedby'), /weekly-completed-priority-hint/);
  assert.equal(byRole(root, 'weekly-priority-unknown-note').hidden, true, 'no unknown-priority note when every completion has a recorded priority');
  assert.equal(countOf(root, 'completed-priority', 'unknown'), '0', 'a real zero unknown bucket is shown as 0');
  assert.ok(!/current priority/i.test(byRole(root, 'weekly-completed').textContent), 'the completed part never claims a current-priority basis');
  assert.equal(byId(root, 'weekly-priority-heading').textContent, 'By current priority', 'the created part keeps its current-priority basis');
  assert.equal(byId(root, 'weekly-origin-heading').textContent, 'When these issues were created');
  assert.equal(byRole(root, 'weekly-completed-origin').getAttribute('aria-labelledby'), 'weekly-origin-heading');
  assert.equal(byRole(root, 'weekly-by-completed-priority').getAttribute('aria-labelledby'), 'weekly-completed-priority-heading');
  assert.match(byRole(root, 'weekly-completed').textContent, /An issue completed more than once in the week counts once; reopening later does not remove it\./);
});

test('one extra completion reads in the singular; none reads 0 explicitly', async () => {
  const { root, app, reports } = await mountSummary();
  const base = countReport(fixtureStore(), WEEK, fixtureHistory());
  reports.next.push(async () => ({ ...base, completed: { ...base.completed, repeatCompletions: 1 } }));
  await app.weekly.reload();
  assert.equal(text(root, 'weekly-repeat'), '1');
  assert.match(text(root, 'weekly-repeat-label'), /^extra completion of the same issues/);
  reports.next.push(async () => ({ ...base, completed: { ...base.completed, repeatCompletions: 0 } }));
  await app.weekly.reload();
  assert.equal(text(root, 'weekly-repeat'), '0', 'a real zero from the server is shown as 0');
});

test('done issues without a recorded completion time are named as unknown and not placed in the week', async () => {
  const { root } = await mountSummary();
  const note = byRole(root, 'weekly-unknown');
  assert.equal(note.hidden, false);
  assert.equal(byId(root, 'weekly-unknown-heading').textContent, 'Completion time unknown');
  assert.equal(text(root, 'weekly-unknown-text'), '1 done issue has no recorded completion time, so it is not counted in this or any other week.');
  assert.ok(!elementsOf(byRole(root, 'weekly-completed')).includes(note), 'the unknown note is not part of the completed count');
  assert.equal(text(root, 'weekly-completed-total'), '3', 'the legacy issue is not counted as completed this week');

  // Several unknowns: plural. None: no note at all.
  const many = await mountSummary({ issues: [...fixtureIssues(), { id: 'wk-0010', title: 'Legacy 2', description: '', status: 'done', priority: 'low', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }] });
  assert.equal(text(many.root, 'weekly-unknown-text'), '2 done issues have no recorded completion time, so they are not counted in this or any other week.');
  const none = await mountSummary({ issues: fixtureIssues().filter((i) => i.id !== 'wk-0009') });
  assert.equal(byRole(none.root, 'weekly-unknown').hidden, true, 'no note when every done issue has a completion time');
});

test('the unknown-timing note is the same in every week (it is not tied to the selected week)', async () => {
  const { root } = await mountSummary();
  for (const target of ['weekly-prev', 'weekly-prev', 'weekly-next', 'weekly-next', 'weekly-next']) {
    await byRole(root, target).dispatch('click');
    await tick();
    assert.equal(byRole(root, 'weekly-unknown').hidden, false);
    assert.match(text(root, 'weekly-unknown-text'), /^1 done issue has no recorded completion time/);
  }
});

test('completions on the week boundaries: the last millisecond is inside, the next Monday and the Sunday before are not', async () => {
  const { root } = await mountSummary();
  // wk-0007 (completed 2026-10-04T23:59:59.999Z, created earlier) is this week's only earlier-created completion.
  assert.equal(text(root, 'weekly-completed-created-earlier'), '1');
  assert.equal(countOf(root, 'completed-priority', 'high'), '1');
  assert.equal(countOf(root, 'completed-priority', 'normal'), '0', 'wk-0008 completed just outside the week on both sides');
  await byRole(root, 'weekly-prev').dispatch('click');
  await tick();
  assert.deepEqual(shownCompleted(root), { total: '1', repeat: '0', createdThisWeek: '0', createdEarlier: '1', byPriority: { low: '0', normal: '1', high: '0', urgent: '0' }, priorityUnknown: '0' },
    'the Sunday-23:59 completion belongs to the week before');
  await byRole(root, 'weekly-next').dispatch('click');
  await byRole(root, 'weekly-next').dispatch('click');
  await tick();
  assert.equal(text(root, 'weekly-completed-total'), '1', 'the Monday-00:00 completion starts the next week');
  assert.equal(countOf(root, 'completed-priority', 'normal'), '1');
});

test('a board mounted without a report source shows no summary and reads no report', async () => {
  const { root, reports } = await mountSummary({ withReports: false });
  assert.equal(byRole(root, 'weekly'), undefined);
  assert.equal(reports.calls.length, 0);
});

test('a board can add the summary later through its handle (as the page does)', async () => {
  const { root, app, reports } = await mountSummary({ withReports: false });
  await app.showWeeklySummary(reports);
  assert.ok(byRole(root, 'weekly')?.isConnected, 'the summary is on the page');
  assert.deepEqual(reports.calls, [WEEK]);
  assert.equal(await app.showWeeklySummary(reports), false, 'adding it twice does nothing');
  assert.equal(allByRole(root, 'weekly').length, 1);
});

test('the summary ignores the board search and filters: no report reads, same counts', async () => {
  const { root, reports, adapter } = await mountSummary();
  const before = shownCounts(root);
  const search = byRole(root, 'search');
  search.value = 'needle';
  await search.dispatch('input');
  await tick(5);
  const status = byRole(root, 'status-filter');
  status.value = 'open';
  await status.dispatch('change');
  const priority = byRole(root, 'priority-filter');
  priority.value = 'urgent';
  await priority.dispatch('change');
  await tick(5);
  assert.deepEqual(adapter.calls.list.at(-1), { status: 'open', priority: 'urgent', q: 'needle' }, 'the board itself is filtered');
  assert.deepEqual(reports.calls, [WEEK], 'filters never trigger a report read');
  assert.deepEqual(shownCounts(root), before, 'the counts do not follow the board filters');
});

test('choosing a week reads that week; any day maps to its Monday; previous/next/this week move by whole weeks', async () => {
  const { root, reports, doc } = await mountSummary();
  const week = byRole(root, 'weekly-week');
  week.value = '2026-09-24'; // a Thursday
  await week.dispatch('change');
  await tick();
  assert.equal(reports.calls.at(-1), PREV_WEEK);
  assert.equal(week.value, PREV_WEEK, 'the picker shows the Monday of the chosen week');
  assert.match(byRole(root, 'weekly-range').textContent, /^Week of Mon 21 Sep 2026 to Sun 27 Sep 2026 \(UTC\)$/);
  assert.equal(byRole(root, 'weekly-total').textContent, '1', 'the Sunday-23:59 issue belongs to the week before');
  assert.equal(byRole(root, 'weekly-total-label').textContent, 'issue created in this week');
  assert.equal(countOf(root, 'status', 'open'), '1');

  await byRole(root, 'weekly-prev').dispatch('click');
  await tick();
  assert.equal(reports.calls.at(-1), '2026-09-14');
  assert.equal(byRole(root, 'weekly-result').hidden, false, 'an empty week still shows both parts');
  assert.equal(byRole(root, 'weekly-created-empty').hidden, false);
  assert.equal(text(root, 'weekly-created-empty'), 'No issues were created in this week.', 'an empty week says so');
  assert.equal(byRole(root, 'weekly-created-details').hidden, true, 'no zero-filled distribution is shown for an empty week');
  assert.equal(byRole(root, 'weekly-completed-empty').hidden, false);
  assert.equal(text(root, 'weekly-completed-empty'), 'No issues have a recorded completion in this week.');
  assert.equal(byRole(root, 'weekly-completed-details').hidden, true);
  assert.equal(text(root, 'weekly-total'), '0');
  assert.equal(text(root, 'weekly-completed-total'), '0');
  assert.equal(byRole(root, 'weekly-status').hidden, true, 'no loading or error line');
  assert.equal(byRole(root, 'announcer').textContent,
    'Week of Mon 14 Sep 2026 to Sun 20 Sep 2026 (UTC). No issues were created. No issues have a recorded completion. 1 done issue has no recorded completion time, so it is not counted in this or any other week.');

  await byRole(root, 'weekly-next').dispatch('click');
  await byRole(root, 'weekly-next').dispatch('click');
  await tick();
  assert.equal(reports.calls.at(-1), WEEK);
  await byRole(root, 'weekly-next').dispatch('click');
  await tick();
  assert.equal(reports.calls.at(-1), '2026-10-05');
  await byRole(root, 'weekly-prev').dispatch('click');
  await byRole(root, 'weekly-prev').dispatch('click');
  await tick();
  assert.equal(reports.calls.at(-1), PREV_WEEK);
  await byRole(root, 'weekly-this').dispatch('click');
  await tick();
  assert.equal(reports.calls.at(-1), WEEK, 'This week returns to the current UTC week');
  assert.equal(byRole(root, 'announcer').textContent,
    'Week of Mon 28 Sep 2026 to Sun 4 Oct 2026 (UTC). 4 issues created. Status: Open 2, In progress 1, Done 1. Priority: Low 1, Normal 1, High 1, Urgent 1. '
    + '3 issues completed, plus 2 extra completions of the same issues. Created this week 2, earlier 1. Priority at completion: Low 1, Normal 0, High 1, Urgent 1, priority not recorded 0. '
    + '1 done issue has no recorded completion time, so it is not counted in this or any other week.');

  const count = reports.calls.length;
  week.value = '2026-10-02'; // another day of the week already shown
  await week.dispatch('change');
  assert.equal(reports.calls.length, count, 'a day of the shown week reads nothing again');
  assert.equal(week.value, WEEK);

  week.value = '';
  doc.activeElement = week;
  await week.dispatch('change');
  assert.equal(reports.calls.length, count, 'an incomplete date reads nothing');
  assert.equal(week.getAttribute('aria-invalid'), 'true');
  assert.equal(byRole(root, 'weekly-week-error').hidden, false);
  assert.match(byRole(root, 'weekly-week-error').textContent, /Enter a full date/);
});

test('board changes refresh the selected week without touching drafts or filters', async () => {
  const { root, reports, adapter, app } = await mountSummary();
  // A filtered board and a half-typed draft.
  const priorityFilter = byRole(root, 'priority-filter');
  priorityFilter.value = 'urgent';
  await priorityFilter.dispatch('change');
  const draft = byRole(root, 'create-form');
  const title = elementsOf(draft).find((el) => el.getAttribute('id') === 'new-title');
  title.value = 'Half-typed draft';
  const reads = reports.calls.length;

  // Direct priority change on the visible card: urgent -> low.
  const control = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-priority-control' && el.getAttribute('data-issue-id') === 'wk-0001');
  control.value = 'low';
  await control.dispatch('change');
  await app.weekly.idle();
  assert.equal(reports.calls.length, reads + 1, 'a saved priority change reads the report again');
  assert.equal(reports.calls.at(-1), WEEK, 'for the week still selected');
  assert.deepEqual(shownCounts(root).byPriority, { low: '2', normal: '1', high: '1', urgent: '0' }, 'counts use the current priority');
  assert.equal(title.value, 'Half-typed draft', 'the create draft is kept');
  assert.equal(priorityFilter.value, 'urgent', 'the filter is unchanged');
  assert.equal(adapter.calls.list.at(-1).priority, 'urgent', 'the board reload keeps its filter');

  // Status move on a card (clear the filter first so cards are shown).
  priorityFilter.value = '';
  await priorityFilter.dispatch('change');
  const move = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-status' && el.getAttribute('data-issue-id') === 'wk-0003');
  move.value = 'done';
  await move.dispatch('change');
  await app.weekly.idle();
  assert.deepEqual(shownCounts(root).byStatus, { open: '1', in_progress: '1', done: '2' }, 'counts use the current status');
  assert.equal(text(root, 'weekly-completed-total'), '4', 'the new completion is read back from the server');
  assert.equal(text(root, 'weekly-completed-created-this-week'), '3');
  assert.equal(text(root, 'weekly-repeat'), '2');

  // Edit dialog save.
  const edit = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-edit' && el.getAttribute('data-issue-id') === 'wk-0002');
  await edit.dispatch('click');
  byRole(root, 'edit-priority').value = 'urgent';
  await byRole(root, 'edit-form').dispatch('submit');
  await app.weekly.idle();
  assert.equal(countOf(root, 'priority', 'urgent'), '1');
  assert.equal(countOf(root, 'priority', 'high'), '0');

  // Create: a new issue inside the week raises the total.
  title.value = 'Fresh issue';
  await draft.dispatch('submit');
  await app.weekly.idle();
  assert.equal(byRole(root, 'weekly-total').textContent, '5', 'a created issue appears in its week');
  assert.equal(adapter.calls.create.length, 1);

  // Refresh button.
  const before = reports.calls.length;
  await byRole(root, 'refresh').dispatch('click');
  await app.weekly.idle();
  assert.equal(reports.calls.length, before + 1, 'Refresh also refreshes the summary');
  assert.ok(reports.calls.every((week) => week === WEEK), 'every refresh reads the selected week');
});

test('loading shows a busy state; a reply for an older week never replaces a newer selection', async () => {
  const { root, reports } = await mountSummary();
  const slow = deferred();
  reports.next.push(async () => { await slow.promise; return countReport(new Map(), PREV_WEEK); });
  await byRole(root, 'weekly-prev').dispatch('click');
  const section = byRole(root, 'weekly');
  assert.equal(section.getAttribute('aria-busy'), 'true');
  assert.equal(byRole(root, 'weekly-status').textContent, 'Loading the summary…');
  assert.equal(byRole(root, 'weekly-result').hidden, true, 'counts of the old week are not shown under the new week');

  // The user moves on before the slow reply arrives.
  await byRole(root, 'weekly-next').dispatch('click');
  await tick();
  assert.equal(byRole(root, 'weekly-week').value, WEEK);
  assert.equal(byRole(root, 'weekly-total').textContent, '4');

  slow.resolve();
  await tick(5);
  assert.equal(byRole(root, 'weekly-week').value, WEEK, 'the stale reply does not move the picker');
  assert.equal(byRole(root, 'weekly-total').textContent, '4', 'the stale reply does not replace the counts');
  assert.equal(text(root, 'weekly-completed-total'), '3', 'nor the completed counts');
  assert.equal(section.getAttribute('aria-busy'), 'false');
});

test('a failed read is recoverable: clear message, Retry, board untouched, focus kept on the page', async () => {
  const { root, reports, doc, app } = await mountSummary({ issues: fixtureIssues() });
  const cardsBefore = allByRole(root, 'card').length;
  reports.next.push(async () => { throw new ApiError('HTTP_404', 'The server answered with an unexpected error (404).', 404, { outcomeUnknown: true }); });
  await byRole(root, 'weekly-prev').dispatch('click');
  await tick();
  const error = byRole(root, 'weekly-error');
  assert.equal(error.hidden, false);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.match(byRole(root, 'weekly-error-text').textContent, /^Could not load the weekly summary: The server answered with an unexpected error \(404\)\.$/);
  assert.equal(byRole(root, 'weekly-status').textContent, 'The summary for this week is not available right now.');
  assert.equal(byRole(root, 'weekly-result').hidden, true);
  assert.equal(byRole(root, 'load-error').hidden, true, 'the board’s own load error is not raised');
  assert.equal(allByRole(root, 'card').length, cardsBefore, 'the board keeps its cards');

  const retry = byRole(root, 'weekly-retry');
  retry.focus();
  await retry.dispatch('click');
  await app.weekly.idle();
  assert.equal(error.hidden, true, 'a successful retry clears the error');
  assert.equal(doc.activeElement, byRole(root, 'weekly-heading'), 'focus moves from the hidden Retry to the summary heading');
  assert.equal(byRole(root, 'weekly-heading').getAttribute('tabindex'), '-1');
  assert.equal(byRole(root, 'weekly-total').textContent, '1', 'the retried week is shown');
  assert.match(byRole(root, 'announcer').textContent, /^Week of Mon 21 Sep 2026 to Sun 27 Sep 2026 \(UTC\)\. 1 issue created\./);
});

test('a failed refresh keeps the last counts for the same week and says so', async () => {
  const { root, reports, app } = await mountSummary();
  reports.next.push(async () => { throw new ApiError('NETWORK_ERROR', 'The connection to the server failed.', 0, { outcomeUnknown: true }); });
  await byRole(root, 'refresh').dispatch('click');
  await app.weekly.idle();
  assert.equal(byRole(root, 'weekly-error').hidden, false);
  assert.match(byRole(root, 'weekly-error-text').textContent, /The connection to the server failed\. Showing the last summary that loaded for this week\./);
  assert.equal(byRole(root, 'weekly-result').hidden, false, 'the last counts for this same week stay visible');
  assert.equal(byRole(root, 'weekly-total').textContent, '4');
  assert.equal(text(root, 'weekly-completed-total'), '3');
});

test('a malformed report is a read failure, not wrong numbers', async () => {
  const { root, reports, app } = await mountSummary();
  reports.next.push(async (week) => ({ ...emptyReport(week), created: { total: 3, byStatus: { open: 3 }, byPriority: {} } }));
  await app.weekly.reload();
  assert.equal(byRole(root, 'weekly-error').hidden, false);
  assert.match(byRole(root, 'weekly-error-text').textContent, /could not read/);
  assert.equal(byRole(root, 'weekly-total').textContent, '4', 'the earlier valid counts are not replaced by a malformed reply');
  assert.equal(text(root, 'weekly-completed-total'), '3');
});

test('a version-1 reply from any report source is an explicit error, with no made-up completion zeros', async () => {
  const { root, reports, app } = await mountSummary();
  const v1 = (week) => ({ schemaVersion: 1, weekStart: week, weekEndExclusive: addUtcDays(week, 7),
    created: { total: 1, byStatus: { open: 1, in_progress: 0, done: 0 }, byPriority: { low: 0, normal: 1, high: 0, urgent: 0 } } });
  // Same week (a refresh): the error is shown and the last version-3 counts stay, labelled as such.
  reports.next.push(async (week) => v1(week));
  await app.weekly.reload();
  assert.equal(byRole(root, 'weekly-error').hidden, false);
  assert.match(text(root, 'weekly-error-text'), /^Could not load the weekly summary: The server sent an older weekly report \(version 1\) without completion data, so completed counts cannot be shown\. Showing the last summary that loaded for this week\.$/);
  assert.equal(text(root, 'weekly-total'), '4', 'the version-1 created count did not replace anything');
  // Another week: nothing from the version-1 reply is shown at all.
  reports.next.push(async (week) => v1(week));
  await byRole(root, 'weekly-prev').dispatch('click');
  await app.weekly.idle();
  assert.equal(byRole(root, 'weekly-result').hidden, true, 'no counts, and no completed zeros, for a version-1 week');
  assert.equal(text(root, 'weekly-status'), 'The summary for this week is not available right now.');
  assert.equal(byRole(root, 'weekly-retry').hidden, false);
  // Retry once the server answers version 3.
  await byRole(root, 'weekly-retry').dispatch('click');
  await app.weekly.idle();
  assert.equal(byRole(root, 'weekly-error').hidden, true);
  assert.equal(text(root, 'weekly-completed-total'), '1');
});

test('reopening keeps the past completion; completing again adds one extra completion, not a new issue', async () => {
  const { root, app, history } = await mountSummary();
  const move = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-status' && el.getAttribute('data-issue-id') === 'wk-0004');
  move.value = 'open';
  await move.dispatch('change');
  await app.weekly.idle();
  assert.equal(countOf(root, 'status', 'done'), '0', 'the created part shows the reopened issue as open now');
  assert.deepEqual(shownCompleted(root), { total: '3', repeat: '2', createdThisWeek: '2', createdEarlier: '1', byPriority: { low: '1', normal: '0', high: '1', urgent: '1' }, priorityUnknown: '0' },
    'reopening does not remove the completion from the week');
  const again = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-status' && el.getAttribute('data-issue-id') === 'wk-0004');
  again.value = 'done';
  await again.dispatch('change');
  await app.weekly.idle();
  assert.equal(history.get('wk-0004').length, 4, 'the stub server recorded one more event');
  assert.equal(text(root, 'weekly-completed-total'), '3', 'the same issue still counts once');
  assert.equal(text(root, 'weekly-repeat'), '3', 'the extra completion is shown apart');
});

test('distribution bars are decorative and sized from the counts; counts are plain text', async () => {
  const { root } = await mountSummary();
  const status = byRole(root, 'weekly-status-open');
  assert.equal(status.textContent, '2');
  const tracks = elementsOf(byRole(root, 'weekly')).filter((el) => el.className === 'weekly-track');
  assert.equal(tracks.length, STATUSES.length + PRIORITIES.length + PRIORITIES.length + 1, 'the completed part has a fifth bar for priority not recorded');
  assert.ok(tracks.every((el) => el.getAttribute('aria-hidden') === 'true'));
  const openBar = tracks[0].children[0];
  assert.equal(openBar.style.width, '50%');
  const completedBars = elementsOf(byRole(root, 'weekly-by-completed-priority')).filter((el) => el.className.startsWith('weekly-bar '));
  assert.deepEqual(completedBars.map((el) => el.style.width), ['33%', '0%', '33%', '33%', '0%'], 'completed bars are sized from the completed total');
  assert.equal(completedBars.at(-1).className, 'weekly-bar weekly-bar-completed-priority-unknown');
  const lists = ['weekly-by-status', 'weekly-by-priority', 'weekly-by-completed-priority', 'weekly-completed-origin'].map((role) => elementsOf(byRole(root, 'weekly')).find((el) => el.tagName === 'UL' && el.getAttribute('data-role') === role));
  assert.ok(lists.every((ul) => ul && ul.getAttribute('aria-labelledby')), 'each distribution list is labelled by its heading');
});

test('after an unconfirmed change the summary is read again with the board check, and nothing is re-sent', async () => {
  const { root, reports, adapter, app, store } = await mountSummary();
  const inner = adapter.update;
  adapter.update = async (id, patch) => {
    await inner(id, patch); // the server applied it, but the reply was lost
    throw new ApiError('NETWORK_ERROR', 'The connection to the server failed.', 0, { outcomeUnknown: true });
  };
  const reads = reports.calls.length;
  const control = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-priority-control' && el.getAttribute('data-issue-id') === 'wk-0004');
  control.value = 'urgent';
  await control.dispatch('change');
  await tick(5);
  await app.weekly.idle();
  assert.equal(adapter.calls.update.length, 1, 'the change is never re-sent automatically');
  assert.equal(store.get('wk-0004').priority, 'urgent');
  assert.equal(reports.calls.length, reads + 1, 'the summary follows the server check');
  assert.equal(countOf(root, 'priority', 'urgent'), '2', 'and shows what the server now holds');
  assert.equal(countOf(root, 'priority', 'low'), '0');
});

// ---------------------------------------------------------------------------
// Four-digit years: low years are real years, and only whole weeks whose
// dates can be written as YYYY-MM-DD (weekStart and weekEndExclusive) are shown
// ---------------------------------------------------------------------------

// Public UTC Mondays in low years (Date.UTC would move 0-99 to 1900-1999).
const LOW_MONDAYS = ['0099-01-05', '0100-01-04', '0999-01-07'];
const at = (iso) => new Date(iso);

test('low four-digit years parse as themselves, zero-padded, and stay real calendar dates', () => {
  for (const monday of LOW_MONDAYS) {
    const date = parseIsoDate(monday);
    assert.ok(date, `${monday} parses`);
    assert.equal(date.getUTCFullYear(), Number(monday.slice(0, 4)), `${monday} keeps its year`);
    assert.equal(date.getUTCDay(), 1, `${monday} is a Monday`);
    assert.equal(date.toISOString().slice(0, 10), monday, `${monday} is that UTC day`);
  }
  assert.equal(parseIsoDate('0000-01-01').getUTCFullYear(), 0, 'year 0000 is accepted');
  assert.equal(parseIsoDate('0000-01-01').getUTCDay(), 6, '0000-01-01 is a Saturday (proleptic Gregorian)');
  assert.equal(parseIsoDate('9999-12-31').getUTCDay(), 5, '9999-12-31 is a Friday');
  assert.ok(parseIsoDate('0004-02-29'), '0004 is a leap year');
  assert.equal(parseIsoDate('0100-02-29'), null, '0100 is not a leap year');
  assert.ok(parseIsoDate('0000-02-29'), '0000 is a leap year');
  assert.equal(parseIsoDate('99-01-05'), null, 'two-digit years are not dates here');
  assert.equal(parseIsoDate('+010000-01-01'), null, 'expanded years are not accepted');
  assert.equal(parseIsoDate('10000-01-03'), null, 'five-digit years are not accepted');
  assert.equal(parseIsoDate('1999-01-05') && parseIsoDate('0099-01-05').getTime() === parseIsoDate('1999-01-05').getTime(), false,
    '0099 and 1999 are different years');
  assert.equal(formatUtcDay('0099-01-05'), 'Mon 5 Jan 0099', 'labels keep four year digits');
  assert.equal(formatUtcDay('0000-01-03'), 'Mon 3 Jan 0000');
  assert.equal(addUtcDays('0099-12-28', 7), '0100-01-04', 'weeks cross low year ends');
  assert.equal(addUtcDays('0000-01-03', -7), null, 'no date before year 0000');
  assert.equal(addUtcDays('9999-12-27', 7), null, 'no date after year 9999');
});

test('week normalization keeps low years and names no week outside four-digit years', () => {
  assert.equal(utcWeekStart('0099-01-07'), '0099-01-05');
  assert.equal(utcWeekStart('0099-01-11'), '0099-01-05', 'Sunday maps to its Monday');
  assert.equal(utcWeekStart('0100-01-01'), '0099-12-28', 'a week crossing into 0100');
  assert.equal(utcWeekStart('0100-01-04'), '0100-01-04');
  assert.equal(utcWeekStart('0999-01-10'), '0999-01-07');
  assert.equal(utcWeekStart(at('0099-01-11T23:59:59.999Z')), '0099-01-05', 'a Date in a low year');
  assert.equal(utcWeekStart(at('0099-01-12T00:00:00.000Z')), '0099-01-12');
  assert.equal(utcWeekStart(at('0099-01-05T00:00:00.000Z').getTime()), '0099-01-05', 'a time value');
  for (const monday of LOW_MONDAYS) {
    assert.equal(utcWeekStart(monday), monday, `${monday} is its own week`);
    assert.equal(isSupportedWeek(monday), true, `${monday} is a supported week`);
  }
  // Edges near 0000.
  assert.equal(utcWeekStart('0000-01-01'), null, 'Saturday 0000-01-01 belongs to a week starting in year -1');
  assert.equal(utcWeekStart('0000-01-02'), null);
  assert.equal(utcWeekStart('0000-01-03'), FIRST_WEEK_START);
  assert.equal(FIRST_WEEK_START, '0000-01-03');
  assert.equal(isSupportedWeek('0000-01-03'), true);
  // Edges near 9999.
  assert.equal(LAST_WEEK_START, '9999-12-20');
  assert.equal(utcWeekStart('9999-12-26'), LAST_WEEK_START, 'Sunday 9999-12-26 is in the last whole week');
  assert.equal(isSupportedWeek('9999-12-20'), true, 'its end 9999-12-27 is still four-digit');
  assert.equal(utcWeekStart('9999-12-31'), '9999-12-27', 'the last days name their Monday');
  assert.equal(isSupportedWeek('9999-12-27'), false, 'but that week ends in 10000 and is not supported');
  assert.equal(isSupportedWeek('0000-01-04'), false, 'not a Monday');
  assert.equal(isSupportedWeek('1999-01-05'), false, '1999-01-05 is a Tuesday');
  assert.equal(isSupportedWeek(null), false);
});

test('a report for a low-year week is accepted when it echoes that week; unsupported weeks never are', async () => {
  const empty = emptyReport;
  assert.equal(isValidWeeklyReport(empty('0099-01-05', '0099-01-12'), '0099-01-05'), true);
  assert.equal(isValidWeeklyReport(empty('0100-01-04', '0100-01-11'), '0100-01-04'), true);
  assert.equal(isValidWeeklyReport(empty('0999-01-07', '0999-01-14'), '0999-01-07'), true);
  assert.equal(isValidWeeklyReport(empty('0099-12-28', '0100-01-04'), '0099-12-28'), true, 'end in the next year');
  assert.equal(isValidWeeklyReport(empty('0000-01-03', '0000-01-10'), '0000-01-03'), true, 'first supported week');
  assert.equal(isValidWeeklyReport(empty('9999-12-20', '9999-12-27'), '9999-12-20'), true, 'last supported week');
  assert.equal(isValidWeeklyReport(empty('1999-01-04', '1999-01-11'), '0099-01-05'), false, 'a 1900s echo for a low year is another week');
  assert.equal(isValidWeeklyReport(empty('99-01-05', '99-01-12'), '0099-01-05'), false, 'unpadded years are not accepted');
  assert.equal(isValidWeeklyReport(empty('0099-01-05', '99-01-12'), '0099-01-05'), false, 'unpadded end');
  assert.equal(isValidWeeklyReport(empty('0099-01-05', '1999-01-12'), '0099-01-05'), false, 'end in the wrong century');
  assert.equal(isValidWeeklyReport(empty('9999-12-27', '10000-01-03'), '9999-12-27'), false, 'a week ending after 9999');
  assert.equal(isValidWeeklyReport(empty('9999-12-27', '+010000-01-03'), '9999-12-27'), false);

  const calls = [];
  const api = createHttpAdapter({ fetchImpl: async (url) => { calls.push(url); return jsonResponse(200, empty('0099-01-05', '0099-01-12')); } });
  assert.deepEqual(await api.weeklyReport('0099-01-05'), empty('0099-01-05', '0099-01-12'), 'the adapter accepts the low-year report');
  assert.equal(calls[0], '/api/reports/weekly?weekStart=0099-01-05', 'and asks for the zero-padded week');
  const wrongCentury = createHttpAdapter({ fetchImpl: async () => jsonResponse(200, empty('1999-01-04', '1999-01-11')) });
  await assert.rejects(wrongCentury.weeklyReport('0099-01-05'), (e) => e.code === 'INVALID_RESPONSE');
});

test('picking low-year days reads those weeks and shows four-digit labels', async () => {
  const { root, reports } = await mountSummary();
  const week = byRole(root, 'weekly-week');
  for (const [day, monday, label] of [
    ['0099-01-07', '0099-01-05', 'Week of Mon 5 Jan 0099 to Sun 11 Jan 0099 (UTC)'],
    ['0100-01-10', '0100-01-04', 'Week of Mon 4 Jan 0100 to Sun 10 Jan 0100 (UTC)'],
    ['0999-01-07', '0999-01-07', 'Week of Mon 7 Jan 0999 to Sun 13 Jan 0999 (UTC)'],
  ]) {
    week.value = day;
    await week.dispatch('change');
    assert.equal(byRole(root, 'weekly-week-error').hidden, true, `${day} is accepted`);
    assert.equal(reports.calls.at(-1), monday, `${day} reads its Monday`);
    assert.equal(week.value, monday);
    assert.equal(byRole(root, 'weekly-range').textContent, label);
    assert.equal(byRole(root, 'weekly-error').hidden, true, 'the low-year report is shown, not rejected');
    assert.equal(byRole(root, 'weekly-created-empty').hidden, false, 'an empty low-year week says so');
  }
  // Previous/Next cross the 0099/0100 year end by whole weeks.
  week.value = '0099-12-30';
  await week.dispatch('change');
  await byRole(root, 'weekly-next').dispatch('click');
  assert.equal(reports.calls.at(-1), '0100-01-04');
  await byRole(root, 'weekly-prev').dispatch('click');
  assert.equal(reports.calls.at(-1), '0099-12-28');
});

test('days whose week cannot be written with four-digit years get a clear message and read nothing', async () => {
  const { root, reports } = await mountSummary();
  const week = byRole(root, 'weekly-week');
  for (const day of ['0000-01-01', '0000-01-02', '9999-12-27', '9999-12-31']) {
    const before = reports.calls.length;
    week.value = day;
    await week.dispatch('change');
    const error = byRole(root, 'weekly-week-error');
    assert.equal(error.hidden, false, `${day} is refused`);
    assert.match(error.textContent, new RegExp(`The week of ${day} can't be shown\\.`));
    assert.match(error.textContent, /weeks from Mon 3 Jan 0000 to Sun 26 Dec 9999 \(UTC\)/, 'it names the supported range');
    assert.match(error.textContent, /four-digit years/, 'and why');
    assert.equal(week.getAttribute('aria-invalid'), 'true');
    assert.equal(reports.calls.length, before, 'no report is read');
    assert.equal(byRole(root, 'weekly-range').textContent, 'Week of Mon 28 Sep 2026 to Sun 4 Oct 2026 (UTC)', 'the shown week stays');
  }
  for (const day of ['0000-01-03', '9999-12-26']) {
    week.value = day;
    await week.dispatch('change');
    assert.equal(byRole(root, 'weekly-week-error').hidden, true, `${day} is in a supported week`);
  }
  assert.equal(reports.calls.at(-1), LAST_WEEK_START);
});

test('at the first and last supported weeks the boundary buttons are disabled and never leave the range', async () => {
  const { root, doc, reports } = await mountSummary();
  const week = byRole(root, 'weekly-week');
  const prev = byRole(root, 'weekly-prev');
  const next = byRole(root, 'weekly-next');
  const edge = byRole(root, 'weekly-edge');
  assert.equal(prev.disabled, false);
  assert.equal(next.disabled, false);
  assert.equal(edge.hidden, true, 'no edge note in ordinary weeks');

  // One week after the first: Previous reaches it, then disables itself.
  week.value = '0000-01-10';
  await week.dispatch('change');
  assert.equal(prev.disabled, false);
  prev.focus();
  await prev.dispatch('click');
  assert.equal(reports.calls.at(-1), FIRST_WEEK_START);
  assert.equal(prev.disabled, true, 'no previous week before 0000-01-03');
  assert.equal(next.disabled, false);
  assert.equal(doc.activeElement, week, 'focus moves to the picker, not lost on a disabled button');
  assert.equal(edge.hidden, false);
  assert.match(edge.textContent, /earliest week the summary can show/);
  const reads = reports.calls.length;
  await prev.dispatch('click');
  assert.equal(reports.calls.length, reads, 'a click that slips through still reads nothing');
  assert.equal(byRole(root, 'weekly-range').textContent, 'Week of Mon 3 Jan 0000 to Sun 9 Jan 0000 (UTC)');

  // One week before the last: Next reaches it, then disables itself.
  week.value = '9999-12-13';
  await week.dispatch('change');
  assert.equal(next.disabled, false);
  next.focus();
  await next.dispatch('click');
  assert.equal(reports.calls.at(-1), LAST_WEEK_START);
  assert.equal(next.disabled, true, 'no next week whose end is after 9999');
  assert.equal(prev.disabled, false);
  assert.equal(doc.activeElement, week);
  assert.match(edge.textContent, /latest week the summary can show/);
  await next.dispatch('click');
  assert.equal(reports.calls.at(-1), LAST_WEEK_START, 'still the last supported week');
  assert.equal(byRole(root, 'weekly-range').textContent, 'Week of Mon 20 Dec 9999 to Sun 26 Dec 9999 (UTC)');
  assert.equal(byRole(root, 'weekly-this').disabled, false, 'This week stays available for a supported clock');
  await byRole(root, 'weekly-this').dispatch('click');
  assert.equal(reports.calls.at(-1), WEEK);
  assert.equal(next.disabled, false);
  assert.equal(edge.hidden, true);
});

test('This week is disabled when the clock is in a week that cannot be shown, and the summary says why', async () => {
  // A clock in the last days of 9999: their week ends in year 10000.
  const late = await mountSummary({ now: at('9999-12-29T12:00:00.000Z') });
  assert.equal(late.reports.calls.length, 0, 'no report is read for an unsupported week');
  assert.equal(byRole(late.root, 'weekly-this').disabled, true);
  assert.equal(byRole(late.root, 'weekly-next').disabled, true);
  assert.equal(byRole(late.root, 'weekly-prev').disabled, false, 'Previous still reaches the last supported week');
  assert.equal(byRole(late.root, 'weekly-error').hidden, false);
  assert.match(byRole(late.root, 'weekly-error-text').textContent, /outside the dates it can show.*four-digit years/);
  await byRole(late.root, 'weekly-prev').dispatch('click');
  assert.deepEqual(late.reports.calls, [LAST_WEEK_START]);
  assert.equal(byRole(late.root, 'weekly-error').hidden, true, 'a supported week reads normally');
  assert.equal(byRole(late.root, 'weekly-this').disabled, true, 'This week still cannot move into 9999-12-27');
  await byRole(late.root, 'weekly-this').dispatch('click');
  assert.deepEqual(late.reports.calls, [LAST_WEEK_START]);

  // A clock in a low year is an ordinary week.
  const low = await mountSummary({ now: at('0099-01-07T08:00:00.000Z') });
  assert.deepEqual(low.reports.calls, ['0099-01-05']);
  assert.equal(byRole(low.root, 'weekly-week').value, '0099-01-05');
  assert.equal(byRole(low.root, 'weekly-this').disabled, false);
  assert.equal(byRole(low.root, 'weekly-error').hidden, true);
});

// ---------------------------------------------------------------------------
// Version 3: priority at completion and its unknown bucket
// ---------------------------------------------------------------------------

const V2_MESSAGE = 'The server sent an older weekly report (version 2) that groups completed issues by their current priority, not their priority at completion, so completed counts cannot be shown.';

test('a version-2 report is refused with its own message, even when its numbers would add up', () => {
  const good = countReport(fixtureStore(), WEEK, fixtureHistory());
  const v2 = version2Of(good);
  assert.equal(isValidWeeklyReport(v2, WEEK), false);
  const problem = weeklyReportProblem(v2, WEEK);
  assert.equal(problem.code, 'UNSUPPORTED_REPORT_VERSION');
  assert.equal(problem.message, V2_MESSAGE);
  assert.equal(problem.outcomeUnknown, true);
  // A version-2 label on a version-3 body is still version 2.
  assert.equal(weeklyReportProblem({ ...good, schemaVersion: 2 }, WEEK).code, 'UNSUPPORTED_REPORT_VERSION');
  assert.notEqual(weeklyReportProblem({ ...good, schemaVersion: 1 }, WEEK).message, V2_MESSAGE, 'version 1 keeps its own message');
});

test('a version-2 reply is shown as an explicit, recoverable error with no counts or zeros made up', async () => {
  const { root, reports, app } = await mountSummary();
  reports.next.push(async (week) => version2Of(countReport(new Map(), week)));
  await app.weekly.reload();
  assert.equal(byRole(root, 'weekly-error').hidden, false);
  assert.equal(text(root, 'weekly-error-text'), `Could not load the weekly summary: ${V2_MESSAGE} Showing the last summary that loaded for this week.`);
  assert.equal(text(root, 'weekly-completed-total'), '3', 'the last version-3 counts stay; nothing from the version-2 reply is shown');
  reports.next.push(async (week) => version2Of(countReport(new Map(), week)));
  await byRole(root, 'weekly-prev').dispatch('click');
  await app.weekly.idle();
  assert.equal(byRole(root, 'weekly-result').hidden, true, 'a version-2 week shows no counts at all');
  assert.equal(text(root, 'weekly-status'), 'The summary for this week is not available right now.');
  await byRole(root, 'weekly-retry').dispatch('click');
  await app.weekly.idle();
  assert.equal(byRole(root, 'weekly-error').hidden, true, 'Retry recovers once the server answers version 3');
  assert.equal(byRole(root, 'weekly-result').hidden, false);
});

test('a missing or malformed priorityUnknown, or totals that do not add up, are read failures in the page', async () => {
  const { root, reports, app } = await mountSummary();
  const base = countReport(fixtureStore(), WEEK, fixtureHistory());
  const { priorityUnknown: _p, ...noUnknown } = base.completed;
  for (const completed of [noUnknown, { ...base.completed, priorityUnknown: null }, { ...base.completed, priorityUnknown: 2 }]) {
    reports.next.push(async () => ({ ...base, completed }));
    await app.weekly.reload();
    assert.equal(byRole(root, 'weekly-error').hidden, false);
    assert.match(text(root, 'weekly-error-text'), /could not read/);
    assert.equal(countOf(root, 'completed-priority', 'unknown'), '0', 'the last valid unknown count stays');
    assert.equal(text(root, 'weekly-completed-total'), '3');
  }
});

test('a mixed week shows recorded priorities and a separate, explained unknown bucket', async () => {
  // wk-0004's first completion this week is an old bare-timestamp event; its
  // later completions carry a priority but do not decide the bucket.
  const completions = { ...fixtureCompletions(), 'wk-0004': ['2026-10-01T09:00:00.000Z', done('2026-10-02T10:00:00.000Z', 'low'), done('2026-10-03T11:00:00.000Z', 'low')] };
  const { root } = await mountSummary({ completions });
  assert.deepEqual(shownCompleted(root), {
    total: '3', repeat: '2', createdThisWeek: '2', createdEarlier: '1',
    byPriority: { low: '0', normal: '0', high: '1', urgent: '1' }, priorityUnknown: '1',
  }, 'unknown is never guessed from the current priority (low)');
  const unknownRow = byRole(root, 'weekly-completed-priority-unknown').parentNode;
  assert.equal(unknownRow.tagName, 'LI', 'the unknown count is a row of the same labelled list');
  assert.equal(unknownRow.children[0].textContent, 'Priority not recorded');
  const note = byRole(root, 'weekly-priority-unknown-note');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, '1 of these issues was completed before the board recorded priority at completion, so its priority then is not known. It is counted as “Priority not recorded” and not guessed from the current priority.');
  assert.match(byRole(root, 'weekly-by-completed-priority').getAttribute('aria-describedby'), /weekly-priority-unknown-note/);
  assert.ok(elementsOf(byRole(root, 'weekly-completed')).includes(note), 'the explanation sits with the completed distribution');
  // The completion-time-unknown note stays its own, separate explanation.
  const timing = byRole(root, 'weekly-unknown');
  assert.equal(timing.hidden, false);
  assert.ok(!elementsOf(timing).includes(note) && !elementsOf(byRole(root, 'weekly-completed')).includes(timing));
  assert.equal(text(root, 'weekly-unknown-text'), '1 done issue has no recorded completion time, so it is not counted in this or any other week.');
  const bars = elementsOf(byRole(root, 'weekly-by-completed-priority')).filter((el) => el.className.startsWith('weekly-bar '));
  assert.deepEqual(bars.map((el) => el.style.width), ['0%', '0%', '33%', '33%', '33%']);
  await byRole(root, 'weekly-this').dispatch('click');
  await tick();
  assert.match(byRole(root, 'announcer').textContent, /Priority at completion: Low 0, Normal 0, High 1, Urgent 1, priority not recorded 1\./,
    'the screen-reader summary names the unknown bucket too');
});

test('an all-unknown week puts every completion in the unknown bucket and says so', async () => {
  const completions = {
    'wk-0001': ['2026-09-29T10:00:00.000Z'],
    'wk-0004': ['2026-10-01T09:00:00.000Z', '2026-10-02T10:00:00.000Z'],
    'wk-0007': ['2026-10-04T23:59:59.999Z'],
  };
  const { root } = await mountSummary({ completions });
  assert.deepEqual(shownCompleted(root), {
    total: '3', repeat: '1', createdThisWeek: '2', createdEarlier: '1',
    byPriority: { low: '0', normal: '0', high: '0', urgent: '0' }, priorityUnknown: '3',
  });
  assert.equal(text(root, 'weekly-priority-unknown-note'), 'All 3 issues were completed before the board recorded priority at completion, so their priority then is not known. They are counted as “Priority not recorded” and not guessed from the current priority.');
  const bars = elementsOf(byRole(root, 'weekly-by-completed-priority')).filter((el) => el.className.startsWith('weekly-bar '));
  assert.deepEqual(bars.map((el) => el.style.width), ['0%', '0%', '0%', '0%', '100%']);
  assert.deepEqual(shownCounts(root).byPriority, { low: '1', normal: '1', high: '1', urgent: '1' }, 'created priorities still use the current priority');
});

test('a single unknown completion reads in the singular', async () => {
  const { root } = await mountSummary({ completions: { 'wk-0007': ['2026-10-04T23:59:59.999Z'] } });
  assert.equal(text(root, 'weekly-completed-total'), '1');
  assert.equal(text(root, 'weekly-priority-unknown-note'), 'This issue was completed before the board recorded priority at completion, so its priority then is not known. It is counted as “Priority not recorded” and not guessed from the current priority.');
});

test('an empty version-3 week shows explicit zeros only where the server sent them, and no unknown note', async () => {
  const { root, reports } = await mountSummary();
  reports.next.push(async (week) => emptyReport(week));
  await byRole(root, 'weekly-this').dispatch('click');
  await tick();
  assert.equal(byRole(root, 'weekly-error').hidden, true);
  assert.equal(text(root, 'weekly-completed-total'), '0');
  assert.equal(byRole(root, 'weekly-completed-empty').hidden, false);
  assert.equal(byRole(root, 'weekly-completed-details').hidden, true);
  assert.equal(byRole(root, 'weekly-priority-unknown-note').hidden, true);
  assert.equal(byRole(root, 'weekly-unknown').hidden, true);
  assert.match(byRole(root, 'announcer').textContent, /No issues have a recorded completion\./);
});

test('editing an issue after it was completed never moves it between past completion buckets', async () => {
  const { root, app, history } = await mountSummary();
  // wk-0001 was completed this week as urgent and is open again: change it to low.
  const control = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-priority-control' && el.getAttribute('data-issue-id') === 'wk-0001');
  control.value = 'low';
  await control.dispatch('change');
  await app.weekly.idle();
  assert.equal(countOf(root, 'priority', 'low'), '2', 'the created part follows the new current priority');
  assert.equal(countOf(root, 'priority', 'urgent'), '0');
  assert.deepEqual(shownCompleted(root).byPriority, { low: '1', normal: '0', high: '1', urgent: '1' }, 'the completed part keeps urgent, the priority at completion');
  // Edit a still-done issue's priority (wk-0007, completed as high) in the dialog.
  const edit = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-edit' && el.getAttribute('data-issue-id') === 'wk-0007');
  await edit.dispatch('click');
  byRole(root, 'edit-priority').value = 'normal';
  await byRole(root, 'edit-form').dispatch('submit');
  await app.weekly.idle();
  assert.deepEqual(shownCompleted(root).byPriority, { low: '1', normal: '0', high: '1', urgent: '1' }, 'a priority edit after completion leaves the bucket alone');
  // Reopen wk-0004 (completed as low), raise it to urgent, complete it again:
  // the first completion this week still decides its bucket.
  const status = () => elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-status' && el.getAttribute('data-issue-id') === 'wk-0004');
  const reopen = status(); reopen.value = 'open'; await reopen.dispatch('change'); await app.weekly.idle();
  const priority = elementsOf(root).find((el) => el.getAttribute('data-role') === 'card-priority-control' && el.getAttribute('data-issue-id') === 'wk-0004');
  priority.value = 'urgent'; await priority.dispatch('change'); await app.weekly.idle();
  const again = status(); again.value = 'done'; await again.dispatch('change'); await app.weekly.idle();
  assert.deepEqual(history.get('wk-0004').at(-1), { at: SERVER_NOW, priority: 'urgent' }, 'the new completion records its own priority');
  assert.deepEqual(shownCompleted(root), {
    total: '3', repeat: '3', createdThisWeek: '2', createdEarlier: '1',
    byPriority: { low: '1', normal: '0', high: '1', urgent: '1' }, priorityUnknown: '0',
  }, 'a re-completion at a new priority is an extra completion, not a new bucket');
});

test('two completions at the same instant: the earlier-appended one decides the bucket', async () => {
  const completions = { 'wk-0007': [done('2026-10-01T09:00:00.000Z', 'urgent'), done('2026-10-01T09:00:00.000Z', 'low')] };
  const { root } = await mountSummary({ completions });
  assert.deepEqual(shownCompleted(root).byPriority, { low: '0', normal: '0', high: '0', urgent: '1' });
  assert.equal(text(root, 'weekly-repeat'), '1');
});
