# Slack August 2026 agent platform adoption plan

**Status:** Recommended implementation plan; no product code implemented

**Date:** 2026-08-31

## Decision

PwrAgent should adopt Slack Agent Sessions now for lifecycle status, conversation titles, and native stop handling. This is the smallest high-value slice because it makes existing PwrAgent threads first-class in Slack's Agents surface without changing PwrAgent's thread model.

PwrAgent should not dual-write the legacy Assistant Threads API and Agent Sessions API. Agent Sessions should be authoritative. During a short migration window, the Slack adapter may fall back to `assistant.threads.setStatus` only when the workspace rejects the new API as unavailable. The fallback must be exclusive for that operation, not a second write.

Slack Code should wait. Slack's announcement describes the product experience, but the public developer documentation does not yet define an API for creating or managing Slack Code session channels or its artifact contract. Ordinary Slack channel and file APIs are not enough to claim Slack Code integration.

No separate brainstorm is needed for this recommendation. The remaining product questions have explicit ownership rules or later-entry gates below.

## Audit baseline

The current checkout already has a meaningful part of Slack's agent messaging stack:

- Opt-in live working cards use `chat.startStream`, `chat.appendStream`, and `chat.stopStream` for a bound Slack thread.
- The working-card mapper produces Slack task and plan updates, with markdown fallbacks and rate-limited queues.
- Typing activity calls `assistant.threads.setStatus` and disables that capability when the method or scope is unavailable.
- The generated manifest requests both `assistant:write` and `chat:write`.
- The desktop already has an explicit conversation-name synchronization action and an established, authorized path for interrupting a running turn.
- The Slack provider declares `@slack/web-api ^7.15.2` and `@slack/socket-mode ^2.0.7`; the current lockfile resolves Web API 7.19.0 and Slack Types 2.22.0, before the Agent Sessions additions in Web API 8.1.0 and Types 3.1.0.

The following are absent:

- `agents.sessions.setStatus` and `agents.sessions.rename` calls.
- An `agent_view` feature declaration in the generated manifest.
- Agent session title persistence or `agent_session` response handling.
- `agent_session_stopped` and `agent_session_title_changed` subscriptions and handlers.
- An explicit `session_status` on `chat.stopStream`.
- Slack Code channel lifecycle support.

The audit also found one payload mismatch to correct during implementation: PwrAgent's internal working-card display modes include `dense`, while Slack documents only `timeline` and `plan` for `task_display_mode`.

Primary code evidence:

- `packages/messaging/providers/slack/src/slack-adapter.ts` contains the stream queues, legacy Assistant Threads status call, unsupported title outcome, inbound event dispatch, and Slack managed-thread behavior.
- `packages/messaging/providers/slack/src/slack-app-manifest.ts` generates the manifest; the JSON/YAML files under `packages/messaging/providers/slack/manifests/` are generated artifacts.
- `packages/messaging/interface/src/index.ts` defines the channel-neutral activity, working-card, title, managed-conversation, and inbound event contracts.
- The desktop messaging controller emits activity and working-card intents and already owns the authorized active-turn interruption and name-sync workflows.
- `docs/messaging-adapter-contract.md` documents the existing working-card contract and Slack streaming behavior.

## Gap matrix

