# Automation messaging surface verification

This is contributor evidence for the main-process automation path. All checks
use real adapters with injected provider SDK/API seams, normalized-event tests,
the controller delivery path, and the automation action executor. No live
provider account was exercised. Passing these checks does not establish an
account's scopes, bot membership, privacy configuration, delivery permissions,
webhook reachability, or ability to initiate a DM.

## Surface matrix

| Provider | Inbound surfaces | Result destinations | History/replay implementation |
| --- | --- | --- | --- |
| Telegram | Authorized private chats, groups/supergroups, forum topics | Same, including contact IDs as private chats | None; live preview only |
| Discord | Authorized 1:1 DMs; text and announcement channels, and their threads, in authorized servers | Contacts resolve through Create DM; native channels/threads deliver by channel ID | None; live preview only |
| Slack | Authorized 1:1 DMs and DM threads, channels/threads, group DMs when the group-DM access policy permits | Contacts use Slack's user-addressed DM delivery; native conversations retain their IDs | Recent top-level native conversations via `conversations.history`, subject to scopes |
| Mattermost | Authorized 1:1 DMs and replies, authorized group DMs and replies, channels/threads | Contacts resolve through `createDirectChannel`; native conversation IDs deliver directly | None; live preview only |
| Feishu/Lark | Authorized p2p chats and group chats | Contacts use `open_id`; group conversations use `chat_id` | None; live preview only |
| LINE | Authorized user chats, groups, rooms | Push messages to the corresponding user/group/room ID | None; live preview only |

The generic contract represents Slack/Mattermost group DMs and LINE rooms as
`channel`, meaning a shared conversation. They are never inferred from a contact
or treated as 1:1 DMs. Groups require their existing conversation/workspace
allowlists or explicit group-DM policy, as well as the adapter's actor policy.

Discord bots cannot join group DMs; the adapter rejects channel type 3 and the
editor offers no group-DM catalog for Discord. Discord guild IDs are servers,
not destinations. See [Discord OAuth2 documentation](https://docs.discord.com/developers/topics/oauth2).
Because PwrAgent authorizes Discord servers rather than channels, the settings
snapshot has no Discord channel list. The editor lists each authorized server's
text and announcement channels from Discord's API — the same lister Messaging
Settings uses to inspect thread permissions — and reports any server Discord
would not list rather than showing it as empty.

A Discord guild message must come from an authorized server and, before this
change, from a sender on the actor allowlist; everything else was dropped at the
adapter, so a channel automation could never fire for an alert bot. The Discord
adapter now implements the observed-conversation set described in the
[adapter contract](messaging-adapter-contract.md#observed-conversations): in a
channel an enabled automation or an open preview watches, other senders'
messages are forwarded `observedOnly`, and their commands are rejected exactly
as before.

Telegram, Mattermost, Feishu, and LINE dropped the same senders, so a group
automation on them fired only for authorized contacts. All four now implement
the observed set too, and Slack's was changed to match: a command from an
observed sender is rejected and reported rather than silently dropped. Each
adapter suite pins the forwarded case, an unwatched conversation, a command,
and a watched conversation that fails the conversation allowlist.

Two platform settings decide delivery before the adapter runs: Telegram's bot
Group Privacy and Feishu's `im:message.group_msg` permission. Neither produces
an error — the automation just never fires — so the editor says so where a
group trigger is chosen, and the Telegram adapter logs a warning when it can
tell. Mattermost's webhook-attributed posts remain excluded as an anti-echo
defense, so webhook-posted alerts there cannot trigger an automation. See the
[adapter contract](messaging-adapter-contract.md#observed-conversations).
Telegram broadcast `channel_post` updates are not subscribed to by this adapter;
the Telegram catalog therefore lists authorized groups/supergroups, not broadcast
channels. LINE groups and rooms use separate allowlists and preserve their native
IDs; [LINE documents both sources](https://developers.line.biz/en/docs/messaging-api/group-chats/).

## Verified boundaries

- Provider adapter suites exercise inbound authorization and event normalization.
  Added coverage pins unmentioned LINE group/room events and their push targets,
  Mattermost DM/group-DM messages and replies, and Discord bot/self-bot handling.
- All six adapter suites resolve a contact and drive actual `deliver()` code with
  a fake provider API. Discord and Mattermost assert the user-to-conversation API
  boundary; Feishu asserts `open_id`; LINE, Telegram, and Slack assert the final
  API recipient.
- `automation-trigger-matcher.test.ts` covers contact identity across all six
  providers, 1:1 versus shared-conversation collisions, DM thread reply policy,
  Discord guild versus parent-channel identity, and duplicate Telegram topic IDs
  in different groups. Preview uses the same shared identity predicate.
- `messaging-controller.test.ts` verifies that every provider's contact target
  resolves before delivery and a failed resolution never posts to the raw user
  ID. Existing executor tests cover `messaging_target` dispatch and result status.
- The editor tests verify that contacts save as explicit recipient targets for
  all six providers. Existing group/topic selectors keep their native IDs.
- Manual ID entry carries a Channel/Direct message switch on both the trigger
  and the destination. Without it a typed DM ID saved as a channel, which the
  matcher rejects against every real DM on Slack, Mattermost, Feishu and
  Discord — the automation looked enabled and never ran. Telegram and LINE
  reached the same target through the legacy-ID fallback above, so the same
  operator action behaved differently across providers.

The observed set now also includes any conversation an open editor preview is
watching, so a preview shows the senders the automation will see rather than
only those on the actor allowlist.

Ambient Slack group-DM and LINE group/room messages pass authorization and are
marked `observedOnly`. The runtime sends these only to preview and matching
automations, never ordinary bound-thread input. Existing authorization remains
fail-closed. Other authorized bot senders now pass Discord's former blanket bot
drop; PwrAgent's own bot remains suppressed.

## Limits and live verification still needed

Only Slack implements history in the shipped adapters. This is an implementation
limit, not a claim that the other platforms have no history APIs. Contact-based
DM targets and scoped thread/topic targets do not advertise replay because the
current history reader accepts only a native top-level conversation ID. Their
live previews remain available and explicitly state that history is unavailable.
Slack history errors (including missing scopes) remain best-effort empty results.

Provider delivery errors surface as failed output actions. No live account was
used to test Discord channel listing or observed-channel delivery against a real
server (including whether the application has the privileged Message Content
intent enabled in the Developer Portal, which the adapter requests and which
ambient channel text requires), blocked DMs, an unstarted Telegram bot chat, Telegram group privacy, Slack scopes or group-DM
access settings, Feishu tenant permissions/event subscriptions, Mattermost server
permissions, or LINE membership and push eligibility. Native threaded Feishu
messages are not separately normalized by this adapter; the verified Feishu
surface is the chat. Mattermost webhook-attributed posts retain the existing
anti-echo exclusion, and Feishu/LINE bot-to-bot inbound availability is not
established here. These are not covered by the ordinary-user surface matrix.

The change adds no SQLite write call, schema, timer, or background persistence.
Accepted messages and results use the existing automation and messaging stores.
