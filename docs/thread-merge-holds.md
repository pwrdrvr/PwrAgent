# Explicit merge holds

A merge hold records why a thread's work must wait before landing. It leaves
conversation, rebase, review, and CI repair available. It creates no to-do,
starts no thread, and schedules no continuation.

The thread menu's **Hold Merge…** opens the same state that agents manage
with `manage_thread_merge_holds`. Active holds appear in the sidebar, above
the transcript, and on merge cards. Each hold requires a reason and a
`releaseWhen` statement. An optional prerequisite thread may be on another
instance, including an instance that is currently offline.

```json
{
  "action": "create",
  "reason": "Waiting for Windows validation",
  "releaseWhen": "Reconcile the investigation findings with PR #17",
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
The desktop accepts a PwrAgent thread link in its optional dependency field.

`list` returns the thread's holds, their history, and active holds on other
threads that name it as a prerequisite. Reverse lookup includes connected
peers that grant `turn_control`; failures are reported in `unavailablePeers`.
The prerequisite thread can use the returned hold id and owner to resolve
that specific prerequisite. Offline owners retain their holds; a failed
lookup or failed resolution never clears them.

`resolve` requires `holdId` and a `note` explaining the findings that satisfy
`releaseWhen`. `cancel` also requires a note and means the operator removed
the prerequisite. The UI calls these **Resolve hold** and **Remove
prerequisite**. History retains the actor, time, and note. Repeated creates
and identical terminal actions are idempotent. Every hold must clear before
merging becomes available. Clearing holds never merges a PR.

Successful turns, idle state, archive, PR status updates, and disconnection
do not change a hold. Use [durable dependencies](thread-dependencies.md)
separately to resume after a deterministic milestone.

## Persistence and enforcement

Holds live in the waiting thread's PwrAgent overlay, with up to 32 active
holds per thread, 512 active holds per profile, and 100 retained terminal
entries per thread. Active holds protect the thread from automatic archive,
and archive cleanup retains the owner overlay until its holds are cleared. Mutations re-read under an immediate
SQLite transaction. Duplicate actions and reads make no writes. There are no
timer, per-turn, or streamed-event writes. The checked-in lifecycle budget
measures two commits and 28,872 WAL bytes for a create and resolve, or
approximately 1.44 MB/day at 50 lifecycles/day.

A hold binds the thread and the PR URLs attached while it is waiting. A PR
attached after creation is bound in the existing attachment write. Detaching
a PR does not remove that binding. Both agent forge merges and operator
merge-card actions re-read active holds at the provider boundary. Another
local thread cannot merge the same held PR. Numeric GitHub merge cards resolve
their URL before checking holds. Peer mutations execute on the waiting
thread's owner and record the authenticated requesting instance.

These guards cover PwrAgent merge actions. They do not install a GitHub or
GitLab required check and cannot prevent a merge performed outside PwrAgent.
