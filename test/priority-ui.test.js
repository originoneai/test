// Frontend coverage for issue priority at the board module's public surface:
// form validation, the shape of a confirmed create, save-confirmation
// strictness, the live HTTP adapter, and the mounted board itself (create and
// edit priority controls with the Normal default, readable card badges, and a
// priority filter composing with status and search). Every check relies only
// on exports and mounted-DOM hooks the board module already provides; a
// failing mounted check identifies priority behavior the mounted board does
// not provide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';
import {
  ApiError, confirmSaved, createHttpAdapter, expectedCreate, isValidIssue,
  matchesSubmitted, mountApp, validateIssueInput,
} from '../public/app.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// ---------------------------------------------------------------------------
// Module-boundary checks
// ---------------------------------------------------------------------------

test('form validation accepts the four priorities, carries them in the value and rejects others', () => {
  for (const priority of PRIORITIES) {
    const { errors, value } = validateIssueInput({ title: 'T', description: 'd', priority });
    assert.deepEqual(errors, {}, 'accepted on create: ' + priority);
    assert.equal(value.priority, priority, 'the validated create value keeps the chosen priority: ' + priority);
  }

  const partial = validateIssueInput({ priority: 'urgent' }, { partial: true });
  assert.deepEqual(partial.errors, {}, 'an edit may change priority alone');
  assert.equal(partial.value.priority, 'urgent', 'a priority-only edit keeps the field in the value it returns');

  for (const bad of ['critical', 'HIGH', '', null, 3]) {
    const { errors } = validateIssueInput({ title: 'T', priority: bad });
    assert.ok(Object.keys(errors).includes('priority'), 'rejected: ' + JSON.stringify(bad));
  }
});

test('a confirmed create must show the submitted priority and the normal default', () => {
  assert.deepEqual(
    expectedCreate({ title: ' T ', priority: 'high' }),
    { title: 'T', description: '', status: 'open', priority: 'high' },
    'the submitted priority travels with a create',
  );
  assert.equal(expectedCreate({ title: 'T' }).priority, 'normal', 'an omitted priority defaults to normal');
});

test('save confirmation is strict about the submitted priority', () => {
  const saved = {
    id: 'prio-ui-0001', title: 'Strict', description: '', status: 'open',
    priority: 'urgent', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  };
  assert.equal(isValidIssue(saved), true, 'a served record carrying priority stays readable');
  assert.equal(matchesSubmitted(saved, { priority: 'urgent' }), true, 'a matching priority confirms the save');
  assert.equal(
    matchesSubmitted(saved, { priority: 'low' }),
    false,
    'a reply showing a different priority must not count as saved',
  );
  assert.throws(
    () => confirmSaved(saved, { priority: 'low' }),
    (err) => err instanceof ApiError && err.code === 'UNCONFIRMED_RESULT' && err.outcomeUnknown === true,
    'a save whose echo shows another priority keeps an unknown outcome',
  );
});

// ---------------------------------------------------------------------------
// Live HTTP adapter against the real API server
// ---------------------------------------------------------------------------

async function withLiveServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'priority-ui-'));
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const adapter = createHttpAdapter({ base: 'http://127.0.0.1:' + server.address().port });
    await run(adapter);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(dataDir, { recursive: true, force: true });
    resetApiStore();
    delete process.env.DATA_DIR;
  }
}

test('the adapter forwards the priority filter, composed with search', async () => {
  await withLiveServer(async (adapter) => {
    await adapter.create({ title: 'Needle low', description: 'shared text', priority: 'low' });
    await adapter.create({ title: 'Needle high', description: 'shared text', priority: 'high' });

    const onlyHigh = await adapter.list({ priority: 'high' });
    assert.deepEqual(
      onlyHigh.map((issue) => issue.title),
      ['Needle high'],
      'the priority filter must reach the server',
    );

    const composed = await adapter.list({ priority: 'low', q: 'shared' });
    assert.deepEqual(
      composed.map((issue) => issue.title),
      ['Needle low'],
      'the priority filter must compose with q',
    );
  });
});

test('the adapter round-trips priority on create and edit and reports definite rejections', async () => {
  await withLiveServer(async (adapter) => {
    const created = await adapter.create({ title: 'Priority create', priority: 'urgent' });
    assert.equal(created.priority, 'urgent', 'the created record echoes the submitted priority');

    const edited = await adapter.update(created.id, { priority: 'low' });
    assert.equal(edited.priority, 'low', 'the edited record echoes the new priority');

    await assert.rejects(
      adapter.create({ title: 'Bad priority', priority: 'critical' }),
      (err) => err instanceof ApiError && err.code === 'VALIDATION_ERROR' && err.status === 400 && err.outcomeUnknown === false,
      'an invalid priority is a definite rejection, not an unknown outcome',
    );
  });
});

