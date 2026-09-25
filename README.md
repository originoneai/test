# Team issue tracker

A real development project for trying AWR team collaboration: two contributors build an issue tracker in parallel, integrate their work, request independent review, and deliver a verified application.

**Current code is a runnable scaffold, not a finished issue tracker.** The API explicitly returns `501` until implemented. The public specification defines the work; live claims, progress and evidence live in the authorized AWR Team project.

## Quickstart

Requires Node.js 20 or newer; no third-party dependencies.

```sh
git clone https://github.com/originoneai/test.git
cd test
npm test
npm start
```

Open http://127.0.0.1:3000. Start from [the product contract](specs/issue-tracker.md) and [task definitions](specs/tasks.yaml).

## Join the team trial

1. Get a personal developer or reviewer credential from the project owner. Use one credential per person; keep it outside this repository.
2. Open https://beta.awr.originoneai.com/ and **Join project**. Select `test`.
3. Choose a task, read its acceptance criteria, then **Claim task**. Claims coordinate work; they do not launch an Agent.
4. Open **Connect Agent** and configure the central MCP endpoint:
   `https://beta.awr.originoneai.com/v1/projects/test/mcp`.
5. In the terminal that launches Codex, load your private credential file and register MCP:

```sh
export AWR_TEAM_BEARER="$(cat /path/to/your-private-credential.token)"
codex mcp add awr_team --url https://beta.awr.originoneai.com/v1/projects/test/mcp --bearer-token-env-var AWR_TEAM_BEARER
```

Restart your Agent and paste the task's **Copy task handoff** text. Use the same credential in the web page and Agent. Continue the existing durable session, inspect the current claim, consume the published contract and follow fresh execution admission before editing. Reconnecting or closing the browser does not renew a lease.

Public repository access and AWR permissions are separate. External contributors should Fork, create a feature branch, and submit a PR to this repository. AWR developer credentials do not grant direct GitHub push access. Keep tokens, runtime databases, private ledgers and execution receipts out of commits and PR bodies.

## Development tasks

| Task | Deliverable | Required predecessors |
| --- | --- | --- |
| TEST-API | Validated issue API and durable JSON storage | None |
| TEST-UI | Accessible board and create/edit forms using fixtures | None |
| TEST-INTEGRATE | Connect the board to the API with visible loading and error states | TEST-API, TEST-UI |
| TEST-QA | End-to-end regression coverage and defect fixes | TEST-INTEGRATE |
| TEST-GUIDE | Contributor guide, usage walkthrough and reproducible demo | TEST-INTEGRATE |

Task contracts are versioned in `specs/tasks.yaml`; source `planned` values describe the published initial plan, not current progress. Query AWR for live state. Each task requires independently reviewed, version-bound evidence before final completion. `TEST-API` and `TEST-UI` are suitable for parallel contributors. Cross-workstream dependency exports are not available in the current remote Beta, so these tasks deliberately share a workstream.

## License

Apache License 2.0. See [LICENSE](LICENSE).
