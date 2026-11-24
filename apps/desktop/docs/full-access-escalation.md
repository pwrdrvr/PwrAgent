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
- A start card's Access menu shows the access the new thread gets, derived by
  `resolveThreadTodoStartAccess` (`packages/shared/src/thread-todo-access.ts`),
  the same function the owner's start runs, and offers only the destination's
  modes: PwrAgent modes, or an agent's own modes (Antigravity's Default /
  Accept Edits / Auto / Plan, Kimi's Yolo). The agent's own modes come from
  `acpRuntimeModeSelector` (`packages/shared/src/acp-permission-mode.ts`),
  the selector the composer's mode picker also reads, and the start writes the
  pick through it. A pick is stored on the card
  through `setThreadTodoAccess`, never held only in the window. A native pick
  stores its level as the card's mode, so Yolo is stored at Full Access and
  the start passes this gate; `seenNativeAccessMode` makes the owner refuse a
  start whose stored pick changed. An agent's `update_todo` that names a mode
  drops the operator's native pick.
- Messaging surfaces deliberately do NOT share this gate. An escalation
  requested over Telegram or Discord is made by a remote actor, so
  `MessagingAccessControl.ensureFullAccessEscalationAllowed` gates it on the
  `thread.execution.full_access` permission, the operator's `warningPolicy`,
  and a per-contact dismissal. The desktop-local preference is the operator's
  own acknowledgement and must never dismiss a contact's warning.
