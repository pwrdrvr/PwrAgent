# Messaging Adapter Contract

Adapters translate PwrAgent semantic messaging intents into a platform-native
surface and translate platform events back into normalized inbound events. They
must not make thread, project, questionnaire, or approval workflow decisions.

For an architecture overview (layered diagram, data flow, capability-profile
explanation, file map) see [`docs/messaging-architecture.md`](messaging-architecture.md).

## Inputs

The controller sends `MessagingSurfaceIntent` values from
`packages/messaging/interface/src/index.ts` (the canonical home for messaging
types). Adapters import them via `@pwragent/messaging-interface`.

Adapters should support:

- text messages with plain, light markdown, and markdown policies
- status and progress updates
- thread and project pickers
- single-select, multi-select, questionnaire, approval, and confirmation actions
- error surfaces
- image and file parts when the platform can render them safely
- best-effort dismiss or update when the platform supports it
- attachment capability metadata for provider-owned download and upload limits
- optional assistant response stream updates

## Outputs

Adapters emit `MessagingInboundEvent` values:

- `command` for explicit commands such as `/threads`
- `text` for ordinary user text
- `callback` for button/component/select interactions
- `media` with generic attachment descriptors for provider media/files
- `lifecycle` for adapter start/stop/bind events when useful

Media events may include message text plus one or more attachments. Adapter
fields such as Telegram file IDs or Discord CDN URLs must stay inside opaque
attachment state; the controller decides whether to download, classify,
normalize, extract, or reject the attachment after authorization and binding
checks pass.

Adapters emit inbound text and media immediately. They must not debounce,
merge, queue, steer, or start turns themselves. Desktop messaging core owns the
turn admission policy that coalesces split input, prevents overlapping
`turn/start` calls, queues follow-ups during active turns, and maps queued
input to `turn/steer` or a later `turn/start`.

The `actor.platformUserId` must be the stable platform ID used for
authorization. Mutable usernames and display names may be included for audit or
operator visibility only.

## Opaque State

Adapters own routing and surface state. PwrAgent may persist and echo
`MessagingAdapterState`, but workflow code must not parse it. Platform message
IDs, interaction tokens, thread IDs, callback payloads, and permission details
belong inside adapter-owned opaque state.

Interactive callbacks should use compact opaque platform handles backed by
long-lived sqlite records:

- Telegram `callback_data` is byte-limited, so never embed semantic action data.
- Discord component `custom_id` should likewise carry only a compact handle.
- Slack button `value` and Mattermost `integration.context` should carry or wrap
  the same opaque handle, plus any provider authenticity/routing breadcrumbs.
- The handle record should outlive pinned/status surfaces and app restarts. Use
  the shared callback-handle TTL policy rather than provider-local 15-minute
  timers. The domain record a button points at, such as a pending approval or
  browse session, may expire separately and should fail closed after the handle
  resolves.
- Callback handle records are scoped per delivery. Persist the delivered
  conversation, the full `allowedActorIds` set, and
  `intent.audit?.bindingId ?? intent.bindingId`; a single intent/action may be
  delivered to multiple bindings with the same platform handle.

## Rendering Policy

Adapters own platform limits and degradation:

- chunk long messages according to platform limits
- preserve inline code and fenced code when supported
- escape or neutralize markdown dialect hazards
- keep scheme-less paths and domain-like text as text, not PwrAgent-generated
  HTTP links or platform anchor markup
- avoid broad mentions by default
- render buttons/components/selects when available
- include text fallback for every interactive surface
- post a fresh message when update or dismiss is unsupported

Adapters may render explicit links only when the source intent carries explicit
link syntax or a future structured link part. Platform clients may still apply
native autolinking to plain text; neutralize that only with a provider-specific
policy and tests for the concrete platform behavior.

Telegram currently uses Bot API long polling, HTML-safe text, inline keyboards,
`sendPhoto` for image URLs/data images, and `sendDocument` for generic file
parts. Discord uses Gateway events, REST message delivery, defensive
`allowed_mentions`, components, image embeds for remote URLs, and multipart
uploads for byte-backed file/image parts.

## Attachment Policy

