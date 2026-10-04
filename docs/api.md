# Issue tracker API · server contract for the board

This document is the interface agreement between the server (`src/`) and the
board UI (`public/`). It describes every endpoint, the validation rules, the
exact failure semantics a client must handle, and how data is stored. The
product contract lives in `specs/issue-tracker.md`; this file adds the
operational detail an integrating client needs.

- Base URL: `http://127.0.0.1:3000` (override with `PORT`; bind address is always localhost).
- Start: `npm start` (or `node src/server.js`). Health: `GET /healthz` → `200 {"ok":true,...}`.
- Data location: `DATA_DIR` (default `.data/`), one JSON file `issues.json`.
- All API responses are JSON with `cache-control: no-store`. Never cache a list:
  the server may have newer data from another tab or teammate.

## Issue resource

```json
{
  "id": "0f1e2d3c-4b5a-6978-8a97-6d5e4f3a2b1c",
  "title": "Fix login flow",
  "description": "Session expires too early.",
  "status": "open",
  "priority": "normal",
  "createdAt": "2026-09-27T00:00:00.000Z",
  "updatedAt": "2026-09-27T00:00:00.000Z"
}
```

| Field | Rules |
| --- | --- |
| `id` | Server-generated UUID. Immutable. |
| `title` | Required string, stored **trimmed**, 1–120 characters after trimming. |
| `description` | Optional string, default `""`, at most 4000 characters. |
| `status` | `open` \| `in_progress` \| `done` (case sensitive). New issues start `open`; status is not accepted on create. |
| `priority` | `low` \| `normal` \| `high` \| `urgent` (case sensitive). New issues default `normal`. Records written before the priority field existed (exactly the legacy six-field shape) read as `normal` and are upgraded on disk only by the next successful write, never by a read. |
| `createdAt` / `updatedAt` | ISO UTC (`Z`) instants taken from the server's wall clock. `createdAt` never changes. `updatedAt` is regenerated at each accepted update: usually later, but **not guaranteed to advance** — same-millisecond updates can tie and a clock rollback can set it earlier. Do not use it for ordering or conflict detection. |

Exactly these seven fields are ever returned; unknown fields in input are
rejected, so a client can detect its own typos. The server additionally keeps
an internal append-only `completions` history per issue (see storage below);
it is not part of the issue resource and reaches clients only through the
weekly report.

## Endpoints

### `GET /api/issues`

Query parameters (all optional, combinable):

- `status` — one of `open`, `in_progress`, `done`; anything else is `400`.
- `priority` — one of `low`, `normal`, `high`, `urgent`; anything else is `400`.
- `q` — case-insensitive substring match on title and description.

Response `200`: `{"items":[...]}`, **newest first** (reverse creation order).
Empty result sets are normal: `{"items":[]}` means "no issues match".

### `POST /api/issues`

Body: `{"title": "...", "description": "...", "priority": "..."}` (`description`
and `priority` optional; `priority` defaults to `normal`).
Response `201` with the created issue (title echoed trimmed).

### `PATCH /api/issues/:id`

Body: a **non-empty subset** of `title`, `description`, `status`, `priority`. Only the
fields you send change; omitted fields keep their values, so send just what the
user edited (this is how concurrent edits to different fields merge).
Response `200` with the updated issue, or `404` if the id is unknown.

### `GET /api/reports/weekly`

Weekly summary behind the board's Weekly overview section: the week's intake
(`created`) and the week's throughput (`completed`) as **two independent
statistics — they are never merged into one number**. It is a pure read over
the same committed data: it never mutates the store, and it is independent of
any `GET /api/issues` filter the client may hold.

Query parameters — at most one, `weekStart`:

- Omitted → the current UTC week (the Monday 00:00 UTC of "now").
- `YYYY-MM-DD` — a **real calendar date** that is a **UTC Monday**, selecting
  `[00:00 UTC, seven days later)`. Selectable whole weeks run from `0000-01-03`
  to `9999-12-20`; a Monday whose exclusive end would fall in year 10000
  (e.g. `9999-12-27`) is rejected.
- Unknown parameter names, repeats, impossible dates (`2026-02-30`),
  non-ISO forms (`2026-9-28`) and non-Mondays → `400 VALIDATION_ERROR`.

Response `200` (empty example; all enum keys are always present, zeros
included):

