---
date: 2026-05-04
topic: thread-branch-drift-detection
---

# Thread Branch Drift Detection

## Problem Frame

A thread's "expected branch" (the git branch the user/agent intended to work
on) can diverge from the workspace's current "observed branch" (whatever
`git rev-parse --abbrev-ref HEAD` reports). When that happens we want to
surface a "Thread branch changed" dialog so the user can either retain the
expected branch or accept the new one.

Two recurring confusions have driven bugs in this code:

1. The expected branch may itself be `HEAD` (a thread created while the
   workspace was in detached-HEAD state). Excluding `expectedBranch === "HEAD"`
   from drift detection silently suppressed legitimate drift warnings even
   though the sidebar chip still rendered the `! now <branch>` indicator,
   producing an inconsistency between what the sidebar and the dialog say.
2. Mid-turn the workspace routinely passes through detached HEAD as a
   transient state — for example when an agent runs
   `git rebase origin/main`, which checks out commits in detached HEAD before
   reattaching to the original branch. Showing a drift dialog mid-turn for
   transient states is noisy and incorrect: by turn end the branch is usually
   back to the expected value.

## Evidence

- Backend drift computation lives in
  `apps/desktop/src/main/app-server/backend-registry.ts` in
  `checkThreadBranchDrift()` and `resolveExpectedThreadBranch()`.
- Renderer dialog gate lives in
  `apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx` in
  `canWarnForBranchDrift()`, `showBranchDriftDialog()`, and
  `checkSelectedThreadBranchDrift()`.
- Sidebar chip indicator lives in
  `apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx`.
- Drift checks are currently triggered in three places: thread focus,
  window focus, and `onBeforeStartTurn` (pre-turn submission).
- The `drifted` boolean is consumer-pure: it only gates the warning dialog.
  It does NOT trigger any thread reload from rollout, enrichment discard,
  or other state mutation.

## Requirements

**Drift Semantics**
- R1. A thread is "drifted" when the expected branch and observed branch
  are both known, are not equal, and the observed branch is a real named
  branch (not `HEAD`).
- R2. A thread with `expectedBranch === "HEAD"` and a named observed
  branch IS considered drifted. Going from detached HEAD to a named
  branch is a meaningful, user-visible change that the dialog must
  surface.
- R3. A thread with `observedBranch === "HEAD"` is NOT considered
  drifted. Detached HEAD on the observed side is treated as a transient
  state because that is what mid-rebase, mid-bisect, and similar git
  operations look like.
- R4. The sidebar drift chip and the drift dialog must agree on the
  drift predicate. Any change to one must update the other.

**Turn Lifecycle**
- R5. Drift detection must not trigger the dialog while a turn is active
  on the selected thread. Many turns rebase or otherwise pass through
  detached HEAD before reattaching to the expected branch by turn end.
- R6. Drift detection must run at end-of-turn (after the turn settles)
  to surface drift the agent introduced during the turn.
- R7. Drift detection must run on thread focus and window focus, but
  must defer the dialog if a turn is currently active for the focused
  thread.
- R8. The pre-turn drift check (`onBeforeStartTurn`) is allowed and
  desirable — it captures drift that accumulated before the turn
  started, when the workspace is stable.

**Consumer Purity**
- R9. The `drifted` boolean returned by `checkThreadBranchDrift` must
  remain a UI-warning gate only. It must not trigger thread reloads
  from rollout, enrichment discards, or any state mutation outside of
  what the user explicitly chooses from the dialog.

**Retention**
- R10. The "Retain Expected Branch" action persists the
  `(expectedBranch, observedBranch)` pair so future checks suppress the
  dialog for that exact pair. Retention is per-pair, not per-thread.
- R11. The "Update Expected Branch" action overwrites the overlay's
  `gitBranch` with the observed branch, eliminating drift.

**Single Gate (added 2026-05-04 after spec-flow analysis)**
- R12. Every dialog entry point must route through one gating
  function whose contract is: predicate(expected, observed) AND
  not-retained AND turn-not-active-on-this-thread. The reactive
  `useEffect` that opens the dialog directly from overlay state must
  not bypass this gate. There must be exactly one path that opens the
  drift dialog.

**Archived Thread Carve-Out (added 2026-05-04)**
- R13. Drift detection must be skipped entirely for archived threads.
  Archived workspaces intentionally land on a clean detached-HEAD
  snapshot ref (per the `2026-04-22-003-feat-thread-worktree-archive-restore-plan.md`),
  so any check would chronically false-positive. Archived state is
  determined from the thread overlay, not from git.

**Retention Scoping (added 2026-05-04)**
- R14. The retention store excludes pairs where `expected === "HEAD"`.
  These pairs represent a one-way transition (detached HEAD → first
  named branch the user/agent moved to) and should not be permanently
  silenced — each new "first named branch" is a meaningful, distinct
  decision the user should be asked about. Existing retained pairs
  with `expected === "HEAD"` are ignored on read (no migration
  required).

**Background Turn Completion (clarification of R6, added 2026-05-04)**
- R15. When a turn completes on a thread the user is not currently
  focused on, the end-of-turn drift check still runs and updates
  overlay state. The dialog does NOT pop on the focused thread —
  that would interrupt the user's current context. Instead, the
  sidebar chip (per R4) shows the new observed branch and the dialog
  fires when the user next focuses that thread.

## Anti-Patterns

- Excluding `expectedBranch === "HEAD"` from drift detection. This was
  the historical bug — it suppressed real drift for threads created in
  detached HEAD without telling the user, while the sidebar still
  flagged drift.
- Showing the drift dialog during an active turn. A rebase mid-turn
  will trigger a false positive that disappears by turn end.
- Adding side effects to the `drifted` boolean (reloads, enrichment
  resets, etc). The field is a UI gate.
- Letting the sidebar chip and the dialog disagree on the drift
  predicate. They must share the same definition.
