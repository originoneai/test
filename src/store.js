// Durable JSON issue store for TEST-API (specs/issue-tracker.md).
// Single JSON file under DATA_DIR. Writes are atomic (temp file + fsync + rename,
// then a best-effort directory fsync where the platform allows it) and serialized
// in-process. Surviving a process crash or restart is covered by tests;
// power-loss durability is platform/filesystem-dependent and not claimed. A mutation commits in two phases: it first persists
// a candidate snapshot, and only after that succeeds is the snapshot published
// to memory. Readers therefore never observe data that is not durable, and a
// failed write leaves both disk and memory at the previous committed state, so
// nothing uncommitted can ride along with a later successful write.
// A corrupt store file is reported, never rewritten. Pre-priority records
// (exactly the legacy six fields) are valid legacy data: they read as
// 'normal' and are upgraded on disk only by the next successful write,
// never by a read. Completion history is the same pattern one step later:
// records without a completions list read as no recorded events, and each
// accepted arrival in 'done' (creation as done, or a transition from another
// status) appends one server-clock UTC event atomically with the mutation.
// The list is append-only: reopening or editing never removes or rewrites
// events, and nothing but an accepted mutation ever adds one. A legacy issue
// that is already done therefore keeps unknown completion timing forever —
// no event is ever inferred or backfilled for it.
// Events record the priority of the resulting issue at completion time:
// new events are immutable {at, priority} snapshots. Events written before
// snapshots existed are plain timestamp strings and stay strings forever —
// their completion-time priority is unknown, never guessed or converted,
// because rewriting them would fabricate history. Copies handed out (list,
// create and update results) duplicate every event object so no caller can
// mutate a stored snapshot through a reference.
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_DATA_DIR = '.data';
const STORE_FILENAME = 'issues.json';
const ISSUE_FIELDS = ['completions', 'createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt']; // exact, sorted
const LEGACY_PRIORITY_FIELDS = ['createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt']; // pre-completions shape, exact, sorted
const LEGACY_ISSUE_FIELDS = ['createdAt', 'description', 'id', 'status', 'title', 'updatedAt']; // pre-priority shape, exact, sorted
const ISSUE_STATUSES = new Set(['open', 'in_progress', 'done']);
const ISSUE_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

// Every event handed past this module is a fresh copy: strings are immutable
// already, snapshot objects are duplicated so callers cannot reach into the
// stored (or to-be-persisted) history through a reference.
function copyCompletions(events) {
  return events.map((event) => (typeof event === 'string' ? event : { at: event.at, priority: event.priority }));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A completion event is either a pre-snapshot timestamp string (its
// completion-time priority is unknown) or an exact {at, priority} snapshot.
// Anything else is corruption.
function isValidCompletionEvent(event) {
  if (typeof event === 'string') return isValidIsoUtc(event);
  if (!isPlainObject(event)) return false;
  const keys = Object.keys(event).sort();
  if (keys.length !== 2 || keys[0] !== 'at' || keys[1] !== 'priority') return false;
  return typeof event.at === 'string' && isValidIsoUtc(event.at) && ISSUE_PRIORITIES.has(event.priority);
}

// UTC instant with a Z suffix; fractional seconds are optional. Date.parse
// normalizes impossible instants (e.g. Feb 30 rolls into March) instead of
// rejecting them, so validity is checked by rebuilding the UTC calendar
// components and comparing them. setUTCFullYear is used because Date.UTC maps
// two-digit years into 1900-1999.
function isValidIsoUtc(value) {
  const match = ISO_UTC_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day &&
    utc.getUTCHours() === hour &&
    utc.getUTCMinutes() === minute &&
    utc.getUTCSeconds() === second
  );
}

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
    this.code = 'STORE_ERROR';
  }
}

// The writer side of the record contract enforced by #parseStore: whatever
// this class persists must reload cleanly, so both mutation entry points
// validate exactly what the loader will later refuse. The API layer already
// validates; these guards keep a direct caller from bricking the store.
function writeGuard(detail) {
  return new StoreError(`Cannot write the issue store: ${detail}`);
}

function guardTitle(title) {
  if (typeof title !== 'string' || title !== title.trim() || title.trim().length < 1 || title.length > TITLE_MAX) {
    throw writeGuard(`title must be a trimmed string of 1-${TITLE_MAX} characters.`);
  }
}

function guardDescription(description) {
  if (typeof description !== 'string' || description.length > DESCRIPTION_MAX) {
    throw writeGuard(`description must be a string of at most ${DESCRIPTION_MAX} characters.`);
  }
}

function guardStatus(status) {
  if (typeof status !== 'string' || !ISSUE_STATUSES.has(status)) {
    throw writeGuard('status must be one of: open, in_progress, done.');
  }
}

