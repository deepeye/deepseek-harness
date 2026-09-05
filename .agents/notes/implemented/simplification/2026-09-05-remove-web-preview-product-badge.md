# Agent Note: Remove the web preview product badge

Status: implemented

English | [中文](2026-09-05-remove-web-preview-product-badge.zh.md)

## Problem

The Web empty-state hero rendered a localized `Preview` / `预览版` badge beneath the headline to mark the product as pre-release ([2026-08-05](../../archived/feature/2026-08-05-web-preview-product-badge.md)). That note defined removal as a product-release event: the badge leaves only when the owning product decision declares the preview phase complete, never through a runtime toggle. The product decision has now been made, so the badge no longer represents the product's lifecycle identity and must leave with its locale key.

## Decision

The preview product badge is removed as a unit from `@deepseek-ai/dsh-client-ui-conversation`: the `<span className={css.previewBadge}>` in `EmptyHero.tsx`, the `.previewBadge` rule and its dedicated `auto` grid column in `HeroShell.module.css`, and the `hero.preview` key from both the `zh` and `en` `conversation` locale dictionaries. The hero headline (`hero.headline`) and the brand-mark slot are unchanged, so the empty hero renders only the fox mark, headline, and workspace chip.

The repository's broader pre-release foundation stance — monotonic `SCHEMA_VERSION`, `SESSION_FORMAT_VERSION` at `0`, and the "rename freely and update every reference" assumption — is untouched and remains tied to the first tagged release, per `CLAUDE.md`. Only the product-identity badge leaves now, using the 2026-08-05 note's independent "owning product decision declares the preview phase complete" exit rather than waiting for a git tag.

The 2026-08-05 note is archived (frozen) alongside this change and remains the record of why the badge existed and why its removal is a product-release event.

## Alternatives considered

**Add a runtime or configuration toggle to hide the badge.** Rejected: the 2026-08-05 decision explicitly rejected a configuration field (two deployments of the same product must not present different lifecycle identities), and its exit is removal of the badge and its locale key together, not a hidden switch. Blank strings or a dead key would be the toggle that decision forbids.

**Defer removal to the first tagged release.** Rejected: the 2026-08-05 note permits removal when "the owning product decision declares the preview phase complete," independently of a git tag. The product decision has been made; keeping the badge would misrepresent the product as pre-release.

**Remove the whole pre-release foundation stance now.** Rejected as out of scope: the foundation stance is a separate, repo-wide effort tied to the first tagged release and deserves its own change and note. This change removes only the product-identity badge.

## Consequences

Every new session presents the same post-preview identity in the empty hero; the accessible headline no longer carries badge text. Reintroducing a preview badge would require a new feature Agent Note; the archived 2026-08-05 note remains the historical record of the original rationale. `skeleton.client.spec.tsx` asserts the headline text and brand-mark slot and never referenced the badge, so no badge-specific assertion changed; the `zh` and `en` `conversation` dictionaries remain key-complete after `hero.preview` leaves both. Typecheck, lint, the focused `ui-conversation` suites (353 tests), and the Agent Note format, translation-pairing, link, and archive gates all pass.
