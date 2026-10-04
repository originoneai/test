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

function setup(responses = [], { storage, matches, prechecks } = {}) {
  const calls = [];
  const client = {
    commit: async (importKey, csv, options = {}) => {
      calls.push({ kind: 'commit', importKey, csv, options });
      return responses.shift();
    },
    lookup: async (importKey) => {
      calls.push({ kind: 'lookup', importKey });
      return responses.shift();
    },
  };
  // Optional server-side "was this exact content already imported?" lookup.
  if (matches) {
    client.match = async (csv, options = {}) => {
      calls.push({ kind: 'match', csv, options });
      return matches.shift();
    };
  }
  // Optional server-side duplicate-external-reference precheck.
  if (prechecks) {
    client.precheck = async (csv) => {
      calls.push({ kind: 'precheck', csv });
      return prechecks.shift();
    };
  }
  const imported = [];
  const root = new FakeElement('main');
  const panel = mountImportPanel(root, {
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
  return { root, one, choose, calls, imported, panel };
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
  assert.match(errors.textContent, /2 of 3 rows cannot be imported:/);
  assert.match(errors.textContent, /Line 3, column title: title is required\./);
  assert.match(errors.textContent, /Line 4, column priority: priority "critical"/);
  assert.equal(ui.root.all((n) => n.attributes.class === 'has-error').length, 2);
  // the valid-rows choice is offered but never preselected
  assert.equal(ui.one('import-valid-only-box').hidden, false);
  assert.equal(ui.one('import-valid-only').checked, false);
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

// ---------------------------------------------------------------------------
// Explicit "import only the valid rows".
// ---------------------------------------------------------------------------
const MIXED = 'title,status,priority\nKeep,open,low\n,open,low\nAlso keep,done,urgent\nBad,open,critical\n';
const subsetOk = (count, lines, replayed = false) => ({
  outcome: 'ok',
  status: replayed ? 200 : 201,
  body: {
    import: {
      importKey: 'k', status: 'committed', mode: 'valid_rows', createdAt: 't', issueCount: count, issueIds: [],
      excludedRows: lines.map((line) => ({ line, problems: [{ column: line === 3 ? 'title' : 'priority', reason: line === 3 ? 'title is required.' : 'priority "critical" is not one of: low, normal, high, urgent.' }] })),
    },
    replayed,
  },
});
const outcomes = (ui) => ui.root.role('import-row-outcome').map((cell) => cell.textContent);
const toggle = async (ui, on) => {
  ui.one('import-valid-only').checked = on;
  await ui.one('import-valid-only').fire('change');
};

test('invalid rows stay visible with line, column and reason; the default imports nothing', async () => {
  const ui = setup();
  await ui.choose('mixed.csv', MIXED);
  assert.equal(ui.root.role('import-row').length, 4);
  const problems = ui.root.role('import-row-problems').map((cell) => cell.textContent);
  assert.deepEqual(problems, ['', 'Column title: title is required.', '', 'Column priority: priority "critical" is not one of: low, normal, high, urgent.']);
  assert.deepEqual(outcomes(ui), ['Not imported while other rows have problems', 'Cannot be imported', 'Not imported while other rows have problems', 'Cannot be imported']);
  assert.equal(ui.one('import-confirm').disabled, true);
  assert.match(ui.one('import-status').textContent, /cannot be imported as a whole: 2 of 4 rows have problems\./);
  // a preview proves nothing about earlier imports, so it never claims "Nothing was saved"
  assert.doesNotMatch(ui.one('import-status').textContent, /Nothing was saved/);
  assert.match(ui.one('import-valid-only-label').textContent, /Import only the 2 valid rows and skip the 2 rows with problems \(lines 3, 5\)/);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 0);
});

test('explicitly choosing valid rows marks the excluded rows and sends the exact excluded lines', async () => {
  const ui = setup([subsetOk(2, [3, 5])]);
  await ui.choose('mixed.csv', MIXED);
  await toggle(ui, true);
  assert.deepEqual(outcomes(ui), ['Will be imported', 'Excluded: will not be imported', 'Will be imported', 'Excluded: will not be imported']);
  assert.equal(ui.one('import-confirm').disabled, false);
  assert.equal(ui.one('import-confirm').textContent, 'Import 2 valid rows, skip 2');
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 1);
  assert.deepEqual(ui.calls[0].options, { mode: 'valid_rows', excludedLines: [3, 5] });
  assert.equal(ui.calls[0].csv, MIXED);
  assert.match(ui.one('import-status').textContent, /Imported 2 issues from mixed\.csv\. Skipped 2 rows with problems \(lines 3, 5\); they were not saved\./);
  // the skipped rows remain listed after the commit
  assert.match(ui.one('import-errors').textContent, /Not imported \(2 rows\):Line 3, column title: title is required\./);
  assert.equal(ui.imported.length, 1);
  assert.equal(ui.one('import-valid-only-box').hidden, true);
});

test('unchecking the choice restores the safe default before anything is sent', async () => {
  const ui = setup();
  await ui.choose('mixed.csv', MIXED);
  await toggle(ui, true);
  await toggle(ui, false);
  assert.equal(ui.one('import-confirm').disabled, true);
  assert.equal(ui.one('import-confirm').textContent, 'Import');
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 0);
});