| Slack feature | Current PwrAgent support | Recommendation | Rationale |
|---|---|---|---|
| Agent Sessions status (`active`, `processing`, `suspended`, `closed`) | Legacy binary activity through `assistant.threads.setStatus` only | **Build now** | Native statuses drive the Agents tab/sidebar, standard working presentation, stop affordance, and richer waiting state. |
| `agents.sessions.setStatus` | No call or SDK type | **Build now** | Use lifecycle transitions rather than the existing 10-second typing refresh. Slack allows 50+ calls/minute but automatically resets `processing` after one hour, so state-change writes plus a long-running refresh are sufficient. |
| `agents.sessions.rename` and titled Agent DMs | Slack returns `unsupported` from generic `setConversationTitle`; inbound titles come from root message text | **Build now** | Real session titles make conversations recoverable in Slack's Agents surface and activate the existing explicit **Sync Name** action. |
| `agent_session_title_changed` | Not subscribed or handled | **Build now** | Preserve Slack-side rename state and recover it across message responses. Do not silently rename the global PwrAgent thread. |
| `agent_session_stopped` and processing stop button | Not subscribed or handled | **Build now** | Map the native Slack control to PwrAgent's existing authorized turn interruption path. Slack does not stop the work or update status for the app. |
| `agent_session` on message-bearing responses | Current SDK/types predate it; ignored by adapter | **Build now** | Hydrate authoritative Slack title and status after restarts or missed events. It also avoids treating the root message text as the title when Slack has a real session title. |
| `agent_view` and Agents tab/sidebar | Manifest declares neither `agent_view` nor deprecated `assistant_view` | **Build now** | The generated app definition does not currently guarantee that PwrAgent is presented as a Slack agent. Add `agent_view` directly; do not introduce `assistant_view`. |
| Messages-tab `app_home_opened` migration behavior | Event is already subscribed; the adapter publishes Home only for Home-tab opens and intentionally takes no action for `tab: "messages"` | **Keep; add coverage** | This already avoids relying on the removed `assistant_thread_started` root-message shape. A mere DM open does not need to create a PwrAgent thread; create/bind on the user's first message. |
| Assistant-to-Agent compatibility bridge | PwrAgent uses the legacy status API; Slack maps nonempty/empty status to `processing`/`active` | **Temporary fallback only** | The bridge helps rollout compatibility, but dual-writing can race, consume rate limits, and collapse `suspended` into the legacy binary model. Remove the fallback before `assistant_view` deprecation in February 2027. |
| Streaming replies | Implemented for working cards when a Slack thread target exists | **Harden now** | Keep the existing implementation, add explicit terminal `session_status`, adopt current SDK types, and normalize undocumented `dense` mode. |
| `session_status` on `chat.stopStream` | Omitted, so Slack defaults the session to `active` | **Build now** | Make successful, failed, and interrupted outcomes explicit and testable. Use `suspended` only when PwrAgent intentionally leaves a session awaiting input. |
| Task display mode | `timeline`, `plan`, and undocumented `dense` may be sent | **Fix with stream hardening** | Map `dense` to `timeline` or omit it; Slack's public contract names only `timeline` and `plan`. |
| Plan and task cards | Already emitted as `plan_update` and `task_update` streaming chunks | **Keep; test after SDK upgrade** | Slack's new Plan/Task UI is primarily client rendering for payloads PwrAgent already emits. No separate app-side feature is required. |
| Block Kit chunks during streaming | Stream model does not expose `blocks` chunks | **Later** | Add only when a concrete artifact or interactive-result design needs it; it is not required for sessions, titles, or stop. |
| `app_context_changed` and agent context | Not subscribed; inbound message model ignores app context | **Later, opt-in** | Current Slack context can enrich prompts but must not replace PwrAgent's explicit binding-based routing. It needs a privacy, prompt-injection, token-budget, and provenance design first. |
| Agents & Tools tab | No explicit integration | **Ignore for now** | This is Slack client presentation. Session APIs, manifest agent declaration, and normal app metadata are the app-side prerequisites. No additional public API work is documented. |
| Marketplace About tab | PwrAgent uses operator-created, unpublished Slack apps | **Ignore** | Marketplace listing metadata is not part of the adapter runtime and provides no value to the current installation model. |
| Slack Code dedicated channels | Managed Slack conversations currently create a child thread, not a dedicated session channel | **Later, gated** | PwrAgent's thread/multi-directory model could fit well, but Slack has not published an app-side Slack Code channel lifecycle API. |
| Slack Code artifact surface (diffs, HTML previews, Block Kit, canvases) | Generic files/messages exist; no Slack Code artifact contract | **Later, gated** | Do not approximate the named feature with unrelated channel/file APIs. Wait for a documented contract, then design typed artifact intents. |
| Slack Code create/update/close lifecycle | Generic managed-conversation interface exists, but Slack provider lacks these channel operations | **Later, gated** | Ordinary `conversations.create`/archive would add broad scopes and unresolved invitation, privacy, retention, and context-carry rules without delivering verified Slack Code behavior. |

