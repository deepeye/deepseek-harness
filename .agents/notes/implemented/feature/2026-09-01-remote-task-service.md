# Agent Note: Remote task service (service profile)

Status: implemented

English | [中文](2026-09-01-remote-task-service.zh.md)

## Problem

Driving the harness from another machine required choosing between two existing seams that both fit awkwardly: the SDK family speaks newline-delimited JSON-RPC over stdio, which assumes the client spawned the runtime as a same-machine subprocess, and the web BFF assumes a browser client with the launch-token trust fence. A local web or desktop client that wants to submit one agent task and collect the result had no network-facing seam, and "harness as a remote agent service" had no supported profile.

## Decision

A new profile (`dsh --profile service`) composes `dsh-base` with a new `service-app` bundle, which mounts the existing webserver and a new `task-service` package (`packages/api/task-service`). The HTTP surface is task-shaped, not session-shaped: one task is one Agent session driven by a single prompt, mirroring the headless runner's in-process drive pattern (`agents.create` → `followup` → finish detection from the log).

Four choices carry the design:

- **taskId IS the branded SessionId.** Wire ids and the durable log stay one identity; the session log is the only authority, and results are re-derived from it on demand instead of accumulated into a parallel state machine.
- **SSE frames are verbatim session events** (backfill from `firstSeq`, sequence-deduped, `turn/end` terminates). Projection stays pure: the stream is a view of the log, so no new event type and no `SessionEventMap` change — which is also why no recorded-session snapshot is required.
- **Completion is a per-task webhook plus the queryable result**, not a push-only stream: callers without a persistent connection still get outcomes, with bounded retries that never alter the task's result.
- **Unattended safety is composed, not coded:** the bundle patch replaces the base approval row with the fail-closed `never` policy and pins a `service` permission preset (workspace-write + reject). Because a patch replaces a row's whole config, the permission row restates every base preset; the composed-default check in permission-presets enforces the pairing, which is exactly the loud failure we want for a mismatched stance.

Bearer auth is one required `token` config field validated at load (empty fails loud) and compared constant-time; the trust boundary is documented as single-user, so no multi-tenant machinery is speculative.

## Alternatives considered

**Wrap the SDK stdio server in a network bridge.** Rejected: it would layer a second protocol translation between the client and the agent, while the in-process drive needs no protocol at all. The SDK remains the right seam for process-local drivers.

**Reuse the web BFF session-controller endpoints.** Rejected: they are session/conversation-shaped and entangled with the browser trust fence (process token, Host/Origin check); adapting them to unattended task semantics would grow the web surface instead of a task surface.

**Task queue with durable state.** Deferred: the registry is in memory and restart drops finished results (session logs persist on disk). Nothing in the current consumer needs cross-restart tasks; the limitation is recorded in the READMEs.

## Consequences

New packages `packages/api/task-service` and `packages/bundle/service-app`; `PROFILE_TEMPLATES` gains `service`; apps/cli declares the bundle dependency so the launcher resolves it. `SessionEventMap`, the agent-loop, and the snapshot tree are untouched. REAL-composition coverage boots the real Loader composition against the mock LLM provider and asserts auth rejection, the submit/result loop, SSE frame order, webhook delivery, and cancellation.
