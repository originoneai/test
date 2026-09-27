# Issue tracker walkthrough

Everything a new contributor needs to go from a clean checkout to everyday
use, including backup, reset and recovery. Verification limits:

- **Server behavior** (API contract, persistence, restart, data lifecycle)
  is covered by automated HTTP tests; the documented backup, restore and
  reset shell blocks are additionally executed verbatim by a targeted
  regression in `test/integration.test.js`.
- **Board behavior** is covered by automated fake-DOM tests, some driving
  the real server through the board's own HTTP adapter.
- **Browser and terminal checks** are separate from both: board interactions
  (create, edit, search, filter) were exercised in real browser sessions,
  while the lifecycle steps (stop, restart, backup, reset, restore) were
  terminal commands with the page observed before and after. All were
  Agent-operated and do not establish independent-human acceptance.

## 1. Clean setup

Requires Node.js 20 or newer. No third-party dependencies, no build step.

```sh
git clone https://github.com/originoneai/test.git
cd test
npm test
```

`npm test` runs five suites: API, storage, scaffold, UI, integration. A clean
checkout must pass all of them before you change anything.

**Shell and tooling requirements.** Running the application needs only
Node.js 20 or newer — no npm dependencies (that statement is about npm
packages, not about your operating system's tools). The **full `npm test`
suite**, however, invokes a POSIX `sh` unconditionally, with no automatic
fallback or skip: running it requires a POSIX shell and the utilities
`cp`, `mv`, `mktemp`, `rm`, `rmdir`, `wc`, `ls` and `mkdir` (`mktemp` is a
common utility, not a POSIX standard one). The walkthrough's command
examples additionally use `curl`. Native Windows (CMD/PowerShell) and Git
Bash have not been verified for either the shell snippets or the full test
suite.

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
  the board says why. If the outcome is instead unknown, the board asks the
  server what it currently has and shows those observed values — which may
  match the status you picked, or not; the board reports what is, without
  claiming which write produced it.

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

A successful copy and a non-empty file do not validate JSON or storage
schema. Restore only a backup known to have served valid data. The
`replaced-*` files preserve the previous state for investigation; they may
be corrupt or empty and are not known-good restore sources.

## 6. Reset to empty

```sh
# stop the server (Ctrl-C), then run:
(
  if [ ! -d .data ]; then
    echo "Nothing to reset: .data does not exist (already fresh)."
  else
    ARCHIVE=""
    if mkdir -p .local/issue-backups \
       && ARCHIVE="$(mktemp -d .local/issue-backups/data-old-XXXXXX)" \
       && mv .data "$ARCHIVE/data"; then
      echo "data archived at: $ARCHIVE/data"
    else
      [ -n "$ARCHIVE" ] && rmdir "$ARCHIVE" 2>/dev/null
      echo "Reset failed: .data was left in place — nothing was archived." >&2
      exit 1
    fi
  fi
  npm start
)
```

After the start, from the **second** terminal (leave `npm start` running in
the first):

```sh
curl -sS http://127.0.0.1:3000/api/issues
# {"items":[]}
```

A fresh tracker: `.data/` itself is created when the server first reads it;
`issues.json` appears only after the first accepted write. An absent `.data`
is handled explicitly by the block above (nothing to reset, fresh start
anyway), and a failed move leaves `.data` exactly where it was, removes the
empty archive directory it had created (`rmdir` only touches an empty dir)
and exits nonzero. Deleting `.data/` outright also works; the archive keeps
a recoverable copy under the ignored backup tree.

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
  if [ ! -f .data/issues.json ]; then
    echo "No existing store to archive."
  else
    REPLACED=""
    if mkdir -p .local/issue-backups \
       && REPLACED="$(mktemp .local/issue-backups/replaced-XXXXXX)" \
       && cp .data/issues.json "$REPLACED"; then
      echo "Replaced-store archive: $REPLACED ($(wc -c < "$REPLACED") bytes)"
    else
      [ -n "$REPLACED" ] && rm -f "$REPLACED"
      echo "Archiving the current store failed; refusing to replace it." >&2
      exit 1
    fi
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

The block runs in a subshell so every failure path (missing/empty source,
failed archival, failed copy/move) returns a **nonzero shell status** without
closing an interactive shell. Before the store is replaced, its current bytes
are preserved in a unique `replaced-*` archive — the exact bytes being
replaced, whatever they are (a normal store, a corrupt one, or even an empty
file), so you can always see and recover what was there — and if that
archival cannot be completed, the restore **fails closed**: nothing is
replaced, nothing is started. `REPLACED` and `RESTORE_TMP` each start empty,
so cleanup can only remove the temp file its own attempt created. A reset
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
  semantic regression (`node --test test/integration.test.js`); the
  documented backup, restore and reset shell blocks themselves are executed
  verbatim by targeted tests, with `npm start` stubbed so no real server is
  launched by those snippets. Automated UI behavior lives in
  `test/ui.test.js` (fake DOM, some real-server adapter cases); the browser
  walkthrough itself is a separate
  activity, Agent-operated so far and not independent human verification.
