// UI tests for the historical import panel (public/csv-import.js): select a
// file, preview every row, cancel without writes, confirm a valid batch only,
// and recover from an unknown outcome with the same import key. Uses a small
// fake DOM and a scripted client; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountImportPanel } from '../public/csv-import.js';

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    this.value = '';
    this.files = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  get hidden() {
    return 'hidden' in this.attributes;
  }
  set hidden(on) {
    if (on) this.attributes.hidden = '';
    else delete this.attributes.hidden;
  }
  get disabled() {
    return 'disabled' in this.attributes;
  }
  set disabled(on) {
    if (on) this.attributes.disabled = '';
    else delete this.attributes.disabled;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  set textContent(text) {
    this._text = String(text);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  async fire(type) {
    for (const fn of this.listeners[type] || []) await fn();
  }
  all(predicate, out = []) {
    for (const child of this.children) {
      if (predicate(child)) out.push(child);
      child.all(predicate, out);
    }
    return out;
  }
  role(name) {
    return this.all((node) => node.attributes['data-role'] === name);
  }
}

const doc = { createElement: (tag) => new FakeElement(tag) };
const encoder = new TextEncoder();
const fakeFile = (name, text) => {
  const bytes = encoder.encode(text);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
};

function setup(responses = []) {
  const calls = [];
  const client = {
    commit: async (importKey, csv) => {
      calls.push({ kind: 'commit', importKey, csv });
      return responses.shift();
    },
    lookup: async (importKey) => {
      calls.push({ kind: 'lookup', importKey });
      return responses.shift();
    },
  };
  const imported = [];
  const root = new FakeElement('main');
  mountImportPanel(root, { client, doc, onImported: (record) => imported.push(record) });
  const one = (name) => root.role(name)[0];
  const choose = async (name, text) => {
    one('import-file').files = [fakeFile(name, text)];
    await one('import-file').fire('change');
  };
  return { root, one, choose, calls, imported };
}

const VALID = '\uFEFFtitle,description,status,priority\r\n中文标题,"带逗号, 和\r\n换行",done,urgent\r\nSecond,,,\r\n';
const okResponse = (count, replayed = false) => ({
  outcome: 'ok',
  status: replayed ? 200 : 201,
  body: { import: { importKey: 'k', status: 'committed', createdAt: 't', issueCount: count, issueIds: [] }, replayed },
});

test('choosing a valid file previews every row and enables confirm; nothing is sent yet', async () => {
  const ui = setup();
  await ui.choose('history.csv', VALID);
  const rows = ui.root.role('import-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /中文标题/);
  assert.match(rows[0].textContent, /带逗号, 和\n换行/);
  assert.match(rows[1].textContent, /Secondopennormal/);
  assert.equal(ui.one('import-confirm').disabled, false);
  assert.equal(ui.one('import-confirm').textContent, 'Import 2 issues');
  assert.equal(ui.calls.length, 0);
});

test('a file with row errors shows them, marks the rows and cannot be confirmed', async () => {
  const ui = setup();
  await ui.choose('bad.csv', 'title,priority\nOk,low\n,low\nX,critical\n');
  assert.equal(ui.one('import-confirm').disabled, true);
  const errors = ui.one('import-errors');
  assert.equal(errors.hidden, false);
  assert.match(errors.textContent, /Line 3: title is required/);
  assert.match(errors.textContent, /Line 4: priority "critical"/);
  assert.equal(ui.root.all((n) => n.attributes.class === 'has-error').length, 2);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 0);
});

test('unsupported columns and non-UTF-8 files are refused before any preview', async () => {
  const ui = setup();
  await ui.choose('secret.csv', 'title,password\nA,b\n');
  assert.match(ui.one('import-errors').textContent, /Unsupported column/);
  assert.equal(ui.root.role('import-row').length, 0);
  ui.one('import-file').files = [{ name: 'latin1.csv', size: 3, arrayBuffer: async () => new Uint8Array([0x74, 0xe9, 0x0a]).buffer }];
  await ui.one('import-file').fire('change');
  assert.match(ui.one('import-errors').textContent, /not valid UTF-8/);
  assert.equal(ui.one('import-confirm').disabled, true);
});

test('cancel clears the preview without sending anything', async () => {
  const ui = setup();
  await ui.choose('history.csv', VALID);
  await ui.one('import-cancel').fire('click');
  assert.equal(ui.root.role('import-row').length, 0);
  assert.equal(ui.one('import-confirm').disabled, true);
  assert.match(ui.one('import-status').textContent, /cancelled. Nothing was saved/);
  assert.equal(ui.calls.length, 0);
});

test('confirm sends the exact file text once and reports the committed result', async () => {
  const ui = setup([okResponse(2)]);
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].csv, VALID.slice(1)); // the UTF-8 decoder drops the BOM; the parser accepts either
  assert.match(ui.calls[0].importKey, /^[0-9a-f-]{36}$/);
  assert.match(ui.one('import-status').textContent, /Imported 2 issues from history.csv/);
  assert.equal(ui.imported.length, 1);
  assert.equal(ui.one('import-confirm').disabled, true);
});

test('an unknown outcome keeps the same import key for retry and lookup', async () => {
  const ui = setup([{ outcome: 'unknown' }, { outcome: 'ok', ...okResponse(2, true) }]);
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  assert.match(ui.one('import-errors').textContent, /could not be confirmed/);
  assert.equal(ui.one('import-check').hidden, false);
  assert.equal(ui.one('import-confirm').disabled, false);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls[1].importKey, ui.calls[0].importKey);
  assert.match(ui.one('import-status').textContent, /Already imported earlier/);
});

test('check result looks up the same key; not found allows importing', async () => {
  const ui = setup([{ outcome: 'unknown' }, { outcome: 'rejected', status: 404, body: { error: { code: 'IMPORT_NOT_FOUND', message: 'x' } } }]);
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  await ui.one('import-check').fire('click');
  assert.equal(ui.calls[1].kind, 'lookup');
  assert.equal(ui.calls[1].importKey, ui.calls[0].importKey);
  assert.match(ui.one('import-status').textContent, /Not imported yet/);
  assert.equal(ui.one('import-confirm').disabled, false);
});

test('a server rejection shows its row errors and saves nothing', async () => {
  const ui = setup([{ outcome: 'rejected', status: 400, body: { error: { code: 'IMPORT_INVALID', message: 'The file cannot be imported; nothing was saved.', details: { fileErrors: [], rowErrors: [{ line: 2, errors: ['title is required.'] }] } } } }]);
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  assert.match(ui.one('import-errors').textContent, /Line 2: title is required/);
  assert.equal(ui.imported.length, 0);
  assert.equal(ui.one('import-confirm').disabled, true);
});

test('choosing a new file starts a new import with a new key', async () => {
  const ui = setup([okResponse(2), okResponse(2)]);
  await ui.choose('a.csv', VALID);
  await ui.one('import-confirm').fire('click');
  await ui.choose('a.csv', VALID);
  await ui.one('import-confirm').fire('click');
  assert.notEqual(ui.calls[0].importKey, ui.calls[1].importKey);
});
