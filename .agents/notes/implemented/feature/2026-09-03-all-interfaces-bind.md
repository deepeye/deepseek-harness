# Agent Note: All-interfaces binding for the web and service profiles

Status: implemented

English | [中文](2026-09-03-all-interfaces-bind.zh.md)

## Problem

Both HTTP surfaces bound loopback only. The service profile exposed `DSH_SERVICE_HOST` but no command-line flag, and an invalid environment value was silently coerced to loopback inside the bundle patch expression. The web profile rejected `--host 0.0.0.0` outright — `web-app/src/startup.ts` carried a deliberate `program.error` stating that all-interfaces binding "would expose remote code execution to the network" — so a public deployment had no supported path even behind a TLS reverse proxy.

## Decision

`--host 0.0.0.0` is now accepted by both profiles, on the assessment that the existing defenses already carry the public-exposure threat model:

- **The web GUI is not unauthenticated.** The process-token URL → signed-cookie exchange (`dsh-client-connection` browser-auth) gates every Host API method and WebSocket stream, so the old rejection guarded against network reachability of an *authenticated* surface, not an open one.
- **The browser-trust fence stays explicit.** An all-interfaces bind auto-trusts only the machine's own non-internal IPv4 literals (`resolveLanTrust`); a public hostname or address must be named with `--trusted-host`, preserving the DNS-rebinding protection. The all-interfaces bind never means "trust any Host header." A cloud VM's public IP is often 1:1 NAT'd to a private interface address, so `resolveLanTrust` samples the private IP only and the public IP must still be named with `--trusted-host`.
- **A startup warning replaces the hard block.** Both profiles print, on the `dsh-cmdline` internals stderr channel, that the credential (web: process token and session cookie; service: bearer token) travels over plaintext HTTP and can be sniffed, and that a public deployment belongs behind a TLS-terminating reverse proxy. The webserver has no TLS story; the warning states that boundary instead of pretending the flag is safe.

The service profile gains the missing flag surface: a `service-startup` provider (mirroring the web profile's `web-startup`) parses `--host` and `--port`, resolves each as flag → environment (`DSH_SERVICE_HOST`/`DSH_SERVICE_PORT`, empty reads as unset) → default (`127.0.0.1`/`0`), and provides the resolved pair as the `serviceStartup` service that the webserver row reads. Unlike the web provider, which publishes only the flags the invocation named, the service provider owns the whole resolution — so an invalid environment value now fails at parse time with the variable named, instead of being silently coerced. `DSH_SERVICE_TOKEN` deliberately keeps no flag: command-line arguments are visible to `ps`, and a token flag would leak the credential to every same-machine user.

Both providers now validate `--host` at parse time against the webserver schema's two literals (`127.0.0.1`, `0.0.0.0`); anything else is a usage error before any row activates, instead of a schemastery failure deep in config load.

## Alternatives considered

**Keep the web rejection, service flag only.** Rejected: the rejection's stated risk (remote code execution) is carried by the authentication fence, and a deployment that owns a reverse proxy has no remaining reason to be blocked; the warning keeps the risk statement without hiding behind a refusal.

**Require a second opt-in (an env var or a mandatory `--trusted-host`) before an all-interfaces web bind.** Rejected: ceremony that the task-service sibling never demanded would be asymmetric, and `--trusted-host` is already required in practice for any public authority to pass the fence.

**Auto-trust any Host header on an all-interfaces bind.** Rejected: it would dismantle the DNS-rebinding protection; the explicit `--trusted-host` is the intended declaration.

## Consequences

`service-app` stops being a patch-only bundle: `src/startup.ts` is its first runtime plugin, the patch inserts a `service-startup` provider row before the webserver row (which now injects `serviceStartup`), and the package gains the `commander` and `dsh-cmdline` dependencies plus the `./startup` export. The invariant companion's empty-installer reason is restated for the new shape (immutable resolved values, no relation to check). Web startup tests replace the rejection case with acceptance-plus-warning and invalid-host rejection cases; service startup tests cover flags, environment fallback, precedence, empty-as-unset, help, and every rejection path. Both bundles' READMEs document the flag table, precedence, fail-loud validation, and the public-exposure warning. No `SessionEventMap`, agent-loop, or snapshot-tree change: the startup flags and warning are user-visible console output, not model-visible input, so no recorded-session snapshot is required.
