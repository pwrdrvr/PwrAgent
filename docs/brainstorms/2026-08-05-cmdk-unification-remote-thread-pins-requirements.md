---
date: 2026-08-05
topic: cmdk-unification-remote-thread-pins
---

# Cmd+K Unification and Viewer-Side Remote Thread Pins Requirements

## Summary

Cmd+K should stop being a local-only filter and become the single "jump to any
thread I care about, anywhere" surface. Today `SidebarSearchPopup` +
`threadMatchesQuery` filter only the current window's in-memory thread array —
no IPC, no federation. The target experience, in the operator's own words:

> "I hit Cmd+K, type a PR number I'm looking at, see that PR 981 for whatever
> project is on some machine I'm not on (don't care), arrow down, hit enter,
> and it appears in the local thread list with a chip telling me where it's
> running. True unification."

Two deliverables fall out of that sentence:

1. **Cmd+K unification** — the popup also queries connected federation peers
   (async, debounced, appended below the instant local hits) with matching
   parity: a PR-number query must hit remote threads exactly the way it hits
   local ones.
2. **Viewer-side remote thread pins** — Enter on a remote hit pins that thread
   into the LOCAL thread list. The pin is viewer-owned state (a new
   overlay-store table), the row carries an instance chip, clicking it opens
   the thread in-place in the main window, and the pin survives (dimmed) when
   the owner is unreachable.

## Problem Frame

- Cmd+K (`SidebarSearchPopup.tsx` + `thread-match.ts:threadMatchesQuery`) is
  instant but blind to peers. The full search panel (⌘⇧F) does fan out to
  peers via `searchThreads` → `searchConnectedPeers`, but (a) it's a heavier
  surface, (b) remote matching is title/metadata-only because the fan-out uses
  peer `listThreads({ filter })` and `AppServerThreadSummary` carries **no PR
  chips** — a PR-number query can never hit a remote thread today, and (c)
  opening a remote result spawns a separate remote-viewer window rather than
  landing the thread in the operator's one list.
- Remote threads are only visible while a remote-viewer window is open. There
  is no way to say "keep this one thread from that machine on my main list."
- The federation plumbing needed for the rest already exists: per-thread
  `federation: { ref, instanceLabel, peerStatus, capabilities }` stamping
  (`remoteNavigationSnapshot`), App-shell IPC scoping by the selected thread's
  ref (`selectedThreadFederationTarget` → `scopeDesktopApiToFederationTarget`),
  peer status events (`federation/peerStatus/changed`), and owner-side service
  guards for terminals and PR refresh.

## Target Experience

- ⌘K keeps its instant local behavior — local results render synchronously,
  exactly as today, always above remote results.
- ~200 ms after the operator stops typing, remote results appear below a
  divider, each row carrying an **instance chip** (peer glyph + display label
  from `formatFederationPeerDisplayLabel`). A loading row shows while the peer
  query is in flight; peers that fail or time out are skipped silently in the
  popup (Cmd+K is a jump surface, not a diagnostics surface).
- PR-number, title, branch, directory-label, and thread-id-fragment queries
  match remote threads with the same semantics as local ones.
- Enter (or click) on a remote hit: the thread is pinned into the local list,
  selected, and opens in-place in the main window. No new window.
- The pinned row lives in the main thread list with the instance chip. While
  viewing it, the owning instance's glyph renders alpha-blended behind the
  transcript (watermark); viewing a local thread shows the local instance
  glyph; it flips as selection moves.
- Owner goes unreachable → the pinned rows stay, dimmed, with their last-known
  title/chips; opening one shows the existing "peer unreachable" degraded
  state. Owner comes back → rows refresh live.
- "Remove from My List" on a pinned remote row deletes only the viewer-side
  pin. It is NOT an archive — the owner's thread is untouched — and it must
  work while the owner is unreachable.

## Requirements

### Cmd+K remote querying

- Local filtering stays synchronous and in-memory; remote querying is
  debounced and async, and never delays local rows.
- **Matching parity requirement:** remote matching must include PR numbers.
  Peer `listThreads` summaries have no `prs`, but peer `getNavigationSnapshot`
  responses do (the owner merges its overlay `prs` before serving). So the
  remote query path must be built on navigation-snapshot-shaped summaries, and
  the matcher must be the same `threadMatchesQuery` used locally — which means
  hoisting it (and its helpers) from the renderer into `packages/shared` so
  both the renderer and the main process can run it.
- Fan-out reuses the federation-runtime peer enumeration
  (`connectedPeerTargets`), per-peer timeout, and display-label composition
  that `searchConnectedPeers` uses. Snapshot responses should be cached
  briefly (main process, per peer, short TTL) so keystroke-debounced queries
  don't re-fetch full snapshots per keypress.
- Remote result rows are capped separately from local rows so a chatty peer
  cannot push local hits off the list.

### Viewer-side pin store