```json
{
  "schemaVersion": 3,
  "weekStart": "2026-09-28",
  "weekEndExclusive": "2026-10-05",
  "created": {
    "total": 0,
    "byStatus": { "open": 0, "in_progress": 0, "done": 0 },
    "byPriority": { "low": 0, "normal": 0, "high": 0, "urgent": 0 }
  },
  "completed": {
    "total": 0,
    "byPriority": { "low": 0, "normal": 0, "high": 0, "urgent": 0 },
    "priorityUnknown": 0,
    "createdThisWeek": 0,
    "createdEarlier": 0,
    "repeatCompletions": 0
  },
  "completedTimingUnknown": 0
}
```

Semantics a client must rely on:

- `created` is the intake statistic and keeps its original meaning exactly:
  it counts the issues whose immutable `createdAt` falls inside
  `[weekStart, weekEndExclusive)`, tallying them with the status and priority
  **stored right now**. `weekEndExclusive` itself is outside.
- `completed` is the throughput statistic, derived from the server-recorded
  append-only completion history (see storage below):
  - `total` counts each issue **once** in every week that contains at least
    one of its completion events — including issues created in earlier weeks,
    and **regardless of the issue's current status**: reopening an issue never
    removes the credit for the week it was really completed in.
  - `byPriority` buckets those same issues by the priority **recorded on
    their earliest completion event inside the selected week** (equal-time
    ties broken by the order the events were appended). That snapshot is
    frozen at completion time: later priority edits and same-week
    re-completions can never rewrite the distribution a week already
    recorded; a later week is bucketed by its own first event.
  - `priorityUnknown` counts the issues whose first in-week event predates
    snapshots (a stored timestamp string): they count once toward `total`,
    but their completion-time priority is unknown — never guessed from the
    current priority, never backfilled. The four buckets plus
    `priorityUnknown` always sum to `completed.total`.
  - `createdThisWeek` / `createdEarlier` partition those distinct issues by
    their known `createdAt` (inside the selected week or not).
  - `repeatCompletions` counts the extra same-week events of issues already
    counted once (complete → reopen → complete again within one week adds 1);
    it is never folded into `total`.
- `completedTimingUnknown` counts issues that are currently `done` but have
  **no recorded completion event** — issues that were already done before
  completion history existed. Their timing is genuinely unknown: it is never
  inferred or backfilled from `createdAt` or `updatedAt`, they belong to no
  week, and the count is independent of the selected week. Priority unknown
  (an event exists but its snapshot does not) is a separate concept from
  timing unknown (no event at all).
- `updatedAt` is not used anywhere in the report.
- On an unavailable or corrupt store the report answers `500 STORAGE_ERROR`
  like every other endpoint and leaves the file untouched; recovery is manual
  as described below.

### `POST /api/imports` — commit a historical CSV import

Imports a whole CSV file of historical issues as **one atomic batch**
(specs/historical-issue-import.md). Body (JSON, capped at 1 MiB):

```json
{ "importKey": "<UUID chosen by the client for this import>", "csv": "<the file text>" }
```

Any other body field is refused (`400 VALIDATION_ERROR`). The server parses
and validates the CSV itself with the same module the page previews with
(`public/csv-import.js`); nothing the browser computed is trusted.

**CSV format.** UTF-8 (an optional BOM is ignored); RFC 4180 quoting — quoted
fields may contain commas, line breaks (stored as `\n`) and `""` for a literal
quote. The first row is a header naming a subset of exactly `title`,
`description`, `status`, `priority` in any order (case-insensitive); `title`
is required. Any other column — credentials, `id`, timestamps,
`completions` or anything unknown — rejects the whole file: ids, timestamps
and completion history are always server-owned. Per row: `title` is trimmed
and must be 1–120 characters; `description` (default empty) at most 4000;
`status` one of `open`, `in_progress`, `done` (empty → `open`); `priority` one
of `low`, `normal`, `high`, `urgent` (empty → `normal`). Each row must have as
many fields as the header. **Limits:** at most 262144 bytes of CSV text and
500 data rows; a larger file is refused, never truncated. A header-only or
empty file is refused.

**Responses.**

- `201` — committed. Every row became an issue with a server-assigned id and
  one shared server timestamp; a row arriving as `done` gets the same
  `{at, priority}` completion snapshot as a create in `done`, so it counts in
  the weekly report for that day.
  ```json
  { "import": { "importKey": "…", "status": "committed", "createdAt": "…Z",
                "issueCount": 6, "issueIds": ["…", "…"] }, "replayed": false }
  ```