test('a fully valid file sends the default whole-file request and offers no subset choice', async () => {
  const ui = setup([okResponse(2)]);
  await ui.choose('history.csv', VALID);
  assert.equal(ui.one('import-valid-only-box').hidden, true);
  await ui.one('import-confirm').fire('click');
  assert.deepEqual(ui.calls[0].options, {});
});

test('no subset choice when no row is valid or the file itself is refused', async () => {
  const ui = setup();
  await ui.choose('none.csv', 'title,priority\n,low\nX,critical\n');
  assert.equal(ui.one('import-valid-only-box').hidden, true);
  await toggle(ui, true);
  assert.equal(ui.one('import-confirm').disabled, true);
  await ui.choose('secret.csv', 'title,password\nA,b\n,c\n');
  assert.equal(ui.one('import-valid-only-box').hidden, true);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 0);
});

test('cancel with the choice checked clears it and sends nothing', async () => {
  const ui = setup();
  await ui.choose('mixed.csv', MIXED);
  await toggle(ui, true);
  await ui.one('import-cancel').fire('click');
  assert.equal(ui.one('import-valid-only-box').hidden, true);
  assert.equal(ui.one('import-valid-only').checked, false);
  assert.equal(ui.one('import-status').textContent, 'Import cancelled. Nothing was sent.');
  assert.equal(ui.calls.length, 0);
  // choosing the file again starts unchecked
  await ui.choose('mixed.csv', MIXED);
  assert.equal(ui.one('import-valid-only').checked, false);
  assert.equal(ui.one('import-confirm').disabled, true);
});

test('an unknown valid-rows outcome retries the same key and choice, and survives a reload', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }, { outcome: 'unknown' }], { storage });
  await first.choose('mixed.csv', MIXED);
  await toggle(first, true);
  await first.one('import-confirm').fire('click');
  assert.equal(first.one('import-status').textContent, 'Result unknown.');
  assert.equal(first.one('import-confirm').disabled, false);
  await first.one('import-confirm').fire('click');
  assert.equal(first.calls[1].importKey, first.calls[0].importKey);
  assert.deepEqual(first.calls[1].options, first.calls[0].options);
  // reload: the same file reuses the pending key; the choice must be made again
  const second = setup([subsetOk(2, [3, 5], true)], { storage });
  assert.equal(second.one('import-recovery').hidden, false);
  await second.choose('mixed.csv', MIXED);
  assert.equal(second.one('import-valid-only').checked, false);
  assert.equal(second.one('import-confirm').disabled, true);
  await toggle(second, true);
  await second.one('import-confirm').fire('click');
  assert.equal(second.calls[0].importKey, first.calls[0].importKey);
  assert.deepEqual(second.calls[0].options, { mode: 'valid_rows', excludedLines: [3, 5] });
  assert.match(second.one('import-status').textContent, /Already imported earlier/);
  assert.equal(second.one('import-recovery').hidden, true);
});

