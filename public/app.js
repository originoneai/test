// Team issue tracker board (NATIVE-UI).
//
// DATA
// The board reads and changes issues only through the live issue API served by
// src/server.js (docs/api.md). There is no demo or fixture data in the page and
// no offline fallback: if the API cannot be reached, the board says so.
//
// The adapter interface follows docs/api.md:
//   list({ status, q }) -> Promise<Issue[]>          (GET   /api/issues)
//   create({ title, description }) -> Promise<Issue> (POST  /api/issues)
//   update(id, patch) -> Promise<Issue>              (PATCH /api/issues/:id)
// Failures reject with ApiError { code, message, status, outcomeUnknown }.
// outcomeUnknown is true when no trustworthy answer came back (the connection
// failed, the response could not be read as the contract shape, or a save
// response did not show the submitted values). For a save, that means the server
// may or may not have applied it. The board then keeps the user's draft, asks
// the server for its current values and leaves the next step to the user; it
// never re-sends a change on its own.
//
// Rendering never uses innerHTML: every piece of issue text is assigned through
// textContent, so HTML-like input is shown as text.

export const STATUSES = ['open', 'in_progress', 'done'];
export const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', done: 'Done' };
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 4000;

export class ApiError extends Error {
  constructor(code, message, status = 0, { outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (shared by the UI and both adapters)
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = ['title', 'description', 'status'];

/**
 * Validate create/edit input against the product contract.
 * Returns { errors, value }; errors is keyed by field (or "form").
 */
export function validateIssueInput(input, { partial = false } = {}) {
  const errors = {};
  const value = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: { form: 'Invalid input.' }, value };
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.includes(key)) errors[key] = 'Unknown field.';
  }
  if (!partial || 'title' in input) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) errors.title = 'Title is required.';
    else if (title.length > TITLE_MAX) errors.title = `Title must be at most ${TITLE_MAX} characters.`;
    else value.title = title;
  }
  if ('description' in input) {
    if (typeof input.description !== 'string') errors.description = 'Description must be text.';
    else if (input.description.length > DESCRIPTION_MAX) {
      errors.description = `Description must be at most ${DESCRIPTION_MAX} characters.`;
    } else value.description = input.description;
  }
  if ('status' in input) {
    if (!STATUSES.includes(input.status)) errors.status = 'Choose a valid status.';
    else value.status = input.status;
  }
  if (partial && Object.keys(input).length === 0) errors.form = 'Nothing to update.';
  return { errors, value };
}

export function groupByStatus(issues) {
  const groups = Object.fromEntries(STATUSES.map(s => [s, []]));
  for (const issue of issues) if (groups[issue.status]) groups[issue.status].push(issue);
  return groups;
}

const isIsoTime = value => typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));

/** True when `value` has the issue shape from specs/issue-tracker.md. */
export function isValidIssue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { id, title, description, status, createdAt, updatedAt } = value;
  return typeof id === 'string' && id !== ''
    && typeof title === 'string' && title.trim().length >= 1 && title.trim().length <= TITLE_MAX
    && typeof description === 'string' && description.length <= DESCRIPTION_MAX
    && STATUSES.includes(status)
    && isIsoTime(createdAt) && isIsoTime(updatedAt);
}

/**
 * True when a returned issue shows every submitted field. The contract stores
 * titles trimmed, so a title is compared after trimming; description and status
 * must match exactly.
 */
export function matchesSubmitted(issue, submitted) {
  if (!isValidIssue(issue) || !submitted || typeof submitted !== 'object') return false;
  if ('title' in submitted && issue.title !== String(submitted.title).trim()) return false;
  if ('description' in submitted && issue.description !== submitted.description) return false;
  if ('status' in submitted && issue.status !== submitted.status) return false;
  return true;
}

export const UNCONFIRMED_MESSAGE = 'The server’s reply does not show the values that were submitted.';

/**
 * Return `issue` only if it confirms this save: the expected id (for an edit)
 * and every submitted field. Otherwise reject as an unknown outcome, because the
 * server answered but did not show that it stored what the user sent.
 */
export function confirmSaved(issue, submitted, { id, status = 0 } = {}) {
  if (!isValidIssue(issue) || (id !== undefined && issue.id !== id) || !matchesSubmitted(issue, submitted)) {
    throw new ApiError('UNCONFIRMED_RESULT', UNCONFIRMED_MESSAGE, status, { outcomeUnknown: true });
  }
  return issue;
}

/** The fields a created issue must show: the submitted text and the defaults. */
export function expectedCreate(input) {
  return { title: String(input.title).trim(), description: input.description ?? '', status: 'open' };
}

// ---------------------------------------------------------------------------
// Live API adapter
// ---------------------------------------------------------------------------

