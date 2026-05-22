---
date: 2026-05-22
topic: telegram-topic-ownership
---

# Telegram Topic Ownership and Monitor Fanout

## Problem Frame

PwrAgent works well enough in Telegram supergroup topics to bind and steer
threads, but the supergroup topic list can become a maintenance burden. A user
who works from Telegram wants PwrAgent to own a control topic, create useful
per-thread topics when monitoring recent work, and help clean up stale or messy
topics without destructive surprises.

Telegram's Bot API supports topic management, but it does not expose a bot
method that lists every forum topic in a supergroup. That means PwrAgent cannot
reliably sweep all historical topics from Telegram alone. It can manage topics
it created, topics it has observed through service messages or inbound traffic,
and topics explicitly adopted by the user through an ID/link/manual command.

## Requirements

- **R1. Topic owner surface.** PwrAgent can establish or adopt a dedicated
  Telegram forum topic for operator commands, status, and approvals related to
  supergroup maintenance.
- **R2. Permission clarity.** The operator can tell whether the bot has the
  Telegram admin rights required for each action before relying on automation:
  create/rename/close/reopen require topic-management rights; delete requires
  delete-message rights.
- **R3. Topic registry.** PwrAgent persists a local registry of Telegram forum
  topics it owns, creates, observes, or adopts, including supergroup id, topic id,
  title, lifecycle state, source, linked PwrAgent thread when known, last observed
  activity, and last proposed cleanup decision.
- **R4. Explicit adoption path.** Since Telegram does not list all topics for
  bots, the user can adopt an existing topic by issuing a command from inside
  that topic or by providing a Telegram topic link/id where the adapter can
  validate it.
- **R5. Dry-run cleanup by default.** Topic cleanup evaluates stale or unmanaged
  topics and posts a proposed action list. Closing and deletion do not happen
  until the user approves specific proposed actions.
- **R6. Conservative deletion.** Deleting a topic is never automatic in the
  default mode. The confirmation surface must make clear that Telegram deletes
  the topic along with its messages.
- **R7. Close before delete.** Cleanup proposals prefer closing inactive topics
  before deleting them, unless the topic is known to be empty/test-created or the
  user explicitly asks for delete candidates.
- **R8. Monitor topic fanout.** A topic-aware monitor mode can summarize recent
  changed PwrAgent threads and ensure each selected thread has exactly one topic
  in the target supergroup.
- **R9. No duplicate topic attachment.** If a PwrAgent thread is already linked
  to a topic in the same supergroup, monitor fanout reuses that topic instead of
  creating a second one.
- **R10. Context seeding.** When monitor fanout creates a topic for a thread, it
  posts a compact context message into that topic: thread title, backend, project
  or directory label when available, recent activity/status, and how to control
  the thread from that topic.
- **R11. Existing `/monitor` preserved.** The current channel-level `/monitor`
  card continues to work. Topic fanout is an explicit mode or subcommand, not a
  silent behavior change to every monitor subscription.
- **R12. Supergroup rate budget respected.** Topic fanout and cleanup avoid
  bursty posts because Telegram supergroup write budgets are shared across
  topics.
- **R13. Authorization preserved.** Only authorized actors in authorized
  supergroups can invoke topic ownership, adoption, cleanup, or monitor fanout.
- **R14. Provider isolation preserved.** Telegram Bot API calls and SDK types
  stay inside `packages/messaging/providers/telegram`; desktop workflow code
  uses provider-neutral messaging capabilities and opaque routing state.

## User Flows

### F1. Establish the Control Topic

1. User adds the PwrAgent bot to a Telegram supergroup and grants admin rights.
2. User sends a topic-owner command from the desired control topic, or asks
   PwrAgent to create one.
3. PwrAgent verifies the conversation is an authorized Telegram supergroup topic.
4. PwrAgent records the topic as the supergroup's control topic and replies with
   the current permission status and available actions.

### F2. Dry-Run Cleanup

1. User asks the control topic to sweep the supergroup topics.
2. PwrAgent evaluates known/adopted topics from its local registry.
3. PwrAgent posts a cleanup proposal grouped by recommendation:
   keep, adopt/label, close candidate, delete candidate, unknown/unseen.
4. User approves selected actions.
5. PwrAgent performs approved close/delete operations, records outcomes, and
   posts a compact completion summary.

