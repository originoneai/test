// Historical issue CSV import: one module shared by the browser preview and
// the server. The server re-parses and re-validates every commit with this
// same code, so the preview a user confirms is exactly what gets stored, and
// the browser is never trusted to have validated anything.
//
// Format: UTF-8 (an optional BOM is dropped), RFC 4180 quoting — fields may
// be quoted, quoted fields may hold commas, CR/LF newlines and doubled
// quotes ("") for a literal quote. A header row names the columns; only
// title, description, status, priority and external_ref are accepted (title
// is required), in any order. external_ref is the optional old-system
// reference of a historical issue, kept on the imported issue so repeated
// imports of the same history can be recognized: a reference that appears
// more than once in one file, or that an earlier import already brought in,
// is flagged as a duplicate that needs an explicit skip-or-import decision —
// an existing issue is never silently overwritten. Any other column —
// credentials, ids, timestamps, history — rejects the whole file. Limits are
// enforced, never by truncation: a file over MAX_CSV_BYTES or with more than
// MAX_IMPORT_ROWS data rows is refused.

export const IMPORT_COLUMNS = ['title', 'description', 'status', 'priority', 'external_ref'];
export const IMPORT_STATUSES = ['open', 'in_progress', 'done'];
export const IMPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const IMPORT_DEFAULTS = { description: '', status: 'open', priority: 'normal', external_ref: '' };
export const IMPORT_TITLE_MAX = 120;
export const IMPORT_DESCRIPTION_MAX = 4000;
export const IMPORT_EXTERNAL_REF_MAX = 100;
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
  // The exact four-field issue shape of a file without the external_ref column
  // is a stable contract; externalRef joins the issue only when the column is
  // present, so legacy files and their digests stay byte-identical.
  if (!columns.includes('external_ref')) {
    return { line: record.line, issue: { title, description, status, priority }, problems, errors: problems.map((entry) => entry.reason) };
  }
  const externalRef = (values.external_ref ?? IMPORT_DEFAULTS.external_ref).trim();
  if (externalRef.length > IMPORT_EXTERNAL_REF_MAX) {
    problem('external_ref', `external_ref must be at most ${IMPORT_EXTERNAL_REF_MAX} characters.`);
  }
  return {
    line: record.line,
    issue: { title, description, status, priority, externalRef },
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
  const result = { valid: false, fileErrors: [], columns: [], rows: [], duplicates: [] };
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
  // Duplicate external references inside this file, counted only among rows
  // that could ever be imported (rows without problems): a reference shared
  // with a row that is itself invalid never blocks the healthy row, exactly
  // like the batch the server finally stores. Duplicates are not row errors:
  // a duplicate row is importable only through the user's explicit
  // skip-or-import decision, so it must never hide in the valid/invalid split
  // and must not make a file invalid on its own.
  const linesByRef = new Map();
  for (const row of result.rows) {
    if (row.errors.length > 0) continue;
    const ref = row.issue.externalRef;
    if (!ref) continue;
    if (!linesByRef.has(ref)) linesByRef.set(ref, []);
    linesByRef.get(ref).push(row.line);
  }
  for (const [externalRef, lines] of linesByRef) {
    if (lines.length > 1) result.duplicates.push({ externalRef, lines: lines.slice().sort((a, b) => a - b) });
  }
  const duplicateLines = new Set(result.duplicates.flatMap((group) => group.lines));
  for (const row of result.rows) row.duplicateInFile = duplicateLines.has(row.line);
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
    // excludedLines} when the user explicitly chose to import only the valid
    // rows, plus duplicateDecisions ({line: 'skip' | 'import'}) for every row
    // flagged as a duplicate external reference.
    commit: (importKey, csv, options = {}) =>
      call('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          importKey,
          csv,
          ...(options.mode === 'valid_rows' ? { mode: 'valid_rows', excludedLines: options.excludedLines } : {}),
          ...(options.duplicateDecisions && Object.keys(options.duplicateDecisions).length > 0 ? { duplicateDecisions: options.duplicateDecisions } : {}),
        }),
      }),
    lookup: (importKey) => call('/api/imports/' + encodeURIComponent(importKey), { method: 'GET' }),
    // Read-only: every committed import of exactly this content and choice —
    // the same normalized rows, mode, excluded lines and duplicate decisions a
    // commit would send, so recovery after a lost response finds the stored
    // outcome of the exact decision that was made.
    match: async (csv, options = {}) => {
      let response;
      try {
        response = await fetchImpl(base + '/api/imports/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            csv,
            ...(options.mode === 'valid_rows' ? { mode: 'valid_rows', excludedLines: options.excludedLines } : {}),
            ...(options.duplicateDecisions && Object.keys(options.duplicateDecisions).length > 0 ? { duplicateDecisions: options.duplicateDecisions } : {}),
          }),
        });
      } catch {
        return { outcome: 'unknown' };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        return { outcome: 'unknown', status: response.status };
      }
      if (response.ok && body && Array.isArray(body.matches)) return { outcome: 'ok', status: response.status, matches: body.matches };
      return { outcome: 'unknown', status: response.status };
    },
    // Read-only: which rows of this file carry a duplicate external reference
    // — repeated inside the file, or already imported earlier. Only an answer
    // with a duplicates list proves anything; everything else stays unknown.
    precheck: async (csv) => {
      let response;
      try {
        response = await fetchImpl(base + '/api/imports/precheck', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ csv }),
        });
      } catch {
        return { outcome: 'unknown' };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        return { outcome: 'unknown', status: response.status };
      }
      if (response.ok && body && Array.isArray(body.duplicates)) return { outcome: 'ok', status: response.status, duplicates: body.duplicates };
      return { outcome: 'unknown', status: response.status };
    },
  };
}

