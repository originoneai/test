// Issue API for TEST-API; implements the contract in specs/issue-tracker.md
// and specs/weekly-delivery-summary.md.
// Routes: GET/POST /api/issues, PATCH /api/issues/:id, GET /api/reports/weekly;
// other methods get 405.
import { IssueStore } from './store.js';

const ISSUE_STATUSES = new Set(['open', 'in_progress', 'done']);
const ISSUE_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const BODY_LIMIT_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// Both week boundaries are pinned to four-digit YYYY-MM-DD, so the last
// selectable whole week starts 9999-12-20 (its exclusive end is 9999-12-27).
// setUTCFullYear rather than Date.UTC for symmetry with parseIsoDate.
const lastSelectableWeek = new Date(0);
lastSelectableWeek.setUTCFullYear(9999, 11, 20);
lastSelectableWeek.setUTCHours(0, 0, 0, 0);
const LAST_SELECTABLE_WEEK_MS = lastSelectableWeek.getTime();

let sharedStore = null;

// Tests point DATA_DIR at an isolated directory and reset the cached store.
export function resetApiStore() {
  sharedStore = null;
}

function getStore() {
  if (!sharedStore) sharedStore = new IssueStore();
  return sharedStore;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Board data is cooperative and changes often; a stale cached list after
    // someone else's mutation would be silently wrong, so never store it.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The issue resource is exactly the seven public fields; the server-internal
// completion history never leaves through an issue response, only through the
// weekly report.
function toIssueResource(issue) {
  const { completions, ...resource } = issue;
  return resource;
}

// Never interpolate client-supplied values into strings directly: objects can
// carry a null/hostile toString and implicit conversion throws (observed as a
// 500 for status {"toString": null}). JSON.stringify cannot invoke it.
function displayValue(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = '[unserializable]';
  }
  if (text === undefined) text = 'undefined';
  return text.length > 80 ? text.slice(0, 77) + '...' : text;
}

function readBody(req) {
  return new Promise((resolveBody) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
      req.resume();
      resolveBody({ ok: false, reason: 'too_large' });
      return;
    }
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > BODY_LIMIT_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolveBody(
        tooLarge ? { ok: false, reason: 'too_large' } : { ok: true, raw: Buffer.concat(chunks).toString('utf8') },
      );
    });
    req.on('error', () => resolveBody({ ok: false, reason: 'aborted' }));
  });
}

async function parseJsonBody(req, res) {
  const read = await readBody(req);
  if (!read.ok) {
    if (read.reason === 'too_large') {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the 16 KiB limit.');
    } else {
      sendError(res, 400, 'INVALID_JSON', 'Request body could not be read.');
    }
    return null;
  }
  try {
    return { value: JSON.parse(read.raw) };
  } catch {
    sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.');
    return null;
  }
}

function validateTitle(value) {
  if (typeof value !== 'string') return 'title must be a string.';
  const trimmed = value.trim();
  if (trimmed.length < 1) return 'title is required and must contain 1-120 non-whitespace characters.';
  if (trimmed.length > TITLE_MAX) return `title must be at most ${TITLE_MAX} characters after trimming.`;
  return null;
}

function validateDescription(value) {
  if (typeof value !== 'string') return 'description must be a string.';
  if (value.length > DESCRIPTION_MAX) return `description must be at most ${DESCRIPTION_MAX} characters.`;
  return null;
}

function validateStatus(value) {
  if (typeof value !== 'string') return 'status must be a string.';
  if (!ISSUE_STATUSES.has(value)) {
    return `Invalid status ${displayValue(value)}; expected one of: open, in_progress, done.`;
  }
  return null;
}

function validatePriority(value) {
  if (typeof value !== 'string') return 'priority must be a string.';
  if (!ISSUE_PRIORITIES.has(value)) {
    return `Invalid priority ${displayValue(value)}; expected one of: low, normal, high, urgent.`;
  }
  return null;
}

function rejectUnknownFields(res, body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return false;
  sendError(
    res,
    400,
    'VALIDATION_ERROR',
    `Unknown field(s): ${unknown.map((key) => displayValue(key)).join(', ')}. Accepted fields: ${allowed.join(', ')}.`,
  );
  return true;
}

// A real calendar date in exactly YYYY-MM-DD form, as UTC milliseconds. Date
// parsing alone cannot be trusted: Date.UTC normalizes impossible dates
// (Feb 30 rolls into March) instead of rejecting them, so validity is checked
// by rebuilding the UTC calendar components and comparing them. setUTCFullYear
// is used because Date.UTC maps two-digit years into 1900-1999.
function parseIsoDate(value) {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return utc.getTime();
}

