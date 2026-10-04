// Historical issue CSV import: one module shared by the browser preview and
// the server. The server re-parses and re-validates every commit with this
// same code, so the preview a user confirms is exactly what gets stored, and
// the browser is never trusted to have validated anything.
//
// Format: UTF-8 (an optional BOM is dropped), RFC 4180 quoting — fields may
// be quoted, quoted fields may hold commas, CR/LF newlines and doubled
// quotes ("") for a literal quote. A header row names the columns; only
// title, description, status and priority are accepted (title is required),
// in any order. Any other column — credentials, ids, timestamps, history —
// rejects the whole file. Limits are enforced, never by truncation: a file
// over MAX_CSV_BYTES or with more than MAX_IMPORT_ROWS data rows is refused.

export const IMPORT_COLUMNS = ['title', 'description', 'status', 'priority'];
export const IMPORT_STATUSES = ['open', 'in_progress', 'done'];
export const IMPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const IMPORT_DEFAULTS = { description: '', status: 'open', priority: 'normal' };
export const IMPORT_TITLE_MAX = 120;
export const IMPORT_DESCRIPTION_MAX = 4000;
export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_IMPORT_ROWS = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isImportKey(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

// RFC 4180 parser. Returns { records: [{ line, fields }] } or { error }.
// `line` is the 1-based physical line where the record starts (the header is
// line 1), so a user can find a multi-line record in their file. Line endings
// inside quoted fields are normalized to \n. A final line break does not
// create an empty record.
export function parseCsv(input) {
  let text = typeof input === 'string' ? input : '';
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let fields = [];
  let field = '';
  let quoted = false; // inside a quoted field
  let wasQuoted = false; // the current field was opened with a quote
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const endField = () => {
    fields.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          return { error: `Line ${line}: unexpected character after a closing quote.` };
        }
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        field += '\n';
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        line += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0 || wasQuoted) {
        return { error: `Line ${line}: a quote may only start a field; write "" inside a quoted field.` };
      }
      quoted = true;
      wasQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) return { error: `Line ${recordLine}: a quoted field is never closed.` };
  if (field.length > 0 || fields.length > 0 || wasQuoted) endRecord();
  return { records };
}

// Every row problem names the column it is about (null when it concerns the
// whole row, such as a wrong number of fields) and a reason, so the preview
// and the server can say exactly which line, which column and why. `errors`
// keeps the plain reason texts for callers that only need the messages.
function validateRow(record, columns) {
  const problems = [];
  const problem = (column, reason) => problems.push({ column, reason });
  if (record.fields.length !== columns.length) {
    problem(null, `expected ${columns.length} field(s) like the header, found ${record.fields.length}.`);
  }
  const values = {};
  columns.forEach((column, index) => {
    values[column] = record.fields[index] ?? '';
  });
  const title = (values.title ?? '').trim();
  if (title.length < 1) problem('title', 'title is required.');
  else if (title.length > IMPORT_TITLE_MAX) problem('title', `title must be at most ${IMPORT_TITLE_MAX} characters.`);
  const description = values.description ?? IMPORT_DEFAULTS.description;
  if (description.length > IMPORT_DESCRIPTION_MAX) {
    problem('description', `description must be at most ${IMPORT_DESCRIPTION_MAX} characters.`);
  }
  const statusText = (values.status ?? '').trim();
  const status = statusText === '' ? IMPORT_DEFAULTS.status : statusText;
  if (!IMPORT_STATUSES.includes(status)) {
    problem('status', `status "${statusText}" is not one of: ${IMPORT_STATUSES.join(', ')}.`);
  }
  const priorityText = (values.priority ?? '').trim();
  const priority = priorityText === '' ? IMPORT_DEFAULTS.priority : priorityText;
  if (!IMPORT_PRIORITIES.includes(priority)) {
    problem('priority', `priority "${priorityText}" is not one of: ${IMPORT_PRIORITIES.join(', ')}.`);
  }
  return {
    line: record.line,
    issue: { title, description, status, priority },
    problems,
    errors: problems.map((entry) => entry.reason),
  };
}

/** "Line 9, column title: title is required." — one readable problem line. */
export function describeProblem(line, entry) {
  return `Line ${line}, ${entry.column ? `column ${entry.column}` : 'whole row'}: ${entry.reason}`;
}