Providers expose metadata and transport:

- inbound attachment descriptors with name, MIME hint, size hint, dimensions
  where available, disposition, and opaque download state
- a download method that resolves opaque state into bounded bytes
- capability hints for inbound download and outbound file/image upload limits

Desktop messaging core owns ingestion policy. It enforces attachment count and
byte caps, sniffs content instead of trusting MIME alone, converts supported
text-like files into bounded text input, normalizes images/GIF stills into
model-safe JPEG/PNG data URLs, and returns user-visible rejection reasons for
unsupported or oversized files. Downloaded bytes and extracted file contents are
not persisted in messaging state.

## Typing Activity

`activity: "typing"` is a semantic lease signal from the messaging controller.
Adapters should start or refresh the platform typing indicator when
`state: "active"` arrives, stop the platform indicator when `state: "idle"`
arrives, and let the lease expire as a fallback if no idle signal is delivered.

Adapters must not infer agent lifecycle from message content. Assistant message
delivery can happen while a turn is still working, and pending user-input
surfaces can happen while a turn is paused for the user. The controller owns
those lifecycle decisions and translates them into active or idle activity
intents.

## Streaming Responses

`stream_update` is a semantic assistant response update. It carries a stable
stream key, accumulated assistant text, optional raw delta text, a monotonic
sequence number, and an `isFinal` flag. The controller owns backend protocol
translation and buffering; adapters must not inspect app-server event names such
as `item/agentMessage/delta`.

Streaming is optional. An adapter may return a benign `discarded` delivery
result when the provider does not support streaming, provider settings disable
streaming, a binding policy disables streaming, or platform limits make the
current update unsafe to edit. Discarding a stream update is not a delivery
failure and must not be treated as evidence that the conversation target is
invalid.

Streaming is an advanced capability, not the normal progress-notification path.
It repeatedly edits the same provider message with partial assistant text. That
can consume the same write budget needed for final answers, approvals, and
status replies, and voice readers that announce messages when first received may
not observe later edits. Providers should honor binding policy as:

- `disabled`: discard stream updates.
- `enabled`: allow stream updates even when the provider-global setting is off.
- `inherit`: follow the provider-global setting.

When streaming is enabled, adapters should use accumulated text for idempotent
edits and keep any stream-key-to-platform-surface mapping in runtime memory
only. Stream surfaces are transient; completed assistant message delivery
remains the authoritative final response. Partial stream text may contain
unfinished markdown, code fences, or links, so adapters should use conservative
formatting until the final update or final assistant message arrives.

## Rate-Limit and Reconnect Health

Adapters may expose `resolveDeliveryScope(intent)`, `onRateLimit(listener)`,
and `onReconnect(listener)` to the desktop runtime. Scope metadata must be
provider-neutral: platform, stable scope id, kind, optional label, optional
provider bucket id, and conservative write budget hints. Do not leak provider
SDK error objects through these hooks.

Outbound rate-limit retries are owned by the desktop delivery budget, not by
provider SDKs. Adapters that use SDKs with built-in 429 queues must configure
those SDKs to reject/surface rate-limit responses before constructing the
adapter. Set `clientRateLimitStrategy` to `externalized` when the SDK has been
configured this way, `direct` when calls go straight to the platform without a
hidden retry queue, or `sdk-managed` only as a temporary diagnostic state. Do
not ship a new provider with `sdk-managed`; fix or wrap the client first.

The controller budgets all outbound intent kinds against the resolved scope:
final assistant messages, user prompts, command replies, status updates, tool
updates, and stream updates. Slow Mode is local: it starts when the shared
budget for a scope is exhausted or close enough that reserved capacity must be
protected. Provider 429 feedback starts a Cool Off window instead: the
controller sends nothing to that scope until the provider retry window clears.
In Slow Mode, obsolete low-priority traffic such as non-final stream updates,
routine status edits, and intermediate tool progress can be dropped; final turn
results and interactive prompts are reserved and deferred when possible.