// ---------------------------------------------------------------------------
// Mounted board: minimal fake DOM (text stays data, like real textContent)
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
  // Selects behave like the platform: an untouched select shows the option
  // marked selected (attribute or property) or defaultSelected (property) or,
  // failing that, its first eligible option — disabled options and options
  // inside a disabled optgroup are skipped; a set value wins until changed.
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const options = elementsOf(this).filter((el) => el.tagName === 'OPTION');
      const marked = options.find((el) => el.getAttribute('selected') !== null
        || el.selected === true || el.defaultSelected === true);
      const eligible = options.filter((el) => el.disabled !== true
        && !(el.parentNode && el.parentNode.tagName === 'OPTGROUP' && el.parentNode.disabled === true));
      const shown = marked ?? eligible[0];
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

const byRole = (root, role) => elementsOf(root).filter((el) => el.getAttribute('data-role') === role);

const optionValues = (select) =>
  elementsOf(select).filter((el) => el.tagName === 'OPTION').map((el) => el.getAttribute('value') ?? el.textContent);

const isPrioritySelect = (select) => {
  const values = optionValues(select);
  return PRIORITIES.every((priority) => values.includes(priority));
};

// A priority control is found by what it offers (the four documented values),
// not by an id or role, so these checks do not depend on markup details.
function prioritySelectIn(container) {
  return elementsOf(container).find((el) => el.tagName === 'SELECT' && isPrioritySelect(el)) ?? null;
}

// The contract fixes the supported values, not their presentation order. The
// raw option values are compared as a sorted multiset against the exact
// allowed set, so duplicated or extra options (including stray empty ones)
// fail; a filter control may additionally offer exactly one empty "all"
// option.
function assertControlOptions(control, { allowAllOption = false } = {}) {
  const expected = [...(allowAllOption ? [''] : []), ...PRIORITIES].sort();
  assert.deepEqual(
    [...optionValues(control)].sort(),
    expected,
    allowAllOption
      ? 'the filter offers exactly one empty option plus the four priorities, in any order'
      : 'the control offers exactly the four priorities, in any order',
  );
}

function accessibleName(el, root) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const id = el.getAttribute('id');
  if (!id) return '';
  const label = elementsOf(root).find((el2) => el2.tagName === 'LABEL' && el2.getAttribute('for') === id);
  return label ? label.textContent.trim() : '';
}

// A recording adapter with the same list/create/update surface as the live
// adapter; it filters like the API and records every call, so mounted-form
// checks can prove what the board actually sent.
function recordingAdapter(issues) {
  const store = new Map(issues.map((issue) => [issue.id, { ...issue }]));
  const calls = { list: [], create: [], update: [] };
  const copy = (issue) => ({ ...issue });
  return {
    mode: 'recording', calls,
    async list(filters = {}) {
      calls.list.push({ ...filters });
      const needle = String(filters.q || '').toLowerCase();
      return [...store.values()]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .filter((issue) => (!filters.status || issue.status === filters.status)
          && (!filters.priority || issue.priority === filters.priority)
          && (!needle || issue.title.toLowerCase().includes(needle)
            || (issue.description || '').toLowerCase().includes(needle)))
        .map(copy);
    },
    async create(input) {
      calls.create.push({ ...input });
      const stamp = '2026-09-28T12:00:00.000Z';
      const issue = {
        id: 'prio-ui-created-' + calls.create.length, title: String(input.title).trim(),
        description: input.description ?? '', status: 'open', priority: input.priority ?? 'normal',
        createdAt: stamp, updatedAt: stamp,
      };
      store.set(issue.id, issue);
      return copy(issue);
    },
    async update(id, patch) {
      calls.update.push({ id, patch: { ...patch } });
      const issue = store.get(id);
      if (!issue) throw new Error('unknown id ' + id);
      const next = { ...issue, ...patch, updatedAt: '2026-09-28T12:00:01.000Z' };
      store.set(id, next);
      return copy(next);
    },
  };
}

