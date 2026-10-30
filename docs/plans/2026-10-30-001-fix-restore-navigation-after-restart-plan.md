---
title: "Restore navigation after application restart"
type: fix
status: implemented
date: 2026-10-30
base_commit: 32ba3b3f7
---

# Restore navigation after application restart

Quitting and reopening PwrAgent, including restarting to install an update, should return the operator to their previous lens, expanded projects, loaded thread lists, and selected chat. Keep the implementation within the existing navigation state and persistence paths.

## Current behavior

- The latest code already persists the lens in the profile database as `navigation_browse_mode`. `navigation-browse-mode-bootstrap.ts` passes it through preload before React mounts. Preserve this behavior and cover every lens in regression tests.
- The Pinned group's disclosure is also already persisted.
- `useNavigationDirectoryDisclosure.ts` initializes project and unpinned-thread disclosures to empty maps on each launch.
- `NavigationWindowQueries` retains loaded ranges and explicit `expandedRows` demand only in renderer memory. Leaving and returning to a lens can reuse that memory; a process restart loses it.
- `useThreadNavigation.ts` initializes selection without a saved thread. Its `useRecoverableState` protects a React subtree remount, but does not persist across application launches.

## Intended behavior

1. Restore the last selected lens without first showing the default lens.
2. Restore expanded and collapsed projects, including each project's ordinary-thread disclosure.
3. Restore the depth requested through **Load more**, separately for each visited lens and project collection. Keep the directory index and pinned collections independent where they already page independently.
4. Reopen the selected chat, even when it is beyond the first page, is a sub-thread, or belongs to a peer. Use the existing identity, exact-selection, ancestry, and detail reads.
5. A saved explicit empty selection stays empty. Profiles without a saved session retain the current first-launch fallback.
6. An explicit startup request to open a particular thread or create a thread takes precedence over the saved selection.

State belongs to the active PwrAgent profile and the ordinary main window. Auxiliary and dedicated peer windows must not overwrite its saved session. Restoring the main window's selected peer chat still retains that chat's owner identity.

## Smallest implementation

### 1. Add one navigation resume record

Store one versioned JSON value, `navigation_resume_state`, in the existing SQLite `meta` table. No schema migration or TOML change is needed. Keep the existing lens and Pinned-group keys authoritative.

The new record contains only:

- The two existing project disclosure maps: `expandedByKey` and `unpinnedExpandedByKey`.
- Requested row counts for collections where the operator used **Load more**.
- The selected `NavigationIdentity`, or `null` for no chat. Distinguish an absent resume record from a saved empty selection.

Key row counts by stable collection semantics: lens, collection kind, directory or parent identity, and owner when applicable. The current resource ID `lens` is reused across lenses; it is insufficient by itself. Exclude runtime attention-view IDs, transport tokens, cursors, revisions, cached rows, and transcript data.

Add one narrow `setNavigationResumeState` IPC method beside the existing navigation preference setters. Validate and normalize the metadata, reject unsupported versions, and skip an identical write. Use one synchronous database commit per changed snapshot, with no periodic writes or unload-only save.

Send updates after committed selection/disclosure changes and completed explicit pagination actions. Keep the latest requested counts when initial pages, refreshes, or temporary errors return fewer rows. Do not persist in response to streamed thread updates or ordinary query publications. Keep updates ordered so an older snapshot cannot overwrite a newer selection.

### 2. Restore through the existing startup and query paths

Extend the existing main-to-preload navigation bootstrap with the optional resume metadata, then initialize disclosure and selection from it before navigation requests begin. Validate both stored and bridged input; missing or malformed state must leave the app usable. Keep the bootstrap payload bounded and small enough for its existing command-line transport.

Pass saved row targets to `NavigationWindowQueries` when their collections are first demanded. Reuse its retained-range rebuilding logic to fetch fresh pages to that depth, including multiple **Load more** blocks. Preserve the existing per-page, concurrency, and retained-memory limits. A collection with fewer available rows simply ends earlier. Do not fetch inactive lenses or collapsed projects just to restore their saved depth; apply it when they next become visible.

