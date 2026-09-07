# Multi-turn conversations and per-conversation isolation on the task-service HTTP surface

English | [中文](0001-task-service-multi-turn-and-isolation.zh.md)

The task-service (`POST /tasks`) is single-turn by design — the README commits to "Every task is one Agent session driven by a single prompt" — and shares one `cwd`, one bearer token, and one Host process across all conversations. We decided to add multi-turn dialogue and working-directory isolation by splitting the task = session = turn conflation: a Task stays one submission (one turn); a Session is the long-lived conversation named by an optional `sessionId` on `POST /tasks`; continuation uses idempotent create-or-resume (a slim inline path in `dsh-task-service`, not a reuse of `ApiSessionAgentController.createOrAdopt` which is not a public export) so a conversation survives Host restart via the durable session log. Each conversation gets a service-minted `<workspaceRoot>/<sessionId>` working directory (a new validated `Config` field), and a second task targeting a conversation whose turn is still running returns `409 session/agent-busy`. Caller/tenant auth and per-conversation process sandboxing stay out of scope.

## Considered Options

- **Identity model:** rejected "promote Task to a long-lived conversation with a `POST /tasks/{id}/messages` route" — it bends the "service adds no new session state" invariant and forces per-turn sub-identity; keeping Task = one turn leaves result / SSE / webhook / cancel semantics unchanged per task.
- **Resume:** rejected "live-agent only" — it orphans every conversation on Host restart despite the durable log; rejected strict "cold-resume, 404 on first message" — idempotent adopt gives a friendlier contract (first message creates, later ones resume) at the same composition cost.
- **Working directory:** rejected "client-supplied `cwd`/`workspaceId`" — hands the client filesystem-path authority and lets two conversations target the same dir; rejected "per-conversation git worktree" — too heavy and git-coupled for an unattended service.
- **Same-conversation concurrency:** rejected "queue the second turn" — it breaks the per-task `firstSeq`/result derivation and introduces a queue concept that does not exist at this surface today.

## Consequences

- **Composition change:** the `service-app` profile does not compose the session-controller today; closing the gap required `dsh-task-service` to inject `ctx.sessionQuery` (cold read) and hand-roll the create-or-resume path inline. The slim path lives in the task-service rather than in `service-app` because the resume need is slimmer than the controller's (no preset, projection, Typert, or subagent-ownership fence).
- **Isolation scope is explicit:** context + working-directory only. Caller/tenant authorization and per-conversation OS-process sandboxing are deliberately out of scope — adding either converts a "trusted single-user host" into a multi-tenant service, a different product surface.
- **Verified:** the `workspace-write` permission sandbox follows the per-call session `cwd` (`packages/fs/fs-sandbox/src/index.ts`), so `<workspaceRoot>/<sessionId>` subdirs are sandbox-bounded automatically — no sandbox change was needed.
- **Contradiction with prior code:** `taskId === sessionId` (`packages/api/task-service/src/index.ts`) and the task-service README's Summary committed to the three-way conflation. This decision splits them, and the README's Summary and Known Limitations were rewritten in the same PR.
