# Issue tracker contract · v1

Build a local issue tracker for a small software team. A user can create issues, edit them, move them between states, and filter the board. The result must survive a server restart. No account system or external service is required; bind to localhost by default.

## Data and API

An issue has `id` (server-generated UUID), `title` (trimmed 1–120 characters), `description` (0–4000 characters), `status` (`open`, `in_progress`, `done`), and ISO UTC `createdAt` / `updatedAt`. A new issue defaults to `open` and an empty description. Validate every supplied field; reject unknown fields and invalid status. Error bodies are `{ "error": { "code": "...", "message": "..." } }` without stack traces.

- `GET /api/issues`: `{ "items": [...] }`, newest first; optional `status` and case-insensitive `q` filtering title/description; reject invalid status with 400.
- `POST /api/issues`: accept title and optional description, return the new issue with 201.
- `PATCH /api/issues/:id`: accept nonempty subset of title, description and status; return updated issue with 200. Missing issue: 404; invalid JSON/fields: 400; unsupported method: 405.
- Request JSON is capped at 16 KiB (413 above limit).
- Store under `DATA_DIR` (default `.data/`). Persist mutations atomically and serialize concurrent writes. Restart must preserve all accepted changes; a corrupt store must fail visibly without silently overwriting it.
- `GET /healthz` remains available.

## Interface

Use a blue and white responsive board with Open / In progress / Done columns, a new-issue form, edit dialog, status selection, text search and status filter. Provide labels, keyboard access, empty states, loading indication and recoverable API errors. Render issue text as text, never executable HTML. Support 390 px mobile and 1440 px desktop. Do not claim a save succeeded before the API confirms it. Preserve a failed form so the user can retry.

## Work and review boundaries

API and UI may start independently against this contract. UI fixtures must stay explicitly separate from live data and must not remain as a fallback after integration. Integration waits for both predecessor completion receipts. A green health test proves only the scaffold, not the issue tracker.

For every task: submit a PR, bind evidence to its exact source SHA and checks, save an AWR checkpoint, and request review by another person. A second Agent using the author's identity is not independent review. Record unverified outcomes honestly. Do not change the product contract merely to make a test pass.