Initialize the saved chat before the initial fallback selection runs. Reuse the existing exact-selection query rather than scanning pages to find it. Apply restoration once; late startup responses must never undo a subsequent operator selection or an explicit open-thread request.

Clear a restored chat only after an authoritative response establishes that it was removed or archived, then use the existing fallback. Keep the identity during provider startup, partial coverage, errors, or a disconnected peer. Preserve the existing composer-readiness and unread rules; reopening a chat must never send a message or approval.

Save during navigation so normal quit and update-triggered restart share the same durable state. No updater-specific persistence path is planned.

### 3. Verify the restart contract

Extend the existing store and navigation-controller tests, plus one Electron regression that closes the actual process and launches a new one against the same isolated profile. A React remount or renderer reload is insufficient. The E2E harness currently removes its temporary profile on `close()`; preserve/reuse test-owned state for this scenario without touching operator state.

Acceptance cases:

- Every lens survives restart; existing Pinned-group persistence still works.
- Two expanded projects, one collapsed project, and their ordinary-thread disclosures survive restart.
- Multiple pagination blocks restore for projects and distinct lenses without sharing counts or requesting inactive collections.
- A selected chat outside page one reopens with its transcript; an explicit empty selection stays empty.
- A missing chat falls back; an unavailable provider or peer does not erase the saved selection.
- An explicit open-thread request and a selection made during startup win over restoration.
- A legacy profile and malformed resume metadata boot safely; auxiliary windows cannot overwrite the main session.
- Navigation followed immediately by normal quit preserves the latest change. Also verify the packaged update-and-restart path manually or in its existing supported test environment.

Measure the real SQLite write budget: one commit per changed resume snapshot, zero for repeated snapshots, ordinary refreshes, and streamed events. Report observed WAL bytes and project MB/day from an explicit navigation-action rate. Run focused tests, typecheck, both Oxlint passes, and dependency boundaries during implementation, following the repository's Sandboxer rule when that MCP is available.

## Expected code footprint

| Area | Change |
| --- | --- |
| Shared navigation contracts and overlay-store interface | Resume payload and setter types |
| SQLite overlay store | Read, normalize, and write one metadata record |
| Existing IPC service, channel, preload, and renderer API | One setter and optional bootstrap metadata |
| `useNavigationDirectoryDisclosure` and `useThreadNavigation` | Seed existing state and publish meaningful changes |
| `useBoundedNavigationWindow` and `NavigationWindowQueries` | Seed saved row targets and report explicit pagination changes |
| Existing tests and one restart E2E | Exercise persistence across a real process restart |

No new state-management framework, navigation cache on disk, setting, or UI is needed. Pixel scroll positions, extra-window restoration, and other main-view routes are outside this request.

## Implementation verification

- Implemented the resume record, bootstrap, disclosure/selection initialization, and fresh-page restoration within the existing navigation paths.
- Passed 294 focused tests across the shared normalizer, SQLite store/bootstrap, paged controller, and navigation hook. Coverage includes a late startup response after a new selection and dedicated peer-window isolation.
- Measured one SQLite commit and 8,272 WAL bytes for one changed snapshot; reordered duplicates and reads add no commits. At 1,000 navigation actions/day this small-snapshot scenario projects about 8.3 MB/day. Actual bytes depend on snapshot size and SQLite page layout.
- Typecheck, syntax/typed lint, dependency boundaries, and the desktop build pass.
- Added `apps/desktop/e2e/navigation-resume.spec.ts`; Playwright discovers it. It closes the first Electron process without removing its isolated profile, then relaunches against that same profile and checks selection, projects, and an unselected row beyond page one. No harness change was needed because `closeApplication()` already preserves the profile.
- The full macOS restart E2E and packaged update restart have not run: this thread has no PwrSuiteLab MCP connection or known primary lab checkout. The repository's macOS E2E skill prohibits using the physical host desktop for this test. An existing lab pointer was requested.
