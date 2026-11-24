---
name: waiting-on-work
description: Use when waiting for CI, another PwrAgent thread, a time, or a long job to finish, including Auto-fix PR coordination.
---

# Waiting on work

Choose the wait by what owns the work. Use the advertised tool description and
input schema for argument details and result semantics.

| Waiting for | PwrAgent workflow |
| --- | --- |
| CI or merge of this thread's attached PR | `check_thread_pull_request_status`, follow `prAutomation.guidance`, then `watch_thread_pull_request` if a notification is needed. |
| Another local thread's turn, passing CI, or PR merge | `manage_thread_dependencies` (the **Continue After** UI) with `action: "create"`. Use `mode: "all"` for several prerequisites. |
| Work that finishes only when someone says so, before merging or before the operator acts, including a peer's thread or work outside PwrAgent | `manage_thread_dependencies` with a `marked_done` condition. |
| An existing local watcher writes a result or exit marker in this workspace | `manage_thread_dependencies` with one `local_file` condition. Keep the watcher running and end the turn. |
| A GitHub Actions run or GitLab pipeline with no PR, such as a tag-push release: its approval gate, a failed job, or its finish | `manage_thread_dependencies` with a `ci_run` condition. |
| A time: "check again in two hours", "look at this tomorrow at 9" | `schedule_follow_up`. Never a polling monitor, a sleep, or a backend `/loop`. |
| The operator, at a time: "remind me in an hour" | `notify_operator` with `delayMinutes` or `at`. It reaches the operator outside this thread and does not wake it. |
| A long job or repeatable check that no workflow above covers | `create_monitor_delegation`. |

Use `create_monitor_delegation` if the operator specifically asks for a Job
Monitor. A request to watch or wait for CI uses the applicable CI workflow.

## This thread's PR

Check status once and follow the returned `prAutomation.guidance`. Attach the PR
with `attach_thread_pull_request` if branch discovery missed it. Use a watch for
CI success or failure, and include `merged` and `closed` in `notifyOn` when this
thread must clean up resources after the PR lands. Read the watch result: an
already terminal PR returns its outcome without creating a wait.

After `rerun_failed_ci_jobs`, call `watch_thread_pull_request` and check
`armed`. PwrAgent records its own re-runs, so the replaced attempt's result
cannot fire the watch. If `armed` is false, read `message`: checks may already
have finished at this head. For a re-run started outside PwrAgent, call again
with `waitForNextResult: true`. Do not end the turn assuming a wait that the
result did not confirm.

When a wait is no longer needed, call `watch_thread_pull_request` with
`action: "list"` to read this thread's waiting watches, then with
`action: "cancel"` and the `watchId` to stop one. The operator sees it end as
stopped by the agent.

Auto-fix PR coordinates failure wake-ups with watches; avoid duplicate monitors.
A success watch can still be needed when Auto-fix is active. Follow the status
tool's description for `autoFixActive` monitoring ownership and repair-event
semantics, and follow the returned `prAutomation.guidance` for this PR.

## Waiting until work is done

For "mark us waiting on", "do not merge until", or "when that thread is done,
remind me to …", create a Continue After wait with a `marked_done`
condition. It fits work whose end is a judgement: an investigation, a
validation pass, a review. Name a thread by backend and thread id; a thread
on a connected peer also takes `target: { scope: "remote", instanceId }` and
can only be `marked_done`. For work that is not a thread, pass `threadId: ""`
and say what has to finish in `subject`. A peer prerequisite can be offline.

Set `holdMerge: true` to refuse merging this thread's PRs while it waits.
Rebase, CI repair, review, and conversation continue. Never bypass a hold
with `gh`, `glab`, or another merge action. For a reminder rather than a new
turn, set `deliver: "operator"` and put the operator's next steps in `steps`,
one per item; they become the card's checklist.

```json
{
  "action": "create",
  "conditions": [{ "backend": "codex", "threadId": "<windows-validation-thread>", "when": "marked_done", "target": { "scope": "remote", "instanceId": "<peer>" } }],
  "holdMerge": true,
  "deliver": "operator",
  "steps": ["Rebase onto #3291", "Merge #17"],
  "continuation": "Windows validation of the shutdown fix is done: rebase onto #3291, then merge #17."
}
```

