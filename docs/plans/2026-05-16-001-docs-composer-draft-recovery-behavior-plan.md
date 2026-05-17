---
title: "docs: Composer draft recovery behavior contract"
type: docs
status: active
date: 2026-05-16
origin: docs/plans/2026-05-14-001-fix-composer-draft-recovery-history-plan.md
---

# docs: Composer draft recovery behavior contract

## Overview

Document the merged composer draft recovery feature as a durable behavior
contract. The implementation landed in squash merge
`5a43b7d09 fix(desktop): persist composer draft recovery history (#417)`;
this plan branch starts from `origin/main` after that merge and adds a
reader-facing explanation of how recovery works, where state lives, what is
bounded, and which keyboard interactions are intentional.

This is a documentation plan, not a request to change runtime behavior. The
plan should make future fixes safer by separating the intended product
contract from incidental implementation details.

## Problem Frame

The original bug class was data loss in long composer drafts: a user could
type a multi-paragraph launchpad prompt with skill tokens, trigger undo or
delete behavior, and lose the message with no reliable recovery path. The
merged feature adds a layered safety model:

- Tiptap owns live in-editor undo/redo.
- The renderer draft store owns immediate in-session current drafts and an
  optimistic local recovery buffer.
- Profile-scoped SQLite owns durable latest-draft hydration and bounded
  recovery history.
- Blank-composer `ArrowUp`/`ArrowDown` exposes recoverable drafts with
  shell-like cycling.

That behavior is now important enough to document explicitly because future
composer changes can easily regress it by changing selection behavior,
scope keys, retention, or persistence boundaries.

## Requirements Trace

- R1. Document the branch provenance: a new branch must start from
  `origin/main` after the squash merge, not from the old PR branch history.
- R2. Document the persistence model: latest unsent draft per scope, bounded
  recovery journal, renderer optimistic buffer, and typed IPC boundary.
- R3. Document scope keys and candidate matching for thread, launchpad, and
  empty/no-project composers.
- R4. Document what enters recovery history: sent prompts, complete unsent or
  abandoned drafts, skill-token/image drafts, whole-composer deletion, and
  the text threshold for ordinary unsent text.
- R5. Document what does not enter history: explicitly cleared drafts and
  short non-sent text-only intermediate edits.
- R6. Document recovery keyboard semantics: `ArrowUp`, `ArrowDown`,
  caret-at-`0..0`, blank-composer entry, spell-breaking keys, and image-bearing
  recovered drafts.
- R7. Document retention and bounds: 300 SQLite journal rows globally, 30-day
  journal age, 80 renderer-local candidates, query default 20 and max 50, and
  the caveat that SQLite pruning currently runs from DB GC rather than on
  every insert.
- R8. Document safety guards: stale async recovery results must not overwrite
  new user input or a newly selected scope.
- R9. Document verification anchors: unit and E2E tests that encode the
  behavior contract.

## Scope Boundaries

- This plan does not change the composer implementation.
- This plan does not change retention constants or add immediate per-insert
  pruning.
- This plan does not add a user-facing help page or release note by itself.
- This plan does not persist ProseMirror/Tiptap internal undo history.
- This plan does not change existing draft privacy posture; drafts are stored
  in the profile-local state DB like other desktop state.

## Context & Research

### Relevant Code and Patterns

- `packages/shared/src/contracts/composer-drafts.ts` defines the shared draft
  record, lifecycle states, recovery candidate shape, and list/save IPC
  contracts.
- `apps/desktop/src/main/state/state-db.ts` defines
  `composer_draft_latest`, `composer_draft_journal`, the 30-day journal age,
  and the 300-row global journal cap enforced by DB cleanup.
- `apps/desktop/src/main/state/composer-draft-recovery-store.ts` normalizes
  draft records, stores latest/current drafts, inserts journal candidates,
  collapses unsubmitted prefix drafts, filters candidates by scope/backend,
  and clamps query limits.
- `apps/desktop/src/renderer/src/features/composer/useDurableComposerDraftStore.ts`
  bridges the renderer draft store to durable IPC with a 200ms save debounce,
  flushes pending saves on teardown, keeps an 80-item optimistic local buffer,
  and applies the same unsubmitted-prefix collapse locally.
