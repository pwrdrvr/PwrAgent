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
- optional managed-conversation operations such as creating, closing, reopening,
  deleting, or probing rights for topic-like child conversations

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

Adapters must not drop all bot-authored messages by default. They should only
suppress messages from the PwrAgent bot identity itself, then emit other
authorized bot messages as ordinary `text` or `media` events with
`actor.isBot = true`. Desktop automation triggers use that distinction to match
provider alerts such as Slack posts from monitoring bots without looping on
PwrAgent's own replies.

## Lifecycle

`stop()` is valid as soon as `start()` has been invoked, not only after the
adapter reports a fully started state. It must close or detach every resource
created by a partial start, including callback servers, SDK listeners,
websockets, gateway clients, and polling loops. A stop that arrives during an
awaited identity or connection step must also prevent later startup steps from
opening new external resources.

Startup cleanup is idempotent. The desktop runtime may call `stop()` once when
cancellation or a deadline wins and again after the original `start()` promise
settles, whether that promise resolves or rejects. Providers must therefore not
gate cleanup solely on a final `started` flag, and repeated cleanup must not
leave listeners or connections behind.

## Opaque State

Adapters own routing and surface state. PwrAgent may persist and echo
`MessagingAdapterState`, but workflow code must not parse it. Platform message
IDs, interaction tokens, thread IDs, callback payloads, and permission details
belong inside adapter-owned opaque state.

Managed-conversation operations follow the same rule. A controller may request
"create a child conversation under this channel" or "close this topic-like
conversation" using `MessagingChannelRef` plus opaque routing state, but only
the adapter may parse Telegram chat IDs, forum topic IDs, Discord thread IDs, or
provider permission payloads. Unsupported providers should omit the optional
methods so workflow code can render an unavailable capability instead of
branching on platform names.

Interactive callbacks should use compact opaque platform handles backed by
long-lived sqlite records:

- When the callback payload identifies the message containing the clicked
  control, adapters should set `MessagingInboundCallbackEvent.sourceSurface`
  to that editable message. Keep it separate from `interaction`, which
  identifies the callback handle or interaction rather than the message.
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

### Working cards

`working_card` is a channel-neutral, turn-scoped Working Updates surface. The
controller owns the dial policy and emits only admitted, redacted tasks with a
stable `key` and monotonic `sequence`. Adapters must discard stale sequences.
Slack renders the intent with Thinking Steps (`chat.startStream`,
`chat.appendStream`, and `chat.stopStream`) when a thread target is available;
stream state stays in memory. Slack Live Working Updates cards are opt-in through
`messaging.slack.live_working_cards`; an absent setting currently means off and
must remain absent during unrelated config writes so a future default change
can apply to untouched profiles. If native streaming is disabled or
unavailable, the adapter delivers `fallbackText` as the existing Working
Update using the intent's `fallbackPresentation` role and Markdown policy.
Providers without a native live-card surface continue to use that text
fallback. Terminal fallback intents are no-ops and must not consume or wait on
ordinary message-delivery capacity.

Provider-native live surfaces may have API budgets orthogonal to ordinary
message delivery. Adapters may use `MessagingRateLimitGate` to account for
multiple workspace/method buckets independently. Slack maintains ordered
per-card lifecycle state over workspace-wide `chat.startStream`,
`chat.appendStream`, and `chat.stopStream` buckets. Start is a barrier and
terminal stop remains queued until admitted. Intermediate appends are
disposable: when their local bucket or Slack 429 cool-off blocks them, the
adapter drops them without a timer or text fallback. A later admitted update
reconciles directly to the newest controller-bounded snapshot. This prevents a
multi-thread append backlog while keeping start/stop lifecycle ordering. These
card lanes must not block approval, questionnaire, final-answer, or other
ordinary message delivery. A platform 429 extends only the affected method
bucket from `Retry-After`; it is not permission to discard a terminal stop.