If a send attempt is rejected with a rate-limit error, `deliver()` should return
a failed `MessagingDeliveryResult` with structured `rateLimit` metadata. Set
`rateLimit.retryable: true` only when replaying the same intent cannot duplicate
visible platform side effects from the failed attempt. The controller always
records the cooldown. It only re-runs admission for retryable attempts; partial
successes are recorded as failed delivery attempts so they do not duplicate
already visible messages or attachments.

The runtime reports a platform as `degraded` while a rate-limit or reconnect
reason is active. `degraded` means connected but constrained. Fatal startup or
runtime failures still report `errored`.

Workspace handoff is expressed with the same generic status, single-select,
confirmation, and error intents as other messaging workflows. Adapters should
render its `Handoff`, branch, confirm, back, refresh, and cancel actions like
any other `MessagingSurfaceAction`; provider payloads must remain compact
opaque handles. The earlier "low-button-count variation policy" deferral is now
implemented via the capability profile (see below) — producers truncate by
priority and adapters apply defensive caps from their own profile.

## Capability Profile

Each adapter declares a `MessagingCapabilityProfile` literal at the top of its
provider class. The profile describes what the platform supports across four
dimensions:

- **actions** — interactive button limits: `maxActions`, `maxActionsPerRow`,
  `maxRows`, `maxLabelLength`, plus support flags for styles, disabled buttons,
  and explicit layout hints. Omit `actions` entirely for a text-only provider
  (e.g., a future Signal adapter); producers will fall back to text rendering.
- **text** — message-body limits: `maxLength`, `encoding` (utf8-bytes,
  utf16-units, characters), `markdownDialect`, formatting feature flags,
  `supportsMessageEdit`.
- **inboundAttachments** — what we accept from the user (size caps, count
  caps, download support).
- **outboundAttachments** — what we can deliver to the user (file upload size,
  image upload, remote URL support). Reserved for the forthcoming Plan/Review
  surface delivery (see the plan-review attachment delivery plan in
  `docs/plans/`).

Existing examples in the tree:

- `packages/messaging/providers/discord/src/discord-adapter.ts` — Discord
  profile (25 actions, 5×5 grid, 80-char labels, discord-markdown dialect).
- `packages/messaging/providers/telegram/src/telegram-adapter.ts` — Telegram
  profile (100 actions, 8 per row, 64-char labels, HTML dialect).

The controller reads the adapter's profile once at construction and threads it
to every producer. Producers call
`applyActionCapabilityLimits(actions, profile)` to (a) drop lowest-priority
actions when the count exceeds the profile's `maxActions` and (b) truncate
labels longer than `maxLabelLength`. `MessagingSurfaceAction.priority` orders
the list — **lower numbers are higher priority**, items without explicit
priority drop first.

Adapter formatting code reads the same profile to apply defensive caps as a
safety net (e.g., `actions.slice(0, profile.actions.maxActions)`). If the
producer respected the profile, those slices are no-ops; if a producer
misbehaves, the adapter clips it before the platform rejects the request.

The page-size helper `capabilityProfilePageSize(profile, navActionCount,
maxPageSize?)` computes how many items can fit on a paginated picker after
reserving slots for nav buttons. The resume browser and handoff branch picker
both use it.

Profile design rule: the profile is the single source of truth for
cross-boundary numbers (max actions, max label length, max columns/rows).
Constants that live entirely inside an adapter's own formatting code — body
length used for chunking, callback-payload byte budget used for handle
encoding — stay as adapter-local constants. The profile is for things
producers need to know.

A permissive profile for tests (`PERMISSIVE_CAPABILITY_PROFILE`) is exported
from the dedicated `@pwragent/messaging-interface/testing` subpath. Production
code must never import it — every adapter must declare a real profile.

## Credential Validation

Every messaging provider MUST export a top-level
`validateCredentials(config)` function from its package barrel
(`packages/messaging/providers/<channel>/src/index.ts`). The desktop
Settings → Connection-test affordance dispatches to this function via
dynamic import keyed on `MessagingChannelKind`, so the orchestration
layer stays channel-neutral and provider SDKs stay isolated to their
own package.

**Signature:**

