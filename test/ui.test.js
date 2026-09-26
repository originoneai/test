// TEST-UI: board, forms, search/filter and fixture adapter checks.
// Runs in plain Node (no browser, no dependencies) against a minimal fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DATA_MODE, STATUSES, TITLE_MAX, DESCRIPTION_MAX, ApiError,
  validateIssueInput, filterIssues, groupByStatus,
  createFixtureAdapter, createHttpAdapter, selectAdapter, fixtureIssues, mountApp,
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

test('HTTP adapter uses the contract endpoints and surfaces error bodies', async () => {
  const requests = [];
  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body, type: init.headers['content-type'] });
    if (url.startsWith('/api/issues?')) return respond(200, { items: [{ id: '1' }] });
    if (init.method === 'POST') return respond(201, { id: '2', ...JSON.parse(init.body) });
    if (url === '/api/issues/a%2Fb') return respond(404, { error: { code: 'NOT_FOUND', message: 'Issue not found.' } });
    return respond(500, null);
  };
  const api = createHttpAdapter({ fetchImpl });
  assert.equal(api.mode, 'api');
  assert.deepEqual(await api.list({ status: 'open', q: 'a b' }), [{ id: '1' }]);
  assert.equal(requests[0].url, '/api/issues?status=open&q=a+b');
  assert.equal((await api.create({ title: 'T' })).title, 'T');
  assert.equal(requests[1].type, 'application/json');
  await assert.rejects(api.update('a/b', { status: 'done' }), e => e.code === 'NOT_FOUND' && e.status === 404 && e.message === 'Issue not found.');
  await assert.rejects(api.update('x', { status: 'done' }), e => e.code === 'HTTP_500');
  const offline = createHttpAdapter({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.list(), e => e.code === 'NETWORK_ERROR');
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

// Regression for review round 1 (01M3CHMZKZ2ZXSPM83GPKTH8V0): on a slow save the
// user typed the next draft while waiting, and the first save's success cleared it.
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
