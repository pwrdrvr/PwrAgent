# Scheduled thread actions

Scheduled messages and reviews are main-process work. A renderer or messaging
adapter may create, edit, cancel, send, and project an action, but it does not
own the clock or decide when the action enters a backend.

## Boundary

The durable boundary is `ScheduledThreadActionService`, backed by
`scheduled_thread_actions` in the profile state database. The service atomically
claims due actions, then hands turns to `ThreadTurnQueue` and reviews to the
registry's review admission path. It publishes lifecycle events after every
state transition. Desktop chips and messaging confirmations are projections of
that state.

```text
Desktop composer ─┐
                  ├─ create/update/cancel/send-now ─> Scheduled action service
Messaging command ┘                                      │
                                                         ├─ due turn ─> ThreadTurnQueue
                                                         └─ due review ─> review admission

Registry lifecycle event ─> scheduled action state ─> desktop/messaging projection
```

Focusing a window, selecting a thread, mounting a composer, or receiving a
React timer tick has no role in dispatch. Closing every renderer window does
not stop the main-process timer.

## State model

- `scheduled`: durable and editable; eligible for atomic claim at
  `scheduledFor`.
- `dispatching`: claimed by one service instance; no longer editable.
- `queued`: accepted by the registry but waiting behind an active turn.
- `started`: handed to a backend turn or review.
- `cancelled` / `failed`: terminal.

Each admitted action has a stable queue identity. Multiple scheduled reviews
behind one active turn keep distinct pending IDs; the registry chains them
across review terminal events instead of deduplicating or starting them
concurrently.

Queued registry work is re-admitted from its durable action after a main-process
restart because the registry FIFO itself is in memory. An action interrupted in
the narrower `dispatching` window is marked failed instead: whether the backend
accepted it is ambiguous, so automatic replay could duplicate operator work.

## Surface contract

Desktop IPC and the messaging backend bridge expose the same operations:

- list active actions, optionally scoped to a backend and thread;
- create a message or review;
- update an action that is still `scheduled`;
- cancel a scheduled or registry-queued action;
- atomically claim and send a scheduled action now.

Messaging exposes these operations as `/schedule` and `/scheduled` commands.
Provider adapters register those commands where the provider has a native
command catalog. All messaging mutations are scoped to the conversation's
bound thread before resolving an action ID.

## Related ownership audit

| Feature | Owner | Assessment |
|---|---|---|
| Immediate queued turns | `ThreadTurnQueue` in the backend registry | Correct. Desktop and messaging submit immediately and only project queue state. |
| Steering | Backend registry / backend client | Correct after payload preparation. If the target turn ends during preparation, the payload is registered as an immediate scheduled action instead of waiting for a renderer release. |
| Reviews behind active turns | Scheduled action service, then registry review admission | Correct. The renderer no longer waits for idle to release a review. |
| Scheduled messages and reviews | Scheduled action service | Correct. Durable clock and lifecycle are independent of GUI focus. |
| Messaging input debounce/admission | Main-process messaging controller | Correct. It is independent of renderer presence. |
| Automations | Main-process automation scheduler | Correct. It already owns persistence, timers, and execution admission. |
| PR auto-fix dispatch | Main-process PR auto-dispatch service | Correct. It already persists candidates and owns its timer. |
| Composer drafts and attachment preparation | Renderer draft store | Appropriate. These are unsent operator edits, not accepted work. |
| Launchpad drafts | Renderer / overlay draft storage | Appropriate until a thread or turn is submitted. |

The test contract should continue to distinguish an unsent draft from accepted
work: once PwrAgent displays an item as queued or scheduled, a main-process
service must be able to account for and advance it without a renderer.
