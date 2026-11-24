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
- `held`: durable, and waiting for the operator instead of the clock. The
  timer never dispatches it, because `claimNextDue` selects `scheduled` rows
  only. It is not editable, because `update` accepts `scheduled` only.
- `cancelled` / `failed`: terminal.

`ScheduledThreadActionStatus` in
`packages/shared/src/contracts/scheduled-thread-actions.ts` lists these
states. The transitions are in
`packages/sqlite-storage/src/scheduled-thread-action-store.ts`.

An action becomes `held` in three ways:

- **At creation.** `create` stores an action with `manualReleaseRequired` as
  `held`, not `scheduled`. The stale-steer fallback creates such an action
  when the turn a steering message targeted ended before delivery
  (`apps/desktop/src/main/scheduled-actions/steer-turn-admission.ts`).
- **After dispatch.** `markHeld` moves a `dispatching` or `queued` action to
  `held` and sets `manualReleaseRequired`. The service calls it when the
  registry holds the queue entry, for example because the thread is locked,
  and when a release attempt does not start the turn
  (`apps/desktop/src/main/scheduled-actions/scheduled-thread-action-service.ts`).
  It records the holder: the scheduler whose in-memory queue keeps the entry,
  in `claim_owner` with no lease. Nothing renews it. When the hold is a
  thread lock it also stores `holdCause: "thread_lock"` in the payload. The
  build that wrote the refusal text classifies it, so no later build has to
  parse that text. A row an older build held has no cause, and its refusal
  text decides.
- **At recovery.** `recoverExpiredClaims` returns a recoverable expired
  `dispatching` action that has `manualReleaseRequired` to `held` and clears
  its queue entry. Its release had not been attempted, so nothing started.

Two operations take an action out of `held`:

- **Send now.** `claim` accepts `held` as well as `scheduled`, so `sendNow`
  moves the action to `dispatching` and dispatches it. A release that cannot
  start the turn returns it to `held` with the reason. When the holder has
  died, its queue entry is gone: `claimHeld` takes the action from that
  holder and forgets the entry, so the dispatch admits it again. A holder
  that is another live instance keeps it, and Send Now there is refused.
- **Unlock.** An unlock releases the lock's entries in the holder's queue.
  The queue announces each one as queued before it starts it, and
  `markHeldQueued` then moves the action to `queued` under the holder's lease.
  The start moves it to `started`.
- **Cancel.** `cancel` and `markCancelled` accept `held`.

A lock's hold lives in the holder's memory and dies with it. Every pass of
the due-action evaluation, which runs at launch, on the heartbeat and when the
restart gate opens, first looks for `held` actions whose cause is a thread
lock and whose holder is not alive. It reads an action's payload only once its
holder is found dead, and remembers a row that is not a lock hold until the
row changes. It claims each with `claimHeld`, which
succeeds only while the dead holder still holds it, so two instances cannot
both take it. The claim drops `manualReleaseRequired`, and the action is
dispatched as when it came due: a thread still locked holds it again in this
queue, and an unlocked one starts it. Other held actions, such as a stale
steering message, wait for the operator as before. This cannot start a turn
twice, because nothing leaves a holder's queue while its action is still
`held`. A quiet restart leaves ordinary scheduled lock holds to the scheduler.
When an operator separately paused a held entry, the checkpoint owns the
pause and unlock leaves it waiting for Resume. The checkpoint also owns
released entries still waiting in the FIFO, even if their old scheduler
lease has expired. Restore checks SQLite metadata without opening scheduled
payload files. A scheduler recovery claim removes a legacy lock-hold copy
in the same transaction, even when a reused PID blocks receipt recovery.

Each admitted action has a stable queue identity. Multiple scheduled reviews
behind one active turn keep distinct pending IDs; the registry chains them
across review terminal events instead of deduplicating or starting them
concurrently.

A scheduler's owner ID is `scheduler:<pid>:<token>:<instanceId>:<startedAt>`.
The last two are the process's profile runtime identity, the one Research
and automation runs record. An owner is alive while a fresh runtime marker of
the profile carries that identity, and dead once its process ID is gone. A
process ID that is alive with no matching fresh marker is unconfirmed: a live
owner whose marker aged out (the machine just woke, or its main thread was
busy), or a dead one whose process ID was reused. It counts as alive for
`SCHEDULER_OWNER_CONFIRMATION_GRACE_MS`, twice the marker's 45-second TTL,
from when this scheduler first saw it so, then as dead. That time is kept in
memory, so the rule writes nothing. An owner ID from an older build,
`scheduler:<pid>:<token>`, has no identity, and its process ID alone decides.
The same rule protects held actions and expired claims.

