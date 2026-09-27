// NATIVE-UI: board, forms, search/filter, error recovery and real-API checks.
// Most tests run in plain Node (no browser, no dependencies) against a minimal
// fake DOM and a TEST-ONLY in-memory adapter defined below. The page itself has
// no demo data: it always talks to the live API. The "real server" tests at the
// end drive the same board against src/server.js with a temporary DATA_DIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATUSES, STATUS_LABELS, TITLE_MAX, DESCRIPTION_MAX, ApiError,
  validateIssueInput, groupByStatus,
  createHttpAdapter, mountApp, isValidIssue,
  matchesSubmitted, confirmSaved, expectedCreate, UNCONFIRMED_MESSAGE,
} from '../public/app.js';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';

// ---------------------------------------------------------------------------
// TEST-ONLY in-memory adapter and sample issues. Never loaded by the page.
// Same list/create/update interface and filtering rules as docs/api.md.
// ---------------------------------------------------------------------------
function filterIssues(issues, { status = '', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return [...issues]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .filter(issue => {
      if (status && issue.status !== status) return false;
      if (!needle) return true;
      return String(issue.title).toLowerCase().includes(needle)
        || String(issue.description || '').toLowerCase().includes(needle);
    });
}
function sampleIssues(scenario = 'default') {
  if (scenario === 'empty') return [];
  const base = [
    { id: 'sample-0001', title: 'Board columns collapse on narrow screens', description: 'Check the 390 px layout on a phone.', status: 'open', createdAt: '2026-09-20T09:00:00.000Z', updatedAt: '2026-09-20T09:00:00.000Z' },
    { id: 'sample-0002', title: 'Search should match descriptions', description: 'Case-insensitive match on title or description.', status: 'in_progress', createdAt: '2026-09-21T10:30:00.000Z', updatedAt: '2026-09-22T08:15:00.000Z' },
    { id: 'sample-0003', title: 'Keep failed form input for retry', description: '', status: 'done', createdAt: '2026-09-19T14:45:00.000Z', updatedAt: '2026-09-23T16:20:00.000Z' },
    { id: 'sample-0004', title: 'Add keyboard access to the edit dialog', description: 'Escape closes it and focus returns to the card.', status: 'open', createdAt: '2026-09-22T12:00:00.000Z', updatedAt: '2026-09-22T12:00:00.000Z' },
  ];
  if (scenario === 'html') {
    base.unshift({ id: 'sample-html', title: '<img src=x onerror="alert(1)"> rendered as text', description: '<script>alert("still text")</script>', status: 'open', createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z' });
  }
  return base;
}
function createMemoryAdapter({ issues = sampleIssues(), failures = {}, now = () => new Date(), makeId = () => 'mem-' + Math.random().toString(16).slice(2) } = {}) {
  const store = new Map(issues.map(issue => [issue.id, { ...issue }]));
  const pendingFailures = { list: 0, create: 0, update: 0, ...failures };
  const copy = issue => ({ ...issue });
  const maybeFail = op => {
    if (pendingFailures[op] > 0) {
      pendingFailures[op] -= 1;
      throw new ApiError('STORAGE_ERROR', 'The test adapter simulated a failed request.', 500);
    }
  };
  return {
    mode: 'memory',
    store,
    async list({ status = '', q = '' } = {}) {
      await null;
      maybeFail('list');
      if (status && !STATUSES.includes(status)) throw new ApiError('VALIDATION_ERROR', 'Invalid status filter.', 400);
      return filterIssues([...store.values()], { status, q }).map(copy);
    },
    async create(input) {
      await null;
      maybeFail('create');
      const extra = Object.keys(input || {}).filter(k => k !== 'title' && k !== 'description');
      if (extra.length) throw new ApiError('VALIDATION_ERROR', `Unknown field: ${extra[0]}.`, 400);
      const { errors, value } = validateIssueInput(input);
      const first = Object.values(errors)[0];
      if (first) throw new ApiError('VALIDATION_ERROR', first, 400);
      const stamp = now().toISOString();
      const issue = { id: makeId(), title: value.title, description: value.description ?? '', status: 'open', createdAt: stamp, updatedAt: stamp };
      store.set(issue.id, issue);
      return copy(issue);
    },
    async update(id, patch) {
      await null;
      maybeFail('update');
      const current = store.get(id);
      if (!current) throw new ApiError('NOT_FOUND', 'Issue not found.', 404);
      const { errors, value } = validateIssueInput(patch, { partial: true });
      const first = Object.values(errors)[0];
      if (first) throw new ApiError('VALIDATION_ERROR', first, 400);
      const next = { ...current, ...value, updatedAt: now().toISOString() };
      store.set(id, next);
      return copy(next);
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal fake DOM: enough for mountApp, with text kept as data (no HTML parsing).
// ---------------------------------------------------------------------------
class FakeText {
  constructor(text) { this.nodeType = 3; this.data = String(text); this.parentNode = null; }
  get textContent() { return this.data; }
}
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeType = 1;
    this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = new Map();
    this.value = ''; this.disabled = false; this.hidden = false; this.className = '';
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n;
      node.parentNode = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners.get(type) || []) fn(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children = []; if (v !== '' && v != null) this.append(this.ownerDocument.createTextNode(String(v))); }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: c => list().includes(c),
      toggle(c, force) {
        const has = list().includes(c);
        const want = force === undefined ? !has : Boolean(force);
        el.className = want ? [...new Set([...list(), c])].join(' ') : list().filter(x => x !== c).join(' ');
        return want;
      },
    };
  }
}
function fakeDocument() {
  const doc = { activeElement: null };
  doc.createElement = tag => new FakeElement(doc, tag);
  doc.createTextNode = text => new FakeText(text);
  return doc;
}
function* walk(node) { yield node; for (const c of node.children || []) yield* walk(c); }
const byRole = (root, role) => [...walk(root)].find(n => n.getAttribute?.('data-role') === role);
const allByRole = (root, role) => [...walk(root)].filter(n => n.getAttribute?.('data-role') === role);
const flush = async (times = 3) => { for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 0)); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function recordingAdapter(inner) {
  const calls = [];
  return {
    calls,
    mode: inner.mode,
    list: (...a) => { calls.push(['list', ...a]); return inner.list(...a); },
    create: (...a) => { calls.push(['create', ...a]); return inner.create(...a); },
    update: (...a) => { calls.push(['update', ...a]); return inner.update(...a); },
  };
}
async function mount(adapter, opts = {}) {
  const doc = fakeDocument();
  const root = doc.createElement('main');
  const app = mountApp(root, { adapter, doc, searchDelayMs: 0, ...opts });
  await app.ready;
  await flush();
  return { doc, root, app };
}
const cardTitles = (root, status) => allByRole(byRole(root, `list-${status}`), 'card-title').map(n => n.textContent);
const fixedClock = () => { let t = Date.parse('2026-09-25T00:00:00.000Z'); return () => new Date(t += 1000); };
const seqIds = () => { let n = 0; return () => `id-${++n}`; };

// ---------------------------------------------------------------------------
// Validation and filtering
// ---------------------------------------------------------------------------
test('validation follows the contract limits', () => {
  assert.deepEqual(validateIssueInput({ title: '  Fix  ' }).value, { title: 'Fix' });
  assert.ok(validateIssueInput({ title: '   ' }).errors.title);
  assert.ok(!validateIssueInput({ title: 'x'.repeat(TITLE_MAX) }).errors.title);
  assert.ok(validateIssueInput({ title: 'x'.repeat(TITLE_MAX + 1) }).errors.title);
  assert.ok(!validateIssueInput({ title: 'a', description: 'd'.repeat(DESCRIPTION_MAX) }).errors.description);
  assert.ok(validateIssueInput({ title: 'a', description: 'd'.repeat(DESCRIPTION_MAX + 1) }).errors.description);
  assert.ok(validateIssueInput({ title: 'a', status: 'blocked' }, { partial: true }).errors.status);
  assert.ok(validateIssueInput({ title: 'a', priority: 1 }).errors.priority);
  assert.ok(validateIssueInput({}, { partial: true }).errors.form);
  assert.deepEqual(validateIssueInput({ status: 'done' }, { partial: true }), { errors: {}, value: { status: 'done' } });
});

test('filtering is newest first, status-scoped and case-insensitive on title or description', () => {
  const items = [
    { id: 'a', title: 'Alpha', description: 'first', status: 'open', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', title: 'beta', description: 'Needs SEARCH', status: 'done', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'c', title: 'Search box', description: '', status: 'open', createdAt: '2026-01-02T00:00:00Z' },
  ];
  assert.deepEqual(filterIssues(items).map(i => i.id), ['b', 'c', 'a']);
  assert.deepEqual(filterIssues(items, { q: 'search' }).map(i => i.id), ['b', 'c']);
  assert.deepEqual(filterIssues(items, { q: 'search', status: 'open' }).map(i => i.id), ['c']);
  assert.deepEqual(Object.keys(groupByStatus(items)), STATUSES);
});

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------
test('test-only memory adapter mirrors the API contract and returns copies', async () => {
  const adapter = createMemoryAdapter({ issues: [], now: fixedClock(), makeId: seqIds() });
  const created = await adapter.create({ title: '  New  ' });
  assert.equal(created.id, 'id-1');
  assert.equal(created.title, 'New');
  assert.equal(created.description, '');
  assert.equal(created.status, 'open');
  assert.equal(created.createdAt, created.updatedAt);
  created.title = 'mutated outside';
  assert.equal((await adapter.list())[0].title, 'New');
  const second = await adapter.create({ title: 'Second', description: 'about search' });
  assert.deepEqual((await adapter.list()).map(i => i.id), [second.id, 'id-1']);
  assert.deepEqual((await adapter.list({ q: 'SEARCH' })).map(i => i.id), [second.id]);
  const moved = await adapter.update('id-1', { status: 'done' });
  assert.equal(moved.status, 'done');
  assert.notEqual(moved.updatedAt, moved.createdAt);
  await assert.rejects(adapter.list({ status: 'nope' }), e => e instanceof ApiError && e.status === 400);
  await assert.rejects(adapter.update('missing', { status: 'done' }), e => e.status === 404 && e.code === 'NOT_FOUND');
  await assert.rejects(adapter.update('id-1', {}), e => e.status === 400);
  await assert.rejects(adapter.create({ title: 'x', status: 'done' }), e => e.status === 400);
  const failing = createMemoryAdapter({ issues: [], failures: { list: 1 } });
  await assert.rejects(failing.list(), e => e.code === 'STORAGE_ERROR');
  assert.deepEqual(await failing.list(), []);
});

const T0 = '2026-09-25T00:00:00.000Z';
const liveIssue = (id, extra = {}) => ({ id, title: `Issue ${id}`, description: '', status: 'open', createdAt: T0, updatedAt: T0, ...extra });
// A fake fetch Response: a JSON body, or raw text that json() cannot parse.
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const textResponse = (status, text) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) });
const GATEWAY_HTML = '<!doctype html><html><body><h1>502 Bad Gateway</h1><p>Temporary proxy page</p></body></html>';