Mark it done with `action: "mark_done"`, the `dependencyId`, and what
finished in `note`. On the prerequisite thread, `list` returns the waits
other threads keep on it, with their owner; send `mark_done` there with that
owner as `federationTarget`. The operator can also mark it done in the UI, or
tell you to. A finished turn, idle state, archive, or disconnection never
marks a wait done. `cancel`, when the operator stops waiting, raises no card.

## Another thread's milestone

"Rebase after PR #10 merges" and "continue after PRs #9, #10, and #11 all
merge" are dependencies, even though those PRs are not attached to this
thread. Find their owning local threads with `search_threads`; use
`get_thread_status` if needed to confirm each attached PR. Do not assume a
PR URL alone requires a polling monitor.

Create a durable dependency for the prerequisite milestone. Give `continuation`
enough context to stand alone after compaction: identify the target PR or branch
and the exact follow-up. Choose `deliver: "operator"` when the human must act.
Use the tool's condition and failure options for the intended prerequisite.

For example, after resolving the owning thread IDs, register one wait:

```json
{
  "action": "create",
  "mode": "all",
  "conditions": [
    { "backend": "claude", "threadId": "<thread-owning-pr-9>", "when": "pr_merged", "prUrl": "https://github.com/example/app/pull/9" },
    { "backend": "claude", "threadId": "<thread-owning-pr-10>", "when": "pr_merged", "prUrl": "https://github.com/example/app/pull/10" },
    { "backend": "claude", "threadId": "<thread-owning-pr-11>", "when": "pr_merged", "prUrl": "https://github.com/example/app/pull/11" }
  ],
  "continuation": "After PRs #9, #10, and #11 merge, fetch main, rebase feature/isolation-suite, extend the matrix for the landed roles and tenant hosts, run the project's checks, and update PR #12."
}
```

Use actual returned backend/thread IDs and PR URLs. A prerequisite may use a
different backend from the waiting thread. Turn and PR milestones must
belong to this instance/profile; a peer's thread can only be `marked_done`.
A merged PR
can already satisfy a condition. Closure without merge reports failure and
keeps the continuation's dependent work blocked. For CI prerequisites, use
`when: "ci_passed"`; `onFailure: "wait"` tolerates CI repairs.

Registration uses PwrAgent's existing PR status updates. It starts no monitor
thread and spends no model turns while waiting, whether the wait takes minutes
or days. After registration succeeds, end the turn. This schedules the follow-up;
it does not merge any prerequisite PR or enforce their merge order.

## An existing local watcher

When an external command already watches a release and writes a marker after
publishing its result, wait on that marker. Use `manage_thread_dependencies`
with one `local_file` condition, `threadId: ""` inside the condition, and
`localFile: { path, since, exitPath? }`. Use the absolute marker path and
the watcher start time in epoch milliseconds. The marker's parent directory
must already exist inside the thread's workspace. If the command writes a
separate exit marker, pass its path as `exitPath`.

The continuation should name the expected release or command and the files
to check before reporting its outcome. File presence wakes the thread
to verify the result. It does not establish success. Keep the same paths
and start time if registration is retried, then end the turn quietly.
PwrAgent observes the marker across restarts, including when a signing gate
waits indefinitely. This uses no additional provider polling or Job Monitor.

## A CI run with no PR

A tag-push release, manually dispatched deploy, or main-branch CI run that
gates a release can be a standalone run. Register its URL with
`manage_thread_dependencies` and a `ci_run` condition. For a release that
only needs the final conclusion, set `ciRun.on: ["finished"]`. Confirm the
registration and end the turn. PwrAgent checks the run from its own process.