- `200` with `"replayed": true` — this `importKey` was already committed for
  the same normalized rows (re-sent after a lost acknowledgement, even if the
  file was re-saved with other line endings or a BOM). The stored outcome is
  returned unchanged; **nothing is created again.**
- `400 IMPORT_INVALID` — the file or at least one row is invalid. **Nothing
  is written**, not even the valid rows. `error.details` lists every problem:
  `{"fileErrors": ["…"], "rowErrors": [{"line": 9, "errors": ["title is required."]}]}`
  where `line` is the physical line in the file where that record starts.
- `409 IMPORT_CONFLICT` — the `importKey` was already used for different rows.
  Nothing is written; start a new import with a new key.
- `413 PAYLOAD_TOO_LARGE` — body over 1 MiB.
- `500 STORAGE_ERROR` — persistence failed; issues **and** import records are
  unchanged and the same request may be retried with the same key.

**Retry rule for clients.** Choose one `importKey` per confirmed file and
reuse it for every retry of that confirmation. A retry after a timeout or
network loss is always safe: it either commits once or returns the stored
result. Choosing the same file again later is a new import with a new key.

### `GET /api/imports/:importKey` — import result lookup

Returns the committed result for that key with `200` in the same shape as the
commit response (`"replayed": false`), so a client whose commit outcome was
unknown can find out whether it landed. `404 IMPORT_NOT_FOUND` means no record
is stored under the key at that moment; it is not proof that nothing was ever
saved, because a commit of that key may still be in flight and not visible
yet. Re-checking later is always safe, and retrying the commit with the same
key and identical rows commits at most once: it returns the stored result if
the import already landed, or commits it once if no result exists yet. A key
that is not a UUID → `400 VALIDATION_ERROR`. Results are durable across
restarts.

### Everything else

- Unsupported methods on known paths → `405` with an `Allow` header.
- Unknown `/api/...` paths → `404`.
- Request bodies are capped at 16 KiB (declared or streamed) → `413` above,
  except `POST /api/imports`, which is capped at 1 MiB.

## Error model

Every error body is `{"error":{"code":"...","message":"..."}}` — a stable
machine-readable `code` plus a human-readable `message`, never a stack trace.
`IMPORT_INVALID` additionally carries `error.details` (see `POST /api/imports`).

| Status | Code | Meaning for the client |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Definite rejection (bad field, unknown field, empty patch). The input must change; retrying unchanged will fail again. |
| 400 | `INVALID_JSON` | Body was not readable/parseable JSON. A retry with a re-serialized body may work. |
| 400 | `INVALID_URL` | Malformed request URL. |
| 400 | `IMPORT_INVALID` | The CSV import was refused as a whole; `details` lists file and row problems. Nothing was written. |
| 404 | `IMPORT_NOT_FOUND` | No committed import has this key. |
| 409 | `IMPORT_CONFLICT` | The import key was already used for different rows. Nothing was written. |
| 404 | `NOT_FOUND` | Unknown resource or issue id. Refresh the list before acting on it. |
| 405 | `METHOD_NOT_ALLOWED` | Wrong verb; `Allow` lists what the path supports. |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 16 KiB. Split or shorten the text. |
| 500 | `STORAGE_ERROR` | The store is unavailable or corrupt. The mutation was **not applied**. |
| 500 | `INTERNAL_ERROR` | Unexpected server bug. Outcome of a mutation is unknown. |

## Failure and retry semantics (what the board must assume)

**A 2xx means the change reached the disk file.** Mutations commit in two
phases: the server first writes the new snapshot to disk (temp file, fsync,
atomic rename, plus a best-effort fsync of the directory entry where the
platform allows it) and only then publishes it to memory and answers. What the
tests establish: killing the server process and reloading serves every
accepted change, and a failed write never leaves partial or smuggled data.
Power-loss durability is **not established by these tests**: it depends on the
filesystem and platform honoring fsync/rename semantics, and where the
directory fsync is refused the server logs that and still answers `200` —
treat power-loss durability as platform-dependent and unverified.
Reads never observe uncommitted data.

**A `500 STORAGE_ERROR` is a clean no-op — at that moment.** The write failed
before anything changed: disk and memory still hold the previous committed
state, no partial or smuggled data, and the user's input is still valid, so
retrying is reasonable. But the retry is itself a fresh save under
last-writer-wins: if a teammate wrote the same field between the failed
request and the retry, the retry overwrites their newer edit. For edits where
that matters, apply the same refresh-and-compare step below before re-sending.

