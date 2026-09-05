# Agent Note: Remote authenticated editing of Models settings (--allow-remote-settings)

Status: implemented

English | [中文](2026-09-05-web-allow-remote-settings.zh.md)

## Problem

The Models settings page edits a Host-owned settings document, so the browser side reaches it through the Host settings provider over `settings.describe`. The settings base plugin (`dsh-client-ui-settings`) fixes that provider's client-side persistence once, at activation:

```ts
const persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'
```

`isLoopback` is the browser's own assessment of `location.hostname` (localhost, `127.0.0.1`, `::1`, or an `8`/`127` private interface) — fixed for the page lifetime, and unrelated to the server-side auth state. A non-loopback browser — the public IP in a `--host 0.0.0.0` deployment, or an authority named with `--trusted-host` — therefore gets `persistence = 'memory'`, the `SettingsDescribeMirror` starts terminal `unavailable`, and `ModelsSettingsStore.load` reports *settings are unavailable on a non-loopback connection without --allow-remote-settings* instead of the provider catalog. The page still loads, chats, and runs tools: only the settings data-access path is gated, because it is the one direct Host-document mutation the UI offers.

`--no-auth` and `--trusted-host` open the server-side `/api` Host/Origin trust fence; neither touches this client-side gate, and the gate is not the auth boundary — the `settings.describe` RPC is already server-auth-gated (BrowserAuth cookie + trust fence). An operator who fronts a public deployment with `--host 0.0.0.0 --trusted-host <authority>` and authenticates via the printed `?token=` URL still cannot edit the Models page, with no flag to lift the gate.

## Decision

Add an invocation-only `--allow-remote-settings` flag to `dsh --profile web` that, **when `--auth` is also on**, bakes a `globalThis.__DSH_REMOTE_SETTINGS__ = true` row into the served boot HTML through the existing `webserver/index-inject` structured-injection table. The settings base plugin reads that global once at activation alongside `isLoopback`:

```ts
const remoteSettingsReadable = (globalThis as ClientRemoteSettingsGlobal).__DSH_REMOTE_SETTINGS__ === true
const persistence = (ctx.remote.$host.isLoopback || remoteSettingsReadable) ? 'host' : 'memory'
```

`ClientRemoteSettingsGlobal` is a reader-side typed interface local to the settings plugin — the same `__DSH_TRANSPORT__` / `__DSH_BOOT__` precedent (a typed reader interface plus a bare writer string), not a shared cross-plane module. The boot entry awaits `__DSH_BOOT_READY__` before any plugin activates, so the global is set before `ui-settings.apply(ctx)` reads it; persistence stays fixed at boot, so no mirror refactor, no wire-protocol change, and no opening-frame / Typert / `SESSION_FORMAT_VERSION` implication.

The flag is fail-loud: `--allow-remote-settings --no-auth` exits 1 at startup with `error: --allow-remote-settings requires authentication; remove --no-auth to use it, or serve on loopback without the flag`. This is a deliberate divergence from the warn-only `--host 0.0.0.0 --no-auth` path: settings-edit is a data-mutation capability, not passive exposure, so unauthenticated `/api` access is not enough to trust it. The web-app `Config` gains `auth` and `allowRemoteSettings` (both booleans, defaults `true` / `false`); the bundle-patch `web-runtime` row reads both from `ctx.webStartup`, and `web-app.apply` registers a `webserver/index-inject` listener that pushes the global row only when `config.allowRemoteSettings && config.auth` — the AND guards a future cordis.yml overlay that names `allowRemoteSettings: true` directly while leaving `auth` at its `true` default in a layer that turns auth off.

The opt-in flips only the settings data-access decision. The two other `$host.isLoopback` reads stay loopback-gated: `ui-settings-general`'s "open native settings document" and `ui-deliverables`'s "open produced files" — both are desktop reachability actions meaningless for a remote browser, not data-access.

## Verification

`startup.spec.ts` pins the `--allow-remote-settings` parse, the `allowRemoteSettings` service value (`true` alone, `false` by default), and that `--allow-remote-settings --no-auth` exits 1 with the `requires authentication` message before the consumer activates — mirroring the `--host 192.168.1.5` rejection case. `plugin.client.spec.ts` pins the persistence decision at the `apply` seam: a non-loopback browser without the global keeps `describe` uncalled (memory, terminal unavailable), and a non-loopback browser with `globalThis.__DSH_REMOTE_SETTINGS__ = true` reads host settings once (eager `describe`). `store.client.spec.ts` pins the improved *…on a non-loopback connection without --allow-remote-settings* fallback literal. The default path (opt-in off, or loopback) pushes no global row and resolves persistence identically to before, so the served boot HTML is byte-identical and recorded web snapshots are unaffected.