// Seven-field records whose titles avoid priority words, so a priority word
// found on a card can only come from the card's priority badge. One title is
// markup-like to prove card text renders as text.
function boardIssues() {
  return [
    { id: 'prio-ui-0010', title: 'Printer keeps jamming', description: '', status: 'open', priority: 'urgent', createdAt: '2026-09-28T09:00:00.000Z', updatedAt: '2026-09-28T09:00:00.000Z' },
    { id: 'prio-ui-0011', title: 'Slight wording <img src=x onerror=alert(1)> snag', description: '', status: 'in_progress', priority: 'low', createdAt: '2026-09-28T08:00:00.000Z', updatedAt: '2026-09-28T08:00:00.000Z' },
    { id: 'prio-ui-0012', title: 'Login needle broken', description: 'shared text', status: 'open', priority: 'high', createdAt: '2026-09-28T07:00:00.000Z', updatedAt: '2026-09-28T07:00:00.000Z' },
    { id: 'prio-ui-0013', title: 'Cosmetic padding tweak', description: '', status: 'done', priority: 'normal', createdAt: '2026-09-28T06:00:00.000Z', updatedAt: '2026-09-28T06:00:00.000Z' },
  ];
}

async function mountBoard({ issues = [], searchDelayMs = 0 } = {}) {
  const doc = new FakeDocument();
  const root = new FakeElement(doc, 'div');
  doc.root = root;
  const adapter = recordingAdapter(issues);
  const app = mountApp(root, { adapter, doc, searchDelayMs });
  await app.ready;
  return { doc, root, adapter, app };
}

test('fake-DOM select values follow platform default rules (harness sanity)', () => {
  const doc = new FakeDocument();
  const select = doc.createElement('select');
  const low = doc.createElement('option'); low.setAttribute('value', 'low');
  const normal = doc.createElement('option'); normal.setAttribute('value', 'normal'); normal.setAttribute('selected', '');
  const urgent = doc.createElement('option'); urgent.setAttribute('value', 'urgent');
  select.append(low, normal, urgent);
  assert.equal(select.value, 'normal', 'an untouched select shows its selected option');
  select.value = 'urgent';
  assert.equal(select.value, 'urgent', 'a programmatically set value wins');
  const marked = doc.createElement('option'); marked.setAttribute('value', 'high'); marked.selected = true;
  const untouched = doc.createElement('select');
  untouched.append(marked);
  assert.equal(untouched.value, 'high', 'an option marked via the selected property also drives the value');
  const propDefault = doc.createElement('option'); propDefault.setAttribute('value', 'low'); propDefault.defaultSelected = true;
  const byDefault = doc.createElement('select');
  byDefault.append(propDefault);
  assert.equal(byDefault.value, 'low', 'an option marked via the defaultSelected property also drives the value');
  const plain = doc.createElement('select');
  const first = doc.createElement('option'); first.setAttribute('value', 'low');
  const second = doc.createElement('option'); second.setAttribute('value', 'high');
  plain.append(first, second);
  assert.equal(plain.value, 'low', 'with no marked option, a select shows its first option');
  const withDisabled = doc.createElement('select');
  const off = doc.createElement('option'); off.setAttribute('value', 'low'); off.disabled = true;
  const on = doc.createElement('option'); on.setAttribute('value', 'high');
  withDisabled.append(off, on);
  assert.equal(withDisabled.value, 'high', 'the fallback skips disabled options');
});

test('the mounted create form offers a labelled priority control defaulting to Normal and sends the choice', async () => {
  const board = await mountBoard({ issues: boardIssues() });
  const form = byRole(board.root, 'create-form')[0];
  assert.ok(form, 'the board mounts a create form');

  const control = prioritySelectIn(form);
  assert.ok(control, 'the create form must offer a priority control with the four values low, normal, high and urgent');
  assertControlOptions(control, { allowAllOption: false });
  assert.equal(control.value, 'normal', 'a new issue defaults to Normal priority');
  const name = accessibleName(control, board.root);
  assert.ok(name && /priority/i.test(name), 'the create priority control has a readable accessible name: ' + JSON.stringify(name));

  const title = elementsOf(form).find((el) => el.getAttribute('id') === 'new-title');
  title.value = '  Mounted create  ';
  control.value = 'urgent';
  await form.dispatch('submit');

  assert.equal(board.adapter.calls.create.length, 1, 'submitting the form creates exactly one issue');
  assert.deepEqual(
    board.adapter.calls.create[0],
    { title: 'Mounted create', description: '', priority: 'urgent' },
    'the chosen priority reaches adapter.create with the trimmed title',
  );
});