**A network failure or timeout has an unknown outcome, and stays unresolved.**
The request may or may not have been applied before the connection broke.
This API has no versioning, ETag, request receipt or compare-and-swap, so no
client-side check can reconstruct what happened: a later `GET` shows the
current state, not the causality behind it — another writer may have applied,
reverted or re-raced the field between the failed request and the check, and
can write again right after it. Two consequences:

- Never retry a mutation blindly, and never present any recovery branch as an
  automatically safe re-send. Re-sending is a fresh, explicit save under
  last-writer-wins.
- Even when the server shows exactly the submitted values, that is a matching
  current state, not proof of which write produced it.

Recover by refresh-and-compare with the decision left to the user:

1. Keep the user's draft exactly as typed; do not close the form or dialog.
2. Re-fetch (`GET /api/issues`), locate the issue and show what the server
   currently shows next to the draft.
3. Let the user choose explicitly:
   - Server values match the draft → nothing further needs sending; keep or
     discard the draft as the user prefers.
   - Server values differ from both the draft and the pre-save baseline → a
     teammate's edit is visible; the user sends the draft again (a fresh save
     that overwrites by last-writer-wins) or adopts the server's values and
     drops the draft.
   - Server values equal the pre-save baseline → still unresolved (the save
     may have landed and been overwritten back, or never landed); the user
     decides to save again or drop the draft.
4. `POST` after an unknown outcome: check `GET /api/issues?q=<title words>`
   for an already-existing matching issue and let the user decide whether to
   create again; a blind re-post can duplicate.

The board's edit dialog carries a "Check again" recovery path, and this is
what it must do after an unconfirmed save: keep the draft open, re-query the
server, show the observed values next to the draft, and leave the
re-send / adopt / drop decision with the user. The shipped board implements
exactly this; the recovery behavior is covered by the fake-DOM suite and the
real-server UI tests. Independent human acceptance is not claimed here.

**Concurrent edits.** Writes are serialized in-process; there is no locking or
versioning. Patches to different fields merge cleanly (last value per field).
Two patches to the *same* field: the last committed one wins, and each `200`
reply tells that client what actually stuck at that moment — which is exactly
why the unknown-outcome recovery above must compare before deciding. The board
already re-reads the list after every mutation, which is the intended refresh
mechanism.

**Corrupt store fails visibly.** If `issues.json` is not exactly the expected
shape, every API call answers `500 STORAGE_ERROR` and the file is left
untouched — the server never rewrites a store it cannot trust. The HTTP error
body is intentionally generic; the corruption detail — the store path and the
first problem found — goes to the server logs (stderr), so check there when
diagnosing. Recovery is manual: stop the server, back up `DATA_DIR/issues.json`,
fix or remove it, restart.

## Storage format and durability

`DATA_DIR/issues.json` is plain JSON, pretty-printed with a trailing newline:

```json
{
  "issues": [ { ...issue objects in creation order... } ]
}
```

After the first committed CSV import the file also carries an `imports` list,
written atomically together with the imported issues (the key is absent
until then, so stores that never imported keep the exact format above):

```json
{
  "issues": [ … ],
  "imports": [ { "importKey": "<lowercase UUID>", "digest": "<sha256 of the normalized rows>",
                 "createdAt": "…Z", "issueIds": ["…"] } ]
}
```

On load each import record must have exactly these fields, a unique key,
and list only existing issue ids not claimed by another import; anything else
is reported as a corrupt store like any other corruption.

Each record carries exactly the seven public fields plus the server-owned
`completions` list: an append-only history of completion events, one appended
**atomically with the accepting mutation** whenever an issue arrives in
`done` — created directly as `done`, or accepted as a transition from another
status. A simultaneous status+priority change is captured in one event.
Staying `done`, or editing title/description without a transition, appends
nothing. Reopening (`done` → any other status) never removes or rewrites past
events; completing again appends a new event. Clients cannot supply, edit or
erase the list: `completions` is rejected as an unknown field on every input,
and it never appears in an issue response — it surfaces only through the
weekly report.

