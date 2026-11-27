# Full Access Escalation

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Full Access Escalation

- Every renderer surface that can raise a thread's execution mode routes the
  selection through `useExecutionModeSelection`
  ([lib/useExecutionModeSelection.tsx](../src/renderer/src/lib/useExecutionModeSelection.tsx)),
  never through `desktopApi.setThreadExecutionMode` directly. The gate owns the
  "Enable Full Access?" confirmation and the dismissed-forever preference; a
  surface that calls the API itself is a one-click, un-gated escalation, which
  is what the Star Map chat card's settings chip was while the dialog lived
  inside `Composer`.
- The access picker (`AccessPicker`) confirms inline instead of opening the
  dialog. The composer and the Star Map chat card's strip use it: choosing the Full Access stop shows Allow Full Access and Cancel
  under the level bar, and the level does not change until Allow. It asks the
  gate's `requiresConfirmation` whether to show them and commits through its
  `confirmExecutionModeSelection`, so the gate still owns the rule and the
  dismissed-forever preference (a dismissed warning commits the stop at
  once). Its stops are ordered by `orderProviderAccessOptions`
  (`packages/shared/src/provider-access-levels.ts`): Plan < Default <
  Accept Edits < Auto < Full Access. The dialog remains for a surface that
  does not confirm inline, such as Start on a to-do card.
- A surface with a live settings snapshot (the main window's `App`) passes
  `dismissed` / `onDismiss`; anything else lets the gate read and write the
  preference itself.
- An agent never raises access itself (`checkAgentAccessRequest`). When it
  needs a thread with more access than its own, it proposes a `start_thread`
  to-do card at that mode, as the Voice and Star Map managers are told to.
  Starting the card is the operator's escalation, and runs through
  `useThreadTodoFullAccessGate`, which wraps this same gate. The gate judges
  the window's copy of the card, so the run carries the access it showed
  (`seenExecutionMode`) and the owner refuses the start if the stored card
  changed since; an agent's `update_todo` cannot slip a raise in between.
- A start card's access picker (`AccessPicker` at `size="card"`, its options
  adapted by `todoAccessControl`) shows the access the new thread gets, derived by
  `resolveThreadTodoStartAccess` (`packages/shared/src/thread-todo-access.ts`),
  the same function the owner's start runs, and offers only the destination's
  modes: PwrAgent modes, an agent's own modes (Kimi's Yolo), or Antigravity's
  single unified access list (Default Access, Accept Edits, Auto, Plan, Full
  Access). Every surface reads the same provider access model
  (`resolveProviderAccessControl` in
  `packages/shared/src/provider-access-mode.ts`), so no provider ever renders
  two overlapping access/mode controls. Antigravity's Full Access runs on the
  Full Access process in default native mode (never silently in Plan). A pick
  is stored on the card through `setThreadTodoAccess`, never held only in the
  window. Choosing a stop never asks: it only stores the level, and Start
  confirms it through the gate. Each stop stores exactly the level it shows,
  so the stops drawn as Full Access are the ones Start confirms. A native pick stores its level as the card's mode, so Yolo is stored
  at Full Access and the start passes this gate; `seenNativeAccessMode` makes
  the owner refuse a start whose stored pick changed. An agent's `update_todo`
  that names a mode drops the operator's native pick.
- Messaging surfaces deliberately do NOT share this gate. An escalation
  requested over Telegram or Discord is made by a remote actor, so
  `MessagingAccessControl.ensureFullAccessEscalationAllowed` gates it on the
  `thread.execution.full_access` permission, the operator's `warningPolicy`,
  and a per-contact dismissal. The desktop-local preference is the operator's
  own acknowledgement and must never dismiss a contact's warning.
