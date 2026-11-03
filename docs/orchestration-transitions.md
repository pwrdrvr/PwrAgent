# Orchestration transition ownership

Admission, activity, delivery, and content have independent lifetimes. These
small transition functions describe the boundaries that accept async results;
they do not replace serialization or provider lifecycle barriers.

## Queue admission

`queue-admission.ts` owns `idle → starting → acknowledged → idle` for each
backend/thread key. A symbol identifies each start or steer attempt. Only its
acknowledgement and settlement can change that attempt. A steer can be admitted
while a turn runs, so running-turn ownership remains separate.

Identified terminal notifications received during startup are matched against
the acknowledged turn ID. A matching completion prevents running-entry insertion
and publishes start then terminal exactly once. An unidentified idle notification
cannot prove which starting turn ended. Existing release serialization and its
failed-start idle replay continue to govern those signals.
Identified outcomes remain buffered through delivery of the started callback.
A rejected direct admission preserves its buffered failure holds; an acknowledged
start ignores buffered outcomes for other turn IDs.

A buffered failure also retains its error reason and applies the normal failure
hold before admission settles and dispatch resumes. Replaying a hold already
applied by an immediate release does not emit another held event.

FIFO contents, per-entry pause, queue hold, and dispatch suspension remain
independent of admission. Mutation tails still serialize edits. Failed queued
starts restore their position and require an operator retry.

## Renderer hydration

`thread-session-transitions.ts` owns request admission and settlement. Each latest
read carries its request version and the immutable live lifecycle revision captured
at admission. A newer read or retention eviction invalidates older responses and
older-page reads. Old settlement cannot clear a newer in-flight read. Versions
survive settlement because React may apply an enqueued update afterwards.

Response application checks request identity again inside the session updater.
A live turn or interaction change during the read leaves activity and pending
interactions under live ownership while allowing transcript hydration. A compatible
active status without a turn transition still allows the snapshot to supply a
missing turn ID or interaction. Active-turn and interaction transitions return
only their own fields; transcript ordering, retention, and content stay in the
existing reconciliation path.

## Runtime generations

| Owner | Identity and publication boundary |
| --- | --- |
| Codex client | `closeGeneration` invalidates work admitted before close. `serverGeneration` identifies a transport incarnation and rejects initialization after exit/replacement. Check both before publishing initialization results or readiness. The lifecycle barrier and active-request drain still order teardown and recovery. |
| Messaging runtime | Config changes and stop serialize through the runtime operation tail. Each `PendingAdapterStart` object identifies its channel's start; only its matching finalizer removes the registration. Cancellation races startup and does not stop the underlying promise: both late success and rejection must clean up the captured adapter. |
| Federation runtime | `connectionAttempt` owns a dial's finalizer; `connectionGeneration` fences client results and refresh callbacks. `walkEpoch` changes at stop and fences the entire endpoint walk, including stop followed by restart. Startup also captures the walk epoch before reading key material or binding a listener. These identities cannot substitute for each other. |

`durable-turn-request-service.ts` provides the persistence counterpart: submission
acknowledgement preserves a receipt already completed by lifecycle events, and
duplicate terminal observations do not write again. This refactor adds no SQLite
storage or writes; existing write-budget fixtures remain authoritative.