test('HTTP adapter uses the contract endpoints and surfaces error bodies', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body, type: init.headers['content-type'] });
    if (url.startsWith('/api/issues?')) return jsonResponse(200, { items: [liveIssue('1')] });
    if (init.method === 'POST') return jsonResponse(201, liveIssue('2', JSON.parse(init.body)));
    if (url === '/api/issues/a%2Fb') return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Issue not found.' } });
    if (url === '/api/issues/ok') return jsonResponse(200, liveIssue('ok', { status: 'done' }));
    return jsonResponse(500, null);
  };
  const api = createHttpAdapter({ fetchImpl });
  assert.equal(api.mode, 'api');
  assert.deepEqual(await api.list({ status: 'open', q: 'a b' }), [liveIssue('1')]);
  assert.equal(requests[0].url, '/api/issues?status=open&q=a+b');
  assert.equal((await api.create({ title: 'T' })).title, 'T');
  assert.equal(requests[1].type, 'application/json');
  assert.equal((await api.update('ok', { status: 'done' })).status, 'done');
  await assert.rejects(api.update('a/b', { status: 'done' }),
    e => e.code === 'NOT_FOUND' && e.status === 404 && e.message === 'Issue not found.' && e.outcomeUnknown === false);
  await assert.rejects(api.update('x', { status: 'done' }), e => e.code === 'HTTP_500' && e.outcomeUnknown === true);
  const offline = createHttpAdapter({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.list(), e => e.code === 'NETWORK_ERROR' && e.outcomeUnknown === true);
  await assert.rejects(offline.create({ title: 'T' }), e => e.code === 'NETWORK_ERROR' && e.outcomeUnknown === true);
});

test('isValidIssue accepts only the contract issue shape', () => {
  assert.equal(isValidIssue(liveIssue('a')), true);
  assert.equal(isValidIssue(liveIssue('a', { description: 'text', status: 'in_progress' })), true);
  for (const bad of [null, [], 'x', { id: '1' }, liveIssue(''), liveIssue('a', { title: '  ' }),
    liveIssue('a', { title: 'x'.repeat(TITLE_MAX + 1) }), liveIssue('a', { description: null }),
    liveIssue('a', { description: 'd'.repeat(DESCRIPTION_MAX + 1) }), liveIssue('a', { status: 'blocked' }),
    liveIssue('a', { createdAt: 'yesterday' }), liveIssue('a', { updatedAt: undefined })]) {
    assert.equal(isValidIssue(bad), false, JSON.stringify(bad));
  }
});

// Regression: a 200 response that is not the { items: [...] } shape (for example a
// temporary gateway HTML page) used to become an empty list, which looked like
// every issue had been deleted.
test('HTTP list rejects malformed 200 responses instead of returning an empty list', async () => {
  const cases = {
    'gateway HTML page': () => textResponse(200, GATEWAY_HTML),
    'empty body': () => textResponse(200, ''),
    'JSON null': () => jsonResponse(200, null),
    'bare array': () => jsonResponse(200, [liveIssue('1')]),
    'missing items': () => jsonResponse(200, { issues: [liveIssue('1')] }),
    'items is not an array': () => jsonResponse(200, { items: {} }),
    'invalid entry': () => jsonResponse(200, { items: [liveIssue('1'), { id: '2', title: 'no status' }] }),
    'gateway 502 HTML': () => textResponse(502, GATEWAY_HTML),
  };
  for (const [name, respond] of Object.entries(cases)) {
    const api = createHttpAdapter({ fetchImpl: async () => respond() });
    await assert.rejects(api.list(), e => e instanceof ApiError && e.outcomeUnknown === true && /INVALID_RESPONSE|HTTP_502/.test(e.code), name);
  }
  const empty = createHttpAdapter({ fetchImpl: async () => jsonResponse(200, { items: [] }) });
  assert.deepEqual(await empty.list(), [], 'a well-formed empty list is still an empty list');
});

test('HTTP create/update reject success responses that are not a valid issue', async () => {
  const bodies = {
    'gateway HTML page': () => textResponse(200, GATEWAY_HTML),
    'empty object': () => jsonResponse(201, {}),
    'wrong status value': () => jsonResponse(201, liveIssue('n', { status: 'saved' })),
    'missing timestamps': () => jsonResponse(201, { id: 'n', title: 'T', description: '', status: 'open' }),
  };
  for (const [name, respond] of Object.entries(bodies)) {
    const api = createHttpAdapter({ fetchImpl: async () => respond() });
    await assert.rejects(api.create({ title: 'T' }), e => e.code === 'INVALID_RESPONSE' && e.outcomeUnknown === true, `create: ${name}`);
    await assert.rejects(api.update('n', { status: 'done' }), e => e.code === 'INVALID_RESPONSE' && e.outcomeUnknown === true, `update: ${name}`);
  }
  const otherIssue = createHttpAdapter({ fetchImpl: async () => jsonResponse(200, liveIssue('someone-else')) });
  await assert.rejects(otherIssue.update('n', { status: 'done' }), e => e.code === 'UNCONFIRMED_RESULT' && e.outcomeUnknown === true, 'update must return the issue that was changed');
});

test('the page always uses the live API: no demo data, fixture mode or fallback', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createFixtureAdapter|fixtureIssues|selectAdapter|DATA_MODE|FIXTURE_SCENARIOS|fixture-banner/);
  assert.match(source, /mountApp\(root, \{ adapter: createHttpAdapter\(\), doc: document \}\)/);
  const { root } = await mount(createMemoryAdapter({ issues: [] }));
  assert.equal(byRole(root, 'fixture-banner'), undefined);
  assert.match(byRole(root, 'data-source').textContent, /Live data from this server/);
});

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------
test('board shows three columns, counts, loading state and the live-data note', async () => {
  const gate = deferred();
  const inner = createMemoryAdapter({ issues: sampleIssues('default') });
  const adapter = { mode: 'memory', list: async a => { await gate.promise; return inner.list(a); }, create: inner.create, update: inner.update };
  const doc = fakeDocument();
  const root = doc.createElement('main');
  const app = mountApp(root, { adapter, doc, searchDelayMs: 0 });
  assert.equal(byRole(root, 'board').getAttribute('aria-busy'), 'true');
  assert.equal(byRole(root, 'board-status').textContent, 'Loading issues…');
  gate.resolve();
  await app.ready;
  assert.equal(byRole(root, 'board').getAttribute('aria-busy'), 'false');
  assert.ok(byRole(root, 'data-source').textContent.includes('Live data'));
  assert.equal(byRole(root, 'count-open').textContent, '2');
  assert.equal(byRole(root, 'count-in_progress').textContent, '1');
  assert.equal(byRole(root, 'count-done').textContent, '1');
  assert.deepEqual(cardTitles(root, 'open'), ['Add keyboard access to the edit dialog', 'Board columns collapse on narrow screens']);
  assert.equal(byRole(root, 'empty-open').hidden, true);
  assert.equal(byRole(root, 'board-status').textContent, '4 issues shown.');
});