// The explicit "import only the valid rows" choice. It exists only when the
// file itself is acceptable (no file-level problem such as an unsupported
// column or a limit) and the rows split into at least one valid and at least
// one invalid row. `excludedLines` is exactly what the user saw excluded in
// the preview; the server recomputes it and refuses the commit when it
// differs, so a stale or different preview can never be committed.
export function validRowsSelection(validation) {
  if (!validation || validation.fileErrors.length > 0 || validation.rows.length === 0) return null;
  const valid = validation.rows.filter((row) => row.errors.length === 0);
  const excluded = validation.rows.filter((row) => row.errors.length > 0);
  if (valid.length === 0 || excluded.length === 0) return null;
  return { valid, excluded, excludedLines: excluded.map((row) => row.line) };
}

// Full validation of one file. Never throws. `valid` is true only when the
// whole batch can be committed: no file-level problem and no row error.
export function validateImportCsv(text) {
  const result = { valid: false, fileErrors: [], columns: [], rows: [] };
  if (typeof text !== 'string') {
    result.fileErrors.push('The file is not text.');
    return result;
  }
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_CSV_BYTES) {
    result.fileErrors.push(`The file is ${bytes} bytes; the limit is ${MAX_CSV_BYTES} bytes. Split it into smaller files.`);
    return result;
  }
  const parsed = parseCsv(text);
  if (parsed.error) {
    result.fileErrors.push(parsed.error);
    return result;
  }
  const [header, ...data] = parsed.records;
  if (!header) {
    result.fileErrors.push('The file is empty; expected a header row such as title,description,status,priority.');
    return result;
  }
  const columns = header.fields.map((name) => name.trim().toLowerCase());
  result.columns = columns;
  const unknown = columns.filter((name) => !IMPORT_COLUMNS.includes(name));
  if (unknown.length > 0) {
    result.fileErrors.push(
      `Unsupported column(s): ${unknown.map((name) => JSON.stringify(name)).join(', ')}. Accepted columns: ${IMPORT_COLUMNS.join(', ')}.`,
    );
  }
  const repeated = columns.filter((name, index) => columns.indexOf(name) !== index);
  if (repeated.length > 0) result.fileErrors.push(`Repeated column(s): ${[...new Set(repeated)].join(', ')}.`);
  if (!columns.includes('title')) result.fileErrors.push('The header must include a title column.');
  if (data.length === 0) result.fileErrors.push('The file has a header but no issues.');
  if (data.length > MAX_IMPORT_ROWS) {
    result.fileErrors.push(`The file has ${data.length} issues; the limit is ${MAX_IMPORT_ROWS} per import.`);
  }
  if (result.fileErrors.length > 0) return result;
  result.rows = data.map((record) => validateRow(record, columns));
  result.valid = result.rows.every((row) => row.errors.length === 0);
  return result;
}

// ---------------------------------------------------------------------------
// Browser panel: select, preview, cancel or confirm.
// ---------------------------------------------------------------------------

const RESULT_UNKNOWN = 'The import result could not be confirmed yet. Importing again with the same import id applies it at most once — the server returns the stored result if it already landed — or use Check result. The import stays listed as unconfirmed until its result is known.';

function newImportKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const DIGEST_AVAILABLE =
  typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function';

// SHA-256 of the file text, hex encoded: a content fingerprint that lets a
// reloaded page recognize the exact same unconfirmed import and reuse its id
// instead of minting a new one that could duplicate the rows. Only the
// fingerprint is persisted, never the file text. When the runtime offers no
// digest there is no way to prove content identity, so no id is reused and
// the panel says that reselect dedup is unavailable instead of promising it.
async function fingerprintCsv(text) {
  if (!DIGEST_AVAILABLE) return null;
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createImportClient({ fetchImpl = (...args) => globalThis.fetch(...args), base = '' } = {}) {
  async function call(path, options) {
    let response;
    try {
      response = await fetchImpl(base + path, options);
    } catch {
      return { outcome: 'unknown' };
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      return { outcome: 'unknown', status: response.status };
    }
    if (response.ok && body && body.import) return { outcome: 'ok', status: response.status, body };
    if (response.status >= 500 || !body || !body.error) return { outcome: 'unknown', status: response.status, body };
    return { outcome: 'rejected', status: response.status, body };
  }
  return {
    // options: {} for the default whole-file import, or {mode: 'valid_rows',
    // excludedLines} when the user explicitly chose to import only valid rows.
    commit: (importKey, csv, options = {}) =>
      call('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options.mode === 'valid_rows' ? { importKey, csv, mode: 'valid_rows', excludedLines: options.excludedLines } : { importKey, csv }),
      }),
    lookup: (importKey) => call('/api/imports/' + encodeURIComponent(importKey), { method: 'GET' }),
  };
}