## Compatibility and manifest changes

### API authority

Use these status mappings:

| PwrAgent lifecycle | Slack Agent Session status |
|---|---|
| Turn accepted or running | `processing` |
| Waiting for user clarification or approval | `suspended` |
| Completed, failed, or interrupted and ready for another prompt | `active` |
| Explicitly closed or unbound conversation | `closed` |

Application process shutdown is not conversation closure and must not set sessions to `closed`.

`chat.startStream` already creates a session and marks it `processing`. The adapter should still support an explicit session-start transition so it can create the session with its initial title and initiator even when no working-card stream is enabled. Coalesce redundant status calls: write on lifecycle changes, and refresh `processing` before Slack's one-hour timeout only for a genuinely long-running turn.

On `chat.stopStream`, send `session_status: "active"` for completed, failed, or interrupted work. If a stream is deliberately stopped while the agent awaits user input, use `suspended`. Do not infer `closed` from a terminal turn.

### No dual-write

The migration behavior should be:

1. Call Agent Sessions APIs as the authoritative path.
2. If Slack reports the new method or agent feature as unavailable for an existing installation, use the corresponding Assistant Threads call for that operation and record the workspace capability.
3. Do not issue both writes for one transition.
4. Retry Agent Sessions only after a manifest/reinstall capability refresh, not on every activity heartbeat.
5. Remove the compatibility fallback before February 2027.

This avoids a race in which `assistant.threads.setStatus` changes a richer `suspended` state back to its binary `processing` or `active` mapping. The legacy custom loading text also has no Agent Sessions equivalent; PwrAgent should accept Slack's standard working presentation.

### Scopes, features, and events

| Manifest item | Current | Change |
|---|---|---|
| `chat:write` | Present | Keep; Agent Sessions methods and events use it. |
| `assistant:write` | Present | Keep during migration and because Slack adds/uses it for declared agent apps. |
| `features.agent_view` | Missing | Add with an operator-facing `agent_description`. Do not add `assistant_view`. |
| `agent_session_stopped` | Missing | Subscribe now. |
| `agent_session_title_changed` | Missing | Subscribe now. |
| `app_context_changed` | Missing | Do not subscribe until PwrAgent consumes and governs context. |
| Slack Code channel/canvas scopes | Missing | Do not add speculative scopes. |

Switching an existing Slack app from `assistant_view` to `agent_view` is irreversible and may require a hard refresh. PwrAgent's checked-in manifest declares neither view, so newly generated manifests should go directly to `agent_view`. Existing customer-owned apps will need an explicit manifest update and reinstall/re-authorization workflow, documented in operator setup instructions.

## Architecture decisions

### Keep the adapter boundary generic

Add a channel-neutral conversation-session intent to `packages/messaging/interface` rather than branching on Slack in the desktop controller. It should express:

- lifecycle state: processing, active, suspended, or closed;
- optional initial title and initiating user;
- a stable conversation target;
- enough correlation to coalesce repeated state writes.

The desktop controller can emit this alongside existing typing activity so other adapters retain their current behavior. Slack implements the richer session intent inside `packages/messaging/providers/slack`; providers without a session model may ignore it or return an explicit unsupported outcome.

Likewise, add a channel-neutral inbound control for a user-requested turn stop. The Slack adapter should validate the channel, thread, and actor, resolve the existing binding, and emit that control. The desktop should route it through the same permission check and interruption function used by the existing status-card stop action. No provider package should import desktop orchestration.

### Title ownership

Use the current PwrAgent thread title when the Slack session is first created. Slack users may then rename the session locally.