test('empty board shows per-column empty states', async () => {
  const { root } = await mount(createMemoryAdapter({ issues: [] }));
  for (const status of STATUSES) {
    assert.equal(byRole(root, `empty-${status}`).hidden, false);
    assert.equal(byRole(root, `count-${status}`).textContent, '0');
  }
  assert.equal(byRole(root, 'board-status').textContent, 'No issues yet. Create the first one.');
});

test('HTML-like issue text is rendered as text, never as markup', async () => {
  const { root } = await mount(createMemoryAdapter({ issues: sampleIssues('html') }));
  const title = allByRole(root, 'card-title').find(n => n.textContent.startsWith('<img'));
  assert.ok(title, 'html sample rendered');
  assert.equal(title.children.length, 1);
  assert.equal(title.children[0].nodeType, 3, 'title is a single text node');
  assert.equal(title.textContent, '<img src=x onerror="alert(1)"> rendered as text');
  assert.ok(![...walk(root)].some(n => n.tagName === 'IMG' || n.tagName === 'SCRIPT'));
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('load failure shows a recoverable error with Retry', async () => {
  const { root } = await mount(createMemoryAdapter({ issues: sampleIssues('default'), failures: { list: 1 } }));
  assert.equal(byRole(root, 'load-error').hidden, false);
  assert.match(byRole(root, 'load-error-text').textContent, /Could not load issues/);
  byRole(root, 'retry').dispatch('click');
  await flush();
  assert.equal(byRole(root, 'load-error').hidden, true);
  assert.equal(byRole(root, 'count-open').textContent, '2');
});

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------
test('create form validates, shows pending state and only reports success after confirmation', async () => {
  const inner = createMemoryAdapter({ issues: [] });
  const gate = deferred();
  const calls = [];
  const adapter = { mode: 'memory', list: inner.list, update: inner.update, create: async input => { calls.push(input); await gate.promise; return inner.create(input); } };
  const { root, doc } = await mount(adapter);
  const form = byRole(root, 'create-form');
  const title = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-title');
  const description = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-description');

  form.dispatch('submit');
  assert.equal(calls.length, 0);
  assert.equal(title.getAttribute('aria-invalid'), 'true');
  assert.equal(byRole(root, 'new-title-error').hidden, false);
  assert.equal(doc.activeElement, title);

  title.value = '  Write tests  ';
  description.value = 'For the board';
  form.dispatch('submit');
  assert.deepEqual(calls[0], { title: 'Write tests', description: 'For the board' });
  const button = byRole(root, 'create-submit');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Saving…');
  assert.equal(byRole(root, 'create-pending').hidden, false);
  assert.match(byRole(root, 'create-pending').textContent, /Saving “Write tests”… You can keep typing your next issue; it will not be cleared\./);
  assert.equal(byRole(root, 'create-pending').getAttribute('aria-live'), 'polite');
  assert.equal(byRole(root, 'announcer').textContent, '', 'no success before the adapter confirms');
  assert.equal(title.getAttribute('aria-invalid'), null);

  gate.resolve();
  await flush();
  assert.equal(button.disabled, false);
  assert.equal(title.value, '');
  assert.match(byRole(root, 'announcer').textContent, /Issue created: Write tests/);
  assert.equal(byRole(root, 'create-pending').hidden, true);
  assert.deepEqual(cardTitles(root, 'open'), ['Write tests']);
});

// Regression: on a slow save the user typed the next draft while waiting, and the
// first save's success cleared it.
// The adapter's create promise is released by hand, so the order is fixed:
// submit, then type a new draft, then the first save resolves.
test('a draft typed while the previous create is saving is kept when that save succeeds', async () => {
  const inner = createMemoryAdapter({ issues: [] });
  const gate = deferred();
  const calls = [];
  const order = [];
  const adapter = {
    mode: 'memory', list: inner.list, update: inner.update,
    create: async input => { calls.push(input); order.push('create-sent'); await gate.promise; order.push('create-resolved'); return inner.create(input); },
  };
  const { root } = await mount(adapter);
  const form = byRole(root, 'create-form');
  const button = byRole(root, 'create-submit');
  const title = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-title');
  const description = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-description');

  title.value = 'First issue';
  description.value = 'First description';
  form.dispatch('submit');
  assert.equal(calls.length, 1);
  assert.equal(button.disabled, true, 'the create button is disabled while saving');
  assert.equal(byRole(root, 'create-pending').hidden, false, 'a visible saving notice is shown');

  // The user starts the next draft while the first request is still in flight.
  title.value = 'Second draft';
  description.value = 'Typed while the first issue was saving';
  order.push('draft-typed');
  form.dispatch('submit');
  assert.equal(calls.length, 1, 'a second submit during the save does not send another request');

  gate.resolve();
  await flush();
  assert.deepEqual(order, ['create-sent', 'draft-typed', 'create-resolved']);
  assert.equal(title.value, 'Second draft', 'the new title draft is kept');
  assert.equal(description.value, 'Typed while the first issue was saving', 'the new description draft is kept');
  assert.deepEqual(cardTitles(root, 'open'), ['First issue'], 'the first issue appears exactly once');
  assert.match(byRole(root, 'announcer').textContent, /Issue created: First issue\. Your new draft was kept\./);
  assert.equal(button.disabled, false);
  assert.equal(byRole(root, 'create-pending').hidden, true);

  // The kept draft is a normal draft: submitting it creates the second issue and clears the form.
  form.dispatch('submit');
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { title: 'Second draft', description: 'Typed while the first issue was saving' });
  assert.deepEqual(cardTitles(root, 'open'), ['Second draft', 'First issue']);
  assert.equal(title.value, '');
  assert.equal(description.value, '');
});

test('changing only one field during a slow save keeps the whole draft', async () => {
  const inner = createMemoryAdapter({ issues: [] });
  const gate = deferred();
  const adapter = { mode: 'memory', list: inner.list, update: inner.update, create: async input => { await gate.promise; return inner.create(input); } };
  const { root } = await mount(adapter);
  const title = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-title');
  const description = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-description');
  title.value = 'Same title';
  description.value = 'Old description';
  byRole(root, 'create-form').dispatch('submit');
  description.value = 'Old description, extended while saving';
  gate.resolve();
  await flush();
  assert.equal(title.value, 'Same title');
  assert.equal(description.value, 'Old description, extended while saving');
  assert.deepEqual(cardTitles(root, 'open'), ['Same title']);
});

test('a failed slow create never overwrites a draft typed while it was saving', async () => {
  const inner = createMemoryAdapter({ issues: [] });
  const gate = deferred();
  const adapter = { mode: 'memory', list: inner.list, update: inner.update, create: async () => { await gate.promise; throw new ApiError('HTTP_503', 'Service unavailable.', 503); } };
  const { root } = await mount(adapter);
  const title = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-title');
  const description = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-description');
  title.value = 'Will fail';
  description.value = 'first';
  byRole(root, 'create-form').dispatch('submit');
  title.value = 'Newer draft';
  description.value = 'typed while waiting';
  gate.resolve();
  await flush();
  assert.equal(title.value, 'Newer draft');
  assert.equal(description.value, 'typed while waiting');
  assert.equal(byRole(root, 'create-error').hidden, false);
  assert.match(byRole(root, 'create-error').textContent, /“Will fail” was not saved\. Your newer draft was left unchanged\./);
  assert.deepEqual(cardTitles(root, 'open'), []);
});

test('failed create keeps the typed input and can be retried', async () => {
  const adapter = recordingAdapter(createMemoryAdapter({ issues: [], failures: { create: 1 } }));
  const { root } = await mount(adapter);
  const title = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-title');
  const description = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-description');
  title.value = 'Keep me';
  description.value = 'and me';
  byRole(root, 'create-form').dispatch('submit');
  await flush();
  assert.equal(byRole(root, 'create-error').hidden, false);
  assert.match(byRole(root, 'create-error').textContent, /Your text is kept/);
  assert.equal(title.value, 'Keep me');
  assert.equal(description.value, 'and me');
  assert.deepEqual(cardTitles(root, 'open'), []);
  byRole(root, 'create-form').dispatch('submit');
  await flush();
  assert.equal(byRole(root, 'create-error').hidden, true);
  assert.deepEqual(cardTitles(root, 'open'), ['Keep me']);
});

// ---------------------------------------------------------------------------
// Status changes and edit dialog
// ---------------------------------------------------------------------------
test('status select moves a card only after the update succeeds, and reverts on failure', async () => {
  const adapter = createMemoryAdapter({ issues: sampleIssues('default'), failures: { update: 1 } });
  const { root } = await mount(adapter);
  const cardFor = t => allByRole(root, 'card').find(c => byRole(c, 'card-title').textContent === t);
  let select = byRole(cardFor('Board columns collapse on narrow screens'), 'card-status');
  select.value = 'done';
  select.dispatch('change');
  await flush();
  assert.equal(select.value, 'open', 'reverted after failure');
  assert.equal(byRole(root, 'action-error').hidden, false);
  assert.match(byRole(root, 'action-error-text').textContent, /Could not change the status/);
  assert.ok(cardTitles(root, 'open').includes('Board columns collapse on narrow screens'));

  select.value = 'done';
  select.dispatch('change');
  await flush();
  assert.ok(cardTitles(root, 'done').includes('Board columns collapse on narrow screens'));
  assert.equal(byRole(root, 'count-done').textContent, '2');
  assert.equal(byRole(root, 'action-error').hidden, true);
});

test('edit dialog is keyboard friendly and sends only changed fields', async () => {
  const adapter = recordingAdapter(createMemoryAdapter({ issues: sampleIssues('default') }));
  const { root, doc } = await mount(adapter);
  const dialog = byRole(root, 'edit-dialog');
  const editTitle = [...walk(root)].find(n => n.getAttribute?.('id') === 'edit-title');
  const editStatus = [...walk(root)].find(n => n.getAttribute?.('id') === 'edit-status');
  const firstEdit = () => allByRole(byRole(root, 'list-in_progress'), 'card-edit')[0];

  firstEdit().dispatch('click');
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(doc.activeElement, editTitle);
  assert.equal(editTitle.value, 'Search should match descriptions');
  assert.match(firstEdit().getAttribute('aria-label'), /Edit issue: Search should match descriptions/);

  dialog.dispatch('keydown', { key: 'Escape' });
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(doc.activeElement, firstEdit(), 'focus returns to the Edit button');

  firstEdit().dispatch('click');
  editTitle.value = 'Search matches descriptions';
  editStatus.value = 'done';
  byRole(root, 'edit-form').dispatch('submit');
  await flush();
  const update = adapter.calls.find(c => c[0] === 'update');
  assert.deepEqual(update[2], { title: 'Search matches descriptions', status: 'done' });
  assert.equal(dialog.hasAttribute('open'), false);
  assert.ok(cardTitles(root, 'done').includes('Search matches descriptions'));
  assert.equal(doc.activeElement.getAttribute('data-role'), 'card-edit');
});

test('failed edit keeps the dialog open with the user changes', async () => {
  const { root } = await mount(createMemoryAdapter({ issues: sampleIssues('default'), failures: { update: 1 } }));
  const dialog = byRole(root, 'edit-dialog');
  const editTitle = [...walk(root)].find(n => n.getAttribute?.('id') === 'edit-title');
  allByRole(root, 'card-edit')[0].dispatch('click');
  editTitle.value = 'Changed title';
  byRole(root, 'edit-form').dispatch('submit');
  await flush();
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(editTitle.value, 'Changed title');
  assert.match(byRole(root, 'edit-error').textContent, /Your changes are kept/);
  editTitle.value = '   ';
  byRole(root, 'edit-form').dispatch('submit');
  assert.equal(editTitle.getAttribute('aria-invalid'), 'true');
});

// ---------------------------------------------------------------------------
// Search and filter
// ---------------------------------------------------------------------------
test('search and status filter query the adapter and show filtered empty states', async () => {
  const adapter = recordingAdapter(createMemoryAdapter({ issues: sampleIssues('default') }));
  const { root } = await mount(adapter);
  const search = byRole(root, 'search');
  search.value = 'KEYBOARD';
  search.dispatch('input');
  await flush();
  assert.deepEqual(adapter.calls.at(-1), ['list', { status: '', q: 'KEYBOARD' }]);
  assert.deepEqual(cardTitles(root, 'open'), ['Add keyboard access to the edit dialog']);
  assert.match(byRole(root, 'empty-done').textContent, /match these filters/);

  const filter = byRole(root, 'status-filter');
  filter.value = 'done';
  filter.dispatch('change');
  await flush();
  assert.deepEqual(adapter.calls.at(-1), ['list', { status: 'done', q: 'KEYBOARD' }]);
  assert.equal(byRole(root, 'board-status').textContent, 'No issues match your search.');
});

test('a slow earlier search response never overwrites a newer one', async () => {
  const gates = [];
  const inner = createMemoryAdapter({ issues: sampleIssues('default') });
  const adapter = { mode: 'memory', create: inner.create, update: inner.update, list: async a => { const g = deferred(); gates.push(g); await g.promise; return inner.list(a); } };
  const doc = fakeDocument();
  const root = doc.createElement('main');
  mountApp(root, { adapter, doc, searchDelayMs: 0 });
  gates[0].resolve();
  await flush();
  const search = byRole(root, 'search');
  search.value = 'narrow';
  search.dispatch('input');
  await flush();
  search.value = 'keyboard';
  search.dispatch('input');
  await flush();
  gates[2].resolve();
  await flush();
  gates[1].resolve();
  await flush();
  assert.deepEqual(cardTitles(root, 'open'), ['Add keyboard access to the edit dialog']);
});

// ---------------------------------------------------------------------------
// Static page checks
// ---------------------------------------------------------------------------
test('page shell is responsive, labelled and blue/white themed', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /id="app"/);
  assert.match(html, /Issue tracker/);
  assert.match(css, /@media \(min-width: 1024px\)/);
  assert.match(css, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /--blue-600: #2563eb/);
  assert.match(css, /:focus-visible/);
});