### F3. Adopt an Existing Topic

1. User posts an adoption command from inside an existing Telegram topic, or
   gives PwrAgent a topic link/id in the control topic.
2. PwrAgent validates the topic route it can infer from Telegram message state.
3. PwrAgent records the topic in the local registry as user-adopted.
4. Future cleanup and monitor fanout can reason about that topic.

### F4. Topic-Aware Monitor Fanout

1. User asks the control topic to monitor recent changed threads into topics.
2. PwrAgent selects recent threads with meaningful activity in the configured
   window, starting with a one-day default.
3. For each selected thread, PwrAgent finds an existing topic link for the same
   supergroup or creates a new topic if no link exists.
4. PwrAgent posts a compact context seed into newly created topics and updates
   the registry.
5. Ongoing monitor refreshes update or post into the appropriate topic without
   attaching the same thread to multiple topics in the same supergroup.

## Scope Boundaries

- In scope: Telegram supergroup forum topics, a PwrAgent control topic, local
  topic registry, adoption commands, dry-run cleanup proposal and approval,
  explicit close/delete execution, and a topic-aware monitor fanout mode.
- In scope: permission checks and user-facing explanation of missing Telegram
  admin rights.
- In scope: preserving current `/monitor` behavior as the default monitor card.
- Out of scope: using Telegram MTProto/TDLib user APIs to list topics. PwrAgent
  should stay on the Bot API path.
- Out of scope: autonomous deletion as the default behavior.
- Out of scope: broad topic cleanup for topics PwrAgent has never observed and
  the user has not adopted.
- Out of scope: provider-specific cleanup behavior for Discord, Slack,
  Mattermost, Feishu, LINE, or other platforms in the first implementation.

## Success Criteria

- A user can set up a Telegram supergroup so PwrAgent clearly reports whether it
  has the rights needed to create, close, rename, and delete topics.
- A user can designate a PwrAgent control topic and issue maintenance commands
  from that topic.
- Cleanup produces a readable dry-run proposal and requires explicit approval
  before closing or deleting topics.
- PwrAgent never deletes a Telegram topic unless the user approved that exact
  proposed action.
- Topic-aware monitor fanout creates or reuses one topic per selected PwrAgent
  thread per supergroup and seeds each new topic with useful context.
- Re-running topic-aware monitor fanout does not create duplicate topics for an
  already linked thread in the same supergroup.
- Restarting PwrAgent preserves the topic registry, control topic, monitor
  fanout links, and pending cleanup proposal state.

## Key Decisions

- **Default cleanup mode is dry-run approval.** The user selected this as the
  safety posture. Deletion is destructive and must remain an explicit approval
  step.
- **Topic inventory is local and adopted, not globally fetched.** Telegram's Bot
  API exposes service messages and topic-management methods, but not a complete
  bot-side topic listing endpoint. PwrAgent must be honest about this limitation.
- **Monitor topic fanout is opt-in.** The existing `/monitor` card remains the
  current low-noise summary. Creating topics is a stronger action and should be
  requested explicitly.
- **The control topic is the natural command surface.** It gives the user a
  stable place to tell PwrAgent to clean, adopt, monitor, and approve without
  mixing maintenance commands into every per-thread topic.

## Dependencies and Assumptions

- The bot must be an admin in the Telegram supergroup.
- For create, rename, close, and reopen, the bot needs topic-management rights
  unless it is acting on a topic it created where Telegram permits that.
- For delete, the bot needs delete-message rights because Telegram deletes the
  topic and all its messages.
- The supergroup must be authorized in PwrAgent's Telegram settings and the
  invoking actor must be authorized.
- Existing topic state can only be complete after adoption or observation. A
  first sweep may report "known topics only" and ask the user to adopt more.

## Open Questions

- Should the first user-facing command be a new `/topics` command, or a
  capability-aware `/monitor topics` and `/monitor cleanup` subcommand family?
- Should cleanup proposals expire after a fixed time, or remain pending until
  approved/rejected from the control topic?
- What is the first default staleness threshold for close candidates: no
  observed activity for 7 days, 14 days, or user-configured per sweep?
- Should thread-topic names be renamed automatically when the PwrAgent thread
  title changes, or should renames be proposed in the dry-run cleanup surface?