test('the choice cannot change while the commit is in flight', async () => {
  let release;
  const calls = [];
  const root = new FakeElement('main');
  mountImportPanel(root, {
    client: {
      commit: (importKey, csv, options) => {
        calls.push(options);
        return new Promise((resolve) => { release = resolve; });
      },
      lookup: async () => ({ outcome: 'unknown' }),
    },
    doc,
    pendingStore: createPendingImportStore(() => sharedStorage()),
  });
  const one = (name) => root.role(name)[0];
  one('import-file').files = [fakeFile('mixed.csv', MIXED)];
  await one('import-file').fire('change');
  one('import-valid-only').checked = true;
  await one('import-valid-only').fire('change');
  const pending = one('import-confirm').fire('click');
  assert.equal(one('import-valid-only').disabled, true);
  one('import-valid-only').checked = false;
  await one('import-valid-only').fire('change');
  assert.equal(one('import-valid-only').checked, true);
  release(subsetOk(2, [3, 5]));
  await pending;
  assert.equal(calls.length, 1);
  assert.match(one('import-status').textContent, /Skipped 2 rows/);
});

test('a stale-preview refusal of a first send says nothing was saved and lists the server rows', async () => {
  const mismatch = {
    outcome: 'rejected',
    status: 400,
    body: { error: { code: 'IMPORT_PREVIEW_MISMATCH', message: 'The rows the server would exclude differ from the preview you confirmed; nothing was saved.', details: { excludedLines: [3], rowErrors: [{ line: 3, errors: ['title is required.'], problems: [{ column: 'title', reason: 'title is required.' }] }] } } },
  };
  const ui = setup([mismatch], { storage: sharedStorage() });
  await ui.choose('mixed.csv', MIXED);
  await toggle(ui, true);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.one('import-status').textContent, 'The server refused this import. Nothing was saved.');
  assert.match(ui.one('import-errors').textContent, /differ from the preview.*Line 3, column title: title is required\./);
  assert.equal(ui.one('import-recovery').hidden, true);
  assert.equal(ui.imported.length, 0);
});

test('the HTTP client sends mode and excludedLines only for an explicit valid-rows commit', async () => {
  const bodies = [];
  const client = csvImport.createImportClient({
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 201, json: async () => okResponse(1).body };
    },
  });
  await client.commit('k1', 'title\nA\n');
  await client.commit('k2', MIXED, { mode: 'valid_rows', excludedLines: [3, 5] });
  assert.deepEqual(bodies, [
    { importKey: 'k1', csv: 'title\nA\n' },
    { importKey: 'k2', csv: MIXED, mode: 'valid_rows', excludedLines: [3, 5] },
  ]);
});

// ---------------------------------------------------------------------------
// Trial findings: recovery after a lost response must never claim "Nothing
// was saved", and a recovered result shows the same skipped rows as a
// normal success.
// ---------------------------------------------------------------------------
const storedSubset = (importKey) => ({ ...subsetOk(2, [3, 5]).body.import, importKey, createdAt: '2026-10-04T20:00:00.000Z' });

test('bug A: after a lost response and a reload, the same file never says nothing was saved and offers Check result', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('mixed.csv', MIXED);
  await toggle(first, true);
  await first.one('import-confirm').fire('click');
  const second = setup([], { storage }); // reload; no server content lookup available
  await second.choose('mixed.csv', MIXED);
  const status = second.one('import-status').textContent;
  assert.doesNotMatch(status, /Nothing was saved/);
  assert.match(status, /already sent/i);
  assert.match(status, /result is not confirmed/i);
  assert.equal(second.one('import-check').hidden, false);
  assert.equal(second.calls.length, 0);
});

test('bug A: reselecting a file whose lost send was committed shows it as already imported, with its skipped rows', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('mixed.csv', MIXED);
  await toggle(first, true);
  await first.one('import-confirm').fire('click');
  const key = first.calls[0].importKey;
  const second = setup([], { storage, matches: [{ outcome: 'ok', matches: [storedSubset(key)] }] });
  await second.choose('mixed.csv', MIXED);
  assert.deepEqual(second.calls.map((call) => call.kind), ['match']);
  assert.deepEqual(second.calls[0].options, { mode: 'valid_rows', excludedLines: [3, 5] });
  assert.equal(second.calls[0].csv, MIXED);
  const status = second.one('import-status').textContent;
  assert.doesNotMatch(status, /Nothing was saved/);
  assert.match(status, /already imported/i);
  assert.match(status, /Skipped 2 rows with problems \(lines 3, 5\)/);
  assert.match(second.one('import-errors').textContent, /Line 3, column title: title is required\./);
  assert.match(second.one('import-errors').textContent, /Line 5, column priority: priority "critical"/);
  assert.equal(second.one('import-confirm').disabled, true);
  assert.equal(second.one('import-recovery').hidden, true); // the pending entry is settled
  assert.equal(second.imported.length, 1);
});

