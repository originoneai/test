// Team issue tracker board (NATIVE-UI).
//
// DATA
// The board reads and changes issues only through the live issue API served by
// src/server.js (docs/api.md). There is no demo or fixture data in the page and
// no offline fallback: if the API cannot be reached, the board says so.
//
// The adapter interface follows docs/api.md:
//   list({ status, priority, q }) -> Promise<Issue[]>          (GET   /api/issues)
//   create({ title, description, priority }) -> Promise<Issue> (POST  /api/issues)
//   update(id, patch) -> Promise<Issue>              (PATCH /api/issues/:id)
//   weeklyReport(weekStart) -> Promise<WeeklyReport>  (GET   /api/reports/weekly)
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
// Issue priority (specs/sim-ws-biz-01-priority-triage.md): exactly these four
// values, lowest first; a new issue defaults to normal.
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const DEFAULT_PRIORITY = 'normal';

/**
 * The priority the board shows and filters by. A record saved before priority
 * existed carries no priority field; it is treated as Normal on screen only.
 * The board never writes that value back on its own: a record is changed on
 * the server only by a save the user makes.
 */
export function effectivePriority(issue) {
  return issue && PRIORITIES.includes(issue.priority) ? issue.priority : DEFAULT_PRIORITY;
}
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

const ALLOWED_FIELDS = ['title', 'description', 'status', 'priority'];

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
  if ('priority' in input) {
    if (!PRIORITIES.includes(input.priority)) errors.priority = 'Choose a valid priority.';
    else value.priority = input.priority;
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

/**
 * True when `value` has the issue shape from specs/issue-tracker.md. A priority,
 * when the record carries one, must be one of PRIORITIES. A record without the
 * field (saved before priority existed) stays readable; it is shown as Normal
 * (effectivePriority) and can never confirm a save that sent a priority.
 */
export function isValidIssue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { id, title, description, status, createdAt, updatedAt } = value;
  if ('priority' in value && !PRIORITIES.includes(value.priority)) return false;
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
  if ('priority' in submitted && issue.priority !== submitted.priority) return false;
  return true;
}

// The error answers docs/api.md defines as definite rejections: the change was
// not applied. Each is trusted only with its documented HTTP status. Any other
// structured error (INTERNAL_ERROR, a code the contract does not list, or a
// listed code with another status) leaves the outcome unknown.
const DEFINITE_ERRORS = Object.freeze({
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  INVALID_URL: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  STORAGE_ERROR: 500,
});
const isDefiniteError = (code, status) => Object.hasOwn(DEFINITE_ERRORS, code) && DEFINITE_ERRORS[code] === status;

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

/** The fields a created issue must show: the submitted values and the defaults. */
export function expectedCreate(input) {
  return {
    title: String(input.title).trim(),
    description: input.description ?? '',
    status: 'open',
    priority: input.priority ?? DEFAULT_PRIORITY,
  };
}