An open native card replaces classic tool-update posts for those activities.
Task titles use the already-redacted activity title, while duration and other
secondary context belong in task details; both fields must be clamped to
provider limits and must never add raw command output or secrets. Because Slack
has no cancelled task status, cancelled tasks close neutrally with cancellation
called out in their details instead of rendering as errors. Waiting phases add
a visible stream headline and waiting and terminal phases clear transient
working indicators; the final assistant message remains authoritative.
Slack renderers reuse a bounded set of positional task IDs so controller
history eviction replaces mounted rows instead of growing the native card.
Adapters return a retractable surface as soon as a native card is queued so
turn cancellation and terminal private-response routing can cancel pending
work or remove an already-mounted card. Completed keys retain a bounded
sequence tombstone so delayed events cannot reopen a terminal card.

- chunk long messages according to platform limits
- preserve inline code and fenced code when supported
- escape or neutralize markdown dialect hazards
- keep scheme-less paths and domain-like text as text, not PwrAgent-generated
  HTTP links or platform anchor markup
- avoid broad mentions by default
- render buttons/components/selects when available
- include text fallback for every interactive surface
- post a fresh message when update or dismiss is unsupported
- honor source-relative delivery hints when the provider can identify the
  source message's channel/thread from opaque routing state

Adapters may render explicit links only when the source intent carries explicit
link syntax or a future structured link part. Platform clients may still apply
native autolinking to plain text; neutralize that only with a provider-specific
policy and tests for the concrete platform behavior.

`MessagingMessageIntent.attribution` carries optional source identity and
secondary delivery context for responses routed away from their bound
conversation. Providers should render it as restrained secondary context, such
as a Slack Block Kit context block. Producers omit it for routine replies when
the destination already identifies the bound thread. For bound Agent threads,
desktop orchestration uses normalized Agent metadata only; for ordinary bound
threads it uses the normalized thread title unless its title source is
`fallback`, then uses `PwrAgent thread`. A missing Agent name must not be
inferred from a derived thread title, prompt text, or `AGENTS.md` content.

Telegram currently uses Bot API long polling, HTML-safe text, inline keyboards,
`sendPhoto` for image URLs/data images, and `sendDocument` for generic file
parts. Discord uses Gateway events, REST message delivery, defensive
`allowed_mentions`, components, image embeds for remote URLs, and multipart
uploads for byte-backed file/image parts.

`delivery.sourceRelative = "source_thread"` means "reply where the source
message can continue the same platform thread." `source_channel` means "post to
the source channel without a thread target." Providers that support an explicit
thread-reply broadcast flag, such as Slack's `reply_broadcast`, should map
`delivery.broadcastThreadReply` to the platform-native option. Unsupported
providers may fall back to a normal fresh message or return a structured
unsupported delivery result.

## Private Terminal Responses

An adapter may implement `resolvePrivateConversation` when the platform can
start or recover a 1:1 conversation with the actor who initiated an inbound
turn. The request carries only the normalized actor, source conversation, and
opaque provider routing state. The result returns a normalized `dm`
conversation plus opaque routing state for ordinary `deliver(intent)` handling;
desktop orchestration must not parse provider user IDs or DM channel IDs.

This resolver is used by the scoped Agent `send_private_response` tool. The
tool can address only the actor recorded for its active messaging turn, and the
controller suppresses the normal source-conversation final response only after
the private delivery succeeds. Resolver and delivery failure leave source
delivery unchanged. Adapters must revalidate the actor identifier at this
boundary and reject bot actors or unsupported conversation types explicitly.

Codex dynamic tool catalogs are fixed when a thread starts. For older threads
whose catalog predates `send_private_response`, an explicit natural-language
private-response request (for example, "DM me") activates a controller-owned
compatibility path: source prose and working updates are suppressed, and the
turn's final answer is delivered to the recorded actor through the same private
resolver. If that fallback delivery fails, the private content remains withheld
and the source receives only a generic delivery error.

Before reporting private-delivery success, the controller cancels queued and
in-flight source streams, prose, and tool updates. Adapters may still complete a
delivery after cancellation, so any late surface returned by `deliver` must be
retracted through `dismissSurface`; private success is withheld when an existing
source surface cannot be dismissed.

Slack resolves the requesting user ID as the initial direct-message target;
`chat.postMessage` opens the bot's 1:1 conversation when needed and returns the
durable `D...` conversation ID in its delivery result. This uses the existing
`chat:write` scope and does not require core workflow code to persist or inspect
Slack-specific identifiers.

