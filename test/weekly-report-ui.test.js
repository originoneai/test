// Frontend coverage for the Weekly summary: UTC week helpers, the version-1
// report shape check, the live HTTP adapter's report read, and the mounted
// summary (default current UTC week, week selection, independence from the
// board's search and filters, refresh after board changes, loading, empty,
// failure and stale-reply handling). The report endpoint is stubbed here: the
// summary is checked against the agreed version-1 contract
// (GET /api/reports/weekly?weekStart=YYYY-MM-DD), not against a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, FIRST_WEEK_START, LAST_WEEK_START, addUtcDays, createHttpAdapter, formatUtcDay,
  isSupportedWeek, isValidWeeklyReport, mountApp, parseIsoDate, utcWeekStart,
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
// Fixtures: an issue store shared by the board adapter and a report stub that
// counts like the version-1 contract (createdAt inside the UTC week, current
// status and priority, every key present).
// ---------------------------------------------------------------------------

const WEEK = '2026-09-28'; // a Monday
const PREV_WEEK = '2026-09-21';

function fixtureIssues() {
  const at = (iso) => ({ createdAt: iso, updatedAt: iso });
  return [
    { id: 'wk-0001', title: 'Printer jam', description: '', status: 'open', priority: 'urgent', ...at('2026-09-28T00:00:00.000Z') },
    { id: 'wk-0002', title: '<b>Markup</b> title', description: 'needle', status: 'in_progress', priority: 'high', ...at('2026-09-30T12:00:00.000Z') },
    { id: 'wk-0003', title: 'Login needle', description: '', status: 'open', priority: 'normal', ...at('2026-10-04T23:59:59.999Z') },
    { id: 'wk-0004', title: 'Done thing', description: '', status: 'done', priority: 'low', ...at('2026-10-01T08:00:00.000Z') },
    // Outside the week: the Sunday before and the Monday after.
    { id: 'wk-0005', title: 'Before', description: '', status: 'open', priority: 'normal', ...at('2026-09-27T23:59:59.999Z') },
    { id: 'wk-0006', title: 'After', description: '', status: 'open', priority: 'normal', ...at('2026-10-05T00:00:00.000Z') },
  ];
}

function boardAdapter(store) {
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
      const next = { ...store.get(id), ...patch, updatedAt: '2026-10-02T00:00:00.000Z' };
      store.set(id, next);
      return { ...next };
    },
  };
}

function countReport(store, weekStart) {
  const start = Date.parse(weekStart + 'T00:00:00.000Z');
  const end = start + 7 * 24 * 60 * 60 * 1000;
  const byStatus = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  const byPriority = Object.fromEntries(PRIORITIES.map((k) => [k, 0]));
  let total = 0;
  for (const issue of store.values()) {
    const t = Date.parse(issue.createdAt);
    if (t >= start && t < end) { total += 1; byStatus[issue.status] += 1; byPriority[issue.priority] += 1; }
  }
  return { schemaVersion: 1, weekStart, weekEndExclusive: addUtcDays(weekStart, 7), created: { total, byStatus, byPriority } };
}

// A report source over the store; `next` (if set) answers the next read.
function reportStub(store) {
  const stub = {
    calls: [],
    next: [],
    async weeklyReport(weekStart) {
      stub.calls.push(weekStart);
      const custom = stub.next.shift();
      if (custom) return custom(weekStart);
      return countReport(store, weekStart);
    },
  };
  return stub;
}

async function mountSummary({ now = new Date('2026-09-30T15:00:00.000Z'), issues = fixtureIssues(), withReports = true } = {}) {
  const store = new Map(issues.map((issue) => [issue.id, { ...issue }]));
  const adapter = boardAdapter(store);
  const reports = reportStub(store);
  const doc = new FakeDocument();
  const root = new FakeElement(doc, 'div');
  doc.root = root;
  const app = mountApp(root, { adapter, doc, searchDelayMs: 0, reports: withReports ? reports : null, now: () => now });
  await app.ready;
  await app.weekly.idle();
  return { doc, root, app, adapter, reports, store };
}