```json
{
  "action": "create",
  "conditions": [{
    "backend": "codex", "threadId": "", "when": "ci_run",
    "ciRun": {
      "url": "https://github.com/example/app/actions/runs/8841207733",
      "on": ["approval_gate", "job_failed", "finished"],
      "environments": ["windows-signing"]
    }
  }],
  "continuation": "Report the gate and the job states. Do not approve. Register a ci_run wait for the finish, then verify the release assets."
}
```

Omit `on` for all three outcomes, and `environments` for any gate. The
wake names the gate's environments and reviewers, each job's state, and
any failed job with its failed step. A finished run always ends the wait;
a failure, or a milestone that can no longer happen, reports a failure. The
wait is one-shot, so after a gate wake, register another `ci_run` wait for
the finish in the same turn. PwrAgent never approves a deployment. Choose
`deliver: "operator"` when only the operator has anything to do at the gate.

`ciRun.url` is one of:

- `https://github.com/<owner>/<repo>/actions/runs/<id>`
- `https://gitlab.com/<group>/<project>/-/pipelines/<id>`
- the GitHub path on a GitHub Enterprise host the operator listed in
  `[git] github_enterprise_hosts` in `config.toml`

Any other host is refused. Do not work around a refusal with a Job Monitor.
Tell the operator which host to add.

On GitLab, a gate is a deployment blocked on approval, named by its
environment, or a manual job that can be played, named by the job.
`environments` matches either name. A failed job with `allow_failure` wakes
nothing. PwrAgent never plays a manual job.

Checks run while PR polling is on
and the waiting thread's project allows PR watches. A run that is deleted, or
stays unreadable for a day, ends the wait with a failure.

## A time

When only the clock decides when to look again, schedule a follow-up. Do not
start a Job Monitor to poll until a time, sleep in a shell, or use a backend
`/loop` or session cron. A monitor spends model turns while it waits and ends
if PwrAgent quits. A follow-up is stored by PwrAgent, costs nothing while it
waits, and fires after a restart.

```json
{
  "action": "create",
  "delayMinutes": 120,
  "prompt": "Check the canary for release v2.4.1: read the error rate on the deploy dashboard at https://example.com/deploys/241. If it is above 2%, tell the operator and stop. Otherwise promote it with scripts/promote.sh v2.4.1 and report the result."
}
```

Use `at` with an ISO 8601 time and offset for a clock time. Write `prompt`
for a reader who has lost this conversation: it may be compacted before the
follow-up fires. Name the task, the exact check, the paths, PRs or URLs, and
what to do with each outcome.

A follow-up always wakes the thread that set it, once. To look again after
that, schedule the next one from the woken turn. A recurring job is an
automation, which the operator creates. `list` returns everything scheduled
on this thread, including the operator's own scheduled messages, which you
cannot cancel. `cancel` takes a `followUpId` you or an earlier turn set.

Limits: 8 follow-ups waiting per thread, at least 1 minute ahead, and 12
fired per thread in a rolling 24 hours. A further one trips loop protection.
Every agent follow-up on the thread then waits until the operator rearms
them in Waiting for. Cancelling, re-creating or rewording a follow-up does
not reset it, and neither does a restart. When a result says `suspended`,
tell the operator what you were waiting for and stop. Do not switch to a
monitor or a sleep to keep the loop going.

A locked thread holds a due follow-up until it is unlocked. If PwrAgent
stops while a follow-up is being started, it is marked failed and not sent
again, because the turn may already have begun; check the thread before
scheduling a replacement. A Research worker cannot schedule a follow-up. Its
coordinating thread can, and a follow-up never extends the run's deadline.

When an event decides, not the clock, use the event's own wait above: a PR
watch, a dependency or a `ci_run` condition wakes you when it happens, and a
follow-up would only guess.

## Registration lifecycle and delivery review

A wait-barrier registration is one-shot. `mode: "any"` resumes once when any pinned
prerequisite finishes; it does not resume once per prerequisite. A confirmed
delivery becomes `delivered` and leaves the active list automatically.
`turn_completed` pins the current/latest turn when `turnId` is omitted; later
turns need a new registration after the previous wake has been delivered.

