# Messaging Platform Integration

PwrAgnt can run messaging adapters from the Electron main process so an
allowlisted Telegram or Discord user can choose a thread, bind the current
conversation, and send free-form text into that thread. The workflow logic is
shared; Telegram and Discord only own transport, formatting, callback handles,
and platform limits.

## Configuration

Messaging is disabled unless a channel has both credentials and authorized actor
IDs. Use stable platform user IDs, not usernames, display names, or guild
nicknames.

Telegram:

- `PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN`
- `PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS`

Discord:

- `PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN`
- `PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID`
- `PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS`
- `PWRAGNT_MESSAGING_DISCORD_MESSAGE_CONTENT_INTENT`

The authorized ID variables are comma-separated lists. Bot tokens are redacted
from runtime logs. Telegram also accepts `TELEGRAM_BOT_TOKEN` and Discord also
accepts `DISCORD_BOT_TOKEN` as local migration fallbacks.

## Security Model

- Authorization is by immutable platform user ID.
- Usernames, display names, and guild nicknames are metadata only.
- A conversation must be bound to a thread before ordinary text is routed.
- Bindings, pending intents, and delivery records live in
  `messaging-state.json` under the desktop state root.
- Inbound media is not downloaded or forwarded into agent turns in this MVP.
- Telegram callback data and Discord component IDs contain short opaque handles,
  not thread IDs, request payloads, tokens, or callback secrets.
- Discord deliveries use defensive `allowed_mentions` so agent output does not
  ping everyone, roles, or arbitrary users.

To revoke stale bindings today, stop the app and remove the relevant binding
from the state-root `messaging-state.json`. A first-class revoke command should
be added before broader rollout.

## Manual Smoke Checklist

Run the desktop app with the desired environment variables configured.

Telegram:

1. Confirm no Telegram webhook is configured for the bot.
2. Send `/threads` from an allowlisted Telegram user.
3. Verify a numbered thread picker appears with inline buttons.
4. Choose a thread by button, then repeat by replying `1`.
5. Send free-form text and verify a PwrAgnt turn starts in the bound thread.
6. Trigger a Plan questionnaire and answer with both a button and text fallback.
7. Trigger an approval request and test accept, session accept, decline, and cancel.
8. Verify markdown, inline code, fenced code, long responses, and image output render.
9. Restart PwrAgnt and verify the same Telegram conversation still routes to the bound thread.
10. Send a file or voice message and verify it is rejected without download.

Discord:

1. Confirm the bot has Gateway access and message content intent enabled.
2. Send `/threads` from an allowlisted Discord user.
3. Verify a numbered thread picker appears with components.
4. Choose a thread by component, then repeat by replying `1`.
5. Send free-form text and verify a PwrAgnt turn starts in the bound thread.
6. Trigger a Plan questionnaire and answer with both a component and text fallback.
7. Trigger an approval request and test accept, session accept, decline, and cancel.
8. Verify markdown, inline code, fenced code, long responses, and image output render.
9. Restart PwrAgnt and verify the same Discord channel still routes to the bound thread.
10. Send an attachment and verify it is rejected without download.

## Chat SDK Decision

Vercel Chat SDK is not the runtime boundary for this MVP. The current direction
is a PwrAgnt-owned semantic surface with direct adapters because markdown,
image/media behavior, callback limits, and voice-friendly text fallback are core
requirements. Chat SDK can be reconsidered later as an adapter implementation
detail if it matures without changing PwrAgnt workflow logic.

## Related Docs

- [Messaging Adapter Contract](messaging-adapter-contract.md)
- [Messaging Requirements](brainstorms/2026-04-30-messaging-platform-integration-requirements.md)
- [Implementation Plan](plans/2026-04-30-001-feat-messaging-platform-integration-plan.md)