// ---------------------------------------------------------------------------
// Live-mode regressions: malformed responses through the real HTTP adapter
// ---------------------------------------------------------------------------
// A scripted fetch: each call takes the next response for its method.
function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const queue = script[init.method];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next(url, init);
  };
  return { fetchImpl, calls };
}

test('a malformed list response shows a recoverable error, not an empty board, and Retry recovers', async () => {
  const { fetchImpl } = scriptedFetch({
    GET: [() => textResponse(200, GATEWAY_HTML), () => jsonResponse(200, { items: [liveIssue('1', { title: 'Real issue' })] })],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  assert.equal(byRole(root, 'load-error').hidden, false);
  assert.match(byRole(root, 'load-error-text').textContent, /Could not load issues: The server sent a response the board could not read\. The list was not updated\. Try again\./);
  assert.equal(byRole(root, 'board-status').textContent, 'Issues could not be loaded.');
  for (const status of STATUSES) assert.equal(byRole(root, `empty-${status}`).hidden, true, `no "No ${status} issues" claim`);
  byRole(root, 'retry').dispatch('click');
  await flush();
  assert.equal(byRole(root, 'load-error').hidden, true);
  assert.deepEqual(cardTitles(root, 'open'), ['Real issue']);
});

test('a malformed refresh keeps the last loaded list on screen', async () => {
  const { fetchImpl } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [liveIssue('1', { title: 'Loaded first' })] }), () => jsonResponse(200, { items: [{ id: 'broken' }] })],
  });
  const { root, app } = await mount(createHttpAdapter({ fetchImpl }));
  assert.deepEqual(cardTitles(root, 'open'), ['Loaded first']);
  await app.reload();
  assert.equal(byRole(root, 'load-error').hidden, false);
  assert.match(byRole(root, 'load-error-text').textContent, /The board still shows the last list that loaded\./);
  assert.equal(byRole(root, 'board-status').textContent, 'Issues could not be refreshed. Showing the last list that loaded.');
  assert.deepEqual(cardTitles(root, 'open'), ['Loaded first']);
});

