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
| Discord | Authorized 1:1 DMs, guild channels and threads | Contacts resolve through Create DM; native channels/threads deliver by channel ID | None; live preview only |
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
used to test blocked DMs, an unstarted Telegram bot chat, Slack scopes or group-DM
access settings, Feishu tenant permissions/event subscriptions, Mattermost server
permissions, or LINE membership and push eligibility. Native threaded Feishu
messages are not separately normalized by this adapter; the verified Feishu
surface is the chat. Mattermost webhook-attributed posts retain the existing
anti-echo exclusion, and Feishu/LINE bot-to-bot inbound availability is not
established here. These are not covered by the ordinary-user surface matrix.

The change adds no SQLite write call, schema, timer, or background persistence.
Accepted messages and results use the existing automation and messaging stores.
