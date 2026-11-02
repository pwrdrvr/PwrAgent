---
name: waiting-on-work
description: Use when waiting for CI, another PwrAgent thread, or a long job to finish, including Auto-fix PR coordination.
---

# Waiting on work

Choose the wait by what owns the work. Use the advertised tool description and
input schema for argument details and result semantics.

| Waiting for | PwrAgent workflow |
| --- | --- |
| CI on this thread's attached PR | `check_thread_pull_request_status`, follow `prAutomation.guidance`, then `watch_thread_pull_request` if a notification is needed. |
| Another local thread's turn or PR milestone | `manage_thread_dependencies` with `action: "create"`. |
| Any other long job or repeatable check | `create_monitor_delegation`. |

## This thread's PR

Check status once and follow the returned `prAutomation.guidance`. Attach the PR
with `attach_thread_pull_request` if branch discovery missed it. Use a watch for
CI success or failure, and include `merged` and `closed` in `notifyOn` when this
thread must clean up resources after the PR lands. Read the watch result: an
already terminal PR returns its outcome without creating a wait.

Auto-fix PR coordinates failure wake-ups with watches; avoid duplicate monitors.
A success watch can still be needed when Auto-fix is active. Follow the status
tool's description for `autoFixActive` monitoring ownership and repair-event
semantics, and follow the returned `prAutomation.guidance` for this PR.

## Another thread

Create a durable dependency for the prerequisite milestone. Give `continuation`
enough context to stand alone after compaction: identify the target PR or branch
and the exact follow-up. Choose `deliver: "operator"` when the human must act.
Use the tool's condition and failure options for the intended prerequisite.

## Other long jobs

Delegate a monitor with a concrete target, check, interval, success and failure
conditions, and diagnostic instructions. The monitor must be able to observe
the work independently. Let it launch a new command, or give it durable logs and
status for an existing job; a parent's tool session ID is not a transferable
process handle. Let the operator's Task monitors setting choose model and
effort. Follow the tool description for monitor-specific controls.

## After setting up the wait

Confirm the wait or monitor was successfully created before relying on it.
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