- New overlay-store table `remote_thread_pins`: `instance_id`, `backend`,
  `thread_id`, `added_at`, plus a `payload` JSON column caching the last
  successfully fetched thread summary and instance label. The cached summary
  is what renders when the owner is unreachable — without it a dimmed offline
  row would have no title.
- Deliberately viewer-owned: nothing is written to the owning instance. The
  owner never learns it has been pinned.
- Pinning is idempotent (re-pinning an already-pinned thread just re-selects
  it). Removal is a local DELETE and must not require peer connectivity.

### Navigation snapshot merge

- The main window's navigation snapshot merges pinned remote thread summaries
  (fetched from connected peers, stamped with `federation` refs exactly like
  `remoteNavigationSnapshot` does) after the local snapshot is built.
- Unreachable peer → merge the cached payload stamped with the peer's current
  non-connected status so rows render dimmed. Reachable peer → refresh the
  cached payload as a side effect.
- The snapshot `unchanged` optimization must account for the merged remote
  rows (a remote title change or peer-status flip must not be suppressed).
- Peer-status events must reach the main window's rows. Today
  `useThreadNavigation` gates `federation/peerStatus/changed` on the
  window-level federation target, which the main window doesn't have; the gate
  must widen to patch rows whose `federation.ref.target` matches the event.

### In-place open

- Selection routing already works: `selectedThreadFederationTarget` scopes
  thread IPC per selected thread. Audit the remaining call sites that read
  only the window-level target (`readRendererFederationTarget()` without a
  per-thread fallback) and stamp them.
- Owner-side service guards must hold on the main-window path: PR polling
  (`usePullRequestRefresh` already checks `isRemoteFederatedThread` per
  thread), terminal cwd resolution (`ThreadView` returns no local cwd for
  federated threads), and main-side throws for remote PR refresh. Verified by
  tests, not assumption.

### Instance chip and watermark

- The celestial icon system (Star Map branch) has NOT landed — no `celestial`
  / star-map / watermark code exists in the tree as of 2026-08-05. Build a
  placeholder: a deterministic-per-instance glyph component with a narrow
  interface (`instanceId`, size) so the Star Map SVG set + federation-synced
  assignment can swap in behind it without touching call sites.
- Chip = glyph + display label; used on Cmd+K remote rows and pinned remote
  thread rows. Reuse the existing chip pill primitive and theme tokens; no new
  colors.
- Watermark = same glyph, alpha-blended behind the transcript; owning
  instance's glyph for remote threads, local instance's for local threads.

### Removal

- Context menu on pinned remote rows offers "Remove from My List" and omits
  owner-mutating actions (Archive, Rename, local Pin) — the main-window menu
  today assumes local threads; remote rows need their own reduced action set.

## What We're Reusing

- `threadMatchesQuery` + helpers (`thread-match.ts`) — hoisted to shared,
  behavior unchanged; existing unit tests move with it.
- `remoteNavigationSnapshot` stamping (`federation-runtime.ts:670`) and
  `formatFederationPeerDisplayLabel` for labels.
- `connectedPeerTargets` + capability filtering (`thread_navigation`) and the
  per-peer timeout pattern from `federated-search-service.ts`.
- The `thread_message_origins` dedicated-table template in `state-db.ts` for
  the new pin table (composite PK, `payload` JSON, user_version ladder +
  `ensureCurrentSchema`).
- `federation/peerStatus/changed` agent events and
  `useFederationPeerConnectivity` for offline dimming and the unreachable
  banner.
- The remote-viewer window's guard sites (terminal bridge, PR refresh throws)
  — verified to hold when the same threads render in the main window.

## Explicitly Out of Scope

- The real celestial icon system (SVG set, federation-synced assignment) —
  placeholder glyph only, swap seam documented.
- Remote message-content search from Cmd+K (metadata/PR/title/branch only).
- Syncing pins across instances or notifying the owner of pins.
- Changing the full search panel (⌘⇧F) remote flow or its new-window opening
  behavior.
- Gateway-relayed (non-directly-connected) peers beyond whatever
  `connectedPeerTargets` already exposes.

## Key Decisions

1. **Remote matching source: peer navigation snapshots, not `listThreads`
   filters.** It's the only remote summary shape carrying PR chips, and it
   lets one matcher serve both sides. Cost: heavier per-fetch payload,
   mitigated by main-process TTL caching. Alternative (extending the peer-side
   `listThreads` filter to PR numbers) was rejected: it needs a protocol
   change on the owner side, so old peers would silently lack PR matching.
2. **Pins are a dedicated table, not `pinnedRank` overlay state.** Local pins
   are ranks on local thread overlay rows; remote pins are membership + cached
   snapshot for rows the local instance doesn't own. Different lifecycle,
   different table.
3. **Pinned remote rows are ordinary list rows** (recent-activity ordering in
   Inbox, creation ordering in Recents), not members of the local pinned-rank
   section. "Pin" in this feature means "keep on my list," not "rank at top."
   Local pinnedRank on a remote row stays possible later but is out of scope.
4. **Placeholder glyph now, celestial swap later** — confirmed the Star Map
   branch does not exist on any remote yet.