export function createHttpAdapter({ fetchImpl = (...args) => globalThis.fetch(...args), base = '' } = {}) {
  const unreadable = status => new ApiError('INVALID_RESPONSE',
    'The server sent a response the board could not read.', status, { outcomeUnknown: true });
  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('NETWORK_ERROR', 'The connection to the server failed.', 0, { outcomeUnknown: true });
    }
    let data;
    let parsed = true;
    try { data = await res.json(); } catch { parsed = false; }
    if (!res.ok) {
      const err = parsed && data && typeof data === 'object' ? data.error : null;
      // A contract error body is a definite answer from the API. Anything else
      // (for example a gateway HTML page) says nothing about what happened.
      if (err && typeof err.code === 'string' && typeof err.message === 'string') {
        throw new ApiError(err.code, err.message, res.status);
      }
      throw new ApiError(`HTTP_${res.status}`, `The server answered with an unexpected error (${res.status}).`, res.status, { outcomeUnknown: true });
    }
    if (!parsed) throw unreadable(res.status);
    return { data, status: res.status };
  }
  async function issueFrom(method, path, body, { id, expected }) {
    const { data, status } = await request(method, path, body);
    if (!isValidIssue(data)) throw unreadable(status);
    return confirmSaved(data, expected, { id, status });
  }
  return {
    mode: 'api',
    async list({ status = '', q = '' } = {}) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      const query = params.toString();
      const { data, status: code } = await request('GET', '/api/issues' + (query ? '?' + query : ''));
      // Only a well-formed { items: [...] } may replace the board; an empty
      // array is a real empty list, anything malformed is an error.
      if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !data.items.every(isValidIssue)) {
        throw unreadable(code);
      }
      return data.items;
    },
    create(input) { return issueFrom('POST', '/api/issues', input, { expected: expectedCreate(input) }); },
    update(id, patch) {
      return issueFrom('PATCH', '/api/issues/' + encodeURIComponent(id), patch, { id, expected: patch });
    },
  };
}

// ---------------------------------------------------------------------------
// User interface
// ---------------------------------------------------------------------------

function h(doc, tag, props = {}, ...children) {
  const el = doc.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (val == null || val === false) continue;
    if (key === 'class') el.className = val;
    else if (key === 'text') el.textContent = val;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), val);
    else if (key === 'hidden' || key === 'disabled') el[key] = true;
    else el.setAttribute(key, val === true ? '' : String(val));
  }
  const kids = children.flat().filter(c => c != null && c !== false);
  if (kids.length) el.append(...kids);
  return el;
}

function statusSelect(doc, id, { includeAll = false } = {}) {
  const select = h(doc, 'select', { id });
  if (includeAll) select.append(h(doc, 'option', { value: '', text: 'All statuses' }));
  for (const status of STATUSES) select.append(h(doc, 'option', { value: status, text: STATUS_LABELS[status] }));
  return select;
}

function describe(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return 'Something went wrong.';
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? '');
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Mount the board into `root`. Returns a small handle for tests and integration.
 * options: { adapter, doc, searchDelayMs }
 */
