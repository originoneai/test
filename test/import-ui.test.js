// UI tests for the historical import panel (public/csv-import.js): select a
// file, preview every row, cancel without writes, confirm a valid batch only,
// and recover from an unknown outcome with the same import key. Uses a small
// fake DOM and a scripted client; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as csvImport from '../public/csv-import.js';
const { mountImportPanel, createPendingImportStore } = csvImport;

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
const bytesOf = (text) => {
  const bytes = encoder.encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
};

const sharedStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

function setup(responses = [], { storage } = {}) {
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
  mountImportPanel(root, {
    client,
    doc,
    onImported: (record) => imported.push(record),
    pendingStore: storage === undefined ? undefined : createPendingImportStore(() => storage),
  });
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
  assert.match(ui.one('import-status').textContent, /Import cancelled\. Nothing was sent\./);
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

test('check result looks up the same key; a 404 stays unconfirmed and keeps checking available', async () => {
  const ui = setup([{ outcome: 'unknown' }, { outcome: 'rejected', status: 404, body: { error: { code: 'IMPORT_NOT_FOUND', message: 'x' } } }], { storage: sharedStorage() });
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  await ui.one('import-check').fire('click');
  assert.equal(ui.calls[1].kind, 'lookup');
  assert.equal(ui.calls[1].importKey, ui.calls[0].importKey);
  assert.match(ui.one('import-status').textContent, /not confirmed yet/i);
  assert.doesNotMatch(ui.one('import-errors').textContent, /was not saved/i);
  assert.equal(ui.one('import-check').hidden, false);
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

test('cancelling after an unknown outcome keeps the unconfirmed import checkable', async () => {
  const notFound = { outcome: 'rejected', status: 404, body: { error: { code: 'IMPORT_NOT_FOUND', message: 'x' } } };
  const ui = setup([{ outcome: 'unknown' }, notFound], { storage: sharedStorage() });
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  await ui.one('import-cancel').fire('click');
  assert.doesNotMatch(ui.one('import-status').textContent, /Nothing was saved/);
  assert.match(ui.one('import-status').textContent, /still unknown|unconfirmed/i);
  const recovery = ui.one('import-recovery');
  assert.equal(recovery.hidden, false);
  assert.match(recovery.textContent, /history\.csv/);
  await ui.one('import-recovery-check').fire('click');
  assert.equal(ui.calls[1].kind, 'lookup');
  assert.equal(ui.calls[1].importKey, ui.calls[0].importKey);
  assert.match(ui.one('import-status').textContent, /still not confirmed/i); // a 404 proves nothing
  assert.equal(ui.one('import-recovery').hidden, false); // and erases nothing
});

test('a reload can still check an unconfirmed import from the persisted list', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('history.csv', VALID);
  await first.one('import-confirm').fire('click');
  const key = first.calls[0].importKey;
  const second = setup([{ outcome: 'ok', ...okResponse(2, true) }], { storage });
  const recovery = second.one('import-recovery');
  assert.equal(recovery.hidden, false);
  assert.match(recovery.textContent, /history\.csv/);
  await second.one('import-recovery-check').fire('click');
  assert.equal(second.calls[0].importKey, key);
  assert.equal(second.imported.length, 1);
  assert.match(second.one('import-status').textContent, /confirmed imported/);
  assert.equal(second.one('import-recovery').hidden, true);
});

test('a later successful import does not erase an older unconfirmed one', async () => {
  const ui = setup(
    [{ outcome: 'unknown' }, okResponse(2), { outcome: 'rejected', status: 404, body: { error: { code: 'IMPORT_NOT_FOUND', message: 'x' } } }],
    { storage: sharedStorage() },
  );
  await ui.choose('old.csv', VALID);
  await ui.one('import-confirm').fire('click');
  const oldKey = ui.calls[0].importKey;
  await ui.choose('new.csv', VALID + 'Extra,,,\n');
  await ui.one('import-confirm').fire('click');
  assert.match(ui.one('import-status').textContent, /Imported 2 issues from new\.csv/);
  await ui.one('import-recovery-check').fire('click');
  assert.equal(ui.calls[2].kind, 'lookup');
  assert.equal(ui.calls[2].importKey, oldKey);
  assert.match(ui.one('import-status').textContent, /still not confirmed/i);
  assert.equal(ui.one('import-recovery').hidden, false);
});

test('when the pending list cannot be stored the panel says so and still imports', async () => {
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  const ui = setup([okResponse(2)], { storage: blocked });
  assert.equal(ui.one('import-recovery').hidden, false);
  assert.match(ui.one('import-recovery').textContent, /unavailable/i);
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  assert.match(ui.one('import-status').textContent, /Imported 2 issues from history\.csv/);
  assert.equal(ui.imported.length, 1);
});

test('re-choosing the same unconfirmed file reuses its import key instead of minting a new one', async () => {
  const ui = setup([{ outcome: 'unknown' }, { outcome: 'ok', ...okResponse(2, true) }], { storage: sharedStorage() });
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  const firstKey = ui.calls[0].importKey;
  await ui.one('import-cancel').fire('click');
  await ui.choose('history.csv', VALID);
  assert.equal(ui.calls.length, 1); // re-choosing alone never sends anything
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls[1].importKey, firstKey); // the same id, so the server cannot apply it twice
});

test('after a reload, reselecting the same unconfirmed file reuses its key and replays', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('history.csv', VALID);
  await first.one('import-confirm').fire('click');
  const key = first.calls[0].importKey;
  const second = setup([{ outcome: 'ok', ...okResponse(2, true) }], { storage });
  await second.choose('history.csv', VALID); // the exact same content on a fresh page
  await second.one('import-confirm').fire('click');
  assert.equal(second.calls[0].importKey, key); // the persisted fingerprint reuses the id
  assert.match(second.one('import-status').textContent, /Already imported earlier/);
});