test('a well-formed empty list still shows the normal empty state', async () => {
  const { fetchImpl } = scriptedFetch({ GET: [() => jsonResponse(200, { items: [] })] });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  assert.equal(byRole(root, 'load-error').hidden, true);
  assert.equal(byRole(root, 'board-status').textContent, 'No issues yet. Create the first one.');
  for (const status of STATUSES) assert.equal(byRole(root, `empty-${status}`).hidden, false);
});

test('an invalid create response is not reported as saved and keeps the input for retry', async () => {
  const saved = liveIssue('n1', { title: 'Keep me', description: 'and me' });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [] }), () => jsonResponse(200, { items: [] }), () => jsonResponse(200, { items: [] }), () => jsonResponse(200, { items: [saved] })],
    POST: [() => textResponse(200, GATEWAY_HTML), () => jsonResponse(201, saved)],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  const title = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-title');
  const description = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-description');
  title.value = 'Keep me';
  description.value = 'and me';
  byRole(root, 'create-form').dispatch('submit');
  await flush(6);
  const error = byRole(root, 'create-error');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'Could not confirm whether “Keep me” was saved: The server sent a response the board could not read. The server has no issue with this title and description right now. You can create it again. Your text is kept.');
  assert.doesNotMatch(error.textContent, /was not saved/, 'an unknown outcome is never stated as not saved');
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Issue created/);
  assert.equal(title.value, 'Keep me');
  assert.equal(description.value, 'and me');
  const gets = calls.filter(c => c.method === 'GET').map(c => c.url);
  assert.deepEqual(gets.slice(1), ['/api/issues?q=Keep+me', '/api/issues'], 'the server is searched for the title, then the board is reloaded');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'never created again automatically');

  byRole(root, 'create-form').dispatch('submit');
  await flush(6);
  assert.equal(error.hidden, true);
  assert.match(byRole(root, 'announcer').textContent, /Issue created: Keep me/);
  assert.equal(title.value, '');
  assert.deepEqual(cardTitles(root, 'open'), ['Keep me']);
});

test('a dropped connection during create says the result could not be confirmed', async () => {
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') { posts += 1; throw new TypeError('network connection was lost'); }
    return jsonResponse(200, { items: [] });
  };
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  const title = [...walk(root)].find(n => n.getAttribute?.('id') === 'new-title');
  title.value = 'Maybe saved';
  byRole(root, 'create-form').dispatch('submit');
  await flush(6);
  assert.equal(posts, 1);
  assert.match(byRole(root, 'create-error').textContent, /Could not confirm whether “Maybe saved” was saved: The connection to the server failed\./);
  assert.doesNotMatch(byRole(root, 'create-error').textContent, /was not saved/);
  assert.equal(title.value, 'Maybe saved');
});

test('an invalid edit response keeps the dialog open and says the result could not be confirmed', async () => {
  const original = liveIssue('e1', { title: 'Original title' });
  const { fetchImpl } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] })],
    PATCH: [() => jsonResponse(200, { ok: true })],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  const dialog = byRole(root, 'edit-dialog');
  const editTitle = [...walk(root)].find(n => n.getAttribute?.('id') === 'edit-title');
  allByRole(root, 'card-edit')[0].dispatch('click');
  editTitle.value = 'Edited title';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(6);
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(editTitle.value, 'Edited title');
  assert.match(byRole(root, 'edit-error').textContent, /Could not confirm whether your changes were saved: The server sent a response the board could not read\. The server still shows the values from before this save, so the save may not have been applied\. Your changes are kept here\./);
  assert.doesNotMatch(byRole(root, 'edit-error').textContent, /[Rr]eload/, 'never asks for a page reload, which would lose the draft');
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Saved/);
  assert.equal(byRole(root, 'edit-check').hidden, false);
});

test('an invalid status-change response is not shown as moved and the board is reloaded', async () => {
  const original = liveIssue('s1', { title: 'Move me' });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] })],
    PATCH: [() => textResponse(200, GATEWAY_HTML)],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  const select = byRole(allByRole(root, 'card')[0], 'card-status');
  select.value = 'done';
  select.dispatch('change');
  await flush(6);
  assert.match(byRole(root, 'action-error-text').textContent, /Could not confirm whether “Move me” moved to Done/);
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Moved/);
  assert.deepEqual(cardTitles(root, 'open'), ['Move me']);
  assert.match(byRole(root, 'action-error-text').textContent, /The server now shows it in Open\. Choose Done again if you still want to move it\.$/);
  assert.equal(calls.filter(c => c.method === 'GET').length, 3, 'one check of the server, then the board is reloaded');
});

// ---------------------------------------------------------------------------
// A save counts only when the reply shows what this user submitted
// ---------------------------------------------------------------------------
const byId = (root, id) => [...walk(root)].find(n => n.getAttribute?.('id') === id);

test('save confirmation compares the submitted fields, with the title trimmed per contract', () => {
  const issue = liveIssue('c1', { title: 'Padded', description: '  keep spaces ', status: 'in_progress' });
  assert.equal(matchesSubmitted(issue, { title: '  Padded  ' }), true, 'the contract stores titles trimmed');
  assert.equal(matchesSubmitted(issue, { description: '  keep spaces ' }), true);
  assert.equal(matchesSubmitted(issue, { description: 'keep spaces' }), false, 'descriptions are not trimmed by the contract');
  assert.equal(matchesSubmitted(issue, { status: 'in_progress' }), true);
  assert.equal(matchesSubmitted(issue, { status: 'done' }), false, 'a stale status is not a confirmed move');
  assert.equal(matchesSubmitted(issue, { title: 'Other' }), false);
  assert.deepEqual(expectedCreate({ title: ' New ' }), { title: 'New', description: '', status: 'open' });
  assert.equal(confirmSaved(issue, { status: 'in_progress' }, { id: 'c1' }), issue);
  assert.throws(() => confirmSaved(issue, { status: 'in_progress' }, { id: 'c2' }),
    e => e.code === 'UNCONFIRMED_RESULT' && e.outcomeUnknown === true && e.message === UNCONFIRMED_MESSAGE);
  assert.throws(() => confirmSaved(issue, { status: 'done' }, { id: 'c1' }), e => e.code === 'UNCONFIRMED_RESULT');
});

test('HTTP create/update reject well-formed replies that do not show the submitted values', async () => {
  const reply = issue => createHttpAdapter({ fetchImpl: async () => jsonResponse(200, issue) });
  await assert.rejects(reply(liveIssue('n', { title: 'Someone else' })).create({ title: 'Mine' }),
    e => e.code === 'UNCONFIRMED_RESULT' && e.outcomeUnknown === true, 'different title');
  await assert.rejects(reply(liveIssue('n', { title: 'Mine', description: 'other' })).create({ title: 'Mine', description: 'mine' }),
    e => e.code === 'UNCONFIRMED_RESULT', 'different description');
  await assert.rejects(reply(liveIssue('n', { title: 'Mine', status: 'done' })).create({ title: 'Mine' }),
    e => e.code === 'UNCONFIRMED_RESULT', 'a new issue must be open');
  assert.equal((await reply(liveIssue('n', { title: 'Mine' })).create({ title: '  Mine  ' })).title, 'Mine', 'trimmed title is confirmed');
  await assert.rejects(reply(liveIssue('n', { status: 'open' })).update('n', { status: 'done' }),
    e => e.code === 'UNCONFIRMED_RESULT' && e.outcomeUnknown === true, 'same issue, old status');
  await assert.rejects(reply(liveIssue('n', { title: 'Old' })).update('n', { title: 'New' }), e => e.code === 'UNCONFIRMED_RESULT');
  assert.equal((await reply(liveIssue('n', { title: 'New' })).update('n', { title: ' New ' })).title, 'New');
});

test('a status reply that still shows the old status is not announced as moved', async () => {
  const original = liveIssue('s2', { title: 'Stale move' });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] })],
    PATCH: [() => jsonResponse(200, original)],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  const select = byRole(allByRole(root, 'card')[0], 'card-status');
  select.value = 'done';
  select.dispatch('change');
  await flush(6);
  assert.equal(byRole(root, 'action-error-text').textContent,
    `Could not confirm whether “Stale move” moved to Done: ${UNCONFIRMED_MESSAGE} The server now shows it in Open. Choose Done again if you still want to move it.`);
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Moved/);
  assert.deepEqual(cardTitles(root, 'open'), ['Stale move']);
  assert.equal(calls.filter(c => c.method === 'GET').length, 3, 'the server is checked, then the board is reloaded to show the real status');
});