Treat `agent_session_title_changed` as Slack binding metadata, not as an automatic rename of the global PwrAgent thread. Slack allows channel participants to change a title, and one PwrAgent thread may be linked to multiple messaging surfaces. The existing explicit **Sync Name** action is the operator's intentional overwrite and should call `agents.sessions.rename`.

When Slack includes `agent_session` on `chat.postMessage`, `conversations.history`, `conversations.replies`, search, or pin responses, prefer its title over the root message text for the Slack thread-title cache. This supplies restart and missed-event recovery.

### Stop authorization and recovery

The native stop button is a request, not proof that work was stopped. Enforce the same `thread.turn.stop` permission as the existing stop control before interrupting the turn.

After an authorized request:

1. Confirm that the bound PwrAgent thread still has the target active turn.
2. Interrupt it through the existing backend path.
3. Mark the turn interrupted and transition the Slack session to `active`.
4. Treat `streaming_message_ts` as correlation/diagnostic data, not as the authority for which PwrAgent turn to stop.

If authorization fails or the event is stale, do not interrupt unrelated work. Because Slack changes the button presentation when clicked but does not update the app's session state, promptly restore the correct session status and send the normal authorization or stale-action response.

## Recommended implementation order

### 1. SDK, manifest, and protocol fixtures

- Upgrade `@slack/web-api` to at least 8.1.0 so `agents.sessions.rename`, `agents.sessions.setStatus`, `session_status`, and `agent_session` are typed.
- Upgrade `@slack/socket-mode` to the compatible v3 line in the same change so PwrAgent has one Node Slack SDK generation; add a direct `@slack/types` 3.1.x dependency only if source imports event types directly.
- Audit the v8 native-fetch and typed-error migration against PwrAgent's rate-limit/error helpers.
- Add `features.agent_view` and the two Agent Session event subscriptions to the generated manifest and regenerate JSON/YAML artifacts.
- Update manifest tests and operator installation/re-authorization documentation.
- Add representative event and response fixtures before behavior changes.

### 2. Session lifecycle and titles

- Add the generic conversation-session intent and Slack capability tracking.
- Implement typed `agents.sessions.setStatus` with state-change coalescing and a long-running processing refresh below the one-hour timeout.
- Set the initial title and initiator when the session is created.
- Implement `agents.sessions.rename` for the existing explicit name-sync action.
- Read `agent_session` metadata from message-bearing responses and handle `agent_session_title_changed` as binding-local metadata.
- Add the exclusive legacy fallback, migration telemetry, and a dated removal marker for February 2027.

This phase should ship independently if needed. It produces first-class, titled sessions in Slack's Agents surface before native stop handling lands.

### 3. Native stop control

- Add the generic inbound stop control and map `agent_session_stopped` to it in the Slack adapter.
- Reuse the desktop's existing permission-checked active-turn interruption path.
- Cover duplicate, unauthorized, stale, already-idle, and backend-failure outcomes.
- Restore the correct Slack status whenever the click cannot produce an interruption.

### 4. Stream lifecycle hardening

- Send an explicit `session_status` from `chat.stopStream`.
- Normalize or omit internal `dense` task display mode.
- Replace manual stream API declarations and avoidable casts with SDK 8.1 types.
- Verify task/plan chunks and non-streaming fallbacks after the SDK upgrade.
- Keep Block Kit stream chunks out of scope until a concrete interactive-result design needs them.

### 5. Later discovery gates

For Slack context, return only after there is an opt-in product design that defines provenance, prompt-injection handling, data minimization, token budgets, and visible user control. Explicit PwrAgent bindings must remain routing authority.

For Slack Code, return only when Slack publishes an official developer contract for session-channel creation/lifecycle and artifact attachment. At that point, decide:

- public versus private channel policy and invitations;
- mapping between a PwrAgent thread, its multiple Git directories, and one or more Slack channels;
- context carry-forward and retention;
- close/reopen/delete semantics;
- typed code diff, preview, Block Kit, canvas, and file artifact intents;
- least-privilege scopes and operator consent.

## Verification and acceptance criteria

