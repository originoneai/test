# Issue tracker walkthrough

Everything a new contributor needs to go from a clean checkout to everyday
use, including backup, reset and recovery. Verification limits:

- **Server behavior** (API contract, persistence, restart, data lifecycle)
  is covered by automated HTTP tests, including the documented backup and
  restore shell blocks, which `test/integration.test.js` executes verbatim.
- **Board behavior** is covered by automated fake-DOM tests, some driving
  the real server through the board's own HTTP adapter.
- **Browser checks** have exercised the board and the lifecycle steps for
  real, but they were Agent-operated and do not establish
  independent-human acceptance.

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

Sanity check in a **second** terminal — leave `npm start` running in the
first; the comment lines below show what that second terminal's `curl`
prints, not output of `npm start` itself:

```sh
curl -sS http://127.0.0.1:3000/healthz
# {"ok":true,...}
curl -sS http://127.0.0.1:3000/api/issues
# {"items":[]}
```

On a fresh checkout the data **directory** is created when the server first
reads it, while the `issues.json` **file** appears only after your first
accepted write — an empty list with no file on disk yet is the correct
starting state. A relative `DATA_DIR` resolves from the directory where you
start the server: the examples in this document assume the default `.data`
at the repository root, so substitute your own path when you set a custom
one.

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
- Changing the status select on a card **saves immediately**. If the server
  explicitly refuses the change, the card returns to its previous status and
  the board says why. If the outcome is instead unknown, the board looks the
  issue up and may end up showing the new status — correctly — because the
  server did apply it.

**When a save goes wrong, two different things can happen** — the board's
message tells you which:

- The server **refused the change** (a definite error answer: a validation
  problem, an unknown issue id, or storage being unavailable). Nothing was
  changed on the server. Your text stays in the form; fix what the message
  names and save again.
- The outcome is **unknown** (the connection dropped, or the answer could
  not be read). The server may or may not have applied the change. The board
  keeps your draft, asks the server what it currently has, and in the edit
  dialog offers up to three choices:
  - **Check again** — read the server once more without resending anything;
    your draft stays as it is.
  - **Save changes** — send the edited fields again as a fresh, explicit
    save, after comparing what the server showed.
  - **Use server values** — drop the draft and adopt the last checked
    server values.

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
if [ ! -s .data/issues.json ]; then
  echo "Nothing to back up: .data/issues.json is missing or empty (fresh or reset state)."
else
  (
    BACKUP=""
    if mkdir -p .local/issue-backups \
       && BACKUP="$(mktemp .local/issue-backups/issues-XXXXXX)" \
       && cp .data/issues.json "$BACKUP"; then
      echo "Backup written: $BACKUP ($(wc -c < "$BACKUP") bytes) — note this path for a restore."
    else
      [ -n "$BACKUP" ] && rm -f "$BACKUP"
      echo "Backup failed; no backup file was kept." >&2
      exit 1
    fi
  )
fi
```

Three properties of this block matter:

- **No data, no fake backup.** A fresh or just-reset installation has no
  `issues.json` yet, and a zero-byte one is never valid either; `-s` rejects
  both, the block says so plainly and creates nothing. A zero-byte `issues-*`
  file must never appear in the backup directory, because restoring one would
  produce a corrupt store.
- **A failed copy leaves nothing behind.** If `cp` fails for any reason, the
  `mktemp` placeholder created for this attempt is removed and the block
  exits nonzero. `BACKUP` starts empty inside a subshell, so cleanup can only
  ever touch this attempt's temp file, never an earlier real backup.
- **Successful backups are unique and verifiable.** `mktemp` (template
  ending in `X`s) guarantees a fresh name, and the echo reports the exact
  path and byte count — a real backup is never 0 bytes.

Backups and reset archives live under `.local/issue-backups/`, which normal
Git staging ignores (the whole `.local/` tree is in `.gitignore`). If you
must copy while the server runs, the atomic write means you always get either
the previous or the new complete snapshot, never a torn file — but the copy
may be one accepted write behind. With a custom `DATA_DIR`, substitute your
own data path; keep backups under the ignored `.local/` tree either way.

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
server (Ctrl-C) and restore a backup you saw succeed — verify the source is
non-empty, copy into a fresh temp file first and move it into place only
after the copy succeeded (so a failed copy cannot truncate your store), and
start the server only on success:

```sh
(
  ls -l .local/issue-backups     # choose a NON-EMPTY issues-* file (size > 0)
  SRC=".local/issue-backups/issues-a1B2c3"   # the path echoed when the backup was made
  if [ ! -s "$SRC" ]; then
    echo "Refusing: '$SRC' is empty or missing; pick a non-empty backup." >&2
    exit 1
  fi
  RESTORE_TMP=""
  if mkdir -p .data \
     && RESTORE_TMP="$(mktemp .data/restore-XXXXXX)" \
     && cp "$SRC" "$RESTORE_TMP" \
     && mv "$RESTORE_TMP" .data/issues.json; then
    echo "Restored from: $SRC"
    npm start                  # start only after a successful restore
  else
    [ -n "$RESTORE_TMP" ] && rm -f "$RESTORE_TMP"
    echo "Restore failed; the existing store was left untouched — do not start yet." >&2
    exit 1
  fi
)
```

The block runs in a subshell so a refusal or a failed copy/move returns a
**nonzero shell status** (scripts can rely on it) without closing an
interactive shell. `RESTORE_TMP` starts empty, so the cleanup branch can only
remove the temp file this attempt created — never a real file. A reset
archive from section 6 holds the whole data directory; restore from it the
same way with
`SRC=".local/issue-backups/data-old-XXXXXX/data/issues.json"`.

Or, if you would rather start empty, use the reset procedure in section 6.

## Where to go next

- Full HTTP contract, validation rules and failure/retry semantics:
  [api.md](api.md).
- How to contribute (humans and agents), review gates and evidence rules:
  [CONTRIBUTING.md](../CONTRIBUTING.md).
- The HTTP journey and data lifecycle of this document, as executable
  semantic regression (`node --test test/integration.test.js`; the backup and
  restore shell blocks themselves are executed verbatim by a targeted test).
  Automated UI behavior lives in `test/ui.test.js` (fake DOM, some
  real-server adapter cases); the browser walkthrough itself is a separate
  activity, Agent-operated so far and not independent human verification.
