---
title: Directory pinning + drag-reorder in sidebar
type: feat
status: completed
date: 2026-05-09
---

# Directory pinning + drag-reorder in sidebar

## Overview

Add per-directory pinning + manual ordering to the sidebar's **Directories** lens, mirroring the existing thread-pin pattern (drag/drop above a divider, keyboard reorder, context menu). Pin state persists across restarts via the overlay store. The IPC and renderer-state shape is a deliberate clone of `setThreadPin` / `reorderThreadPins` with the per-backend dimension stripped (directories are backend-agnostic).

This is a **steal-the-pattern** feature: every implementation unit should call back to the equivalent thread-pin code path. The plan calls out the two genuine divergences (no per-backend scope, no existing `directory_overlay` sqlite table) with rationale.

## Problem Statement

The Directories lens currently sorts directories alphabetically only. Users with 10+ tracked directories scan past the same 2–3 directories they care about every time. The thread-row pin pattern solves this for threads inside a directory; the same affordance is missing one level up.

Internal user feedback: *"I have been wanting pinned/manually sorted directories. Can we steal our drag/drop pinning for thread cards themselves and apply to directories?"*

## Proposed Solution

A `pinnedRank: string | undefined` field on `NavigationDirectorySummary`, set from a new `directory_overlay` sqlite row, plumbed through:

1. The snapshot builder (with a directories slice added to the snapshot hash so pin mutations propagate).
2. Two new IPC channels (`navigation:set-directory-pin`, `navigation:reorder-directory-pins`) wrapping new overlay-store mutators.
3. Three new bus notifications (`directory/pin/added`, `directory/pin/removed`, `directory/pin/reordered`) that the renderer subscribes to for optimistic-but-reconciled state updates.
4. `DirectoriesList.tsx` gains a pinned/unpinned split, divider, drag handlers, keyboard reorder, and a context menu — all cloned from `RecentsList.tsx`.

The pure `thread-pins.ts` helpers are already shape-generic (over `{ id, pinnedRank, updatedAt? }`). A thin `directory-pins.ts` shim adapts directory summaries (`key` → `id`, `latestUpdatedAt` → `updatedAt`) so the call sites in DirectoriesList and useThreadNavigation stay clean.

## Technical Approach

### Architecture

The feature crosses all five layers of the existing dependency hierarchy:

| Layer | Addition |
|---|---|
| `packages/shared` | `NavigationDirectorySummary.pinnedRank?`, `SetDirectoryPin{Request,Response}`, `ReorderDirectoryPins{Request,Response}`, `DirectoryOverlayState`, new `directory-pins.ts` shim, new `AppServerNotification` directory-pin event variants. |
| `packages/agent-core` | `buildDirectorySummaries` accepts `directoryOverlayByKey`, attaches `pinnedRank` to summaries. `buildNavigationSnapshotHash` gains a directories slice so pin mutations invalidate the unchanged-snapshot short-circuit. |
| `apps/desktop/src/main` | New `directory_overlay` sqlite table + getters/putters in `state-db.ts`. New `setDirectoryPin` + `reorderDirectoryPins` mutators in `overlay-store-sqlite.ts`. IPC handlers in `app-server.ts`. Emit bus events from the handlers (matching thread pattern). |
| `apps/desktop/src/preload` | Bridge methods `setDirectoryPin`, `reorderDirectoryPins`. |
| `apps/desktop/src/renderer` | `desktop-api.ts` type addition. `useThreadNavigation` adds methods + bus subscriptions + snapshot patchers. `DirectoriesList.tsx` adds the pinned section, drag handlers, keyboard reorder, context menu. New CSS for `.directory-row-shell` + `.directories-pinned-divider`. |

### Implementation Units

Each unit is sized to land as one focused commit. Verification field is the "done signal" for the unit. Patterns-to-follow points at the file:line you mirror.

#### Phase 1: Foundation (contract + helpers + persistence)

**Unit A — Shared contract additions**
- Goal: Add `pinnedRank` to `NavigationDirectorySummary` + the new request/response/overlay shapes. Add `directory-pins.ts` shim.
- Files: `packages/shared/src/contracts/navigation.ts`, `packages/shared/src/directory-pins.ts` (new), `packages/shared/src/index.ts`.
- Patterns to follow: `NavigationThreadSummary.pinnedRank` (navigation.ts:31–32), `SetThreadPinRequest/Response` (navigation.ts:296–307), `ReorderThreadPinsRequest/Response` (navigation.ts:309–318), `ThreadOverlayState.pinnedRank` (navigation.ts:399–400). The `directory-pins.ts` shim wraps `comparePinnedThreads` and `moveThreadKey` from `thread-pins.ts` with directory-shaped inputs.
- Execution note: pragmatic — contract additions, no logic to TDD.
- Test scenarios: shape-only; the helper wrappers get pure-function tests in Unit E.
- Verification: `pnpm --filter @pwragent/shared typecheck` clean. Existing thread-pin tests in `packages/shared/src/__tests__/thread-pins.test.ts` still pass (we add to, not modify, the helpers).

