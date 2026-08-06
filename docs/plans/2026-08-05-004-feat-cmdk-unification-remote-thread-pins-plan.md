---
title: "feat: Cmd+K unification + viewer-side remote thread pins"
type: feat
date: 2026-08-05
brainstorm: ../brainstorms/2026-08-05-cmdk-unification-remote-thread-pins-requirements.md
---

# Cmd+K unification + viewer-side remote thread pins

## Summary

Extend the ⌘K jump popup to query connected federation peers (async, debounced,
below the instant local hits, with PR-number matching parity), and let Enter on
a remote hit pin that thread into the LOCAL thread list as viewer-owned state:
a new `remote_thread_pins` overlay-store table, merged into the main window's
navigation snapshot with `federation` stamping, an instance chip on the row, an
in-place open in the main window, offline dimming from peer status, and a
"Remove from My List" action that works while the owner is unreachable.

Celestial icons (Star Map) have not landed anywhere — this plan ships a
placeholder `InstanceGlyph` with a swap seam.

## Work stream A — shared matcher hoist

Move the quick-jump matcher from the renderer into shared so main can run it
over remote summaries:

- New [packages/shared/src/thread-jump-match.ts](../../packages/shared/src/thread-jump-match.ts):
  `threadMatchesQuery`, `threadPrNumbers`, `threadIdMatchesQuery`,
  `agentMetadataMatchesQuery` — moved verbatim from
  `apps/desktop/src/renderer/src/features/thread-search/thread-match.ts`
  (they only depend on `NavigationThreadSummary`, already in shared). Export
  from the shared index.
- `thread-match.ts` re-exports them so the search panel's other helpers
  (`parsePrNumberQuery`, `threadsByPrNumber`, FTS merge) stay put and no
  renderer import churn is needed beyond the one file.
- Move the `threadMatchesQuery` describe block of
  `thread-match.test.ts` into
  `packages/shared/src/__tests__/thread-jump-match.test.ts`.

Boundaries: renderer may import `@pwragent/shared` (allowed); main may import
shared (allowed). No new edges.

## Work stream B — remote snapshot cache + jump search service (main)

New [apps/desktop/src/main/federation/remote-thread-summary-cache.ts](../../apps/desktop/src/main/federation/remote-thread-summary-cache.ts):

- `RemoteThreadSummaryCache` — per-peer cache of stamped
  `NavigationThreadSummary[]` from `remoteNavigationSnapshot(target, {})`,
  TTL ~15 s, per-peer in-flight coalescing, per-peer timeout (reuse the
  federated-search 10 s constant). Peers enumerated via
  `connectedPeerTargets()` filtered to the `thread_navigation` capability.
- `searchRemoteThreadsForJump({ query, limit })` — runs the shared
  `threadMatchesQuery` over each connected peer's cached rows; returns
  `{ results, searchedInstances, failures }` with results ordered by
  `updatedAt` desc and capped (default 8 remote rows).
- `resolveRemoteThreadSummaries(refs)` — for the snapshot merge (stream C):
  returns the pinned refs' summaries from cache/fetch, plus per-peer status so
  callers know which pins fell back to cached payloads.

IPC: new channel `FEDERATION_JUMP_SEARCH_CHANNEL = "federation:jump-search"`
(shared/ipc.ts), handler in `main/ipc/federation.ts`, preload
`jumpSearchRemoteThreads(request)`, renderer `desktopApi` binding. Request
`{ query: string; limit?: number }`; response
`{ results: NavigationThreadSummary[] }` (rows arrive fully stamped with
`federation`, so the popup renders them like any remote row).

## Work stream C — `remote_thread_pins` store + snapshot merge

### Table (state-db.ts, v42 → v43)

```sql
CREATE TABLE IF NOT EXISTS remote_thread_pins (
  instance_id TEXT NOT NULL,
  backend     TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (instance_id, backend, thread_id)
);
```

`payload` JSON: `{ summary: NavigationThreadSummary (last fetched, unstamped),
instanceLabel: string }` — the offline rendering source. Follows the
`thread_message_origins` template: DDL const + user_version ladder step + the
same DDL in `ensureCurrentSchema`.

### Store methods (`SqliteOverlayStore`)

- `addRemoteThreadPin({ ref, summary, instanceLabel, addedAt? })` — upsert
  (`ON CONFLICT DO UPDATE` refreshes payload, keeps original `added_at`).
- `removeRemoteThreadPin({ ref })` — local DELETE, no connectivity involved.
- `listRemoteThreadPins()` — all pins, parsed payloads, tolerant of
  unparseable payload rows (skip + log, never throw).