- `apps/desktop/src/renderer/src/features/composer/Composer.tsx` owns scope
  keys, recovery-cycle state, abandoned-draft recording on whole-composer
  deletion, sent-history recording, stale async recovery guards, and
  `ArrowUp`/`ArrowDown` behavior.
- `apps/desktop/src/renderer/src/features/composer/ComposerTiptapInput.tsx`
  forwards recovery navigation keys before ProseMirror consumes them and
  applies selection requests so recovered drafts anchor the caret at the
  beginning.
- `apps/desktop/src/renderer/src/features/composer/__tests__/composer.test.tsx`,
  `apps/desktop/src/main/__tests__/composer-draft-recovery-store.test.ts`,
  `apps/desktop/src/renderer/src/features/composer/__tests__/useDurableComposerDraftStore.test.tsx`,
  and `apps/desktop/e2e/new-thread-transcript-sync.spec.ts` encode the
  current behavioral contract.

### Institutional Learnings

- `docs/plans/2026-05-14-001-fix-composer-draft-recovery-history-plan.md`
  established the two-layer model: Tiptap owns live undo/redo; PwrAgent owns
  durable app-level snapshots.
- `docs/plans/2026-05-02-003-fix-composer-draft-persistence-plan.md`
  established that draft text, Tiptap JSON, skill tokens, and image
  attachments move as one coherent snapshot.
- `docs/brainstorms/2026-05-02-desktop-composer-draft-persistence-regression-requirements.md`
  defines unsent composer content as user data rather than disposable UI
  state.

### External References

- None used for this documentation pass. The subject is the already-merged
  PwrAgent implementation; repo-local code and tests are the source of truth.

## Key Technical Decisions

- **Keep this as a plan artifact, not product help copy.** The goal is to
  document a technical behavior contract for future maintainers. User-facing
  wording can be derived later if the interaction needs discoverability.
- **Describe actual merged behavior, including limits and caveats.** The plan
  should say SQLite journal pruning is bounded by DB cleanup, not imply a
  hard on-insert cap that the code does not currently enforce.
- **Treat sent prompts and unsubmitted drafts differently.** Sent prompts are
  immutable shell-style history entries. Unsubmitted near-repeat prefix drafts
  collapse so the queue contains coherent drafts rather than every typed word.
- **Name the keyboard mode precisely.** Recovery mode starts from a blank
  composer or an active recovered draft anchored at `0..0`; once the caret
  moves or any non-Up/Down key runs, normal editor navigation resumes until
  the composer is blank again.
- **Keep tests as part of the contract.** The plan should point future
  maintainers to the exact test files that must change if behavior changes.

## Current Behavior Contract

### Storage Model

| Layer | Purpose | Bound |
|---|---|---|
| Renderer base draft store | Synchronous current draft state for mounted UI | One current snapshot per scope |
| Renderer optimistic recovery buffer | Immediate recovery before durable IPC settles | 80 candidates in memory |
| `composer_draft_latest` | Profile-local durable latest unsent draft hydration | One row per scope key |
| `composer_draft_journal` | Profile-local recoverable sent/abandoned/unsent history | 300 rows globally, 30-day age via DB GC |

Draft snapshots include canonical text, Tiptap JSON, skill tokens, image
attachment metadata/data URLs, lifecycle status, timestamps, scope metadata,
content hash, and character count.

### Scope Model

- Existing thread replies use `thread:<backend>:<threadId>`.
- Directory launchpads use `launchpad:<directoryKey>`.
- No-project launchpads use `empty`.
- Scoped recovery requests prefer the exact scope key, then related
  backend/thread/directory candidates, then fall back to global recent
  candidates only when no scoped candidates are found.
- Backend filtering is applied before thread matching so backend-local thread
  id collisions cannot surface the wrong provider's draft.

### History Admission

- Sent prompts enter history whenever the snapshot is non-empty.
- Unsent/abandoned drafts enter history if they have skill tokens, image
  attachments, or at least 120 trimmed text characters.