**Unit B — New `directory_overlay` sqlite table**
- Goal: Add a new sqlite table keyed by `directory_key`, single JSON `payload` column. Mirror the `threads` table shape (state-db.ts:85–94).
- Files: `apps/desktop/src/main/state/state-db.ts`.
- Patterns to follow: the `threads` table definition (`state-db.ts:85–94`) + its `getThread`/`putThread` methods. The new methods are `getDirectoryOverlay(directoryKey: string): DirectoryOverlayState | undefined` and `putDirectoryOverlay(directoryKey: string, state: DirectoryOverlayState): void` (plus a `readAllDirectoryOverlays()` for snapshot reconciliation).
- Execution note: **test-first**. Persistence layer is pure I/O and the easiest place to lock the contract.
- Test scenarios:
  - put + get round-trip returns the same `DirectoryOverlayState` (pinnedRank string).
  - put + delete (via `putDirectoryOverlay(key, undefined)` or explicit delete) clears the row.
  - readAllDirectoryOverlays returns a `Record<directoryKey, DirectoryOverlayState>` covering every persisted row.
  - schema migration: opening an older DB without the table auto-creates it on first read (mirrors existing `SCHEMA_V<N>` pattern — bump version, add CREATE TABLE).
- Verification: new test file `apps/desktop/src/main/__tests__/state-db-directory-overlay.test.ts` passes. Existing `state-db.test.ts` (if present) unaffected.

**Unit C — Overlay-store mutators**
- Goal: Add `setDirectoryPin` and `reorderDirectoryPins` to `SqliteOverlayStore`. Mirror `setThreadPin` / `reorderThreadPins` exactly.
- Files: `apps/desktop/src/main/state/overlay-store-sqlite.ts`.
- Patterns to follow: `setThreadPin` (overlay-store-sqlite.ts:303–322) and `reorderThreadPins` (overlay-store-sqlite.ts:324–348). Use `this.stateDb.raw.transaction(() => { ... })` for the reorder batch. Use `String((index + 1) * 1024)` for fresh ranks (matches helper `buildPinnedRanks`).
- Execution note: **test-first** in `apps/desktop/src/main/__tests__/overlay-store-directory-pins.test.ts` — mirror `overlay-store-pins.test.ts` (which tests the thread version).
- Test scenarios:
  - `setDirectoryPin({ directoryKey, pinnedRank })` writes the rank to the overlay.
  - `setDirectoryPin({ directoryKey, pinnedRank: null })` clears the rank.
  - `reorderDirectoryPins({ directoryKeys })` assigns ranks `1024`, `2048`, `3072`, … in order.
  - Pins survive `SqliteOverlayStore` re-instantiation (persist-across-handle check).
  - Reorder with a non-existent directoryKey is a no-op for that key (does not throw).
- Verification: new test file passes; runs in ~50ms (same envelope as overlay-store-pins.test.ts).

#### Phase 2: Snapshot + IPC

