# Scheduled thread actions

Scheduled messages and reviews are main-process work. A renderer or messaging
adapter may create, edit, cancel, send, and project an action, but it does not
own the clock or decide when the action enters a backend.

## Boundary

The durable boundary is `ScheduledThreadActionService`. Scheduler metadata and
an opaque payload reference live in `scheduled_thread_actions`; accepted prompt,
attachment, path, and review content lives in atomic per-action files beside the
profile database, never in desktop SQLite. The service atomically claims due
actions, then hands turns to `ThreadTurnQueue` and reviews to the registry's
review admission path. It publishes lifecycle events after every state
transition. Desktop chips and messaging confirmations are projections of that
state.

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
- `dispatching`: claimed by one service instance under a renewable lease; no
  longer editable.
- `queued`: accepted by the registry but waiting behind an active turn. It
  remains owned by the same renewable lease while the in-memory registry holds
  it.
- `started`: handed to a backend turn or review.
- `cancelled` / `failed`: terminal.

Each admitted action has a stable queue identity. Multiple scheduled reviews
behind one active turn keep distinct pending IDs; the registry chains them
across review terminal events instead of deduplicating or starting them
concurrently.

Only expired claims are recovered, so a second live process sharing the profile
cannot take another instance's work. Queued registry work with an expired lease
is re-admitted from its durable action because the registry FIFO itself is in
memory. An expired action in the narrower `dispatching` window is marked failed
instead: whether the backend accepted it is ambiguous, so automatic replay
could duplicate operator work. Due actions are claimed individually immediately
before backend admission; later due work stays scheduled if an earlier admission
blocks.

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
| Steering | Backend registry / backend client | Correct after payload preparation. The main-process steer admission accepts the fallback payload in the same request and durably schedules it if the expected target is stale; React never decides or releases that fallback. |
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
