# Agent Note: Web login-gate opt-out (--no-auth)

Status: implemented

English | [中文](2026-09-05-web-no-auth-opt-out.zh.md)

## Problem

The Web profile gates every `/api` request and the index page behind a process launch-token exchange and a signed browser-session cookie ([browser token authentication](2026-08-24-browser-token-authentication.md)). That gate is correct for a loopback or directly-exposed deployment, but two shapes want it off: a local dev session that resents copying the tokenized URL, and a production deployment fronted by a TLS-terminating reverse proxy that supplies its own authentication. With no opt-out, the second shape must either leak the process token to the proxy or run an unmodified gate the proxy cannot satisfy.

## Decision

Add an invocation-only `--no-auth` flag to `dsh --profile web` that disables the `BrowserAuth` gate for that invocation. The connection plugin's `Config.auth` boolean (default `true`) is the mechanism; the web-app startup provider publishes `auth` from the CLI flag, and the bundle-patch connection row reads `ctx.webStartup.auth` directly — mirroring how the webserver row reads `webStartup.host` / `port` — so `web-app`'s own `Config` is unchanged and `webRuntime` carries no `auth` field.

When `auth` is `false`:

- `BrowserAuth` creates no `client-connection/browser-session` signing secret; the credential record is untouched.
- `authenticatedUrl` returns the bare root URL with no `?token=...`.
- `authorizeIndex` serves the index without challenge; no cookie is minted.
- `isAuthenticated` returns `true`, so `HostConnectionService.requestRejection` skips the 401 path. The Host/Origin trust fence (`isTrustedApiRequest`) still runs and still returns 403 for an untrusted Host — the opt-out removes token/cookie auth only, never the DNS-rebinding / cross-site defense.

A non-loopback bind (`--host 0.0.0.0`) with `--no-auth` is allowed but prints a distinct stderr warning: the agent is exposed to every reachable client with no authentication. The warning replaces the auth-on token-sniffing warning for that combination, since there is no token or cookie to sniff. The service profile's bearer-token gate is out of scope and untouched.

## Verification

`startup.spec.ts` pins the `--no-auth` parse, the `auth` service value, the distinct non-loopback warning text, and that the auth-on token-sniffing warning does not fire under `--no-auth`. `browser-auth.host.spec.ts` pins the disabled owner: no secret written, clean `authenticatedUrl`, `authorizeIndex` serves without challenge, `isAuthenticated` is unconditionally true. `node-half.host.spec.ts` pins the carrier behavior end-to-end: the 403 trust fence still rejects an untrusted Host, a loopback Host reaches the bridge with no cookie (no 401), and `requestRejection` returns `undefined` for trusted Hosts. The default `auth=true` path is byte-identical to before, so recorded-session snapshots are unaffected.

## Alternatives considered

### Why not hard removal?

Gutting `BrowserAuth` would make open access the default, including for `--host 0.0.0.0` where anyone on the network gets full agent control. The opt-out keeps the secure default and the tokenized-URL path; only an explicit flag widens access.

### Why not route `auth` through `webRuntime` like `trustedHosts`?

`trustedHosts` travels through `webRuntime` because it is bind-derived (LAN IP literals are sampled after the server binds). `auth` is invocation-only with no bind dependence, so routing it through `webRuntime` would invent a field with no bind reason to exist. Reading `webStartup.auth` directly at the connection row mirrors the webserver row's direct read of `webStartup.host` / `port`, and leaves `web-app`'s `Config` and `apply` untouched.

### Why not also disable the trust fence?

The Host/Origin fence is a DNS-rebinding and cross-site CSRF defense, not an authentication layer; its own file says so. Disabling it would let any page in the user's browser drive `/api` on the loopback origin. The flag removes only token/cookie auth.

### Why not refuse `--no-auth` on a non-loopback bind?

A reverse-proxy deployment that terminates TLS and supplies its own authentication legitimately wants `--host 0.0.0.0 --no-auth`. Refusing would block that shape. A loud warning matches the existing `--host 0.0.0.0` precedent (warn, not refuse) while naming the larger blast radius.

## Consequences

What it cost: a new per-invocation code path through `BrowserAuth`, one more `webStartup` expression in the bundle patch, and a documented-and-warned shape in which a non-loopback `dsh web` runs with no authentication — safe only behind a proxy that authenticates.

What it bought: a loopback dev session opens to a clean URL with no token to copy, and a TLS-fronted deployment can delegate authentication to its proxy without leaking the process token. The secure default and the trust fence are both intact; the credential record is not created when the gate is off.