// An import whose result is not confirmed yet stays in a pending list keyed
// by its import id, so the outcome can still be looked up after the preview
// is cancelled or the page is reloaded. The list lives in sessionStorage when
// the browser allows it and always in memory for this page; when storage
// cannot be used the panel says recovery across reloads is unavailable
// instead of silently promising it.
const PENDING_STORAGE_KEY = 'issue-imports-pending';

export function createPendingImportStore(getStorage = () => globalThis.sessionStorage) {
  let storage = null;
  let usable = true;
  try {
    storage = getStorage();
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      storage = null;
      usable = false;
    }
  } catch {
    storage = null;
    usable = false;
  }
  let memory = [];
  const sanitize = (value) =>
    Array.isArray(value) && value.every((entry) => entry && isImportKey(entry.importKey) && typeof entry.fileName === 'string')
      ? value
      : null;
  function entries() {
    if (!usable) return [...memory];
    let raw;
    try {
      raw = storage.getItem(PENDING_STORAGE_KEY);
    } catch {
      usable = false;
      return [...memory];
    }
    if (raw === null) return [];
    let parsed;
    try {
      parsed = sanitize(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      // Unreadable or rewritten data: promise nothing about earlier sessions.
      usable = false;
      return [...memory];
    }
    memory = parsed;
    return [...parsed];
  }
  function write(list) {
    memory = list;
    if (!usable) return;
    try {
      storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(list));
    } catch {
      usable = false;
    }
  }
  return {
    usable: () => usable,
    entries,
    add(importKey, fileName, fingerprint) {
      write([...entries().filter((entry) => entry.importKey !== importKey), { importKey, fileName, fingerprint }]);
    },
    remove(importKey) {
      write(entries().filter((entry) => entry.importKey !== importKey));
    },
  };
}