test('bug A: after recovery cleared the pending entry, the same file is still recognized as already imported', async () => {
  const ui = setup([], { storage: sharedStorage(), matches: [{ outcome: 'ok', matches: [storedSubset('11111111-2222-4333-8444-555555555555')] }] });
  await ui.choose('mixed.csv', MIXED);
  const status = ui.one('import-status').textContent;
  assert.doesNotMatch(status, /Nothing was saved/);
  assert.match(status, /already imported earlier/i);
  assert.match(status, /2026-10-04T20:00:00\.000Z/);
  assert.match(status, /second time/);
  assert.equal(ui.calls.filter((call) => call.kind === 'commit').length, 0);
});

test('bug A: when the content lookup cannot answer for a pending file, the result stays unknown with Check result', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('history.csv', VALID);
  await first.one('import-confirm').fire('click');
  const second = setup([], { storage, matches: [{ outcome: 'unknown' }] });
  await second.choose('history.csv', VALID);
  assert.deepEqual(second.calls[0].options, {});
  const status = second.one('import-status').textContent;
  assert.doesNotMatch(status, /Nothing was saved/);
  assert.match(status, /result is not confirmed/i);
  assert.equal(second.one('import-check').hidden, false);
  assert.equal(second.one('import-recovery').hidden, false);
});

test('bug A: a content lookup with no match for a fresh file adds no claim and changes nothing', async () => {
  const ui = setup([okResponse(2)], { storage: sharedStorage(), matches: [{ outcome: 'ok', matches: [] }] });
  await ui.choose('history.csv', VALID);
  assert.equal(ui.one('import-status').textContent, 'history.csv: 2 issue(s) ready. Review the preview, then confirm.');
  assert.equal(ui.one('import-confirm').disabled, false);
});

test('bug B: Check pending results shows the skipped lines and reasons stored by the server', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('mixed.csv', MIXED);
  await toggle(first, true);
  await first.one('import-confirm').fire('click');
  const key = first.calls[0].importKey;
  const second = setup([{ outcome: 'ok', status: 200, body: { import: storedSubset(key), replayed: false } }], { storage });
  await second.one('import-recovery-check').fire('click');
  const status = second.one('import-status').textContent;
  assert.match(status, /confirmed imported/);
  assert.match(status, /mixed\.csv: imported 2 issues\. Skipped 2 rows with problems \(lines 3, 5\); they were not saved\./);
  const errors = second.one('import-errors');
  assert.equal(errors.hidden, false);
  assert.match(errors.textContent, /Not imported from mixed\.csv \(2 rows\):/);
  assert.match(errors.textContent, /Line 3, column title: title is required\./);
  assert.match(errors.textContent, /Line 5, column priority: priority "critical" is not one of: low, normal, high, urgent\./);
  assert.equal(second.imported.length, 1);
});

test('the HTTP client asks the server about already-imported content with mode and excluded lines', async () => {
  const requests = [];
  const client = csvImport.createImportClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ matches: [] }) };
    },
  });
  assert.deepEqual(await client.match('title\nA\n'), { outcome: 'ok', status: 200, matches: [] });
  await client.match(MIXED, { mode: 'valid_rows', excludedLines: [3, 5] });
  assert.deepEqual(requests, [
    { url: '/api/imports/match', body: { csv: 'title\nA\n' } },
    { url: '/api/imports/match', body: { csv: MIXED, mode: 'valid_rows', excludedLines: [3, 5] } },
  ]);
});

test('cancelling a reselected unconfirmed file after a reload does not claim nothing was sent', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('history.csv', VALID);
  await first.one('import-confirm').fire('click');
  const second = setup([], { storage });
  await second.choose('history.csv', VALID);
  await second.one('import-cancel').fire('click');
  const status = second.one('import-status').textContent;
  assert.doesNotMatch(status, /Nothing was sent/);
  assert.match(status, /still unknown/);
  assert.equal(second.one('import-recovery').hidden, false);
});