// ---------------------------------------------------------------------------
// Weekly summary (GET /api/reports/weekly, version 1)
// ---------------------------------------------------------------------------
//
// A week runs from Monday 00:00 UTC for seven days. Weeks are named by the
// date of that Monday, "YYYY-MM-DD". Every date here is a UTC calendar date
// (proleptic Gregorian) written with exactly four year digits, 0000 to 9999.
//
// Both dates of a version-1 report (weekStart and weekEndExclusive) must be
// written that way, so the summary covers the whole weeks from Monday
// 0000-01-03 (the first Monday of year 0000) to the week of Monday 9999-12-20
// (ending Sunday 9999-12-26; its end, 9999-12-27, is the last Monday that can
// still be written). Days outside those weeks belong to weeks the summary
// cannot name.

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = n => String(n).padStart(2, '0');
export const FIRST_WEEK_START = '0000-01-03';
export const LAST_WEEK_START = '9999-12-20';
/** "YYYY-MM-DD" (year zero-padded to four digits) for a UTC Date, or null outside the years 0000-9999. */
const isoDay = date => {
  const year = date.getUTCFullYear();
  if (!Number.isInteger(year) || year < 0 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};
// A UTC midnight for the given calendar day. Date.UTC would read the years
// 0-99 as 1900-1999; setUTCFullYear takes the year exactly as given.
const utcMidnight = (year, monthIndex, day) => {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
};

/** A real calendar date "YYYY-MM-DD" (years 0000-9999) as a UTC Date, or null. */
export function parseIsoDate(text) {
  const m = typeof text === 'string' ? ISO_DATE.exec(text) : null;
  if (!m) return null;
  const date = utcMidnight(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isoDay(date) === text ? date : null;
}

/**
 * The UTC Monday ("YYYY-MM-DD") of the week containing `date` (a Date, a time
 * value or "YYYY-MM-DD"), or null when there is none or that Monday has no
 * four-digit year.
 */
export function utcWeekStart(date) {
  const day = typeof date === 'string' ? parseIsoDate(date) : new Date(date);
  if (!day || Number.isNaN(day.getTime())) return null;
  const midnight = Math.floor(day.getTime() / DAY_MS) * DAY_MS;
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return isoDay(new Date(midnight - sinceMonday * DAY_MS));
}

/** `isoDate` moved by `n` days, as "YYYY-MM-DD"; null if the result has no four-digit year. */
export function addUtcDays(isoDate, n) {
  const day = parseIsoDate(isoDate);
  return day ? isoDay(new Date(day.getTime() + n * DAY_MS)) : null;
}

/**
 * True for a UTC Monday whose whole week, including the following Monday
 * (weekEndExclusive), can be written with four-digit years: FIRST_WEEK_START
 * to LAST_WEEK_START.
 */
export function isSupportedWeek(week) {
  return typeof week === 'string' && utcWeekStart(week) === week
    && week >= FIRST_WEEK_START && week <= LAST_WEEK_START;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Mon 28 Sep 2026" for a UTC calendar date (the same in every browser). */
export function formatUtcDay(isoDate) {
  const day = parseIsoDate(isoDate);
  if (!day) return String(isoDate ?? '');
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${isoDate.slice(0, 4)}`;
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const hasExactCounts = (obj, keys) => Boolean(obj && typeof obj === 'object' && !Array.isArray(obj))
  && keys.every(key => isCount(obj[key]));

/**
 * A version-1 weekly report for `weekStart`: schemaVersion 1, the requested
 * week, weekEndExclusive seven days later, and a count for every status and
 * every priority (zeros included) that add up to the total.
 */
export function isValidWeeklyReport(data, weekStart) {
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1) return false;
  if (!isSupportedWeek(data.weekStart)) return false;
  if (weekStart && data.weekStart !== weekStart) return false;
  if (data.weekEndExclusive !== addUtcDays(data.weekStart, 7)) return false;
  const created = data.created;
  if (!created || typeof created !== 'object' || !isCount(created.total)) return false;
  if (!hasExactCounts(created.byStatus, STATUSES) || !hasExactCounts(created.byPriority, PRIORITIES)) return false;
  const sum = (obj, keys) => keys.reduce((total, key) => total + obj[key], 0);
  return sum(created.byStatus, STATUSES) === created.total && sum(created.byPriority, PRIORITIES) === created.total;
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
      // Only a documented definite rejection means the change was not applied.
      // Other structured errors keep their code and message but leave the
      // outcome unknown; anything unstructured (for example a gateway HTML
      // page) says nothing about what happened.
      if (err && typeof err.code === 'string' && typeof err.message === 'string') {
        throw new ApiError(err.code, err.message, res.status, { outcomeUnknown: !isDefiniteError(err.code, res.status) });
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
    async list({ status = '', priority = '', q = '' } = {}) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (priority) params.set('priority', priority);
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
    // The weekly summary of issues created in the UTC week starting `weekStart`
    // (a Monday, "YYYY-MM-DD"). Only a well-formed version-1 report for that
    // week is returned; anything else is an error.
    async weeklyReport(weekStart) {
      const { data, status } = await request('GET', '/api/reports/weekly?weekStart=' + encodeURIComponent(weekStart));
      if (!isValidWeeklyReport(data, weekStart)) throw unreadable(status);
      return data;
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

function prioritySelect(doc, id, { includeAll = false } = {}) {
  const select = h(doc, 'select', { id });
  if (includeAll) select.append(h(doc, 'option', { value: '', text: 'All priorities' }));
  for (const priority of PRIORITIES) {
    select.append(h(doc, 'option', {
      value: priority, text: PRIORITY_LABELS[priority],
      selected: !includeAll && priority === DEFAULT_PRIORITY,
    }));
  }
  if (!includeAll) select.value = DEFAULT_PRIORITY;
  return select;
}

// The server answers 500 STORAGE_ERROR when its saved issues cannot be read or
// written (docs/api.md: the store is corrupt or unavailable; it is never
// rewritten). On a load, that is a data problem the user cannot fix from the
// board, so the board explains it and how it is recovered.
function isStorageProblem(error) {
  return Boolean(error && error.code === 'STORAGE_ERROR' && error.status === 500);
}
export const STORAGE_HINT = 'The server could not read its saved issues. The data file may be damaged '
  + '(for example after a hand edit) or storage may be unavailable. Nothing was changed or deleted: '
  + 'the server never rewrites a file it cannot read. To recover, ask whoever runs this server to check '
  + 'its log for the problem it found, keep a copy of the data file (issues.json), then fix it or put back '
  + 'a good backup and restart the server. Then choose Retry.';

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
 * options: { adapter, doc, searchDelayMs, reports, now }
 *   reports: an object with weeklyReport(weekStart) (the HTTP adapter has one).
 *     When given, the board shows a Weekly summary; without it there is none.
 *     handle.showWeeklySummary(reports) adds it to a board mounted without one.
 *   now: the current time, for the default (current UTC) week.
 */
export function mountApp(root, { adapter, doc = root.ownerDocument, searchDelayMs = 200, reports: reportSource = null, now = () => new Date() } = {}) {
  if (!adapter) throw new Error('mountApp requires an adapter');
  const state = { issues: [], filters: { status: '', priority: '', q: '' }, loading: false, loadError: null, loadSeq: 0 };
  // Controls of the cards on screen, per issue id, and each column's order, so
  // focus can go back to a control that is still on the page after a render.
  const cardControls = new Map(); // id -> { edit, select, priority, title }
  const columnIds = Object.fromEntries(STATUSES.map(s => [s, []]));
  // Last position of every issue that has been shown: { status, index, title }.
  // Kept after the card is gone so focus can move to its neighbour.
  const lastSeen = new Map();
  // Direct priority changes made on a card, per issue id. Kept across renders
  // so a card that is re-rendered (by a search, a filter or a refresh) still
  // shows its saving, saved, failed or unconfirmed state.
  //   { state: 'saving' | 'checking' | 'saved' | 'failed' | 'unknown',
  //     target, previous, title, message }
  const prioritySaves = new Map();
  // Where focus went when a focused card priority control left the board.
  let priorityFocusMove = null; // { id, description }
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
  const newPriority = prioritySelect(doc, 'new-priority');
  newPriority.setAttribute('name', 'priority');
  newPriority.setAttribute('data-role', 'new-priority');
  newPriority.setAttribute('aria-describedby', 'new-priority-hint');
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
    h(doc, 'div', { class: 'field' },
      h(doc, 'label', { for: 'new-priority', text: 'Priority' }),
      newPriority,
      h(doc, 'p', { id: 'new-priority-hint', class: 'hint', text: `New issues default to ${PRIORITY_LABELS[DEFAULT_PRIORITY]}.` }),
    ),
    createError,
    createPending,
    h(doc, 'div', { class: 'form-actions' }, createButton),
  );

  // --- toolbar ----------------------------------------------------------------
  const searchInput = h(doc, 'input', { id: 'search', type: 'search', autocomplete: 'off', placeholder: 'Title or description', 'data-role': 'search' });
  const filterSelect = statusSelect(doc, 'status-filter', { includeAll: true });
  filterSelect.setAttribute('data-role', 'status-filter');
  const priorityFilter = prioritySelect(doc, 'priority-filter', { includeAll: true });
  priorityFilter.setAttribute('data-role', 'priority-filter');
  // Asks the server for the current list, for example to see a teammate's changes.
  const refreshButton = h(doc, 'button', { type: 'button', class: 'button', 'data-role': 'refresh', text: 'Refresh' });
  const toolbar = h(doc, 'section', { class: 'panel toolbar', role: 'search', 'aria-label': 'Filter issues' },
    h(doc, 'div', { class: 'field grow' }, h(doc, 'label', { for: 'search', text: 'Search issues' }), searchInput),
    h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: 'status-filter', text: 'Status' }), filterSelect),
    h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: 'priority-filter', text: 'Priority' }), priorityFilter),
    h(doc, 'div', { class: 'field toolbar-action' }, refreshButton),
  );

  // --- board ------------------------------------------------------------------
  const boardStatus = h(doc, 'p', { class: 'board-status', role: 'status', 'data-role': 'board-status' });
  const loadErrorText = h(doc, 'span', { 'data-role': 'load-error-text' });
  const retryButton = h(doc, 'button', { type: 'button', class: 'button', 'data-role': 'retry', text: 'Retry' });
  // Extra guidance when the server says its storage cannot be read (docs/api.md:
  // a corrupt or unavailable store answers 500 STORAGE_ERROR and is never
  // rewritten). Hidden for other load failures.
  const loadErrorHint = h(doc, 'p', { class: 'notice-hint', 'data-role': 'load-error-hint', hidden: true });
  const loadErrorBox = h(doc, 'div', { class: 'notice error', role: 'alert', 'data-role': 'load-error', hidden: true }, loadErrorText, ' ', retryButton, loadErrorHint);
  const actionErrorText = h(doc, 'span', { 'data-role': 'action-error-text' });
  const dismissButton = h(doc, 'button', { type: 'button', class: 'button subtle', text: 'Dismiss' });
  const actionErrorBox = h(doc, 'div', { class: 'notice error', role: 'alert', 'data-role': 'action-error', hidden: true }, actionErrorText, ' ', dismissButton);
  // Visible note for a card priority change whose card is no longer shown
  // (it left the current filters, or the server no longer has it).
  const priorityNoticeText = h(doc, 'span', { 'data-role': 'priority-notice-text' });
  const priorityNoticeDismiss = h(doc, 'button', { type: 'button', class: 'button subtle', text: 'Dismiss' });
  const priorityNotice = h(doc, 'div', { class: 'notice info', 'data-role': 'priority-notice', hidden: true }, priorityNoticeText, ' ', priorityNoticeDismiss);
  const columns = {};
  const board = h(doc, 'div', { class: 'board', 'data-role': 'board', 'aria-busy': 'false' });
  for (const status of STATUSES) {
    const headingId = `column-${status}-heading`;
    const count = h(doc, 'span', { class: 'count', 'data-role': `count-${status}`, text: '0' });
    const list = h(doc, 'ul', { class: 'cards', 'aria-labelledby': headingId, 'data-role': `list-${status}` });
    // Both can take focus from script (tabindex -1, not in the tab order), so a
    // card that leaves the view never drops keyboard focus to the page.
    const empty = h(doc, 'p', { class: 'empty', 'data-role': `empty-${status}`, tabindex: '-1', hidden: true });
    const heading = h(doc, 'h2', { id: headingId, tabindex: '-1', 'data-role': `heading-${status}` }, STATUS_LABELS[status], ' ', count);
    const column = h(doc, 'section', { class: `column column-${status}`, 'aria-labelledby': headingId, 'data-role': `column-${status}` },
      heading,
      list,
      empty,
    );
    columns[status] = { count, list, empty, heading };
    board.append(column);
  }

  // --- edit dialog ------------------------------------------------------------
  const editTitle = h(doc, 'input', { id: 'edit-title', name: 'title', type: 'text', required: true, autocomplete: 'off', 'aria-describedby': 'edit-title-error' });
  const editTitleError = h(doc, 'p', { id: 'edit-title-error', class: 'field-error', hidden: true, 'data-role': 'edit-title-error' });
  const editDescription = h(doc, 'textarea', { id: 'edit-description', name: 'description', rows: '5', 'aria-describedby': 'edit-description-error' });
  const editDescriptionError = h(doc, 'p', { id: 'edit-description-error', class: 'field-error', hidden: true });
  const editStatus = statusSelect(doc, 'edit-status');
  const editPriority = prioritySelect(doc, 'edit-priority');
  editPriority.setAttribute('data-role', 'edit-priority');
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
    h(doc, 'div', { class: 'field' }, h(doc, 'label', { for: 'edit-priority', text: 'Priority' }), editPriority),
    editNotice,
    editError,
    editCompare,
    h(doc, 'div', { class: 'form-actions' }, editCancel, editCheck, editAdopt, editSave),
  );
  const dialog = h(doc, 'dialog', { class: 'edit-dialog', 'aria-labelledby': 'edit-heading', 'data-role': 'edit-dialog' }, editForm);
  // seed: per field, the server value that field was last filled from.
  // unconfirmed: { id, submitted, before, reason } after a save with an unknown outcome.
  // placed: per field, the value the dialog last put in (or saw when sending).
  // uncertain: fields of a save whose outcome is unknown and not yet observed.
  const edit = { issue: null, seed: null, placed: null, uncertain: new Set(), trigger: null, saving: false, open: false, unconfirmed: null, serverIssue: null };

  // --- weekly summary -----------------------------------------------------------
  // Issues created in one UTC week, by their current status and priority. It
  // reads its own report from the server, so the board's search and filters
  // never change it; board changes refresh it (refreshWeekly).
  let reports = null;
  const weekly = { week: null, seq: 0, loading: false, data: null, error: null, pending: Promise.resolve(), userAsked: false };
  const weeklyHeading = h(doc, 'h2', { id: 'weekly-heading', tabindex: '-1', 'data-role': 'weekly-heading', text: 'Weekly summary' });
  const weeklyWeek = h(doc, 'input', { id: 'weekly-week', type: 'date', 'data-role': 'weekly-week', 'aria-describedby': 'weekly-week-hint weekly-range weekly-week-error' });
  const weeklyWeekError = h(doc, 'p', { id: 'weekly-week-error', class: 'field-error', 'data-role': 'weekly-week-error', hidden: true });
  const weeklyPrev = h(doc, 'button', { type: 'button', class: 'button subtle', 'data-role': 'weekly-prev', text: 'Previous week' });
  const weeklyThis = h(doc, 'button', { type: 'button', class: 'button subtle', 'data-role': 'weekly-this', text: 'This week' });
  const weeklyNext = h(doc, 'button', { type: 'button', class: 'button subtle', 'data-role': 'weekly-next', text: 'Next week' });
  const weeklyRange = h(doc, 'p', { id: 'weekly-range', class: 'weekly-range', 'data-role': 'weekly-range' });
  const weeklyEdge = h(doc, 'p', { id: 'weekly-edge', class: 'hint', 'data-role': 'weekly-edge', hidden: true });
  const weeklyStatus = h(doc, 'p', { class: 'weekly-status', 'data-role': 'weekly-status' });
  const weeklyErrorText = h(doc, 'span', { 'data-role': 'weekly-error-text' });
  const weeklyRetry = h(doc, 'button', { type: 'button', class: 'button subtle', 'data-role': 'weekly-retry', text: 'Retry' });
  const weeklyError = h(doc, 'div', { class: 'notice error', role: 'alert', 'data-role': 'weekly-error', hidden: true }, weeklyErrorText, ' ', weeklyRetry);
  const weeklyTotal = h(doc, 'span', { class: 'weekly-total-count', 'data-role': 'weekly-total' });
  const weeklyTotalLabel = h(doc, 'span', { 'data-role': 'weekly-total-label' });
  const distribution = (key, title, keys, labels) => {
    const headingId = `weekly-${key}-heading`;
    const counts = {};
    const bars = {};
    const items = keys.map(k => {
      counts[k] = h(doc, 'span', { class: 'weekly-count', 'data-role': `weekly-${key}-${k}` });
      bars[k] = h(doc, 'span', { class: `weekly-bar weekly-bar-${key}-${k}` });
      return h(doc, 'li', { class: 'weekly-row' },
        h(doc, 'span', { class: 'weekly-label', text: labels[k] }), counts[k],
        h(doc, 'span', { class: 'weekly-track', 'aria-hidden': 'true' }, bars[k]));
    });
    const block = h(doc, 'div', { class: 'weekly-block' },
      h(doc, 'h3', { id: headingId, text: title }),
      h(doc, 'ul', { class: 'weekly-list', 'aria-labelledby': headingId, 'data-role': `weekly-by-${key}` }, items));
    return { block, counts, bars };
  };
  const byStatus = distribution('status', 'By current status', STATUSES, STATUS_LABELS);
  const byPriority = distribution('priority', 'By current priority', PRIORITIES, PRIORITY_LABELS);
  const weeklyResult = h(doc, 'div', { class: 'weekly-result', 'data-role': 'weekly-result', hidden: true },
    h(doc, 'p', { class: 'weekly-total' }, weeklyTotal, ' ', weeklyTotalLabel),
    byStatus.block, byPriority.block);
  const weeklySection = h(doc, 'section', { class: 'panel weekly', 'aria-labelledby': 'weekly-heading', 'aria-busy': 'false', 'data-role': 'weekly' },
    weeklyHeading,
    h(doc, 'p', { class: 'hint', text: 'Issues created in the chosen week, counted by their current status and priority. The board’s search and filters do not change it.' }),
    h(doc, 'div', { class: 'field' },
      h(doc, 'label', { for: 'weekly-week', text: 'Week (UTC)' }),
      weeklyWeek,
      h(doc, 'p', { id: 'weekly-week-hint', class: 'hint', text: 'Pick any day; its Monday-to-Sunday week in UTC is shown.' }),
      weeklyWeekError,
    ),
    h(doc, 'div', { class: 'weekly-nav' }, weeklyPrev, weeklyThis, weeklyNext),
    weeklyRange,
    weeklyEdge,
    weeklyStatus,
    weeklyError,
    weeklyResult,
  );

  const sidebar = h(doc, 'aside', { class: 'sidebar' }, createForm);
  root.replaceChildren(
    header,
    live,
    h(doc, 'div', { class: 'layout' },
      sidebar,
      h(doc, 'div', { class: 'main' }, toolbar, loadErrorBox, actionErrorBox, priorityNotice, boardStatus, board),
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
  function filtersActive() { return Boolean(state.filters.status || state.filters.priority || state.filters.q.trim()); }

  function renderCard(issue) {
    const title = h(doc, 'h3', { class: 'card-title', 'data-role': 'card-title' });
    title.textContent = issue.title;
    const card = h(doc, 'article', { class: 'card', 'data-issue-id': issue.id, 'data-role': 'card' }, title);
    // Readable priority badge: the visible word plus a screen-reader prefix, so
    // it never relies on colour alone. A record saved before priority existed
    // shows Normal, like every new issue.
    const shownPriority = effectivePriority(issue);
    card.append(h(doc, 'p', { class: `priority-badge priority-${shownPriority}`, 'data-role': 'card-priority', 'data-priority': shownPriority },
      h(doc, 'span', { class: 'sr-only', text: 'Priority: ' }),
      PRIORITY_LABELS[shownPriority]), ' ');
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
    const priority = renderCardPriority(issue, card);
    cardControls.set(issue.id, { edit: editButton, select, priority, title: issue.title });
    card.append(h(doc, 'div', { class: 'card-actions' }, selectLabel, select, editButton));
    return h(doc, 'li', {}, card);
  }

  // The card's own priority control: a labelled select that saves on change,
  // a visible save state next to it and, after a failed or unconfirmed save, a
  // Retry button that sends the same priority again. Returns the select.
  function renderCardPriority(issue, card) {
    const id = issue.id;
    const save = prioritySaves.get(id);
    const controlId = `priority-${id}`;
    const stateId = `priority-${id}-state`;
    const control = prioritySelect(doc, controlId);
    control.setAttribute('data-role', 'card-priority-control');
    control.setAttribute('data-issue-id', id);
    control.setAttribute('aria-describedby', stateId);
    const shown = effectivePriority(issue);
    // While a save is in flight the control shows the value being saved; in
    // every other state it shows the value the server last reported.
    control.value = save && (save.state === 'saving' || save.state === 'checking') ? save.target : shown;
    const busy = save && (save.state === 'saving' || save.state === 'checking');
    // aria-disabled rather than disabled, so a focused control keeps focus;
    // a change made while busy is undone by the change handler.
    if (busy) {
      control.setAttribute('aria-disabled', 'true');
      card.setAttribute('aria-busy', 'true');
    }
    control.addEventListener('change', () => savePriority(id, control.value, { control }));
    const label = h(doc, 'label', { for: controlId, class: 'card-priority-label' }, 'Priority',
      h(doc, 'span', { class: 'sr-only', text: ` for ${issue.title}` }));
    const stateText = h(doc, 'span', { id: stateId, class: 'card-priority-state', 'data-role': 'card-priority-state' });
    if (save) {
      stateText.textContent = save.message;
      stateText.setAttribute('data-state', save.state);
    }
    const row = h(doc, 'div', { class: 'card-priority-row' }, label, control, stateText);
    if (save && (save.state === 'failed' || save.state === 'unknown')) {
      const retry = h(doc, 'button', { type: 'button', class: 'button subtle', 'data-role': 'card-priority-retry', 'data-issue-id': id,
        text: `Retry ${PRIORITY_LABELS[save.target]}` });
      retry.setAttribute('aria-label', `Retry saving priority ${PRIORITY_LABELS[save.target]} for ${issue.title}`);
      retry.addEventListener('click', () => savePriority(id, save.target, { retry: true, control: retry }));
      row.append(retry);
    }
    card.append(row);
    return control;
  }

  // Which card control has focus right now, if any: { id, role }.
  function focusedCardControl() {
    const active = doc.activeElement;
    const id = active?.getAttribute?.('data-issue-id');
    const controls = id ? cardControls.get(id) : null;
    if (!controls) return null;
    if (active === controls.edit) return { id, role: 'card-edit' };
    if (active === controls.select) return { id, role: 'card-status' };
    if (active === controls.priority) return { id, role: 'card-priority-control' };
    if (active?.getAttribute?.('data-role') === 'card-priority-retry') return { id, role: 'card-priority-control' };
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
    if (role === 'card-priority-control') return restorePriorityFocus(id);
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

  /**
   * Focus for a card priority control after a render. The same card's control
   * when it is still shown; otherwise the priority control of the next card in
   * its column, else the previous one, else the column's empty-state message or
   * heading. Records where focus went (priorityFocusMove) so the change that
   * caused it can say so in one announcement. Returns the focused element.
   */
  function restorePriorityFocus(id) {
    const controls = cardControls.get(id);
    if (controls?.priority?.isConnected) {
      controls.priority.focus();
      return controls.priority;
    }
    const seen = lastSeen.get(id);
    if (!seen) {
      refreshButton.focus();
      priorityFocusMove = { id, description: 'the Refresh button' };
      return refreshButton;
    }
    const ids = columnIds[seen.status];
    const column = STATUS_LABELS[seen.status];
    if (ids.length > 0) {
      // The card's old index now holds the next card; past the end, the previous.
      const next = seen.index < ids.length;
      const neighbour = cardControls.get(ids[next ? seen.index : ids.length - 1]);
      if (neighbour?.priority?.isConnected) {
        neighbour.priority.focus();
        priorityFocusMove = { id, description: `the ${next ? 'next' : 'previous'} card, “${neighbour.title}”, in ${column}` };
        return neighbour.priority;
      }
    }
    const { empty, heading } = columns[seen.status];
    const target = empty.hidden ? heading : empty;
    target.focus();
    priorityFocusMove = { id, description: empty.hidden ? `the ${column} column heading` : `the empty ${column} column` };
    return target;
  }

  function render() {
    // Re-rendering replaces the cards, so remember which card control had focus.
    const hadFocus = focusedCardControl();
    board.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    board.classList.toggle('is-loading', state.loading);
    const keptList = state.loadError && state.issues.length > 0;
    const storageProblem = isStorageProblem(state.loadError);
    showBox(loadErrorBox, loadErrorText, state.loadError
      ? `Could not load issues: ${describe(state.loadError)} ${keptList ? 'The board still shows the last list that loaded.' : 'The list was not updated.'} Try again.`
      : '');
    showBox(loadErrorHint, loadErrorHint, storageProblem ? STORAGE_HINT : '');
    // With nothing loaded, an unreadable store is not an empty board: the
    // columns are hidden so zero counts cannot read as "no issues".
    board.hidden = storageProblem && state.issues.length === 0;
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
    else if (state.loadError) {
      boardStatus.textContent = state.issues.length > 0
        ? 'Issues could not be refreshed. Showing the last list that loaded.'
        : storageProblem ? 'Issues could not be loaded: the server cannot read its saved issues.' : 'Issues could not be loaded.';
    }
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

  // Resolves true only when this load's result was applied to the board and
  // it succeeded; a load superseded by a newer one resolves false.
  async function load() {
    const seq = ++state.loadSeq;
    state.loading = true;
    render();
    try {
      // The priority filter is sent only when one is chosen ("All priorities").
      const { priority, ...rest } = state.filters;
      const items = await adapter.list(priority ? { ...rest, priority } : rest);
      if (seq !== state.loadSeq) return false;
      state.issues = items;
      state.loadError = null;
    } catch (error) {
      if (seq !== state.loadSeq) return false;
      state.loadError = error;
    }
    state.loading = false;
    render();
    return !state.loadError;
  }

  // The board's filters applied to an unfiltered list, with the same rules as
  // the API (docs/api.md, src/store.js): exact status, exact priority, and q
  // as a case-insensitive substring of the title or description.
  function applyFilters(items, { status = '', priority = '', q = '' } = {}) {
    const needle = q ? q.toLowerCase() : '';
    return items.filter(issue => (!status || issue.status === status)
      && (!priority || effectivePriority(issue) === priority)
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
    // An unknown outcome may still have changed the server: the summary follows.
    refreshWeekly();
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
    // Records without a priority field are summarised without one, so the
    // comparison only shows what the server actually returned.
    const priority = PRIORITIES.includes(issue.priority) ? `, priority ${PRIORITY_LABELS[issue.priority]}` : '';
    return `title ${quoteText(issue.title)}, status ${STATUS_LABELS[issue.status] ?? issue.status}${priority}, description ${quoteText(issue.description)}`;
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
    const submitted = { title: newTitle.value, description: newDescription.value, priority: newPriority.value };
    const { errors, value } = validateIssueInput(submitted);
    setFieldError(newTitle, newTitleError, errors.title);
    setFieldError(newDescription, newDescriptionError, errors.description);
    if (errors.priority) showBox(createError, createError, errors.priority);
    if (errors.title || errors.description || errors.priority) {
      (errors.title ? newTitle : errors.description ? newDescription : newPriority).focus();
      return;
    }
    const draftUnchanged = () => newTitle.value === submitted.title && newDescription.value === submitted.description
      && newPriority.value === submitted.priority;
    creating = true;
    createButton.disabled = true;
    createButton.textContent = 'Saving…';
    createForm.setAttribute('aria-busy', 'true');
    showBox(createPending, createPending, `Saving “${value.title}”… You can keep typing your next issue; it will not be cleared.`);
    try {
      const input = { title: value.title, description: value.description ?? '', priority: value.priority };
      // Only a reply that shows what was submitted counts as saved.
      const created = confirmSaved(await adapter.create(input), expectedCreate(input));
      if (draftUnchanged()) {
        newTitle.value = '';
        newDescription.value = '';
        newPriority.value = DEFAULT_PRIORITY;
        announce(`Issue created: ${created.title}`);
      } else {
        announce(`Issue created: ${created.title}. Your new draft was kept.`);
      }
      refreshWeekly();
      await load();
    } catch (error) {
      const unchanged = draftUnchanged();
      if (error?.outcomeUnknown) {
        // The request may have reached the server; never say it was not saved,
        // and never create it again automatically (docs/api.md: a blind re-post
        // can duplicate). Look for a matching issue and let the user decide.
        const kept = unchanged ? 'Your text is kept.' : 'Your newer draft was left unchanged.';
        const input = { title: value.title, description: value.description ?? '', priority: value.priority };
        showBox(createPending, createPending, `Checking the server for “${value.title}”…`);
        const obs = await observe();
        let check;
        if (obs.error) check = `The server could not be checked either: ${describe(obs.error)} Look for it on the board before creating it again.`;
        else {
          // Any issue with the same text may be this one (a teammate may also
          // have changed its priority since), so priority does not narrow it.
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
      refreshWeekly();
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
        refreshWeekly();
        await load();
        restoreCardFocus(issue.id, 'card-edit', { gone: `The server no longer has “${issue.title}”.` });
      } else {
        showBox(actionErrorBox, actionErrorText, `Could not change the status of “${issue.title}”: ${describe(error)}`);
        if (select.isConnected) select.focus();
        else restoreCardFocus(issue.id, 'card-status');
      }
    }
  }

  // --- card priority -------------------------------------------------------------
  //
  // A priority chosen on a card is saved at once with a PATCH that carries only
  // the priority. The current search and filters stay as they are: the board is
  // reloaded with them, so a card that no longer matches leaves the view and
  // focus moves to a neighbour (see restorePriorityFocus). Only one priority
  // save per card is in flight; a change made meanwhile is undone and named.
  // An unknown outcome is never re-sent automatically: the server is read once
  // and the card says what it showed; Retry is the user's explicit choice.
  const priorityName = value => PRIORITY_LABELS[value] ?? String(value);
  function showPriorityNotice(message) { showBox(priorityNotice, priorityNoticeText, message); }
  priorityNoticeDismiss.addEventListener('click', () => showPriorityNotice(''));

  // Announce `message`, adding where focus went if this card's control left.
  function announcePriority(id, message) {
    const moved = priorityFocusMove?.id === id ? priorityFocusMove : null;
    priorityFocusMove = null;
    announce(moved ? `${message} Focus moved to ${moved.description}.` : message);
  }
  const onBoard = id => state.issues.some(item => item.id === id);
  const leftView = title => `“${title}” no longer matches the current search and filters, so it is hidden.`;

  async function savePriority(id, next, { retry = false, control = null } = {}) {
    const current = state.issues.find(item => item.id === id);
    const pending = prioritySaves.get(id);
    if (pending && (pending.state === 'saving' || pending.state === 'checking')) {
      // A save for this card is still in flight: keep its value on screen.
      if (control && control.tagName !== 'BUTTON' && 'value' in control) control.value = pending.target;
      announce(`Still saving priority ${priorityName(pending.target)} for “${pending.title}”. Wait for it to finish.`);
      return;
    }
    if (!current) return;
    const title = current.title;
    const previous = effectivePriority(current);
    if (!retry && next === previous) {
      // Choosing the value already saved clears an old failed state, sends nothing.
      if (pending) { prioritySaves.delete(id); render(); }
      return;
    }
    const { errors, value } = validateIssueInput({ priority: next }, { partial: true });
    if (errors.priority) {
      if (control && 'value' in control) control.value = previous;
      announce(errors.priority);
      return;
    }
    // A fresh change: older "Saved" notes on other cards are no longer news.
    for (const [otherId, other] of prioritySaves) if (other.state === 'saved') prioritySaves.delete(otherId);
    showPriorityNotice('');
    showBox(actionErrorBox, actionErrorText, '');
    const label = priorityName(value.priority);
    prioritySaves.set(id, { state: 'saving', target: value.priority, previous, title, message: `Saving ${label}…` });
    render();
    announce(`Saving priority ${label} for “${title}”…`);
    try {
      // Only a reply for this issue that shows the sent priority counts as saved.
      const saved = confirmSaved(await adapter.update(id, { priority: value.priority }), { priority: value.priority }, { id });
      prioritySaves.set(id, { state: 'saved', target: value.priority, previous, title, message: `Saved: ${label}.` });
      // Show the confirmed record at once, then reload with the current filters.
      state.issues = state.issues.map(item => (item.id === id ? saved : item));
      priorityFocusMove = null;
      refreshWeekly();
      await load();
      if (onBoard(id)) announcePriority(id, `Priority of “${title}” saved: ${label}.`);
      else {
        prioritySaves.delete(id);
        showPriorityNotice(`Saved: “${title}” is now ${label}. ${leftView(title)}`);
        announcePriority(id, `Priority of “${title}” saved: ${label}. ${leftView(title)}`);
      }
    } catch (error) {
      if (error?.outcomeUnknown) {
        prioritySaves.set(id, { state: 'checking', target: value.priority, previous, title, message: 'Not confirmed. Checking the server…' });
        render();
        // One read of the server (no filters) decides what the card says.
        const obs = await observe();
        const now = obs.error ? null : obs.items.find(item => item.id === id) ?? null;
        const lead = `Could not confirm whether “${title}” was saved as ${label}: ${describe(error)}`;
        let entry = null;
        let message;
        if (obs.error) {
          entry = { state: 'unknown', message: `Not confirmed. The server could not be checked: ${describe(obs.error)} Retry sends ${label} again.` };
          message = `${lead} The server could not be checked either: ${describe(obs.error)} Retry sends ${label} again.`;
        } else if (!now) {
          message = `${lead} When checked just now, the server did not show this issue.${boardNote(obs)}`;
        } else if (now.priority === value.priority) {
          entry = { state: 'saved', message: `Saved: ${label} (checked with the server).` };
          message = `${lead} When checked just now, the server showed ${label}.${boardNote(obs)} Nothing more needs sending.`;
        } else {
          const shown = priorityName(effectivePriority(now));
          const whose = effectivePriority(now) === previous ? 'the priority from before' : 'a different priority (possibly a teammate’s change)';
          entry = { state: 'unknown', message: `Not confirmed. The server shows ${shown}, ${whose}. Retry sends ${label} again.` };
          message = `${lead} When checked just now, the server showed ${shown}, ${whose}.${boardNote(obs)} Retry sends ${label} again.`;
        }
        if (entry) prioritySaves.set(id, { target: value.priority, previous, title, ...entry });
        else prioritySaves.delete(id);
        render();
        if (!onBoard(id)) {
          prioritySaves.delete(id);
          showBox(actionErrorBox, actionErrorText, `${message} ${obs.error ? '' : leftView(title)}`.trim());
        }
        announcePriority(id, message);
      } else if (error?.code === 'NOT_FOUND') {
        prioritySaves.delete(id);
        showBox(actionErrorBox, actionErrorText, `Could not change the priority of “${title}”: the server no longer has this issue. The board was refreshed.`);
        priorityFocusMove = null;
        refreshWeekly();
        await load();
        announcePriority(id, `Could not change the priority of “${title}”: the server no longer has this issue.`);
      } else {
        // A definite rejection: nothing changed. The card shows the saved value
        // again, says why, and offers Retry.
        prioritySaves.set(id, { state: 'failed', target: value.priority, previous, title,
          message: `Not saved: ${describe(error)} Still ${priorityName(previous)}.` });
        render();
        announce(`Could not save priority ${label} for “${title}”: ${describe(error)} It is still ${priorityName(previous)}. Use Retry to try again.`);
      }
    }
  }

  // --- edit dialog -------------------------------------------------------------------
  //
  // The dialog tracks, per field, the server value that field was last filled
  // from (its "seed"), and the value the dialog itself last put in or saw at
  // send time (its "placed" value). A field counts as edited while its input
  // differs from its seed, or while it was part of a save whose outcome is
  // still unknown (the server may hold the sent value, so even a value equal to
  // the seed has to be sent again). A save sends only edited fields.
  //
  // When a server observation of the issue arrives (a confirmed save reply, or
  // the check after an unknown outcome), a field the user changed since it was
  // placed, including a change back to the old value, is kept as typed; every
  // other field takes the server's value. Whether the user meant something is
  // decided by what they did after the send, never by comparing with the old
  // seed. The whole stale form is never compared against a newer server copy,
  // so a teammate's change to a field the user did not touch is never sent back.
  const FIELDS = ['title', 'description', 'status', 'priority'];
  const FIELD_LABELS = { title: 'Title', description: 'Description', status: 'Status', priority: 'Priority' };
  const fieldInputs = { title: editTitle, description: editDescription, status: editStatus, priority: editPriority };
  // A record without priority (saved before priority existed) seeds the
  // control with Normal; priority is then sent only if the user changes it.
  const serverValue = (issue, field) => {
    if (field === 'description') return issue.description || '';
    if (field === 'priority') return effectivePriority(issue);
    return issue[field];
  };
  // Titles are stored trimmed (contract), so they are compared trimmed.
  const sameValue = (field, a, b) => (field === 'title' ? String(a).trim() === String(b).trim() : a === b);
  const editedFields = () => FIELDS.filter(field => edit.uncertain.has(field)
    || !sameValue(field, fieldInputs[field].value, edit.seed[field]));
  const changedSincePlaced = field => !sameValue(field, fieldInputs[field].value, edit.placed[field]);
  const placeCurrent = () => { edit.placed = Object.fromEntries(FIELDS.map(field => [field, fieldInputs[field].value])); };
  function editPatch() {
    const patch = {};
    for (const field of editedFields()) patch[field] = fieldInputs[field].value;
    return patch;
  }
  function seedFrom(issue) {
    edit.issue = issue;
    edit.seed = Object.fromEntries(FIELDS.map(field => [field, serverValue(issue, field)]));
    for (const field of FIELDS) fieldInputs[field].value = edit.seed[field];
    edit.placed = { ...edit.seed };
    edit.uncertain = new Set();
  }
  // Take in a server observation of this issue. A field is kept as typed when
  // the user changed it since it was placed (after the send or the last
  // observation, even back to the old value), or when it belongs to an
  // unconfirmed save (`outstanding`: field to value sent) and the server does
  // not show the value sent. Every other field takes the server value.
  function syncFromServer(issue, outstanding = {}) {
    for (const field of FIELDS) {
      const value = serverValue(issue, field);
      const input = fieldInputs[field];
      const notApplied = field in outstanding && !sameValue(field, value, outstanding[field]);
      if (!changedSincePlaced(field) && !notApplied) {
        input.value = value;
        edit.placed[field] = value;
      }
      edit.seed[field] = value;
    }
    edit.uncertain = new Set();
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
  const editFields = [editTitle, editDescription, editStatus, editPriority];

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
      const toSend = editedFields();
      const retry = toSend.length > 0
        ? `Choose Check again, or Save changes to send only the fields you edited (${fieldList(toSend)}).`
        : 'Choose Check again, or Cancel to close.';
      showBox(editError, editError, `${lead} The server could not be checked either: ${describe(obs.error)} ${kept} ${retry}`);
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
    syncFromServer(latest, pending.submitted);
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
    if (errors.priority) showBox(editError, editError, errors.priority);
    if (errors.title || errors.description || errors.priority) {
      (errors.title ? editTitle : errors.description ? editDescription : editPriority).focus();
      return;
    }
    // The seeds of the submitted fields at send time, to describe a later check.
    const before = { ...edit.seed };
    // What the form held when sent: anything changed after this is new intent.
    placeCurrent();
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
        edit.uncertain = new Set(Object.keys(value));
        editCheck.hidden = false;
        await checkEdit();
      } else if (error?.code === 'NOT_FOUND') {
        showBox(editError, editError, `Could not save: the server no longer has this issue. Your changes are kept here so you can copy them. The board was refreshed.`);
        refreshWeekly();
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
    refreshWeekly();
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

  // --- weekly summary behaviour ---------------------------------------------------------
  const weekLabel = week => `${formatUtcDay(week)} to ${formatUtcDay(addUtcDays(week, 6))} (UTC)`;
  const supportedRange = () => `The weekly summary covers the weeks from ${formatUtcDay(FIRST_WEEK_START)} to ${formatUtcDay(addUtcDays(LAST_WEEK_START, 6))} (UTC), because its dates are written with four-digit years.`;
  const outOfRange = () => new ApiError('WEEK_OUT_OF_RANGE', `That week is outside the dates it can show. ${supportedRange()}`, 0);
  // The week each button would select, or null when that week can't be shown
  // (the button is then disabled, so it never leads to an unsupported week).
  const weekTargets = () => ({
    prev: weekly.week && isSupportedWeek(addUtcDays(weekly.week, -7)) ? addUtcDays(weekly.week, -7) : null,
    next: weekly.week && isSupportedWeek(addUtcDays(weekly.week, 7)) ? addUtcDays(weekly.week, 7) : null,
    current: isSupportedWeek(utcWeekStart(now())) ? utcWeekStart(now()) : null,
  });
  function renderWeekly() {
    if (!reports) return;
    const week = weekly.week;
    const supported = isSupportedWeek(week);
    weeklyRange.textContent = supported ? `Week of ${weekLabel(week)}` : 'No week selected.';
    if (supported && weeklyWeek.value !== week && doc.activeElement !== weeklyWeek) weeklyWeek.value = week;
    const targets = weekTargets();
    weeklyPrev.disabled = !targets.prev;
    weeklyNext.disabled = !targets.next;
    weeklyThis.disabled = !targets.current;
    const edge = !supported ? ''
      : week === FIRST_WEEK_START ? `This is the earliest week the summary can show. ${supportedRange()}`
        : week === LAST_WEEK_START ? `This is the latest week the summary can show. ${supportedRange()}`
          : '';
    weeklyEdge.textContent = edge;
    weeklyEdge.hidden = edge === '';
    // Only a report for the week now selected is ever shown.
    const data = weekly.data && weekly.data.weekStart === week ? weekly.data : null;
    weeklySection.setAttribute('aria-busy', weekly.loading ? 'true' : 'false');
    weeklySection.classList.toggle('is-loading', weekly.loading);
    weeklyRetry.setAttribute('aria-disabled', weekly.loading ? 'true' : 'false');
    weeklyRetry.textContent = weekly.loading ? 'Retrying…' : 'Retry';
    showBox(weeklyError, weeklyErrorText, weekly.error
      ? `Could not load the weekly summary: ${describe(weekly.error)} ${data ? 'Showing the last summary that loaded for this week.' : ''}`.trim()
      : '');
    if (weekly.loading) weeklyStatus.textContent = data ? 'Updating the summary…' : 'Loading the summary…';
    else if (weekly.error) weeklyStatus.textContent = data ? '' : 'The summary for this week is not available right now.';
    else if (data && data.created.total === 0) weeklyStatus.textContent = 'No issues were created in this week.';
    else weeklyStatus.textContent = '';
    weeklyStatus.hidden = weeklyStatus.textContent === '';
    weeklyResult.hidden = !data || data.created.total === 0;
    if (!data) return;
    const { total, byStatus: statusCounts, byPriority: priorityCounts } = data.created;
    weeklyTotal.textContent = String(total);
    weeklyTotalLabel.textContent = total === 1 ? 'issue created in this week' : 'issues created in this week';
    const fill = (part, counts) => {
      for (const [key, el] of Object.entries(part.counts)) el.textContent = String(counts[key]);
      for (const [key, el] of Object.entries(part.bars)) if (el.style) el.style.width = `${total ? Math.round((counts[key] / total) * 100) : 0}%`;
    };
    fill(byStatus, statusCounts);
    fill(byPriority, priorityCounts);
  }
  function weeklySummaryText(data) {
    const t = data.created.total;
    if (t === 0) return `No issues were created in the week of ${weekLabel(data.weekStart)}.`;
    const parts = STATUSES.map(k => `${STATUS_LABELS[k]} ${data.created.byStatus[k]}`).join(', ');
    const prios = PRIORITIES.map(k => `${PRIORITY_LABELS[k]} ${data.created.byPriority[k]}`).join(', ');
    return `${t} ${t === 1 ? 'issue' : 'issues'} created in the week of ${weekLabel(data.weekStart)}. Status: ${parts}. Priority: ${prios}.`;
  }
  // Read the report for the selected week. A reply for an older request (an
  // earlier week, or an earlier read of this week) never replaces a newer one.
  // announce: say the result (only for loads the user asked for).
  function loadWeekly({ announceResult = false } = {}) {
    if (!reports) return Promise.resolve(false);
    const seq = ++weekly.seq;
    const week = weekly.week;
    if (!isSupportedWeek(week)) {
      // Nothing to read (for example a clock outside the supported years).
      weekly.loading = false;
      weekly.error = outOfRange();
      renderWeekly();
      if (announceResult) announce(`Could not load the weekly summary: ${describe(weekly.error)}`);
      weekly.pending = Promise.resolve(false);
      return weekly.pending;
    }
    weekly.loading = true;
    renderWeekly();
    const run = (async () => {
      let data = null;
      let error = null;
      try {
        data = await reports.weeklyReport(week);
        if (!isValidWeeklyReport(data, week)) {
          throw new ApiError('INVALID_RESPONSE', 'The server sent a response the board could not read.', 200, { outcomeUnknown: true });
        }
      } catch (err) {
        error = err;
      }
      if (seq !== weekly.seq) return false;
      weekly.loading = false;
      if (error) weekly.error = error;
      else { weekly.data = data; weekly.error = null; }
      const retryHadFocus = doc.activeElement === weeklyRetry;
      renderWeekly();
      if (!error && retryHadFocus) weeklyHeading.focus();
      if (announceResult) {
        announce(error ? `Could not load the weekly summary: ${describe(error)}` : weeklySummaryText(data));
      }
      return !error;
    })();
    weekly.pending = run;
    return run;
  }
  // Something on the board may have changed on the server: read the selected
  // week again. It never touches drafts, filters or focus.
  function refreshWeekly() { if (reports) loadWeekly(); }
  function selectWeek(week, { announceResult = true } = {}) {
    setFieldError(weeklyWeek, weeklyWeekError, '');
    weekly.week = week;
    weeklyWeek.value = week;
    return loadWeekly({ announceResult });
  }
  // Week selection and Retry (active once the summary is shown).
  weeklyWeek.addEventListener('change', () => {
    if (!parseIsoDate(weeklyWeek.value)) {
      setFieldError(weeklyWeek, weeklyWeekError, 'Enter a full date, for example 2026-09-28.');
      return;
    }
    const week = utcWeekStart(weeklyWeek.value);
    if (!isSupportedWeek(week)) {
      // The week of that day can't be named with four-digit dates: say so and
      // keep showing the week already selected.
      setFieldError(weeklyWeek, weeklyWeekError, `The week of ${weeklyWeek.value} can't be shown. ${supportedRange()}`);
      return;
    }
    if (week === weekly.week && !weekly.error) {
      // Another day of the week already shown: name its Monday, read nothing.
      setFieldError(weeklyWeek, weeklyWeekError, '');
      weeklyWeek.value = week;
      return;
    }
    selectWeek(week);
  });
  // Each button moves only to a week the summary can show; at the first or
  // last week it is disabled, and focus moves to the week picker rather than
  // being lost on a button that just became disabled.
  const moveTo = (button, key) => {
    const target = weekTargets()[key];
    if (!target) return;
    selectWeek(target);
    if (button.disabled && doc.activeElement === button) weeklyWeek.focus();
  };
  weeklyPrev.addEventListener('click', () => { moveTo(weeklyPrev, 'prev'); });
  weeklyNext.addEventListener('click', () => { moveTo(weeklyNext, 'next'); });
  weeklyThis.addEventListener('click', () => { moveTo(weeklyThis, 'current'); });
  weeklyRetry.addEventListener('click', () => {
    if (weekly.loading) return;
    loadWeekly({ announceResult: true });
  });

  // Show the Weekly summary for the current UTC week and read its report.
  function showWeeklySummary(source) {
    if (reports || !source || typeof source.weeklyReport !== 'function') return Promise.resolve(false);
    reports = source;
    weekly.week = utcWeekStart(now());
    sidebar.append(weeklySection);
    return loadWeekly();
  }

  // --- filters -------------------------------------------------------------------------
  searchInput.addEventListener('input', () => {
    state.filters.q = searchInput.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; load(); }, searchDelayMs);
  });
  filterSelect.addEventListener('change', () => {
    showPriorityNotice('');
    state.filters.status = filterSelect.value;
    load();
  });
  priorityFilter.addEventListener('change', () => {
    showPriorityNotice('');
    state.filters.priority = priorityFilter.value;
    load();
  });
  retryButton.addEventListener('click', () => load());
  refreshButton.addEventListener('click', async () => {
    if (state.loading) return;
    refreshWeekly();
    // Announce only when this request's result is the one on the board; a
    // search or filter started meanwhile supersedes it and reports itself.
    if (await load()) announce(`Board refreshed. ${boardStatus.textContent}`);
  });
  dismissButton.addEventListener('click', () => showBox(actionErrorBox, actionErrorText, ''));

  const ready = load();
  showWeeklySummary(reportSource);
  return { state, ready, reload: load, adapter, showWeeklySummary,
    weekly: { state: weekly, idle: () => weekly.pending, reload: () => loadWeekly() } };
}

// ---------------------------------------------------------------------------
// Browser boot (skipped when imported by Node tests)
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.getElementById('app');
  if (root) {
    // The board, then its Weekly summary (GET /api/reports/weekly).
    const board = mountApp(root, { adapter: createHttpAdapter(), doc: document });
    board.showWeeklySummary(createHttpAdapter());
  }
}
