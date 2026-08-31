# Agent Note: SmartFox brand in every build profile

Status: implemented

English | [中文](2026-08-24-smartfox-brand-in-every-build.zh.md)

## Problem

Deployment branding through slots ([2026-07-22 slot type chain](2026-07-22-slot-type-chain-implementation.md), master `319d9a7984`) made the sidebar brand a build-profile concern: `ui-brand-official` fills `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` only when `DSH_CLIENT_BUILD_PROFILE` is `official`, and the generic shell falls back to a repo-identity label - "DSH Local Build" plus the `DSH_CLIENT_COMMIT_HASH` badge. The pdmi rebrand (`a62033e7b3`) established SmartFox Harness as the user-visible product brand; after merging master's slot architecture, every non-official build - all local development - rendered the repo-identity label instead. The repository's ubiquitous language (`CONTEXT.md`) puts page title, wordmark, and onboarding copy on SmartFox Harness, so a brand that appears only under one build profile contradicts the glossary and makes local dev builds look like a different product.

## Decision

The SmartFox brand renders in every build. `ui-brand-official` fills the three brand slots unconditionally; the `DSH_CLIENT_BUILD_PROFILE` gate is removed from client code. The `ui-sidebar` shell fallbacks mirror the official occupants: the fox mark for `sidebar.brand.mark` and the mark-less smartfox wordmark for `sidebar.brand.name`, replacing the "DSH Local Build" label and deleting the commit-hash badge and its CSS. The build-environment title defaults follow the same rule: `DocumentTitle`, the vite index projection, and `apps/web/index.html` all default to `SmartFox Harness`. `DSH_CLIENT_BUILD_PROFILE` and `DSH_CLIENT_COMMIT_HASH` remain in `scripts/client-build-environment.ts` as build-record provenance for official artifacts; no client code reads either variable for presentation.

## Consequences

- Local/development and official builds render the identical brand; only the build record distinguishes them.
- The commit-hash badge disappears from the UI. Build provenance lives in `.dsh-build/client-build-environment.json`, not in user-visible chrome.
- `OfficialBrandName` now renders the same artwork as the shell fallback (the mark-less wordmark). The duplication is tolerated: the occupant remains the documented official provider, and the fallback keeps the generic shell self-sufficient when no brand package is loaded.
- A deployment wanting a different brand replaces the occupants through the slots; neither the fallback nor the build profile injects a repo identity.

## Testing

- `ui-sidebar` specs pin the fallback pair (fox-mark svg plus wordmark svg carrying the `smartfox` text) and the regenerated DOM snapshots; the commit-hash stubs left the specs with the badge.
- `ui-brand-official`'s profile-gating spec is deleted with the gate; the registration lifecycle spec runs without environment stubs.
- `ui-renderer`'s document-title spec expects `SmartFox Harness` in the no-build-title path.
- The built-boot smoke pins the wordmark by viewBox and its `smartfox` text instead of the old "official wordmark present, fallback text absent" pair.

## Alternatives considered

- **Rebrand the shell fallback text, keep the profile gate** - rejected: the generic `ui-sidebar` package would carry a specific brand as text while local builds still depended on a build profile to see the real brand art; the label/gate duality survives.
- **Keep "DSH Local Build" as a local-build label (master's model)** - rejected for this fork: the glossary makes SmartFox Harness the user-visible brand on every UI surface and the repo identity a non-brand; a two-brand, profile-dependent model re-introduces exactly the confusion the rebrand removed.
- **Run local builds under the official profile** - rejected: a brand that depends on how the dev server was launched reappears broken on every fresh checkout; branding must not be environment setup.
