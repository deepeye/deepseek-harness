---
description: "Remote task HTTP surface for dsh: submit an agent task, watch its progress over SSE, and collect the result, for local web and desktop clients driving a harness service."
kind: "package-reference"
---

# @deepseek-ai/dsh-task-service

English | [中文](README.zh.md)

## Summary

`dsh-task-service` turns a running harness into a task service: a local web or desktop client POSTs one task prompt, watches the agent work through server-sent events, and collects the final result — by query, by SSE stream, or by webhook callback. Every task is one Agent session driven by a single prompt, so the session log stays the durable record and the service adds no new session state. A single bearer token guards every route; the service is designed for a trusted single-user host, not a multi-tenant deployment.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The package composes as the [`@deepseek-ai/dsh-service-app`](../../bundle/service-app/README.md) bundle over `dsh-base`; run `dsh --profile service` with `DSH_SERVICE_TOKEN` set. The direct HTTP surface is what clients program against.

### Submit a task and collect the result

```sh
curl -X POST http://127.0.0.1:PORT/tasks \
  -H "Authorization: Bearer $DSH_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"task": "Summarize the repo README"}'
# 202 {"taskId": "session-…", "status": "queued"}
```

The service creates one Agent session, queues the prompt, and returns `202` immediately. `GET /tasks/{taskId}` reports `{"status": "running"}` while the turn is live and the final text plus the durable `turn/end` reason (`completed`, `error`, `max-tokens`, `aborted`, `blocked`) once it settles. Unknown ids answer `404`; cancelling is `POST /tasks/{taskId}/cancel`, which aborts the turn and lets the normal finish path record the `aborted` outcome (a finished task answers `409`).

### Watch progress over SSE

`GET /tasks/{taskId}/events` answers `text/event-stream`. Each SSE frame carries one session event verbatim as JSON, starting from the task's first event (the stream backfills the log before going live, and sequence numbers dedupe the join). The `turn/end` event is the last frame, and the server closes the stream after it. A client that disconnects simply drops its subscription.

### Completion webhook

Submit `"webhookUrl": "https://…" ` (or set the service-wide default) and the service POSTs one JSON body to that URL when the task finishes:

```json
{"taskId": "session-…", "status": "finished", "result": {"text": "…", "reason": {"kind": "completed"}}}
```

Delivery times out per attempt (default 10 s) and retries a bounded number of times (default 2); failures log a warning and never change the task's outcome.

### Authentication

Every route requires `Authorization: Bearer <token>`; the token is the required `token` config field (an empty value fails the profile load). Comparison is constant time. Requests without a valid token answer `401`.

| Field | Default | Meaning |
|---|---|---|
| `token` | required | Bearer token every request must present |
| `webhookUrl` | — | Default completion webhook for tasks without a per-task override |
| `webhookTimeoutMs` | `10000` | Per-attempt webhook delivery timeout |
| `webhookRetries` | `2` | Webhook redelivery attempts after the first failure |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-task-service) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One Service class registers a single `prefix` route `/tasks` on the [webserver](../../host/webserver/README.md) plus one global `session/event` subscription; both are effects of the service fiber, so disposal removes the routes and the subscription.

### Task lifecycle

`POST /tasks` reads a bounded (1 MiB) JSON body, creates a fresh Agent through [`ctx.agents`](../../core/agent/README.md) with the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection (the same driver pattern as [headless](../../bundle/headless/README.md)), records `firstSeq` at quiescence, and queues the prompt with `agent.followup`. The `taskId` is the branded session id, so wire ids and the durable log stay one identity. The finish subscription folds each task's `turn/end` into the final text (all `assistant/message` text blocks after `firstSeq` joined) and fires the webhook; the result is re-derived from the session log, never accumulated incrementally, so the log stays the only authority.

### SSE projection

`GET /tasks/{taskId}/events` subscribes to `session/event` for its session, backfills the log from `firstSeq`, then drains the subscription queue; `event.seq <= lastSent` dedupes the subscribe/snapshot join. The pump ends after the record's status is finished or the client disconnects (`req` close disposes the subscription and wakes the pump).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `taskService` Service: routes, task registry, SSE pump, webhook delivery |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: every registered task holds the agent registry's live agent |
| [`tests/task-service.spec.ts`](tests/task-service.spec.ts) | REAL-composition coverage through the vendored Loader with a mock provider |

### Invariant ownership

The companion checks the registry relation the service owns: on every observed `turn/end`, a task record must still hold the agent registry's live entry — a stale record would serve results from a disposed agent and accept cancellation for a dead driver.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-service-app](../../bundle/service-app/README.md) — the profile bundle that composes this service.
- [Webserver](../../host/webserver/README.md) — the HTTP route seam this service registers on.
- [dsh-headless](../../bundle/headless/README.md) — the one-shot sibling with the same agent-driving pattern.
- [SDK family](../..//sdk/README.md) — the stdio JSON-RPC alternative for in-process drivers.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service submits each task as an ordinary user message and the composed base rows own the prompts and tools.

#### KV Cache effect

The service adds nothing to the request prefix; each task is an ordinary fresh session driven through the composed tree.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you when the task service does not fit and what a deployment must accept.

- **Single-user bearer token** — one shared token guards the surface; there are no users, tenants, or per-caller authorization, so expose it only on a trusted host or behind your own gateway.
- **No task persistence across restart** — the registry is in memory; after a restart finished results are gone from the HTTP surface (the session logs remain on disk under the sessions root).
- **No cancellation of the queue, only the turn** — a submitted task that has not started still runs to its turn; there is no delete or task-list operation.
- **No concurrency limit** — every submission creates one Agent; a deployment must bound submissions itself.
- **SSE frames are full session events** — clients receive every event type including tool calls and their arguments; treat the stream as operator-level output, not public API payload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