test('a create reply for different content keeps the draft and is not announced', async () => {
  const { fetchImpl } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [] })],
    POST: [() => jsonResponse(201, liveIssue('x1', { title: 'Somebody else’s issue' }))],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  byId(root, 'new-title').value = 'My issue';
  byId(root, 'new-description').value = 'My text';
  byRole(root, 'create-form').dispatch('submit');
  await flush(6);
  assert.equal(byRole(root, 'create-error').textContent,
    `Could not confirm whether “My issue” was saved: ${UNCONFIRMED_MESSAGE} The server has no issue with this title and description right now. You can create it again. Your text is kept.`);
  assert.equal(byId(root, 'new-title').value, 'My issue');
  assert.equal(byId(root, 'new-description').value, 'My text');
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Issue created/);
});

test('a create reply with the contract-trimmed title counts as saved', async () => {
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [] })],
    POST: [(url, init) => jsonResponse(201, liveIssue('t1', { title: JSON.parse(init.body).title.trim() }))],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  byId(root, 'new-title').value = '   Padded title   ';
  byRole(root, 'create-form').dispatch('submit');
  await flush(6);
  assert.equal(byRole(root, 'create-error').hidden, true);
  assert.match(byRole(root, 'announcer').textContent, /Issue created: Padded title/);
  assert.equal(byId(root, 'new-title').value, '');
  assert.equal(JSON.parse(calls.find(c => c.method === 'POST').body).title, 'Padded title');
});

test('an unconfirmed edit re-queries the board in the app, keeps the draft and can be sent again', async () => {
  const original = liveIssue('e2', { title: 'Before' });
  const edited = liveIssue('e2', { title: 'After', description: 'Draft description', updatedAt: '2026-09-25T01:00:00.000Z' });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [original] }),
      () => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [edited] })],
    PATCH: [() => jsonResponse(200, liveIssue('e2', { title: 'Something else' })), () => jsonResponse(200, edited)],
  });
  const { root, doc } = await mount(createHttpAdapter({ fetchImpl }));
  const dialog = byRole(root, 'edit-dialog');
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'After';
  byId(root, 'edit-description').value = 'Draft description';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  assert.equal(dialog.hasAttribute('open'), true, 'the dialog stays open');
  assert.equal(byId(root, 'edit-title').value, 'After');
  assert.equal(byId(root, 'edit-description').value, 'Draft description');
  assert.equal(byRole(root, 'edit-error').textContent,
    `Could not confirm whether your changes were saved: ${UNCONFIRMED_MESSAGE} The server still shows the values from before this save, so the save may not have been applied. Your changes are kept here. Choose Save changes to send your version again (it replaces what the server shows), Use server values to drop your draft, or Check again.`);
  assert.equal(byRole(root, 'edit-check').hidden, false);
  assert.equal(byRole(root, 'edit-adopt').hidden, false);
  assert.equal(byRole(root, 'edit-compare').textContent, 'Server now shows: title “Before”, status Open, description (empty).');
  assert.equal(doc.activeElement, byRole(root, 'edit-save'));
  const gets = calls.filter(c => c.method === 'GET').map(c => c.url);
  assert.equal(gets[1], '/api/issues', 'the check asks for all issues, not a page reload');
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Saved/);

  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  const patches = calls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body));
  assert.deepEqual(patches[1], { title: 'After', description: 'Draft description' }, 'the retry sends the kept draft');
  assert.equal(dialog.hasAttribute('open'), false);
  assert.match(byRole(root, 'announcer').textContent, /Saved “After”\./);
});

test('an unconfirmed edit that the board shows as applied is confirmed, even when filters would hide it', async () => {
  const original = liveIssue('e3', { title: 'Filtered' });
  const moved = { ...original, status: 'done', updatedAt: '2026-09-25T01:00:00.000Z' };
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [original] }),
      () => jsonResponse(200, { items: [moved] }), () => jsonResponse(200, { items: [] })],
    PATCH: [() => { throw new TypeError('network connection was lost'); }],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  const filter = byRole(root, 'status-filter');
  filter.value = 'open';
  filter.dispatch('change');
  await flush();
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-status').value = 'done';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  const gets = calls.filter(c => c.method === 'GET').map(c => c.url);
  assert.equal(gets[2], '/api/issues', 'the check ignores the active filter');
  assert.equal(gets[3], '/api/issues?status=open', 'then the filtered board is refreshed');
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), false);
  assert.equal(byRole(root, 'announcer').textContent, 'The server now shows your changes to “Filtered”, so nothing more needs sending.');
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 1, 'nothing is sent twice');
});

test('when the check also fails, the draft stays and Check again tries once more', async () => {
  const original = liveIssue('e4', { title: 'Offline' });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => textResponse(502, GATEWAY_HTML), () => textResponse(502, GATEWAY_HTML),
      () => jsonResponse(200, { items: [original] })],
    PATCH: [() => { throw new TypeError('network connection was lost'); }],
  });
  const { root, doc } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'Offline edit';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  assert.equal(byRole(root, 'edit-error').textContent,
    'Could not confirm whether your changes were saved: The connection to the server failed. The board could not be checked either: The server answered with an unexpected error (502). Your changes are kept here. Choose Check again, or Save changes to send them again.');
  assert.equal(doc.activeElement, byRole(root, 'edit-check'));
  assert.equal(byId(root, 'edit-title').value, 'Offline edit');

  byRole(root, 'edit-check').dispatch('click');
  await flush(8);
  assert.match(byRole(root, 'edit-error').textContent, /The server still shows the values from before this save, so the save may not have been applied\. Your changes are kept here\./);
  assert.equal(byId(root, 'edit-title').value, 'Offline edit');
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), true);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 1, 'checking never re-sends the change');
});

test('edits typed while the check runs are kept even if the earlier save turns out applied', async () => {
  const original = liveIssue('e5', { title: 'First' });
  const check = deferred();
  const { fetchImpl } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => check.promise, () => jsonResponse(200, { items: [original] })],
    PATCH: [() => { throw new TypeError('network connection was lost'); }],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'Second';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(4);
  assert.equal(byRole(root, 'edit-cancel').disabled, true, 'the dialog cannot be dismissed while checking');
  byId(root, 'edit-title').value = 'Third';
  check.resolve(jsonResponse(200, { items: [{ ...original, title: 'Second' }] }));
  await flush(8);
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), true);
  assert.equal(byId(root, 'edit-title').value, 'Third');
  assert.equal(byRole(root, 'edit-error').textContent,
    'The board was checked and shows the changes you saved to “Second”. Your newer edits are still here and have not been saved.');
  assert.equal(byRole(root, 'edit-check').hidden, true);
});

// ---------------------------------------------------------------------------
// Edits typed while a successful save is still pending (review round 4)
// ---------------------------------------------------------------------------
const T1 = '2026-09-25T01:00:00.000Z';
const T2 = '2026-09-25T02:00:00.000Z';

test('text typed while a successful edit save is pending survives the reply and the refresh, and only the rest is sent next', async () => {
  const original = liveIssue('r1', { title: 'Draft release notes' });
  const saved = { ...original, title: 'Publish the release notes', updatedAt: T1 };
  const final = { ...saved, description: 'Also explain the migration and rollback', updatedAt: T2 };
  const patch = deferred();
  const refresh = deferred();
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => refresh.promise, () => jsonResponse(200, { items: [final] })],
    PATCH: [() => patch.promise, () => jsonResponse(200, final)],
  });
  const { root, doc } = await mount(createHttpAdapter({ fetchImpl }));
  const dialog = byRole(root, 'edit-dialog');
  const notice = byRole(root, 'edit-notice');
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'Publish the release notes';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(4);
  assert.equal(byRole(root, 'edit-save').disabled, true);
  assert.equal(byRole(root, 'edit-cancel').disabled, true, 'the dialog cannot be dismissed while saving');
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.textContent, 'Saving your changes… You can keep editing; anything you change now stays here.');

  // The user keeps typing before the PATCH reply arrives.
  byId(root, 'edit-description').value = 'Also explain the migration';
  patch.resolve(jsonResponse(200, saved));
  await flush(6);
  assert.equal(dialog.hasAttribute('open'), true, 'the dialog stays open during the refresh');
  assert.equal(byId(root, 'edit-description').value, 'Also explain the migration');
  assert.equal(byRole(root, 'edit-save').textContent, 'Refreshing…');
  assert.equal(byRole(root, 'edit-save').disabled, true);
  assert.equal(notice.textContent, 'Saved “Publish the release notes”. Refreshing the board… Anything you change now stays here.');

  // More typing while the list refresh is still pending.
  byId(root, 'edit-description').value = 'Also explain the migration and rollback';
  refresh.resolve(jsonResponse(200, { items: [saved] }));
  await flush(6);
  assert.equal(dialog.hasAttribute('open'), true, 'newer edits keep the dialog open');
  assert.equal(byId(root, 'edit-title').value, 'Publish the release notes');
  assert.equal(byId(root, 'edit-description').value, 'Also explain the migration and rollback');
  assert.equal(notice.textContent, 'Saved “Publish the release notes”. Your newer edits are still here and have not been saved. Choose Save changes to save them.');
  assert.equal(byRole(root, 'edit-save').disabled, false);
  assert.equal(byRole(root, 'edit-save').textContent, 'Save changes');
  assert.equal(byRole(root, 'edit-error').hidden, true, 'a confirmed save is not shown as an error');
  assert.deepEqual(cardTitles(root, 'open'), ['Publish the release notes'], 'the board shows the saved title');
  assert.equal(doc.activeElement, byId(root, 'edit-title'), 'focus is not pulled out of the field being edited');

  // Saving again sends only what differs from the confirmed baseline.
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  const patches = calls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body));
  assert.deepEqual(patches, [{ title: 'Publish the release notes' }, { description: 'Also explain the migration and rollback' }]);
  assert.equal(dialog.hasAttribute('open'), false, 'with nothing left unsaved the dialog closes');
  assert.equal(byRole(root, 'announcer').textContent, 'Saved “Publish the release notes”.');
  assert.equal(notice.hidden, true);
});