When a provider can identify the native conversation where replies to a newly
delivered surface will arrive, it should populate
`MessagingDeliveryResult.continuation`. The continuation contains a normalized
channel plus opaque routing state; workflow code may persist it as an ordinary
binding but must not recover it by parsing the delivered surface state. Slack
uses this to bind the private message's `D...` channel and root timestamp back
to the originating Agent. Replies in that message's native thread therefore
survive restarts and route deterministically, while a top-level DM remains
available to the configured default Agent.

That continuation is an implicit, on-demand-status binding. Starting a turn
from its replies must not insert the full binding status card into the private
conversation. An explicit status command may create the card, after which
ordinary refreshes may update it.

When `send_private_response` requests a reply, the continuation additionally
stores a bounded, expiring one-shot return route and Agent-authored completion
instructions. The first private-thread reply starts the originating Agent with
those instructions, suppresses non-final source updates, delivers the final
answer through the original source binding, and atomically consumes the
continuation when that first reply is admitted. Providers do not implement
this workflow and still see only normalized continuation and delivery requests.

Providers set `conversation.isDirectMessage` on both a 1:1 DM and any native
thread nested inside it. This preserves DM authorization and ambient-reply
semantics after normalization changes the child conversation's `kind` to
`thread`; shared-channel allowlists and mention-only policies must not be
applied to those private thread replies.

## Attachment Policy

Providers expose metadata and transport:

- inbound attachment descriptors with name, MIME hint, size hint, dimensions
  where available, disposition, and opaque download state
- a download method that resolves opaque state into bounded bytes
- capability hints for inbound download and outbound file/image upload limits

Desktop messaging core owns ingestion policy. It enforces attachment count and
byte caps, sniffs content instead of trusting MIME alone, converts supported
text-like files into bounded text input, passes PDFs through as native file
input, normalizes images/GIF stills into model-safe JPEG/PNG data URLs, and
returns user-visible rejection reasons for unsupported or oversized files.
Downloaded bytes and extracted file contents are not persisted in messaging
state.

After authorization and shared-conversation response-mode checks, inbound media
uses the same routing hierarchy as accepted text: an active binding first, then
the effective default Agent, and only then the unbound conversation picker. A
child thread or topic can inherit the exact conversation default configured on
its normalized parent channel, after any exact-child or explicit-parent
assignment. Providers must therefore preserve mention state and normalized
`parentConversationId` metadata on media events just as they do on text events.

For outbound final responses, desktop messaging core resolves structured
assistant image parts and local Markdown image links before constructing the
provider intent. Local files and signed loopback media are copied into the
profile-owned transcript image cache and emitted as bounded data-image parts;
ordinary HTTPS images remain remote-image parts. Providers consume only those
generic parts and apply their declared capabilities. Telegram, Discord, Slack,
Mattermost, and Feishu upload local image data. LINE can render HTTPS image
parts but cannot accept local bytes, so local-only images degrade to the text
response on LINE.

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

## Transient Transcript Messages

Transient transcript messages are local, replaceable desktop UI state. A
desktop renderer may freeze completed segments in transcript order so live
commentary remains visible between tool invocations, but those segments remain
bounded, in-memory, and separate from durable replay entries. They are evicted
before durable transcript state and discarded on reload, compaction, or cache
eviction.

Transient messages are not assistant response streams and are not part of the
generic messaging surface contract. The messaging controller must discard
transient transcript updates at the backend-event boundary without converting
them into `message`, `stream_update`, status, progress, or typing intents.

This keeps transient text out of provider queues, delivery retries, rate
budgets, pending-intent persistence, conversation history, and outbound
activity records. Final assistant messages remain authoritative.

If a future product explicitly opts a messaging surface into transient content,
extend the generic interface with a distinct replace-only intent. It must be
memory-only, non-queueable, non-retryable, and lower priority than
`stream_partial`; it must never fall back to a durable `message`.

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
  image upload, remote URL support). Plan/Review artifact producers read this
  to choose between inline-only text and inline preview plus Markdown
  attachment.

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
