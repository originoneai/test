# Issue tracker walkthrough

Everything a new contributor needs to go from a clean checkout to everyday
use, including backup, reset and recovery. What is verified how, plainly:

- **Automated UI behavior** runs against a fake DOM (`test/ui.test.js`),
  including some cases that drive the real server through the board's own
  HTTP adapter.
- **Process behavior and persistence** are tested over HTTP: the journeys and
  data lifecycle in this document are mirrored step by step by
  `test/integration.test.js`, alongside the API and storage suites.
- **The actual browser walkthrough is separate**: it has been exercised so far
  only with Agent-operated Chrome (the UI round's automated browser run); no
  independent human browser verification is claimed in this repository.

## 1. Clean setup

Requires Node.js 20 or newer. No third-party dependencies, no build step.

```sh
git clone https://github.com/originoneai/test.git
cd test
npm test
```

`npm test` runs five suites: API, storage, scaffold, UI, integration. A clean
checkout must pass all of them before you change anything.

## 2. Start the tracker

```sh
npm start
# Issue tracker: http://127.0.0.1:3000
```

Open http://127.0.0.1:3000. The server always binds to 127.0.0.1 (not exposed
to the network). Two environment variables matter:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | TCP port to listen on |
| `DATA_DIR` | `.data/` | Directory holding the durable store file `issues.json` |

Sanity check in a second terminal:

```sh
curl -sS http://127.0.0.1:3000/healthz
# {"ok":true,...}
curl -sS http://127.0.0.1:3000/api/issues
# {"items":[]}
```

A fresh `DATA_DIR` is created automatically on first use; an empty list is the
correct starting state. A relative `DATA_DIR` resolves from the directory
where you start the server: the examples in this document assume the default
`.data` at the repository root, so substitute your own path when you set a
custom one.

## 3. Everyday use (board)

1. **Create**: type a title (required, trimmed, ≤120 chars) and an optional
   description (≤4000 chars) in the "New issue" panel and press
   **Create issue**. The card appears in the Open column only after the
   server confirms the save.
2. **Edit**: press **Edit** on a card, change title/description/status, save.
   The dialog sends only the fields you changed.
3. **Move**: change the status select on a card (Open / In progress / Done).
   The card moves after the server confirms.
4. **Search/filter**: use the search box (title+description, case-insensitive)
   and the status filter; empty columns explain why they are empty.
5. **Refresh**: the Refresh button reloads the board; after someone else
   changes an issue this is how you pull their update in.

Four behaviors worth knowing before they surprise you:

- A new issue is created as **Open**: with the status filter set to In
  progress/Done, or with a search that does not match, the new card is
  invisible until you clear the filters.
- The board does **not auto-poll**: it fetches on load, after your own
  changes, and when you press **Refresh** — that is the only way a
  teammate's change reaches your screen.
- There is **no delete** for an individual issue; finished issues stay on
  the board (section 6's reset is the deliberate exception).
- Changing the status select on a card **saves immediately**; if that save
  fails the card snaps back and the board says what happened.

The same actions over HTTP look like this (full contract in
[api.md](api.md)). Put the id from the create response into a shell variable
and quote it in later commands — unquoted angle-bracket placeholders are
shell redirections and will not do what you want:

```sh
# create (title is stored trimmed)
curl -sS -X POST http://127.0.0.1:3000/api/issues \
  -H 'content-type: application/json' \
  -d '{"title":"  Fix login flow  ","description":"Session expires too early."}'
# → 201 with the created issue; copy the "id" value from the response, then:
ID="the-id-you-copied"

# edit a subset of fields (only what you send changes)
curl -sS -X PATCH "http://127.0.0.1:3000/api/issues/$ID" \
  -H 'content-type: application/json' \
  -d '{"status":"done"}'
# → 200 with the updated issue

# filter (quote the URL: it contains & and ?)
curl -sS 'http://127.0.0.1:3000/api/issues?status=done&q=login'
# → {"items":[...]} newest first
```

If a request fails mid-save, the board keeps your text and tells you what it
could and could not confirm; it never re-sends a change on its own. How to
retry safely (refresh-and-compare) is specified in [api.md](api.md).

## 4. Restart: data survives

Stop the server with Ctrl-C (or kill it outright — same result) and start it
again:

```sh
npm start
```

Every issue that was confirmed saved is still on the board, in the same
order. Accepted writes reach the disk file before the server answers, so a
crash cannot lose a confirmed change. (Power-loss durability depends on your
filesystem honoring fsync semantics and is not claimed as tested.)

## 5. Backup

All state is one file: `$DATA_DIR/issues.json` (pretty-printed JSON, creation
order). **Stop the server first** (Ctrl-C), then copy it — this is the only
moment when the file is guaranteed not to change under you:

```sh
mkdir -p .local/issue-backups \
  && BACKUP="$(mktemp .local/issue-backups/issues-XXXXXX)" \
  && cp .data/issues.json "$BACKUP" \
  && echo "backup written: $BACKUP"   # note this path; restore uses it
```

`mktemp` creates a unique destination, so a new backup can never collide with
or overwrite an earlier one — that is why the template ends in `X`s. Backups
and reset archives live under `.local/issue-backups/`, which normal Git
staging ignores (the whole `.local/` tree is in `.gitignore`). If you must
copy while the server runs, the atomic write means you always get either the
previous or the new complete snapshot, never a torn file — but the copy may
be one accepted write behind. With a custom `DATA_DIR`, substitute your own
data path; keep backups under the ignored `.local/` tree either way.

## 6. Reset to empty

```sh
# stop the server (Ctrl-C), then archive the data directory under a unique,
# ignored destination; the fresh start runs only after the move succeeded:
mkdir -p .local/issue-backups \
  && ARCHIVE="$(mktemp -d .local/issue-backups/data-old-XXXXXX)" \
  && mv .data "$ARCHIVE/data" \
  && echo "data archived at: $ARCHIVE/data" \
  && npm start
# → {"items":[]}: a fresh tracker; .data/ is recreated on first write
```

Deleting `.data/` outright also works; the archive keeps a recoverable copy
under the ignored backup tree.

## 7. Recovery: corrupt or damaged store

If `issues.json` is not exactly the expected shape (truncated, hand-edited
wrong, half-written by another tool), the server refuses to run on it:

```sh
npm start
curl -sS http://127.0.0.1:3000/api/issues
# → 500 {"error":{"code":"STORAGE_ERROR","message":"Issue storage is unavailable; the store file was not modified."}}
```

The HTTP error body is intentionally generic; the corruption detail (file
path and the first problem found) is printed to the server log on stderr.
**The server never rewrites the file it refuses.** To recover, stop the
server (Ctrl-C), pick a known-good copy and restore it — use the actual file
name you see, quoted:

```sh
ls .local/issue-backups
cp ".local/issue-backups/issues-a1B2c3" .data/issues.json   # the path echoed at backup time (or picked from ls)
npm start
```

Or, if you would rather start empty, use the reset procedure in section 6.

## Where to go next

- Full HTTP contract, validation rules and failure/retry semantics:
  [api.md](api.md).
- How to contribute (humans and agents), review gates and evidence rules:
  [CONTRIBUTING.md](../CONTRIBUTING.md).
- The HTTP journey and data lifecycle of this document, as executable
  regression: `node --test test/integration.test.js`. Automated UI behavior
  lives in `test/ui.test.js` (fake DOM, some real-server adapter cases); the
  browser walkthrough itself is a separate, human-facing activity.
