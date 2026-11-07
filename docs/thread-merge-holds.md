# Wait Until Done

A wait marks a thread as waiting for work whose end someone has to judge: an
investigation, a validation pass, a review in another thread. While it
waits, merging the thread's PR is held. Conversation, rebase, review, and CI
repair continue. When someone marks the work done, the operator gets a
reminder card with the next steps they asked for. Nothing starts a turn.

Use [Continue After](thread-dependencies.md) instead when the event is
automatic: a turn ends, CI passes, a PR merges. A completed turn is a
scheduling event; it does not establish that another thread has finished its
work.

The thread menu's **Wait Until Done…** opens the same state that agents
manage with `manage_thread_merge_holds`. The form asks for:

| Field | Request field | |
| --- | --- | --- |
| **Waiting for** | `reason` | Required. What has to finish. |
| **Waiting on** | `dependency` | Optional. A PwrAgent thread link to the thread doing the work. It may be on another instance, including one that is offline. |
| **When it's done, remind me to** | `followUp` | Optional. One step per line, at most 12 steps of 200 characters. |
| **Offer to send these steps to this thread** | `offerToSend` | Optional, needs steps. |

`releaseWhen` is optional and agent-only: what counts as done, when that is
more than the reason says.

```json
{
  "action": "create",
  "reason": "Windows validation of the shutdown fix",
  "followUp": ["Rebase onto #3291", "Re-run the Windows E2E lane", "Merge #17"],
  "dependency": {
    "backend": "codex",
    "threadId": "validation-thread",
    "target": { "scope": "remote", "instanceId": "windows-instance" },
    "title": "Windows validation"
  }
}
```

`backend` and `threadId` default to the calling thread. They identify the
waiting thread. `federationTarget`, when supplied, identifies that thread's
owner. `dependency.target` identifies the prerequisite relative to the owner.

## Where a wait shows

- The sidebar row carries a **Waiting** chip, with a count for several.
  Clicking it opens the dialog.
- Above the transcript: "Waiting for … · Merge held · 2 steps to remind you
  of", with **Manage…**.
- A merge to-do card on the thread reads "Merge waits for …" instead of its
  merge button.
- The prerequisite thread shows "Another thread is waiting on this one for …"
  with **Mark Done…**, and its dialog lists the wait under the waiting
  thread's chip.

## Marking it done

`resolve` requires `holdId` and a `note` saying what finished. Any of these
can mark a wait done:

- The prerequisite thread's agent. `list` on that thread returns the holds of
  threads waiting on it, with each hold's id and owner; the agent resolves
  that exact hold on its owner.
- The operator, with **Mark Done…** on either thread.
- The waiting thread's agent, when the operator tells it the work is done.

Resolving raises one reminder to-do card on the waiting thread, in the same
SQLite transaction as the resolve, so a crash leaves both or neither. A card
that cannot be inserted rolls the resolve back. The card:

- Is titled from the prerequisite's title, or the reason, and the first step:
  `Windows validation done: Rebase onto #3291 (+2 more)`. Without steps it is
  `Windows validation done`.
- Lists the steps as its checklist.
- Gives what was waited for, the note, who marked it done, and whether
  another wait still holds merging.
- Offers **Send** to the waiting thread only with `offerToSend`. Its prompt
  names what finished and numbers the steps. The operator decides.

The card's `dependencyId` and `key` are `merge-hold:<hold id>`. The unique
index on `dependency_id` means one wait raises at most one card, even after
the card is resolved. The hold records the card as `reminderTodoId`. Like
Continue After's reminders, these cards skip the twenty-open-card cap.

`cancel` (**Stop Waiting**) also requires a note. It means the operator no
longer waits, and raises no card. Only the waiting thread's dialog offers it.

History retains the actor, time, and note. Repeated creates and identical
terminal actions are idempotent. Every wait must clear before merging becomes
available. Clearing never merges a PR or starts a turn.

Successful turns, idle state, archive, PR status updates, and disconnection
do not change a wait. Offline owners keep their waits; a failed lookup or
failed resolve never clears one. Reverse lookup includes connected peers that
grant `turn_control`; failures are reported in `unavailablePeers`.

PwrAgent does not tell the prerequisite thread's agent that someone waits on
it. Its banner and dialog show the wait to the operator, and the tool
description tells an agent to `list` before reporting finished work.

## Persistence and enforcement

Holds live in the waiting thread's PwrAgent overlay, with up to 32 active
holds per thread, 512 active holds per profile, and 100 retained terminal
entries per thread. Active holds protect the thread from Thread Maintenance archiving,
and archive cleanup retains the owner overlay until its holds are cleared.
Mutations re-read under an immediate SQLite transaction. Duplicate actions
and reads make no writes. There are no timer, per-turn, or streamed-event
writes. The checked-in budgets measure two commits and 28,872 WAL bytes for a
create and resolve without a reminder (`thread-merge-hold-lifecycle`), and
one commit and 32,960 WAL bytes for a resolve together with its card
(`thread-merge-hold-reminder`). At 50 waits a day the pair projects about
3 MB/day.

A hold binds the thread and the PR URLs attached while it is waiting. A PR
attached after creation is bound in the existing attachment write. Detaching
a PR does not remove that binding. Both agent forge merges and operator
merge-card actions re-read active holds at the provider boundary. Another
local thread cannot merge the same held PR. Numeric GitHub merge cards resolve
their URL before checking holds. Peer mutations execute on the waiting
thread's owner and record the authenticated requesting instance; the
reminder card is raised there.

These guards cover PwrAgent merge actions. They do not install a GitHub or
GitLab required check and cannot prevent a merge performed outside PwrAgent.