test('mounted cards show a readable badge for every priority, rendering text safely', async () => {
  const board = await mountBoard({ issues: boardIssues() });
  const issues = boardIssues();
  const cardOf = (issue) => byRole(board.root, 'card').find((el) => el.getAttribute('data-issue-id') === issue.id);
  const urgentCard = cardOf(issues[0]);
  const lowCard = cardOf(issues[1]);
  const highCard = cardOf(issues[2]);
  const normalCard = cardOf(issues[3]);
  assert.ok(urgentCard && lowCard && highCard && normalCard, 'every listed issue renders a card');

  // The titles avoid priority words, so these matches can only come from the
  // card's priority badge, which must be readable for every value including
  // the Normal default.
  assert.match(urgentCard.textContent, /\burgent\b/i, 'an urgent issue shows its priority on the card');
  assert.match(highCard.textContent, /\bhigh\b/i, 'a high issue shows its priority on the card');
  assert.match(lowCard.textContent, /\blow\b/i, 'a low issue shows its priority on the card');
  assert.match(normalCard.textContent, /\bnormal\b/i, 'a normal issue shows its priority on the card too');

  assert.ok(
    lowCard.textContent.includes('<img src=x onerror=alert(1)>'),
    'markup-like text on a card renders as text, never as markup',
  );
});

test('the mounted toolbar priority filter composes with status and search', async () => {
  const board = await mountBoard({ issues: boardIssues() });
  const toolbar = elementsOf(board.root).find((el) => el.getAttribute('role') === 'search');
  assert.ok(toolbar, 'the board mounts a filter toolbar');

  const control = prioritySelectIn(toolbar);
  assert.ok(control, 'the toolbar must offer a priority filter with the four values');
  assertControlOptions(control, { allowAllOption: true });
  const name = accessibleName(control, board.root);
  assert.ok(name && /priority/i.test(name), 'the priority filter has a readable accessible name: ' + JSON.stringify(name));

  // What the board renders must follow the filter, not merely mention it in
  // the request: after each load settles, exactly the matching cards are on
  // the board and every excluded card is absent.
  const renderedIds = () => byRole(board.root, 'card').map((el) => el.getAttribute('data-issue-id'));

  control.value = 'high';
  await control.dispatch('change');
  assert.equal(board.adapter.calls.list.at(-1).priority, 'high', 'choosing a priority asks the server for that priority only');
  assert.deepEqual(renderedIds(), ['prio-ui-0012'], 'a priority-only filter renders exactly the high-priority card');

  const search = elementsOf(toolbar).find((el) => el.getAttribute('id') === 'search');
  const status = elementsOf(toolbar).find((el) => el.getAttribute('id') === 'status-filter');
  status.value = 'open';
  await status.dispatch('change');
  search.value = 'needle';
  await search.dispatch('input');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const composed = board.adapter.calls.list.at(-1);
  assert.deepEqual(
    { status: composed.status, priority: composed.priority, q: composed.q },
    { status: 'open', priority: 'high', q: 'needle' },
    'the priority filter composes with status and search in one server query',
  );
  assert.deepEqual(renderedIds(), ['prio-ui-0012'], 'the composed filter renders exactly the one matching card');
});

test('the mounted edit dialog seeds a priority control with the current value and sends only the change', async () => {
  const board = await mountBoard({ issues: boardIssues() });
  const issue = boardIssues()[1];

  const editButton = byRole(board.root, 'card-edit').find((el) => el.getAttribute('data-issue-id') === issue.id);
  assert.ok(editButton, 'cards expose their edit button');
  await editButton.dispatch('click');

  const dialog = byRole(board.root, 'edit-dialog')[0];
  assert.ok(dialog, 'the edit dialog opens');
  const control = prioritySelectIn(dialog);
  assert.ok(control, 'the edit dialog must offer a priority control with the four values');
  assertControlOptions(control, { allowAllOption: false });
  assert.equal(control.value, issue.priority, "the edit control is seeded with the issue's current priority");
  const name = accessibleName(control, board.root);
  assert.ok(name && /priority/i.test(name), 'the edit priority control has a readable accessible name: ' + JSON.stringify(name));

  control.value = 'urgent';
  await byRole(board.root, 'edit-form')[0].dispatch('submit');

  assert.equal(board.adapter.calls.update.length, 1, 'saving a changed priority updates the issue once');
  assert.deepEqual(
    board.adapter.calls.update[0].patch,
    { priority: 'urgent' },
    'a priority-only edit sends exactly the changed priority',
  );
});

process.on('exit', () => {
  resetApiStore();
  delete process.env.DATA_DIR;
});