- Whole-composer deletion records the previous non-empty snapshot as
  `abandoned` before the visible draft becomes blank.
- Pending debounced saves flush during teardown so recent edits are not lost
  only because navigation or unmount happened quickly.
- Explicit clears do not create recoverable `cleared` history.

### Near-Repeat Collapse

- For unsubmitted candidates in the same scope, if the latest candidate is a
  prefix of the next longer candidate from position `0`, the store replaces
  the previous row/buffer entry with the longer draft.
- Sent prompts are never replaced by later longer prompts. A sent prompt is
  treated like shell command history that actually ran.

### Keyboard Recovery

- `ArrowUp` starts recovery only from a blank composer, or continues recovery
  while an active recovered draft still has the caret exactly at `0..0`.
- First `ArrowUp` restores the newest matching candidate and anchors the caret
  at `0..0`.
- Repeated `ArrowUp` walks toward older candidates and clamps at the oldest
  candidate.
- `ArrowDown` only participates while recovery mode is active, the recovered
  draft is non-empty, and the caret remains at `0..0`.
- Repeated `ArrowDown` walks back toward newer candidates. `ArrowDown` from
  the newest candidate clears the composer to blank and ends the recovery
  cycle.
- Any key other than `ArrowUp`/`ArrowDown`, mouse/selection movement, right
  arrow, end-of-line commands, or typing breaks recovery mode. After that,
  `ArrowUp`/`ArrowDown` return to normal editor navigation until the composer
  is blank again.
- Image-bearing recovered drafts can continue cycling; image attachments do
  not block active recovery navigation.
- If an async recovery lookup resolves after the user typed or changed scope,
  the stale result is ignored rather than applied.

## Open Questions

### Resolved During Planning

- **Is history unbounded?** No. SQLite journal retention is 300 rows globally
  plus 30 days via DB cleanup; local optimistic recovery is capped at 80; query
  results default to 20 and clamp at 50.
- **Should this branch be based on the old feature branch?** No. It is based
  on `origin/main` after the squash merge so its diff contains only the new
  documentation plan.
- **Should external Tiptap research run for this pass?** No. The requested
  artifact documents merged PwrAgent behavior, not proposed editor changes.

### Deferred to Implementation

- Whether to make the SQLite 300-row cap an immediate on-insert invariant
  instead of GC-enforced cleanup.
- Whether the behavior contract should later become user-facing help copy,
  release-note text, or docs-site content.
- Whether to expose a visible draft-history affordance beyond keyboard-only
  `ArrowUp`/`ArrowDown`.

## Implementation Units

- [ ] **Unit 1: Preserve the merged behavior contract in docs**

**Goal:** Add this plan file from a branch based on `origin/main` so future
work can reference the expected recovery behavior.

**Requirements:** R1-R9

**Dependencies:** The #417 squash merge must already be present on
`origin/main`.

**Files:**
- Create: `docs/plans/2026-05-16-001-docs-composer-draft-recovery-behavior-plan.md`

**Approach:**
- Treat the merged code and tests as source material.
- Record the storage, scope, admission, retention, and keyboard contracts in
  prose and tables.
- Include explicit caveats where the implementation is intentionally bounded
  but not hard-pruned on every insert.

**Patterns to follow:**
- Existing docs plans that document behavior and rationale after a feature
  lands, such as `docs/plans/2026-05-13-001-docs-codex-via-messaging-guide-plan.md`.

**Test scenarios:**
- Test expectation: none -- documentation-only plan; verification is by
  cross-checking referenced code and tests.

**Verification:**
- The branch diff contains this plan file only.
- The plan accurately describes current merged behavior and points to the
  relevant code/test files.

- [ ] **Unit 2: Optional hard-cap follow-up**

**Goal:** Decide whether journal pruning should happen immediately after
`composer_draft_journal` inserts, not only during `StateDb.cleanupExpired`.

**Requirements:** R7

**Dependencies:** Unit 1

**Files:**
- Modify, if accepted later: `apps/desktop/src/main/state/composer-draft-recovery-store.ts`
- Test, if accepted later: `apps/desktop/src/main/__tests__/composer-draft-recovery-store.test.ts`

