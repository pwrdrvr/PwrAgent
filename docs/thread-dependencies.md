# Durable thread dependencies

`manage_thread_dependencies` registers one-shot prerequisites for a local
thread. The thread ends its turn after registration; PwrAgent evaluates
prerequisites from provider turn boundaries and its existing PR status bus.
There is no Job Monitor, model-driven polling, or new timer.

```json
{
  "action": "create",
  "conditions": [
    { "backend": "codex", "threadId": "foundation", "when": "ci_passed" }
  ],
  "mode": "all",
  "onFailure": "wait",
  "continuation": "Continue the previously authorized dependency upgrades."
}
```

`backend` and `threadId` identify the waiting thread and default to the
trusted calling thread. `action: "list"` returns its registrations and
evidence, plus `dependents`: active registrations on other threads that wait
on this one. `action: "cancel"` requires `dependencyId` and cancels a
registration before admission. A condition may carry a display-only `title`
(at most 200 characters). It is excluded from deduplication, and the
continuation prompt names the prerequisite by it.

The desktop uses the same service from Thread Info's **Continue after**
section. Searching adds a prerequisite row per chosen thread, each with its
own condition; threads already waiting on this one are not offered. Active
registrations show one line per prerequisite with its state, and finished
ones collapse under **History**. The prerequisite thread lists its dependents
under **Waiting on this thread**, and every change notifies the waiting
thread and each prerequisite thread. A continuation turn is labeled
**Continue after** in the transcript.

## Conditions

| `when` | Readiness |
| --- | --- |
| `turn_completed` | The pinned turn completed successfully. Omitted `turnId` pins the current or latest turn during registration. Failed/cancelled turns report failure. |
| `pr_attached` | A reviewable primary-workspace PR exists. Drafts remain pending. |
| `ci_passed` | Fresh status for the current head reports passing checks with no checks still running, no conflict, and no draft. A merge alone does not prove CI passed. |
| `pr_merged` | The selected PR merged. Closure without merging reports failure. |

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

## Persistence and admission

`thread_dependencies` stores the request, evidence, and lifecycle under the
PwrAgent profile's state database. Registration runs in an immediate SQLite
transaction: identical active requests deduplicate and new edges must not
create cycles. Dependencies are limited to sixteen conditions, thirty-two
active registrations per consumer, and 512 per profile. Completed edges no
longer constrain the graph. Federation dependencies are not supported yet.

The coordinator serializes local events and uses a SQLite compare-and-swap
to claim delivery across instances sharing a profile. Busy consumers retain
readiness; their terminal turn event retries admission after rechecking the
prerequisites. Dependencies schedule a continuation; they do not interrupt
an active turn or hold unrelated manual messages.

Watching/ready registrations survive restart and reconcile through the
provider protocol. Runtime code never reads Codex storage. An admitted turn
carries `dependencyId` in its message origin. That durable receipt can settle
a claim left incomplete by a crash.

Backend turn admission has no idempotency key. If a crash or transport error
leaves admission uncertain and no receipt exists, PwrAgent retains a visible
delivery-review state and does **not** replay the continuation. Inspect the
consumer before registering another dependency. `action: "dismiss"` (or
**Dismiss after review** in the UI) retires an uncertain claim after that
inspection; it does not cancel a potentially admitted turn. This provides at-most-once
automatic admission rather than claiming exactly-once delivery across an
unacknowledged backend request.

## SQLite write budget

The checked-in budgets cover dependency storage, excluding provider turn
setup: five boundary commits and approximately 49 KB of WAL for registration
through successful delivery (~4.9 MB/day at 100 dependencies). One hundred
unchanged PR observations plus one hundred thread events make zero commits,
including when the consumer is busy. Evidence timestamps alone never cause
a write. No dependency means no per-turn persistence.
