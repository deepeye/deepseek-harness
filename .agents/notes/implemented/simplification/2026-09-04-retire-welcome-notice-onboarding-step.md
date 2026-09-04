# Agent Note: Retire the welcome-notice onboarding step

Status: implemented

English | [中文](2026-09-04-retire-welcome-notice-onboarding-step.zh.md)

## Problem

The Web client opened a versioned "Internal Testing Notice" (`内测声明`) modal on first run, acknowledged against a durable `ui-onboarding.welcomeNoticeVersion` field. The notice announced the 0.1 testing phase to Harness developers and was a pre-release artifact. The other first-run dialog, the official-DeepSeek credential step, does not depend on it.

## Decision

The `welcome-notice` onboarding step is removed from `dsh-client-ui-settings-models`: the `WelcomeNotice` component and `WelcomeNotice.module.css`, the `welcome-store`, the `onboarding-copy` constants, the four `welcome*` locale keys in both `en` and `zh`, the `settings.onboarding` registration, and the two dedicated tests (`welcome-notice.client.spec.tsx`, `welcome-store.client.spec.ts`). `apply.client.spec.ts` now asserts one onboarding step (`deepseek-official`).

The shared `OnboardingModal` chrome stays; the DeepSeek credential step still renders inside it. The `settings.onboarding` ledger and the shell projection in `dsh-client-ui-settings-general` are unchanged.

The durable `ui-onboarding` settings namespace and its `welcomeNoticeVersion` field are removed from the `dsh-client-ui-settings-general` Host apply. That apply becomes the no-op Host stub the codebase uses for Client-only packages, and the now-orphaned `@deepseek-ai/schemastery` dependency is dropped. The client slot catalog is regenerated.

Both packages' READMEs (English and Chinese) are updated and the bilingual pairs re-recorded.

## Alternatives considered

**Keep the machinery, suppress only the popup.** Rejected because it leaves the component, store, constants, locale keys, and Host namespace as dead code with no consumer, which the repo conventions forbid. A future notice can reintroduce the machinery from git history.

**Keep the durable `ui-onboarding` Host namespace as a future onboarding-facts container.** Rejected for the same dead-code reason: the namespace had one consumer, and an empty Host apply is not a valid installer in this codebase.

**Remove the DeepSeek credential onboarding step too.** Rejected because that step is a separate first-run flow (API-key setup), not the internal-testing notice, and it shares the `OnboardingModal` chrome.

## Consequences

Opening the Web client no longer shows the Internal Testing Notice; the `settings.onboarding` ledger carries one step. Loopback browsers that previously acknowledged carry a stale `ui-onboarding` section; with the namespace unregistered and no reader, it is inert, which the pre-release on-disk-format policy covers.

A future product-wide notice can reintroduce a versioned step and its durable namespace when it has a consumer. Typecheck, lint, and `doc-sync` pass, and the focused `ui-settings-models` and `ui-settings-general` suites pass (253 tests).