function guardPriority(priority) {
  if (typeof priority !== 'string' || !ISSUE_PRIORITIES.has(priority)) {
    throw writeGuard('priority must be one of: low, normal, high, urgent.');
  }
}

export class IssueStore {
  constructor(dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR) {
    this.dataDir = resolve(dataDir);
    this.storePath = join(this.dataDir, STORE_FILENAME);
    this.issues = []; // last published (durable) snapshot, in creation order
    this.loaded = false;
    this.loadPromise = null; // shared so concurrent first touches load exactly once
    this.writeQueue = Promise.resolve();
    this.tmpCounter = 0;
  }

  async list({ status, priority, query } = {}) {
    await this.#ensureLoaded();
    let items = this.issues.slice().reverse(); // newest first: array is kept in creation order
    if (status) items = items.filter((issue) => issue.status === status);
    if (priority) items = items.filter((issue) => issue.priority === priority);
    if (query) {
      const needle = query.toLowerCase();
      items = items.filter(
        (issue) =>
          issue.title.toLowerCase().includes(needle) ||
          (issue.description && issue.description.toLowerCase().includes(needle)),
      );
    }
    return items.map((issue) => ({ ...issue, completions: copyCompletions(issue.completions) }));
  }

  async create({ title, description = '', status = 'open', priority = 'normal' }) {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      guardTitle(title);
      guardDescription(description);
      guardStatus(status);
      guardPriority(priority);
      const now = new Date().toISOString();
      // Arriving directly in 'done' is itself an accepted completion; every
      // other start records nothing until a real transition happens. The
      // event snapshots the resulting priority at completion time.
      const issue = {
        id: randomUUID(),
        title,
        description,
        status,
        priority,
        createdAt: now,
        updatedAt: now,
        completions: status === 'done' ? [{ at: now, priority }] : [],
      };
      const candidate = [...this.issues, issue];
      await this.#persist(candidate);
      this.issues = candidate;
      return { ...issue, completions: copyCompletions(issue.completions) };
    });
  }

  async update(id, patch) {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      const keys = Object.keys(patch);
      // id/createdAt/updatedAt/completions are server-owned; patching them or
      // writing non-contract values would produce a record the loader refuses
      // — and would let a client forge or erase completion history.
      if (keys.length === 0 || keys.some((key) => key !== 'title' && key !== 'description' && key !== 'status' && key !== 'priority')) {
        throw writeGuard('only title, description, status and priority are patchable.');
      }
      if ('title' in patch) guardTitle(patch.title);
      if ('description' in patch) guardDescription(patch.description);
      if ('status' in patch) guardStatus(patch.status);
      if ('priority' in patch) guardPriority(patch.priority);
      const index = this.issues.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const now = new Date().toISOString();
      const previous = this.issues[index];
      const updated = { ...previous, ...patch, updatedAt: now };
      // One event per accepted arrival in 'done': a transition from another
      // status appends the same server-clock instant as the mutation,
      // snapshotting the resulting priority — so a simultaneous
      // status+priority change is captured atomically. Staying done (or
      // editing other fields) appends nothing, and leaving 'done' keeps
      // every past event untouched.
      if (patch.status === 'done' && previous.status !== 'done') {
        updated.completions = [...previous.completions, { at: now, priority: updated.priority }];
      }
      const candidate = this.issues.slice();
      candidate[index] = updated;
      await this.#persist(candidate);
      this.issues = candidate;
      return { ...updated, completions: copyCompletions(updated.completions) };
    });
  }

  // All first touches (reads and queued writes) share one load so a late-finishing
  // loader can never overwrite state published by an already-committed write.
  #ensureLoaded() {
    if (this.loaded) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = this.#load()
        .then(() => {
          this.loaded = true;
        })
        .catch((err) => {
          this.loadPromise = null; // allow a retry after e.g. a manual fix
          throw err;
        });
    }
    return this.loadPromise;
  }

  async #load() {
    await mkdir(this.dataDir, { recursive: true });
    let raw;
    try {
      raw = await readFile(this.storePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.issues = [];
        return;
      }
      throw new StoreError(`Cannot read issue store ${this.storePath}: ${err.message}`);
    }
    this.issues = this.#parseStore(raw);
  }

  // A store file is only trusted when every record matches the data contract
  // or one of the two exact legacy shapes (pre-completions with priority, or
  // pre-priority); anything else is corruption: it is reported and the file is
  // kept as-is, so neither reads nor later successful writes can launder it.
  // Timestamps are not compared against each other: the writer does not
  // guarantee a monotonic clock, and a system clock rollback must not
  // invalidate real data.
  #parseStore(raw) {
    const refuse = (detail) =>
      new StoreError(
        `Corrupt issue store ${this.storePath}: ${detail} Fix or remove the file manually; the server will not overwrite it.`,
      );
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw refuse(`not valid JSON (${err.message}).`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw refuse('expected an object like {"issues": [...]}');
    }
    if (Object.keys(parsed).join(',') !== 'issues' || !Array.isArray(parsed.issues)) {
      throw refuse('expected exactly one top-level field "issues" holding an array');
    }
    const seenIds = new Set();
    const issues = [];
    for (const [index, issue] of parsed.issues.entries()) {
      if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) {
        throw refuse(`item ${index} is not an issue object.`);
      }
      const keys = Object.keys(issue).sort();
      const keyList = keys.join(',');
      // The only tolerated deviations from the full contract are the exact
      // older shapes: records written before the priority field existed and
      // before completion history existed.
      const legacyPriority = keyList === LEGACY_PRIORITY_FIELDS.join(',');
      const legacySix = keyList === LEGACY_ISSUE_FIELDS.join(',');
      const legacy = legacyPriority || legacySix;
      if (!legacy && keyList !== ISSUE_FIELDS.join(',')) {
        throw refuse(
          `item ${index} must have exactly the fields ${ISSUE_FIELDS.join(', ')}, the legacy fields ${LEGACY_PRIORITY_FIELDS.join(', ')} or the legacy fields ${LEGACY_ISSUE_FIELDS.join(', ')} (found: ${keys.join(', ') || 'none'}).`,
        );
      }
      for (const [key, value] of Object.entries(issue)) {
        if (key === 'completions') {
          if (!Array.isArray(value) || value.some((event) => !isValidCompletionEvent(event))) {
            throw refuse(`item ${index} completions must be a list of ISO UTC timestamps or {at, priority} snapshots.`);
          }
        } else if (typeof value !== 'string') {
          throw refuse(`item ${index} has a non-string field.`);
        }
      }
      if (!UUID_PATTERN.test(issue.id)) {
        throw refuse(`item ${index} id is not a UUID.`);
      }
      const idKey = issue.id.toLowerCase();
      if (seenIds.has(idKey)) {
        throw refuse(`item ${index} repeats the id of an earlier item.`);
      }
      seenIds.add(idKey);
      if (issue.title.trim().length < 1 || issue.title.length > TITLE_MAX || issue.title !== issue.title.trim()) {
        throw refuse(`item ${index} title must be trimmed and 1-${TITLE_MAX} characters.`);
      }
      if (issue.description.length > DESCRIPTION_MAX) {
        throw refuse(`item ${index} description exceeds ${DESCRIPTION_MAX} characters.`);
      }
      if (!ISSUE_STATUSES.has(issue.status)) {
        throw refuse(`item ${index} status "${issue.status}" is not one of: open, in_progress, done.`);
      }
      if (!legacySix && !ISSUE_PRIORITIES.has(issue.priority)) {
        throw refuse(`item ${index} priority "${issue.priority}" is not one of: low, normal, high, urgent.`);
      }
      if (!isValidIsoUtc(issue.createdAt) || !isValidIsoUtc(issue.updatedAt)) {
        throw refuse(`item ${index} createdAt/updatedAt must be valid ISO UTC timestamps.`);
      }
      // Legacy records are upgraded in memory only: reads never touch the
      // file, and the next successful mutation persists the whole snapshot,
      // upgrading every legacy record in one atomic write. A legacy record
      // with no events gains an empty list — for an issue already done that
      // empty list is exactly the honest statement "completion time unknown";
      // no event is invented for it here or anywhere else. Recorded string
      // events are preserved exactly as stored: converting them to snapshots
      // would fabricate a completion-time priority that was never observed.
      issues.push({
        ...issue,
        ...(legacySix ? { priority: 'normal' } : {}),
        ...(legacy ? { completions: [] } : { completions: copyCompletions(issue.completions) }),
      });
    }
    return issues;
  }

  #enqueue(operation) {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #persist(snapshot) {
    const tmpPath = join(this.dataDir, `${STORE_FILENAME}.tmp-${process.pid}-${++this.tmpCounter}`);
    const payload = JSON.stringify({ issues: snapshot }, null, 2) + '\n';
    try {
      const handle = await open(tmpPath, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, this.storePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw new StoreError(`Cannot persist issue store ${this.storePath}: ${err.message}`);
    }
    // Past this point the rename has landed, so the mutation is committed on
    // disk and must not be reported as failed. The directory fsync is an
    // additional best-effort durability measure where the platform supports
    // it — not a power-loss guarantee. Platforms that refuse it only lose
    // this extra measure, which is logged, never fatal.
    try {
      const dirHandle = await open(this.dataDir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (err) {
      console.error(`[issue-store] directory fsync after rename failed for ${this.storePath}: ${err.message}`);
    }
  }
}