**Unit D — Snapshot builder propagates pin state**
- Goal: `buildNavigationSnapshot` receives `directoryOverlayByKey` and threads it through to `buildDirectorySummaries`, which attaches `pinnedRank` to each summary.
- Files: `packages/agent-core/src/domain/navigation-state.ts`, `packages/agent-core/src/domain/directory-navigation.ts`.
- Patterns to follow: how `launchpadsByKey` is currently threaded (`navigation-state.ts:216`, `directory-navigation.ts` consumer). New param has the same shape: `directoryOverlayByKey?: Record<string, DirectoryOverlayState | undefined>`.
- Execution note: test-first. The builder is pure and easy to TDD.
- Test scenarios:
  - Summary for a directory with a pinned-rank overlay carries `pinnedRank: "1024"`.
  - Summary for a directory without an overlay carries `pinnedRank: undefined`.
  - Overlay for a directoryKey with no thread or launchpad (the persists-after-disappear case) does NOT add a summary entry — pin metadata only annotates existing summaries.
  - `kind: "workspace"` and `kind: "unlinked"` summaries never carry `pinnedRank` even if an overlay row exists for the key (defensive — the IPC handler also blocks this, but the builder is the snapshot's truth).
- Verification: new test cases in `packages/agent-core/src/domain/__tests__/directory-navigation.test.ts` (if exists; otherwise create) pass.

**Unit E — Snapshot hash includes directory pin state**
- Goal: `buildNavigationSnapshotHash` adds a directories slice (currently has none) that hashes `{ key, pinnedRank }` per directory. Without this, pin mutations don't invalidate the unchanged-snapshot short-circuit at `overlay-store-sqlite.ts:161–174` and the renderer sees stale state. (This is the recurring footgun the learnings researcher flagged — see Risk Analysis.)
- Files: `packages/agent-core/src/domain/navigation-state.ts`.
- Patterns to follow: the existing threads slice hashing (`navigation-state.ts:348` includes `pinnedRank: thread.pinnedRank ?? null`).
- Execution note: **test-first** with a focused invariant test that locks the contract for future contributors. Add `packages/agent-core/src/domain/__tests__/navigation-snapshot-hash.test.ts` (or extend existing).
- Test scenarios:
  - Changing a directory summary's `pinnedRank` changes the snapshot hash.
  - Changing the order of directories in the snapshot's `directories` array does NOT change the hash (hash is order-insensitive over directories, like it is over threads).
  - Adding a directory to the snapshot changes the hash.
- Verification: new hash tests pass. **This unit is the gate** — without it the rest of the feature appears broken.

**Unit F — Bus notifications**
- Goal: Add `directory/pin/added`, `directory/pin/removed`, `directory/pin/reordered` to `AppServerNotification`. Wire emit calls into the IPC handlers (Unit G).
- Files: `packages/shared/src/contracts/normalized-app-server.ts`.
- Patterns to follow: `thread/pin/added`, `thread/pin/removed`, `thread/pin/reordered` (normalized-app-server.ts:891–909). Same shape, drop the `backend` dimension. Params:
  - `directory/pin/added` → `{ directoryKey: string; pinnedRank: string }`
  - `directory/pin/removed` → `{ directoryKey: string }`
  - `directory/pin/reordered` → `{ pinnedRanks: Record<string, string> }`
- Execution note: pragmatic — contract addition.
- Test scenarios: covered indirectly via renderer-state tests in Unit I.
- Verification: typecheck clean; existing `AppServerNotification` switch handlers fall through these new variants safely (existing branches don't match the new methods, so they're a no-op until renderer handles them).

**Unit G — IPC channels + handlers**
- Goal: Two new IPC channels + handlers that wrap the overlay-store mutators and emit bus events.
- Files: `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/main/ipc/app-server.ts`, plus the `disposeAppServerIpcHandlers` cleanup.
- Patterns to follow:
  - Channel constants: `NAVIGATION_SET_THREAD_PIN_CHANNEL` / `NAVIGATION_REORDER_THREAD_PINS_CHANNEL` (ipc.ts:43–46). New constants: `NAVIGATION_SET_DIRECTORY_PIN_CHANNEL = "navigation:set-directory-pin"`, `NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL = "navigation:reorder-directory-pins"`.
  - Handler registration: `app-server.ts:1309–1328` (paired `removeHandler` + `handle`).
  - Handler methods: `setThreadPin` (app-server.ts:924–964), `reorderThreadPins` (app-server.ts:966–992). The new methods are `setDirectoryPin(request: SetDirectoryPinRequest)` and `reorderDirectoryPins(request: ReorderDirectoryPinsRequest)`.
  - Each handler: validate (reject non-`kind: "directory"` keys), call overlay-store mutator, emit `publishLocalEvent({ notification: { method: "directory/pin/...", params: ... } })`, return response.
- Execution note: pragmatic.
- Test scenarios:
  - Handler test (`apps/desktop/src/main/__tests__/app-server-directory-pins.test.ts`):
    - `setDirectoryPin({ directoryKey, pinnedRank: "1024" })` → overlay row exists, bus event emitted.
    - `setDirectoryPin({ directoryKey, pinnedRank: null })` → overlay row cleared, `directory/pin/removed` emitted.
    - `reorderDirectoryPins({ directoryKeys: [...] })` → overlay reflects new ranks, `directory/pin/reordered` emitted with `pinnedRanks` map.
  - Validation: passing a `workspace:` or `unlinked` key returns a structured rejection (mirror the existing rejection patterns).
- Verification: new test file passes; existing app-server tests unaffected.

#### Phase 3: Renderer state

**Unit H — Preload bridge + desktop-api types**
- Goal: Expose `setDirectoryPin` and `reorderDirectoryPins` through the preload bridge with typed signatures.
- Files: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/lib/desktop-api.ts`.
- Patterns to follow: existing `setThreadPin` / `reorderThreadPins` bridge methods (preload/index.ts:552–559, desktop-api.ts:320–325).
- Execution note: pragmatic.
- Test scenarios: covered indirectly by Unit J's hook tests.
- Verification: typecheck clean.

**Unit I — Bus-event subscriptions + snapshot patchers**
- Goal: Add three pure-functional snapshot patchers (`updateDirectoryPinInSnapshot`, `updateDirectoryPinsInSnapshot`) and three new branches in `useThreadNavigation`'s `onAgentEvent` subscription that apply incoming `directory/pin/*` notifications to the local snapshot.
- Files: `apps/desktop/src/renderer/src/lib/useThreadNavigation.ts`.
- Patterns to follow: `updateThreadPinInSnapshot` (useThreadNavigation.ts:465–490), `updateThreadPinsInSnapshot` (useThreadNavigation.ts:492–517), and the three bus-event branches (useThreadNavigation.ts:1911–1954).
- Execution note: pragmatic. Patchers are pure and trivially unit-testable, but their value is in the integration with the hook (Unit J's tests).
- Test scenarios: covered via Unit J's hook tests.
- Verification: typecheck clean.

**Unit J — `setDirectoryPin` + `reorderDirectoryPins` hook methods**
- Goal: Expose the two mutation methods from `useThreadNavigation` with the optimistic-update + reconcile-on-response pattern.
- Files: `apps/desktop/src/renderer/src/lib/useThreadNavigation.ts`, `apps/desktop/src/renderer/src/App.tsx` (pass new methods to `Sidebar` props).
- Patterns to follow: `setThreadPin` (useThreadNavigation.ts:2887–2932) and `reorderThreadPins` (useThreadNavigation.ts:2934–2969). Optimistic patch → await IPC → re-patch with authoritative response → on throw, `refresh()`.
- Execution note: test-first via `useThreadNavigation.test.tsx`. The renderer-state hook is the most important contract to lock.
- Test scenarios (new describe block):
  - Calling `setDirectoryPin(directory, true)` patches the snapshot with a non-null `pinnedRank` immediately (optimistic), then resolves the IPC and re-patches with the authoritative rank.
  - Calling `setDirectoryPin(directory, false)` patches the snapshot's `pinnedRank` to undefined immediately.
  - Calling `reorderDirectoryPins([keyA, keyB, keyC])` patches all three with `1024`, `2048`, `3072` ranks.
  - IPC rejection triggers a `refresh()` fallback (assert the snapshot is reloaded, not left with the stale optimistic state).
  - Incoming `directory/pin/added` bus event applies to the snapshot.
  - Incoming `directory/pin/reordered` bus event applies to the snapshot.
  - Patcher short-circuits when `pinnedRank` already matches the incoming rank (no re-render).
- Verification: new tests in `useThreadNavigation.test.tsx` pass.

#### Phase 4: Renderer UX

**Unit K — DirectoriesList drag/drop, divider, keyboard reorder**
- Goal: Restructure `DirectoriesList.tsx` to split pinned + unpinned, render a divider between them, wire drag handlers on each directory row, and add the Cmd+Shift+Arrow keyboard-reorder helpers.
- Files: `apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx`.
- Patterns to follow: `RecentsList.tsx` end-to-end (lines 47–234). The mapping is:
  - `RecentsList` state (`dropIndicator`, `dividerDropTarget`, `draggedThreadKey`) → `DirectoriesList` state with same names but operating on directory keys.
  - `pinnedThreads.filter(isPinnedThread).sort(comparePinnedThreads)` → `pinnedDirectories.filter(isPinnedDirectory).sort(comparePinnedDirectories)` (using the new `directory-pins.ts` shim).
  - `reorderPins(backend, nextThreadKeys)` → `reorderPins(nextDirectoryKeys)` (no backend dim).
  - `movePinnedThreadByKeyboard(thread, direction)` → `movePinnedDirectoryByKeyboard(directory, direction)`.
  - The pinned-divider drop target: same `is-drop-target` toggling.
- Execution note: **characterization-first** — `RecentsList.tsx` is the reference. Write the same shape; resist redesigning.
- Test scenarios: covered by Unit P (sidebar tests).
- Verification: visual sanity in dev; tests pass.

**Unit L — CSS for the directory-row shell + pinned divider**
- Goal: Add `.directory-row-shell` wrapper class with the drop-indicator pseudo-elements; add `.directories-pinned-divider` style mirroring `.recents-pinned-divider`.
- Files: `apps/desktop/src/renderer/src/styles/app.css`.
- Patterns to follow: `.thread-row-shell` (app.css:1431–1442), `.thread-row-shell.is-drop-target-before/after::before/::after` (app.css:1444–1466), `.recents-pinned-divider` (app.css:1468–1500).
- Execution note: pragmatic.
- Test scenarios: theme-contract test (Unit Q) locks the styles.
- Verification: theme-contract test passes; visual sanity in dev.

**Unit M — Context menu for directory rows**
- Goal: Add a right-click context menu to directory rows with "Pin Directory" / "Unpin Directory" item. Wire `onContextMenu` on `.directory-row__summary` to open the menu via the existing Sidebar menu plumbing.
- Files: `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx`, `apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx`.
- Patterns to follow: thread context menu in Sidebar.tsx (lines 532–639), the `togglePinFromContextMenu` action (Sidebar.tsx:546–554), and how `ThreadRow` invokes `onOpenContextMenu` (ThreadRow.tsx:151–157).
- Execution note: pragmatic. The menu is currently inline in Sidebar.tsx — extend it rather than extract.
- Test scenarios:
  - Right-click on a directory row opens a context menu with a single "Pin" / "Unpin" item (current state-dependent label).
  - Selecting the menu item calls `setDirectoryPin` with the inverted state.
  - Menu item is NOT shown for `workspace` or `unlinked` rows.
- Verification: tests in `sidebar.test.tsx` (Unit P) cover the context-menu interaction.

#### Phase 5: Tests + invariants

**Unit N — Pure-helper tests for `directory-pins.ts`**
- Goal: Lock the directory-pin shim's compare / move / build-rank behavior.
- Files: `packages/shared/src/__tests__/directory-pins.test.ts` (new).
- Patterns to follow: `packages/shared/src/__tests__/thread-pins.test.ts`.
- Execution note: pragmatic.
- Test scenarios:
  - `isPinnedDirectory({ pinnedRank: "1024" })` → true.
  - `comparePinnedDirectories` orders by rank asc.
  - `moveDirectoryKey` reorders correctly with `before` / `after` positions.
  - `buildPinnedRanks` (re-exported) returns the expected `{ key: "1024", ... }` shape.
- Verification: new test file passes (~10ms).

**Unit O — Sidebar drag/drop tests**
- Goal: Extend `sidebar.test.tsx` with directory-pin coverage.
- Files: `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx`.
- Patterns to follow: existing thread-pin tests in sidebar.test.tsx:827, :874, :920, :952, :994, :1061. Mirror the same drag-event simulation and `is-drop-target-*` class assertions.
- Execution note: pragmatic.
- Test scenarios:
  - Dragging an unpinned directory above the pinned divider pins it (calls `setDirectoryPin` with the next rank).
  - Dragging a pinned directory below the divider unpins it.
  - Dragging within the pinned section reorders.
  - Drop indicator class (`is-drop-target-before` / `is-drop-target-after`) appears on the right target during drag.
  - Workspace / unlinked rows do NOT have drag handlers (no `draggable` attr).
  - Right-click on a pinnable directory opens the context menu with the Pin/Unpin item.
- Verification: tests pass.

**Unit P — Theme-contract test for the drop-indicator + pinned-divider CSS**
- Goal: Lock the visual contract for `.directory-row-shell.is-drop-target-*::before/::after` and `.directories-pinned-divider` so future contributors don't silently regress the height / color / glow.
- Files: `apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx`.
- Patterns to follow: the existing thread-row-shell drop-indicator contract (if locked) or the comparable existing theme-contract patterns.
- Execution note: pragmatic.
- Test scenarios:
  - `.directory-row-shell.is-drop-target-before::before` has `height: 3px`, `background: var(--accent)`, `top: -3px`.
  - `.directories-pinned-divider.is-drop-target` thickens to 3px accent.
- Verification: theme-contract test passes.

**Unit Q — Snapshot-hash invariant test**
- Goal: Lock the contract that mutations to `NavigationDirectorySummary.pinnedRank` invalidate the snapshot hash. This is the "footgun" the learnings researcher flagged — adding fields to summaries without updating the hash silently breaks renderer propagation.
- Files: `packages/agent-core/src/domain/__tests__/navigation-snapshot-hash.test.ts` (new or extend existing).
- Patterns to follow: existing `buildNavigationSnapshotHash` tests if any; otherwise pure-function unit tests.
- Execution note: **test-first** in Unit E (this is the gate test).
- Test scenarios: see Unit E.
- Verification: test passes after Unit E ships.

## Alternative Approaches Considered

### Alternative 1: Reuse the `threads` overlay table with a synthetic `directory:` prefix

**Rationale for rejection.** Storing directory pins as fake-thread rows in the `threads` table would avoid the schema migration but couples directory pin semantics to the thread overlay shape (which includes per-thread fields like `executionMode`, `model`, `serviceTier` that don't apply). A separate `directory_overlay` table costs one migration but keeps the persistence shape honest. Mirrors how `directory_launchpads` is also its own table.

### Alternative 2: Global pin order vs per-backend pin order

**Decision: global.** Thread pins are scoped per `backend` because thread IDs collide across backends (codex thread `abc` ≠ grok thread `abc`) and pin order would be incoherent if mixed. Directory keys are globally unique (path-derived, prefix `directory:`). The Directories lens itself is backend-agnostic. So directory pins are global — IPC drops the `backend` parameter. This is the **one genuine divergence** from the thread-pin contract called out up-front.

### Alternative 3: Pre-sort the directories array in the snapshot

**Rejected.** Threads aren't pre-sorted by pin in the snapshot (the sort happens at the renderer in `RecentsList`). Mirror that: `buildDirectorySummaries` continues to return alphabetical-by-label, and `DirectoriesList` does the pinned/unpinned split. Pre-sorting would force every consumer (renderer, messaging surfaces, future API consumers) to either accept the pin-first order or re-sort. Keeping the sort at the consumer keeps the snapshot's contract simple.

### Alternative 4: Generalize `thread-pins.ts` helpers vs add `directory-pins.ts` shim

**Decision: shim.** The helpers are already generic over `{ id, pinnedRank, updatedAt? }`, but directories have `key` and `latestUpdatedAt`. Three options were considered:
- (a) Generalize the helpers to accept field-name configuration — more API surface, less call-site clarity.
- (b) Adapter at each call site (`{ id: dir.key, pinnedRank: dir.pinnedRank, updatedAt: dir.latestUpdatedAt }`) — repetitive at the call sites.
- (c) A thin `directory-pins.ts` shim that wraps the helpers with directory-shaped inputs — clean call sites, minor duplication.

Going with **(c)**: a 30-line shim that re-exports the helpers with directory-shaped function signatures. Call sites stay readable; the underlying logic lives in one place.

## System-Wide Impact

### Interaction Graph

Action: user drags directory A above the pinned divider.

1. `DirectoriesList`'s `onDropOnDirectory` handler computes the next pinned-keys order via `moveDirectoryKey`.
2. Calls `useThreadNavigation.reorderDirectoryPins(nextKeys)`.
3. Hook patches the local snapshot optimistically (`updateDirectoryPinsInSnapshot`).
4. Hook calls `desktopApi.reorderDirectoryPins({ directoryKeys: nextKeys })` (IPC).
5. Main process `app-server.ts:reorderDirectoryPins` calls `overlayStore.reorderDirectoryPins({ directoryKeys })`.
6. Overlay store writes `directory_overlay` rows inside a sqlite transaction.
7. Handler emits `directory/pin/reordered` bus event via `publishLocalEvent`.
8. Bus event fans out to renderer (`onAgentEvent` subscription) AND to messaging controllers (currently no-op for directory pin events — messaging surfaces don't render directory lists, but the bus infrastructure delivers anyway).
9. Hook's bus-event handler re-applies the rank map to the snapshot (idempotent — patcher short-circuits if rank already matches).
10. Next snapshot reconciliation (`reconcileNavigationSnapshot`) reads `directory_overlay` rows and attaches `pinnedRank` to each summary. Hash includes the new ranks; snapshot is recomputed.

### Error & Failure Propagation

| Layer | Error | Handling |
|---|---|---|
| IPC handler | overlay-store write throws (sqlite error) | Handler throws; renderer `setDirectoryPin` catches in try/finally, calls `refresh()` to reload authoritative state. |
| Bus subscription | bus event arrives for a directoryKey not in the current snapshot | Patcher is a no-op (the snapshot's `directories` array doesn't contain the key; patcher's map-loop skips it). Next snapshot reconciliation surfaces the pin once the directory reappears. |
| Snapshot builder | overlay row exists for a key with no thread or launchpad | No summary added (mirrors current behavior — overlay alone doesn't materialize a directory). The pin metadata is preserved for when the directory reappears. |
| IPC validation | request targets a `workspace:` or `unlinked` key | Handler returns a structured rejection; renderer should never send these (UI doesn't expose drag/menu on those rows), but defense-in-depth blocks at the handler. |

### State Lifecycle Risks

- **Orphan overlay rows**: a directory's pin survives all of its threads being archived. This is intentional (mirrors thread-pin behavior). If the directory comes back, the pin re-applies. To clear the orphan, the user would need to explicitly unpin (impossible if the row isn't visible) — accept this as the same "ghost archived thread pin" tradeoff the thread system already has. Optional future cleanup: a "Forget unused directory pins" admin action.
- **Race: simultaneous setDirectoryPin from two windows**: each tab writes its own optimistic state, then the IPC + bus reconcile to whatever sqlite writes last (last-writer-wins). Mirrors thread pin behavior. No revision counter needed.
- **Schema migration**: adding the `directory_overlay` table is additive. Existing databases without the table will not error — the `CREATE TABLE IF NOT EXISTS` pattern in `state-db.ts` handles fresh creation on first open after upgrade.

### API Surface Parity

The directory-pin IPC shape mirrors thread-pin EXCEPT for the dropped `backend` field. Reviewers should check that:
- The `SetDirectoryPinRequest` / `ReorderDirectoryPinsRequest` shapes have no `backend` field (correct for global pinning).
- The bus event params have no `backend` field.
- The renderer hook's `setDirectoryPin(directory, pinned)` signature accepts a `NavigationDirectorySummary`, not a `(backend, key)` tuple.

### Integration Test Scenarios

Five cross-layer scenarios that unit tests with mocks would not catch:

1. **Pin → restart → reload**: user pins directory A, quits the app, relaunches → directory A appears in the pinned section at the same position. (Verifies overlay persistence + snapshot reconciliation.)
2. **Pin → archive all threads in directory → unarchive one → directory reappears in pinned section at original rank.** (Verifies overlay survives directory disappearance.)
3. **Pin via drag → close window → reopen window**: same window-instance, no app restart → directory pin is reflected via the next snapshot tick. (Verifies bus + snapshot hash, not just overlay.)
4. **Two open windows → pin in window A → window B sees the pin within one snapshot tick.** (Verifies bus delivery cross-window.)
5. **Add a new directory via the project-picker → pin it → unpin it via context menu → reload**: the pin doesn't persist after unpin. (Verifies the full create → pin → unpin → reload cycle.)

## Acceptance Criteria

### Functional Requirements

- [ ] User can drag any `kind: "directory"` directory row above the pinned divider in the Directories lens to pin it.
- [ ] User can drag a pinned directory below the divider to unpin it.
- [ ] User can reorder pinned directories by drag.
- [ ] User can reorder pinned directories via keyboard (Cmd+Shift+ArrowUp/Down on a focused pinned row).
- [ ] User can right-click a pinnable directory to open a context menu with a "Pin Directory" / "Unpin Directory" item (label reflects current state).
- [ ] `workspace` and `unlinked` directories are NOT pinnable (no drag handlers, no context menu pin item, IPC handler rejects).
- [ ] Pin state survives app restart.
- [ ] Pin state survives the directory temporarily disappearing from the snapshot (e.g., all threads archived) and reappearing later.
- [ ] Pin mutations from one window are visible in other open windows within one snapshot tick.

### Non-Functional Requirements

- [ ] No new dependencies (Electron, React, better-sqlite3 versions unchanged).
- [ ] Snapshot reconciliation tick time doesn't regress noticeably (hash now includes one more slice; bound the regression to <1ms per tick at 50 directories).
- [ ] Bus event subscription overhead unchanged for renderers that don't care about directory pin events (the three new event branches fall through quickly when not matched).

### Quality Gates

- [ ] `pnpm --filter @pwragent/desktop typecheck` clean.
- [ ] `pnpm lint:boundaries` clean (no new cross-package imports beyond the existing hierarchy).
- [ ] `pnpm lint:sql` clean (the new `directory_overlay` table uses prepared statements only).
- [ ] All new unit tests pass in <100ms each.
- [ ] New theme-contract assertions pass.

## Success Metrics

- Internal user feedback: the feature was requested by name in the previous PR thread; the success signal is "the user reports it works as expected after a single visual test".
- No regression in existing thread-pin tests (52 tests in `sidebar.test.tsx` pre-change).
- Snapshot hash invariant test catches the footgun on a deliberately-broken `buildNavigationSnapshotHash` (run with the directories slice removed; the test should fail loudly).

## Dependencies & Prerequisites

- No external dependencies. All work lives within the existing monorepo.
- Reads `docs/config-file-evolution.md` before bumping the sqlite schema version (per the project's stated rule).
- Reuses the existing `thread-pins.ts` helpers — no new pure-helper logic, just a directory-shaped shim around them.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Snapshot-hash footgun**: forgot to add the directories slice to `buildNavigationSnapshotHash`. The renderer never sees pin mutations. | Medium (this is the recurring footgun called out by the learnings researcher — has bitten the project before with thread fields) | High (entire feature appears broken) | **Unit E is test-first** and asserts the hash invariant. Test must be written BEFORE the rest of the snapshot work to act as a gate. |
| **Two-window race**: pin updates from window A overwrite window B's in-flight pin. | Low (the bus event is the source of truth; both windows reconcile to it) | Low (last-writer-wins, no data loss) | Mirror the thread-pin pattern — no extra revision counter needed. |
| **Sqlite migration breaks fresh installs**: `CREATE TABLE IF NOT EXISTS` doesn't fire because the existing migration step is skipped on an old version. | Low (pattern is established in state-db.ts) | Medium (some users get an error opening the DB) | Add the new table to the existing `SCHEMA_V<N>` bump; verify with the existing migration test pattern. |
| **Context menu collision with existing Sidebar event handlers** | Low (Sidebar's context menu is the only contender) | Low (the menu fails to open) | The new menu reuses the existing Sidebar menu plumbing — adding a new menu kind, not a parallel system. |
| **Drag indicator CSS conflicts** with existing `.thread-row-shell` rules | Low (selectors are class-scoped) | Low (visual bug only) | New selectors use `.directory-row-shell`, not `.thread-row-shell`. Theme-contract test locks the visual. |
| **Workspace pseudo-directory becomes pinnable** | Low (UI doesn't expose it) | Low (user pins a synthetic entry that looks weird) | IPC handler defense + builder defense — both reject `workspace:` / `unlinked` keys. Test in `sidebar.test.tsx`. |

## Resource Requirements

Single contributor. Estimated effort:
- Phase 1 (Foundation, contract + sqlite): 1–2 hours, mostly test scaffolding
- Phase 2 (Snapshot + IPC): 2 hours
- Phase 3 (Renderer state): 1–2 hours
- Phase 4 (Renderer UX): 2–3 hours (the DirectoriesList rewrite is the most code; the CSS and context menu are smaller)
- Phase 5 (Tests + invariants): 1–2 hours (extending existing test files)

Total: ~8–11 hours.

## Future Considerations

- **Forget unused directory pins** admin action — clean up overlay rows for directories that haven't appeared in the snapshot for N days.
- **Pin export/import** — if config-export ever surfaces directory pins as part of user preferences.
- **Pin sync across devices** — if iCloud / config-sync ever happens, directory pins should be in the sync envelope.

## Documentation Plan

- After landing, write `docs/solutions/2026-MM-DD-navigation-snapshot-hash-field-propagation.md` capturing the snapshot-hash contract (every field that affects renderer state must be in the hash) and the invariant-test pattern. This converts the recurring footgun from oral tradition to a grep-able artifact. (Recommended by the learnings researcher.)
- No user-facing doc updates needed — the affordance is discoverable via drag.

## Scope Boundaries

**In scope:**
- Pinning + reordering + unpinning of `kind: "directory"` rows in the Directories lens.
- Drag/drop + keyboard reorder + context menu affordances.
- Persistence across restarts and across windows.
- Tests at all five layers.

**Out of scope:**
- Pinning `workspace` or `unlinked` pseudo-directories.
- Per-backend pin order (decided to be global — see Alternative 2).
- Updated / Created lens reordering — those lenses sort threads, not directories.
- Pin sync across devices.
- Pin export/import as user preferences.

## Deferred to Implementation

- **Exact context-menu entry copy** — "Pin Directory" / "Unpin Directory" is the starting point; the actual label can change if the existing Sidebar menu has a convention I'm not aware of mid-implementation.
- **Drag handle visibility** — leaning "grab anywhere on the row" (matches thread pattern), but if implementation reveals an accidental-drag UX issue (e.g., dragging instead of clicking to expand), add a small drag handle to the left of the folder icon.
- **Whether to extract the existing Sidebar thread context menu into a shared component** — the directory menu and the thread menu share the same plumbing. If the implementation reveals a clean extraction point, do it; if it's more code than copy/paste, leave them inline.

## Sources & References

### Internal References (Thread-Pin Pattern, the Reference Implementation)

- **Contract**: `packages/shared/src/contracts/navigation.ts:31–32` (pinnedRank on summary), `:296–318` (request/response types), `:399–400` (overlay state).
- **Pure helpers**: `packages/shared/src/thread-pins.ts:1–92`, tests in `packages/shared/src/__tests__/thread-pins.test.ts`.
- **Sqlite persistence**: `apps/desktop/src/main/state/state-db.ts:85–94` (threads table), `apps/desktop/src/main/state/overlay-store-sqlite.ts:303–322` (setThreadPin), `:324–348` (reorderThreadPins), `:161–174` (snapshot-hash short-circuit).
- **Snapshot builder**: `packages/agent-core/src/domain/navigation-state.ts:123–184` (materialize threads), `:186–227` (buildNavigationSnapshot), `:229+` (hash), `:348` (threads slice's pinnedRank inclusion).
- **Directory builder (current state, no pin logic)**: `packages/agent-core/src/domain/directory-navigation.ts:339`.
- **IPC channels**: `apps/desktop/src/shared/ipc.ts:43–46` (thread pin channels).
- **IPC handlers**: `apps/desktop/src/main/ipc/app-server.ts:924–964` (setThreadPin), `:966–992` (reorderThreadPins), `:1309–1328` (handler registration), bus emit pattern in same file.
- **Bus notification types**: `packages/shared/src/contracts/normalized-app-server.ts:891–909`.
- **Preload bridge**: `apps/desktop/src/preload/index.ts:552–559`.
- **Renderer typed surface**: `apps/desktop/src/renderer/src/lib/desktop-api.ts:320–325`.
- **Renderer hook (snapshot patchers + bus subs + mutators)**: `apps/desktop/src/renderer/src/lib/useThreadNavigation.ts:465–517` (patchers), `:1911–1954` (bus subs), `:2887–2969` (mutators), `:3156–3157` (exposed surface).
- **Drag/drop helpers**: `apps/desktop/src/renderer/src/features/navigation/drag-drop.ts:1–25`.
- **Renderer drag UX**: `apps/desktop/src/renderer/src/features/navigation/RecentsList.tsx:47–234`.
- **Directories list (current state)**: `apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx:116–214` (threads-inside drag/drop), `:271–310` (summary button).
- **ThreadRow drop-indicator wiring**: `apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx:36`, `:137`, `:151–157`, `:166–182`, `:212–216`.
- **Sidebar context menu**: `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx:532–639`, pin toggle at `:546–554`.
- **Existing tests**:
  - Drag/drop sidebar tests: `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx:827`, `:874`, `:920`, `:952`, `:994`, `:1061`.
  - Overlay-store pin tests: `apps/desktop/src/main/__tests__/overlay-store-pins.test.ts:23–80`.
  - Pure-helper tests: `packages/shared/src/__tests__/thread-pins.test.ts`.
- **CSS**: `apps/desktop/src/renderer/src/styles/app.css:1431–1466` (thread-row-shell + drop indicators), `:1468–1500` (recents-pinned-divider), `:2148–2285` (directory-row rules).

### Related Work

- Previous sidebar tightening: PR #469 (this branch's parent direction — `ux/sidebar-directories-tighter`).
- Project-directory picker that lets users register new directories: PR #232 (issue #223).
- The recurring "snapshot hash missing field" footgun: no prior `docs/solutions/` entry; this plan recommends writing one after landing.