Only expired claims whose scheduler owner is no longer live are recovered,
so a second live process sharing the profile cannot take another instance's
work after a system suspend or event-loop stall. Queued registry work with a
recoverable expired lease is re-admitted from its durable action because the
registry FIFO itself is in memory. A recoverable expired action in the narrower
`dispatching` window is marked failed instead: whether the backend accepted it
is ambiguous, so automatic replay could duplicate operator work. Neither rule
applies to an action with `manualReleaseRequired`. A `dispatching` one returns
to `held` as described above. A `queued` one is marked failed: it is queued
only while its release is under way, and the release may have started it. Due actions
are claimed individually immediately before backend admission; later due work
stays scheduled if an earlier admission blocks.

## Agent follow-ups

An agent schedules a wake for its own thread with the `schedule_follow_up`
tool: create, list and cancel. A follow-up is an ordinary scheduled turn with
origin `agent`. The same service claims it, hands it to `ThreadTurnQueue`,
and recovers it after a restart. Nothing else decides when its turn starts,
so lock, project pause, archive and the restart gate apply as they do to an
operator's scheduled message.

- **Own thread only.** The thread comes from the tool call's trusted context.
  No argument names a thread, an actor or a role. `list` also returns the
  operator's scheduled actions on the thread; `cancel` refuses them.
- **One-shot.** A recurring job stays an automation.
- **The prompt stands alone.** The conversation may be compacted before the
  follow-up fires. The prompt lives in the action's payload file with every
  other scheduled input, never in SQLite.
- **Messaging.** A turn a messaging contact started needs
  `thread.control.schedule` to call the tool. The follow-up keeps that
  contact as the woken turn's causal source, so its tool calls are checked
  against the contact's role when it fires.
- **Research.** A Research worker is refused, as it is for `handoff_task`.
  The coordinating thread may schedule one. A follow-up starts a turn on the
  coordinator and changes no run's deadline or worker limit.
- **Only the tool writes origin `agent`.** `create` refuses that origin from
  the desktop, messaging and peer surfaces, which do not apply the limits
  below.

### Loop guard

| Limit | Value |
|---|---|
| Agent follow-ups waiting per thread (`held`, `scheduled`, `dispatching`, `queued`) | 8 |
| Minimum delay | 1 minute |
| Fired per thread in a rolling 24 hours | 12 |

A follow-up is counted as fired when it is claimed for dispatch. The claim
and its reservation in `thread_agent_follow_up_guards` commit in one
immediate transaction, so two owners cannot spend one allowance and a crash
cannot keep a claim without its reservation. A reservation is keyed by action
id: a follow-up that a lock held, and that is claimed again, reuses its slot.

A further claim inside the window trips the guard. The thread's agent
follow-ups then stay `scheduled` and are left out of the due query and the
timer, so a suspended thread costs no writes and blocks no other due work.
The operator's own scheduled actions on that thread still fire. The
suspension survives the window expiring and a restart. Only the local
operator's **Rearm follow-ups** in Waiting for clears it; an agent, a peer
and a federation window cannot. Cancelling, re-creating or rewording a
follow-up does not reset it. Waiting for shows the suspension and the rearm
even when no agent follow-up waits, such as after the operator cancelled the
stuck one. An agent may still create a follow-up while
suspended, up to the waiting limit. It waits with the others.

The window is anchored to the latest reservation time, which never moves
back, and a reservation stamped ahead of a rolled-back clock still counts.
A clock rollback cannot open the window early.

### Crash rule

One follow-up produces at most one admitted turn. An agent follow-up found
`dispatching` or `queued` under a dead owner's expired lease is marked
`failed` and never sent again. This is stricter than the rule for an
operator's action, whose `queued` claim is re-admitted: the in-memory queue
may have started the turn just before the owner died, and an agent's own wake
must not run twice. The failed action stays visible with its reason.

An unlock starts what a lock held without a new claim on the loop guard. The
release moves the `held` action to `queued` under a lease before the queue
starts it, so an owner that dies between the start and its record leaves a
`queued` action, which the next launch marks `failed`. This applies to every
origin, because the turn may have begun. An action a lock held when its owner
stopped is admitted again by the next launch, as described under the state
model, and starts once the thread is unlocked. The lifecycle model's oracle
is "a cancelled follow-up never ran" and "a held follow-up starts exactly once
after unlock, including across a restart".

### Budgets

