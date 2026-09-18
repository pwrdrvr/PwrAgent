# UX review — automation messaging surfaces

Scope: the operator-facing surfaces of
[PR #2196](https://github.com/pwrdrvr/PwrAgent/pull/2196), which made every
messaging provider and every non-channel surface (DMs, group DMs, LINE rooms)
usable as an automation trigger and as a result destination.

The plumbing this PR added is sound and its evidence document,
[automation-messaging-surfaces.md](../automation-messaging-surfaces.md), is
unusually honest about its own limits. This review is about the half the
handoff deliberately deferred: whether an operator can now *tell* what the
plumbing will do.

Mockups for every finding below:
[`automation-surfaces-v1/`](automation-surfaces-v1/).

## Status

| # | Finding | Status |
| --- | --- | --- |
| 1 | `dm:` sentinel in the picker's ID column | Fixed on this branch |
| 2 | Manual entry cannot express a DM | Fixed on this branch |
| 3 | Replay blames the provider for a scope limit | Fixed on this branch |
| 4 | Discarded Telegram destination topic field | Fixed on this branch |
| 5 | Discord offers no channels at all | Fixed on this branch |
| 6 | Three providers have no manual-entry guidance | Fixed on this branch |
| 7 | The pipeline caption describes a room | Fixed on this branch |
| 8 | Preview copy, and a limit stated too late | Fixed on this branch |
| 9 | Smaller items | Fixed, one withdrawn |
| 10 | A new destination saved to a disabled provider | Fixed on this branch |
| 11 | Four providers drop every sender outside the allowlist | Open |

Finding 5 turned out to be structural, not copy — see its section. Findings 10
and 11 came out of fixing it.

## Overall

The feature reads as finished from the main process outward and unfinished from
the operator inward. DMs became selectable, but the vocabulary around them did
not change: the fields are still called channels, the manual escape hatch can
still only build a channel, the pipeline caption still describes a room, and two
empty states now describe a constraint that moved. The result is a form that
will let an operator build a trigger that never fires, on four of six providers,
without a word of feedback — the exact failure mode the handoff set out to
eliminate.

The first draft of this review said nothing here was a plumbing defect. Two
were: Discord had no channel list to offer (finding 5), and four other providers
drop the senders a channel automation mostly exists to watch (finding 11).
Everything else is a label, a guard, or a sentence.

## Findings

### 1. The `dm:` sentinel reaches the operator-facing ID column — critical, fixed

`readProviderGroups` encodes contacts as `` `dm:${contact.id}` `` so the editor
can tell a contact from a conversation
([AutomationEditor.tsx:3183](../../apps/desktop/src/renderer/src/features/automations/AutomationEditor.tsx)).
`conversationOptions` then derives the picker's `detail` from that same value,
so the mono right-hand column prints `dm:U03QW7ELB19`.

That column is the picker's entire reason for existing — its own docstring says
two destinations that share a name "are told apart by that ID column, which is
what the native `<select>` it replaced could not do". A fabricated ID cannot do
that job: it exists nowhere on Slack, and it is also what the search box matches
against. A contact with no display name is worse still — `title` falls back to
the raw ID while `detail` shows the prefixed one, so the row prints the same
identifier twice, spelled two ways.

Fixed: `conversationOptions` strips the marker through one `contactUserId`
helper and gives `detail` the platform ID, dropping the column entirely when it
would repeat the label. The DM-ness is already carried by `kind`, which is what
drives the glyph and the section.

### 2. Manual entry cannot express a DM, and silently saves an inert trigger — critical, fixed

`buildDestinationSnapshot` only produces a DM when the value carries the `dm:`
prefix, which only the picker can produce. Anything typed into the manual field
saves `conversationKind: "channel"`.

Verified against the shipped matcher: for Slack, Mattermost, Feishu and Discord,
a `channel`-kind target is rejected against a real DM
(`matchesAutomationConversation` — `if (expectedKind === "channel" && isDm) return false`).
Telegram and LINE accidentally succeed, because the legacy-ID heuristic added in
this PR recognises a raw user ID and reclassifies it. So the same operator
action succeeds on two providers and fails silently on four, and the UI reports
nothing in either case.

The Slack hint makes this actively likely: it says to "open the channel details
and copy the ID at the bottom", which in a DM yields the `D…` conversation ID.

Fixed: a Channel / Direct message switch on both manual paths, writing the same
`dm:` form the picker produces so nothing downstream learns a second encoding.
The label, placeholder and hint follow the switch, and the DM hint asks for the
sender's user ID — which is what `matchesAutomationConversation` compares —
while naming the conversation ID it is not. Switching the kind re-encodes what
is already typed rather than clearing it.

### 3. The replay empty state blames the provider for a scope limit — critical, fixed

`listReplayCandidates` gained two refusals in this PR: a trigger carrying
`recipientUserId` or `parentId`
([desktop-automation-service.ts:670](../../apps/desktop/src/main/automations/desktop-automation-service.ts)).
`AutomationsScreen` still renders the one sentence written when the provider was
the only refusal: *"This provider can't serve conversation history."*

For a Slack DM trigger that is false. Slack serves history; the same automation
would offer replay if its trigger were a channel. The sentence sends the
operator to check their provider when the constraint is the scope, and it will
keep being wrong as more adapters gain history.

Fixed: `ListAutomationReplayCandidatesResponse` carries an
`unsupportedReason` (`contact_dm` / `scoped_thread` / `provider`) beside
`supported`, checked most-specific-first so a Slack DM reports the scope. Each
reason gets its own sentence, the provider one names the provider, and a
response carrying no reason — an older main process, or a schedule trigger —
falls back to a sentence that blames nothing.

### 4. A live destination field whose value is discarded — moderate, fixed

The trigger side suppresses Telegram's topic controls once a DM is selected
(`inboundProvider === "telegram" && !inboundGroupId.startsWith("dm:")`). The
destination side guards on `destProvider === "telegram"` alone, while
`buildDestinationSnapshot` returns before it ever reads `topicId` for a `dm:`
value. "Destination topic ID (optional)" therefore stays on screen for a 1:1
Telegram DM, accepts input, and throws it away on save.

Fixed: the same `dm:` test the trigger side already uses.

### 5. Discord offers no channels at all — critical, fixed

Discord's only authorized list is of guilds, which are servers rather than
conversations, so `readProviderGroups` gave Discord `authorizedUserIds` and
nothing else. Meanwhile `conversationPickerLabel("discord")` returned "Channel",
so the field was labelled *Channel*, the trigger read *"Choose a channel or
DM"*, and the *"Authorized channels"* heading never rendered.

The first draft of this review proposed a banner pointing at manual entry.
That was the wrong fix: channels are what a Discord operator picks, and the
banner would have documented the gap instead of closing it. Two things were
missing, one in each layer:

- **No channel list.** Fixed: the editor lists each authorized server's text
  and announcement channels from Discord's API, through the same lister
  Messaging Settings already uses to inspect thread permissions. Rows read
  "Server / channel", Messaging Routes' separator, because two servers
  routinely both have a `#general`. They sit under *"Channels in authorized
  servers"*, since Discord channels are not authorized one by one. A server
  Discord will not list is named with its error, a missing bot token is said
  once, and having no authorized server is explained rather than shown empty.
  Listing waits until Discord is chosen, since each server costs a request.
- **No way for most channel traffic to reach the matcher.** A Discord guild
  message was dropped at the adapter unless its sender was on the actor
  allowlist, so a channel automation could never fire for an alert bot or a
  teammate. Picking channels would have produced automations that silently
  never ran. Fixed: the Discord adapter now implements the observed-conversation
  set Slack already had. In a channel an enabled automation watches, other
  senders' messages are forwarded `observedOnly`, and their slash commands are
  dropped. The server allowlist still applies first.

### 6. Three of six providers have no manual-entry guidance — moderate

`conversationPickerLabel`, `conversationPlaceholder` and `conversationHint` each
special-case Telegram, Slack and Discord and fall through to a generic string
for Mattermost, Feishu and LINE — *"Conversation"*, *"e.g. a conversation ID"*,
*"The conversation ID PwrAgent should watch."*

Those three are exactly the providers this PR made selectable, and they are the
ones where the operator is most likely to need the manual path (Feishu `chat_id`
versus `open_id`, LINE's separate group and room ID spaces). Fixed: each has its
own noun (Mattermost *channel*, Feishu *group chat*, LINE *group*), ID label,
example, and a sentence naming the wrong ID it is easily confused with.

The first pass of finding 2 claimed a Mattermost UI path to a user ID that
could not be verified; that hint now says only what is true on every server.

### 7. The pipeline caption describes a room — moderate

`inboundConversationLabel` is interpolated into `every message in …`. For a
contact DM that renders as *"every message in Dana Okonkwo"*.

It is also imprecise about behaviour: `matchesAutomationConversation` requires
`actorId === expected.recipientUserId`, so a DM trigger fires on messages *from*
that person, not on everything in the conversation. *"every direct message from
Dana Okonkwo"* is both grammatical and true. The same applies to the picker's
`dm` section heading and to the destination picker's `aria-label`, which
announced *"Destination channel: Dana Okonkwo"*.

Fixed: the caption says *from* for a contact; the contact heading reads
*"Direct messages from"* on the trigger and *"Direct messages to"* on the
destination; the two picker fields are named *Conversation* and *Destination*,
since both lists hold rooms and people; and a contact destination's hint says
*"The result is sent to Dana Okonkwo as a direct message"*.

### 8. Preview copy calls the trigger source a "destination" — moderate

*"History is unavailable for this destination"* appears in the **trigger**
stage, where "destination" is the name of a different field later in the same
form. It should say conversation, or DM, or name the scope.

Two adjacent points:

- `previewHistorySupported` initialises to `false`, so the panel asserts history
  is unavailable for a frame before the IPC answers. It should start `undefined`
  and render neither sentence until it knows.
- The main process computes `historySupported` **synchronously** from provider
  and scope (`supportsPreviewHistory`). The editor could say it under the
  Preview button, where it can change the operator's plan, rather than after
  they have opened the panel.

Fixed: the panel says *conversation*, and says nothing about history until the
main process answers. The two scope refusals — a contact DM, a topic — are the
same on every provider, so they are stated under the button before opening. The
provider refusal is not knowable in the renderer without copying the main
process's adapter table, so it is still stated once the panel opens.

A preview also showed less than the automation would see. The adapters'
observed set came only from **enabled** automations, so previewing `#alerts`
before saving showed nothing from the alert bot the automation was for — on
Slack already, and on Discord once finding 5 landed. Fixed: an open preview
adds its conversation to the observed set while it is open.

### 9. Smaller items — minor

- ~~"Include thread replies" is offered on 1:1 DM triggers, where there are no
  thread replies.~~ **Withdrawn — this was wrong.** Slack and Mattermost DMs
  have threads, and `matchesAutomationConversation` honours the flag for a
  contact trigger. The checkbox stays.
- The capture-by-code panel said *"Paste this into the channel you want to
  watch"* for Mattermost, Feishu and LINE. Fixed: it uses the provider's noun.
- The capture-by-code DM error pointed to *"Messaging settings"* while the field
  hint two elements above said *"Settings > Messaging"*. Fixed: both say the
  latter.
- `previewScope`'s object literal in `AutomationEditor.tsx` was indented at the
  wrong level for its `? :`. Fixed.

### 10. A new destination saved to a disabled provider — critical, fixed

Found while fixing finding 7, and older than this PR. The destination provider
defaults to Telegram, or to the trigger's platform on edit, and only the
select's `onChange` ever changed it. With Telegram disabled, the select
*displayed* its first option (Slack) — a controlled select whose value matches
no option does that — while the state stayed Telegram. An operator who chose
"different conversation" and typed a Slack channel ID under it saved a Telegram
target with a Slack ID in it.

Fixed the way the trigger side already handled its own default: a new
destination follows the trigger's provider when that is enabled, else the first
enabled one. A saved destination is never moved, because silently re-pointing
it at another platform would be the same bug.

The trigger side's version of that correction still has an edge: editing an
automation whose trigger provider has since been disabled moves the provider but
keeps the old conversation ID. Not changed here.

The same select behaviour caused a Windows-only test failure earlier on this
branch. Tests that waited on the Provider select's value were waiting on a
signal the state had not reached yet. They now wait for something only the
target state renders.

### 11. Four providers drop every sender outside the allowlist — open

Only Slack and Discord forward a non-allowlisted sender in a watched
conversation. Telegram, Mattermost, Feishu, and LINE drop that sender in every
shared conversation, so an automation there fires only for authorized contacts
— an alert bot posting into a Telegram group never triggers one unless the bot
is itself authorized. The editor does not say so.

This is the same silent-failure class as finding 5, and the fix is the same
shape: each adapter implements `updateObservedConversations`. It is left open
because each platform's own delivery rules need checking first. Telegram's bot
privacy mode, for one, keeps ordinary group messages from reaching the bot at
all, which no adapter change can fix. The contract is now written down in
[messaging-adapter-contract.md](../messaging-adapter-contract.md#observed-conversations).

## Accessibility

No contrast failures. `--text-muted` (`#8c857a`) on `--bg-panel` (`#0a0a0a`) is
5.4:1, which clears AA for the 11px mono ID column and the field hints;
`--text-secondary` clears it comfortably. Hit targets are 38px rows and 32px
fields.

The accessible-name defects are the same noun problem as finding 7: the picker
composes `` `${fieldLabel}: ${triggerLabel}` ``, so a DM selection announces
with a room noun. Fixing the visible labels fixes the announced ones.

## What works well

- **One matcher, three surfaces.** `matchesAutomationConversation` is now shared
  by the live matcher, the editor preview and the replay badges. The preview's
  "matches" badge is a real promise about what the trigger would do — that is a
  meaningful correctness property, not just deduplication.
- **The section headings explain a short list.** "Authorized …" tells the
  operator why the list is short instead of leaving it looking broken.
- **The kind glyph column** (`#` / `@` / `▸`) does the work a kind filter would
  have done without hiding any rows, and survives a saved route whose kind is no
  longer selectable.
- **The evidence document states its limits plainly**, including exactly which
  provider behaviours no live account verified. That is the right shape for a
  change of this kind.

## Priority

Findings 1–10 are fixed on this branch, except the one item in finding 9 that
was withdrawn. Each blocking finding was a case where the form accepted input
and then discarded or misrepresented it. Finding 2 in particular shipped the
failure mode this work existed to remove.

Finding 11 is the one worth doing next. It is the same failure class as
finding 5 on four more providers, and until it is fixed a group automation
there fires only for authorized contacts, with nothing on screen to say so.