test('Check pending results also closes the matching preview with its confirmed result', async () => {
  const storage = sharedStorage();
  const first = setup([{ outcome: 'unknown' }], { storage });
  await first.choose('mixed.csv', MIXED);
  await toggle(first, true);
  await first.one('import-confirm').fire('click');
  const key = first.calls[0].importKey;
  const second = setup([{ outcome: 'ok', status: 200, body: { import: storedSubset(key), replayed: false } }], { storage });
  await second.choose('mixed.csv', MIXED);
  await second.one('import-recovery-check').fire('click');
  assert.equal(second.one('import-confirm').disabled, true);
  assert.equal(second.one('import-preview').hidden, true);
  assert.equal(second.one('import-check').hidden, true);
  assert.match(second.one('import-errors').textContent, /Line 3, column title: title is required\./);
});

// ---------------------------------------------------------------------------
// R2: the external_ref column. Duplicate external references inside one file
// and against already imported issues are flagged in the preview; every
// flagged row needs an explicit skip-or-import decision before anything can
// be sent, the server independently re-checks and refuses undecided duplicate
// rows before any write, and skipped duplicates come back listed with their
// reasons.
// ---------------------------------------------------------------------------
const REF_FILE = 'title,status,external_ref\nFirst,open,OPS-9\nSecond,open,OPS-9\nThird,open,OPS-8\n';
const decide = async (ui, line, choice) => {
  const select = ui.root.role('import-row-decision').find((node) => node.attributes['data-line'] === String(line));
  select.value = choice;
  await select.fire('change');
};

test('duplicate external references inside one file are flagged with an explicit per-row decision', async () => {
  const ui = setup();
  await ui.choose('dup.csv', REF_FILE);
  const decisions = ui.root.role('import-row-decision');
  assert.deepEqual(decisions.map((node) => node.attributes['data-line']), ['2', '3']);
  assert.equal(ui.one('import-confirm').disabled, true);
  const results = ui.root.role('import-row-outcome').map((cell) => cell.textContent);
  assert.match(results[0], /duplicate/i);
  assert.match(results[0], /decide/i);
  assert.equal(results[2], 'Will be imported'); // the unique reference is unaffected
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 0);
});

test('deciding skip and import sends the exact decision map and shows the skipped duplicate', async () => {
  const skipped = {
    outcome: 'ok',
    status: 201,
    body: {
      import: {
        importKey: 'k', status: 'committed', mode: 'valid_rows', createdAt: 't', issueCount: 2, issueIds: [],
        excludedRows: [{ line: 3, problems: [{ column: 'external_ref', reason: 'external_ref "OPS-9" appears on lines 2, 3 of this file; this row was skipped by your choice.' }] }],
      },
      replayed: false,
    },
  };
  const ui = setup([skipped]);
  await ui.choose('dup.csv', REF_FILE);
  await decide(ui, 2, 'import');
  assert.equal(ui.one('import-confirm').disabled, true); // one decision is not enough
  await decide(ui, 3, 'skip');
  assert.equal(ui.one('import-confirm').disabled, false);
  assert.equal(ui.one('import-confirm').textContent, 'Import 2 issues');
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.calls.length, 1);
  assert.deepEqual(ui.calls[0].options, { duplicateDecisions: { 2: 'import', 3: 'skip' } });
  assert.match(ui.one('import-status').textContent, /Skipped 1 row with problems \(line 3\)/);
  assert.match(ui.one('import-errors').textContent, /Line 3, column external_ref/);
  assert.equal(ui.imported.length, 1);
});

