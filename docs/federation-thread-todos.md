# Federated To-dos and tracked reviews

To-dos and tracked review findings remain in the thread owner's profile database.
Remote windows read that owner's queue. A local window combines its local queue
with exact-thread reads for its mounted remote pins, excluding revoked pins.
Unrelated remote threads are not enumerated. An unavailable mounted owner does
not prevent local cards from loading; an explicitly targeted read or mutation
fails without falling back to local state.

Owners advertise the additive `thread_todos` capability. Both ends must support
it; older owners produce an update-required error for targeted calls. Existing
pairings advertise the capability on reconnect; re-enrollment is unnecessary.

| RPC method | Required capability | Behavior on the owner |
| --- | --- | --- |
| `threadTodos.list` | `thread_detail` | List cards, projected reviews, and merge preferences |
| `threadTodos.snapshot` | `thread_detail` | Open cards at the owner feed's epoch and revision; needs `thread_todo_feed` on the owner |
| `threadReviews.list` | `thread_detail` | Read tracked findings and their resolutions |
| `threadTodos.listProjects` | `thread_detail` | List projects available to the card |
| `threadReviews.update` | `turn_control` | Address, decline, dismiss, or reopen findings/reviews |
| `threadTodos.resolve` | `turn_control` | Resolve or reopen a card, including projected reviews |
| `threadTodos.setItemChecked` | `turn_control` | Toggle a checklist step |
| `threadTodos.setProject` | `turn_control` | Change the card's target project |
| `threadTodos.runAction` | `turn_control` and `environment_actions` | Merge or start a thread using the owner's workspace, configuration, and credentials |

Wire parameters use the shared To-do/review request contracts with
`federationTarget` removed. Owner handlers reject a target field instead of
routing recursively. The viewer's IPC layer resolves the explicit target or the
remote window's owner before dispatch. Viewer card IDs have the opaque form
`remote-todo:<encoded instance ID>:<encoded owner-local card ID>`, preventing
collisions in React keys and pending actions. Only the original card ID travels
to its owner. Review lookups, mutation targets, pending-read keys, and navigation
counts also retain owner identity. Remote merge labels use the owner's
preferences; project menus list the owner's projects.

A local change publishes the small `thread/todos/changed` notification through
the existing subscribed backend event stream. It carries only an optional
backend/thread identity and a timestamp, and uses the `navigation` event class.
A companion `thread/todoDetails/changed` transcript marker reaches selected
thread-detail viewers without requiring navigation or pending-request control.
Sparse mounted-thread subscribers receive their own invalidations; remote
windows receive the owner's full invalidation stream. Gateway relay, subscription
filtering, and reconnect use the existing event machinery. Review details refresh
on these markers. The To-do queue follows the owner's snapshot and deltas,
which are described below. It falls back to these markers only for owners
that predate the feed.

## Snapshot and deltas

An owner keeps its open, eligible cards live in memory, as a Kubernetes
list+watch server does. The first snapshot seeds this state: every open card
and tracked review, plus one provider listing for owner eligibility. After
that, a card change re-reads only that thread's cards. Archive and delete
remove the owner's cards, and a rename retitles them. An unarchive or provider
refresh reads the listing again. A new thread has no cards, so the owner
reads the listing again only when a card names a thread the last listing
did not include. Each published card change increments the revision and
emits one `thread/todos/delta` event. The event names one thread and carries
the card upsert or removal plus merge preferences. A navigation-class event
reaches sparse mounted-thread subscribers only for their own threads.

Owners that advertise the additive `thread_todo_feed` capability answer
`threadTodos.snapshot`. They send deltas only to directly connected viewers
that advertise the same capability. A gateway that predates the feed would
classify the new event as transcript traffic and not relay it to a
navigation subscriber. Both ends therefore read the capability from the same
direct connection, and a relayed owner uses the list fallback. Owners still
publish the `thread/todos/changed` and `thread/todoDetails/changed` markers
for older viewers, relayed viewers, and review details.

The viewer's main process keeps one view per window kind. The main window
view contains the local feed and mounted remote threads. A remote window
view contains its owner's cards. Each window reads one snapshot at a view
revision, then applies one delta per card change. A window reads a new
snapshot only after a revision gap, a new epoch, a `resync` delta, or a
change to its mounted threads. The view follows a capable owner through
its deltas. A gap, a new epoch, a reconnect
(`federation/eventStream/changed`), or a peer-status change takes one new
owner snapshot. The viewer diffs that snapshot into deltas. An owner without
the capability is listed again on each marker, and that list is also diffed
into deltas. A mounted thread is listed when it is mounted and after a
reconnect. Between those reads, its owner's deltas or markers keep it current.
A remote view is dropped when no window shows its owner. A sparse stream
would otherwise appear to have revision gaps. Unavailable owners keep the
quiet `unavailableInstances` footnote. The Done list still lists with
`status: "all"` when it opens.

No remote To-do or review state is copied into the viewer's database. The routing
and invalidation paths add no SQLite writes; mutations use the existing owner
services and their write budgets.

## Operator requests and dispatch

The additive `operator_requests` capability exposes the owner queue alongside
To-dos. Remote windows read one owner's queue; main windows combine local
requests with exact reads for mounted threads. Approvals, MCP forms and URL
elicitations, blocking questionnaires, and async questions retain their owner in
item keys, thread keys, responses, project groups, and navigation links. Failed
owner reads and actions display their errors; they never fall back to a colliding
local thread. Owners without this capability require an update.

| RPC method | Required capability | Behavior on the owner |
| --- | --- | --- |
| `operatorRequests.list` | `thread_detail` | Read async questions and seen marks; scoped reads exclude unrelated item identities |
| `operatorRequests.listPending` | `pending_request_control` | Read pending approvals, MCP requests, and questionnaires |
| `operatorRequests.markSeen` | `thread_detail` | Record viewing metadata in one owner batch |
| `operatorRequests.reply` | `turn_control` | Admit an offscreen answer through the owner's start/steer/queue FIFO |

Pending requests are omitted for viewers without pending-request control, while
questions and review updates remain available with thread-detail access. Existing
server-request responses use the owner's pending-request API; dismissals retain
the `operator_questions` protocol. Handler inputs must be owner-local and cannot
forward to a third instance.

`thread/operatorRequests/changed` is a navigation marker for queue consumers;
`thread/operatorRequestDetails/changed` is its transcript companion for selected
thread-detail viewers. These contain no request content. Unscoped markers refresh
selected details when a seen batch or pending set changes. Existing reconnect and
stream recovery markers also refetch the queues. Viewers with both subscriptions
may receive both markers; in-flight reads coalesce refreshes.

Remote seen keys are `remote-operator:<encoded owner>:<encoded local item key>`.
Main dispatch splits one renderer batch by owner and strips that projection before
writing. Repeated marks and reads make no commits. The checked write budget is one
commit and 8,240 WAL bytes for a two-item owner batch: about 0.41 MB/day at 50
batches, with zero idle writes. No remote state is copied into the viewer database.

Fix-all, selected-finding, and single-finding dispatch retain the acceptance
promise through the compact stack. Refusal preserves the selected findings; a
pending dispatch cannot be submitted again. Programmatic reply/review requests
include owner identity, so switching between equal local and remote thread IDs
cannot send to the newly selected owner. A review-start acknowledgement resolves
the original owner's task even if navigation has changed in the meantime.