## Alternatives considered

### Why not gate on `--trusted-host`?

`--trusted-host` answers a different question: "is this Host/Origin authority accepted by the `/api` trust fence?" It is a reachability and DNS-rebinding defense, not a settings-mutation consent. A deployment names a public authority with `--trusted-host` precisely so the remote browser can reach `/api` at all; conflating that with "may edit the settings document" would silently widen data-mutation the first time an operator reaches for a public hostname, with no separate opt-in and no fail-loud. The settings gate needs its own affirmative flag whose sole purpose is settings-edit consent.

### Why not extend `ConnectionHostInfo` / the opening frame?

`RemoteHostFacts` (`{ home, isLoopback }`) is a plain client-side interface, and `isLoopback` is the browser's self-assessment — the server cannot derive it (it does not know the browser's `location.hostname`). The server-pushed fact on the opening frame is `home` alone; pushing a "remote settings readable" fact would require either a new wire/Typert field (bumping surface area and `SESSION_FORMAT_VERSION`-adjacent contracts) or smuggling it through an existing field. The boot-HTML global reaches the browser through the same channel that already bakes `__DSH_BOOT__` / `__DSH_TRANSPORT__`, needs no wire event, and is fixed at boot — which is exactly the invariant the persistence decision already relies on.

### Why not put `remoteSettingsReadable` on `ConnectionHandle`?

A live RPC the client polls on each connection would make settings readability a per-connection property. But persistence is fixed once at `ui-settings.apply` activation and never re-derived; a per-connection RPC would either be read once (no benefit over a boot global) or invite re-derivation, breaking the "persistence fixed at boot" invariant and risking a mid-session flip from memory to host that the mirror is not built to handle. The boot global is read exactly where `isLoopback` is read, in the same activation segment, and never again.

### Why leave the desktop-open actions loopback-gated?

`ui-settings-general`'s "open native settings document" and `ui-deliverables`'s "open produced files" invoke the operator's local desktop — `open`-style reachability actions that are meaningless for a remote browser and have no server-side path to the remote machine. Flipping them under `--allow-remote-settings` would advertise actions that cannot succeed remotely; the settings data-access path is the only one of the three `isLoopback` reads that has a remote-meaningful, server-backed behavior, so it is the only one the flag touches.

### Why fail-loud exit 1 instead of warn like `--host 0.0.0.0 --no-auth`?

`--host 0.0.0.0 --no-auth` warns because a reverse-proxy deployment that terminates TLS and supplies its own authentication legitimately wants unauthenticated local `/api` exposure — the warn path is a supported shape. `--allow-remote-settings` has no such supported unauthenticated shape: the flag exists to let a remote browser mutate the settings document, and `--no-auth` makes `/api` reachable by anyone on the network with no identity. A warning would let an operator pair the two and believe settings-edit was gated when it was wide open. The exit-1 makes the incompatibility unmissable and matches the existing `program.error` precedent for `--host` / `--port` rejection.

## Consequences

What it cost: one CLI flag and its help example, two `Config` fields (`auth`, `allowRemoteSettings`) on `web-app` with their patch-row expressions, one `webserver/index-inject` listener (registry-disposed with the fiber), a reader-side typed global and a second term in the one persistence decision, the fail-loud check, and the bilingual README + config-catalog + Agent Note updates. The `auth` field is also a `web-app` `Config` field now (previously only the `connection` row read `ctx.webStartup.auth`), which is the right home for the AND-guard.

What it bought: an operator who fronts a public deployment with `dsh web --host 0.0.0.0 --trusted-host <authority> --allow-remote-settings` and opens the printed `?token=` URL can edit the Models settings page from the remote, authenticated browser — the exact gap the Aliyun deployment hit — while the loopback default, the trust fence, and the desktop-open actions are all unchanged. The fail-loud `--no-auth` pairing and the AND-guarded listener keep settings-mutation behind an affirmative, authenticated opt-in.
