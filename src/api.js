// Issue API for TEST-API; implements the contract in specs/issue-tracker.md
// and specs/weekly-delivery-summary.md.
// Routes: GET/POST /api/issues, PATCH /api/issues/:id, GET /api/reports/weekly,
// POST /api/imports, POST /api/imports/match, POST /api/imports/precheck,
// GET /api/imports/:importKey (specs/historical-issue-import.md);
// other methods get 405.
import { createHash } from 'node:crypto';
import { IssueStore } from './store.js';
import { isImportKey, validateImportCsv, validRowsSelection, MAX_CSV_BYTES, MAX_IMPORT_ROWS } from '../public/csv-import.js';

const ISSUE_STATUSES = new Set(['open', 'in_progress', 'done']);
const ISSUE_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const BODY_LIMIT_BYTES = 16 * 1024;
// An import carries a whole CSV file (at most MAX_CSV_BYTES of UTF-8) inside
// JSON; escaping can grow it, so the envelope gets a larger, still bounded limit.
const IMPORT_BODY_LIMIT_BYTES = 1024 * 1024;
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

function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: details === undefined ? { code, message } : { code, message, details } });
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

function readBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolveBody) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolveBody({ ok: false, reason: 'too_large' });
      return;
    }
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > limit) {
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

async function parseJsonBody(req, res, limit = BODY_LIMIT_BYTES) {
  const read = await readBody(req, limit);
  if (!read.ok) {
    if (read.reason === 'too_large') {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Request body exceeds the ${limit / 1024} KiB limit.`);
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

// Exact ordering of two accepted ISO UTC timestamps. Date.parse truncates
// beyond milliseconds, but stored timestamps may carry more fractional
// digits; two distinct instants must never collapse into an append-order
// tie. Compare whole seconds numerically, then the fractional digits padded
// to a common scale (equal-value fractions compare equal, so genuine ties
// still fall back to append order in the caller).
const ISO_UTC_PARTS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;
function compareInstants(a, b) {
  const partA = ISO_UTC_PARTS.exec(a);
  const partB = ISO_UTC_PARTS.exec(b);
  const wholeA = Date.parse(partA[1] + 'Z');
  const wholeB = Date.parse(partB[1] + 'Z');
  if (wholeA !== wholeB) return wholeA < wholeB ? -1 : 1;
  const fractionA = partA[2] ?? '';
  const fractionB = partB[2] ?? '';
  const width = Math.max(fractionA.length, fractionB.length);
  const scaledA = fractionA.padEnd(width, '0');
  const scaledB = fractionB.padEnd(width, '0');
  if (scaledA === scaledB) return 0;
  return scaledA < scaledB ? -1 : 1;
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
  // separately. Its priority bucket comes from the earliest event inside the
  // week (append order breaks equal-time ties), read from that event's
  // {at, priority} snapshot: later priority edits and same-week
  // re-completions can never rewrite the history a week already recorded.
  // Pre-snapshot string events have no completion-time priority; the issues
  // they first-completed count once, but only in priorityUnknown — never a
  // guessed enum bucket.
  const items = await getStore().list();
  const byStatus = { open: 0, in_progress: 0, done: 0 };
  const byPriority = { low: 0, normal: 0, high: 0, urgent: 0 };
  const completedByPriority = { low: 0, normal: 0, high: 0, urgent: 0 };
  let total = 0;
  let completedTotal = 0;
  let priorityUnknown = 0;
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
    let eventsInWeek = 0;
    let firstEvent = null; // earliest in-week event by full instant precision
    let firstEventAt = null; // append order wins only true ties
    for (const event of issue.completions) {
      const at = typeof event === 'string' ? event : event.at;
      const eventMs = Date.parse(at);
      if (eventMs >= startMs && eventMs < endMs) {
        eventsInWeek += 1;
        if (firstEventAt === null || compareInstants(at, firstEventAt) < 0) {
          firstEvent = event;
          firstEventAt = at;
        }
      }
    }
    if (eventsInWeek > 0) {
      completedTotal += 1;
      if (typeof firstEvent === 'string') priorityUnknown += 1;
      else completedByPriority[firstEvent.priority] += 1;
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
    schemaVersion: 3,
    weekStart: formatIsoDate(startMs),
    weekEndExclusive: formatIsoDate(endMs),
    created: { total, byStatus, byPriority },
    completed: {
      total: completedTotal,
      byPriority: completedByPriority,
      priorityUnknown,
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

function toImportResource(record, replayed) {
  return {
    import: {
      importKey: record.importKey,
      status: 'committed',
      mode: record.mode === 'valid_rows' ? 'valid_rows' : 'all',
      createdAt: record.createdAt,
      issueCount: record.issueIds.length,
      issueIds: record.issueIds.slice(),
      excludedRows: (record.excludedRows || []).map((row) => ({
        line: row.line,
        problems: row.problems.map((entry) => ({ column: entry.column, reason: entry.reason })),
      })),
    },
    replayed,
  };
}

// The digest identifies the exact committed choice. For files without
// external references it stays byte-identical to the original scheme
// (normalized rows, plus mode and excluded lines for a valid-rows import), so
// imports committed before references existed still replay. A file that
// carries references — or any explicit duplicate decision — instead binds the
// pre-skip rows, the excluded lines and the whole decision map, so the digest
// never depends on which references happen to exist at request time: the same
// key, file and decisions always replay, and a different decision is always
// a conflict.
function importDigest(rows, excludedLines = null, decisions = null) {
  const hasRefs = rows.some((row) => row.externalRef);
  const tuples = rows.map((row) =>
    hasRefs ? [row.title, row.description, row.status, row.priority, row.externalRef || ''] : [row.title, row.description, row.status, row.priority],
  );
  if (!hasRefs && !decisions) {
    return createHash('sha256').update(JSON.stringify(excludedLines === null ? tuples : ['valid_rows', tuples, excludedLines])).digest('hex');
  }
  return createHash('sha256')
    .update(JSON.stringify(['external_ref', excludedLines === null ? null : excludedLines, tuples, decisions || {}]))
    .digest('hex');
}

const rowProblemList = (rows) =>
  rows.map((row) => ({ line: row.line, errors: row.errors, problems: row.problems.map((entry) => ({ column: entry.column, reason: entry.reason })) }));

// duplicateDecisions maps every flagged data line to "skip" | "import".
// Returns {ok:false} after sending the refusal, or {ok:true, value} where
// value is null when the field was absent.
function parseDuplicateDecisions(value, res) {
  if (value === undefined) return { ok: true, value: null };
  if (!isPlainObject(value)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'duplicateDecisions must be an object mapping duplicate external_ref line numbers to "skip" or "import".');
    return { ok: false };
  }
  for (const [rawLine, choice] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(rawLine) || !Number.isSafeInteger(Number(rawLine)) || Number(rawLine) < 2 || (choice !== 'skip' && choice !== 'import')) {
      sendError(res, 400, 'VALIDATION_ERROR', 'duplicateDecisions keys must be data line numbers and each value must be "skip" or "import".');
      return { ok: false };
    }
  }
  return { ok: true, value };
}

// Which rows of a validated file carry a duplicate external reference:
// repeated inside the file or already present on an imported issue — counted
// only among rows that could ever be imported (rows without problems), like
// the batch a commit would store. Advisory only — the preview uses it to ask
// for skip-or-import decisions. The commit path never consults it: the store
// re-decides duplicates against its durable snapshot inside the serialized
// write queue, so replay, conflict and duplicate outcomes can never race
// this read.
async function collectDuplicateFlags(validation) {
  const importable = validation.rows.filter((row) => row.errors.length === 0);
  const flags = new Map();
  for (const group of validation.duplicates) {
    for (const line of group.lines) flags.set(line, { line, externalRef: group.externalRef, kind: 'in_file', lines: group.lines });
  }
  const refs = [...new Set(importable.map((row) => row.issue.externalRef).filter(Boolean))];
  if (refs.length > 0) {
    const existing = await getStore().listByExternalRefs(refs);
    const firstByRef = new Map();
    for (const issue of existing) if (!firstByRef.has(issue.externalRef)) firstByRef.set(issue.externalRef, issue);
    for (const row of importable) {
      const ref = row.issue.externalRef;
      const earlier = ref ? firstByRef.get(ref) : undefined;
      if (earlier && !flags.has(row.line)) {
        flags.set(row.line, { line: row.line, externalRef: ref, kind: 'already_imported', issueId: earlier.id, createdAt: earlier.createdAt });
      }
    }
  }
  return flags;
}

// Commit: the server re-parses and re-validates the CSV itself. By default
// (mode "all") any file or row problem rejects the entire batch before
// anything is written. Only an explicit mode "valid_rows" — with the exact
// excluded lines the user saw — commits the valid subset, atomically, and
// records which lines were left out and why. File-level problems (limits,
// columns, parse errors) always reject everything. Duplicate external
// references are decided by the store inside its serialized write queue; the
// commit path below never reads imported history, so a same-key replay and a
// read-only match depend only on the request's own digest.
// Parses and validates a commit (or match) request exactly as a commit
// would, without touching the store. Sends the refusal and returns null, or
// returns the resolved batch: {importKey?, digest, rows (importable,
// pre-skip, with line and externalRef), invalidExcluded (null |
// [{line, problems}]), decisions (object | null)}.
async function resolveImportRequest(req, res, { withKey }) {
  const parsed = await parseJsonBody(req, res, IMPORT_BODY_LIMIT_BYTES);
  if (!parsed) return null;
  const body = parsed.value;
  if (!isPlainObject(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    return null;
  }
  if (rejectUnknownFields(res, body, withKey ? ['importKey', 'csv', 'mode', 'excludedLines', 'duplicateDecisions'] : ['csv', 'mode', 'excludedLines', 'duplicateDecisions'])) return null;
  if (withKey && !isImportKey(body.importKey)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'importKey is required and must be a UUID chosen by the client for this import.');
    return null;
  }
  if (typeof body.csv !== 'string') {
    sendError(res, 400, 'VALIDATION_ERROR', 'csv is required and must be the file text.');
    return null;
  }
  const decisions = parseDuplicateDecisions(body.duplicateDecisions, res);
  if (!decisions.ok) return null;
  const mode = body.mode === undefined ? 'all' : body.mode;
  if (mode !== 'all' && mode !== 'valid_rows') {
    sendError(res, 400, 'VALIDATION_ERROR', 'mode must be "all" (the default) or "valid_rows".');
    return null;
  }
  if (mode === 'all' && body.excludedLines !== undefined) {
    sendError(res, 400, 'VALIDATION_ERROR', 'excludedLines is only accepted with mode "valid_rows".');
    return null;
  }
  if (
    mode === 'valid_rows' &&
    (!Array.isArray(body.excludedLines) ||
      body.excludedLines.length < 1 ||
      !body.excludedLines.every((line, index) => Number.isSafeInteger(line) && line > 1 && (index === 0 || line > body.excludedLines[index - 1])))
  ) {
    sendError(res, 400, 'VALIDATION_ERROR', 'mode "valid_rows" requires excludedLines: the ascending line numbers shown as excluded in the preview.');
    return null;
  }
  const validation = validateImportCsv(body.csv);
  const invalidRows = validation.rows.filter((row) => row.errors.length > 0);
  const limits = `limits: ${MAX_CSV_BYTES} bytes, ${MAX_IMPORT_ROWS} issues`;
  let importable;
  let invalidExcluded;
  if (mode === 'all') {
    if (!validation.valid) {
      sendError(res, 400, 'IMPORT_INVALID', `The file cannot be imported; nothing was saved (${limits}).`, {
        fileErrors: validation.fileErrors,
        rowErrors: rowProblemList(invalidRows),
      });
      return null;
    }
    importable = validation.rows;
    invalidExcluded = null;
  } else {
    if (validation.fileErrors.length > 0) {
      sendError(res, 400, 'IMPORT_INVALID', `The file cannot be imported; nothing was saved (${limits}).`, {
        fileErrors: validation.fileErrors,
        rowErrors: [],
      });
      return null;
    }
    const selection = validRowsSelection(validation);
    if (!selection) {
      sendError(
        res,
        400,
        'IMPORT_INVALID',
        invalidRows.length === 0
          ? 'Every row is valid; import the whole file (mode "all") instead. Nothing was saved.'
          : 'No row of this file can be imported; nothing was saved.',
        { fileErrors: [], rowErrors: rowProblemList(invalidRows) },
      );
      return null;
    }
    if (JSON.stringify(selection.excludedLines) !== JSON.stringify(body.excludedLines)) {
      sendError(
        res,
        400,
        'IMPORT_PREVIEW_MISMATCH',
        'The rows the server would exclude differ from the preview you confirmed; nothing was saved. Choose the file again to see a fresh preview.',
        { excludedLines: selection.excludedLines, rowErrors: rowProblemList(selection.excluded) },
      );
      return null;
    }
    importable = selection.valid;
    invalidExcluded = selection.excluded;
  }
  const hasRefs = validation.rows.some((row) => row.issue.externalRef);
  const rows = importable.map((row) => {
    const { title, description, status, priority } = row.issue;
    return row.issue.externalRef ? { line: row.line, title, description, status, priority, externalRef: row.issue.externalRef } : { line: row.line, title, description, status, priority };
  });
  const decisionMap = hasRefs ? decisions.value || {} : null;
  const invalidLines = invalidExcluded === null ? null : invalidExcluded.map((row) => row.line);
  return {
    ...(withKey ? { importKey: body.importKey } : {}),
    digest: importDigest(rows, invalidLines, decisionMap),
    rows,
    invalidExcluded: invalidExcluded === null ? null : invalidExcluded.map((row) => ({ line: row.line, problems: row.problems.map((entry) => ({ column: entry.column, reason: entry.reason })) })),
    decisions: decisionMap,
  };
}

async function commitImport(req, res) {
  const batch = await resolveImportRequest(req, res, { withKey: true });
  if (!batch) return;
  let outcome;
  try {
    outcome = await getStore().importBatch(
      batch.importKey,
      batch.digest,
      batch.rows,
      batch.invalidExcluded === null ? null : { mode: 'valid_rows', excludedRows: batch.invalidExcluded },
      batch.decisions,
    );
  } catch (err) {
    if (err && err.code === 'IMPORT_CONFLICT') {
      sendError(res, 409, 'IMPORT_CONFLICT', 'This importKey was already used for a different file or a different choice of rows; choose the file again to start a new import.');
      return;
    }
    if (err && err.code === 'IMPORT_DUPLICATES_UNDECIDED') {
      sendError(res, 400, 'IMPORT_DUPLICATES_UNDECIDED', 'The file repeats or reuses external reference(s); each duplicate row needs an explicit skip-or-import decision before anything is saved. Nothing was saved.', err.details);
      return;
    }
    if (err && err.code === 'IMPORT_INVALID') {
      sendError(res, 400, 'IMPORT_INVALID', err.message, { fileErrors: [], rowErrors: [] });
      return;
    }
    throw err;
  }
  sendJson(res, outcome.replayed ? 200 : 201, toImportResource(outcome.record, outcome.replayed));
}

// Match: "was this exact content already imported?" Read-only. The request
// is validated like a commit and matched by the same digest (normalized
// rows, plus mode, excluded lines and duplicate decisions where they apply),
// so a page that lost a commit response can tell an already-imported file
// apart from a new one without guessing. The answer comes from the stored
// records alone — never from which references happen to exist right now —
// and duplicates without decisions simply match nothing. Returns every
// committed import with that digest, oldest first, each with its stored
// skipped rows.
async function matchImport(req, res) {
  const batch = await resolveImportRequest(req, res, { withKey: false });
  if (!batch) return;
  const records = await getStore().findImportsByDigest(batch.digest);
  sendJson(res, 200, { matches: records.map((record) => toImportResource(record, false).import) });
}

// Precheck: "which rows of this file carry a duplicate external reference?"
// Read-only, exactly what a commit would flag — repeats inside the file and
// references already present on imported issues — so a preview can collect an
// explicit skip-or-import decision per flagged row. A file a commit would
// refuse for other reasons has nothing checkable and answers empty.
async function precheckImport(req, res) {
  const parsed = await parseJsonBody(req, res, IMPORT_BODY_LIMIT_BYTES);
  if (!parsed) return;
  const body = parsed.value;
  if (!isPlainObject(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    return;
  }
  if (rejectUnknownFields(res, body, ['csv'])) return;
  if (typeof body.csv !== 'string') {
    sendError(res, 400, 'VALIDATION_ERROR', 'csv is required and must be the file text.');
    return;
  }
  const validation = validateImportCsv(body.csv);
  if (validation.fileErrors.length > 0 || validation.rows.length === 0) {
    sendJson(res, 200, { duplicates: [] });
    return;
  }
  const flags = await collectDuplicateFlags(validation);
  sendJson(res, 200, { duplicates: [...flags.values()].sort((a, b) => a.line - b.line) });
}

async function lookupImport(res, rawKey) {
  let key;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    key = '';
  }
  if (!isImportKey(key)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'importKey must be a UUID.');
    return;
  }
  const record = await getStore().getImport(key);
  if (!record) {
    // A missing record is not proof that nothing was saved: a commit of this
    // key may still be in flight and not visible yet. Re-checking later is
    // always safe, and retrying the same commit applies it at most once.
    sendError(
      res,
      404,
      'IMPORT_NOT_FOUND',
      'No committed import is stored under this importKey yet. This does not prove that nothing was saved: a commit of this key may still be in flight. Check again shortly, or send the same commit again — the same importKey and rows commit at most once.',
    );
    return;
  }
  sendJson(res, 200, toImportResource(record, false));
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
    if (url.pathname === '/api/imports') {
      if (req.method === 'POST') {
        await commitImport(req, res);
        return;
      }
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on /api/imports.`);
      return;
    }
    if (url.pathname === '/api/imports/match') {
      if (req.method === 'POST') {
        await matchImport(req, res);
        return;
      }
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on /api/imports/match.`);
      return;
    }
    if (url.pathname === '/api/imports/precheck') {
      if (req.method === 'POST') {
        await precheckImport(req, res);
        return;
      }
      res.setHeader('Allow', 'POST');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on /api/imports/precheck.`);
      return;
    }
    const importMatch = url.pathname.match(/^\/api\/imports\/([^/]+)$/);
    if (importMatch) {
      if (req.method === 'GET') {
        await lookupImport(res, importMatch[1]);
        return;
      }
      res.setHeader('Allow', 'GET');
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on /api/imports/:importKey.`);
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
