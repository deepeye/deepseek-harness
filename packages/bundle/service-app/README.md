---
description: "The dsh remote service profile bundle: a bearer-authenticated task HTTP surface over dsh-base for local web and desktop clients."
kind: "package-bundle"
---

# @deepseek-ai/dsh-service-app

English | [中文](README.zh.md)

## Summary

`dsh-service-app` is the profile bundle behind `dsh --profile service`: it layers the remote task HTTP surface over `dsh-base` so a local web or desktop client can submit agent tasks, watch progress over SSE, and collect results. It sets the unattended safety stance — the service never prompts anyone; operations that would need approval are rejected — while the sandbox still bounds file effects to the workspace by default. The bundle inserts two rows (the webserver and the [task service](../../api/task-service/README.md)) and restates the approval and permission rows; it owns no plugin of its own.

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

Run the profile with a token; the listening port and host are environment-driven:

```sh
DSH_SERVICE_TOKEN=change-me dsh --profile service
```

| Environment variable | Default | Meaning |
|---|---|---|
| `DSH_SERVICE_TOKEN` | required | Bearer token for every task-service route; empty fails the load |
| `DSH_SERVICE_PORT` | `0` | Listen port; `0` picks an OS-assigned port |
| `DSH_SERVICE_HOST` | `127.0.0.1` | Listen host; `0.0.0.0` accepts remote connections |
| `DSH_SERVICE_WEBHOOK_URL` | — | Service-wide default completion webhook |

The HTTP surface, its request/response contract, and the SSE frames are owned by [`dsh-task-service`](../../api/task-service/README.md). Submit against `http://127.0.0.1:PORT/tasks` with the token as bearer.

### Unattended permission stance

The profile replaces the base `approval` row with the fail-closed `never` policy and pins the default permission preset to a `service` entry (workspace-write sandbox, approvals rejected). There is no one to ask on a headless service, so anything outside the preset is rejected rather than hanging a task on a prompt that no one will answer. Deployments wanting wider access restate `defaultPreset` in their own patch layer or switch it in settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a static patch-list carrier over `dsh-base`: `cordis.patch.yml` replaces the `approval` row (`policy: never`) and the `permission` row (the base presets restated plus a `service` preset and `defaultPreset: service`), then inserts the `webserver` row (env-driven host/port) and the `task-service` row (env-driven token and default webhook). A patch replaces a targeted row's whole config, which is why the permission row restates every base preset. `src/index.ts` exports nothing; the bundle owns no service, and its invariant companion registers an empty installer for that reason.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The service patch over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module marker (patch-only bundle) |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: no runtime invariant; the rows are owned by their packages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core the service profile runs on.
- [dsh-task-service](../../api/task-service/README.md) — the HTTP surface this bundle composes.
- [dsh-headless](../headless/README.md) — the one-shot sibling for scripts and CI.

-----

<a id="model-experience"></a>
## Model Experience

None, as the bundle adds no model-facing rows; the persona, prompts, and tools come from the base layer it patches.

#### KV Cache effect

The bundle adds nothing to the request prefix; the task service submits ordinary user messages into fresh sessions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you when the service profile does not fit and what a deployment must supply.

- **Runs through the `dsh` launcher** — the profile is a `dsh --profile` composition; other launch paths are not supported application entry points.
- **Token from the environment only** — the bearer token arrives via `DSH_SERVICE_TOKEN`; there is no credential-file integration or rotation story in the bundle.
- **Single-user trust model** — the surface assumes one trusted caller; front it with your own gateway for anything wider.
- **No TLS** — the webserver serves plain HTTP; terminate TLS in a reverse proxy if the port leaves the host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