`agent-follow-up-*` in `sqlite-write-budgets.json`: three commits for a
follow-up on an idle thread (create; claim with its reservation; started),
four when it waits behind an active turn, two for create and cancel. A trip
is one commit and a rearm is one. A suspended thread writes nothing. A lock's
hold costs one commit (`held`), its release one more than a direct start
(`queued`, then `started`), and a restart while held two (the claim from the
dead holder, and the new hold): seven for a follow-up held across a restart,
about 120 KB of WAL. Even 50 such actions a day stay near 6 MB/day. Looking for
orphaned holds on the heartbeat is a read; it writes only when it takes one.
`agent-follow-up.property.test.ts` holds the lifecycle model and the guard
property.

## Agent notices

An agent raises a notice for the operator with the `notify_operator` tool:
send, list and cancel. A notice is a scheduled action of kind
`notification` with origin `agent`, on the calling thread. A notice sent now
is due at once, so the same service claims and delivers it before the tool
returns; a scheduled one waits for the scheduler's clock like a follow-up,
survives a restart, and is delivered at the next launch if its time passed
while PwrAgent was closed. Title, body, urgency and the optional link live in
the payload file, never in SQLite.

- **No turn.** Dispatch hands the claimed notice to the owner's
  `AgentNotificationCenter` and marks it `started` (delivered). It starts no
  turn, so lock, archive and project pause do not hold it.
- **Exactly once.** A notice found `dispatching` under a dead owner is marked
  `failed`, as any dispatching claim is. It may have been shown; it is never
  shown twice.
- **Own thread only.** The thread comes from the call's trusted context. An
  agent cancels only its own thread's waiting notices. A Research worker is
  refused; its coordinator decides what reaches the operator. A messaging
  contact's turn needs `thread.control.schedule`.
- **Only the tool writes kind `notification`.** `create` refuses it from the
  desktop, messaging and peer surfaces, and `update` refuses to edit one.
- **Not a follow-up.** The follow-up guard counts and suspends `origin =
  agent AND kind <> notification` only. A notice never spends a follow-up
  slot and is delivered while the thread's follow-ups are suspended.
  `schedule_follow_up` lists a notice but cannot cancel it, and neither the
  composer queue nor messaging `/scheduled` shows one as a message.
- **Mixed builds.** A build from before notices that shares the profile
  treats any agent-origin scheduled row as a follow-up. If it claims a
  notice first, it marks the notice failed (no turn payload) and spends a
  follow-up slot. It cannot show the notice twice.

### Bounds

`[general.agent_notifications]` in the profile's `config.toml`; zero turns a
bound off. The counts and the insert are one immediate transaction. A window
counts every notice an agent created in it, cancelled ones too, so cancel
and resend cannot spend more.

| Key | Default |
|---|---|
| `max_per_thread_per_day` (rolling 24 hours) | 12 |
| `max_per_profile_per_day` (rolling 24 hours) | 60 |
| `max_scheduled_per_thread` (waiting) | 8 |

### Surfaces

- **Windows.** The center keeps the delivered notices the operator has not
  dismissed, in process memory, and publishes `agentNotifications/updated`.
  Each window shows them as durable cards in the notice stack and as a count
  on the masthead bell, which also lists scheduled notices with Cancel and
  the last day's delivered ones (read from the scheduler, so they survive a
  restart). Dismissing writes nothing; a restart clears read state.
- **Native.** `DesktopNotificationService.notifyAttention` with key
  `agent-notification:<id>`: only when Desktop notifications are on and no
  window is focused, deduplicated by key, cleared on dismiss.
- **Messaging.** The backend event router posts a delivered notice once to
  each conversation bound to the thread.
- **Federation.** The owner stores, times and shows a notice. The update
  event is not relayed, and a window showing a peer gets an empty snapshot.

### Budgets

`agent-notice-*` in `sqlite-write-budgets.json`: three commits per notice
(create; claim; delivered), two for create and cancel. About 62 KB of WAL
per notice: 3.7 MB/day at the default profile bound of 60, about 0.3 MB/day
at five. `agent-notification.property.test.ts` holds the delivery model and
the bound oracle.

## Surface contract

Desktop IPC and the messaging backend bridge expose the same operations:

- list active actions, optionally scoped to a backend and thread;
- create a message or review;
- update an action that is still `scheduled`;
- cancel a scheduled, held or registry-queued action;
- atomically claim and send a scheduled or held action now.

Messaging exposes these operations as `/schedule` and `/scheduled` commands.
Provider adapters register those commands where the provider has a native
command catalog. All messaging mutations are scoped to the conversation's
bound thread before resolving an action ID.

Federated actions cross the RPC boundary before admission and are stored and
timed by the thread-owning instance. Federation protocol v1 exposes all five
operations under the dedicated `scheduled_actions` capability. A remote window
or messaging binding must never fall back to a same-named local thread when the
peer is unavailable or does not advertise that capability.

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