- `updateRemoteThreadPinSnapshots(entries)` — batch payload refresh used by
  the snapshot merge after successful peer fetches.

### Snapshot merge (`AppServerService.readNavigationSnapshot`)

After the local snapshot pipeline (post `hydrateThreadGitWorkingStates`),
when `request.federationTarget` is absent (main-window path only):

1. `listRemoteThreadPins()`; group by `instanceId`.
2. `resolveRemoteThreadSummaries` (stream B): connected peer → fresh summary
   (side effect: `updateRemoteThreadPinSnapshots`); unreachable peer or thread
   missing from its snapshot → cached payload. Stamp every row
   `federation: { ref, instanceLabel, peerStatus, capabilities }` — status
   from the runtime's visible-peer view, so offline rows carry
   `peerStatus: "disconnected"` (or the actual non-connected state).
3. Append to `threads`, recombine `inboxThreadKeys` (local keys + remote rows
   already ranked by the owner — same recombination the messaging bridge
   does), and fold a JSON hash of the merged remote rows into the `unchanged`
   decision so peer-side title/PR/status changes are never suppressed.

Pin add/remove IPC: `NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL =
"navigation:add-remote-thread-pin"` / `NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL
= "navigation:remove-remote-thread-pin"`, service methods on
`AppServerService`, preload + `desktopApi` bindings. Add accepts
`{ ref, summary?, instanceLabel? }` — the popup passes the summary it already
has so the row renders before the next snapshot refresh.

## Work stream D — Cmd+K popup

`SidebarSearchPopup.tsx`:

- Keep the synchronous local `useMemo` filter untouched.
- Add a debounced (200 ms) effect: non-empty trimmed query →
  `desktopApi.jumpSearchRemoteThreads({ query })` guarded by a request
  generation counter (stale responses dropped); skip entirely in federation
  windows (`readRendererFederationTarget()` set) — a remote-viewer window
  keeps today's behavior.
- Render order: local rows (cap 8, unchanged) → `sidebar-search__divider`
  ("Other instances") → remote rows with `InstanceChip`, or a
  `sidebar-search__loading` row while in flight. Remote rows join the same
  `activeIndex` keyboard-nav list (flattened array; ArrowDown walks from
  local into remote). Dedupe remote hits whose identity key already appears
  in the local list (a thread pinned earlier is already local-visible).
- Enter/click on a remote row → new prop `onJumpToRemoteThread(summary)`.
  App.tsx handler: `addRemoteThreadPin` → `navigation.refresh` → select the
  thread (same reveal/peek dance as local jumps).

## Work stream E — rows, chip, watermark, open-in-place, removal

- **`InstanceGlyph`** ([apps/desktop/src/renderer/src/features/federation/InstanceGlyph.tsx](../../apps/desktop/src/renderer/src/features/federation/InstanceGlyph.tsx)):
  placeholder deterministic glyph (small inline SVG variants selected by a
  hash of `instanceId`, `currentColor` only). Documented swap seam for the
  Star Map celestial set. `InstanceChip` = glyph + label using the `.chip`
  pill primitive (`thread-row__chip--instance`), tokens only from app.css.
- **Thread rows**: `ThreadMetaChips` renders `InstanceChip` when
  `thread.federation` is set and the window is the main window; row shell gets
  `is-remote-offline` (dim via `opacity` + muted title token) when
  `federation.peerStatus` is present and ≠ `"connected"`.
- **Peer-status patching in the main window**: widen the
  `federation/peerStatus/changed` gate in `useThreadNavigation.ts:3186+` — when
  the window target is unset, patch `federation.peerStatus` on rows whose
  `federation.ref.target` matches the event target (and schedule a refresh on
  reconnect, mirroring the federation-window path).
- **Open in place**: selection already scopes IPC via
  `selectedThreadFederationTarget` (App.tsx:737-757). Audit the enumerated
  call sites for window-target-only stamping on paths reachable from a
  main-window remote selection (the explorer's list: pin reorder at
  `useThreadNavigation.ts:5952` is local-only by design; verify each). The
  unreachable-peer banner: `useFederationPeerConnectivity` must key off
  `activeFederationTarget` (selected-thread-aware) rather than only the window
  target.
- **Watermark**: `InstanceWatermark` in ThreadView behind the transcript —
  absolutely positioned, `pointer-events: none`, low-opacity `InstanceGlyph`
  scaled large; owning instance for remote threads, local instance identity
  (federation health `instanceLabel` / local instanceId) for local threads.