export function mountApp(root, { adapter, doc = root.ownerDocument, searchDelayMs = 200 } = {}) {
  if (!adapter) throw new Error('mountApp requires an adapter');
  const state = { issues: [], filters: { status: '', q: '' }, loading: false, loadError: null, loadSeq: 0 };
  // Controls of the cards on screen, per issue id, and each column's order, so
  // focus can go back to a control that is still on the page after a render.
  const cardControls = new Map(); // id -> { edit, select, title }
  const columnIds = Object.fromEntries(STATUSES.map(s => [s, []]));
  // Last position of every issue that has been shown: { status, index, title }.
  // Kept after the card is gone so focus can move to its neighbour.
  const lastSeen = new Map();
  let searchTimer = null;

  // --- header -------------------------------------------------------------
  const header = h(doc, 'header', { class: 'app-header' },
    h(doc, 'p', { class: 'eyebrow', text: 'Origin One AI · Team trial' }),
    h(doc, 'h1', { text: 'Issue tracker' }),
  );
  header.append(h(doc, 'p', { class: 'data-source', 'data-role': 'data-source',
    text: 'Live data from this server. Saved changes are kept after a reload or restart and are visible to everyone using this board.' }));

  // --- announcements --------------------------------------------------------
  const live = h(doc, 'p', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-role': 'announcer' });
  const announce = message => { live.textContent = ''; live.textContent = message; };

  // --- new issue form -------------------------------------------------------
  const newTitle = h(doc, 'input', { id: 'new-title', name: 'title', type: 'text', autocomplete: 'off', required: true, 'aria-describedby': 'new-title-hint new-title-error' });
  const newTitleError = h(doc, 'p', { id: 'new-title-error', class: 'field-error', 'data-role': 'new-title-error', hidden: true });
  const newDescription = h(doc, 'textarea', { id: 'new-description', name: 'description', rows: '3', 'aria-describedby': 'new-description-error' });
  const newDescriptionError = h(doc, 'p', { id: 'new-description-error', class: 'field-error', hidden: true });
  const createButton = h(doc, 'button', { type: 'submit', class: 'button primary', 'data-role': 'create-submit', text: 'Create issue' });
  const createError = h(doc, 'p', { class: 'form-error', role: 'alert', 'data-role': 'create-error', hidden: true });
  // Visible while a create request is in flight. The fields stay editable so the
  // user can start the next draft; the notice says that draft will be kept.
  const createPending = h(doc, 'p', { class: 'form-pending', role: 'status', 'aria-live': 'polite', 'data-role': 'create-pending', hidden: true });
  const createForm = h(doc, 'form', { class: 'panel new-issue', 'aria-labelledby': 'new-issue-heading', novalidate: true, 'data-role': 'create-form' },
    h(doc, 'h2', { id: 'new-issue-heading', text: 'New issue' }),
    h(doc, 'div', { class: 'field' },
      h(doc, 'label', { for: 'new-title', text: 'Title' }),
      newTitle,
      h(doc, 'p', { id: 'new-title-hint', class: 'hint', text: `Required, up to ${TITLE_MAX} characters.` }),
      newTitleError,
    ),
    h(doc, 'div', { class: 'field' },
      h(doc, 'label', { for: 'new-description', text: 'Description (optional)' }),
      newDescription,
      newDescriptionError,
    ),
    createError,
    createPending,
    h(doc, 'div', { class: 'form-actions' }, createButton),
  );

  // --- toolbar ----------------------------------------------------------------
  const searchInput = h(doc, 'input', { id: 'search', type: 'search', autocomplete: 'off', placeholder: 'Title or description', 'data-role': 'search' });
  const filterSelect = statusSelect(doc, 'status-filter', { includeAll: true });
  filterSelect.setAttribute('data-role', 'status-filter');
  // Asks the server for the current list, for example to see a teammate's changes.
  const refreshButton = h(doc, 'button', { type: 'button', class: 'button', 'data-role': 'refresh', text: 'Refresh' });
  const toolbar = h(doc, 'section', { class: 'panel toolbar', role: 'search', 'aria-label': 'Filter issues' },
    h(doc, 'div', { class: 'field grow' }, h(doc, 'label', { for: 'search', text: 'Search issues' }), searchInput),
    h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: 'status-filter', text: 'Status' }), filterSelect),
    h(doc, 'div', { class: 'field toolbar-action' }, refreshButton),
  );

  // --- board ------------------------------------------------------------------
  const boardStatus = h(doc, 'p', { class: 'board-status', role: 'status', 'data-role': 'board-status' });
  const loadErrorText = h(doc, 'span', { 'data-role': 'load-error-text' });
  const retryButton = h(doc, 'button', { type: 'button', class: 'button', 'data-role': 'retry', text: 'Retry' });
  const loadErrorBox = h(doc, 'div', { class: 'notice error', role: 'alert', 'data-role': 'load-error', hidden: true }, loadErrorText, ' ', retryButton);
  const actionErrorText = h(doc, 'span', { 'data-role': 'action-error-text' });
  const dismissButton = h(doc, 'button', { type: 'button', class: 'button subtle', text: 'Dismiss' });
  const actionErrorBox = h(doc, 'div', { class: 'notice error', role: 'alert', 'data-role': 'action-error', hidden: true }, actionErrorText, ' ', dismissButton);
  const columns = {};
  const board = h(doc, 'div', { class: 'board', 'data-role': 'board', 'aria-busy': 'false' });
  for (const status of STATUSES) {
    const headingId = `column-${status}-heading`;
    const count = h(doc, 'span', { class: 'count', 'data-role': `count-${status}`, text: '0' });
    const list = h(doc, 'ul', { class: 'cards', 'aria-labelledby': headingId, 'data-role': `list-${status}` });
    const empty = h(doc, 'p', { class: 'empty', 'data-role': `empty-${status}`, hidden: true });
    const column = h(doc, 'section', { class: `column column-${status}`, 'aria-labelledby': headingId, 'data-role': `column-${status}` },
      h(doc, 'h2', { id: headingId }, STATUS_LABELS[status], ' ', count),
      list,
      empty,
    );
    columns[status] = { count, list, empty };
    board.append(column);
  }

  // --- edit dialog ------------------------------------------------------------
  const editTitle = h(doc, 'input', { id: 'edit-title', name: 'title', type: 'text', required: true, autocomplete: 'off', 'aria-describedby': 'edit-title-error' });
  const editTitleError = h(doc, 'p', { id: 'edit-title-error', class: 'field-error', hidden: true, 'data-role': 'edit-title-error' });
  const editDescription = h(doc, 'textarea', { id: 'edit-description', name: 'description', rows: '5', 'aria-describedby': 'edit-description-error' });
  const editDescriptionError = h(doc, 'p', { id: 'edit-description-error', class: 'field-error', hidden: true });
  const editStatus = statusSelect(doc, 'edit-status');
  const editError = h(doc, 'p', { class: 'form-error', role: 'alert', hidden: true, 'data-role': 'edit-error' });
  const editSave = h(doc, 'button', { type: 'submit', class: 'button primary', 'data-role': 'edit-save', text: 'Save changes' });
  const editCancel = h(doc, 'button', { type: 'button', class: 'button', 'data-role': 'edit-cancel', text: 'Cancel' });
  // Shown only after a save whose outcome is unknown: asks the API for the
  // current issue again without leaving the dialog or losing the draft.
  const editCheck = h(doc, 'button', { type: 'button', class: 'button', 'data-role': 'edit-check', text: 'Check again', hidden: true });
  // After an unconfirmed save: what the server shows now, next to the draft.
  const editCompare = h(doc, 'p', { class: 'form-compare', 'data-role': 'edit-compare', hidden: true });
  const editAdopt = h(doc, 'button', { type: 'button', class: 'button', 'data-role': 'edit-adopt', text: 'Use server values', hidden: true });
  // Progress and follow-up notice for an edit save. The fields stay editable
  // while a save is in flight; anything typed meanwhile is kept, never closed away.
  const editNotice = h(doc, 'p', { class: 'form-pending', role: 'status', 'aria-live': 'polite', 'data-role': 'edit-notice', hidden: true });
  const editForm = h(doc, 'form', { novalidate: true, 'data-role': 'edit-form' },
    h(doc, 'h2', { id: 'edit-heading', text: 'Edit issue' }),
    h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: 'edit-title', text: 'Title' }), editTitle, editTitleError),
    h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: 'edit-description', text: 'Description' }), editDescription, editDescriptionError),
    h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: 'edit-status', text: 'Status' }), editStatus),
    editNotice,
    editError,
    editCompare,
    h(doc, 'div', { class: 'form-actions' }, editCancel, editCheck, editAdopt, editSave),
  );
  const dialog = h(doc, 'dialog', { class: 'edit-dialog', 'aria-labelledby': 'edit-heading', 'data-role': 'edit-dialog' }, editForm);
  // seed: per field, the server value that field was last filled from.
  // unconfirmed: { id, submitted, before, reason } after a save with an unknown outcome.
  const edit = { issue: null, seed: null, trigger: null, saving: false, open: false, unconfirmed: null, serverIssue: null };

  root.replaceChildren(
    header,
    live,
    h(doc, 'div', { class: 'layout' },
      h(doc, 'aside', { class: 'sidebar' }, createForm),
      h(doc, 'div', { class: 'main' }, toolbar, loadErrorBox, actionErrorBox, boardStatus, board),
    ),
    dialog,
  );

  // --- helpers -----------------------------------------------------------------
  function setFieldError(input, errorEl, message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  function showBox(box, textEl, message) {
    textEl.textContent = message || '';
    box.hidden = !message;
  }
  function filtersActive() { return Boolean(state.filters.status || state.filters.q.trim()); }

  function renderCard(issue) {
    const title = h(doc, 'h3', { class: 'card-title', 'data-role': 'card-title' });
    title.textContent = issue.title;
    const card = h(doc, 'article', { class: 'card', 'data-issue-id': issue.id, 'data-role': 'card' }, title);
    if (issue.description) {
      const desc = h(doc, 'p', { class: 'card-description', 'data-role': 'card-description' });
      desc.textContent = issue.description;
      card.append(desc);
    }
    const time = h(doc, 'time', { datetime: issue.updatedAt || issue.createdAt });
    time.textContent = formatTime(issue.updatedAt || issue.createdAt);
    card.append(h(doc, 'p', { class: 'meta' }, 'Updated ', time));

    const selectId = `status-${issue.id}`;
    const select = statusSelect(doc, selectId);
    select.value = issue.status;
    select.setAttribute('data-role', 'card-status');
    select.setAttribute('data-issue-id', issue.id);
    const selectLabel = h(doc, 'label', { for: selectId, class: 'sr-only' });
    selectLabel.textContent = `Status for ${issue.title}`;
    select.addEventListener('change', () => moveIssue(issue, select, card));
    const editButton = h(doc, 'button', { type: 'button', class: 'button subtle', 'data-role': 'card-edit', text: 'Edit' });
    editButton.setAttribute('aria-label', `Edit issue: ${issue.title}`);
    editButton.setAttribute('data-issue-id', issue.id);
    editButton.addEventListener('click', () => openEdit(issue, editButton));
    cardControls.set(issue.id, { edit: editButton, select, title: issue.title });
    card.append(h(doc, 'div', { class: 'card-actions' }, selectLabel, select, editButton));
    return h(doc, 'li', {}, card);
  }

  // Which card control has focus right now, if any: { id, role }.
  function focusedCardControl() {
    const active = doc.activeElement;
    const id = active?.getAttribute?.('data-issue-id');
    const controls = id ? cardControls.get(id) : null;
    if (!controls) return null;
    if (active === controls.edit) return { id, role: 'card-edit' };
    if (active === controls.select) return { id, role: 'card-status' };
    return null;
  }

  /**
   * Put focus back on a card control that is still on the page. Prefers the
   * same control of the same issue; if that card is gone (a filter, a deletion
   * or a refresh removed it), moves to the Edit button of the card now in its
   * place in the same column, else to the Refresh button, and says why.
   * Returns the element that received focus.
   */
  function restoreCardFocus(id, role = 'card-edit', { prefix = '', gone = '' } = {}) {
    const controls = cardControls.get(id);
    const same = controls && (role === 'card-status' ? controls.select : controls.edit);
    if (same && same.isConnected && !same.disabled) {
      same.focus();
      if (prefix) announce(prefix);
      return same;
    }
    const seen = lastSeen.get(id);
    const reason = gone || (seen ? `“${seen.title}” is no longer shown on the board.` : 'That issue is no longer shown on the board.');
    const lead = prefix ? `${prefix} ${reason}` : reason;
    const ids = seen ? columnIds[seen.status] : [];
    if (ids.length > 0) {
      const neighbour = cardControls.get(ids[Math.min(seen.index, ids.length - 1)]);
      if (neighbour?.edit.isConnected) {
        neighbour.edit.focus();
        announce(`${lead} Focus moved to “${neighbour.title}” in ${STATUS_LABELS[seen.status]}.`);
        return neighbour.edit;
      }
    }
    refreshButton.focus();
    announce(`${lead} Focus moved to the Refresh button.`);
    return refreshButton;
  }

  function render() {
    // Re-rendering replaces the cards, so remember which card control had focus.
    const hadFocus = focusedCardControl();
    board.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    board.classList.toggle('is-loading', state.loading);
    const keptList = state.loadError && state.issues.length > 0;
    showBox(loadErrorBox, loadErrorText, state.loadError
      ? `Could not load issues: ${describe(state.loadError)} ${keptList ? 'The board still shows the last list that loaded.' : 'The list was not updated.'} Try again.`
      : '');
    const groups = groupByStatus(state.issues);
    cardControls.clear();
    for (const status of STATUSES) {
      const { count, list, empty } = columns[status];
      const items = groups[status];
      count.textContent = String(items.length);
      list.replaceChildren(...items.map(renderCard));
      columnIds[status] = items.map(issue => issue.id);
      items.forEach((issue, index) => lastSeen.set(issue.id, { status, index, title: issue.title }));
      const label = STATUS_LABELS[status].toLowerCase();
      empty.textContent = filtersActive() ? `No ${label} issues match these filters.` : `No ${label} issues.`;
      // An empty column is only claimed after a successful load.
      empty.hidden = items.length > 0 || state.loading || Boolean(state.loadError);
    }
    if (state.loading) boardStatus.textContent = 'Loading issues…';
    else if (state.loadError) boardStatus.textContent = state.issues.length > 0 ? 'Issues could not be refreshed. Showing the last list that loaded.' : 'Issues could not be loaded.';
    else if (state.issues.length === 0) boardStatus.textContent = filtersActive() ? 'No issues match your search.' : 'No issues yet. Create the first one.';
    else boardStatus.textContent = `${state.issues.length} ${state.issues.length === 1 ? 'issue' : 'issues'} shown.`;
    boardStatus.classList.toggle('is-loading', state.loading);
    // aria-disabled rather than disabled: disabling a focused button would drop
    // keyboard focus to the page whenever a load starts (for example the search
    // debounce firing just after focus was moved here).
    refreshButton.setAttribute('aria-disabled', state.loading ? 'true' : 'false');
    refreshButton.textContent = state.loading ? 'Refreshing…' : 'Refresh';
    if (hadFocus) restoreCardFocus(hadFocus.id, hadFocus.role);
  }

  async function load() {
    const seq = ++state.loadSeq;
    state.loading = true;
    render();
    try {
      const items = await adapter.list({ ...state.filters });
      if (seq !== state.loadSeq) return;
      state.issues = items;
      state.loadError = null;
    } catch (error) {
      if (seq !== state.loadSeq) return;
      state.loadError = error;
    }
    state.loading = false;
    render();
  }

  // The board's filters applied to an unfiltered list, with the same rules as
  // the API (docs/api.md, src/store.js): exact status, and q as a
  // case-insensitive substring of the title or description.
  function applyFilters(items, { status = '', q = '' } = {}) {
    const needle = q ? q.toLowerCase() : '';
    return items.filter(issue => (!status || issue.status === status)
      && (!needle || issue.title.toLowerCase().includes(needle)
        || (issue.description || '').toLowerCase().includes(needle)));
  }

  /**
   * One read of the server for recovery after an unknown outcome. The advice,
   * the comparison, "Use server values" and the board are all taken from this
   * single unfiltered list (the board applies the current filters to it), so
   * they cannot disagree. Any load still in flight is discarded. If the user
   * starts a newer load before this read returns, the board shows that newer
   * load instead and `boardShowsIt` is false.
   * Returns { items } or { error }, plus boardShowsIt.
   */
  async function observe() {
    const seq = ++state.loadSeq;
    state.loading = true;
    render();
    let result;
    try {
      result = { items: await adapter.list({}) };
    } catch (error) {
      result = { error };
    }
    result.boardShowsIt = seq === state.loadSeq;
    if (result.boardShowsIt) {
      if (result.error) state.loadError = result.error;
      else {
        state.issues = applyFilters(result.items, state.filters);
        state.loadError = null;
      }
      state.loading = false;
      render();
    }
    return result;
  }
  const boardNote = obs => (obs.boardShowsIt
    ? ' The board below shows the same check.'
    : ' The board below was loaded again after this check and may show newer values.');
  const quoteText = text => (text ? `“${text}”` : '(empty)');
  function issueSummary(issue) {
    return `title ${quoteText(issue.title)}, status ${STATUS_LABELS[issue.status] ?? issue.status}, description ${quoteText(issue.description)}`;
  }

  // --- create ---------------------------------------------------------------------
  let creating = false;
  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (creating) return;
    showBox(createError, createError, '');
    // Snapshot exactly what was submitted. The fields stay editable while the
    // request is in flight, so on success we only clear the form if the user has
    // not started a new draft in the meantime; a changed draft is never cleared.
    const submitted = { title: newTitle.value, description: newDescription.value };
    const { errors, value } = validateIssueInput(submitted);
    setFieldError(newTitle, newTitleError, errors.title);
    setFieldError(newDescription, newDescriptionError, errors.description);
    if (errors.title || errors.description) {
      (errors.title ? newTitle : newDescription).focus();
      return;
    }
    const draftUnchanged = () => newTitle.value === submitted.title && newDescription.value === submitted.description;
    creating = true;
    createButton.disabled = true;
    createButton.textContent = 'Saving…';
    createForm.setAttribute('aria-busy', 'true');
    showBox(createPending, createPending, `Saving “${value.title}”… You can keep typing your next issue; it will not be cleared.`);
    try {
      const input = { title: value.title, description: value.description ?? '' };
      // Only a reply that shows what was submitted counts as saved.
      const created = confirmSaved(await adapter.create(input), expectedCreate(input));
      if (draftUnchanged()) {
        newTitle.value = '';
        newDescription.value = '';
        announce(`Issue created: ${created.title}`);
      } else {
        announce(`Issue created: ${created.title}. Your new draft was kept.`);
      }
      await load();
    } catch (error) {
      const unchanged = draftUnchanged();
      if (error?.outcomeUnknown) {
        // The request may have reached the server; never say it was not saved,
        // and never create it again automatically (docs/api.md: a blind re-post
        // can duplicate). Look for a matching issue and let the user decide.
        const kept = unchanged ? 'Your text is kept.' : 'Your newer draft was left unchanged.';
        const input = { title: value.title, description: value.description ?? '' };
        showBox(createPending, createPending, `Checking the server for “${value.title}”…`);
        const obs = await observe();
        let check;
        if (obs.error) check = `The server could not be checked either: ${describe(obs.error)} Look for it on the board before creating it again.`;
        else {
          const matches = obs.items.filter(item => item.title === input.title && item.description === input.description);
          check = matches.length > 0
            ? `When checked just now, the server showed ${matches.length === 1 ? 'an issue' : `${matches.length} issues`} with this title and description.${boardNote(obs)} It may be yours or a teammate’s; creating it again could add a duplicate.`
            : `When checked just now, the server showed no issue with this title and description.${boardNote(obs)} That does not show whether your request failed. If it still does not appear after a Refresh, you can create it again.`;
        }
        showBox(createError, createError, `Could not confirm whether “${value.title}” was saved: ${describe(error)} ${check} ${kept}`);
      } else {
        const kept = unchanged
          ? 'Your text is kept so you can try again.'
          : `“${value.title}” was not saved. Your newer draft was left unchanged.`;
        showBox(createError, createError, `Could not create the issue: ${describe(error)} ${kept}`);
      }
    } finally {
      creating = false;
      createButton.disabled = false;
      createButton.textContent = 'Create issue';
      createForm.setAttribute('aria-busy', 'false');
      showBox(createPending, createPending, '');
    }
  });

  async function moveIssue(issue, select, card) {
    const previous = issue.status;
    const next = select.value;
    if (next === previous) return;
    select.disabled = true;
    card.setAttribute('aria-busy', 'true');
    showBox(actionErrorBox, actionErrorText, '');
    try {
      confirmSaved(await adapter.update(issue.id, { status: next }), { status: next }, { id: issue.id });
      await load();
      restoreCardFocus(issue.id, 'card-edit', { prefix: `Moved “${issue.title}” to ${STATUS_LABELS[next]}.` });
    } catch (error) {
      select.value = previous;
      select.disabled = false;
      card.setAttribute('aria-busy', 'false');
      if (error?.outcomeUnknown) {
        // One read of the server (all statuses) for both the advice and the board.
        const obs = await observe();
        const now = obs.error ? null : obs.items.find(item => item.id === issue.id) ?? null;
        let seen;
        if (obs.error) seen = `The server could not be checked either: ${describe(obs.error)} Check the board before trying again.`;
        else if (!now) seen = `When checked just now, the server did not show this issue.${boardNote(obs)}`;
        else if (now.status === next) seen = `When checked just now, the server showed it in ${STATUS_LABELS[next]}.${boardNote(obs)} Nothing more needs sending.`;
        else seen = `When checked just now, the server showed it in ${STATUS_LABELS[now.status]}.${boardNote(obs)} Choose ${STATUS_LABELS[next]} again if you still want to move it.`;
        showBox(actionErrorBox, actionErrorText, `Could not confirm whether “${issue.title}” moved to ${STATUS_LABELS[next]}: ${describe(error)} ${seen}`);
        restoreCardFocus(issue.id, 'card-status');
      } else if (error?.code === 'NOT_FOUND') {
        showBox(actionErrorBox, actionErrorText, `Could not change the status of “${issue.title}”: the server no longer has this issue. The board was refreshed.`);
        await load();
        restoreCardFocus(issue.id, 'card-edit', { gone: `The server no longer has “${issue.title}”.` });
      } else {
        showBox(actionErrorBox, actionErrorText, `Could not change the status of “${issue.title}”: ${describe(error)}`);
        if (select.isConnected) select.focus();
        else restoreCardFocus(issue.id, 'card-status');
      }
    }
  }

  // --- edit dialog -------------------------------------------------------------------
  //
  // The dialog tracks, per field, the server value that field was last filled
  // from (its "seed"). A field counts as edited only while its input differs
  // from its own seed, and a save sends only edited fields. When a server
  // observation of the issue arrives (a confirmed save reply, or the check
  // after an unknown outcome), fields the user has not edited take the server's
  // value, and edited fields, including anything typed while the request was
  // running, are kept. The whole stale form is never compared against a newer
  // server copy, so a teammate's change to a field the user did not touch is
  // never sent back.
  const FIELDS = ['title', 'description', 'status'];
  const FIELD_LABELS = { title: 'Title', description: 'Description', status: 'Status' };
  const fieldInputs = { title: editTitle, description: editDescription, status: editStatus };
  const serverValue = (issue, field) => (field === 'description' ? issue.description || '' : issue[field]);
  // Titles are stored trimmed (contract), so they are compared trimmed.
  const sameValue = (field, a, b) => (field === 'title' ? String(a).trim() === String(b).trim() : a === b);
  const editedFields = () => FIELDS.filter(field => !sameValue(field, fieldInputs[field].value, edit.seed[field]));
  function editPatch() {
    const patch = {};
    for (const field of editedFields()) patch[field] = fieldInputs[field].value;
    return patch;
  }
  function seedFrom(issue) {
    edit.issue = issue;
    edit.seed = Object.fromEntries(FIELDS.map(field => [field, serverValue(issue, field)]));
    for (const field of FIELDS) fieldInputs[field].value = edit.seed[field];
  }
  // Take in a server observation of this issue without touching edited fields.
  function syncFromServer(issue) {
    for (const field of FIELDS) {
      const value = serverValue(issue, field);
      const input = fieldInputs[field];
      if (sameValue(field, input.value, edit.seed[field])) input.value = value;
      edit.seed[field] = value;
    }
    edit.issue = issue;
  }
  const fieldList = fields => fields.map(field => FIELD_LABELS[field].toLowerCase()).join(', ');

  function openEdit(issue, trigger) {
    edit.trigger = trigger;
    seedFrom(issue);
    setFieldError(editTitle, editTitleError, '');
    setFieldError(editDescription, editDescriptionError, '');
    showBox(editError, editError, '');
    showBox(editNotice, editNotice, '');
    edit.unconfirmed = null;
    editCheck.hidden = true;
    hideCompare();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    edit.open = true;
    editTitle.focus();
  }

  // message: announced together with where focus went.
  function closeEdit({ message = '' } = {}) {
    if (!edit.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    edit.open = false;
    const id = edit.issue?.id;
    const trigger = edit.trigger;
    edit.issue = null;
    edit.trigger = null;
    edit.unconfirmed = null;
    editCheck.hidden = true;
    hideCompare();
    showBox(editNotice, editNotice, '');
    // The card that opened the dialog may have been re-rendered, filtered out or
    // deleted meanwhile: only focus a control that is still on the page.
    if (id) restoreCardFocus(id, 'card-edit', { prefix: message });
    else {
      (trigger?.isConnected ? trigger : refreshButton).focus();
      if (message) announce(message);
    }
  }

  editCancel.addEventListener('click', () => { if (!edit.saving) closeEdit(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!edit.saving) closeEdit();
    }
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!edit.saving) closeEdit();
  });

  function hideCompare() {
    showBox(editCompare, editCompare, '');
    editAdopt.hidden = true;
    edit.serverIssue = null;
  }
  const editFields = [editTitle, editDescription, editStatus];

  function setEditBusy(busy, label) {
    edit.saving = busy;
    editSave.disabled = busy;
    editCancel.disabled = busy;
    editCheck.disabled = busy;
    editAdopt.disabled = busy;
    editSave.textContent = busy && label ? label : 'Save changes';
    editForm.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  // After a save with an unknown outcome, read the server once (all statuses,
  // no search, so filters cannot hide the issue). The advice, the comparison,
  // "Use server values" and the board behind the dialog all come from that one
  // read. Fields the user did not edit take the server's values; edited fields
  // stay as typed. The wording reports what the server showed at this check; it
  // does not claim to know whether the original request was applied.
  async function checkEdit() {
    const pending = edit.unconfirmed;
    if (!pending || edit.saving) return;
    const lead = `Could not confirm whether your changes were saved: ${pending.reason}`;
    setEditBusy(true, 'Checking…');
    showBox(editError, editError, `${lead} Checking the server…`);
    const obs = await observe();
    setEditBusy(false);
    if (edit.unconfirmed !== pending || !edit.open) return;
    const kept = 'Your edits are kept here.';
    hideCompare();
    if (obs.error) {
      showBox(editError, editError, `${lead} The server could not be checked either: ${describe(obs.error)} ${kept} Choose Check again, or Save changes to send only the fields you edited (${fieldList(editedFields())}).`);
      editCheck.focus();
      return;
    }
    const latest = obs.items.find(item => item.id === pending.id) ?? null;
    if (!latest) {
      showBox(editError, editError, `${lead} When checked just now, the server did not show this issue.${boardNote(obs)} ${kept} Choose Check again, or Cancel to close.`);
      editCheck.focus();
      return;
    }
    // Per submitted field: does the server show the value sent, the value from
    // before the save, or something else?
    const sent = Object.keys(pending.submitted);
    const shows = sent.map(field => {
      const now = serverValue(latest, field);
      if (sameValue(field, now, pending.submitted[field])) return { field, kind: 'sent' };
      if (sameValue(field, now, pending.before[field])) return { field, kind: 'before' };
      return { field, kind: 'other' };
    });
    const phrase = ({ field, kind }) => {
      const name = FIELD_LABELS[field].toLowerCase();
      if (kind === 'sent') return `the ${name} you sent`;
      if (kind === 'before') return `the ${name} from before your save`;
      return `a different ${name} (possibly a teammate’s change)`;
    };
    const phrases = shows.map(phrase);
    const joined = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}` : phrases[0];
    const observed = `When checked just now, the server showed ${joined}.${boardNote(obs)}`;
    syncFromServer(latest);
    if (shows.every(s => s.kind === 'sent')) {
      edit.unconfirmed = null;
      editCheck.hidden = true;
      if (editedFields().length === 0) {
        showBox(editError, editError, '');
        closeEdit({ message: `${observed} Nothing more needs sending for “${latest.title}”.` });
      } else {
        showBox(editError, editError, `${observed} Nothing more needs sending for those fields. Your newer edits (${fieldList(editedFields())}) are still here and have not been saved.`);
        editSave.focus();
      }
      return;
    }
    const edited = editedFields();
    const next = edited.length > 0
      ? `Save changes sends only the fields you edited (${fieldList(edited)}); fields you did not edit now show the server’s values. Use server values drops your edits, or choose Check again.`
      : 'None of your fields differ from the server now. Choose Cancel to close, or Check again.';
    showBox(editError, editError, `${lead} ${observed} This shows the server’s current values, not whether your request was applied. ${kept} ${next}`);
    edit.serverIssue = latest;
    showBox(editCompare, editCompare, `Server showed at this check: ${issueSummary(latest)}.`);
    editAdopt.hidden = false;
    editSave.focus();
  }

  editCheck.addEventListener('click', () => checkEdit());
  // Replace the draft with what the server showed at the last check.
  editAdopt.addEventListener('click', () => {
    const latest = edit.serverIssue;
    if (!latest || edit.saving) return;
    seedFrom(latest);
    edit.unconfirmed = null;
    editCheck.hidden = true;
    hideCompare();
    showBox(editError, editError, '');
    showBox(editNotice, editNotice, 'The form now shows the server’s values from the last check. Your edits were dropped.');
    editTitle.focus();
  });

  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (edit.saving || !edit.issue) return;
    const id = edit.issue.id;
    const patch = editPatch();
    showBox(editError, editError, '');
    showBox(editNotice, editNotice, '');
    if (Object.keys(patch).length === 0) { closeEdit(); return; }
    const { errors, value } = validateIssueInput(patch, { partial: true });
    setFieldError(editTitle, editTitleError, errors.title);
    setFieldError(editDescription, editDescriptionError, errors.description);
    if (errors.title || errors.description) {
      (errors.title ? editTitle : editDescription).focus();
      return;
    }
    // The seeds of the submitted fields at send time, to describe a later check.
    const before = { ...edit.seed };
    edit.unconfirmed = null;
    editCheck.hidden = true;
    hideCompare();
    setEditBusy(true, 'Saving…');
    showBox(editNotice, editNotice, 'Saving your changes… You can keep editing; anything you change now stays here.');
    let updated;
    try {
      // Only a reply for this issue that shows every submitted field counts as saved.
      updated = confirmSaved(await adapter.update(id, value), value, { id });
    } catch (error) {
      setEditBusy(false);
      showBox(editNotice, editNotice, '');
      if (error?.outcomeUnknown) {
        edit.unconfirmed = { id, submitted: value, before, reason: describe(error) };
        editCheck.hidden = false;
        await checkEdit();
      } else if (error?.code === 'NOT_FOUND') {
        showBox(editError, editError, `Could not save: the server no longer has this issue. Your changes are kept here so you can copy them. The board was refreshed.`);
        await load();
      } else {
        showBox(editError, editError, `Could not save: ${describe(error)} Your changes are kept so you can try again.`);
      }
      return;
    }
    // The confirmed reply is a server observation of this issue: untouched
    // fields follow it, edited fields (including text typed during the request)
    // are kept for the next explicit save. The dialog stays busy (fields still
    // editable) until the board behind it has been refreshed.
    syncFromServer(updated);
    setEditBusy(true, 'Refreshing…');
    showBox(editNotice, editNotice, `Saved “${updated.title}”. Refreshing the board… Anything you change now stays here.`);
    await load();
    setEditBusy(false);
    if (!edit.open || edit.issue !== updated) return;
    const remaining = editedFields();
    if (remaining.length === 0) {
      closeEdit({ message: `Saved “${updated.title}”.` });
      return;
    }
    showBox(editNotice, editNotice, `Saved “${updated.title}”. Your newer edits (${fieldList(remaining)}) are still here and have not been saved. Choose Save changes to save them.`);
    if (!editFields.includes(doc.activeElement)) editSave.focus();
  });

  // --- filters -------------------------------------------------------------------------
  searchInput.addEventListener('input', () => {
    state.filters.q = searchInput.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; load(); }, searchDelayMs);
  });
  filterSelect.addEventListener('change', () => {
    state.filters.status = filterSelect.value;
    load();
  });
  retryButton.addEventListener('click', () => load());
  refreshButton.addEventListener('click', async () => {
    if (state.loading) return;
    await load();
    if (!state.loadError) announce(`Board refreshed. ${boardStatus.textContent}`);
  });
  dismissButton.addEventListener('click', () => showBox(actionErrorBox, actionErrorText, ''));

  const ready = load();
  return { state, ready, reload: load, adapter };
}

// ---------------------------------------------------------------------------
// Browser boot (skipped when imported by Node tests)
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.getElementById('app');
  if (root) {
    mountApp(root, { adapter: createHttpAdapter(), doc: document });
  }
}
