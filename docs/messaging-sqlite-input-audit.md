# Messaging SQLite Input Audit

Issue: <https://github.com/pwrdrvr/PwrAgent/issues/225>

## Scope

This audit covers SQLite writes that can persist messaging-platform-originated
text from Telegram, Discord, Mattermost, and future messaging providers. The
provider packages do not import SQLite directly; they pass normalized events
through the desktop messaging runtime and the persistence interfaces.

## Surface Enumeration

| Table | Columns / payload fields that can hold platform text | Writer path | Verification |
|---|---|---|---|
| `bindings` | `binding_id`, `channel_kind`, `channel_id`, `thread_id`, and JSON `payload`. Platform text inside the payload includes `channel.conversation.id`, `parentId`, `title`, `parentTitle`, `ancestorTitle`, `authorizedActorIds`, `routingState.opaque`, `displayName`, and surface ids/state. | `SqliteMessagingStore.upsertBinding`, called by `MessagingController.bindChannelToThread`, `refreshBindingFromInbound`, `revokeBinding`, and binding preference/status updates. | `INSERT OR REPLACE ... VALUES (?, ... ?)` with all values passed to `.run(...)`. Reads/deletes bind `bindingId`, `threadId`, and channel kind through `?`. |
| `pending_intents` | `intent_id`, `binding_id`, and JSON `payload`. Platform text can appear in `channel`, `allowedActorIds`, `surface`, action fallback text, and adapter state echoed from a delivery surface. | `SqliteMessagingStore.upsertPendingIntent`, called by `MessagingController.storePendingIntent` and related update paths. | `INSERT OR REPLACE ... VALUES (?, ... ?)` with bound values. Cleanup/find queries bind ids/timestamps. |
| `browse_sessions` | `session_id`, `binding_id`, and JSON `payload`. Platform text can appear in `channel`, `allowedActorIds`, `query`, `selectedProject`, and `surface`. | `SqliteMessagingStore.upsertBrowseSession`, called by resume-browser controller paths. | `INSERT OR REPLACE ... VALUES (?, ... ?)` with bound values. Deletes and TTL cleanup bind ids/timestamps. |
| `callback_handles` | `handle_id`, `session_id`, and JSON `payload`. Platform text can appear in `actionId`, `allowedActorIds`, `channel`, `handle`, `surface`, and opaque `value`. | `SqliteMessagingStore.upsertCallbackHandle`, including provider calls through `MessagingCallbackHandleStore`. | `INSERT OR REPLACE ... VALUES (?, ... ?)` with bound values. Resolve/delete/cleanup queries bind values. |
| `deliveries` | `delivery_id`, `binding_id`, and JSON `payload`. Platform text can appear in provider delivery surface ids/state and error messages. | `SqliteMessagingStore.recordDelivery`, called after desktop messaging deliveries. | `INSERT OR REPLACE ... VALUES (?, ?, ?, ?)` with bound values. |
| `messaging_activity_log` | `platform`, `kind`, `thread_id`, `binding_id`, `conversation_id`, `conversation_title`, `actor_id`, `actor_display_name`, `summary`, and JSON `payload`. | `MessagingActivityLog.record`, called from runtime inbound activity and controller outbound activity. | `INSERT INTO ... VALUES (?, ... ?)` with bound values. List queries bind `sinceId` and `limit`. |

## Interpolation Review

All audited messaging write paths use prepared-statement parameter binding.
The two current interpolated SQL strings are not user-data interpolation:

- `apps/desktop/src/main/state/messaging-store-sqlite.ts:263` builds a
  generated `?, ?, ?` placeholder list for a bounded `IN (...)` delete, then
  binds the actual ids through `.run(...removed)`.
- `apps/desktop/src/main/state/migration.ts:534` checks counts for hardcoded
  migration table names selected from a fixed array.

`pnpm lint:sql` fails on new interpolated SQL template strings in the desktop
main-process messaging/state persistence surface unless the location is
explicitly allowlisted.

## Negative Coverage

Regression tests submit adversarial payloads containing SQL quotes, `UPDATE`,
`DROP TABLE`, an embedded NUL, and oversized text. The tests verify sentinel
SQLite state remains unchanged, the target table survives, and persisted text
round-trips literally.