- **Removal**: Sidebar context menu — when the row is a main-window remote
  pinned row, show `Open`, copy actions, and `Remove from My List`
  (→ `removeRemoteThreadPin`); omit Archive/Rename/Pin/Mark Unread and other
  owner-or-local-overlay actions. Works offline (local DELETE + refresh).
- **Owner-side guards** (verify, don't assume): `usePullRequestRefresh`
  already guards `isRemoteFederatedThread(thread)` per-thread — add a
  main-window test; terminal cwd stays undefined for federated threads in
  ThreadView; main-side `refreshThreadPullRequests` throw path untouched.

## Test plan

- `packages/shared/src/__tests__/thread-jump-match.test.ts` — moved matcher
  suite (PR-number, thread-id fragment, agent metadata cases).
- `apps/desktop/src/main/__tests__/remote-thread-pins-store.test.ts` — table
  CRUD: upsert idempotence (added_at preserved), delete without peer,
  malformed-payload tolerance, migration (fresh DB + v42→v43 ladder).
- `apps/desktop/src/main/__tests__/remote-thread-summary-cache.test.ts` — TTL
  + coalescing, per-peer timeout → failure entry, jump-search filtering incl.
  PR-number match against stamped remote rows.
- Navigation snapshot merge test (main): pinned + connected → stamped fresh
  row & payload refreshed; pinned + unreachable → cached row with
  non-connected `peerStatus`; `unchanged` flips when a remote title changes.
- `SidebarSearchPopup.test.tsx` — remote section renders after debounce with
  instance chip; loading state; ArrowDown crosses local→remote; Enter fires
  `onJumpToRemoteThread`; stale responses dropped; federation window skips
  remote querying.
- Row/dimming test — `is-remote-offline` class + chip presence from
  `federation.peerStatus`.
- `usePullRequestRefresh` main-window remote-thread guard test.
- Context-menu test — remote pinned row shows reduced action set;
  `Remove from My List` dispatches while `peerStatus: "disconnected"`.

## Progress

- [x] A: matcher hoisted to shared + tests moved
- [x] B: RemoteThreadSummaryCache + jump-search IPC
- [x] C: remote_thread_pins table + store methods + snapshot merge + pin IPC
- [x] D: SidebarSearchPopup remote section + App wiring
- [x] E: InstanceGlyph/Chip, row dimming, peer-status gate widening, watermark,
      context-menu removal, guard verification
- [x] Verify: eslint, typecheck, lint:boundaries, targeted vitest suites

## Resolved during implementation

- The main window's integrated-terminal IPC routes by WINDOW identity, so an
  enabled terminal toggle on a remote-pinned thread would have spawned a
  local shell under a remote thread. `resolveRemoteTerminalDisabledReason`
  now also disables the toggle whenever the window is not a federation
  window ("Terminal for this thread runs on <label> — open its remote
  window."), with tests for both window shapes.
- Cached pin payloads persist UNSTAMPED (the `federation` stamp is live
  state re-applied at merge time) so a stale peerStatus can never leak from
  the database into rendered rows.
- The snapshot `unchanged` hash for merged remote rows is seeded with the
  empty-list hash so a pinless boot never defeats the optimization.
- `useFederationPeerConnectivity` already keys off `activeFederationTarget`
  (selected-thread-aware), so the unreachable banner needed no change for
  the main-window path.

## Post-rebase onto the Star Map stack (PR #1249)

- Rebased onto `star-map/celestial-icons` once it appeared; the placeholder
  swap seam paid off: `InstanceWatermark` + `useLocalInstanceId` were deleted
  in favor of #1249's `CelestialWatermark`/`useCelestialIcons`, and
  `InstanceChip` now renders the assigned `CelestialIcon` (resolved at
  stamping time via a new `federation.celestialIcon` field on
  `NavigationThreadSummary`), keeping the placeholder glyph only as the
  fallback for peers without an assignment (e.g. pre-celestial builds).
- Operator testing found two viewer-side gaps, both fixed:
  - Pinned remote threads were absent from the Directories lens — the merge
    appended threads but never joined them to a local project group. They now
    consolidate into matching local directory summaries by project identity
    (directory label or path basename; peer paths never match viewer paths).
    `selectedDirectory` resolves by `threadKeys` membership, so this also
    restores the title-bar breadcrumb for matched projects.
  - For remote projects with no local counterpart, the breadcrumb falls back
    to the owner-reported `linkedDirectories[0].label`; such threads surface
    in the Updated / Created lenses only.
- Plan renumbered 003 → 004: the Star Map plan landed as
  `2026-08-05-003-feat-star-map-mission-control-plan.md` on the same day.
