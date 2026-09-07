# DeepSeek Harness

A plugin-based agent harness on vendored Cordis. The repo ships a web UI whose user-visible brand differs from the repo/package identity.

## Language

### Branding

**SmartFox Harness**:
The user-visible product name of the web UI: page title, PWA manifest, brand wordmark, and onboarding copy. Short name: SFH.
_Avoid_: DeepSeek Harness (for UI surfaces), SmartFox alone

**DeepSeek Harness**:
The repo and npm-package identity (`@deepseek-ai/dsh-*`, docs, commit history). Not a UI brand.
_Avoid_: SmartFox Harness (for repo/package references), DSH Local Build (as a UI label)

**DeepSeek**:
The LLM provider name shown in model settings. A real provider, never rebranded.
_Avoid_: SmartFox (for the provider)

**Fox mark**:
The single-color geometric fox-head SVG used as the standalone logo (sidebar, empty-state hero, favicon). Rides currentColor like other brand art.
_Avoid_: Fish logo, whale

### Conversations

**Session**:
The durable identity and append-only event log of one conversation; the unit a client reuses to continue a conversation across turns and Host restarts.
_Avoid_: conversation, thread, chat, dialogue (as the identity name)

**Turn**:
One user prompt and the agent's complete response up to the next turn boundary; the unit a Session accumulates.
_Avoid_: round, exchange, message

**Task** (task-service surface):
One submission to the task-service HTTP surface, serving exactly one Turn within a Session. Distinct from the Session, which may hold many Tasks' turns.
_Avoid_: job, request, conversation
