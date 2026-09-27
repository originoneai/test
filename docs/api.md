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
| `createdAt` / `updatedAt` | ISO UTC (`Z`) instants taken from the server's wall clock. `createdAt` never changes. `updatedAt` is regenerated at each accepted update: usually later, but **not guaranteed to advance** — same-millisecond updates can tie and a clock rollback can set it earlier. Do not use it for ordering or conflict detection. |

Exactly these six fields are ever returned; unknown fields in input are
rejected, so a client can detect its own typos.

## Endpoints

### `GET /api/issues`

Query parameters (both optional, combinable):

- `status` — one of `open`, `in_progress`, `done`; anything else is `400`.
- `q` — case-insensitive substring match on title and description.

Response `200`: `{"items":[...]}`, **newest first** (reverse creation order).
Empty result sets are normal: `{"items":[]}` means "no issues match".

### `POST /api/issues`

Body: `{"title": "...", "description": "..."}` (`description` optional).
Response `201` with the created issue (title echoed trimmed).

### `PATCH /api/issues/:id`

Body: a **non-empty subset** of `title`, `description`, `status`. Only the
fields you send change; omitted fields keep their values, so send just what
the user edited (this is how concurrent edits to different fields merge).
Response `200` with the updated issue, or `404` if the id is unknown.

### Everything else

- Unsupported methods on known paths → `405` with an `Allow` header.
- Unknown `/api/...` paths → `404`.
- Request bodies are capped at 16 KiB (declared or streamed) → `413` above.

## Error model

Every error body is `{"error":{"code":"...","message":"..."}}` — a stable
machine-readable `code` plus a human-readable `message`, never a stack trace.

| Status | Code | Meaning for the client |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Definite rejection (bad field, unknown field, empty patch). The input must change; retrying unchanged will fail again. |
| 400 | `INVALID_JSON` | Body was not readable/parseable JSON. A retry with a re-serialized body may work. |
| 400 | `INVALID_URL` | Malformed request URL. |
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

The board's edit dialog already carries a "Check again" recovery path; this
document defines what the integrated UI must provide after an unconfirmed
save: keep the draft open, re-query the server, show the observed values next
to the draft, and leave the re-send / adopt / drop decision with the user.
Whether the current UI matches this exactly is for TEST-UI to implement and
verify against this contract — the server side does not assert it.

**Concurrent edits.** Writes are serialized in-process; there is no locking or
versioning. Patches to different fields merge cleanly (last value per field).
Two patches to the *same* field: the last committed one wins, and each `200`
reply tells that client what actually stuck at that moment — which is exactly
why the unknown-outcome recovery above must compare before deciding. The board
already re-reads the list after every mutation, which is the intended refresh
mechanism.

**Corrupt store fails visibly.** If `issues.json` is not exactly the expected
shape, every API call answers `500 STORAGE_ERROR` and the file is left
untouched — the server never rewrites a store it cannot trust. Recovery is
manual: stop the server, back up `DATA_DIR/issues.json`, fix or remove it,
restart. The error text names the file and the first problem found.

## Storage format and durability

`DATA_DIR/issues.json` is plain JSON, pretty-printed with a trailing newline:

```json
{
  "issues": [ { ...issue objects in creation order... } ]
}
```

The format is intentionally strict (exact fields, UUID ids, enum status, ISO
UTC timestamps, no extra keys): a hand-edited file is either fully valid or
the server refuses it as corrupt. Backups can be made by copying the file
while the server is stopped, or at any time — a snapshot mid-rename can never
be torn because of the atomic write.

## Integration notes for the board (TEST-UI)

`public/app.js` already ships `createHttpAdapter()` implementing this API:

- `list({status, q})`, `create({title, description})`, `update(id, patch)`
  map 1:1 to the endpoints above and verify every reply against the issue
  contract (an unconfirmable save is surfaced as `outcomeUnknown`).
- Switching `DATA_MODE` to `'api'` and removing the fixture section is the
  integration step owned by the UI developer; nothing on the server side
  needs to change for it.
- The adapter relies on: trimmed-title echo on create/update, newest-first
  lists, stable `error.code` values, and `no-store` caching. This document is
  the agreement for all four; changes go through a recorded AWR contract note
  before either side ships them.

## Verification

- `npm test` — full suite (API, storage, scaffold, UI).
- `test/api.test.js` includes an integration regression that boots the real
  server and drives it through `createHttpAdapter` from `public/app.js`,
  including a restart to prove durability.
- `test/storage.test.js` covers the store directly: on-disk format, reload,
  corruption refusal, write guards, serialization and failed-write recovery.
