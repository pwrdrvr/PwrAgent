---
title: Fix Thread Branch Drift Detection
type: fix
status: active
date: 2026-05-04
origin: docs/brainstorms/2026-05-04-thread-branch-drift-detection-requirements.md
---

# Fix Thread Branch Drift Detection

## Enhancement Summary

**Deepened on:** 2026-05-04
**Sections enhanced:** Proposed Solution, Technical Considerations, System-Wide Impact, Implementation Phases, Risks
**Reviewers used:** Kieran TypeScript, Architecture Strategist, Code Simplicity, Julik Frontend Races, Pattern Recognition, Framework Docs Researcher, Best Practices Researcher

### Key Changes from Initial Plan

1. **Predicate package collapsed to one export.** Original plan had three helpers (`isBranchDrifted`, `isRetentionablePair`, `isThreadArchivedForDriftPurposes`); simplicity + Kieran reviews showed two were dead weight. Final API is just `isBranchDrifted`. Archived check inlines a `Boolean(thread.archivedAt)` in `resolveExpectedThreadBranch`. Retention filter inlines `expected !== "HEAD"` at one read site and one write site.
2. **`pendingBranchDriftRef` removed entirely.** Original plan deferred the suppressed dialog via a ref. Simplicity review showed the end-of-turn `useEffect` already runs a fresh IPC check that supersedes any deferred state. Removing the ref also kills two race conditions Julik flagged (stale read on thread switch, sibling-effect ordering).
3. **`"turn-end"` reason reused as `"focus"`.** No code branches on the new value; the existing `"focus"` reason already covers "user attention returning to a settled thread."
4. **R15 eager backend refresh dropped.** Original plan added a `turn/completed` hook in `BackendRegistry` to refresh observed branch on background threads. Architecture review flagged cohesion concerns; simplicity review showed the focus-path refresh covers the same case. Acceptable trade-off: sidebar chip on a non-focused thread is stale until next focus, at which point chip and dialog settle in the same tick.
5. **Race-condition fixes added to Phase 2.** Julik's review surfaced four concrete races in the new effect lifecycle: same-render falling-edge misfire across thread switches, multi-await stale closure in `checkSelectedThreadBranchDrift`, sibling-effect ordering, and reactive-overlay-vs-falling-edge same-tick collision. All four addressed inline in Phase 2 with explicit guards.
6. **Phase labels corrected.** Single-gate consolidation actually lands in Phase 2, not Phase 3. Phase 3 is archived-thread carve-out only.
7. **External validation added.** Research across Cursor, Aider, GitHub Copilot Workspace, VS Code Git extension confirms suppression-during-turn is ahead of the field — Cursor has multiple open bugs from reacting to transient mid-rebase ref states. Naming "branch drift" is appropriate (avoids "inconsistency" / "mismatch" anti-patterns).
8. **Deferred future work documented.** `useEffectEvent`, `useReducer` for dialog state, derived-state-during-render — flagged for follow-up rather than incorporated now, to keep this fix small and aligned with existing codebase idioms (which use `useRef` + `useEffect`).

Net scope reduction: roughly 30–40% smaller surface area, same R1–R15 acceptance.

## Overview

Refine the desktop app's thread branch drift detection so that:

1. Drift across the `HEAD` boundary is handled correctly on both sides
   (HEAD → named **is** drift; named → HEAD is **not**) — partially
   landed in this branch already.
2. The drift dialog is suppressed while a turn is active and re-checked
   when the turn settles (the rebase-mid-turn false-positive class).
3. The sidebar `! now <branch>` chip and the drift dialog share one
   predicate so they can never disagree.
4. Archived threads (which intentionally sit on a detached snapshot ref)
   are carved out of drift detection.

This addresses the original "sidebar shows drift but dialog never opens"
report and the broader "spurious branch dialog while the agent is
rebasing" class.

## Problem Statement / Motivation

The user reported (2026-05-04, see screenshot in conversation thread
`019df4a1-31c8-7e12-9dd8-af36a6a68bbf`) that the sidebar showed
`! now fix/release-skill-squash-merge` for a thread whose `expectedBranch`
was the literal string `"HEAD"` (Codex thread created during a detached
HEAD state). The drift dialog never appeared. Backend logs showed
`drifted=false` despite the sidebar chip rendering.

Root cause: an `expectedBranch !== "HEAD"` exclusion in three places
silently suppressed the dialog while the sidebar chip used a different
predicate that did not skip HEAD. That root cause is fixed in this branch
already (commit on `peaceful-mcnulty-efdbfa`).

While discussing the fix, a second class of issue surfaced: agents
frequently rebase mid-turn (`git rebase origin/main` detaches HEAD
transiently before reattaching). The drift dialog should not interrupt
mid-turn — it should fire at end-of-turn or on next focus.

A third class surfaced during spec-flow analysis: the reactive overlay
`useEffect` in `ThreadView.tsx` opens the dialog without going through
the imperative IPC path. Any new gating logic must live in a unified
gate or it leaks through this back-channel.

