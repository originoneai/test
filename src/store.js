// Durable JSON issue store for TEST-API (specs/issue-tracker.md).
// Single JSON file under DATA_DIR. Writes are atomic (temp file + fsync + rename)
// and serialized in-process. A mutation commits in two phases: it first persists
// a candidate snapshot, and only after that succeeds is the snapshot published
// to memory. Readers therefore never observe data that is not durable, and a
// failed write leaves both disk and memory at the previous committed state, so
// nothing uncommitted can ride along with a later successful write.
// A corrupt store file is reported, never rewritten.
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_DATA_DIR = '.data';
const STORE_FILENAME = 'issues.json';
const ISSUE_FIELDS = ['createdAt', 'description', 'id', 'status', 'title', 'updatedAt']; // exact, sorted
const ISSUE_STATUSES = new Set(['open', 'in_progress', 'done']);
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

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

  async list({ status, query } = {}) {
    await this.#ensureLoaded();
    let items = this.issues.slice().reverse(); // newest first: array is kept in creation order
    if (status) items = items.filter((issue) => issue.status === status);
    if (query) {
      const needle = query.toLowerCase();
      items = items.filter(
        (issue) =>
          issue.title.toLowerCase().includes(needle) ||
          (issue.description && issue.description.toLowerCase().includes(needle)),
      );
    }
    return items.map((issue) => ({ ...issue }));
  }

  async create({ title, description = '', status = 'open' }) {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      const now = new Date().toISOString();
      const issue = { id: randomUUID(), title, description, status, createdAt: now, updatedAt: now };
      const candidate = [...this.issues, issue];
      await this.#persist(candidate);
      this.issues = candidate;
      return { ...issue };
    });
  }

  async update(id, patch) {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      const index = this.issues.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const updated = { ...this.issues[index], ...patch, updatedAt: new Date().toISOString() };
      const candidate = this.issues.slice();
      candidate[index] = updated;
      await this.#persist(candidate);
      this.issues = candidate;
      return { ...updated };
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

  // A store file is only trusted when every record matches the data contract;
  // anything else is corruption: it is reported and the file is kept as-is, so
  // neither reads nor later successful writes can launder it. Timestamps are
  // not compared against each other: the writer does not guarantee a monotonic
  // clock, and a system clock rollback must not invalidate real data.
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
    for (const [index, issue] of parsed.issues.entries()) {
      if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) {
        throw refuse(`item ${index} is not an issue object.`);
      }
      const keys = Object.keys(issue).sort();
      if (keys.join(',') !== ISSUE_FIELDS.join(',')) {
        throw refuse(
          `item ${index} must have exactly the fields ${ISSUE_FIELDS.join(', ')} (found: ${keys.join(', ') || 'none'}).`,
        );
      }
      if (Object.values(issue).some((value) => typeof value !== 'string')) {
        throw refuse(`item ${index} has a non-string field.`);
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
      if (!isValidIsoUtc(issue.createdAt) || !isValidIsoUtc(issue.updatedAt)) {
        throw refuse(`item ${index} createdAt/updatedAt must be valid ISO UTC timestamps.`);
      }
    }
    return parsed.issues;
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
  }
}