// The rows a valid-rows import left out, as stored by the server: one
// status sentence and the per-line reasons. Shared by a fresh commit, a
// replay, Check result, Check pending results and an already-imported file,
// so every confirmed result shows the same skipped rows.
function excludedOf(record) {
  return record && Array.isArray(record.excludedRows) ? record.excludedRows : [];
}

function skippedSentence(record) {
  const excluded = excludedOf(record);
  if (excluded.length === 0) return '';
  const plural = excluded.length === 1 ? '' : 's';
  return ` Skipped ${excluded.length} row${plural} with problems (line${plural} ${excluded.map((row) => row.line).join(', ')}); they were not saved.`;
}

function skippedDetails(record, header) {
  const excluded = excludedOf(record);
  if (excluded.length === 0) return [];
  return [
    `${header} (${excluded.length} row${excluded.length === 1 ? '' : 's'}):`,
    ...excluded.flatMap((row) => (Array.isArray(row.problems) ? row.problems : []).map((entry) => describeProblem(row.line, entry))),
  ];
}

const issueCountText = (record) => `${record.issueCount} issue${record.issueCount === 1 ? '' : 's'}`;

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
    el(
      'p',
      { class: 'hint' },
      'Columns: title (required), description, status (open, in_progress, done; default open), priority (low, normal, high, urgent; default normal), external_ref (optional: the old system\'s reference, kept on the imported issue). UTF-8, up to 500 issues. Nothing is saved until you confirm. If some rows have problems, nothing is imported unless you explicitly choose to import only the valid rows. Rows whose external_ref repeats in the file or was already imported are flagged as duplicates and each needs an explicit skip-or-import decision; existing issues are never overwritten.',
    ),
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
  const state = {
    csv: null, fileName: '', validation: null, importKey: null, fingerprint: null, busy: false, result: null, sent: false,
    attempts: 0, preexistingPending: false, reading: false, validOnly: false, prior: null,
    // Duplicate external references of the current file (Map line → flag) and
    // the user's explicit per-line decision ('skip' | 'import'); precheckNote
    // records that the server-side duplicate check could not answer.
    duplicates: null, decisions: {}, precheckNote: null,
  };

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

  // What will happen to one row if the user confirms now. A duplicate
  // decision never overrides validation: a row with problems stays excluded
  // or unimportable, and the all-or-nothing default still gates valid rows of
  // a file with problems until the valid-rows choice is explicit.
  function rowOutcome(validation, row) {
    if (row.errors.length > 0) return state.validOnly ? 'Excluded: will not be imported' : 'Cannot be imported';
    const importableNow = validation.valid || state.validOnly;
    const duplicate = state.duplicates && state.duplicates.get(row.line);
    if (duplicate && importableNow) {
      if (state.decisions[row.line] === 'skip') return 'Excluded: will not be imported';
      if (state.decisions[row.line] === 'import') return 'Will be imported';
      return duplicate.kind === 'already_imported' ? 'Already imported — decide below' : 'Duplicate — decide below';
    }
    return importableNow ? 'Will be imported' : 'Not imported while other rows have problems';
  }

  function duplicateNotice(flag) {
    if (!flag) return '';
    if (flag.kind === 'already_imported') {
      return `external_ref ${flag.externalRef} was already imported (issue ${flag.issueId}, created ${flag.createdAt}); importing again adds a second copy unless you skip it.`;
    }
    return `external_ref ${flag.externalRef} appears on line${flag.lines.length === 1 ? '' : 's'} ${flag.lines.join(', ')} of this file; import it once and skip the other(s), or import every copy explicitly.`;
  }

  // Once a commit has left with these decisions, the sent intent stays
  // immutable until its outcome settles: changing a decision after an unknown
  // result would silently redefine what the pending importKey means.
  const decisionsFrozen = () => state.sent && state.result === null;

  function renderPreview(validation) {
    table.replaceChildren();
    if (!validation || validation.rows.length === 0) {
      table.hidden = true;
      return;
    }
    // Legacy files keep the exact seven-column preview; the extra columns
    // appear only when this file actually carries references or decisions.
    const hasRefColumn = validation.columns.includes('external_ref');
    const wantsDecide = validation.rows.some((row) => row.errors.length === 0 && state.duplicates && state.duplicates.get(row.line));
    const head = el('thead');
    const headRow = el('tr');
    const names = ['Line', 'Title', 'Description', 'Status', 'Priority'];
    if (hasRefColumn) names.push('External ref');
    names.push('Result');
    if (wantsDecide) names.push('Decide');
    names.push('Problems');
    for (const name of names) headRow.append(el('th', { scope: 'col' }, name));
    head.append(headRow);
    const body = el('tbody');
    for (const row of validation.rows) {
      const excluded = row.errors.length > 0;
      const tr = el('tr', { 'data-role': 'import-row', 'data-line': String(row.line), class: excluded ? 'has-error' : '' });
      const problems = el('td', { 'data-role': 'import-row-problems' });
      const duplicate = state.duplicates && state.duplicates.get(row.line);
      if (duplicate) problems.append(el('div', {}, `Duplicate: ${duplicateNotice(duplicate)}`));
      problems.append(...row.problems.map((entry) => el('div', {}, `${entry.column ? `Column ${entry.column}` : 'Whole row'}: ${entry.reason}`)));
      // The explicit per-duplicate decision: no default, so neither skipping
      // nor importing a duplicate can happen silently. Only an importable row
      // (no row problems) is decidable.
      const cells = [el('td', {}, String(row.line)), el('td', {}, row.issue.title), el('td', { class: 'import-description' }, row.issue.description), el('td', {}, row.issue.status), el('td', {}, row.issue.priority)];
      if (hasRefColumn) cells.push(el('td', { 'data-role': 'import-row-ref' }, row.issue.externalRef || ''));
      cells.push(el('td', { 'data-role': 'import-row-outcome' }, rowOutcome(validation, row)));
      if (wantsDecide) {
        const decideCell = el('td', { 'data-role': 'import-row-decide' });
        if (duplicate && !excluded) {
          const select = el('select', { 'data-role': 'import-row-decision', 'data-line': String(row.line) });
          for (const [value, label] of [['', '— decide —'], ['skip', 'Skip this duplicate'], ['import', 'Import anyway']]) {
            select.append(el('option', { value }, label));
          }
          select.value = state.decisions[row.line] || '';
          select.disabled = state.busy || state.reading || decisionsFrozen();
          select.addEventListener('change', () => {
            if (state.busy || state.reading || decisionsFrozen()) {
              select.value = state.decisions[row.line] || '';
              return;
            }
            if (select.value === 'skip' || select.value === 'import') state.decisions[row.line] = select.value;
            else delete state.decisions[row.line];
            renderPreview(state.validation);
            renderChoice();
          });
          decideCell.append(select);
        }
        cells.push(decideCell);
      }
      cells.push(problems);
      tr.append(...cells);
      body.append(tr);
    }
    table.append(head, body);
    table.hidden = false;
  }

  // What is known about earlier sends of exactly this content: an
  // unconfirmed send from this browser (pending), imports the server already
  // holds for the same content and choice, or a check still running. Never
  // "nothing was saved" — only the server can confirm what is stored.
  function priorNotice() {
    const prior = state.prior;
    if (!prior) return '';
    const name = state.fileName || 'This file';
    const parts = [];
    if (prior.pending) {
      parts.push(`${name} was already sent from this browser and its result is not confirmed yet — it may already be imported. Use Check result before importing it again; importing again reuses the same import id, so it is applied at most once.`);
    }
    if (prior.others.length > 0) {
      const latest = prior.others[prior.others.length - 1];
      const times = prior.others.length === 1 ? '' : ` (${prior.others.length} times)`;
      parts.push(`This exact content was already imported earlier${times}: ${issueCountText(latest)} on ${latest.createdAt}.${skippedSentence(latest)} Importing it again would add these issues a second time.`);
    }
    if (prior.checking) parts.push('Checking whether this exact content was already imported…');
    return parts.join(' ');
  }

  function withPrior(text) {
    const notice = priorNotice();
    return notice ? `${text} ${notice}` : text;
  }

  // Confirm button, status line and the valid-rows choice for the current
  // preview. The default never imports a file with problems; only the
  // explicitly checked choice turns the button into "Import N valid rows".
  // Duplicate external references gate the button on top of that: every
  // flagged row must carry an explicit skip-or-import decision, and at least
  // one row must remain importable.
  function undecidedDuplicates() {
    if (!state.duplicates || !state.validation) return [];
    return [...state.duplicates.keys()].filter(
      (line) => state.validation.rows.some((row) => row.line === line && row.errors.length === 0) && !state.decisions[line],
    );
  }

  function importableRows() {
    const validation = state.validation;
    if (!validation) return [];
    const base = validation.valid ? validation.rows : state.validOnly && validRowsSelection(validation) ? validRowsSelection(validation).valid : [];
    return base.filter((row) => state.decisions[row.line] !== 'skip');
  }

  function precheckNoteText() {
    return state.precheckNote
      ? ' The duplicate check against imported history is unavailable right now; the server still re-checks every duplicate before anything is saved.'
      : '';
  }

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
    const undecided = undecidedDuplicates();
    const undecidedText =
      undecided.length > 0
        ? ` ${undecided.length} duplicate external-reference row${undecided.length === 1 ? '' : 's'} (line${undecided.length === 1 ? '' : 's'} ${undecided.join(', ')}) still need${undecided.length === 1 ? 's' : ''} an explicit skip-or-import decision.`
        : '';
    const note = precheckNoteText();
    const importable = importableRows();
    const blockedByDuplicates = undecided.length > 0 || importable.length === 0;
    if (validation.valid) {
      confirmButton.disabled = state.busy || blockedByDuplicates;
      confirmButton.textContent = `Import ${importable.length} issue${importable.length === 1 ? '' : 's'}`;
      status.textContent = withPrior(`${name}: ${importable.length} issue(s) ready. Review the preview, then confirm.${undecidedText}${note}`);
    } else if (selection && state.validOnly) {
      const skippedDuplicates = selection.valid.filter((row) => state.decisions[row.line] === 'skip').length;
      confirmButton.disabled = state.busy || blockedByDuplicates;
      confirmButton.textContent = `Import ${importable.length} valid row${importable.length === 1 ? '' : 's'}, skip ${selection.excluded.length + skippedDuplicates}`;
      status.textContent = withPrior(`${name}: only the ${selection.valid.length} valid row(s) will be imported; ${selection.excluded.length} row(s) with problems will be skipped and not saved.${undecidedText}${note}`);
    } else if (selection) {
      confirmButton.disabled = true;
      confirmButton.textContent = 'Import';
      // A preview proves nothing about earlier sends of this content, so it
      // never claims "Nothing was saved"; what an earlier send did is shown
      // by the prior notice (pending / already imported / unknown).
      status.textContent = withPrior(`${name} cannot be imported as a whole: ${selection.excluded.length} of ${validation.rows.length} rows have problems. Fix them and choose the file again, or explicitly choose to import only the ${selection.valid.length} valid row(s).${undecidedText}${note}`);
    } else {
      confirmButton.disabled = true;
      confirmButton.textContent = 'Import';
      status.textContent = withPrior(`${name} cannot be imported: fix the problems listed and choose the file again.${undecidedText}${note}`);
    }
  }

  // Only a fully valid file, or the explicitly chosen valid rows of a file
  // that has some, can ever be sent — and only with every duplicate decided
  // and something left to import.
  function canConfirm() {
    if (!state.validation) return false;
    if (undecidedDuplicates().length > 0) return false;
    if (importableRows().length === 0) return false;
    return state.validation.valid || (state.validOnly && validRowsSelection(state.validation) !== null);
  }

  validOnlyInput.addEventListener('change', () => {
    // Ignored while a commit/lookup resolves, a newly chosen file is still
    // being read (the visible preview is then about to be replaced), or the
    // sent intent is still unconfirmed: flipping the choice after an unknown
    // send would silently redefine what the pending importKey means.
    if (state.busy || state.reading || !validRowsSelection(state.validation) || decisionsFrozen()) {
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
    Object.assign(state, { csv: null, fileName: '', validation: null, importKey: null, fingerprint: null, result: null, sent: false, attempts: 0, preexistingPending: false, reading: false, validOnly: false, prior: null, duplicates: null, decisions: {}, precheckNote: null });
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
    const selection = validRowsSelection(validation);
    // Files that carry external references are matched by content AND the
    // user's duplicate decisions, so the panel asks the server which rows are
    // duplicates (precheck) instead of the decision-free content match.
    const hasRefs = validation.rows.some((row) => row.issue.externalRef);
    const matchOptions = hasRefs ? null : validation.valid ? {} : selection ? { mode: 'valid_rows', excludedLines: selection.excludedLines } : null;
    const canMatch = !hasRefs && typeof client.match === 'function' && matchOptions !== null;
    const duplicates = new Map();
    for (const group of validation.duplicates) {
      for (const line of group.lines) duplicates.set(line, { kind: 'in_file', externalRef: group.externalRef, lines: group.lines });
    }
    Object.assign(state, {
      csv: text, fileName, validation, importKey: pending ? pending.importKey : newImportKey(), fingerprint, result: null, sent: false, attempts: 0,
      preexistingPending: Boolean(pending), validOnly: false,
      prior: pending || canMatch ? { pending: Boolean(pending), others: [], checking: canMatch } : null,
      duplicates, decisions: {}, precheckNote: null,
    });
    renderPreview(validation);
    const rowProblems = validation.rows.filter((row) => row.errors.length > 0);
    showErrors([
      ...validation.fileErrors,
      ...(rowProblems.length > 0 ? [`${rowProblems.length} of ${validation.rows.length} rows cannot be imported:`] : []),
      ...rowProblems.flatMap((row) => row.problems.map((entry) => describeProblem(row.line, entry))),
    ]);
    cancelButton.disabled = false;
    // An unconfirmed earlier send of this exact file can be checked right here.
    checkButton.hidden = !pending;
    renderChoice();
    if (canMatch) await checkPrior(text, matchOptions);
    else if (hasRefs && typeof client.precheck === 'function') await runPrecheck(text);
    return validation;
  }

  // Asks the server which rows of this file carry a duplicate external
  // reference — repeated inside the file or already imported earlier. Only an
  // answer that still belongs to the visible, unsent preview is applied; an
  // answer that cannot be obtained proves nothing and only says so, because
  // the server re-checks every duplicate before anything is saved. The token
  // is captured here (not passed in) so a programmatic preview() call without
  // one is guarded exactly like a file-selection preview.
  async function runPrecheck(text) {
    const token = selectionToken;
    const response = await client.precheck(text);
    if (token !== selectionToken || state.csv !== text || state.sent || state.busy || state.result !== null || !state.duplicates) return;
    if (response && response.outcome === 'ok' && Array.isArray(response.duplicates)) {
      for (const entry of response.duplicates) {
        if (!entry || !Number.isSafeInteger(entry.line)) continue;
        if (state.validation && state.validation.rows.some((row) => row.line === entry.line && row.errors.length === 0)) {
          state.duplicates.set(entry.line, entry);
        }
      }
    } else {
      state.precheckNote = 'unavailable';
    }
    renderPreview(state.validation);
    renderChoice();
  }

  // Asks the server whether exactly this content and choice was already
  // imported. Only answers that still belong to the visible, unsent preview
  // are applied; a failed check leaves the result unknown, never "not saved".
  async function checkPrior(text, options) {
    const importKey = state.importKey;
    const token = selectionToken;
    // The preview is usable while the check runs.
    state.reading = false;
    const response = await client.match(text, options);
    if (token !== selectionToken || state.csv !== text || state.importKey !== importKey || state.sent || state.busy || state.result !== null || !state.prior) return;
    state.prior.checking = false;
    if (response && response.outcome === 'ok') {
      const records = response.matches.filter((record) => record && typeof record.importKey === 'string');
      const own = state.prior.pending ? records.find((record) => record.importKey === importKey) : null;
      if (own) {
        // The unconfirmed send from this browser did land: settle it now.
        pendingStore.remove(importKey);
        renderRecovery();
        showConfirmed(own, state.fileName, `${state.fileName || 'This file'} was already imported earlier (${own.createdAt}): ${issueCountText(own)}.${skippedSentence(own)} Nothing was added again.`);
        onImported(own);
        return;
      }
      state.prior.others = records;
    }
    if (!state.prior.pending && state.prior.others.length === 0) state.prior = null;
    renderChoice();
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
    // The read completed for the still-current selection: clear the gate
    // BEFORE rendering, so the preview's decision controls and the Import
    // button render enabled for exactly this completed file (a native
    // preflight caught them stuck disabled when the flag outlived the
    // first render).
    state.reading = false;
    await preview(read.text, file.name, token);
  });

  // settle() resolves the outcome of one specific import. The identity is
  // captured when the request is sent, so a selection made while the request
  // is in flight can never be mistaken for the import being settled.
  // Shows a confirmed import of the current preview: the preview closes and
  // the rows a valid-rows import left out stay listed with their reasons, as
  // stored by the server — never silently dropped.
  function showConfirmed(record, fileName, text) {
    state.result = record;
    state.prior = null;
    renderPreview(null);
    showErrors(skippedDetails(record, 'Not imported'));
    state.validOnly = false;
    validOnlyBox.hidden = true;
    checkButton.hidden = true;
    cancelButton.disabled = true;
    confirmButton.disabled = true;
    input.value = '';
    status.textContent = text;
  }

  function settle(response, importKey = state.importKey, fileName = state.fileName) {
    state.busy = false;
    // The valid-rows choice, like the duplicate decisions, is part of the
    // sent intent: it stays as-is while the outcome is unknown so a retry
    // re-sends exactly the same choice under the same import id.
    validOnlyInput.disabled = decisionsFrozen();
    if (response.outcome === 'ok') {
      const record = response.body.import;
      pendingStore.remove(importKey);
      renderRecovery();
      showConfirmed(
        record,
        fileName,
        `Imported ${issueCountText(record)} from ${fileName || 'the file'}.${skippedSentence(record)}${response.body.replayed ? ' (Already imported earlier; nothing was added again.)' : ''}`,
      );
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
      // its lookup available. An undecided-duplicate refusal is such a
      // definite refusal: the key was never committed, so on a first send the
      // file can be chosen again with the decisions made.
      const validationRefusal =
        error &&
        (error.code === 'IMPORT_INVALID' ||
          error.code === 'VALIDATION_ERROR' ||
          error.code === 'IMPORT_PREVIEW_MISMATCH' ||
          error.code === 'IMPORT_DUPLICATES_UNDECIDED');
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
      if (details && Array.isArray(details.duplicates)) {
        for (const entry of details.duplicates) {
          if (entry && Number.isSafeInteger(entry.line)) {
            lines.push(`Line ${entry.line}, column external_ref: ${entry.reason || `duplicate external reference ${entry.externalRef || ''}.`}`);
          }
        }
      }
      showErrors(lines);
      // The sent intent (choices and decisions) stays frozen until the
      // outcome settles; the controls must visibly say so.
      renderPreview(state.validation);
      const duplicatesRefusal = error.code === 'IMPORT_DUPLICATES_UNDECIDED';
      status.textContent =
        error.code === 'IMPORT_CONFLICT'
          ? 'This import id was already used for different rows. Nothing new was saved here; use Check result to see what is stored under it.'
          : duplicatesRefusal && definitivelyRefused
          ? 'The server refused this import: duplicate external references still need an explicit decision. Nothing was saved; choose the file again to see them and decide skip or import.'
          : duplicatesRefusal
          ? 'The server refused this import attempt: duplicate external references still need an explicit decision. Nothing new was saved here; an earlier unconfirmed send stays recorded — use Check result.'
          : definitivelyRefused && state.prior && state.prior.others.length > 0
            ? 'The server refused this import attempt. Nothing new was saved; this exact content was already imported earlier.'
            : definitivelyRefused
            ? 'The server refused this import. Nothing was saved.'
            : 'The server refused this import attempt. Nothing new was saved here; an earlier unconfirmed send stays recorded — use Check result.';
      confirmButton.disabled = true;
      cancelButton.disabled = false;
      checkButton.hidden = !pendingStore.entries().some((entry) => entry.importKey === importKey);
      return;
    }
    // Unknown outcome: keep the same import key so a retry is deduplicated,
    // and keep the import in the pending list until its result is known. The
    // frozen decision controls must visibly stay disabled.
    showErrors([RESULT_UNKNOWN]);
    renderPreview(state.validation);
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
    // Re-render so the native decision controls actually become disabled
    // while the commit is in flight — not merely ignore later changes.
    renderPreview(state.validation);
    state.sent = true;
    state.attempts += 1;
    // Capture what is being sent and record the import id before anything
    // leaves: even a lost page keeps a checkable identity for this import.
    const importKey = state.importKey;
    const fileName = state.fileName;
    const csv = state.csv;
    // The default sends the whole file; the valid-rows choice also sends the
    // exact lines the preview showed as excluded, which the server re-checks.
    // The duplicate decisions travel with the same commit and are bound into
    // its digest, so the same key can never be replayed as a different choice.
    const options = state.validation.valid ? {} : { mode: 'valid_rows', excludedLines: validRowsSelection(state.validation).excludedLines };
    if (Object.keys(state.decisions).length > 0) options.duplicateDecisions = { ...state.decisions };
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
    const unconfirmed = state.importKey && (state.sent || state.preexistingPending) && state.result === null && pendingStore.entries().some((entry) => entry.importKey === state.importKey);
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
    const summaries = [];
    const details = [];
    for (const entry of pending) {
      const response = await client.lookup(entry.importKey);
      if (response && response.outcome === 'ok') {
        const record = response.body.import;
        const name = entry.fileName || entry.importKey;
        pendingStore.remove(entry.importKey);
        confirmed += 1;
        // The same skipped lines and reasons a normal success shows, from the
        // excluded rows the server stored with the import.
        summaries.push(`${name}: imported ${issueCountText(record)}.${skippedSentence(record)}`);
        details.push(...skippedDetails(record, `Not imported from ${name}`));
        // The visible preview of this very import is settled too (no commit can be
        // in flight here: this check only runs while the panel is idle).
        if (state.importKey === entry.importKey && state.result === null) {
          state.result = record;
          state.prior = null;
          renderPreview(null);
          validOnlyBox.hidden = true;
          checkButton.hidden = true;
          cancelButton.disabled = true;
          confirmButton.disabled = true;
          input.value = '';
        }
        onImported(record);
      } else {
        // Not found yet, unreachable or refused without a durable record:
        // none of these proves the import was not saved, so it stays pending.
        stillOpen += 1;
      }
    }
    state.busy = false;
    renderRecovery();
    if (confirmed > 0) showErrors(details);
    const summary = summaries.length > 0 ? ` ${summaries.join(' ')}` : '';
    status.textContent =
      confirmed > 0 && stillOpen > 0
        ? `${confirmed} unconfirmed import(s) are confirmed imported; ${stillOpen} still not confirmed.${summary}`
        : confirmed > 0
          ? `All ${confirmed} unconfirmed import(s) are confirmed imported.${summary}`
          : 'Still not confirmed: the server has no record yet, which does not prove they were not saved — the request may still be on its way. Check again in a moment.';
  });

  return { section, state, preview, reset };
}