Events come in two encodings. Events recorded since completion-priority
snapshots exist are objects `{ "at": "<ISO UTC>", "priority":
"low|normal|high|urgent" }`: an immutable snapshot of the resulting issue
priority at the completion instant. Events recorded before that are plain
timestamp strings; a string and object event may sit in the same list.
Strings keep unknown completion-time priority **forever** — the server never
converts, infers or backfills them, because rewriting them would fabricate
history. All copies handed out (list results, create/update replies)
duplicate every snapshot object, so no caller can mutate stored history
through a reference.

The format is intentionally strict (exact fields, UUID ids, enum status, ISO
UTC timestamps, no extra keys): a hand-edited file is either fully valid or
the server refuses it as corrupt. Backups can be made by copying the file
while the server is stopped, or at any time — a snapshot mid-rename can never
be torn because of the atomic write.

**Compatible shapes and migration.** The loader accepts three exact record
shapes: the current eight-field form (with `completions`), the pre-completions
seven-field form (with `priority`), and the pre-priority six-field legacy
form. Records without a `completions` list read as *no recorded events* while
keeping every stored value untouched — for an issue that is already `done`
that is precisely the "completion time unknown" state the report exposes, and
no event is ever invented for it. Older records are upgraded on disk only by
the next successful write, which rewrites the whole snapshot atomically and
adds an explicit empty `completions` list to each of them; reads never modify
the file.

**Rollback limits.** The upgrade is one-way on disk: a server from before
completion history existed refuses a store containing `completions` fields as
corrupt (its loader knows only the older shapes), and a server from before
completion-priority snapshots refuses snapshot objects (it accepts only
timestamp strings). Rolling the software back therefore requires restoring a
backup taken before the upgrade — the preferred path. Manually stripping
snapshot objects down to their timestamps is possible but lossy: it discards
exactly the completion-time priorities this version records, reverts those
issues to `priorityUnknown` in the report, and must never be claimed to
preserve V3 priority history. The events themselves are real server-clock
instants; nothing is reconstructed after the fact.

## Integration notes for the board

`public/app.js` ships `createHttpAdapter()` and the board uses it
exclusively — there is no fixture mode and no offline fallback:

- `list({status, q})`, `create({title, description})`, `update(id, patch)`
  map 1:1 to the endpoints above and verify every reply against the issue
  contract (an unconfirmable save is surfaced as `outcomeUnknown`).
- The adapter relies on: trimmed-title echo on create/update, newest-first
  lists, stable `error.code` values, and `no-store` caching. This document is
  the agreement for all four; changes go through a recorded AWR contract note
  before either side ships them.
- After an unconfirmed save the board keeps the user's draft, re-queries the
  server and leaves the re-send / adopt / drop decision with the user, as the
  failure semantics above require. It never re-sends a change on its own.
  This flow is implemented in the shipped board and covered by its fake-DOM
  suite and real-server UI tests; independent human acceptance is not
  claimed here.
- A human-facing tour of these flows (including restart, backup and reset)
  lives in [walkthrough.md](walkthrough.md).

## Verification

- `npm test` — full suite (API, storage, scaffold, UI, integration).
- `test/api.test.js` — the HTTP contract, including an integration regression
  that boots the real server and drives it through `createHttpAdapter` from
  `public/app.js`, with a restart proving durability, and the dropped-reply +
  concurrent-edit interleaving that mandates refresh-and-compare recovery.
- `test/weekly-report-api.test.js` — the weekly report contract: current-week
  default, `[weekStart, weekEndExclusive)` boundaries with current
  status/priority tallying, legacy records, validation and 405 handling,
  low-year and upper-boundary week formatting, corrupt-store refusal without
  rewrite, and read-only behavior next to the issue APIs. The V2 additions
  cover distinct-versus-repeat completion counts, reopened tasks, the
  created/completed partitions, the current-priority basis, unknown legacy
  timing and completion-event boundaries.
- `test/completion-history.test.js` — the completion history itself:
  creation directly as done, transitions into and out of done, repeated
  completion, unchanged-done edits, client-forged history, process reload,
  corrupt data, failed writes and the legacy upgrade path.
- `test/storage.test.js` — the store directly: on-disk format, reload,
  corruption refusal, write guards with boundary acceptance, serialization,
  failed-write recovery.
- `test/integration.test.js` — the documented HTTP journey and data
  lifecycle as executable regression: a real server process started from a
  clean data directory (health, create/edit/filter, restart persistence),
  then backup, corrupt-store refusal without rewrite, restore, and reset to
  empty.