const countOf = (root, key, value) => byRole(root, `weekly-${key}-${value}`).textContent;
function shownCounts(root) {
  return {
    total: byRole(root, 'weekly-total').textContent,
    byStatus: Object.fromEntries(STATUSES.map((k) => [k, countOf(root, 'status', k)])),
    byPriority: Object.fromEntries(PRIORITIES.map((k) => [k, countOf(root, 'priority', k)])),
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

test('only a complete version-1 report for the requested week is accepted', () => {
  const good = countReport(new Map(fixtureIssues().map((i) => [i.id, i])), WEEK);
  assert.equal(isValidWeeklyReport(good, WEEK), true);
  assert.equal(good.created.total, 4, 'fixture sanity: four issues created in the week');
  const variants = {
    'another week': { ...good, weekStart: PREV_WEEK, weekEndExclusive: WEEK },
    'schema version 2': { ...good, schemaVersion: 2 },
    'non-Monday week': { ...good, weekStart: '2026-09-29', weekEndExclusive: '2026-10-06' },
    'wrong end': { ...good, weekEndExclusive: '2026-10-04' },
    'missing status key': { ...good, created: { ...good.created, byStatus: { open: 2, in_progress: 1 } } },
    'missing priority key': { ...good, created: { ...good.created, byPriority: { low: 1, normal: 1, high: 1 } } },
    'negative count': { ...good, created: { ...good.created, total: -1 } },
    'fractional count': { ...good, created: { ...good.created, byStatus: { ...good.created.byStatus, done: 0.5 } } },
    'counts not adding up': { ...good, created: { ...good.created, total: 5 } },
    'text count': { ...good, created: { ...good.created, total: '4' } },
  };
  for (const [name, report] of Object.entries(variants)) {
    assert.equal(isValidWeeklyReport(report, WEEK), false, name);
  }
  assert.equal(isValidWeeklyReport(null, WEEK), false);
});

// ---------------------------------------------------------------------------
// Live HTTP adapter (fetch stubbed)
// ---------------------------------------------------------------------------

test('the adapter reads GET /api/reports/weekly?weekStart= and keeps the error envelope', async () => {
  const calls = [];
  const good = countReport(new Map(fixtureIssues().map((i) => [i.id, i])), WEEK);
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
  assert.equal(byRole(root, 'weekly-status').textContent, 'No issues were created in this week.', 'an empty week says so');
  assert.equal(byRole(root, 'weekly-result').hidden, true, 'no zero-filled distribution is shown for an empty week');
  assert.match(byRole(root, 'announcer').textContent, /^No issues were created in the week of Mon 14 Sep 2026 to Sun 20 Sep 2026 \(UTC\)\.$/);

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
  assert.match(byRole(root, 'announcer').textContent, /^4 issues created in the week of .*Status: Open 2, In progress 1, Done 1\. Priority: Low 1, Normal 1, High 1, Urgent 1\.$/);

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
  assert.match(byRole(root, 'announcer').textContent, /^1 issue created in the week of Mon 21 Sep 2026/);
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
});

test('a malformed report is a read failure, not wrong numbers', async () => {
  const { root, reports, app } = await mountSummary();
  reports.next.push(async (week) => ({ schemaVersion: 1, weekStart: week, weekEndExclusive: addUtcDays(week, 7), created: { total: 3, byStatus: { open: 3 }, byPriority: {} } }));
  await app.weekly.reload();
  assert.equal(byRole(root, 'weekly-error').hidden, false);
  assert.match(byRole(root, 'weekly-error-text').textContent, /could not read/);
  assert.equal(byRole(root, 'weekly-total').textContent, '4', 'the earlier valid counts are not replaced by a malformed reply');
});

test('distribution bars are decorative and sized from the counts; counts are plain text', async () => {
  const { root } = await mountSummary();
  const status = byRole(root, 'weekly-status-open');
  assert.equal(status.textContent, '2');
  const tracks = elementsOf(byRole(root, 'weekly')).filter((el) => el.className === 'weekly-track');
  assert.equal(tracks.length, STATUSES.length + PRIORITIES.length);
  assert.ok(tracks.every((el) => el.getAttribute('aria-hidden') === 'true'));
  const openBar = tracks[0].children[0];
  assert.equal(openBar.style.width, '50%');
  const lists = ['weekly-by-status', 'weekly-by-priority'].map((role) => elementsOf(byRole(root, 'weekly')).find((el) => el.tagName === 'UL' && el.getAttribute('data-role') === role));
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
  const empty = (weekStart, weekEndExclusive) => ({ schemaVersion: 1, weekStart, weekEndExclusive,
    created: { total: 0, byStatus: { open: 0, in_progress: 0, done: 0 }, byPriority: { low: 0, normal: 0, high: 0, urgent: 0 } } });
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
    assert.match(byRole(root, 'weekly-status').textContent, /No issues were created in this week/);
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