test('rows already imported are flagged from the server precheck', async () => {
  const ui = setup(
    [{ outcome: 'ok', status: 201, body: { import: { importKey: 'k', status: 'committed', createdAt: 't', issueCount: 1, issueIds: [], excludedRows: [] }, replayed: false } }],
    { prechecks: [{ outcome: 'ok', duplicates: [{ line: 2, externalRef: 'OPS-1', kind: 'already_imported', issueId: 'earlier', createdAt: 't0' }] }] },
  );
  await ui.choose('later.csv', 'title,external_ref\nOld again,OPS-1\nFresh,OPS-7\n');
  assert.deepEqual(ui.calls.map((call) => call.kind), ['precheck']);
  assert.equal(ui.calls[0].csv, 'title,external_ref\nOld again,OPS-1\nFresh,OPS-7\n');
  assert.deepEqual(ui.root.role('import-row-decision').map((node) => node.attributes['data-line']), ['2']);
  assert.match(ui.root.role('import-row-outcome')[0].textContent, /already imported/i);
  await decide(ui, 2, 'skip');
  assert.equal(ui.one('import-confirm').disabled, false);
  await ui.one('import-confirm').fire('click');
  assert.deepEqual(ui.calls[1].options, { duplicateDecisions: { 2: 'skip' } });
  assert.equal(ui.imported.length, 1);
});

test('every flagged row must be decided before importing', async () => {
  const ui = setup();
  await ui.choose('dup.csv', REF_FILE);
  await decide(ui, 2, 'skip');
  assert.equal(ui.one('import-confirm').disabled, true);
  await decide(ui, 3, 'skip');
  assert.equal(ui.one('import-confirm').disabled, false); // the unique OPS-8 row remains importable
  await decide(ui, 3, 'import');
  await decide(ui, 2, 'import');
  assert.equal(ui.one('import-confirm').disabled, false);
  // a file whose every row is a duplicate imports nothing once both are skipped
  const all = setup();
  await all.choose('all-dup.csv', 'title,external_ref\nA,OPS-9\nB,OPS-9\n');
  await decide(all, 2, 'skip');
  assert.equal(all.one('import-confirm').disabled, true);
  await decide(all, 3, 'skip');
  assert.equal(all.one('import-confirm').disabled, true);
  await all.one('import-confirm').fire('click');
  assert.equal(all.calls.length, 0);
});

test('when the precheck cannot answer, the panel says so and the server stays the guard', async () => {
  const ui = setup(
    [{ outcome: 'ok', status: 201, body: { import: { importKey: 'k', status: 'committed', createdAt: 't', issueCount: 1, issueIds: [], excludedRows: [] }, replayed: false } }],
    { prechecks: [{ outcome: 'unknown' }] },
  );
  await ui.choose('later.csv', 'title,external_ref\nFresh,OPS-7\n');
  assert.match(ui.one('import-status').textContent, /unavailable/i);
  assert.equal(ui.one('import-confirm').disabled, false); // no in-file duplicate is provable
  await ui.one('import-confirm').fire('click');
  assert.deepEqual(ui.calls[1].options, {}); // the server re-checks duplicates and refuses undecided ones before any write
});

test('an undecided-duplicate refusal distinguishes a first send from an unconfirmed retry', async () => {
  const undecided = {
    outcome: 'rejected',
    status: 400,
    body: {
      error: {
        code: 'IMPORT_DUPLICATES_UNDECIDED',
        message: 'The file repeats or reuses external reference(s).',
        details: { duplicates: [{ line: 2, externalRef: 'OPS-1', kind: 'already_imported', issueId: 'i', createdAt: 't0', reason: 'external_ref "OPS-1" was already imported (issue i); decide skip or import.' }] },
      },
    },
  };
  // First send of a fresh key: a definite refusal — nothing was saved.
  const first = setup([undecided], { storage: sharedStorage(), prechecks: [{ outcome: 'ok', duplicates: [] }] });
  await first.choose('r.csv', 'title,external_ref\nOld,OPS-1\n');
  await first.one('import-confirm').fire('click');
  assert.match(first.one('import-status').textContent, /Nothing was saved; choose the file again/);
  assert.match(first.one('import-errors').textContent, /Line 2, column external_ref/);
  assert.equal(first.one('import-recovery').hidden, true);
  // Retry after an unknown outcome: the earlier send may already be committed.
  const retry = setup([{ outcome: 'unknown' }, undecided], { storage: sharedStorage(), prechecks: [{ outcome: 'ok', duplicates: [] }] });
  await retry.choose('r.csv', 'title,external_ref\nOld,OPS-1\n');
  await retry.one('import-confirm').fire('click');
  await retry.one('import-confirm').fire('click');
  assert.match(retry.one('import-status').textContent, /earlier unconfirmed send stays recorded/);
  assert.equal(retry.one('import-check').hidden, false);
  assert.equal(retry.one('import-recovery').hidden, false);
});

