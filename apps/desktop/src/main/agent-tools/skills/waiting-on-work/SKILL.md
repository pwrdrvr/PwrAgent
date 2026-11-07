---
name: waiting-on-work
description: Use when waiting for CI, another PwrAgent thread, or a long job to finish, including Auto-fix PR coordination.
---

# Waiting on work

Choose the wait by what owns the work. Use the advertised tool description and
input schema for argument details and result semantics.

| Waiting for | PwrAgent workflow |
| --- | --- |
| CI or merge of this thread's attached PR | `check_thread_pull_request_status`, follow `prAutomation.guidance`, then `watch_thread_pull_request` if a notification is needed. |
| Another local thread's turn, passing CI, or PR merge | `manage_thread_dependencies` (the **Continue After** UI) with `action: "create"`. Use `mode: "all"` for several prerequisites. |
| Work that finishes only when someone says so, before merging or before the operator acts, including a peer's thread or work outside PwrAgent | `manage_thread_dependencies` with a `marked_done` condition. |
| A long job or repeatable check that neither workflow covers | `create_monitor_delegation`. |

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

## Other long jobs

Delegate a monitor with a concrete target, check, interval, success and failure
conditions, and diagnostic instructions. The monitor must be able to observe
the work independently. Let it launch a new command, or give it durable logs and
status for an existing job; a parent's tool session ID is not a transferable
process handle. Let the operator's Task monitors setting choose model and
effort. Follow the tool description for monitor-specific controls.

## After setting up the wait

For a `marked_done` wait, confirm creation and say what it waits for, whether
it holds the merge, and what the operator will be reminded to do.

For a watch, dependency, or monitor, confirm creation before relying on it.
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
