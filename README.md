# Team issue tracker

A small, dependency-free issue tracker for one team: a durable JSON-backed API, an accessible browser board, and a walkthrough a brand-new contributor can follow from a clean checkout. The repository is also a live trial of AWR team collaboration — the work is planned, claimed, executed and reviewed through the shared AWR project rather than a local task list.

## What you get

- **Board** (`public/`): create issues, edit title/description, move Open → In progress → Done, search and filter — keyboard accessible at desktop and mobile widths, issue text rendered as text.
- **API** (`src/`): `GET/POST /api/issues`, `PATCH /api/issues/:id`, `GET /healthz`; validated input, atomic durable storage, serialized writes, visible failure on a corrupt store. Full contract: [docs/api.md](docs/api.md).
- **Persistence**: accepted changes survive restarts and process crashes; a corrupt store file is reported, never silently rewritten. Backup, reset and recovery steps: [docs/walkthrough.md](docs/walkthrough.md).
- **No fixtures**: the board talks to the real API only; there is no demo data and no offline fallback.

## Quickstart (from zero)

Requires Node.js 20 or newer; no third-party dependencies.

```sh
git clone https://github.com/originoneai/test.git
cd test
npm test     # five suites: API, storage, scaffold, UI, integration
npm start    # serves http://127.0.0.1:3000
```

Open http://127.0.0.1:3000 and follow [the walkthrough](docs/walkthrough.md) — clean setup, everyday use, restart, backup and reset are all covered step by step. Useful environment variables: `PORT` (default `3000`) and `DATA_DIR` (default `.data/`; the server binds to 127.0.0.1 only).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | HTTP server, issue API, durable JSON store |
| `public/` | Board UI (vanilla JS, no build step) |
| `docs/` | [API contract](docs/api.md), [contributor guide](CONTRIBUTING.md), [walkthrough](docs/walkthrough.md) |
| `test/` | `api`, `storage`, `scaffold`, `ui`, `integration` suites — all run by `npm test` |
| `specs/` | Original product contract and task plan (see below) |

## Development model: agents claim work through AWR

This repository is developed AWR-first. Work items, ownership, execution
admission, evidence and review rounds live in the shared AWR project; GitHub
PRs carry the code. Humans can contribute directly (fork → branch → PR), and
agents join through the same MCP endpoint:

1. Get your personal developer or reviewer credential from the project owner. Keep it outside this repository; use a separate credential for each person.
2. Fork this repository and clone your fork for development.
3. Connect your Agent directly to the shared MCP endpoint:
   `https://beta.awr.originoneai.com/v1/projects/test/mcp`.

Use any Agent client that supports remote MCP over **Streamable HTTP** with **Bearer authentication**. Add a remote server through that client's settings:

| Setting | Value |
| --- | --- |
| Transport | Streamable HTTP |
| Server URL | `https://beta.awr.originoneai.com/v1/projects/test/mcp` |
| Authentication | Bearer token in the HTTP `Authorization` header |
| Credential | Your personal credential from the project owner |

Configure the credential from its private file or through the client's supported secret settings, then reconnect and open your local checkout. These settings are client-neutral; use your client's documented configuration format. A client with only local stdio MCP needs a compatible remote-MCP integration before it can use this endpoint. AWR does not require a particular Agent or model.

4. Ask your Agent to start the work, for example:

> Use the connected AWR Team test project to implement the next eligible task. Refresh the current tasks, check existing sessions and ownership, and resume my work or claim the matching eligible task. Read its current contract, dependencies and checkpoint. Obtain execution admission before editing, keep progress and version-bound evidence in AWR, then submit a tested PR and request independent review.

The Agent performs the refresh → preparation → claim → development → checkpoint → review loop through MCP. Web sign-in, browser task selection and browser claims are not required. If a request outcome is unknown, the Agent must inspect the original request before retrying; reconnecting does not renew a lease.

5. Optionally open [Inspector](https://beta.awr.originoneai.com/?lang=en#team) to view the same project's task relationships, ownership and progress. Its connection instructions and task briefs are optional conveniences; copying text does not claim work.

Public repository access and AWR permissions are separate. Submit feature branches as PRs to this repository; AWR developer credentials do not grant direct GitHub push access. Keep tokens, runtime databases, private ledgers and execution receipts out of commits and PR bodies. The remote AWR project is the shared task authority; do not replace it with a second local task ledger. Contribution rules for both humans and agents: [CONTRIBUTING.md](CONTRIBUTING.md).

## Contracts and honest status

- [specs/issue-tracker.md](specs/issue-tracker.md) is the original product contract the components were built against; [specs/tasks.yaml](specs/tasks.yaml) records the **published initial plan** (its `planned` statuses describe that plan, not current progress). Live task state, claims and evidence are only in AWR.
- **The original human gate stands.** Work on this repository's tasks requires
  independent review by a **different real person** using their own identity;
  an Agent may prepare and submit work, but that review is not satisfied by a
  second Agent or by the same person. The scoped simulated Agent trial
  described below does not satisfy or change this gate.
- The current API, UI and integration state was produced inside a separate,
  scoped simulated-role trial: Agent developers (Zcode: API and storage; Grok
  Bot: board UI) with Codex acting as a distinct Agent reviewer, all operated
  by one human controller. Within that trial every review was **Agent review,
  not independent-human acceptance**, and nothing here is recorded as
  independent-human verification. Verification boundary, in short: automated
  HTTP and fake-DOM tests cover the declared server and board behaviors, and
  a separate Agent-operated Chrome walkthrough covered create, edit and
  filter in the browser, with stop/restart/backup/reset/restore driven from
  the terminal and the page observed around each step. Independent human
  acceptance is not claimed.
- Known boundaries, stated plainly: durability claims cover process crashes and
  restarts (tested); power-loss durability is platform-dependent and not
  established by these tests. Concurrent edits to the same field resolve
  last-writer-wins; there is no versioning — see [docs/api.md](docs/api.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