A fourth class: archived threads land on a snapshot ref in detached HEAD
(per `docs/plans/2026-04-22-003-feat-thread-worktree-archive-restore-plan.md`).
Drift detection currently has no carve-out and would chronically
false-positive once the dialog is allowed to fire.

### Research Insights — external tools

External survey (see references at end) confirms this class of bug is
common and the proposed approach is novel:

- **Cursor** has multiple documented bugs from reacting to transient
  mid-rebase ref states — silent stash/reset, force-deleting source
  branches when worktrees clean up, `.git/HEAD.lock` errors during
  rebase. None of them suppress drift UI during agent turns.
- **VS Code Git extension** acknowledges that `onDidChange` does not
  reliably fire on branch changes (issue #189316). Most consumers don't
  get fine-grained mid-rebase events at all, so transient detached HEAD
  passes without UI. We DO get the fine-grained signal (we run
  `git rev-parse` ourselves), so we have to suppress it deliberately.
- **Aider** sidesteps the question by auto-committing before each turn.
- **Cursor's worktree mode** (and competitors moving the same way)
  isolates the agent's checkout so user state is irrelevant. Our handoff
  + worktree story already does this; drift detection covers the
  remaining "user is editing the same workspace as the agent" case.
- The community-validated pattern for "turn started on A, ended on B":
  log it, surface a non-blocking indicator, never auto-prompt or
  auto-destroy. Matches our R6 (dialog) + R4 (chip) split.

## Proposed Solution

### High-level approach

1. **Extract a single shared predicate** `isBranchDrifted(expected, observed)`
   into `@pwragent/shared`. Renderer chip, renderer dialog gate, and
   main-process `checkThreadBranchDrift` all consume it. Satisfies R4
   (parity) and the predicate half of R12 (single gate).
2. **Add a turn-activity gate in the renderer.** A new `tryOpenBranchDriftDialog`
   wrapper consults `props.activeTurnId`. When a turn is active for the
   focused thread, no dialog opens. The IPC check still runs (so overlay
   observed branch stays fresh) but the dialog opening is short-circuited.
3. **Add an end-of-turn drift recheck** as a `useEffect` that watches a
   ref-tracked `{ threadKey, activeTurnId }` pair. On the falling edge
   (`activeTurnId` transitions defined → undefined while `threadKey`
   stays the same) the effect calls `checkSelectedThreadBranchDrift("focus")`
   which does a fresh `git rev-parse` and routes through the gate. R6.
4. **Unify the dialog entry path.** The reactive `useEffect` that
   currently calls `showBranchDriftDialog` directly from overlay state
   instead routes through `tryOpenBranchDriftDialog`. R12.
5. **Carve out archived threads** at `resolveExpectedThreadBranch`
   (returns `undefined` for archived threads). Both the chip predicate
   and the dialog gate already short-circuit on `expected === undefined`,
   so carving out at this single layer covers all surfaces. R13.
6. **Scope retention.** Reject pairs with `expected === "HEAD"` on
   write; filter them out on read. R14.
7. **Sidebar chip parity** comes for free once the chip uses
   `isBranchDrifted` — the helper already excludes `observed === "HEAD"`
   and short-circuits on archived threads via `gitBranch === undefined`.

### What is already done in this branch

- Removed `expectedBranch !== "HEAD"` from
  `apps/desktop/src/main/app-server/backend-registry.ts` (drift compute,
  twice).
- Removed `expectedBranch !== "HEAD"` from
  `apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx`
  (`canWarnForBranchDrift`).
- Captured requirements at
  `docs/brainstorms/2026-05-04-thread-branch-drift-detection-requirements.md`.

### What this plan adds

- Shared `isBranchDrifted` predicate in `@pwragent/shared`.
- Turn-activity gating + end-of-turn recheck in `ThreadView.tsx`.
- Reactive-effect unification through the imperative gate.
- Archived-thread carve-out at `resolveExpectedThreadBranch`.
- Retention scoping for `expected === "HEAD"`.
- Sidebar chip parity via shared predicate.
- Renderer + E2E test coverage for the new gates.

### Research Insights — predicate API design

- Return type stays `boolean`. R9 makes the predicate a UI gate, not a
  state machine; a discriminated union would just collapse to a boolean
  at every call site. (Kieran)
- Don't import `Pick<NavigationThreadSummary, ...>` into
  `packages/shared/` for an archived helper. Archival semantics live
  outside the predicate; inline the `Boolean(archivedAt)` check inside
  `resolveExpectedThreadBranch` instead. (Kieran, Architecture)
- Naming `isBranchDrifted(expected, observed)` matches existing
  predicate idiom (`isTerminalTurnLifecycle`, `isDesktopChatReplyComposer`).
  (Pattern Recognition confirmed against existing codebase.)

## Technical Considerations

### Where the shared predicate lives

New file: `packages/shared/src/contracts/branch-drift.ts`. Re-exported
from `packages/shared/src/index.ts`. Single export:

```ts
// packages/shared/src/contracts/branch-drift.ts
export function isBranchDrifted(
  expected: string | undefined,
  observed: string | undefined,
): boolean {
  if (!expected || !observed) return false;
  if (observed === "HEAD") return false;
  return expected !== observed;
}
```

Three call sites:

- `apps/desktop/src/main/app-server/backend-registry.ts` (drift compute,
  twice — replaces the inline expression already in the branch).
- `apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx`
  (`canWarnForBranchDrift` becomes a one-liner that calls the helper
  plus `branchDriftRetained`).
- `apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx`
  (chip predicate becomes the helper).

### Turn-activity gate

```ts
// pseudo - apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx
const tryOpenBranchDriftDialog = (params: {
  thread: NavigationThreadSummary;
  expected: string;
  observed: string;
  reason: BranchDriftDialogState["reason"];
  checkedAt?: number;
}): boolean => {
  if (props.activeTurnId !== undefined) return false;
  return showBranchDriftDialog(params.thread, params.expected, params.observed, params.reason, params.checkedAt);
};
```

Options-object signature avoids the `(observed, expected)` swap hazard
flagged by Kieran (both are `string`, TypeScript can't catch the swap).

The reactive overlay effect at `ThreadView.tsx:830` and
`checkSelectedThreadBranchDrift` both call this wrapper instead of
`showBranchDriftDialog` directly. R12.

### End-of-turn falling-edge effect

```ts
// pseudo
const previousTurnRef = useRef<{ threadKey: string; activeTurnId: string | undefined }>({
  threadKey: selectedThreadKey ?? "",
  activeTurnId: props.activeTurnId,
});
useEffect(() => {
  const previous = previousTurnRef.current;
  const current = { threadKey: selectedThreadKey ?? "", activeTurnId: props.activeTurnId };
  previousTurnRef.current = current;

  // Only fire end-of-turn check when:
  //   - thread did NOT change
  //   - activeTurnId went defined → undefined
  if (
    previous.threadKey === current.threadKey &&
    previous.activeTurnId !== undefined &&
    current.activeTurnId === undefined
  ) {
    void checkSelectedThreadBranchDrift("focus");
  }
}, [props.activeTurnId, selectedThreadKey]);
```

`reason: "focus"` is reused — no `"turn-end"` variant. Nothing else in
the dialog branches on reason except the special "turn" reason for the
pre-turn case.

The combined `{ threadKey, activeTurnId }` ref closes the race Julik
identified: when both deps change in the same render (user clicks a
different thread while a turn is mid-flight), the strict `threadKey`
equality guard prevents a spurious end-of-turn check from firing on
the new thread. Same-render thread switch just updates the ref and
bails.

### Stale-closure guard inside `checkSelectedThreadBranchDrift`

The existing function awaits IPC then awaits navigation refresh before
opening the dialog. If the user navigates away mid-await, the closure's
captured `thread` becomes stale. Add a check against a live
`selectedThreadKeyRef`:

```ts
// pseudo - inside checkSelectedThreadBranchDrift
const startedThreadKey = `${thread.source}:${thread.id}`;
const result = await props.desktopApi.checkThreadBranchDrift({...});
if (selectedThreadKeyRef.current !== startedThreadKey) return false;
if (result.observedBranch !== thread.observedGitBranch) {
  await props.onRefreshNavigation?.();
  if (selectedThreadKeyRef.current !== startedThreadKey) return false;
}
// ... continue with tryOpenBranchDriftDialog
```

`selectedThreadKeyRef` is established with the existing pattern used in
`useThreadSessionState.ts:1573` and `Composer.tsx:838` — no new helpers.
Pattern Recognition confirmed this matches codebase idiom.

### Archived-thread carve-out

`resolveExpectedThreadBranch` in
`apps/desktop/src/main/app-server/backend-registry.ts:290` gains:

```ts
function resolveExpectedThreadBranch(params: {...}): string | undefined {
  if (params.thread?.archivedAt) return undefined;
  // ...existing logic
}
```

That single change makes drift compute return `false` for archived
threads via `isBranchDrifted`'s undefined-short-circuit. The renderer's
`canWarnForBranchDrift` short-circuits on the same condition because
the IPC reply carries `expectedBranch: undefined`. The chip predicate
short-circuits on `gitBranch` from the renderer's overlay snapshot,
which `navigation-state.ts` will need a parallel guard in (verify
during Phase 3).

### Retention scoping

`branchDriftRetained()` in `ThreadView.tsx:740` adds a filter:

```ts
const branchDriftRetained = (thread, expectedBranch, observedBranch) =>
  expectedBranch !== "HEAD" &&  // R14: never silence (HEAD, *) pairs
  (thread.retainedBranchDriftPairs ?? []).some(...);
```

The IPC handler `retainThreadBranchDrift` in
`apps/desktop/src/main/app-server/backend-registry.ts` adds an
identical guard so we never persist a `(HEAD, *)` pair in the first
place. Existing rows in user state are tolerated and ignored on read.

### Research Insights — React lifecycle patterns

- The codebase idiom for "previous prop value" is **inline `useRef` +
  `useEffect`**, not a `usePrevious` hook. See `useThreadSessionState.ts:1573`,
  `useThreadNavigation.ts:827`, `Composer.tsx:838`. Stay with the
  idiom; do not introduce a custom hook for one site. (Pattern Recognition)
- React 19+ recommends `useEffectEvent` for "imperative function called
  from multiple effects, always sees latest state." The codebase has
  not adopted this yet. Defer to a follow-up plan once the codebase
  starts using it elsewhere; introducing a one-off `useEffectEvent` here
  would be inconsistent. (Framework Docs Researcher; deferred.)
- `useReducer` for dialog state would make "exactly one dialog open at
  a time" structural rather than convention. Architecture review
  recommended this; simplicity review pushed back as out-of-scope.
  Decision: defer to a follow-up. The current `useState` + the
  `tryOpenBranchDriftDialog` gate is sufficient if combined with the
  race fixes above. Note as future tech debt at PR time.

## System-Wide Impact

### Interaction graph

- **Pre-turn path**: Composer → `onBeforeStartTurn` →
  `checkSelectedThreadBranchDrift("turn")` → `tryOpenBranchDriftDialog`
  → (if drift and !activeTurnId and !retained) dialog opens → user
  retains/updates → submission proceeds. **Unchanged.** R8.
- **End-of-turn path (NEW)**: `props.activeTurnId` falling edge with
  `threadKey` stable → `checkSelectedThreadBranchDrift("focus")` →
  `tryOpenBranchDriftDialog` (gate clears since `activeTurnId === undefined`)
  → dialog opens if drifted. R6.
- **Focus path**: `selectedThreadKey` change OR window focus →
  `checkSelectedThreadBranchDrift("focus")` → `tryOpenBranchDriftDialog`
  → (gate may suppress if a turn is active on the focused thread).
- **Reactive-overlay path (CHANGED)**: was bypassing the gate; now
  routes through `tryOpenBranchDriftDialog`. Becomes a no-op while a
  turn is active. R12.
- **Background-thread completion (CLARIFIED)**: turn completes on a
  thread the user is NOT focused on. The renderer's per-thread session
  reducer clears that thread's `activeTurnId` but never propagates as
  ThreadView props for the focused thread, so the falling-edge effect
  does not fire (correct — we don't want the dialog popping on the
  current thread). The sidebar chip stays stale until the next focus
  event refreshes. On focus, the focus-path useEffect fires
  `checkSelectedThreadBranchDrift("focus")` and the dialog opens if
  drifted. R15. (This is the simplification: no eager backend hook.)

### Error & failure propagation

- `git rev-parse` failure already swallowed by
  `readCurrentGitBranch().catch()` in
  `apps/desktop/src/main/app-server/backend-registry.ts:310`.
  Unchanged.
- IPC `checkThreadBranchDrift` failure caught by the empty catch in
  `checkSelectedThreadBranchDrift` (`ThreadView.tsx:821`). Unchanged.
- New end-of-turn IPC call uses the same path, so same swallow.

### State lifecycle risks

- **No `pendingBranchDriftRef`**, so no cleanup ordering hazard between
  sibling effects. (Removed per simplicity review + race review.)
- **Stale-closure guard** added inside
  `checkSelectedThreadBranchDrift` prevents the dialog from attaching
  to an already-deselected thread.
- **Combined-ref equality guard** in the falling-edge effect prevents
  spurious end-of-turn checks during same-render thread switches.
- Retention dataset filtering happens on read AND write so a pair
  stored under the old logic doesn't permanently silence a user.

### API surface parity

`packages/shared/src/contracts/branch-drift.ts` is the only predicate.
Three call sites listed above. Audit for additional consumers during
Phase 1 implementation — repo research did not find others.

### Integration test scenarios

Cross-layer scenarios that unit tests with mocks won't catch:

1. **Mid-turn rebase**: launch a real turn on a fixture repo, rebase
   into detached HEAD, complete turn, observe no dialog mid-turn and
   correct dialog at end-of-turn. (E2E.)
2. **Same-render thread switch**: focus thread A with active turn,
   click thread B, observe NO dialog flashes. (Renderer integration.)
3. **Background turn completion + focus**: focus thread B, complete a
   turn on thread A, focus thread A, observe dialog opens. (E2E.)
4. **Pre-turn dialog blocks submit**: with drift present, hit submit;
   dialog opens; pressing "Update Expected Branch" resubmits cleanly.
   (E2E — already exists; verify not regressed.)
5. **Archived thread**: archive a thread that has drift, observe no
   chip and no dialog. (Renderer integration.)
6. **Retention with HEAD expected**: retain a `(HEAD, fix/foo)` pair
   (or attempt to — write should reject), trigger drift to
   `(HEAD, fix/bar)`, observe dialog still fires. (Renderer integration.)
7. **Mid-await thread navigation**: trigger drift check, navigate away
   mid-IPC, observe dialog never appears for the deselected thread.
   (Renderer integration.)

### Research Insights — external tools (carry from Overview)

Suppression-during-turn is novel relative to Cursor / Aider / Copilot
Workspace. Cursor has multiple open bugs from NOT suppressing. Status-bar
indicator + non-blocking dialog at turn-end matches the pattern used by
the `vscode-branch-warning` extension (which has a `suppressPopup`
setting that demotes warnings to the status bar).

## Implementation Phases

### Phase 1 — Shared predicate

**Files:**
- `packages/shared/src/contracts/branch-drift.ts` (new, ~12 LOC)
- `packages/shared/src/index.ts` (re-export)
- `packages/shared/src/contracts/__tests__/branch-drift.test.ts` (new)
- `apps/desktop/src/main/app-server/backend-registry.ts` (drift compute
  twice — replace inline expression)
- `apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx`
  (`canWarnForBranchDrift` calls helper)
- `apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx`
  (chip predicate calls helper; chip now suppresses for `observed === "HEAD"`)

**Deliverables:**
- Single export `isBranchDrifted(expected, observed): boolean`.
- Unit tests covering: both undefined; expected="HEAD" + observed named
  (drift); observed="HEAD" + expected named (no drift);
  expected===observed (no drift); both named differing (drift).
- Audit: confirm no other consumer of the predicate exists (document
  scan in PR description).

**Success criteria:**
- `pnpm --filter @pwragent/desktop run typecheck` passes.
- `pnpm test packages/shared` passes new unit suite.
- Existing `backend-registry.test.ts` and `thread-view.test.tsx`
  branch-drift suites still pass without modification.

**Independence:** standalone. Can ship as its own PR.

### Phase 2 — Single gate + turn lifecycle (R5, R6, R7, R12, race fixes)

**Files:**
- `apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx`
- `apps/desktop/src/renderer/src/features/thread-detail/__tests__/thread-view.test.tsx`

**Deliverables:**
- New `tryOpenBranchDriftDialog` wrapper (options-object signature)
  consulting `props.activeTurnId`.
- Reactive overlay `useEffect` (current line ~830) routed through the
  wrapper.
- Focus + window-focus useEffect (current line ~851) unchanged in
  trigger logic; the wrapper handles suppression.
- New `useEffect` watching `{ threadKey, activeTurnId }` falling edge
  via combined ref (per "End-of-turn falling-edge effect" above).
  Reuses `"focus"` reason — no new union variant.
- New `selectedThreadKeyRef` updated each render (or at the existing
  point if one already exists), consulted inside
  `checkSelectedThreadBranchDrift` to abort dialog opening if the user
  has navigated away mid-await.

**Tests:**
- "drift dialog suppressed during active turn" — render with
  `activeTurnId="turn-1"` and overlay drift state; assert dialog absent;
  rerender with `activeTurnId={undefined}` and assert dialog appears.
- "end-of-turn fires drift recheck" — mock `checkThreadBranchDrift`
  returning drifted=true; render with active turn → assert no dialog;
  transition `activeTurnId` → undefined → assert IPC called and dialog
  opens.
- "same-render thread switch suppresses end-of-turn dialog" — render
  with thread A focused and active turn; in one rerender flip both
  `selectedThread` to B and `activeTurnId` to undefined; assert no
  dialog opens for either thread.
- "navigation away during IPC await suppresses dialog" — mock
  `checkThreadBranchDrift` with a deferred resolve; trigger check on
  thread A; rerender with thread B selected; resolve the deferred
  promise; assert no dialog.
- "reactive overlay path respects active turn" — render with
  `activeTurnId="turn-1"` and update `selectedThread.observedGitBranch`
  to drift state; assert no dialog.

**Success criteria:**
- All new and existing renderer tests pass.
- Manual: launch dev app, start a turn that runs `git rebase HEAD~3`
  on a fixture repo, observe no dialog mid-turn and correct dialog at
  end-of-turn.

**Independence:** depends on Phase 1's helper for the predicate calls
inside the wrapper. Ship after Phase 1.

### Phase 3 — Archived carve-out (R13)

**Implementation finding (2026-05-04):** R13 is satisfied entirely by
R3's `observed === "HEAD"` short-circuit. No new code is required.

Investigation revealed:

1. **Archived threads are not in the navigation snapshot.** The
   navigation `listThreads` flow filters by `archived: false` by
   default (see `backend-registry.ts:2643` and
   `session-state.ts:89`). A thread that has been archived simply
   does not appear in `selectedThread` for the renderer, so neither
   the chip nor the dialog runs against it.
2. **Archive lives at the worktree, not the thread.** `archivedAt`
   exists on `WorktreeSnapshotSummary` (per-worktree) and the per-thread
   archived bucket on the backend. There is no top-level
   `thread.archivedAt` for the predicate to read, so the planned
   `Boolean(thread.archivedAt)` carve-out has no input.
3. **Restored archive worktrees land on detached HEAD.** Per the
   archive-restore plan, restoring a snapshot puts the workspace on a
   snapshot ref in detached HEAD. `git rev-parse --abbrev-ref HEAD`
   returns `"HEAD"` in that state, which the R3 rule already
   short-circuits. Both `isBranchDrifted("feature/x", "HEAD")` and
   the backend predicate return `drifted: false`.

**Deliverables (this phase):**
- New `backend-registry.test.ts` case
  `"does not flag drift when observed branch is HEAD (restored archived snapshot)"`
  that locks in R3 for the restored-archive scenario explicitly,
  preventing future regressions of the SpecFlow-flagged
  "saved by R3 but only by accident" concern.
- Documentation update in this plan recording the finding.

**Tests:** new test added in this phase; existing 46 backend-registry
tests preserved.

**Success criteria:**
- New test passes.
- No code change to `resolveExpectedThreadBranch`.

**Independence:** standalone documentation/test phase.

### Phase 4 — Retention scoping + E2E coverage (R14)

**Implementation status (2026-05-04):**
- Retention filter-on-read + reject-on-write: LANDED.
- Unit tests for both surfaces: LANDED.
- Turn-active E2E variant: DEFERRED to a follow-up. The existing
  branch-drift E2E was hand-rolled without using the seeding skill;
  extending it with `turn/started`/`turn/completed` notification steps
  is non-trivial (~250 LOC fixture-format study). Coverage of the
  active-turn gate is provided by the renderer unit tests added in
  Phase 2 (`suppresses the branch drift dialog while a turn is active`,
  `re-checks branch drift on end-of-turn falling edge`,
  `does not fire end-of-turn drift check when both thread and activeTurnId change in one render`).
  The trade-off: the IPC plumbing isn't smoke-tested for the turn-gate
  case end-to-end, but the gate logic itself is well-covered.

**Files:**
- `apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx`
  (`branchDriftRetained` filters via `expected !== "HEAD"`)
- `apps/desktop/src/main/app-server/backend-registry.ts`
  (`retainThreadBranchDrift` rejects pairs where `expected === "HEAD"`,
  silently — no log)
- `apps/desktop/e2e/thread-branch-drift.spec.ts` (extend with
  turn-active variant)

**Deliverables:**
- Filter-on-read in renderer (one-line addition).
- Reject-on-write in main process (silent — no debug log per simplicity
  review).
- New E2E test "suppresses drift dialog during active turn and surfaces
  on turn end" using the existing `createBranchDriftFixture` extended
  with `turn/started` and `turn/completed` notification steps. Use
  `apps/desktop/e2e/fixtures/turn-lifecycle/` as a reference for
  notification encoding.

**Tests:**
- Renderer: "retained (HEAD, X) pair does not silence later (HEAD, Y)
  drift" — preload retained pairs in mock, assert dialog still opens.
- Main process: `retainThreadBranchDrift` with `expected="HEAD"` does
  not persist (assertion against overlay-store mock).
- E2E: turn-active variant per above.

**Success criteria:**
- `pnpm test:desktop-e2e` passes including the new spec.
- All unit suites pass.

**Dependency note:** the E2E "turn-active" variant requires Phase 2's
gate to be in place. The retention code itself is independent. Can
split into Phase 4a (retention) and Phase 4b (E2E) if useful.

## Acceptance Criteria

### Functional Requirements (carry forward from origin R1–R15)

- [ ] R1 / R2 / R3: predicate returns drifted only when expected and
  observed are both known, observed is not "HEAD", and they differ.
  HEAD-on-expected counts as drift; HEAD-on-observed does not.
  (Already passes; Phase 1 preserves through shared helper.)
- [ ] R4: sidebar chip and dialog use the same shared predicate. Chip
  suppresses when observed is "HEAD".
- [ ] R5 / R7: drift dialog does not open during an active turn on the
  focused thread, regardless of which entry path triggers it (focus,
  window focus, reactive overlay).
- [ ] R6: drift is rechecked at end-of-turn (active → undefined
  transition with thread unchanged) and dialog opens if still drifted.
- [ ] R8: pre-turn check unchanged, blocks submission until user
  resolves dialog.
- [ ] R9: `drifted` boolean remains UI-warning gate only; no thread
  reload, no enrichment discard.
- [ ] R10 / R11: retain and update actions behave as today.
- [ ] R12: exactly one dialog entry path; reactive overlay effect
  routes through the same gate as imperative checks.
- [ ] R13: archived threads have no chip, no dialog, no drift compute
  (compute returns drifted=false because expected is undefined).
- [ ] R14: retention rejects and ignores pairs where `expected === "HEAD"`.
- [ ] R15: turn completion on a non-focused thread does not pop dialog
  on the focused thread, dialog fires on next focus of the completed
  thread.

### Race-condition Acceptance (added during deepen)

- [ ] Same-render thread switch with `activeTurnId` flip does not fire
  a spurious end-of-turn dialog (combined-ref guard).
- [ ] Mid-await navigation away does not surface dialog on the
  deselected thread (`selectedThreadKeyRef` guard).
- [ ] Reactive overlay update in same render as turn-end transition
  does not double-open the dialog.

### Quality Gates

- [ ] `pnpm --filter @pwragent/desktop run typecheck` clean
- [ ] `pnpm test` clean (workspace-wide)
- [ ] `pnpm test:desktop-e2e` clean
- [ ] `pnpm test packages/shared` covers shared predicate
- [ ] Manual smoke test: agent rebase mid-turn on a real repo, verify
  no false positive

## Success Metrics

- Zero "spurious branch drift dialog while agent was rebasing" reports
  in the next 30 days.
- Zero "sidebar shows drift but dialog never appears" reports in the
  next 30 days (the original bug class).
- No regressions in existing pre-turn drift detection (R8 path).

## Dependencies & Risks

### Dependencies

- None new. Uses existing `@pwragent/shared` workspace package and
  existing `desktopApi.checkThreadBranchDrift` IPC.
- The `archivedAt` field on `NavigationThreadSummary` (or whatever
  archival sentinel exists) must reliably reflect archival state — Phase 3
  audit confirms shape and propagation through `navigation-state.ts`.

### Risks

- **Risk: `props.desktopApi` referential instability up the prop tree
  (pre-existing).** The window-focus useEffect at `ThreadView.tsx:851`
  re-subscribes on every `props.desktopApi` change. If a parent passes
  a freshly-built object literal, every render registers a new listener.
  Mitigation: confirm referential stability in App.tsx; if not stable,
  destructure `onWindowFocus` once into a local stable reference.
  (Pre-existing; flagged by Julik. Verify in Phase 2 work.)
- **Risk: existing retained pairs in user state include
  `expected === "HEAD"` rows.** Impact: users may see a one-time dialog
  for a pair they previously retained. Acceptable per R14 since each
  "first named branch" is meaningfully distinct.
- **Risk: archived-thread propagation diverges between IPC reply path
  and overlay snapshot path.** Mitigation: Phase 3 audit centralizes at
  `resolveExpectedThreadBranch` AND verifies `navigation-state.ts`
  applies the same guard. Single test covers both surfaces (chip and
  dialog).

### Risks closed by simplification

- (Closed) `pendingBranchDriftRef` lifecycle hazards — ref removed.
- (Closed) Sibling-effect cleanup ordering — no sibling effects to
  order.
- (Closed) R15 eager-refresh navigation-snapshot invalidation — no
  eager refresh.

## Future Considerations

- Once `docs/solutions/` exists in this repo, write a solution doc
  capturing the "drift detection + turn lifecycle + detached HEAD"
  intersection so future maintainers don't relearn it. This plan and
  its origin requirements doc should be cited.
- **`useEffectEvent` adoption** (React 19+): `tryOpenBranchDriftDialog`
  is a textbook fit. Defer until the codebase adopts `useEffectEvent`
  more broadly.
- **`useReducer` for dialog state**: would make "exactly one dialog
  open at a time" a structural invariant. Architecture review flagged
  the current `useState` + gate as functional but conventional. Defer.
- **Worktree isolation**: Cursor and competitors are moving toward
  worktree-per-agent so user state never collides with agent state.
  Our handoff-to-worktree path already supports this; encouraging users
  toward worktree mode is a UX direction independent of this fix.

## Sources & References

### Origin

- **Origin document:**
  [docs/brainstorms/2026-05-04-thread-branch-drift-detection-requirements.md](docs/brainstorms/2026-05-04-thread-branch-drift-detection-requirements.md)
  — carries forward R1–R15. R12–R15 were added during spec-flow
  analysis on 2026-05-04 and explicitly resolved in this plan.

### Internal references

- Predicate compute (backend):
  [apps/desktop/src/main/app-server/backend-registry.ts:1820](apps/desktop/src/main/app-server/backend-registry.ts:1820)
  (`checkThreadBranchDrift`),
  [apps/desktop/src/main/app-server/backend-registry.ts:290](apps/desktop/src/main/app-server/backend-registry.ts:290)
  (`resolveExpectedThreadBranch`)
- Renderer dialog gate:
  [apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:751](apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:751)
  (`canWarnForBranchDrift`),
  [ThreadView.tsx:759](apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:759)
  (`showBranchDriftDialog`),
  [ThreadView.tsx:785](apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:785)
  (`checkSelectedThreadBranchDrift`)
- Reactive overlay effect (R12 target):
  [ThreadView.tsx:830](apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:830)
- Focus + window focus useEffect:
  [ThreadView.tsx:851](apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:851)
- Pre-turn hookup (R8):
  [ThreadView.tsx:1514](apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:1514)
- Sidebar chip (R4 target):
  [apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx:19](apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx:19)
- Active turn id origin:
  [apps/desktop/src/renderer/src/lib/useThreadSessionState.ts:100](apps/desktop/src/renderer/src/lib/useThreadSessionState.ts:100)
  (state shape),
  [useThreadSessionState.ts:2261](apps/desktop/src/renderer/src/lib/useThreadSessionState.ts:2261)
  (turn-completed reducer)
- Existing prev-value ref pattern:
  [useThreadSessionState.ts:1573](apps/desktop/src/renderer/src/lib/useThreadSessionState.ts:1573),
  [useThreadNavigation.ts:827](apps/desktop/src/renderer/src/lib/useThreadNavigation.ts:827),
  [Composer.tsx:838](apps/desktop/src/renderer/src/features/composer/Composer.tsx:838)
- Existing renderer drift tests:
  [thread-view.test.tsx:2713](apps/desktop/src/renderer/src/features/thread-detail/__tests__/thread-view.test.tsx:2713)
  and
  [thread-view.test.tsx:2801](apps/desktop/src/renderer/src/features/thread-detail/__tests__/thread-view.test.tsx:2801)
- Existing backend drift test:
  [backend-registry.test.ts:2867](apps/desktop/src/main/__tests__/backend-registry.test.ts:2867)
- Existing E2E:
  [apps/desktop/e2e/thread-branch-drift.spec.ts](apps/desktop/e2e/thread-branch-drift.spec.ts)
- Turn-lifecycle E2E reference:
  [apps/desktop/e2e/fixtures/turn-lifecycle/](apps/desktop/e2e/fixtures/turn-lifecycle/)
- Existing predicate naming idiom:
  [packages/shared/src/contracts/settings.ts:243](packages/shared/src/contracts/settings.ts:243)
  (`isDesktopChatReplyComposer`),
  [apps/desktop/src/main/messaging/core/messaging-controller.ts:3448](apps/desktop/src/main/messaging/core/messaging-controller.ts:3448)
  (`isTerminalTurnLifecycle`)
- Existing predicate test home:
  [packages/shared/src/contracts/__tests__/settings.test.ts](packages/shared/src/contracts/__tests__/settings.test.ts)

### React documentation

- [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
- [useEffectEvent (deferred adoption)](https://react.dev/reference/react/useEffectEvent)
- [Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
- [`<StrictMode>`](https://react.dev/reference/react/StrictMode)
- [Removing Effect Dependencies](https://react.dev/learn/removing-effect-dependencies)

### External tool research (drift detection in AI coding agents)

- [Cursor: silent stash/reset bug](https://forum.cursor.com/t/cursor-ide-silently-runs-git-stash-git-reset-head-during-active-agent-session-all-uncommitted-changes-lost/156146)
- [Cursor: WorktreeManager force-deleted branch](https://forum.cursor.com/t/cursors-worktreemanager-force-deleted-my-git-branch-when-cleaning-up-agent-worktrees/146865)
- [Cursor: rebase .lockd issue](https://forum.cursor.com/t/bug-report-git-rebase-lock-file-lockd-issue-preventing-operation-completion/42184)
- [Cursor worktrees docs](https://cursor.com/docs/configuration/worktrees)
- [VS Code Git: onDidChange branch issue #189316](https://github.com/microsoft/vscode/issues/189316)
- [vscode-branch-warning extension (suppressPopup precedent)](https://github.com/teledemic/vscode-branch-warning)
- [aider git integration docs](https://aider.chat/docs/git.html)
- [GitHub Copilot agent default-branch limitation](https://github.com/orgs/community/discussions/159836)

### Related plans

- [docs/plans/2026-04-22-003-feat-thread-worktree-archive-restore-plan.md](docs/plans/2026-04-22-003-feat-thread-worktree-archive-restore-plan.md)
  — establishes archived workspaces sit on a snapshot ref in detached
  HEAD, motivating R13.
- [docs/plans/2026-04-29-001-feat-thread-workspace-handoff-plan.md](docs/plans/2026-04-29-001-feat-thread-workspace-handoff-plan.md)
  — defines overlay-vs-backend split that drift detection reasons over.
- [docs/plans/2026-05-02-004-fix-messaging-handoff-branch-picker-plan.md](docs/plans/2026-05-02-004-fix-messaging-handoff-branch-picker-plan.md)
  — adjacent UX vocabulary for branch occupancy and detached HEAD.
- [docs/plans/2026-05-03-001-fix-messaging-turn-admission-plan.md](docs/plans/2026-05-03-001-fix-messaging-turn-admission-plan.md)
  — `isTerminalTurnLifecycle` primitive considered (and rejected) for
  the gate; `activeTurnId` is already terminal-aware via the reducer.

### Institutional learnings

- No `docs/solutions/` directory exists yet in this repo. Once the fix
  lands, this is a strong candidate for the first solutions doc (per
  `CLAUDE.md`'s mention of "future `docs/solutions/`"). Topic:
  "Drift detection + turn lifecycle + detached HEAD intersection."
