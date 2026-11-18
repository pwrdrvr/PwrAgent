# Thread-State Update Bus

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Thread-State Update Bus

When mutating persistent thread state (model, reasoning effort, fast mode,
permissions/execution mode, name, compaction), `BackendRegistry` MUST emit a
typed `AppServerNotification` from the mutation method on success. That
notification fans out through two existing listeners:

- **Renderer**: `apps/desktop/src/main/ipc/agent-ipc.ts:broadcastAgentEvent` →
  `agent:event` IPC → `desktopApi.onAgentEvent` → `useThreadNavigation`
  patches the navigation snapshot in place.
- **Messaging controllers**: `apps/desktop/src/main/messaging/messaging-runtime.ts`
  fans the event out to every `MessagingController.handleBackendEvent`,
  which routes thread-state methods to `refreshStatusSurfacesForThread`
  to re-render every binding's status surface on its channel.

This is what keeps Telegram, Discord, and the desktop UI in sync when any
surface changes a setting. The cross-surface refresh is automatic — do
NOT add ad-hoc IPC channels or per-controller refresh fan-outs for new
thread-state fields. Instead:

1. Add the new notification method to `AppServerNotification` in
   `packages/shared/src/contracts/normalized-app-server.ts`.
2. Emit from the registry mutation method via `await this.emit(...)`.
3. Add a handler branch in `useThreadNavigation`'s `onAgentEvent`
   subscription, mirroring `applyThreadModelSettingsUpdate` /
   `applyThreadExecutionModeUpdate`.
4. Add a method-name branch in `MessagingController.handleBackendEvent`
   that routes to `refreshStatusSurfacesForThread`.

Mutation handlers in `MessagingController` (e.g. `togglePermissionsMode`)
should NOT call `renderBindingStatus` inline for state that flows through
the bus — the bus is the single source of refresh, and an inline render
would be redundant. Update binding-local preferences before the registry
call so the bus-path render sees fresh prefs.

For binding-local mutations that do NOT flow through the registry
(e.g. `cycleToolUpdateMode`, `syncConversationName`), keep the inline
`renderBindingStatus` call — there's no bus event for those.

### Permission-mode queue events

A toggle of `executionMode` while a turn is active produces additional
notifications beyond `thread/executionMode/updated`:

- `thread/executionMode/queued` — fired when the registry queues a
  pending mode change instead of applying it immediately. Params:
  `{ threadId, queuedExecutionMode, queuedAt }`. Renderer patches
  `NavigationThreadSummary.queuedExecutionMode` and shows the queue
  indicator in the composer; messaging posts an audit message in every
  bound conversation with a Cancel button.
- `thread/executionMode/queueCleared` — fired on either `cancelled`
  (user clicked Cancel) or `applied` (turn ended and the queue
  flushed). Params: `{ threadId, reason: "applied" | "cancelled" }`.
  Renderer clears the queue indicator; messaging edits the previously
  posted audit message in place (or falls back to a fresh message if
  edit fails). On `applied`, this fires AFTER `thread/executionMode/updated`
  — clients should see the apply before the queue-clear so the UI
  transitions cleanly through "queued → applying → applied".

The persistent `permissionTransitionLog` on `ThreadOverlayState` (capped
at 100 entries, sqlite-backed) is the audit trail. Renderer materializes
log entries into the transcript as synthetic activity entries with id
prefix `permission-transition-`. The queue itself (`queuedExecutionMode`,
`queuedExecutionModeAt`) lives in registry memory only and is cleared on
app restart — that's intentional, since the active turn would have been
interrupted on shutdown.
