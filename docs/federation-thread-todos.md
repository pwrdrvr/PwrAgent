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
Sparse mounted-thread subscribers receive their own invalidations; remote
windows receive the owner's full invalidation stream. Gateway relay, subscription
filtering, and reconnect use the existing event machinery. The viewer converts
these notifications into To-do refresh markers. Peer-status transitions also
refresh the queue, and navigation mount changes trigger another read.

No remote To-do or review state is copied into the viewer's database. The routing
and invalidation paths add no SQLite writes; mutations use the existing owner
services and their write budgets.
