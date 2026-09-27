# Contributing

Two kinds of contributors work on this repository, and both are welcome:
**humans** (fork, branch, PR) and **agents** connected to the shared AWR
project through remote MCP. The rules below apply to both.

## The short version

1. Work is tracked in AWR, not in local to-do lists. Before changing files,
   know which task owns them and claim it (agents do this through MCP;
   humans check the task board in Inspector or with the maintainer).
2. Never commit credentials, tokens, runtime databases or raw execution
   records. `.gitignore` already excludes `.data/`, `.env*` and `*.token`;
   keep it that way, and keep private evidence in private paths.
3. Every change ships with a regression: if you fix behavior, add or extend a
   test that fails without the fix. All tests use isolated temporary data
   directories — never point a test at a real `DATA_DIR`.
4. Documentation must match reality. If you change observable behavior,
   update `docs/api.md` / `docs/walkthrough.md` / `README.md` in the same PR.
5. PRs describe product behavior, verification and limits in public terms —
   no internal ledgers, session identifiers or private run logs.

## Testing

```sh
npm test                            # everything (five suites)
node --test test/api.test.js        # HTTP contract
node --test test/storage.test.js    # durable store
node --test test/scaffold.test.js   # server scaffold
node --test test/ui.test.js         # board (fake DOM)
node --test test/integration.test.js  # walkthrough journey + data lifecycle
```

Node.js 20+ only, zero dependencies. CI runs the same command.

## For human contributors

Fork → branch (`yourname/short-topic`) → commit → open a PR against `main`.
The PR should state what changes for a user, how you verified it (commands,
results) and any limits. A maintainer who is **not you** reviews and merges.
For setup and a tour of the running product, start with
[docs/walkthrough.md](docs/walkthrough.md).

## For agents: the AWR loop

Connect to the project MCP endpoint (settings table in
[README.md](README.md)), then follow the claim loop — refresh → prepare →
session → claim → execution admission → work → report → evidence → PR →
review:

- **Refresh before acting**: `work.next`, then `work.prepare` for the task
  you intend to take. Consume the current contract, dependencies and
  checkpoints; do not rely on cached context.
- **One owner at a time**: acquire the claim before editing; if a lease
  expires or an outcome is unknown, stop effects, inspect the original
  request, and report truthfully — never fabricate progress or retry blindly.
- **Execution admission**: prepare and start an execution with a declared
  scope and input digest before changing files, and report the real outcome
  (succeeded / failed / cancelled) when done.
- **Evidence**: keep progress and version-bound evidence in AWR; artifacts
  should be mechanically verifiable bytes with digests, not prose claims.
- **Checkpoints**: save a checkpoint whenever you pause; a future session
  (yours or a successor's) resumes from it.
- **Stay in scope**: edit only the paths your task's contract declares. If a
  fix outside your scope is required, report it to the maintainer instead of
  reaching across; never edit another contributor's in-flight work or
  sessions.

## Review and acceptance boundaries

- **The default gate for this repository's tasks is independent human
  review**: a reviewer who is a different real person, with their own
  identity, reviews the actual work before it is accepted. An Agent may
  prepare and submit work, but this gate is not satisfied by a second Agent
  or by the same person wearing another hat.
- A scoped, clearly-labeled simulated Agent trial (Agent developers plus an
  Agent reviewer under one human controller) may be used for rehearsal; its
  reviews are **Agent reviews**, never independent-human acceptance, and it
  does not relax the gate above.
- Author your PR honestly: what was executed and verified, what was not, and
  who did what. "Not run" is a valid status; do not upgrade it silently.

## Project layout cheat sheet

| Path | Owned by |
| --- | --- |
| `src/`, `test/api.test.js`, `test/storage.test.js` | API & storage tasks |
| `public/`, `test/ui.test.js` | Board UI tasks |
| `test/integration.test.js`, `docs/`, `README.md`, `CONTRIBUTING.md` | Integration & guide tasks |

When a task's contract says otherwise, the contract wins — read it via AWR
before you start.
