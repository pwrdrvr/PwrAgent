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

Interactive callbacks should use short opaque platform handles:

- Telegram `callback_data` is byte-limited, so never embed semantic action data.
- Discord component `custom_id` should likewise carry only a compact handle.
- The full pending intent remains in `MessagingStore` with binding, actor, TTL,
  and audit context.

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

When streaming is enabled, adapters should use accumulated text for idempotent
edits and keep any stream-key-to-platform-surface mapping in runtime memory
only. Stream surfaces are transient; completed assistant message delivery
remains the authoritative final response. Partial stream text may contain
unfinished markdown, code fences, or links, so adapters should use conservative
formatting until the final update or final assistant message arrives.

Workspace handoff is expressed with the same generic status, single-select,
confirmation, and error intents as other messaging workflows. Adapters should
render its `Handoff`, branch, confirm, back, refresh, and cancel actions like
any other `MessagingSurfaceAction`; provider payloads must remain short opaque
handles. The earlier "low-button-count variation policy" deferral is now
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
7. Use short callback handles and resolve them back to semantic actions
   inside the adapter.
8. Add tests for command normalization, authorization by stable ID, callbacks,
   markdown/code rendering, long text chunking, unsupported inbound media,
   restart-safe binding behavior, and capability-profile reads in formatting.
9. Document any capability gaps as adapter degradation or as profile fields
   the new platform leaves unset, not as workflow branches.

If a platform exposes a useful feature that the generic surface cannot
express, extend `packages/messaging/interface/src/index.ts` first and keep
the new workflow semantic channel-neutral.
