# Durable thread dependencies

`manage_thread_dependencies` (**Continue After…**) registers one-shot
prerequisites or post-compaction recovery subscriptions for a thread. After
registering a wait barrier, the thread ends its turn; PwrAgent evaluates
prerequisites from provider turn boundaries and its existing PR status bus.
No Job Monitor or model turn runs while it waits. The one timer is the CI run
poller, which runs only while a `ci_run` condition is waiting (see
[CI runs without a PR](#ci-runs-without-a-pr)).

## Post-compaction recovery subscriptions

```json
{
  "action": "create",
  "conditions": [{ "backend": "codex", "threadId": "<this-thread>", "when": "compaction_completed" }],
  "continuation": "Re-read /workspace/AGENTS.md and /workspace/worker-session.md, then use the declared recovery tool to resolve the current assignment. Preserve its progress.",
  "repeat": true
}
```

The top-level backend/thread defaults to the trusted caller. Compaction
recovery requires exactly one local same-thread Codex condition, agent
delivery, an explicitly authorized instruction prompt, and no merge hold.
Declared paths and recovery tool checks belong in `continuation`; PwrAgent
does not infer instructions from paper/session content or read those files
itself. Keep the prompt stable and let its recovery tool resolve the current
assignment. Do not register a new paragraph-specific payload each time.

`repeat: true` retains one durable subscription. Identical active
registrations return that subscription; omitting it watches the next future
completion once. Use the existing list/cancel/dismiss actions to manage it.
The desktop form offers **Add Compaction Recovery**, **Instructions**, and
**Repeat after each future compaction**. It exposes no wait-barrier or
reminder controls for this subscription.

**Keep the ongoing authorized task running after registration.** A
compaction subscription is not a wait barrier; end-turn guidance elsewhere
in this document does not apply to it.

Only owner-local live `contextCompaction` item start/completion pairs count.
The completed item's turn and item IDs identify the event. Starts, explicit
failures/cancellations, unmatched completions, historical thread reads, and
the deprecated `thread/compacted` notification do not fire hooks. This uses
the [Codex App Server item lifecycle and steering contract](https://learn.chatgpt.com/docs/app-server),
not Codex storage. A connection restart forgets unfinished live pairs;
there is no history catch-up, including for compactions while disconnected.

Recovery uses `turn/steer` with the compacted `expectedTurnId`. It never
interrupts, starts, or queues a turn. It skips an ended, stopped, or replaced
assignment, including an idle/manual compaction; recurring hooks remain
subscribed to future compactions. A lock may defer delivery while that turn
remains active. Project pauses, archive, restart gates, and claim revocation
prevent delivery. A pause drops that recovery attempt; it does not queue a
future wake. If multiple completions arrive while one recovery is pending,
they coalesce into that recovery rather than accumulating prompts.

Steering acceptance is not an atomic pre-next-action barrier. Codex may
already have continued before it accepts/applies the guidance. Retain an
explicit startup instruction-file read contract. The recovery wrapper says
the prompt is control guidance, preserves the current assignment, and must
not become artifact content or an instruction to generate another paragraph.

### Loop protection

Every thread shares a durable guard across all its hooks: at most one
automatic recovery attempt every **five minutes**, and at most **three
attempts in a rolling thirty-minute window**, with a hard ceiling of
**eight attempts per active turn** even when spread over hours. A further eligible attempt
trips a circuit breaker. It stays suspended even after the window expires
or the app restarts; only the local operator's **Rearm recovery** button in
Continue After clears it. Agents and peers cannot rearm it. Re-registering,
cancelling, or changing a hook does not clear the guard.

Cooldown events are dropped, with no delayed prompt or timer. The budget
reservation commits atomically with the dispatch claim, so two owners or
different hooks cannot spend the same allowance. Uncertain or refused
admission counts conservatively; retrying a still-unsubmitted busy claim
reuses its reservation, but never bypasses suspension or dispatch cooldown.
After initialization, resume, input preparation and any lifecycle/setup replay,
the final `turn/steer` admission checks the current lock, pause, assignment and
claim again. An immediate SQLite transaction consumes the reservation just
before RPC admission. It anchors the rolling window and cooldown to actual
dispatch time, so unlocking multiple pending hooks cannot send a burst.
Clock rollback cannot open the cooldown early.
The guard stores at most three reservation keys/timestamps and submission bits,
the current turn's counter, and its last attempt, dispatch and suspension times in a PwrAgent-owned row per thread. This
bounds automatic recovery injection; it is not an account-wide token budget
for the worker's independently authorized work.

Each hook retains only its latest completion, consumed item IDs within that
turn, and the existing claim/evidence fields. A compare-and-swap claim
arbitrates owners; per-event message-origin receipts distinguish recurring
deliveries. After a crash, a receipt rearms the recurring hook; an uncertain
claim requires review instead of retrying a possibly accepted steer.

The checked-in `compaction-recovery-eight-completions` budget measures 32
commits for eight eligible completions and 160 duplicate pairs: four
commits per completion, including atomic reservation and final RPC admission,
with zero start/duplicate or idle timer writes. Observed WAL was 267,800 bytes
(about 33,475 bytes/completion). At eight workers each compacting once per ten
minutes, 0.0533 commits/second × 8,369 bytes/commit × 86,400 seconds projects
to **38.6 MB/day**. This is the coordinator's incremental
write cost; existing steering/message-origin persistence keeps its own
budgets. Registration adds one transaction. Cooldown suppression adds zero
writes; a circuit trip plus an explicit operator rearm has its own budget.
Releasing two busy reservations costs four commits total: one dispatch and
one cooldown skip. Repeated availability notifications add no further writes.
The guard table is additive and introduces no timer.

## Choosing a wait

Use `watch_thread_pull_request` for CI or merge notifications on this thread's
attached PR. Follow `prAutomation.guidance` for Auto-fix PR coordination.
Use `manage_thread_dependencies` (**Continue After…**) when work should resume
after another local thread finishes, its CI passes, or its PR merges. Several
prerequisite PRs belong in one registration with `mode: "all"`. Find their
owning threads with `search_threads` and confirm their PRs with
`get_thread_status`; they do not need to be attached to the waiting thread.

For example, "after #9, #10, and #11 merge, rebase #12 and update its tests"
is a dependency on three owning threads with `when: "pr_merged"`, plus that
follow-up as `continuation`. Do not replace it with a Job Monitor running
`gh pr view` every fifteen minutes. Dependencies reuse PR status updates and
spend no model turns while waiting, even if merging takes days. They schedule
the follow-up, but do not merge the PRs or enforce their merge order.

A GitHub Actions run that no PR check covers, such as a tag-push release or a
manual dispatch, is a `ci_run` condition. Do not start a Job Monitor to poll
`gh run view` for it.

Reserve `create_monitor_delegation` for long jobs that PR watches and local
thread dependencies cannot cover. Confirm a wait was registered, finish any
unrelated work, and end the turn.

## Waiting until work is done

A completed turn is a scheduling event; it does not establish that another
thread has finished its work. For work that is done only when someone says
so, use a `marked_done` condition. It names a thread on this instance, a
thread on a connected peer (`target: { scope: "remote", instanceId }`), or
work outside PwrAgent (`threadId: ""` with a `subject`). It is met only by
`action: "mark_done"`, from the operator's **Mark Done…** or an agent, with
an optional note. A finished turn, idle state, archive, or disconnection
never marks it done. A peer's thread can only be `marked_done`; turn and PR
milestones stay on the waiting thread's own instance.

`holdMerge: true` refuses merging the waiting thread's PRs, and any PR
attached to it, while the wait is waiting or ready. Merge cards and the
`merge_pull_request` tool both check it just before the provider write.
Rebase, CI repair, review, and conversation continue. With
`deliver: "operator"`, `steps` (up to twelve) become the reminder card's
checklist. This replaced Wait Until Done (v1.3.13–14); waits made there were
not carried over.

A waiting thread on a peer is managed on its owner: the request carries
`federationTarget` and crosses as `backend.manageThreadDependencies`, gated
on the `thread_dependencies_v1` capability and `turn_control`. `list` also
returns `peerDependents`, the waits connected peers keep on this thread, so
the prerequisite's side can mark them done. Peers that do not answer are
left out.

## Registering a dependency

```json
{
  "action": "create",
  "conditions": [
    { "backend": "codex", "threadId": "foundation", "when": "ci_passed" }
  ],
  "mode": "all",
  "onFailure": "wait",
  "continuation": "When the foundation PR passes CI, rebase this branch onto its head and switch the upgrade to its new retry helper."
}
```

`continuation` is required on every create, from an agent or from the desktop
dialog. It is what the resumed turn should do, written for a reader without
the registering conversation, which may be compacted by then. The continuation
prompt leads with it on success. On failure the prompt asks for a failure
report and quotes the plan as work not to start. A registration saved before
the field was required has none; its prompt asks the thread to continue the
previously authorized work.

`backend` and `threadId` identify the waiting thread and default to the
trusted calling thread. `action: "list"` returns its registrations and
evidence, plus `dependents`: active registrations on other threads that wait
on this one. `action: "cancel"` requires `dependencyId` and cancels a
registration before admission. A condition may carry a display-only `title`
(at most 200 characters). It is excluded from deduplication, and the
continuation prompt names the prerequisite by it. When an agent omits it,
PwrAgent saves the thread's current title at registration.

The desktop uses the same service from **Continue After…** in a sidebar
thread's menu, beside **Lock Thread…**. It is offered only for threads this
window owns; a peer's thread is managed on its owner. The item shows the
thread's waiting count, and it opens a dialog on the thread's registrations,
or on the add form when there is nothing to show. In the form, searching
adds a prerequisite row per chosen thread, each with its own condition;
threads already waiting on this one are not offered. **Instructions** are
required. Active registrations show one line per prerequisite with its state
and the registered plan, and finished ones collapse under **History**. The
prerequisite thread lists its dependents under **Waiting on this thread**,
and every change notifies the waiting thread and each prerequisite thread.

Uncertain deliveries leave the card list for one **Delivery review** section
above it. Claims are grouped by exact error, and each group prints its error
once in full, with its count and time range. A disclosure lists every
registration in the group: its id, prerequisites, plan and time. The operator
selects groups, then **Dismiss N Reviewed…** opens an inline confirmation that
states what dismissal does: the claims move to History, a continuation that
did start keeps running, and nothing is cancelled or sent again. One request
(`action: "dismiss"` with `dependencyIds`) retires the selection in one
immediate transaction, all or none. Bulk dismissal is the operator's; the
agent tool keeps single `dependencyId` dismissal, and the owner refuses
`dependencyIds` from an agent. A wait replaced by a newer registration appears
in History as **Replaced**.

A sidebar row with active registrations carries a chip: progress such as
`1 of 2` for one registration, a count for several, and a red
**Check delivery** label when a delivery needs review, with a count when several
deliveries need review. This means admission could not be confirmed; it is not
ordinary waiting. While reviews exist, the tooltip groups them by exact error:
one clipped line per cause, at most three, with the remainder counted. Without
reviews it previews at most two registrations and three prerequisites each,
and reports omitted counts. Clicking the chip opens the dialog. The chip reads
`action: "active"` from the desktop window's IPC channel, which lists every
active registration without its continuation text; agents cannot call it. A
continuation turn is labeled **Continue after** in the transcript.

## Delivery target

`deliver` chooses who acts when the dependency fires:

| `deliver` | On delivery |
| --- | --- |
| `agent` (default) | Submits a continuation turn to the waiting thread. |
| `operator` | Raises a reminder to-do card on the waiting thread. No model turn starts. |

Agents should choose `operator` when only the human can do the follow-up. A
manual approval, a decision, a deploy the agent cannot run, and telling
someone are all examples. Registrations made before this field existed have
no `deliver` and resume the thread. The target is part of deduplication, so
the same prerequisites can both resume the thread and remind the operator.

The card's title joins the fired prerequisites and the continuation, such as
`#2999 merged: call mom and tell her I'm her hero again`. A PR prerequisite
is named by its PR number. Other prerequisites use their saved title, or the
thread id when no title exists. More than two fired prerequisites become
`3 prerequisites met`. The title is clipped to the 120-character to-do limit.
The detail lists every prerequisite with its state, reason and PR URL. When
the title was clipped, the detail starts with the whole continuation.
Without a continuation, the title is the prerequisites alone.

`handoff: true` (operator delivery only, and it requires a continuation)
gives the card a **Start thread** action whose prompt is the continuation, so
the operator can pass the work to an agent with one click. That card's kind
is `handoff` rather than `reminder`.

In the **Continue After** dialog, the form's **When met** choice switches
between **Resume this thread** and **Remind me**. **Remind me** relabels the
required text field **Reminder** and offers the Start thread option. Each card
names its target beside the status: **Resumes this thread** or **Reminds
you**. The sidebar chip's tooltip ends with "Then reminds you." for an
operator registration.

### Failures

Failure follows the same policy as agent delivery. `onFailure: "wait"` keeps
a CI failure or conflict waiting for its repair. A terminal failure, or any
failure under `notify`, raises the card once. Its title names the failure,
for example `#2999 failed: PR closed without merging`. The continuation
appears in the detail as `Not started: …`, the same contract the agent prompt
keeps: the plan is shown and not begun. A failure card never carries Start
thread, even with `handoff`, because one click must not start work whose
prerequisite failed.

### Exactly one card

The card insert and the dependency's `ready` → `delivered` compare-and-swap
commit in one immediate SQLite transaction. A process that loses the claim
rolls its card back with it. A crash leaves either both or neither. A turn
needs an uncertain `dispatching` state because backend admission has no
idempotency key. Operator delivery has no such state, so there is nothing
to review or dismiss afterwards. Async lookups (the waiting thread's
workspace and project, for Start thread) run before the transaction. A claim
that changes during them simply fails the swap.

Two keys identify the card. `key` is `dependency:<id>`, which follows the
to-do convention that re-adding a key updates the card in place. The open-key
index frees a key once its card is resolved, so the card also stores
`dependency_id`. That column's unique index (schema v78) holds even after the
operator resolves or dismisses the card, and raising again for the same
dependency returns the existing card unchanged. These cards skip the
twenty-open-card cap. The cap stops a looping turn calling `add_todo`.
A dependency fires once, after a prerequisite event, and a thread holds at
most thirty-two active registrations. Operator delivery does not wait for an
idle consumer, because it starts no turn.

## Conditions

| `when` | Readiness |
| --- | --- |
| `turn_completed` | The pinned turn completed successfully. Omitted `turnId` pins the current or latest turn during registration. Failed/cancelled turns report failure. |
| `pr_attached` | A reviewable primary-workspace PR exists. Drafts remain pending. |
| `ci_passed` | Fresh status for the current head reports passing checks with no checks still running, no conflict, and no draft. A merge alone does not prove CI passed. |
| `pr_merged` | The selected PR merged. Closure without merging reports failure. |
| `marked_done` | Someone sent `mark_done` for this condition. Nothing else satisfies it. |
| `ci_run` | The run reached a milestone in `ciRun.on`: `approval_gate`, `job_failed` or `finished` (all three when omitted). A finished run always ends the wait. See below. |

A prerequisite can be registered before its PR exists. Omitted `prUrl`
selects the first unambiguous primary-workspace PR and retains that identity.
Multiple PRs require an explicit URL. Omitted `headSha` follows the current
head; an explicit head fails if superseded. All evidence is rechecked before
admission, so an earlier green head cannot release a busy consumer later.

`mode` is `all` by default; `any` releases on the first satisfied condition
and fails only when every alternative has failed. `onFailure: "notify"`
resumes once to report failure, with instructions to keep dependent work
blocked. `wait` tolerates CI failures/conflicts while repair proceeds, but a
closed PR or failed turn is terminal. The UI defaults to waiting through
repairs; the tool defaults to reporting failure.

## CI runs without a PR

A `ci_run` condition names one GitHub Actions run by URL, with `threadId: ""`
and the waiting thread's `backend`:

```json
{
  "action": "create",
  "conditions": [{
    "backend": "codex",
    "threadId": "",
    "when": "ci_run",
    "ciRun": {
      "url": "https://github.com/acme/app/actions/runs/8841207733",
      "on": ["approval_gate"],
      "environments": ["production"]
    }
  }],
  "continuation": "Report the gate and its reviewers to the operator."
}
```

- **Milestones.** `approval_gate` means the run waits on a deployment
  approval (GitHub's `pending_deployments`), optionally limited to the named
  environments. `job_failed` means a job in the latest attempt failed while
  others may still run. `finished` means the run concluded `success`.
- **A finished run always settles the wait.** Success satisfies `finished`.
  Any other conclusion, or a success when `finished` was not requested, fails
  the condition, because the milestone can no longer happen.
- **One-shot.** A wake after a gate does not keep watching. Register a new
  `ci_run` wait for the finish. PwrAgent never approves a deployment.
- **Registration reads the run once.** A URL it cannot read is refused. A run
  already at a requested milestone fires at once. A re-run is followed through
  its latest attempt.
- **Host.** Only `https://github.com/<owner>/<repo>/actions/runs/<id>` is
  accepted, the same origin rule as automatic transcript PR reads. GitHub
  Enterprise hosts and GitLab pipelines are not supported.
- **Wake context.** The continuation prompt lists the run, each pending gate
  with its reviewers, job counts for the latest attempt, and each failed job
  with its failed step and URL.

### Polling

GitHub sends no events for a run without a GitHub App, so the main process
polls. The poller keeps one timer for all waiting runs: every 30 seconds for
a run's first ten minutes, then every two minutes. Each check reads the run,
its latest-attempt jobs, and, while the run is waiting, its pending
deployments. Requests go through the forge client's admission and token
bucket. No model is involved.

The poller runs only while background PR polling is enabled and the waiting
thread's project allows PR watches, the same gate as PR conditions. With PR
polling off, registration is refused, as it is for a PR prerequisite. A failed
check keeps the last observation and marks it stale. It never fails the wait.

A future PwrAgent GitHub App should replace this polling with `workflow_run`
and `deployment_review` webhooks.

### Storage

The latest observation lives in coordinator memory only. The stored evidence
for a waiting run is a fixed `Waiting for run <id>` line, so an unchanged
check writes nothing. `list` responses and the Waiting For panel are decorated
from memory with the run's status, job counts and check time. After a
restart, the first check restores them.

The renderer shows the wait in the Waiting For panel's **CI runs** group and
in Continue After, with the run's link and a Cancel action. An agent
registers these waits. The dialog does not offer a form for them.

## Persistence and admission

`thread_dependencies` stores the request, evidence, and lifecycle under the
PwrAgent profile's state database. Registration runs in an immediate SQLite
transaction: identical active requests deduplicate and new edges must not
create cycles. Dependencies are limited to sixteen conditions, thirty-two
active registrations per consumer, and 512 per profile. Completed edges no
longer constrain the graph. Only local thread conditions join the graph;
a peer's thread or a subject cannot form a cycle here.

Deduplication includes pinned turns and continuation text, but excludes display
titles and condition order. Each wait-barrier registration fires once, including
`mode: "any"`; later worker turns require a new wait after the previous
delivery completes.

A rolling orchestrator re-registers its wait as workers take new turns. A
registration supersedes an active `waiting` or `ready` one on the same thread
when the delivery, policy, continuation and prerequisite set match and only
pinned turns differ. Each differing turn must be later in its thread's provider
history. The older wait becomes `cancelled` with `supersededBy`, in the
registering transaction, and never fires. A claim being dispatched or reviewed
is never superseded. A different continuation, thread set, PR or delivery is
an independent wait and is kept.

The coordinator serializes local events and uses a SQLite compare-and-swap
to claim delivery across instances sharing a profile. Busy consumers retain
readiness; their terminal turn event retries admission after rechecking the
prerequisites. Dependencies schedule a continuation; they do not interrupt
an active turn or hold unrelated manual messages.
The specific Codex resume refusal about changing Token Miser activation during
an active turn is a confirmed busy result, before `turn/start`. It retains the
wait for an idle event. Transport errors and errors after sending `turn/start`
remain uncertain and are never automatically retried.

A busy refusal or a started continuation holds the consumer until its own
terminal or idle notification. The registry tracks only turns it started, so
an active turn started elsewhere can refuse admission and its idle notification
can be delayed or lost. The owner then confirms idle: the registry holds no
turn for the thread, the thread is not locked, and the provider's thread read
shows no turn in progress. The coordinator asks on a prerequisite's thread
event, on `list` (opening Continue After), and on reconcile. It does not poll.
After confirmation it evaluates the ready waits and admits at most one; the
next waits for that turn to end.

Watching/ready registrations survive restart and reconcile through the
provider protocol. Runtime code never reads Codex storage. An admitted turn
carries `dependencyId` in its message origin. That durable receipt can settle
a claim left incomplete by a crash. A claim counts as in flight only while
another process holds it and it is under five minutes old. The admitting
PID is not trusted beyond that, because the OS reuses PIDs.

Backend turn admission has no idempotency key. If a crash or transport error
leaves admission uncertain and no receipt exists, PwrAgent retains a visible
delivery-review state and does **not** replay the continuation. New agent waits
and admission of other pending agent waits on that consumer are blocked until
review resolves the claim. Operator reminders can still be registered and
delivered. Inspect the consumer before registering another dependency.
`action: "dismiss"` (or
**Dismiss after review** in the UI) retires an uncertain claim after that
inspection; it does not cancel a potentially admitted turn. This provides at-most-once
automatic admission rather than claiming exactly-once delivery across an
unacknowledged backend request.
The refusal to register a replacement while review is pending makes zero
SQLite commits (0 MB/day), covered by its checked-in write budget. Dismissing
32 reviewed deliveries is one commit (about 21 KB of WAL), and only when the
operator confirms a review.

## SQLite write budget

The checked-in budgets cover dependency storage, excluding provider turn
setup: five boundary commits and approximately 49 KB of WAL for registration
through successful delivery (~4.9 MB/day at 100 dependencies). Operator
delivery costs four commits and approximately 62 KB for registration through
its card (~6.2 MB/day at 100 reminders). The card and the delivered claim
share one commit. A marked-done wait costs five commits and approximately
70 KB from registration through Mark Done and its card (~3.5 MB/day at 50
waits); only the operator's or an agent's Mark Done writes. A rolling
re-registration that supersedes its older wait costs the same two commits as
any registration: the insert and the retirement share one transaction
(about 25 KB of WAL; 300 worker turns a day is about 7 MB/day, with or without
supersession). Owner-confirmed idle reads the provider and writes nothing. One hundred
unchanged PR observations plus one hundred thread events make zero commits,
including when the consumer is busy. Evidence timestamps alone never cause
a write. No dependency means no per-turn persistence.

A `ci_run` wait costs five commits and approximately 49 KB of WAL from
registration through delivery, and zero commits per unchanged check
(`thread-dependency-ci-run-lifecycle`, `thread-dependency-ci-run-unchanged-checks`).
One release wait a day is about 0.05 MB/day.
