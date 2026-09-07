# Agent Note: Task-service multi-turn conversations and per-conversation working-directory isolation

Status: implemented

English | [中文](2026-09-07-task-service-multi-turn-and-isolation.zh.md)

## Problem

The task-service HTTP surface (`POST /tasks`) conflated task, session, and turn: every submission minted `session-<uuid>` as both the task id and the session id, created a fresh Agent, and queued one prompt — so a client could not keep a conversation going across turns, nor survive a Host restart, despite the durable session log. Every task also set `meta: { cwd: process.cwd() }`, so all conversations shared one working directory. The original [remote task-service note](../../implemented/feature/2026-09-01-remote-task-service.md) committed to both claims: "taskId IS the branded SessionId" and "one task is one Agent session driven by a single prompt."

## Decision

Split the conflation. A **Task** stays one submission (one turn, id `task-<uuid>`); a **Session** is the long-lived conversation named by an optional `sessionId` on `POST /tasks` (minted `session-<uuid>` when absent). Continuation is idempotent create-or-resume: a second task with the same `sessionId` adopts the live idle agent, cold-resumes a persisted session, or creates a fresh ordinary session — so a conversation survives a Host restart through the durable log. Each conversation gets a service-minted `<workspaceRoot>/<sessionId>` working directory (`workspaceRoot` is a new validated `Config` field, default `process.cwd()`), and a second task against a conversation whose turn is still running answers `409 session/agent-busy`.

Four sub-decisions carry the design:

- **Slim inline create-or-resume, not a reused controller.** The resume path is hand-rolled in roughly forty lines inside `dsh-task-service` using only public APIs (`ctx.agents.get` / `create` / `resume`, `ctx.sessionQuery.observeSession`). It does not reuse `ApiSessionAgentController.createOrAdopt`: that class is not a public export of `@deepseek-ai/dsh-api-session-controller`, so reusing it would need a public-API expansion or a source-plane import — both bigger blasts than the slim inline path. The task-service's resume need is genuinely slimmer than the controller's (no preset, no projection, no Typert, no subagent-ownership fence), so the parallel logic is not a pure duplicate.

- **`sessionTask` index for the running turn.** A `Map<sessionId, TaskRecord>` tracks the in-flight turn, serving two consumers the split otherwise breaks: the finish-detection handler (now keyed by `session.id` via `sessionTask`, not by taskId) and the 409-busy guard. On `turn/end` the record is finished and the `sessionTask` entry is deleted, freeing the session for the next task; the live idle agent stays in `ctx.agents` for adoption and result queries. Finished records stay in `this.tasks` for `/tasks/{taskId}` queries.

- **cwd conflict is a 409, not a silent rebind.** Cold-resume verifies `observation.header.cwd === sessionCwd(sessionId)`; a persisted session whose recorded cwd no longer matches the service-minted one (a `workspaceRoot` change, or a foreign `sessionId` collision) answers `409 session/cwd-conflict` with the `sessionId`. The subagent-ownership fence the session-controller carries is unnecessary here: the task-service owns its session namespace and creates sessions with ordinary origin, so a cold-read session carrying subagent origin is a foreign-id collision caught by the same cwd check.

- **The cold-read and cold-resume paths both read `sessionPersistence` directly, not the SQLite query index.** `SessionObservationReader.read` falls back to `ctx.get('sessionPersistence')` for a cold session, and `AgentLoop.resume` opens the session through `sessionPersistence` exclusively. So the production composition (`session-query-sqlite` at `path: ':memory:'`, `openAt: never`) supports cold resume — the empty SQLite index is irrelevant to both paths. This was verified by tracing the resume load path and by the two-context cold-resume test.

The `firstSeq` per-task turn bound, the result-text derivation, `streamEvents` backfill, `cancel`, and webhook delivery all key on `taskId` / `record.agent.session` and are unchanged — each task's turn is bounded by its own `firstSeq`, so multi-turn needs no change to result derivation.

## Alternatives considered

**Reuse `ApiSessionAgentController.createOrAdopt`.** Rejected: the class is internal to `@deepseek-ai/dsh-api-session-controller` (no public export); importing it would expand the public API or force a source-plane import, both larger than the slim inline path. The task-service's resume need lacks the controller's preset, projection, Typert, and subagent-ownership concerns, so the parallel logic is not a duplicate worth a shared seam today.

**Promote Task to a long-lived conversation with `POST /tasks/{id}/messages`.** Rejected: it bends the "service adds no new session state" invariant and forces per-turn sub-identity; keeping Task = one turn leaves result / SSE / webhook / cancel semantics unchanged per task.

**Cold-resume-only (404 on first message).** Rejected: idempotent adopt-or-create gives a friendlier contract (first message creates, later ones resume) at the same composition cost.

**Client-supplied `cwd` / `workspaceId`.** Rejected: hands the client filesystem-path authority and lets two conversations target the same directory.

**Queue a second turn against a running session.** Rejected: it breaks the per-task `firstSeq` / result derivation and introduces a queue concept that does not exist at this surface.

## Consequences

- **Composition:** `dsh-task-service` gains `sessionQuery` as a required injection (`static inject` adds `'sessionQuery'`); `workspaceRoot` is a new `Config` field. The `service-app` profile needs no change — it composes `dsh-base`, which mounts `sessionQuery` and `session-persistence-jsonl`, and `workspaceRoot` defaults to `process.cwd()`.
- **Partial supersession:** the [original task-service note](../../implemented/feature/2026-09-01-remote-task-service.md)'s "taskId IS the branded SessionId" and "one task is one Agent session driven by a single prompt" decisions no longer hold; this note splits them. The original note's profile, SSE, webhook, and unattended-safety decisions stand.
- **Future extraction trigger:** a third consumer of the create-or-resume pattern (today: `ApiSessionAgentController` and this inline path) should extract a `dsh-session-resume` package owning the slim adopt / cold-read / resume seam. Two consumers do not yet justify the package boundary.
- **Coverage:** REAL-composition tests add multi-turn (live-agent adoption retains history), cold-resume across two Host contexts (the persisted second turn's LLM request carries the first turn's marker), cwd isolation (distinct `<workspaceRoot>/<sessionId>` dirs), 409 busy, and 409 cwd-conflict. The sandbox-isolation consequence in `docs/adr/0001-task-service-multi-turn-and-isolation.md` is verified: `workspace-write` follows the per-call session cwd, so `<workspaceRoot>/<sessionId>` subdirs are sandbox-bounded automatically — no sandbox change was needed.