test('changed content mints a new key while the older unconfirmed import stays pending', async () => {
  const ui = setup([{ outcome: 'unknown' }, { outcome: 'unknown' }], { storage: sharedStorage() });
  await ui.choose('a.csv', VALID);
  await ui.one('import-confirm').fire('click');
  const firstKey = ui.calls[0].importKey;
  await ui.choose('a.csv', VALID + 'Extra,,,\n'); // same name, different rows
  await ui.one('import-confirm').fire('click');
  assert.notEqual(ui.calls[1].importKey, firstKey);
  const recovery = ui.one('import-recovery');
  assert.equal(recovery.hidden, false);
  assert.match(recovery.textContent, /2 import results are still unconfirmed/);
});

test('a conflicting retry keeps the unconfirmed import and does not claim nothing was saved', async () => {
  const conflict = { outcome: 'rejected', status: 409, body: { error: { code: 'IMPORT_CONFLICT', message: 'This importKey was already used for different rows.' } } };
  const ui = setup([{ outcome: 'unknown' }, conflict], { storage: sharedStorage() });
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  await ui.one('import-confirm').fire('click'); // the retry hits a conflict
  assert.match(ui.one('import-status').textContent, /different rows/);
  assert.doesNotMatch(ui.one('import-status').textContent, /Nothing was saved/);
  assert.equal(ui.one('import-check').hidden, false); // the stored outcome stays lookable
  assert.equal(ui.one('import-recovery').hidden, false); // and the pending record is not erased
});

test('a validation refusal on a retry keeps the earlier unconfirmed send recorded', async () => {
  const invalid = { outcome: 'rejected', status: 400, body: { error: { code: 'IMPORT_INVALID', message: 'The file cannot be imported; nothing was saved.', details: { fileErrors: [], rowErrors: [] } } } };
  const ui = setup([{ outcome: 'unknown' }, invalid], { storage: sharedStorage() });
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  await ui.one('import-confirm').fire('click');
  assert.match(ui.one('import-status').textContent, /earlier unconfirmed send stays recorded/);
  assert.equal(ui.one('import-check').hidden, false);
  assert.equal(ui.one('import-recovery').hidden, false);
});

test('a validation refusal of a first send clears the pending record for that import', async () => {
  const invalid = { outcome: 'rejected', status: 400, body: { error: { code: 'IMPORT_INVALID', message: 'The file cannot be imported; nothing was saved.', details: { fileErrors: [], rowErrors: [] } } } };
  const ui = setup([invalid], { storage: sharedStorage() });
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.one('import-status').textContent, 'The server refused this import. Nothing was saved.');
  assert.equal(ui.one('import-recovery').hidden, true);
});