// Manual UTC formatting instead of toISOString: the schema pins both week
// boundaries to four-digit YYYY-MM-DD, so the year is zero-padded to four
// digits (getUTCFullYear alone would drop the leading zeros of 0099 or 0100).
// Weeks whose exclusive end would need a fifth digit are rejected upstream in
// weeklyReport, never formatted here.
function formatIsoDate(ms) {
  const date = new Date(ms);
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

// The Monday 00:00 UTC of the week the given instant falls in. UTC has no DST,
// so a fixed number of whole days always lands on midnight.
function startOfUtcWeek(ms) {
  const date = new Date(ms);
  const midnight = new Date(0);
  midnight.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS;
}

async function weeklyReport(searchParams, res) {
  // Exactly one optional parameter is accepted; unknown names and repeats are
  // definite input errors, mirroring the unknown-field rule on mutations.
  const problems = [];
  let weekStartCount = 0;
  for (const key of searchParams.keys()) {
    if (key === 'weekStart') weekStartCount += 1;
    else problems.push(`Unknown parameter(s): ${displayValue(key)}.`);
  }
  if (weekStartCount > 1) problems.push('weekStart must be provided at most once.');
  if (problems.length > 0) {
    sendError(res, 400, 'VALIDATION_ERROR', `${problems.join(' ')} Accepted parameters: weekStart.`);
    return;
  }
  const provided = searchParams.get('weekStart');
  let startMs;
  if (provided === null) {
    startMs = startOfUtcWeek(Date.now());
  } else {
    startMs = parseIsoDate(provided);
    if (startMs === null) {
      sendError(res, 400, 'VALIDATION_ERROR', `Invalid weekStart ${displayValue(provided)}; expected a real date as YYYY-MM-DD.`);
      return;
    }
    // Impossible calendar dates were rejected above; here only the weekday can
    // still be wrong. Midnight UTC makes getUTCDay exact.
    if (new Date(startMs).getUTCDay() !== 1) {
      sendError(res, 400, 'VALIDATION_ERROR', `Invalid weekStart ${displayValue(provided)}; weeks start on a Monday (UTC).`);
      return;
    }
    // Both boundaries must stay four-digit YYYY-MM-DD: the last selectable
    // whole week starts 9999-12-20; 9999-12-27 would end in year 10000.
    if (startMs > LAST_SELECTABLE_WEEK_MS) {
      sendError(res, 400, 'VALIDATION_ERROR', `Invalid weekStart ${displayValue(provided)}; the week must end within year 9999.`);
      return;
    }
  }
  const endMs = startMs + WEEK_DAYS * DAY_MS;
  // Two independent statistics over the same committed snapshot. `created`
  // describes the week's intake: an issue belongs to the week its immutable
  // createdAt falls in, tallied with the status and priority stored right
  // now. `completed` describes the week's throughput: an issue counts once in
  // every week that holds at least one of its recorded completion events —
  // regardless of its current status, so reopened work keeps the credit for
  // the week it was really done — with extra same-week events counted
  // separately and the priority bucket following the currently stored value.
  const items = await getStore().list();
  const byStatus = { open: 0, in_progress: 0, done: 0 };
  const byPriority = { low: 0, normal: 0, high: 0, urgent: 0 };
  const completedByPriority = { low: 0, normal: 0, high: 0, urgent: 0 };
  let total = 0;
  let completedTotal = 0;
  let createdThisWeek = 0;
  let createdEarlier = 0;
  let repeatCompletions = 0;
  let completedTimingUnknown = 0;
  for (const issue of items) {
    const createdMs = Date.parse(issue.createdAt);
    const createdInWeek = createdMs >= startMs && createdMs < endMs;
    if (createdInWeek) {
      byStatus[issue.status] += 1;
      byPriority[issue.priority] += 1;
      total += 1;
    }
    const eventsInWeek = issue.completions.reduce(
      (count, event) => {
        const eventMs = Date.parse(event);
        return eventMs >= startMs && eventMs < endMs ? count + 1 : count;
      },
      0,
    );
    if (eventsInWeek > 0) {
      completedTotal += 1;
      completedByPriority[issue.priority] += 1;
      // A partition by the known createdAt: created inside the week, or not.
      if (createdInWeek) createdThisWeek += 1;
      else createdEarlier += 1;
      repeatCompletions += eventsInWeek - 1;
    }
    // Done with no recorded event anywhere: the pre-history legacy case. It
    // belongs to no week and is reported as unknown regardless of selection.
    if (issue.status === 'done' && issue.completions.length === 0) completedTimingUnknown += 1;
  }
  sendJson(res, 200, {
    schemaVersion: 2,
    weekStart: formatIsoDate(startMs),
    weekEndExclusive: formatIsoDate(endMs),
    created: { total, byStatus, byPriority },
    completed: {
      total: completedTotal,
      byPriority: completedByPriority,
      createdThisWeek,
      createdEarlier,
      repeatCompletions,
    },
    completedTimingUnknown,
  });
}

async function listIssues(searchParams, res) {
  const status = searchParams.get('status');
  if (status !== null && !ISSUE_STATUSES.has(status)) {
    sendError(res, 400, 'VALIDATION_ERROR', `Invalid status filter ${displayValue(status)}; expected one of: open, in_progress, done.`);
    return;
  }
  const priority = searchParams.get('priority');
  if (priority !== null && !ISSUE_PRIORITIES.has(priority)) {
    sendError(res, 400, 'VALIDATION_ERROR', `Invalid priority filter ${displayValue(priority)}; expected one of: low, normal, high, urgent.`);
    return;
  }
  const query = searchParams.get('q');
  const items = await getStore().list({
    status: status || undefined,
    priority: priority || undefined,
    query: query === null ? undefined : query,
  });
  sendJson(res, 200, { items: items.map(toIssueResource) });
}

async function createIssue(req, res) {
  const parsed = await parseJsonBody(req, res);
  if (!parsed) return;
  const body = parsed.value;
  if (!isPlainObject(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    return;
  }
  if (rejectUnknownFields(res, body, ['title', 'description', 'priority'])) return;
  if (!('title' in body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'title is required.');
    return;
  }
  const titleError = validateTitle(body.title);
  if (titleError) {
    sendError(res, 400, 'VALIDATION_ERROR', titleError);
    return;
  }
  let description = '';
  if ('description' in body) {
    const descriptionError = validateDescription(body.description);
    if (descriptionError) {
      sendError(res, 400, 'VALIDATION_ERROR', descriptionError);
      return;
    }
    description = body.description;
  }
  let priority = 'normal';
  if ('priority' in body) {
    const priorityError = validatePriority(body.priority);
    if (priorityError) {
      sendError(res, 400, 'VALIDATION_ERROR', priorityError);
      return;
    }
    priority = body.priority;
  }
  const issue = await getStore().create({ title: body.title.trim(), description, priority });
  sendJson(res, 201, toIssueResource(issue));
}

async function updateIssue(req, res, id) {
  const parsed = await parseJsonBody(req, res);
  if (!parsed) return;
  const body = parsed.value;
  if (!isPlainObject(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    return;
  }
  if (rejectUnknownFields(res, body, ['title', 'description', 'status', 'priority'])) return;
  const patch = {};
  if ('title' in body) {
    const titleError = validateTitle(body.title);
    if (titleError) {
      sendError(res, 400, 'VALIDATION_ERROR', titleError);
      return;
    }
    patch.title = body.title.trim();
  }
  if ('description' in body) {
    const descriptionError = validateDescription(body.description);
    if (descriptionError) {
      sendError(res, 400, 'VALIDATION_ERROR', descriptionError);
      return;
    }
    patch.description = body.description;
  }
  if ('status' in body) {
    const statusError = validateStatus(body.status);
    if (statusError) {
      sendError(res, 400, 'VALIDATION_ERROR', statusError);
      return;
    }
    patch.status = body.status;
  }
  if ('priority' in body) {
    const priorityError = validatePriority(body.priority);
    if (priorityError) {
      sendError(res, 400, 'VALIDATION_ERROR', priorityError);
      return;
    }
    patch.priority = body.priority;
  }
  if (Object.keys(patch).length === 0) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Provide at least one of: title, description, status, priority.');
    return;
  }
  const updated = await getStore().update(id, patch);
  if (!updated) {
    sendError(res, 404, 'NOT_FOUND', `No issue with id ${displayValue(id)}.`);
    return;
  }
  sendJson(res, 200, toIssueResource(updated));
}

export async function handleApi(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    sendError(res, 400, 'INVALID_URL', 'Malformed request URL.');
    return;
  }
  try {
    if (url.pathname === '/api/issues') {
      if (req.method === 'GET') {
        await listIssues(url.searchParams, res);
        return;
      }
      if (req.method === 'POST') {
        await createIssue(req, res);
        return;
      }
      res.setHeader('Allow', 'GET, POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on /api/issues.`);
      return;
    }
    const itemMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (itemMatch) {
      if (req.method === 'PATCH') {
        await updateIssue(req, res, itemMatch[1]);
        return;
      }
      res.setHeader('Allow', 'PATCH');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on /api/issues/:id.`);
      return;
    }
    if (url.pathname === '/api/reports/weekly') {
      if (req.method === 'GET') {
        await weeklyReport(url.searchParams, res);
        return;
      }
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on /api/reports/weekly.`);
      return;
    }
    sendError(res, 404, 'NOT_FOUND', 'Unknown API resource.');
  } catch (err) {
    // Visible failure: full detail on stderr, no stack trace in the response body.
    console.error(`[issue-api] ${req.method} ${url.pathname} failed: ${err && err.stack ? err.stack : err}`);
    if (err && err.code === 'STORE_ERROR') {
      sendError(res, 500, 'STORAGE_ERROR', 'Issue storage is unavailable; the store file was not modified.');
      return;
    }
    if (!res.headersSent) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error.');
    } else {
      res.destroy();
    }
  }
}
