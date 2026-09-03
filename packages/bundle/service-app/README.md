---
description: "The dsh remote service profile bundle: a bearer-authenticated task HTTP surface over dsh-base for local web and desktop clients."
kind: "package-bundle"
---

# @deepseek-ai/dsh-service-app

English | [中文](README.zh.md)

## Summary

`dsh-service-app` is the profile bundle behind `dsh --profile service`: it layers the remote task HTTP surface over `dsh-base` so a local web or desktop client can submit agent tasks, watch progress over SSE, and collect results. It sets the unattended safety stance — the service never prompts anyone; operations that would need approval are rejected — while the sandbox still bounds file effects to the workspace by default. The bundle inserts three rows (the startup flag provider, the webserver, and the [task service](../../api/task-service/README.md)) and restates the approval and permission rows; its one plugin is that startup provider.

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

Run the profile with a token; the listen pair comes from the invocation flags or, when a flag is absent, the matching environment variable:

```sh
DSH_SERVICE_TOKEN=change-me dsh --profile service
DSH_SERVICE_TOKEN=change-me dsh --profile service --host 0.0.0.0 --port 18923
```

| Flag | Environment variable | Default | Meaning |
|---|---|---|---|
| — | `DSH_SERVICE_TOKEN` | required | Bearer token for every task-service route; empty fails the load (environment only — the token never takes a flag, which `ps` would expose) |
| `--port <port>` | `DSH_SERVICE_PORT` | `0` | Listen port; `0` picks an OS-assigned port |
| `--host <host>` | `DSH_SERVICE_HOST` | `127.0.0.1` | Bind host; `0.0.0.0` accepts remote connections |
| — | `DSH_SERVICE_WEBHOOK_URL` | — | Service-wide default completion webhook |

A flag overrides its environment variable for that invocation; an empty environment value reads as unset. An invalid `--host` (only `127.0.0.1` and `0.0.0.0` are supported), `--port`, `DSH_SERVICE_HOST`, or `DSH_SERVICE_PORT` value fails at startup instead of being silently coerced. An all-interfaces bind prints a warning: the bearer token travels over plaintext HTTP and can be sniffed, so front a public deployment with a TLS-terminating reverse proxy.

The HTTP surface, its request/response contract, and the SSE frames are owned by [`dsh-task-service`](../../api/task-service/README.md). Submit against `http://127.0.0.1:PORT/tasks` with the token as bearer.

### Unattended permission stance

The profile replaces the base `approval` row with the fail-closed `never` policy and pins the default permission preset to a `service` entry (workspace-write sandbox, approvals rejected). There is no one to ask on a headless service, so anything outside the preset is rejected rather than hanging a task on a prompt that no one will answer. Deployments wanting wider access restate `defaultPreset` in their own patch layer or switch it in settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a patch-list carrier over `dsh-base` with one runtime plugin: `cordis.patch.yml` replaces the `approval` row (`policy: never`) and the `permission` row (the base presets restated plus a `service` preset and `defaultPreset: service`), then inserts the `service-startup` provider, the `webserver` row (the provider's resolved host/port), and the `task-service` row (env-driven token and default webhook). A patch replaces a targeted row's whole config, which is why the permission row restates every base preset. The startup plugin owns the whole listen resolution — flag, environment fallback, default — so an invalid environment value fails at parse time. `src/index.ts` exports nothing; the invariant companion registers an empty installer because the provider publishes immutable values with no relation to check.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The service patch over `dsh-base` |
| [`src/startup.ts`](src/startup.ts) | The `service-startup` provider: `--host`, `--port`, `--help`, environment fallbacks, the public-bind warning |
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