test('with blocked storage, an unknown result keeps a same-page check after cancelling', async () => {
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  const ui = setup([{ outcome: 'unknown' }, { outcome: 'ok', ...okResponse(2, true) }], { storage: blocked });
  await ui.choose('history.csv', VALID);
  await ui.one('import-confirm').fire('click');
  await ui.one('import-cancel').fire('click');
  assert.match(ui.one('import-recovery').textContent, /history\.csv/); // the in-memory identity survives
  await ui.one('import-recovery-check').fire('click');
  assert.equal(ui.calls[1].importKey, ui.calls[0].importKey);
  assert.match(ui.one('import-status').textContent, /confirmed imported/);
});

test('a lookup in flight is not confused by choosing another file meanwhile', async () => {
  const storage = sharedStorage();
  const calls = [];
  let releaseLookup;
  const lookupPromise = new Promise((resolve) => { releaseLookup = resolve; });
  const client = {
    commit: async (importKey, csv) => {
      calls.push({ kind: 'commit', importKey, csv });
      return { outcome: 'unknown' };
    },
    lookup: async (importKey) => {
      calls.push({ kind: 'lookup', importKey });
      return lookupPromise;
    },
  };
  const imported = [];
  const root = new FakeElement('main');
  mountImportPanel(root, { client, doc, onImported: (record) => imported.push(record), pendingStore: createPendingImportStore(() => storage) });
  const one = (name) => root.role(name)[0];
  const choose = async (name, text) => {
    one('import-file').files = [fakeFile(name, text)];
    await one('import-file').fire('change');
  };
  await choose('old.csv', VALID);
  await one('import-confirm').fire('click');
  const checkDone = one('import-check').fire('click'); // the lookup is now in flight
  await choose('other.csv', VALID + 'Extra,,,\n'); // meanwhile another file is picked
  releaseLookup({ outcome: 'ok', status: 201, body: { import: { importKey: 'k', status: 'committed', createdAt: 't', issueCount: 2, issueIds: [] }, replayed: false } });
  await checkDone;
  assert.match(one('import-status').textContent, /Imported 2 issues from old\.csv/); // the queried import, not the newer selection
  assert.equal(root.role('import-row').length, 0); // the newer selection was not silently adopted
  assert.equal(one('import-recovery').hidden, true); // the confirmed import is fully resolved
});

test('a slower earlier file read cannot overwrite a newer selection', async () => {
  const root = new FakeElement('main');
  mountImportPanel(root, { client: { commit: async () => ({ outcome: 'unknown' }), lookup: async () => ({ outcome: 'unknown' }) }, doc, pendingStore: createPendingImportStore(() => sharedStorage()) });
  const one = (name) => root.role(name)[0];
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const slowFile = { name: 'slow.csv', size: encoder.encode(VALID).length, arrayBuffer: () => slowGate };
  const pick = (file) => {
    one('import-file').files = [file];
    return one('import-file').fire('change');
  };
  const slowRead = pick(slowFile); // starts first, completes only when released
  await pick(fakeFile('fast.csv', 'title,description,status,priority\nFast row,,,\n')); // completes and previews
  releaseSlow(bytesOf(VALID));
  await slowRead; // the earlier read lands now — it must not replace the newer preview
  const rows = root.role('import-row');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Fast row/);
  assert.match(one('import-status').textContent, /fast\.csv/);
  assert.equal(one('import-confirm').disabled, false);
});

test('importing is disabled while the chosen file is still being read', async () => {
  const calls = [];
  const client = {
    commit: async (importKey) => { calls.push({ kind: 'commit', importKey }); return { outcome: 'unknown' }; },
    lookup: async (importKey) => { calls.push({ kind: 'lookup', importKey }); return { outcome: 'unknown' }; },
  };
  const root = new FakeElement('main');
  mountImportPanel(root, { client, doc, pendingStore: createPendingImportStore(() => sharedStorage()) });
  const one = (name) => root.role(name)[0];
  one('import-file').files = [fakeFile('ready.csv', VALID)];
  await one('import-file').fire('change');
  assert.equal(one('import-confirm').disabled, false); // a settled preview is importable
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  one('import-file').files = [{ name: 'next.csv', size: 10, arrayBuffer: () => gate }];
  const reading = one('import-file').fire('change');
  assert.equal(one('import-confirm').disabled, true); // the stale preview cannot be imported meanwhile
  await one('import-confirm').fire('click'); // even a forced click sends nothing
  assert.equal(calls.length, 0);
  releaseRead(bytesOf('title,description,status,priority\nNext row,,,\n'));
  await reading;
  assert.equal(calls.length, 0); // reading alone still sends nothing
  assert.match(one('import-status').textContent, /next\.csv/);
});
