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

## Join the team trial through your Agent

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

> Use the connected AWR Team test project to implement the issue API. Refresh the current tasks, check existing sessions and ownership, and resume my work or claim the matching eligible task. Read its current contract, dependencies and checkpoint. Obtain execution admission before editing, keep progress and version-bound evidence in AWR, then submit a tested PR and request independent review.

The Agent performs the refresh → preparation → claim → development → checkpoint → review loop through MCP. Web sign-in, browser task selection and browser claims are not required. If a request outcome is unknown, the Agent must inspect the original request before retrying; reconnecting does not renew a lease. An independent reviewer uses their own identity and reviews another person's actual work.

5. Optionally open [Inspector](https://beta.awr.originoneai.com/?lang=en#team) to view the same project's task relationships, ownership and progress. Its connection instructions and task briefs are optional conveniences; copying text does not claim work.

Public repository access and AWR permissions are separate. Submit feature branches as PRs to this repository; AWR developer credentials do not grant direct GitHub push access. Keep tokens, runtime databases, private ledgers and execution receipts out of commits and PR bodies. The remote AWR project is the shared task authority; do not replace it with a second local task ledger.

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
