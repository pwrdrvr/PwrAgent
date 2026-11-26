# Operator alert history

In **Settings → Troubleshooting → Operator alerts**, **Copy Alert History**
copies the current desktop profile's history as JSON. Version 1 contains a
capacity, cumulative eviction and dropped-observation counts, and up to 512
alerts in reverse admission order. Each alert contains a fixed category, a
surface, and the first observed time for each recorded milestone. Times are
Unix milliseconds in UTC.

## Producer paths

| Producer | History boundary |
| --- | --- |
| Pending approvals, CI approvals and Job Monitor wakes | `useApprovalNotices` and `useJobMonitorWakeNotices` supply durable cards to `AppNoticeStack`. |
| Provider startup and sign-in, stream and turn errors, recovery, configuration, messaging platform errors, federation shutdown, GitHub access, updates, model verification and cost alerts | Owner events and renderer reads feed `App` and `appNoticeReducer`. The stack records the committed cards after reducer coalescing and transient-slot replacement. |
| Navigation and thread actions, archive and worktree operations, diagnostic results, voice, and composer feedback | Their producers supply the reducer or the additional toast inputs to the same stack. |
| Queue quit blockers, minimized maintenance, and agent thread renames | Their standalone `AppNoticeToast` instances record display, dismissal and supported actions. |
| Update progress and restart offers, minimized handoff progress | `AppUpdateBanner` and `LiveThreadHandoffToastCard` report their own committed cards and actions. |
| OS attention, approvals and terminal turn outcomes | `BackendRegistry` calls the desktop owner notification port. `DesktopNotificationService` owns eligibility, pending-key deduplication, routine turn cooldown and the Electron `Notification` callbacks. |

Toast `queued` means a card entered the committed stack. `displayed` means
the card rendered in a window. The pageable queue displays its selected
durable card. A standalone card starts at `displayed`.
`dismissed` records an explicit dismissal or group dismissal, `expired` a
countdown, and `withdrawn` a card leaving the committed stack or a tracked
progress surface in one window. Closing or reloading a window produces no
synthetic acknowledgement. `action-invoked` describes a control selection
and leaves the underlying operation's result to its owning feature.

Native `submitted` records entry to the Electron display path. Only Electron's
`show` callback records `displayed`. `failed` covers the failure callback or
a synchronous display error. An eligible notification on an unsupported
platform records `unsupported`. Native click, action, close and owner
clear each have their own milestone. Close alone provides no evidence of
operator acknowledgement. Disabled, focused, duplicate, and rate-limited
attempts that return before submission remain governed by the existing
native policy. An absent milestone means the app received no such observation.

## Profile, privacy and bounds

The desktop main process stores records in the active profile's
`state/state.db`. Local main windows share it, including separate processes
opening the same profile through SQLite WAL. The read path takes a single
database snapshot. Bootstrap and headless sessions have no desktop history
collection, and federation viewers have no history IPC access.

Toast IDs stay out of persisted evidence. The recorder hashes them before
buffering and keys correlation with a profile-local random salt. The same
surface, category and toast identity share first milestones across window
redeliveries and restarts while retained. After a dismissal, expiry or
withdrawal, a fresh queue or standalone display more than 30 seconds later
can start a new occurrence for a reused UI slot. That window intentionally
merges quick repeats of the same slot. A native attempt starts its own row
after the existing native gates. Outcome-only observations cannot recreate
evicted rows.

An explicit allowlist shapes the export. It contains no correlation keys,
thread identifiers, notice titles or bodies, raw provider messages, paths,
account details, or credentials. Inline banners and provider messages sent
through messaging integrations are outside the desktop toast and native
display surfaces. This history begins when collection is installed.
Diagnostic log rotation is independent. Logs cannot recover alerts that never
emitted a log.

The recorder batches up to 256 observations, with a five-second flush when
the batch is smaller. Export and graceful teardown flush pending observations.
An abrupt exit can lose the pending batch. The same transaction applies
milestones, trims the oldest rows and updates the eviction count. If repeated
storage failures exhaust the bounded queue, a later successful flush
includes the number of overflowed observations.

The checked-in write budget measures one transaction and 16,512 bytes of WAL
growth for a burst of two toasts and one native failure, including first-use
salt. At one such burst per minute for an eight-hour session, that sample
projects to about 7.9 MB of WAL writes per day. WAL growth varies with the
pages touched and checkpoint timing.