export function mountImportPanel(root, { client = createImportClient(), doc = root.ownerDocument, onImported = () => {}, decode, pendingStore = createPendingImportStore() } = {}) {
  const el = (tag, attrs = {}, text) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const section = el('section', { class: 'import-panel', 'aria-labelledby': 'import-heading', 'data-role': 'import' });
  section.append(el('h2', { id: 'import-heading' }, 'Import historical issues (CSV)'));
  section.append(
    el('p', { class: 'hint' }, 'Columns: title (required), description, status (open, in_progress, done; default open), priority (low, normal, high, urgent; default normal). UTF-8, up to 500 issues. Nothing is saved until you confirm. If some rows have problems, nothing is imported unless you explicitly choose to import only the valid rows.'),
  );
  const label = el('label', { for: 'import-file' }, 'CSV file');
  const input = el('input', { id: 'import-file', type: 'file', accept: '.csv,text/csv', 'data-role': 'import-file' });
  section.append(label, input);
  const status = el('p', { role: 'status', 'data-role': 'import-status' });
  const errorBox = el('div', { role: 'alert', 'data-role': 'import-errors', hidden: '' });
  const table = el('table', { 'data-role': 'import-preview', hidden: '' });
  const actions = el('div', { class: 'import-actions' });
  const confirmButton = el('button', { type: 'button', 'data-role': 'import-confirm', disabled: '' }, 'Import');
  const cancelButton = el('button', { type: 'button', 'data-role': 'import-cancel', disabled: '' }, 'Cancel');
  const checkButton = el('button', { type: 'button', 'data-role': 'import-check', hidden: '' }, 'Check result');
  actions.append(confirmButton, cancelButton, checkButton);
  // The explicit, opt-in choice to import only the valid rows. Hidden unless
  // the file splits into valid and invalid rows; always unchecked at first.
  const validOnlyBox = el('p', { class: 'import-valid-only', 'data-role': 'import-valid-only-box', hidden: '' });
  const validOnlyInput = el('input', { id: 'import-valid-only', type: 'checkbox', 'data-role': 'import-valid-only' });
  validOnlyInput.checked = false;
  const validOnlyLabel = el('label', { for: 'import-valid-only', 'data-role': 'import-valid-only-label' });
  validOnlyBox.append(validOnlyInput, validOnlyLabel);
  const recoveryBox = el('div', { 'data-role': 'import-recovery', hidden: '' });
  const recoveryCheckButton = el('button', { type: 'button', 'data-role': 'import-recovery-check', hidden: '' }, 'Check pending results');
  section.append(status, errorBox, recoveryBox, table, validOnlyBox, actions);
  root.append(section);

  // Selections are tokened: every file choice takes the next token, and an
  // await may only mutate panel state while its token is still the newest.
  // A slower earlier read can then never overwrite a newer preview, and a
  // reset invalidates whatever was still in flight.
  let selectionToken = 0;
  const state = { csv: null, fileName: '', validation: null, importKey: null, fingerprint: null, busy: false, result: null, sent: false, attempts: 0, preexistingPending: false, reading: false, validOnly: false };

  function showErrors(messages) {
    errorBox.replaceChildren(...messages.map((message) => el('p', {}, message)));
    errorBox.hidden = messages.length === 0;
  }

  function renderRecovery() {
    recoveryBox.replaceChildren();
    const pending = pendingStore.entries();
    if (!pendingStore.usable()) {
      recoveryBox.append(
        el('p', {}, 'Import recovery across reloads is unavailable in this browser: the list of unconfirmed imports cannot be stored. An unconfirmed import can still be checked from this page.'),
      );
      if (pending.length === 0) {
        recoveryCheckButton.hidden = true;
        recoveryBox.hidden = false;
        return;
      }
    } else if (pending.length === 0) {
      recoveryBox.hidden = true;
      return;
    }
    recoveryBox.append(
      el(
        'p',
        {},
        `${pending.length} import result${pending.length === 1 ? ' is' : 's are'} still unconfirmed (${pending.map((entry) => entry.fileName || entry.importKey).join(', ')}). ${
          DIGEST_AVAILABLE
            ? 'Choosing the exact same file again reuses its import id, which applies the import at most once; a different file starts a new import.'
            : 'Choosing a file again always starts a new import id in this browser; use Check pending results instead.'
        }`,
      ),
    );
    recoveryBox.append(recoveryCheckButton);
    recoveryCheckButton.hidden = false;
    recoveryBox.hidden = false;
  }
  renderRecovery();

  // What will happen to one row if the user confirms now.
  function rowOutcome(validation, row) {
    if (validation.valid) return 'Will be imported';
    if (row.errors.length > 0) return state.validOnly ? 'Excluded: will not be imported' : 'Cannot be imported';
    return state.validOnly ? 'Will be imported' : 'Not imported while other rows have problems';
  }

  function renderPreview(validation) {
    table.replaceChildren();
    if (!validation || validation.rows.length === 0) {
      table.hidden = true;
      return;
    }
    const head = el('thead');
    const headRow = el('tr');
    for (const name of ['Line', 'Title', 'Description', 'Status', 'Priority', 'Result', 'Problems']) headRow.append(el('th', { scope: 'col' }, name));
    head.append(headRow);
    const body = el('tbody');
    for (const row of validation.rows) {
      const excluded = row.errors.length > 0;
      const tr = el('tr', { 'data-role': 'import-row', 'data-line': String(row.line), class: excluded ? 'has-error' : '' });
      const problems = el('td', { 'data-role': 'import-row-problems' });
      problems.append(...row.problems.map((entry) => el('div', {}, `${entry.column ? `Column ${entry.column}` : 'Whole row'}: ${entry.reason}`)));
      tr.append(
        el('td', {}, String(row.line)),
        el('td', {}, row.issue.title),
        el('td', { class: 'import-description' }, row.issue.description),
        el('td', {}, row.issue.status),
        el('td', {}, row.issue.priority),
        el('td', { 'data-role': 'import-row-outcome' }, rowOutcome(validation, row)),
        problems,
      );
      body.append(tr);
    }
    table.append(head, body);
    table.hidden = false;
  }

  // Confirm button, status line and the valid-rows choice for the current
  // preview. The default never imports a file with problems; only the
  // explicitly checked choice turns the button into "Import N valid rows".
  function renderChoice() {
    const validation = state.validation;
    const selection = validRowsSelection(validation);
    if (!selection) {
      state.validOnly = false;
      validOnlyInput.checked = false;
      validOnlyBox.hidden = true;
    } else {
      validOnlyBox.hidden = false;
      validOnlyInput.disabled = state.busy;
      validOnlyInput.checked = state.validOnly;
      validOnlyLabel.textContent = `Import only the ${selection.valid.length} valid row${selection.valid.length === 1 ? '' : 's'} and skip the ${selection.excluded.length} row${selection.excluded.length === 1 ? '' : 's'} with problems (line${selection.excluded.length === 1 ? '' : 's'} ${selection.excludedLines.join(', ')}). Skipped rows are not saved; fix them and import them in another file.`;
    }
    if (!validation) return;
    const name = state.fileName;
    if (validation.valid) {
      confirmButton.disabled = state.busy;
      confirmButton.textContent = `Import ${validation.rows.length} issue${validation.rows.length === 1 ? '' : 's'}`;
      status.textContent = `${name}: ${validation.rows.length} issue(s) ready. Review the preview, then confirm.`;
    } else if (selection && state.validOnly) {
      confirmButton.disabled = state.busy;
      confirmButton.textContent = `Import ${selection.valid.length} valid row${selection.valid.length === 1 ? '' : 's'}, skip ${selection.excluded.length}`;
      status.textContent = `${name}: only the ${selection.valid.length} valid row(s) will be imported; ${selection.excluded.length} row(s) with problems will be skipped and not saved. Review the preview, then confirm.`;
    } else if (selection) {
      confirmButton.disabled = true;
      confirmButton.textContent = 'Import';
      status.textContent = `${name} cannot be imported as a whole: ${selection.excluded.length} of ${validation.rows.length} rows have problems. Nothing was saved. Fix them and choose the file again, or explicitly choose to import only the ${selection.valid.length} valid row(s).`;
    } else {
      confirmButton.disabled = true;
      confirmButton.textContent = 'Import';
      status.textContent = `${name} cannot be imported: fix the problems listed and choose the file again. Nothing was saved.`;
    }
  }

  // Only a fully valid file, or the explicitly chosen valid rows of a file
  // that has some, can ever be sent.
  function canConfirm() {
    if (!state.validation) return false;
    return state.validation.valid || (state.validOnly && validRowsSelection(state.validation) !== null);
  }

  validOnlyInput.addEventListener('change', () => {
    // Ignored while a commit/lookup resolves or a newly chosen file is still
    // being read (the visible preview is then about to be replaced).
    if (state.busy || state.reading || !validRowsSelection(state.validation)) {
      validOnlyInput.checked = state.validOnly;
      return;
    }
    state.validOnly = Boolean(validOnlyInput.checked);
    renderPreview(state.validation);
    renderChoice();
  });

  function reset(message = '') {
    // An unconfirmed import survives the reset: its identity stays in the
    // pending list, so its result can still be checked afterwards. Any file
    // read still in flight is invalidated.
    selectionToken += 1;
    Object.assign(state, { csv: null, fileName: '', validation: null, importKey: null, fingerprint: null, result: null, sent: false, attempts: 0, preexistingPending: false, reading: false, validOnly: false });
    input.value = '';
    renderPreview(null);
    renderChoice();
    showErrors([]);
    status.textContent = message;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Import';
    cancelButton.disabled = true;
    checkButton.hidden = true;
  }

  async function preview(text, fileName, token = null) {
    const validation = validateImportCsv(text);
    // Re-selecting the exact text of an unconfirmed import — now or after a
    // reload — reuses that import's id, so confirming again can only replay
    // it, never duplicate the rows. Without a digest, content identity cannot
    // be proven, so a fresh id is minted and nothing is deduplicated.
    const fingerprint = await fingerprintCsv(text);
    if (token !== null && (token !== selectionToken || state.busy)) return validation; // a newer selection or a started commit wins
    const pending = fingerprint ? pendingStore.entries().find((entry) => entry.fingerprint === fingerprint) : null;
    Object.assign(state, { csv: text, fileName, validation, importKey: pending ? pending.importKey : newImportKey(), fingerprint, result: null, sent: false, attempts: 0, preexistingPending: Boolean(pending), validOnly: false });
    renderPreview(validation);
    const rowProblems = validation.rows.filter((row) => row.errors.length > 0);
    showErrors([
      ...validation.fileErrors,
      ...(rowProblems.length > 0 ? [`${rowProblems.length} of ${validation.rows.length} rows cannot be imported:`] : []),
      ...rowProblems.flatMap((row) => row.problems.map((entry) => describeProblem(row.line, entry))),
    ]);
    cancelButton.disabled = false;
    checkButton.hidden = true;
    renderChoice();
    return validation;
  }

  async function readFile(file) {
    if (file.size > MAX_CSV_BYTES) return { error: `The file is ${file.size} bytes; the limit is ${MAX_CSV_BYTES} bytes.` };
    const buffer = await file.arrayBuffer();
    try {
      const text = decode ? decode(buffer) : new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return { text };
    } catch {
      return { error: 'The file is not valid UTF-8 text. Save it as UTF-8 CSV and try again.' };
    }
  }

  input.addEventListener('change', async () => {
    if (state.busy) return; // a commit or lookup is resolving; pick the file again after it finishes
    const token = ++selectionToken;
    const file = input.files && input.files[0];
    if (!file) return;
    // While the chosen file is being read the visible preview no longer
    // matches the input, so importing is disabled until the new preview is
    // ready — the stale preview must never be committed.
    state.reading = true;
    confirmButton.disabled = true;
    const read = await readFile(file);
    if (token !== selectionToken) return; // a newer selection superseded this read
    if (read.error) {
      state.reading = false;
      reset('');
      showErrors([read.error]);
      return;
    }
    await preview(read.text, file.name, token);
    if (token === selectionToken) state.reading = false;
  });

  // settle() resolves the outcome of one specific import. The identity is
  // captured when the request is sent, so a selection made while the request
  // is in flight can never be mistaken for the import being settled.
  function settle(response, importKey = state.importKey, fileName = state.fileName) {
    state.busy = false;
    validOnlyInput.disabled = false;
    if (response.outcome === 'ok') {
      const record = response.body.import;
      state.result = record;
      pendingStore.remove(importKey);
      renderRecovery();
      renderPreview(null);
      const excluded = Array.isArray(record.excludedRows) ? record.excludedRows : [];
      // Rows left out by an explicit valid-rows import stay listed after the
      // commit, as reported by the server — never silently dropped.
      showErrors(
        excluded.length > 0
          ? [`Not imported (${excluded.length} row${excluded.length === 1 ? '' : 's'}):`, ...excluded.flatMap((row) => row.problems.map((entry) => describeProblem(row.line, entry)))]
          : [],
      );
      state.validOnly = false;
      validOnlyBox.hidden = true;
      checkButton.hidden = true;
      cancelButton.disabled = true;
      confirmButton.disabled = true;
      input.value = '';
      status.textContent = `Imported ${record.issueCount} issue${record.issueCount === 1 ? '' : 's'} from ${fileName || 'the file'}.${
        excluded.length > 0 ? ` Skipped ${excluded.length} row${excluded.length === 1 ? '' : 's'} with problems (line${excluded.length === 1 ? '' : 's'} ${excluded.map((row) => row.line).join(', ')}); they were not saved.` : ''
      }${response.body.replayed ? ' (Already imported earlier; nothing was added again.)' : ''}`;
      onImported(record);
      return;
    }
    if (response.outcome === 'rejected') {
      const error = response.body.error;
      // A refusal of this attempt proves nothing about earlier sends of the
      // same import id: the server validates the file before consulting the
      // durable key, and an earlier send whose response was lost may already
      // be committed. Only a validation refusal of the very first send of a
      // freshly minted id — no unconfirmed send ever made — durably means
      // "nothing was saved"; every other refusal keeps the import pending and
      // its lookup available.
      const validationRefusal = error && (error.code === 'IMPORT_INVALID' || error.code === 'VALIDATION_ERROR' || error.code === 'IMPORT_PREVIEW_MISMATCH');
      const definitivelyRefused = validationRefusal && state.attempts === 1 && !state.preexistingPending;
      if (definitivelyRefused) pendingStore.remove(importKey);
      renderRecovery();
      const details = error.details;
      const lines = [error.message];
      if (details && Array.isArray(details.rowErrors)) {
        for (const row of details.rowErrors) {
          if (Array.isArray(row.problems)) for (const entry of row.problems) lines.push(describeProblem(row.line, entry));
          else lines.push(`Line ${row.line}: ${row.errors.join(' ')}`);
        }
      }
      showErrors(lines);
      status.textContent =
        error.code === 'IMPORT_CONFLICT'
          ? 'This import id was already used for different rows. Nothing new was saved here; use Check result to see what is stored under it.'
          : definitivelyRefused
            ? 'The server refused this import. Nothing was saved.'
            : 'The server refused this import attempt. Nothing new was saved here; an earlier unconfirmed send stays recorded — use Check result.';
      confirmButton.disabled = true;
      cancelButton.disabled = false;
      checkButton.hidden = !pendingStore.entries().some((entry) => entry.importKey === importKey);
      return;
    }
    // Unknown outcome: keep the same import key so a retry is deduplicated,
    // and keep the import in the pending list until its result is known.
    showErrors([RESULT_UNKNOWN]);
    status.textContent = 'Result unknown.';
    confirmButton.disabled = !canConfirm();
    cancelButton.disabled = false;
    checkButton.hidden = false;
    renderRecovery();
  }

  confirmButton.addEventListener('click', async () => {
    if (state.busy || state.reading || !canConfirm()) return;
    state.busy = true;
    validOnlyInput.disabled = true;
    state.sent = true;
    state.attempts += 1;
    // Capture what is being sent and record the import id before anything
    // leaves: even a lost page keeps a checkable identity for this import.
    const importKey = state.importKey;
    const fileName = state.fileName;
    const csv = state.csv;
    // The default sends the whole file; the valid-rows choice also sends the
    // exact lines the preview showed as excluded, which the server re-checks.
    const options = state.validation.valid ? {} : { mode: 'valid_rows', excludedLines: validRowsSelection(state.validation).excludedLines };
    pendingStore.add(importKey, fileName, state.fingerprint);
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    status.textContent = 'Importing…';
    settle(await client.commit(importKey, csv, options), importKey, fileName);
  });

  checkButton.addEventListener('click', async () => {
    if (state.busy || !state.importKey) return;
    state.busy = true;
    // The import being checked is fixed the moment the lookup leaves; a
    // selection made meanwhile must not redefine what the answer settles.
    const importKey = state.importKey;
    const fileName = state.fileName;
    status.textContent = 'Checking…';
    const response = await client.lookup(importKey);
    if (response.outcome === 'rejected' && response.status === 404) {
      // A missing record does not prove the import was not saved: the request
      // may still be on its way. Keep the id pending and keep checking open.
      state.busy = false;
      showErrors(['No record of this import was found yet, which does not confirm anything: the request may still be on its way. Check again in a moment; importing again reuses the same import id, which applies the import at most once.']);
      status.textContent = 'Result not confirmed yet.';
      confirmButton.disabled = !canConfirm();
      cancelButton.disabled = false;
      checkButton.hidden = false;
      return;
    }
    settle(response, importKey, fileName);
  });

  cancelButton.addEventListener('click', () => {
    if (state.busy) return;
    // Cancelling the preview never destroys the identity of an import whose
    // result is still unknown — only the durable lookup can settle that.
    const unconfirmed = state.importKey && state.sent && state.result === null && pendingStore.entries().some((entry) => entry.importKey === state.importKey);
    const name = state.fileName || 'the file';
    reset(
      unconfirmed
        ? `Cancelled here — the result of ${name} is still unknown. Use Check result before importing that file again.`
        : 'Import cancelled. Nothing was sent.',
    );
    renderRecovery();
  });

  recoveryCheckButton.addEventListener('click', async () => {
    if (state.busy) return;
    const pending = pendingStore.entries();
    if (pending.length === 0) return;
    state.busy = true;
    status.textContent = 'Checking pending results…';
    let confirmed = 0;
    let stillOpen = 0;
    for (const entry of pending) {
      const response = await client.lookup(entry.importKey);
      if (response && response.outcome === 'ok') {
        pendingStore.remove(entry.importKey);
        confirmed += 1;
        onImported(response.body.import);
      } else {
        // Not found yet, unreachable or refused without a durable record:
        // none of these proves the import was not saved, so it stays pending.
        stillOpen += 1;
      }
    }
    state.busy = false;
    renderRecovery();
    status.textContent =
      confirmed > 0 && stillOpen > 0
        ? `${confirmed} unconfirmed import(s) are confirmed imported; ${stillOpen} still not confirmed.`
        : confirmed > 0
          ? `All ${confirmed} unconfirmed import(s) are confirmed imported.`
          : 'Still not confirmed: the server has no record yet, which does not prove they were not saved — the request may still be on its way. Check again in a moment.';
  });

  return { section, state, preview, reset };
}