The implementation is complete when all of these behaviors are covered by adapter, controller, and manifest tests:

- A newly accepted Slack request becomes a titled `processing` Agent Session even when live working cards are disabled.
- Waiting for clarification becomes `suspended`; a new accepted reply becomes `processing`; completion, failure, and interruption become `active`.
- Repeated typing refreshes do not repeatedly call Agent Sessions APIs.
- A turn longer than one hour refreshes `processing` before Slack resets it.
- Explicit name sync renames the Slack session; a Slack-originated rename updates local binding metadata without renaming the global PwrAgent thread.
- Message responses containing `agent_session` restore title/status metadata after restart or a missed event.
- Native stop interrupts only the currently bound, authorized active turn and is idempotent under duplicate delivery.
- Unauthorized, stale, idle, and backend-failure stop requests leave unrelated turns untouched and restore truthful Slack status.
- `chat.stopStream` sends the intended terminal session status.
- Only documented `timeline` or `plan` task display modes reach Slack.
- Workspaces that lack the new capability use one legacy write rather than a legacy/new dual-write.
- The generated manifest contains `agent_view`, both Agent Session events, and no speculative Slack Code or context scopes/events.
- Existing text fallbacks continue to work when streaming is disabled, rate-limited, or unavailable.

Run the focused Slack provider and desktop messaging tests, then the repository's required lint, type, boundary, and license checks before opening a pull request. The renderer must continue to access provider behavior only through the main-process IPC bridge.

## Official sources

- [Slack agent updates, 20 August 2026](https://docs.slack.dev/changelog/2026/08/20/agent-updates/)
- [Slack Code announcement](https://docs.slack.dev/changelog/2026/08/20/slack-code/)
- [Agent Sessions guide](https://docs.slack.dev/ai/agent-sessions/)
- [Migrating to agent messaging](https://docs.slack.dev/ai/migrating-to-agent-messaging/)
- [Developing agents](https://docs.slack.dev/ai/developing-agents/)
- [Agent context management](https://docs.slack.dev/ai/agent-context-management/)
- [`agents.sessions.setStatus`](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/) and [`agents.sessions.rename`](https://docs.slack.dev/reference/methods/agents.sessions.rename/)
- [`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream/)
- [`agent_session_stopped`](https://docs.slack.dev/reference/events/agent_session_stopped/) and [`agent_session_title_changed`](https://docs.slack.dev/reference/events/agent_session_title_changed/)
- [`app_context_changed`](https://docs.slack.dev/reference/events/app_context_changed/)
- [Task cards and plan blocks, 11 February 2026](https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks/)
- [Assistant status scope bridge, 5 March 2026](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/)
- [Block Kit chunks in streaming, 16 April 2026](https://docs.slack.dev/changelog/2026/04/16/block-kit-new-blocks/)
- [Agent Messages tab requirements, 30 June 2026](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/)
- [Node Slack SDK v8 migration announcement](https://docs.slack.dev/changelog/2026/07/14/node-slack-sdk-release/)
- [Slack Web API 8.1 request types](https://github.com/slackapi/node-slack-sdk/blob/c663dc06c362cffbb11773cc85228eb4f943630c/packages/web-api/src/types/request/agents.ts), [stream request types](https://github.com/slackapi/node-slack-sdk/blob/c663dc06c362cffbb11773cc85228eb4f943630c/packages/web-api/src/types/request/chat.ts), and [Slack Types 3.1 agent events](https://github.com/slackapi/node-slack-sdk/blob/c663dc06c362cffbb11773cc85228eb4f943630c/packages/types/src/events/agent.ts)

## Operator summary

PwrAgent already built the expensive foundation: streamed Thinking Steps, task/plan updates, fallbacks, and legacy working status. The next build should make those threads first-class, titled Slack Agent Sessions and connect Slack's native stop button to PwrAgent's existing authorized interruption path. Agent context can wait for an explicit privacy design, and Slack Code should wait for a public app-side lifecycle and artifact contract.