**Approach:**
- Keep this as a follow-up decision, not part of the documentation branch.
- If implemented later, preserve the current 300-row/30-day policy and add
  store-level tests that prove inserts cannot temporarily grow without bound.

**Patterns to follow:**
- `StateDb.cleanupExpired` pruning logic in `apps/desktop/src/main/state/state-db.ts`.

**Test scenarios:**
- Happy path: inserting the 301st journal row removes the oldest journal row.
- Edge case: pruning does not remove `composer_draft_latest` rows.
- Edge case: sent and abandoned entries obey the same global journal cap.

**Verification:**
- Follow-up PR, if created, makes the retention cap immediate without changing
  recovery ordering or candidate filtering.

## System-Wide Impact

- **Interaction graph:** The plan references renderer composer state,
  renderer-main IPC, profile SQLite, and E2E recovery behavior. It does not
  alter those surfaces.
- **Error propagation:** No runtime errors are introduced. The document should
  preserve the current expectation that durable-save failures are logged and
  do not clear visible drafts.
- **State lifecycle risks:** The key documented risks are stale async recovery,
  pending-save teardown, whole-composer deletion, and GC-bounded retention.
- **API surface parity:** The shared `composer-drafts` contract remains the
  boundary between renderer and main. Documentation should not imply renderer
  direct DB access.
- **Integration coverage:** Current verification spans renderer unit tests,
  main-process store tests, durable-store tests, Tiptap input tests, and the
  new-thread E2E recovery scenario.
- **Unchanged invariants:** Existing send payload semantics, Tiptap canonical
  draft serialization, directory launchpad materialization, and profile-local
  state layout remain unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The document drifts from the implementation. | Cite concrete code/test files and keep this plan scoped to current merged behavior. |
| Readers think the 300-row cap is enforced synchronously on every insert. | Explicitly state that pruning currently runs through DB cleanup. |
| Future changes regress keyboard recovery mode. | Capture the caret-at-`0..0` and spell-breaking rules as a named behavior contract with test references. |
| Sent prompts and unsent drafts get conflated. | Document sent prompts as immutable history and unsubmitted drafts as prefix-collapsible candidates. |

## Documentation / Operational Notes

- No release note is required for this documentation-only branch.
- If this plan is later converted into user-facing docs, avoid overexplaining
  keyboard internals. Users need the recovery affordance; maintainers need the
  state-machine details.
- Draft history contains user-entered prompt text in the profile-local SQLite
  DB. This matches the feature's implementation and should be considered when
  discussing privacy, export, or cleanup behavior.

## Sources & References

- Origin plan:
  `docs/plans/2026-05-14-001-fix-composer-draft-recovery-history-plan.md`
- Origin requirements:
  `docs/brainstorms/2026-05-02-desktop-composer-draft-persistence-regression-requirements.md`
- Squash merge: `5a43b7d09 fix(desktop): persist composer draft recovery history (#417)`
- Shared contracts: `packages/shared/src/contracts/composer-drafts.ts`
- Main persistence: `apps/desktop/src/main/state/state-db.ts`
- Recovery store: `apps/desktop/src/main/state/composer-draft-recovery-store.ts`
- Renderer durable bridge:
  `apps/desktop/src/renderer/src/features/composer/useDurableComposerDraftStore.ts`
- Composer recovery UI:
  `apps/desktop/src/renderer/src/features/composer/Composer.tsx`
- Tiptap selection/key forwarding:
  `apps/desktop/src/renderer/src/features/composer/ComposerTiptapInput.tsx`
- Main tests:
  `apps/desktop/src/main/__tests__/composer-draft-recovery-store.test.ts`
- Renderer tests:
  `apps/desktop/src/renderer/src/features/composer/__tests__/composer.test.tsx`
  and
  `apps/desktop/src/renderer/src/features/composer/__tests__/useDurableComposerDraftStore.test.tsx`
- E2E tests: `apps/desktop/e2e/new-thread-transcript-sync.spec.ts`