test('an edit made only while the board refreshes after a save is kept for an explicit save', async () => {
  const original = liveIssue('r2', { title: 'Refresh race' });
  const saved = { ...original, description: 'First pass', updatedAt: T1 };
  const refresh = deferred();
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => refresh.promise, () => jsonResponse(200, { items: [{ ...saved, status: 'done' }] })],
    PATCH: [() => jsonResponse(200, saved), () => jsonResponse(200, { ...saved, status: 'done', updatedAt: T2 })],
  });
  const { root, doc } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-description').value = 'First pass';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(6);
  byId(root, 'edit-status').value = 'done';
  doc.activeElement = null;
  refresh.resolve(jsonResponse(200, { items: [saved] }));
  await flush(6);
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), true);
  assert.equal(byId(root, 'edit-status').value, 'done');
  assert.equal(byId(root, 'edit-description').value, 'First pass');
  assert.match(byRole(root, 'edit-notice').textContent, /Your newer edits are still here and have not been saved\./);
  assert.equal(doc.activeElement, byRole(root, 'edit-save'), 'with no field focused, focus moves to Save changes');
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  const patches = calls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body));
  assert.deepEqual(patches, [{ description: 'First pass' }, { status: 'done' }]);
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), false);
});

test('edits typed during a save and then reverted still close the dialog normally', async () => {
  const original = liveIssue('r3', { title: 'Revert' });
  const saved = { ...original, title: 'Reverted back', updatedAt: T1 };
  const patch = deferred();
  const { fetchImpl } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [saved] })],
    PATCH: [() => patch.promise],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'Reverted back';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(4);
  byId(root, 'edit-description').value = 'temporary';
  byId(root, 'edit-description').value = '';
  patch.resolve(jsonResponse(200, saved));
  await flush(8);
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), false);
  assert.equal(byRole(root, 'announcer').textContent, 'Saved “Reverted back”.');
});

test('text typed during a save whose outcome is unknown is kept, and the unknown-outcome path is unchanged', async () => {
  const original = liveIssue('r4', { title: 'Unknown' });
  const patch = deferred();
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [original] })],
    PATCH: [() => patch.promise],
  });
  const { root, doc } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'Unknown sent';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(4);
  byId(root, 'edit-description').value = 'Typed while pending';
  patch.reject(new TypeError('network connection was lost'));
  await flush(8);
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), true);
  assert.equal(byId(root, 'edit-title').value, 'Unknown sent');
  assert.equal(byId(root, 'edit-description').value, 'Typed while pending');
  assert.equal(byRole(root, 'edit-error').textContent,
    'Could not confirm whether your changes were saved: The connection to the server failed. The server still shows the values from before this save, so the save may not have been applied. Your changes are kept here. Choose Save changes to send your version again (it replaces what the server shows), Use server values to drop your draft, or Check again.');
  assert.equal(byRole(root, 'edit-check').hidden, false);
  assert.equal(byRole(root, 'edit-notice').hidden, true, 'no saved notice for an unknown outcome');
  assert.equal(doc.activeElement, byRole(root, 'edit-save'));
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 1);
});

// ---------------------------------------------------------------------------
// NATIVE-UI additions: refresh, server comparison, duplicate check, deleted issues
// ---------------------------------------------------------------------------
test('Refresh asks the server again and shows a teammate’s new issue', async () => {
  const adapter = recordingAdapter(createMemoryAdapter({ issues: sampleIssues('default') }));
  const { root } = await mount(adapter);
  assert.equal(byRole(root, 'count-open').textContent, '2');
  const inner = adapter;
  await inner.create({ title: 'Added by a teammate' }); // as if another person saved it
  const before = inner.calls.filter(c => c[0] === 'list').length;
  const refresh = byRole(root, 'refresh');
  assert.equal(refresh.getAttribute('type'), 'button');
  refresh.dispatch('click');
  assert.equal(refresh.disabled, true, 'disabled while refreshing');
  assert.equal(refresh.textContent, 'Refreshing…');
  await flush();
  assert.equal(inner.calls.filter(c => c[0] === 'list').length, before + 1);
  assert.equal(refresh.disabled, false);
  assert.ok(cardTitles(root, 'open').includes('Added by a teammate'));
  assert.equal(byRole(root, 'announcer').textContent, 'Board refreshed. 5 issues shown.');
});

test('Refresh keeps the active search and status filter', async () => {
  const adapter = recordingAdapter(createMemoryAdapter({ issues: sampleIssues('default') }));
  const { root } = await mount(adapter);
  const search = byId(root, 'search');
  search.value = 'search';
  search.dispatch('input');
  await flush();
  byRole(root, 'refresh').dispatch('click');
  await flush();
  assert.deepEqual(adapter.calls.at(-1), ['list', { status: '', q: 'search' }]);
});

test('Use server values replaces the draft with what the server showed and drops the unconfirmed save', async () => {
  const original = liveIssue('u1', { title: 'Before' });
  const teammate = liveIssue('u1', { title: 'Teammate title', description: 'Their text', status: 'in_progress', updatedAt: '2026-09-25T02:00:00.000Z' });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [teammate] })],
    PATCH: [() => { throw new TypeError('network connection was lost'); }, (url, init) => jsonResponse(200, { ...teammate, ...JSON.parse(init.body) })],
  });
  const { root, doc } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'My title';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  assert.match(byRole(root, 'edit-error').textContent, /The server now shows different values, which may include a teammate’s change\. Your changes are kept here\./);
  assert.equal(byRole(root, 'edit-compare').textContent, 'Server now shows: title “Teammate title”, status In progress, description “Their text”.');
  assert.equal(byId(root, 'edit-title').value, 'My title', 'the draft is kept until the user chooses');
  byRole(root, 'edit-adopt').dispatch('click');
  assert.equal(byId(root, 'edit-title').value, 'Teammate title');
  assert.equal(byId(root, 'edit-description').value, 'Their text');
  assert.equal(byId(root, 'edit-status').value, 'in_progress');
  assert.equal(byRole(root, 'edit-adopt').hidden, true);
  assert.equal(byRole(root, 'edit-compare').hidden, true);
  assert.equal(byRole(root, 'edit-check').hidden, true);
  assert.equal(byRole(root, 'edit-error').hidden, true);
  assert.equal(byRole(root, 'edit-notice').textContent, 'The form now shows the server’s values. Your draft was dropped.');
  assert.equal(doc.activeElement, byId(root, 'edit-title'));
  // A later edit is compared with the server values, so only the new change is sent.
  byId(root, 'edit-description').value = 'Their text, plus mine';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  const patches = calls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body));
  assert.deepEqual(patches, [{ title: 'My title' }, { description: 'Their text, plus mine' }]);
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), false);
});

test('saving again after a teammate’s change sends the kept draft as an explicit replacement', async () => {
  const original = liveIssue('u2', { title: 'Before' });
  const teammate = liveIssue('u2', { title: 'Teammate title', updatedAt: '2026-09-25T02:00:00.000Z' });
  const mine = { ...teammate, title: 'My title', updatedAt: '2026-09-25T03:00:00.000Z' };
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [teammate] }), () => jsonResponse(200, { items: [teammate] }), () => jsonResponse(200, { items: [mine] })],
    PATCH: [() => { throw new TypeError('network connection was lost'); }, () => jsonResponse(200, mine)],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'My title';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  assert.equal(byRole(root, 'edit-adopt').hidden, false);
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 2, 'sent again only because the user chose Save changes');
  assert.equal(byRole(root, 'edit-dialog').hasAttribute('open'), false);
  assert.match(byRole(root, 'announcer').textContent, /Saved “My title”\./);
});

