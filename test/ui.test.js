// TEST-UI: board, forms, search/filter and fixture adapter checks.
// Runs in plain Node (no browser, no dependencies) against a minimal fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DATA_MODE, STATUSES, TITLE_MAX, DESCRIPTION_MAX, ApiError,
  validateIssueInput, filterIssues, groupByStatus,
  createFixtureAdapter, createHttpAdapter, selectAdapter, fixtureIssues, mountApp, isValidIssue,
} from '../public/app.js';

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
test('fixture adapter mirrors the API contract and returns copies', async () => {
  const adapter = createFixtureAdapter({ issues: [], now: fixedClock(), makeId: seqIds() });
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
  const failing = createFixtureAdapter({ issues: [], failures: { list: 1 } });
  await assert.rejects(failing.list(), e => e.code === 'FIXTURE_FAILURE');
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
  await assert.rejects(otherIssue.update('n', { status: 'done' }), e => e.code === 'INVALID_RESPONSE', 'update must return the issue that was changed');
});

test('fixture mode is explicit and replaceable; no silent fallback', () => {
  assert.equal(DATA_MODE, 'fixture');
  assert.equal(selectAdapter('fixture', { search: '?fixture=empty' }).scenario, 'empty');
  assert.equal(selectAdapter('fixture', { search: '?fixture=unknown' }).scenario, 'default');
  assert.equal(selectAdapter('api', { fetchImpl: async () => ({}) }).mode, 'api');
});

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------
test('board shows three columns, counts, loading state and the fixture banner', async () => {
  const gate = deferred();
  const inner = createFixtureAdapter({ issues: fixtureIssues('default') });
  const adapter = { mode: 'fixture', list: async a => { await gate.promise; return inner.list(a); }, create: inner.create, update: inner.update };
  const doc = fakeDocument();
  const root = doc.createElement('main');
  const app = mountApp(root, { adapter, doc, searchDelayMs: 0 });
  assert.equal(byRole(root, 'board').getAttribute('aria-busy'), 'true');
  assert.equal(byRole(root, 'board-status').textContent, 'Loading issues…');
  gate.resolve();
  await app.ready;
  assert.equal(byRole(root, 'board').getAttribute('aria-busy'), 'false');
  assert.ok(byRole(root, 'fixture-banner').textContent.includes('Demo data'));
  assert.equal(byRole(root, 'count-open').textContent, '2');
  assert.equal(byRole(root, 'count-in_progress').textContent, '1');
  assert.equal(byRole(root, 'count-done').textContent, '1');
  assert.deepEqual(cardTitles(root, 'open'), ['Add keyboard access to the edit dialog', 'Board columns collapse on narrow screens']);
  assert.equal(byRole(root, 'empty-open').hidden, true);
  assert.equal(byRole(root, 'board-status').textContent, '4 issues shown.');
});

test('empty board shows per-column empty states', async () => {
  const { root } = await mount(createFixtureAdapter({ issues: [] }));
  for (const status of STATUSES) {
    assert.equal(byRole(root, `empty-${status}`).hidden, false);
    assert.equal(byRole(root, `count-${status}`).textContent, '0');
  }
  assert.equal(byRole(root, 'board-status').textContent, 'No issues yet. Create the first one.');
});

test('HTML-like issue text is rendered as text, never as markup', async () => {
  const { root } = await mount(createFixtureAdapter({ issues: fixtureIssues('html') }));
  const title = allByRole(root, 'card-title').find(n => n.textContent.startsWith('<img'));
  assert.ok(title, 'html fixture rendered');
  assert.equal(title.children.length, 1);
  assert.equal(title.children[0].nodeType, 3, 'title is a single text node');
  assert.equal(title.textContent, '<img src=x onerror="alert(1)"> rendered as text');
  assert.ok(![...walk(root)].some(n => n.tagName === 'IMG' || n.tagName === 'SCRIPT'));
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('load failure shows a recoverable error with Retry', async () => {
  const { root } = await mount(createFixtureAdapter({ issues: fixtureIssues('default'), failures: { list: 1 } }));
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
  const inner = createFixtureAdapter({ issues: [] });
  const gate = deferred();
  const calls = [];
  const adapter = { mode: 'fixture', list: inner.list, update: inner.update, create: async input => { calls.push(input); await gate.promise; return inner.create(input); } };
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
  const inner = createFixtureAdapter({ issues: [] });
  const gate = deferred();
  const calls = [];
  const order = [];
  const adapter = {
    mode: 'fixture', list: inner.list, update: inner.update,
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
  const inner = createFixtureAdapter({ issues: [] });
  const gate = deferred();
  const adapter = { mode: 'fixture', list: inner.list, update: inner.update, create: async input => { await gate.promise; return inner.create(input); } };
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
  const inner = createFixtureAdapter({ issues: [] });
  const gate = deferred();
  const adapter = { mode: 'fixture', list: inner.list, update: inner.update, create: async () => { await gate.promise; throw new ApiError('HTTP_503', 'Service unavailable.', 503); } };
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
  const adapter = recordingAdapter(createFixtureAdapter({ issues: [], failures: { create: 1 } }));
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
  const adapter = createFixtureAdapter({ issues: fixtureIssues('default'), failures: { update: 1 } });
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
  const adapter = recordingAdapter(createFixtureAdapter({ issues: fixtureIssues('default') }));
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
  const { root } = await mount(createFixtureAdapter({ issues: fixtureIssues('default'), failures: { update: 1 } }));
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
  const adapter = recordingAdapter(createFixtureAdapter({ issues: fixtureIssues('default') }));
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
  const inner = createFixtureAdapter({ issues: fixtureIssues('default') });
  const adapter = { mode: 'fixture', create: inner.create, update: inner.update, list: async a => { const g = deferred(); gates.push(g); await g.promise; return inner.list(a); } };
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
    GET: [() => jsonResponse(200, { items: [] }), () => jsonResponse(200, { items: [] }), () => jsonResponse(200, { items: [saved] })],
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
  assert.match(error.textContent, /Could not confirm whether “Keep me” was saved: The server sent a response the board could not read\. Your text is kept\. Check the board for it before creating it again\./);
  assert.doesNotMatch(error.textContent, /was not saved/, 'an unknown outcome is never stated as not saved');
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Issue created/);
  assert.equal(title.value, 'Keep me');
  assert.equal(description.value, 'and me');
  assert.equal(calls.filter(c => c.method === 'GET').length, 2, 'the board is reloaded so the user can check');

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
  assert.match(byRole(root, 'edit-error').textContent, /Could not confirm whether your changes were saved: The server sent a response the board could not read\. Your changes are kept here\./);
  assert.doesNotMatch(byRole(root, 'announcer').textContent, /Saved/);
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
  assert.equal(calls.filter(c => c.method === 'GET').length, 2);
});
