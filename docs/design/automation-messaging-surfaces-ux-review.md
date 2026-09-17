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
| 5 | Discord's nouns promise channels that cannot appear | Open |
| 6 | Three providers have no manual-entry guidance | Open |
| 7 | The pipeline caption describes a room | Open |
| 8 | Preview copy, and a limit stated too late | Open |
| 9 | Smaller items | Open |

Findings 5–9 are a copy pass with no structural change. The mockup sheets
draft every one of their strings; none of that wording is a decision yet.

## Overall

The feature reads as finished from the main process outward and unfinished from
the operator inward. DMs became selectable, but the vocabulary around them did
not change: the fields are still called channels, the manual escape hatch can
still only build a channel, the pipeline caption still describes a room, and two
empty states now describe a constraint that moved. The result is a form that
will let an operator build a trigger that never fires, on four of six providers,
without a word of feedback — the exact failure mode the handoff set out to
eliminate.

Nothing here is a plumbing defect. Every finding is a label, a guard, or a
sentence.

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

### 5. The picker's nouns promise channels that can never appear — moderate

Discord's only authorized list is of guilds, which are servers rather than
conversations, so `readProviderGroups` gives Discord `authorizedUserIds` and
nothing else. Meanwhile `conversationPickerLabel("discord")` returns "Channel",
so the field is labelled *Channel*, the trigger reads *"Choose a channel or
DM"*, the search says *"Find a channel, DM, or ID"*, and the *"Authorized
channels"* heading never renders.

An operator looking for `#deploys` has no way to learn that it is not missing —
it is structurally absent, and the only route to it is the manual field they
have been given no reason to open.

Fix: one banner beside the Discord control saying PwrAgent authorizes servers
rather than channels, and pointing at manual entry.

### 6. Three of six providers have no manual-entry guidance — moderate

`conversationPickerLabel`, `conversationPlaceholder` and `conversationHint` each
special-case Telegram, Slack and Discord and fall through to a generic string
for Mattermost, Feishu and LINE — *"Conversation"*, *"e.g. a conversation ID"*,
*"The conversation ID PwrAgent should watch."*

Those three are exactly the providers this PR made selectable, and they are the
ones where the operator is most likely to need the manual path (Feishu `chat_id`
versus `open_id`, LINE's separate group and room ID spaces). Fix: give each the
noun and the "where do I find it" sentence the first three already have.

### 7. The pipeline caption describes a room — moderate

`inboundConversationLabel` is interpolated into `every message in …`. For a
contact DM that renders as *"every message in Dana Okonkwo"*.

It is also imprecise about behaviour: `matchesAutomationConversation` requires
`actorId === expected.recipientUserId`, so a DM trigger fires on messages *from*
that person, not on everything in the conversation. *"every direct message from
Dana Okonkwo"* is both grammatical and true. The same applies to the picker's
`dm` section heading and to the destination picker's `aria-label`, which
currently announces *"Destination channel: Dana Okonkwo"*.

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

### 9. Smaller items — minor

- "Include thread replies" is offered on 1:1 DM triggers, where there are no
  thread replies. It is hidden for Telegram only.
- The capture-by-code panel says *"Paste this into the channel you want to
  watch"* for Mattermost, Feishu and LINE.
- The capture-by-code DM error points to *"Messaging settings"* while the field
  hint two elements above says *"Settings > Messaging"*. Pick one.
- `previewScope`'s object literal in `AutomationEditor.tsx` is indented at the
  wrong level for its `? :` — house style is hand-maintained, so this will not
  be caught by tooling.

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

Findings 1–4 are fixed on this branch: each was a case where the form accepted
input and then discarded or misrepresented it, and finding 2 in particular
shipped the failure mode this work existed to remove.

Findings 5–9 remain open and are a copy pass — labels, nouns, and one banner,
with no structural change. Of them, finding 5 is the one worth doing next: a
Discord operator is currently told to look for a section that cannot exist.