test('an unknown create that the server shows as saved warns about duplicates and keeps the text', async () => {
  const saved = liveIssue('d1', { title: 'Printer offline', description: 'Floor 3' });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [] }), () => jsonResponse(200, { items: [saved, liveIssue('d2', { title: 'Printer offline again' })] }), () => jsonResponse(200, { items: [saved] })],
    POST: [() => { throw new TypeError('network connection was lost'); }],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  byId(root, 'new-title').value = '  Printer offline ';
  byId(root, 'new-description').value = 'Floor 3';
  byRole(root, 'create-form').dispatch('submit');
  await flush(8);
  assert.equal(byRole(root, 'create-error').textContent,
    'Could not confirm whether “Printer offline” was saved: The connection to the server failed. The server now has an issue with this title and description, so it was probably saved. Creating it again would add a duplicate. Your text is kept.');
  assert.equal(byId(root, 'new-title').value, '  Printer offline ');
  assert.deepEqual(cardTitles(root, 'open'), ['Printer offline']);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('an unknown create whose duplicate check also fails says so and keeps the text', async () => {
  const { fetchImpl } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [] }), () => textResponse(502, GATEWAY_HTML), () => jsonResponse(200, { items: [] })],
    POST: [() => { throw new TypeError('network connection was lost'); }],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  byId(root, 'new-title').value = 'Maybe';
  byRole(root, 'create-form').dispatch('submit');
  await flush(8);
  assert.equal(byRole(root, 'create-error').textContent,
    'Could not confirm whether “Maybe” was saved: The connection to the server failed. The server could not be checked for it either: The server answered with an unexpected error (502). Look for it on the board before creating it again. Your text is kept.');
  assert.equal(byId(root, 'new-title').value, 'Maybe');
});

test('an unknown status change that did land says nothing more needs sending', async () => {
  const original = liveIssue('m1', { title: 'Landed' });
  const done = { ...original, status: 'done', updatedAt: '2026-09-25T01:00:00.000Z' };
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [original] }), () => jsonResponse(200, { items: [done] })],
    PATCH: [() => { throw new TypeError('network connection was lost'); }],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  const select = byRole(allByRole(root, 'card')[0], 'card-status');
  select.value = 'done';
  select.dispatch('change');
  await flush(8);
  assert.equal(byRole(root, 'action-error-text').textContent,
    'Could not confirm whether “Landed” moved to Done: The connection to the server failed. The server now shows it in Done, so nothing more needs sending.');
  assert.deepEqual(cardTitles(root, 'done'), ['Landed']);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 1);
});

test('a status change or edit on an issue deleted elsewhere says so and refreshes the board', async () => {
  const gone = liveIssue('g1', { title: 'Gone soon' });
  const notFound = () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Issue not found.' } });
  const { fetchImpl, calls } = scriptedFetch({
    GET: [() => jsonResponse(200, { items: [gone] }), () => jsonResponse(200, { items: [gone] }), () => jsonResponse(200, { items: [] })],
    PATCH: [notFound],
  });
  const { root } = await mount(createHttpAdapter({ fetchImpl }));
  allByRole(root, 'card-edit')[0].dispatch('click');
  byId(root, 'edit-title').value = 'Edited';
  byRole(root, 'edit-form').dispatch('submit');
  await flush(8);
  assert.equal(byRole(root, 'edit-error').textContent,
    'Could not save: the server no longer has this issue. Your changes are kept here so you can copy them. The board was refreshed.');
  assert.equal(byId(root, 'edit-title').value, 'Edited');
  assert.equal(calls.filter(c => c.method === 'GET').length, 2);
  byRole(root, 'edit-cancel').dispatch('click');
  const select = byRole(allByRole(root, 'card')[0], 'card-status');
  select.value = 'done';
  select.dispatch('change');
  await flush(8);
  assert.equal(byRole(root, 'action-error-text').textContent,
    'Could not change the status of “Gone soon”: the server no longer has this issue. The board was refreshed.');
  assert.equal(allByRole(root, 'card').length, 0);
});

// ---------------------------------------------------------------------------
// The board against the real server (src/server.js) with a temporary DATA_DIR
// ---------------------------------------------------------------------------
async function bootRealServer(dataDir) {
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  // Keep-alive sockets from fetch would otherwise hold the server open.
  const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  return { base, close };
}
async function until(check, label, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + label);
    await new Promise(r => setTimeout(r, 10));
  }
}

test('real server: create, edit, search, filter and move from the board, and it survives a restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'native-ui-'));
  let srv;
  try {
    srv = await bootRealServer(dataDir);
    let { root } = await mount(createHttpAdapter({ base: srv.base }));
    assert.equal(byRole(root, 'board-status').textContent, 'No issues yet. Create the first one.');

    for (const [title, description] of [['Login button broken', 'Safari only'], ['<b>Bold?</b> title', '<script>x</script>'], ['Slow search', '']]) {
      byId(root, 'new-title').value = title;
      byId(root, 'new-description').value = description;
      byRole(root, 'create-form').dispatch('submit');
      await until(() => byRole(root, 'announcer').textContent.includes(`Issue created: ${title}`), 'create ' + title);
      // The form accepts the next issue once the board has been refreshed.
      await until(() => byRole(root, 'create-form').getAttribute('aria-busy') === 'false', 'create form ready');
    }
    assert.equal(byRole(root, 'count-open').textContent, '3');
    const htmlTitle = allByRole(root, 'card-title').find(n => n.textContent === '<b>Bold?</b> title');
    assert.equal(htmlTitle.children[0].nodeType, 3, 'HTML-like text from the server is a text node');

    const loginCard = () => allByRole(root, 'card').find(c => byRole(c, 'card-title').textContent.startsWith('Login'));
    byRole(loginCard(), 'card-edit').dispatch('click');
    byId(root, 'edit-title').value = 'Login button broken on Safari';
    byId(root, 'edit-description').value = 'Safari 17 and 18';
    byRole(root, 'edit-form').dispatch('submit');
    await until(() => byRole(root, 'announcer').textContent === 'Saved “Login button broken on Safari”.', 'edit');

    const select = byRole(loginCard(), 'card-status');
    select.value = 'in_progress';
    select.dispatch('change');
    await until(() => byRole(root, 'count-in_progress').textContent === '1', 'move');

    const search = byId(root, 'search');
    search.value = 'SAFARI';
    search.dispatch('input');
    await until(() => byRole(root, 'board-status').textContent === '1 issue shown.', 'search');
    search.value = '';
    search.dispatch('input');
    await until(() => byRole(root, 'board-status').textContent === '3 issues shown.', 'clear search');
    const filter = byRole(root, 'status-filter');
    filter.value = 'in_progress';
    filter.dispatch('change');
    await until(() => allByRole(root, 'card').length === 1, 'filter');
    assert.deepEqual(cardTitles(root, 'in_progress'), ['Login button broken on Safari']);

    await srv.close();
    srv = await bootRealServer(dataDir);
    ({ root } = await mount(createHttpAdapter({ base: srv.base })));
    assert.equal(byRole(root, 'board-status').textContent, '3 issues shown.');
    assert.deepEqual(cardTitles(root, 'in_progress'), ['Login button broken on Safari']);
    const card = allByRole(root, 'card').find(c => byRole(c, 'card-title').textContent === 'Login button broken on Safari');
    assert.equal(byRole(card, 'card-description').textContent, 'Safari 17 and 18');
    assert.deepEqual(cardTitles(root, 'open').sort(), ['<b>Bold?</b> title', 'Slow search']);
  } finally {
    await srv?.close();
    resetApiStore();
    delete process.env.DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('real server: a validation error from the API keeps the draft and names the problem', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'native-ui-'));
  let srv;
  try {
    srv = await bootRealServer(dataDir);
    const api = createHttpAdapter({ base: srv.base });
    const created = await api.create({ title: 'Valid' });
    await assert.rejects(api.update(created.id, { status: 'blocked' }), e => e.code === 'VALIDATION_ERROR' && e.outcomeUnknown === false);
    await assert.rejects(api.update('no-such-id', { status: 'done' }), e => e.code === 'NOT_FOUND' && e.status === 404);
    const { root } = await mount(api);
    assert.deepEqual(cardTitles(root, 'open'), ['Valid']);
  } finally {
    await srv?.close();
    resetApiStore();
    delete process.env.DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});