```ts
import type {
  MessagingCredentialValidationResult,
  // Plus a per-channel `*CredentialValidationConfig` type from the interface
  // package — e.g. `TelegramCredentialValidationConfig`. Add a new one to
  // the interface package when you onboard a new platform.
} from "@pwragent/messaging-interface";

export async function validateCredentials(
  config: TelegramCredentialValidationConfig,
): Promise<MessagingCredentialValidationResult>;
```

**Required properties:**

1. **Non-disruptive.** No polling started, no gateway connected, no
   webhook registered, no message sent. The probe MUST be a stateless
   REST call (or equivalent) using the provider's real SDK.
   - Telegram uses `grammy.Bot.api.getMe()`.
   - Discord uses `discord.js.REST.get(Routes.user("@me"))`.
   - Future platforms should pick the cheapest "who am I" endpoint
     their SDK exposes.
2. **Stateless.** Don't construct the full adapter. Don't touch the
   store. Don't subscribe to events. Don't write logs at info level.
3. **Result carries only public identity.** `account` is a username,
   bot handle, or similar — never the credential. `errorMessage` is
   clipped to ≤ 240 characters via `clipMessagingValidationError` from
   the interface package, so the renderer never surfaces a giant
   stack.
4. **Returns `unset` when config is empty.** The dispatch layer
   normally short-circuits before reaching the provider when there's
   no credential, but providers MUST return `{ status: "unset", … }`
   defensively if their config arrives without the required field.
5. **Measures its own duration.** `durationMs` is the round-trip the
   provider observed, not a runtime-side estimate.

**Lazy loading:** the desktop runtime dynamically imports
`@pwragent/messaging-provider-<channel>` on first invocation and Node
caches the module thereafter. The provider package is NOT loaded on
boot — only on the first Test click for that channel (or whenever the
provider's full adapter would otherwise be loaded by the runtime).

**Boundary:** the provider's `validateCredentials` may import
`@pwragent/messaging-interface` and its own SDK. It must NOT import
anything from `apps/desktop`, `packages/messaging/providers/*`
siblings, or `@pwragent/shared`.

See `packages/messaging/providers/telegram/src/validate-credentials.ts`
and `packages/messaging/providers/discord/src/validate-credentials.ts`
for canonical implementations.

## Adding A New Adapter

To add Mattermost, Feishu/Lark, Slack, Matrix, or another channel:

1. Create `packages/messaging/providers/<channel>/` with its own
   `package.json` and `tsconfig.json`. Depend only on
   `@pwragent/messaging-interface` and the channel's SDK.
2. Implement the desktop adapter shape from
   `apps/desktop/src/main/messaging/messaging-runtime.ts`
   (`DesktopMessagingAdapter`).
3. Declare a `capabilityProfile: MessagingCapabilityProfile` literal at the
   top of the adapter class with real numbers from the platform's docs.
4. Normalize inbound platform events into `MessagingInboundEvent`.
5. Render `MessagingSurfaceIntent` without changing `MessagingController`.
   Apply defensive caps from the adapter's own `capabilityProfile`.
6. Store platform-specific details only in `MessagingAdapterState`.
7. Use compact opaque callback handles and resolve them back to semantic actions
   inside the adapter. Persist delivery-scoped callback records with the full
   actor set and routed binding id so restart, fan-out, and rebind cleanup paths
   behave consistently.
8. **Implement `validateCredentials` per the contract above.** Add a
   `<Channel>CredentialValidationConfig` type to
   `packages/messaging/interface/src/index.ts` and extend
   `CredentialValidationRequest` in
   `apps/desktop/src/main/messaging/messaging-runtime.ts`.
9. Add tests for command normalization, authorization by stable ID, callbacks,
   markdown/code rendering, long text chunking, unsupported inbound media,
   restart-safe binding behavior, callback fan-out/rebind persistence,
   capability-profile reads in formatting, AND the `validateCredentials` ok /
   failed / unset paths.
10. Document any capability gaps as adapter degradation or as profile fields
    the new platform leaves unset, not as workflow branches.

If a platform exposes a useful feature that the generic surface cannot
express, extend `packages/messaging/interface/src/index.ts` first and keep
the new workflow semantic channel-neutral.
