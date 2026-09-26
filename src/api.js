// Issue API for TEST-API; implements the contract in specs/issue-tracker.md.
// Routes: GET/POST /api/issues, PATCH /api/issues/:id; other methods get 405.
import { IssueStore } from './store.js';

const ISSUE_STATUSES = new Set(['open', 'in_progress', 'done']);
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const BODY_LIMIT_BYTES = 16 * 1024;

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

async function listIssues(searchParams, res) {
  const status = searchParams.get('status');
  if (status !== null && !ISSUE_STATUSES.has(status)) {
    sendError(res, 400, 'VALIDATION_ERROR', `Invalid status filter ${displayValue(status)}; expected one of: open, in_progress, done.`);
    return;
  }
  const query = searchParams.get('q');
  const items = await getStore().list({ status: status || undefined, query: query === null ? undefined : query });
  sendJson(res, 200, { items });
}

async function createIssue(req, res) {
  const parsed = await parseJsonBody(req, res);
  if (!parsed) return;
  const body = parsed.value;
  if (!isPlainObject(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    return;
  }
  if (rejectUnknownFields(res, body, ['title', 'description'])) return;
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
  const issue = await getStore().create({ title: body.title.trim(), description });
  sendJson(res, 201, issue);
}

async function updateIssue(req, res, id) {
  const parsed = await parseJsonBody(req, res);
  if (!parsed) return;
  const body = parsed.value;
  if (!isPlainObject(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    return;
  }
  if (rejectUnknownFields(res, body, ['title', 'description', 'status'])) return;
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
  if (Object.keys(patch).length === 0) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Provide at least one of: title, description, status.');
    return;
  }
  const updated = await getStore().update(id, patch);
  if (!updated) {
    sendError(res, 404, 'NOT_FOUND', `No issue with id ${displayValue(id)}.`);
    return;
  }
  sendJson(res, 200, updated);
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
