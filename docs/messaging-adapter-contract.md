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

## Outputs

Adapters emit `MessagingInboundEvent` values:

- `command` for explicit commands such as `/threads`
- `text` for ordinary user text
- `callback` for button/component/select interactions
- `media` with `disposition: "unsupported"` for inbound media until a separate
  ingestion policy exists
- `lifecycle` for adapter start/stop/bind events when useful

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
- avoid broad mentions by default
- render buttons/components/selects when available
- include text fallback for every interactive surface
- post a fresh message when update or dismiss is unsupported

Telegram currently uses Bot API long polling, HTML-safe text, inline keyboards,
and `sendPhoto` for image URLs. Discord uses Gateway events, REST message
delivery, defensive `allowed_mentions`, components, and image embeds.

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
