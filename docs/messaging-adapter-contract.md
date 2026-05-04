# Messaging Adapter Contract

Adapters translate PwrAgnt semantic messaging intents into a platform-native
surface and translate platform events back into normalized inbound events. They
must not make thread, project, questionnaire, or approval workflow decisions.

## Inputs

The controller sends `MessagingSurfaceIntent` values from
`packages/shared/src/contracts/messaging.ts`.

Adapters should support:

- text messages with plain, light markdown, and markdown policies
- status and progress updates
- thread and project pickers
- single-select, multi-select, questionnaire, approval, and confirmation actions
- error surfaces
- image and file parts when the platform can render them safely
- best-effort dismiss or update when the platform supports it
- attachment capability metadata for provider-owned download and upload limits

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

Adapters own routing and surface state. PwrAgnt may persist and echo
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
- keep scheme-less paths and domain-like text as text, not PwrAgnt-generated
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

Workspace handoff is expressed with the same generic status, single-select,
confirmation, and error intents as other messaging workflows. Adapters should
render its `Handoff`, branch, confirm, back, refresh, and cancel actions like
any other `MessagingSurfaceAction`; provider payloads must remain short opaque
handles. If a platform cannot show every button, text fallback remains the
required escape hatch until PwrAgnt has a generic low-button-count variation
policy.

## Adding A New Adapter

To add Mattermost, Feishu/Lark, Slack, Matrix, or another channel:

1. Implement the desktop adapter shape from
   `apps/desktop/src/main/messaging/messaging-runtime.ts`.
2. Normalize inbound platform events into `MessagingInboundEvent`.
3. Render `MessagingSurfaceIntent` without changing `MessagingController`.
4. Store platform-specific details only in `MessagingAdapterState`.
5. Use short callback handles and resolve them back to semantic actions inside
   the adapter.
6. Add tests for command normalization, authorization by stable ID, callbacks,
   markdown/code rendering, long text chunking, unsupported inbound media, and
   restart-safe binding behavior.
7. Document any capability gaps as adapter degradation, not workflow branches.

If a platform exposes a useful feature that the generic surface cannot express,
extend `packages/shared/src/contracts/messaging.ts` first and keep the new
workflow semantic.