test('the valid-rows choice is frozen while its send is unconfirmed', async () => {
  const ui = setup([{ outcome: 'unknown' }, { outcome: 'ok', ...subsetOk(2, [3, 5], true) }], { storage: sharedStorage() });
  await ui.choose('mixed.csv', MIXED);
  await toggle(ui, true);
  await ui.one('import-confirm').fire('click');
  assert.equal(ui.one('import-status').textContent, 'Result unknown.');
  // Flipping the checkbox must not redefine the pending import's choice.
  ui.one('import-valid-only').checked = false;
  await ui.one('import-valid-only').fire('change');
  assert.equal(ui.one('import-valid-only').checked, true);
  assert.equal(ui.one('import-valid-only').disabled, true);
  await ui.one('import-confirm').fire('click');
  assert.deepEqual(ui.calls[1].options, ui.calls[0].options); // the same choice retries
  assert.match(ui.one('import-status').textContent, /Already imported earlier/);
});

test('mixed skip totals count invalid rows and skipped duplicates together', async () => {
  // Lines 2 and 3 share OPS-5; line 5 has no title; line 4 is clean.
  const csv = 'title,external_ref\nA,OPS-5\nB,OPS-5\nC,OPS-6\n,OPS-7\n';
  const skipped = {
    outcome: 'ok',
    status: 201,
    body: {
      import: {
        importKey: 'k', status: 'committed', mode: 'valid_rows', createdAt: 't', issueCount: 2, issueIds: [],
        excludedRows: [
          { line: 3, problems: [{ column: 'external_ref', reason: 'external_ref "OPS-5" appears on lines 2, 3 of this file; this row was skipped by your choice.' }] },
          { line: 5, problems: [{ column: 'title', reason: 'title is required.' }] },
        ],
      },
      replayed: false,
    },
  };
  const ui = setup([skipped], { prechecks: [{ outcome: 'ok', duplicates: [] }] });
  await ui.choose('mixed-dup.csv', csv);
  await toggle(ui, true);
  await decide(ui, 2, 'import');
  await decide(ui, 3, 'skip');
  assert.equal(ui.one('import-confirm').disabled, false);
  assert.equal(ui.one('import-confirm').textContent, 'Import 2 valid rows, skip 2'); // 1 invalid + 1 skipped duplicate
  await ui.one('import-confirm').fire('click');
  assert.deepEqual(ui.calls[1].options, { mode: 'valid_rows', excludedLines: [5], duplicateDecisions: { 2: 'import', 3: 'skip' } });
  assert.match(ui.one('import-status').textContent, /Skipped 2 rows with problems \(lines 3, 5\)/);
});

test('a ref file without duplicates sends the unchanged default request', async () => {
  const ui = setup([okResponse(2)], { prechecks: [{ outcome: 'ok', duplicates: [] }] });
  await ui.choose('clean.csv', 'title,external_ref\nOne,OPS-1\nTwo,OPS-2\n');
  assert.equal(ui.root.role('import-row-decision').length, 0);
  assert.equal(ui.one('import-confirm').disabled, false);
  await ui.one('import-confirm').fire('click');
  assert.deepEqual(ui.calls[1].options, {});
});

test('a programmatic preview() call also applies the precheck answer', async () => {
  const ui = setup([], {
    prechecks: [{ outcome: 'ok', duplicates: [{ line: 2, externalRef: 'OPS-1', kind: 'already_imported', issueId: 'earlier', createdAt: 't0' }] }],
  });
  // No file input involved: the module's own returned preview API, guarded
  // exactly like a file-selection preview.
  await ui.panel.preview('title,external_ref\nOld again,OPS-1\nFresh,OPS-2\n', 'later.csv');
  assert.deepEqual(ui.calls.map((call) => call.kind), ['precheck']);
  assert.deepEqual(ui.root.role('import-row-decision').map((node) => node.attributes['data-line']), ['2']);
  assert.match(ui.root.role('import-row-outcome')[0].textContent, /already imported/i);
  assert.equal(ui.one('import-confirm').disabled, true); // the flagged row still needs a decision
});

