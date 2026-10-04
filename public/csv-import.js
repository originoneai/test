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

function validateRow(record, columns) {
  const errors = [];
  if (record.fields.length !== columns.length) {
    errors.push(`expected ${columns.length} field(s) like the header, found ${record.fields.length}.`);
  }
  const values = {};
  columns.forEach((column, index) => {
    values[column] = record.fields[index] ?? '';
  });
  const title = (values.title ?? '').trim();
  if (title.length < 1) errors.push('title is required.');
  else if (title.length > IMPORT_TITLE_MAX) errors.push(`title must be at most ${IMPORT_TITLE_MAX} characters.`);
  const description = values.description ?? IMPORT_DEFAULTS.description;
  if (description.length > IMPORT_DESCRIPTION_MAX) {
    errors.push(`description must be at most ${IMPORT_DESCRIPTION_MAX} characters.`);
  }
  const statusText = (values.status ?? '').trim();
  const status = statusText === '' ? IMPORT_DEFAULTS.status : statusText;
  if (!IMPORT_STATUSES.includes(status)) {
    errors.push(`status "${statusText}" is not one of: ${IMPORT_STATUSES.join(', ')}.`);
  }
  const priorityText = (values.priority ?? '').trim();
  const priority = priorityText === '' ? IMPORT_DEFAULTS.priority : priorityText;
  if (!IMPORT_PRIORITIES.includes(priority)) {
    errors.push(`priority "${priorityText}" is not one of: ${IMPORT_PRIORITIES.join(', ')}.`);
  }
  return {
    line: record.line,
    issue: { title, description, status, priority },
    errors,
  };
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

const RESULT_UNKNOWN = 'The import result could not be confirmed. Nothing will be sent twice: use Check result, or Import again — the same import is never applied twice.';

function newImportKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
    commit: (importKey, csv) =>
      call('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importKey, csv }),
      }),
    lookup: (importKey) => call('/api/imports/' + encodeURIComponent(importKey), { method: 'GET' }),
  };
}

export function mountImportPanel(root, { client = createImportClient(), doc = root.ownerDocument, onImported = () => {}, decode } = {}) {
  const el = (tag, attrs = {}, text) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const section = el('section', { class: 'import-panel', 'aria-labelledby': 'import-heading', 'data-role': 'import' });
  section.append(el('h2', { id: 'import-heading' }, 'Import historical issues (CSV)'));
  section.append(
    el('p', { class: 'hint' }, 'Columns: title (required), description, status (open, in_progress, done; default open), priority (low, normal, high, urgent; default normal). UTF-8, up to 500 issues. Nothing is saved until you confirm.'),
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
  section.append(status, errorBox, table, actions);
  root.append(section);

  const state = { csv: null, fileName: '', validation: null, importKey: null, busy: false, result: null };

  function showErrors(messages) {
    errorBox.replaceChildren(...messages.map((message) => el('p', {}, message)));
    errorBox.hidden = messages.length === 0;
  }

  function renderPreview(validation) {
    table.replaceChildren();
    if (!validation || validation.rows.length === 0) {
      table.hidden = true;
      return;
    }
    const head = el('thead');
    const headRow = el('tr');
    for (const name of ['Line', 'Title', 'Description', 'Status', 'Priority', 'Problems']) headRow.append(el('th', { scope: 'col' }, name));
    head.append(headRow);
    const body = el('tbody');
    for (const row of validation.rows) {
      const tr = el('tr', { 'data-role': 'import-row', class: row.errors.length ? 'has-error' : '' });
      tr.append(
        el('td', {}, String(row.line)),
        el('td', {}, row.issue.title),
        el('td', { class: 'import-description' }, row.issue.description),
        el('td', {}, row.issue.status),
        el('td', {}, row.issue.priority),
        el('td', { 'data-role': 'import-row-problems' }, row.errors.join(' ')),
      );
      body.append(tr);
    }
    table.append(head, body);
    table.hidden = false;
  }

  function reset(message = '') {
    Object.assign(state, { csv: null, fileName: '', validation: null, importKey: null, result: null });
    input.value = '';
    renderPreview(null);
    showErrors([]);
    status.textContent = message;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Import';
    cancelButton.disabled = true;
    checkButton.hidden = true;
  }

  function preview(text, fileName) {
    const validation = validateImportCsv(text);
    Object.assign(state, { csv: text, fileName, validation, importKey: newImportKey(), result: null });
    renderPreview(validation);
    const rowProblems = validation.rows.filter((row) => row.errors.length > 0);
    showErrors([
      ...validation.fileErrors,
      ...rowProblems.map((row) => `Line ${row.line}: ${row.errors.join(' ')}`),
    ]);
    cancelButton.disabled = false;
    checkButton.hidden = true;
    if (validation.valid) {
      confirmButton.disabled = false;
      confirmButton.textContent = `Import ${validation.rows.length} issue${validation.rows.length === 1 ? '' : 's'}`;
      status.textContent = `${fileName}: ${validation.rows.length} issue(s) ready. Review the preview, then confirm.`;
    } else {
      confirmButton.disabled = true;
      confirmButton.textContent = 'Import';
      status.textContent = `${fileName} cannot be imported: fix the problems listed and choose the file again. Nothing was saved.`;
    }
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
    const file = input.files && input.files[0];
    if (!file) return;
    const read = await readFile(file);
    if (read.error) {
      reset('');
      showErrors([read.error]);
      return;
    }
    preview(read.text, file.name);
  });

  function settle(response) {
    state.busy = false;
    if (response.outcome === 'ok') {
      const record = response.body.import;
      state.result = record;
      renderPreview(null);
      showErrors([]);
      checkButton.hidden = true;
      cancelButton.disabled = true;
      confirmButton.disabled = true;
      input.value = '';
      status.textContent = `Imported ${record.issueCount} issue${record.issueCount === 1 ? '' : 's'} from ${state.fileName || 'the file'}.${response.body.replayed ? ' (Already imported earlier; nothing was added again.)' : ''}`;
      onImported(record);
      return;
    }
    if (response.outcome === 'rejected') {
      const details = response.body.error.details;
      const lines = [response.body.error.message];
      if (details && Array.isArray(details.rowErrors)) {
        for (const row of details.rowErrors) lines.push(`Line ${row.line}: ${row.errors.join(' ')}`);
      }
      showErrors(lines);
      status.textContent = 'The server refused this import. Nothing was saved.';
      confirmButton.disabled = true;
      cancelButton.disabled = false;
      checkButton.hidden = true;
      return;
    }
    // Unknown outcome: keep the same import key so a retry is deduplicated.
    showErrors([RESULT_UNKNOWN]);
    status.textContent = 'Result unknown.';
    confirmButton.disabled = false;
    cancelButton.disabled = false;
    checkButton.hidden = false;
  }

  confirmButton.addEventListener('click', async () => {
    if (state.busy || !state.validation || !state.validation.valid) return;
    state.busy = true;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    status.textContent = 'Importing…';
    settle(await client.commit(state.importKey, state.csv));
  });

  checkButton.addEventListener('click', async () => {
    if (state.busy || !state.importKey) return;
    state.busy = true;
    status.textContent = 'Checking…';
    const response = await client.lookup(state.importKey);
    if (response.outcome === 'rejected' && response.status === 404) {
      state.busy = false;
      showErrors(['This import was not saved. You can import it now.']);
      status.textContent = 'Not imported yet.';
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      checkButton.hidden = true;
      return;
    }
    settle(response);
  });

  cancelButton.addEventListener('click', () => {
    if (state.busy) return;
    reset('Import cancelled. Nothing was saved.');
  });

  return { section, state, preview, reset };
}