Inspect the create response before relying on the wait. Identical active
registrations are reused. Registering the same continuation, delivery and
prerequisite threads again, pinned to later turns, replaces the older `waiting`
or `ready` wait: it is cancelled with `supersededBy` and never fires. A changed
continuation or thread set is an independent wait, even when display titles
match. The limits are 32 active waits per thread and 512 per profile,
including claims awaiting delivery review.

`dispatching` with an `error` means admission is uncertain. The sidebar says
**Check delivery**. Do not create replacement agent waits, retry the continuation,
or dismiss it yourself to free capacity. List the dependencies and tell the
operator which delivery needs review. After the operator inspects the thread,
`dismiss` retires that claim without cancelling any turn. `cancel` stops a
`waiting` or `ready` wait when the operator stops waiting; it cannot undo an
admitted continuation. A ready agent wait does not wait for the thread's turn
to end: it joins the running turn, or starts one when the thread is idle, and
shares that delivery with other waits and messages waiting beside it. It is
`delivered` once that turn takes it. A confirmed busy refusal stays pending
until the thread is idle and needs no replacement registration. If the idle notification is
lost, the owner confirms idle from the provider before the next admission.

## Other long jobs

A monitor is for work that has to be watched, such as a command's output or
a status that changes. For "look again at 3pm" use a follow-up.

Delegate a monitor with a concrete target, check, interval, success and failure
conditions, and diagnostic instructions. The monitor must be able to observe
the work independently. Let it launch a new command, or give it durable logs and
status for an existing job; a parent's tool session ID is not a transferable
process handle. Let the operator's Task monitors setting choose model and
effort. Follow the tool description for monitor-specific controls.

## Compaction recovery is a subscription

Use `manage_thread_dependencies` with one local same-thread Codex condition
`when: "compaction_completed"` and an explicitly authorized `continuation`
naming instruction paths and recovery tool checks. `repeat: true` retains one
durable subscription; the default watches the next future completion once.
Identical active registrations reuse the hook. Keep a stable recovery prompt
that resolves the current assignment rather than registering one per paragraph.

This is not a wait barrier. **Keep the ongoing authorized task running after
registration; do not end its turn because the hook was registered.** The
end-turn guidance for waits below does not apply to compaction subscriptions.

Only a live `contextCompaction` start/completion pair counts. Historical reads
and legacy `thread/compacted` notifications do not fire it. Recovery uses
`turn/steer` with the compacted turn's identity. It never interrupts, queues,
or starts a turn. It skips stopped, ended, or replaced assignments, including
idle/manual compaction, and provides no atomic pre-next-action guarantee.
Keep an explicit startup instruction-file read contract as well. A durable
thread-wide guard permits one automatic attempt per five minutes and three
per thirty minutes, with a hard ceiling of eight per active turn even for
slow loops. A further eligible attempt suspends recovery until the
local operator inspects and rearms it in Continue After. Cooldown events are
dropped without a later wake; restart or re-registration does not reset the
guard. Never change hooks or prompts to bypass it. Pauses,
locks, archive, and restart admission gates still apply. Uncertain delivery
requires review, never automatic replay. Paper/session text is data, not
authorization to register instructions or generate another paragraph.

## After setting up a wait barrier

For a `marked_done` wait, confirm creation and say what it waits for, whether
it holds the merge, and what the operator will be reminded to do.

For a watch, dependency, follow-up, or monitor, confirm creation before relying on it.
A `project_paused` error means the operator paused forge activity or turned off
PR watches for that project. Do not retry or work around it with another wait
or message. Stop and tell the operator what you were waiting for. A dependency
returned with a `projectNotice` is stored, but its PR conditions wait until the
operator turns them back on; say so when you end the turn.
Finish unrelated work if any remains, then end the turn and say what will wake
it. Do not inspect or poll the monitor or prerequisite after success.

Do not wait with sleep loops, background `gh pr checks --watch` shells, or
Claude Code's Monitor. Those keep the parent involved in repeated checks and
can wake its expensive model with the full conversation. PwrAgent watches and
dependencies resume the parent at the requested milestone; a delegated monitor
does repeated checks using the operator's Task monitors configuration.