test('duplicate decision controls render enabled on a ready preview', async () => {
  const ui = setup([], { prechecks: [{ outcome: 'ok', duplicates: [] }] });
  await ui.choose('dup.csv', REF_FILE);
  const decisions = ui.root.role('import-row-decision');
  assert.equal(decisions.length, 2);
  for (const select of decisions) assert.equal(select.disabled, false, 'a completed file preview must offer enabled decision controls');
  assert.equal(ui.one('import-confirm').disabled, true); // …while a duplicate row is still undecided
});

test('decision controls really become disabled once a commit is sent', async () => {
  const ui = setup([{ outcome: 'unknown' }], { storage: sharedStorage(), prechecks: [{ outcome: 'ok', duplicates: [] }] });
  await ui.choose('dup.csv', REF_FILE);
  await decide(ui, 2, 'import');
  await decide(ui, 3, 'skip');
  const before = ui.root.role('import-row-decision');
  assert.equal(before.every((select) => select.disabled === false), true);
  await ui.one('import-confirm').fire('click');
  const during = ui.root.role('import-row-decision');
  assert.equal(during.length, 2);
  for (const select of during) assert.equal(select.disabled, true, 'the sent intent stays visibly frozen while the outcome is unknown');
  // A forced change on the disabled control neither sticks nor resends anything.
  during[0].value = 'skip';
  await during[0].fire('change');
  assert.equal(during[0].value, 'import'); // the captured decision is unchanged
  assert.equal(ui.calls.filter((call) => call.kind === 'commit').length, 1);
});

test('an invalid row sharing a reference never flags the healthy row', async () => {
  // Line 2 has no title and carries OPS-5; line 3 is healthy with the same
  // reference. Only lines that could ever be imported count as duplicates,
  // so line 3 imports through the valid-rows choice with no decision at all.
  const csv = 'title,external_ref\n,OPS-5\nHealthy,OPS-5\n';
  const ok = {
    outcome: 'ok',
    status: 201,
    body: { import: { importKey: 'k', status: 'committed', mode: 'valid_rows', createdAt: 't', issueCount: 1, issueIds: [], excludedRows: [{ line: 2, problems: [{ column: 'title', reason: 'title is required.' }] }] }, replayed: false },
  };
  const ui = setup([ok], { prechecks: [{ outcome: 'ok', duplicates: [] }] });
  await ui.choose('mixed-ref.csv', csv);
  assert.equal(ui.root.role('import-row-decision').length, 0); // no duplicate to decide
  await toggle(ui, true);
  assert.equal(ui.one('import-confirm').disabled, false);
  await ui.one('import-confirm').fire('click');
  assert.deepEqual(ui.calls[1].options, { mode: 'valid_rows', excludedLines: [2] }); // no duplicateDecisions
  assert.match(ui.one('import-status').textContent, /Imported 1 issue/);
});

test('the HTTP client sends duplicateDecisions and precheck bodies exactly', async () => {
  const requests = [];
  const client = csvImport.createImportClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url === '/api/imports/precheck') return { ok: true, status: 200, json: async () => ({ duplicates: [] }) };
      return { ok: true, status: 201, json: async () => okResponse(1).body };
    },
  });
  assert.deepEqual(await client.precheck(REF_FILE), { outcome: 'ok', status: 200, duplicates: [] });
  // a body without a duplicates list proves nothing and stays unknown
  const malformed = csvImport.createImportClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ matches: [] }) }),
  });
  assert.deepEqual(await malformed.precheck(REF_FILE), { outcome: 'unknown', status: 200 });
  await client.commit('k1', 'title\nA\n', { duplicateDecisions: { 3: 'skip' } });
  await client.commit('k2', 'title\nB\n');
  assert.deepEqual(requests, [
    { url: '/api/imports/precheck', body: { csv: REF_FILE } },
    { url: '/api/imports', body: { importKey: 'k1', csv: 'title\nA\n', duplicateDecisions: { 3: 'skip' } } },
    { url: '/api/imports', body: { importKey: 'k2', csv: 'title\nB\n' } },
  ]);
});
