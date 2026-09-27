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
  const editButtons = new Map();
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
  // unconfirmed: { id, submitted, form, reason } after a save with an unknown outcome.
  const edit = { issue: null, trigger: null, saving: false, open: false, unconfirmed: null, serverIssue: null };

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
    const selectLabel = h(doc, 'label', { for: selectId, class: 'sr-only' });
    selectLabel.textContent = `Status for ${issue.title}`;
    select.addEventListener('change', () => moveIssue(issue, select, card));
    const editButton = h(doc, 'button', { type: 'button', class: 'button subtle', 'data-role': 'card-edit', text: 'Edit' });
    editButton.setAttribute('aria-label', `Edit issue: ${issue.title}`);
    editButton.addEventListener('click', () => openEdit(issue, editButton));
    editButtons.set(issue.id, editButton);
    card.append(h(doc, 'div', { class: 'card-actions' }, selectLabel, select, editButton));
    return h(doc, 'li', {}, card);
  }

  function render() {
    board.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    board.classList.toggle('is-loading', state.loading);
    const keptList = state.loadError && state.issues.length > 0;
    showBox(loadErrorBox, loadErrorText, state.loadError
      ? `Could not load issues: ${describe(state.loadError)} ${keptList ? 'The board still shows the last list that loaded.' : 'The list was not updated.'} Try again.`
      : '');
    const groups = groupByStatus(state.issues);
    editButtons.clear();
    for (const status of STATUSES) {
      const { count, list, empty } = columns[status];
      const items = groups[status];
      count.textContent = String(items.length);
      list.replaceChildren(...items.map(renderCard));
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
    refreshButton.disabled = state.loading;
    refreshButton.textContent = state.loading ? 'Refreshing…' : 'Refresh';
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

  // Issues on the server with exactly this (trimmed) title and description.
  async function findMatchingIssues(input) {
    try {
      const items = await adapter.list({ q: input.title });
      return { matches: items.filter(item => item.title === input.title && item.description === input.description) };
    } catch (error) {
      return { matches: [], error };
    }
  }
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
        const found = await findMatchingIssues(input);
        let check;
        if (found.error) check = `The server could not be checked for it either: ${describe(found.error)} Look for it on the board before creating it again.`;
        else if (found.matches.length > 0) check = `The server now has ${found.matches.length === 1 ? 'an issue' : `${found.matches.length} issues`} with this title and description, so it was probably saved. Creating it again would add a duplicate.`;
        else check = 'The server has no issue with this title and description right now. You can create it again.';
        showBox(createError, createError, `Could not confirm whether “${value.title}” was saved: ${describe(error)} ${check} ${kept}`);
        await load();
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
      announce(`Moved “${issue.title}” to ${STATUS_LABELS[next]}.`);
      await load();
      editButtons.get(issue.id)?.focus();
    } catch (error) {
      select.value = previous;
      select.disabled = false;
      card.setAttribute('aria-busy', 'false');
      if (error?.outcomeUnknown) {
        // Ask the server what it shows now (all statuses, so filters cannot hide it).
        let now = null;
        let checkError = null;
        try { now = (await adapter.list({})).find(item => item.id === issue.id) ?? null; } catch (e) { checkError = e; }
        let seen;
        if (checkError) seen = `The server could not be checked either: ${describe(checkError)} Check the board before trying again.`;
        else if (!now) seen = 'The server no longer shows this issue.';
        else if (now.status === next) seen = `The server now shows it in ${STATUS_LABELS[next]}, so nothing more needs sending.`;
        else seen = `The server now shows it in ${STATUS_LABELS[now.status]}. Choose ${STATUS_LABELS[next]} again if you still want to move it.`;
        showBox(actionErrorBox, actionErrorText, `Could not confirm whether “${issue.title}” moved to ${STATUS_LABELS[next]}: ${describe(error)} ${seen}`);
        await load();
        (editButtons.get(issue.id) ?? select).focus();
      } else if (error?.code === 'NOT_FOUND') {
        showBox(actionErrorBox, actionErrorText, `Could not change the status of “${issue.title}”: the server no longer has this issue. The board was refreshed.`);
        await load();
      } else {
        showBox(actionErrorBox, actionErrorText, `Could not change the status of “${issue.title}”: ${describe(error)}`);
        select.focus();
      }
    }
  }

  // --- edit dialog -------------------------------------------------------------------
  function openEdit(issue, trigger) {
    edit.issue = issue;
    edit.trigger = trigger;
    editTitle.value = issue.title;
    editDescription.value = issue.description || '';
    editStatus.value = issue.status;
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

  function closeEdit({ restoreFocusTo } = {}) {
    if (!edit.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    edit.open = false;
    const target = restoreFocusTo || (edit.issue && editButtons.get(edit.issue.id)) || edit.trigger;
    edit.issue = null;
    edit.trigger = null;
    edit.unconfirmed = null;
    editCheck.hidden = true;
    hideCompare();
    showBox(editNotice, editNotice, '');
    target?.focus();
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
  const readEditForm = () => ({ title: editTitle.value, description: editDescription.value, status: editStatus.value });
  const sameForm = (a, b) => a.title === b.title && a.description === b.description && a.status === b.status;
  // The fields of `form` that differ from the saved `issue` (title compared trimmed, per contract).
  function changesFrom(form, issue) {
    const patch = {};
    if (form.title.trim() !== issue.title) patch.title = form.title;
    if (form.description !== (issue.description || '')) patch.description = form.description;
    if (form.status !== issue.status) patch.status = form.status;
    return patch;
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

  // After a save with an unknown outcome, ask the API for the issue again (all
  // statuses, no search, so filters cannot hide it) and tell the user what the
  // server now shows. The dialog and the draft stay as they are unless the
  // server shows every submitted change and the draft was not edited since.
  async function checkEdit() {
    const pending = edit.unconfirmed;
    if (!pending || edit.saving) return;
    setEditBusy(true, 'Checking…');
    showBox(editError, editError, `Could not confirm whether your changes were saved: ${pending.reason} Checking the board again…`);
    let latest = null;
    let checkError = null;
    try {
      const items = await adapter.list({});
      latest = items.find(item => item.id === pending.id) ?? null;
    } catch (error) {
      checkError = error;
    }
    // Refresh the board behind the dialog too, so it matches what was checked.
    await load();
    setEditBusy(false);
    if (edit.unconfirmed !== pending || !edit.open) return;
    const kept = 'Your changes are kept here.';
    hideCompare();
    if (checkError) {
      showBox(editError, editError, `Could not confirm whether your changes were saved: ${pending.reason} The board could not be checked either: ${describe(checkError)} ${kept} Choose Check again, or Save changes to send them again.`);
      editCheck.focus();
      return;
    }
    if (!latest) {
      showBox(editError, editError, `Could not confirm whether your changes were saved: ${pending.reason} The board was checked again, but this issue was not found. ${kept} Choose Check again, or Cancel to close.`);
      editCheck.focus();
      return;
    }
    // Later saves are compared against what the server shows now.
    edit.issue = latest;
    if (matchesSubmitted(latest, pending.submitted)) {
      edit.unconfirmed = null;
      editCheck.hidden = true;
      if (sameForm(readEditForm(), pending.form)) {
        showBox(editError, editError, '');
        announce(`The server now shows your changes to “${latest.title}”, so nothing more needs sending.`);
        closeEdit();
      } else {
        showBox(editError, editError, `The board was checked and shows the changes you saved to “${latest.title}”. Your newer edits are still here and have not been saved.`);
        editSave.focus();
      }
      return;
    }
    // The server shows something else. Say whether it still has the values from
    // before this save, or different ones (possibly a teammate's change).
    const base = pending.base;
    const unchangedOnServer = latest.title === base.title && (latest.description || '') === (base.description || '') && latest.status === base.status;
    const seen = unchangedOnServer
      ? 'The server still shows the values from before this save, so the save may not have been applied.'
      : 'The server now shows different values, which may include a teammate’s change.';
    showBox(editError, editError, `Could not confirm whether your changes were saved: ${pending.reason} ${seen} ${kept} Choose Save changes to send your version again (it replaces what the server shows), Use server values to drop your draft, or Check again.`);
    edit.serverIssue = latest;
    showBox(editCompare, editCompare, `Server now shows: ${issueSummary(latest)}.`);
    editAdopt.hidden = false;
    editSave.focus();
  }

  editCheck.addEventListener('click', () => checkEdit());
  // Replace the draft with what the server showed at the last check.
  editAdopt.addEventListener('click', () => {
    const latest = edit.serverIssue;
    if (!latest || edit.saving) return;
    edit.issue = latest;
    edit.unconfirmed = null;
    editTitle.value = latest.title;
    editDescription.value = latest.description || '';
    editStatus.value = latest.status;
    editCheck.hidden = true;
    hideCompare();
    showBox(editError, editError, '');
    showBox(editNotice, editNotice, 'The form now shows the server’s values. Your draft was dropped.');
    editTitle.focus();
  });

  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (edit.saving || !edit.issue) return;
    const issue = edit.issue;
    const form = readEditForm();
    const patch = changesFrom(form, issue);
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
    edit.unconfirmed = null;
    editCheck.hidden = true;
    hideCompare();
    setEditBusy(true, 'Saving…');
    showBox(editNotice, editNotice, 'Saving your changes… You can keep editing; anything you change now stays here.');
    let updated;
    try {
      // Only a reply for this issue that shows every submitted field counts as saved.
      updated = confirmSaved(await adapter.update(issue.id, value), value, { id: issue.id });
    } catch (error) {
      setEditBusy(false);
      showBox(editNotice, editNotice, '');
      if (error?.outcomeUnknown) {
        edit.unconfirmed = { id: issue.id, submitted: value, form, base: issue, reason: describe(error) };
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
    // The confirmed reply is the new saved baseline; later saves send only what
    // differs from it. The dialog stays busy (fields still editable) until the
    // board behind it has been refreshed.
    edit.issue = updated;
    setEditBusy(true, 'Refreshing…');
    showBox(editNotice, editNotice, `Saved “${updated.title}”. Refreshing the board… Anything you change now stays here.`);
    await load();
    setEditBusy(false);
    if (!edit.open || edit.issue !== updated) return;
    const current = readEditForm();
    if (sameForm(current, form) || Object.keys(changesFrom(current, updated)).length === 0) {
      announce(`Saved “${updated.title}”.`);
      closeEdit();
      return;
    }
    // Text typed while the save or the refresh was running is kept for an explicit save.
    showBox(editNotice, editNotice, `Saved “${updated.title}”. Your newer edits are still here and have not been saved. Choose Save changes to save them.`);
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
