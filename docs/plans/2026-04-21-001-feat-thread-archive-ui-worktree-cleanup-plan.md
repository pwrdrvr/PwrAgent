---
title: "feat: Thread archive UI, confirmation, context menu, and worktree deletion"
type: feat
status: completed
date: 2026-04-21
origin: user-directive
---

# feat: Thread archive UI, confirmation, context menu, and worktree deletion

## Overview

Add UI affordances for archiving threads in the desktop sidebar thread list (Inbox/Recents/Directories lens). Support mouse-over archive button (with confirmation dialog) and right-click context menu entry ("Archive Thread", direct action). On archive, mark the thread as archived (leveraging existing Codex archived metadata and thread/list filtering) and delete any associated Git worktree to clean up disk/resources.

This builds on existing backend support for `archived` flag in thread summaries, merged active/archived lists in `codex-app-server/client.ts`, and worktree handling in directory linking.

## Problem Frame

Current state:
- Sidebar thread rows in `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx` and thread list components support mouse-over states but no archive button.
- No right-click context menu on thread list items (though other lists may have menus).
- Archiving exists in Codex protocol (`thread/list` with archived filter, mergeArchivedThreadMetadata) but no UI trigger in desktop for Grok/Codex threads.
- Worktrees are created/linked for threads (see `backend-registry.ts`, worktreePath in summaries); no current archive hook deletes them.
- Confirmation dialogs exist elsewhere (e.g. for dangerous actions); reuse or extend for archive button path.
- Product tone (per desktop-style-guide.md): calm, editorial, avoid noisy confirmations where possible—hence direct context menu, confirmed button.

No existing "archive" UI in thread rows or context menus.

## Requirements Trace

- R1. Mouse-over on thread list item shows an archive icon/button; clicking opens a confirmation dialog ("Archive this thread? This will also delete its worktree.").
- R2. Right-click on thread list item shows context menu with "Archive Thread" (no confirmation; executes immediately).
- R3. Archiving calls appropriate backend/app-server method to set archived state, removing from active lists (Inbox/Recents) but preserving in archived view if implemented.
- R4. On archive, identify and delete the associated Git worktree (using git worktree remove --force if needed).
- R5. Archived threads remain readable but non-editable/mutable; worktree deletion is permanent (with safety checks to avoid deleting main repo).
- R6. Align with current thread lens (Inbox leftmost, Recents default); archived may appear in a new or existing "Archived" lens later.
- R7. Preserve approval flows if archiving counts as mutating action; but per user, context menu is direct.
- R8. Follow UI-THEME.md and desktop-style-guide.md for icons, hover states, menu styling, copy, radius, colors (use orange for destructive? but calm tone favors neutral).

## Scope Boundaries

- In scope: Sidebar thread row hover button, confirmation dialog, right-click menu component, archive action handler, worktree deletion logic (in main process or agent-core).
- In scope: Update thread list rendering to filter or tag archived items; extend existing mergeArchivedThreadMetadata if needed for Grok parity.
- In scope: Unit/E2E tests for new UI paths and worktree cleanup.
- Out of scope: Full "Archived" view/lens in sidebar (assume archive hides from active lists for now).
- Out of scope: Archiving directories vs threads; focus on threads.
- Out of scope: Changing existing active plan files or deleting brainstorms/plans.
- Superseded: Backend changes to Grok rollout for archive events were originally out of scope, but the implementation added `thread/archive` support because the execution directive explicitly required Grok App Server parity.

## Context & Research

### Relevant Code and Patterns

- `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx` and thread row components for list rendering, hover, events.
- `apps/desktop/src/main/codex-app-server/client.ts` for archived metadata merging, thread/list calls.
- Worktree logic in `packages/agent-core/src/persistence/` or desktop backend-registry, git commands via shell_command or dedicated tool.
- Context menu examples (if any) in renderer; confirmation via existing dialog primitives (per style guide).
- `docs/design/desktop-style-guide.md` for copy ("Archive Thread"), tone, anti-patterns (no browser defaults, calm density).
- Existing destructive actions (e.g. delete) for confirmation patterns.

### Current Product Direction

- Threads first-class, may exist without directory.
- Recents default lens; Inbox leftmost.
- Linked Git directories/worktrees per thread.

## Key Technical Decisions

- Use existing `archived` flag in thread summaries rather than new state.
- For worktree deletion: Use `git worktree remove` via shell runner (safe read-only? No, mutating—require approval if policy requires, but per user direct for menu).
- Confirmation only for hover button (destructive mouse action); context menu direct (standard UX for lists).
- Add to thread row component: conditional hover archive icon (use theme token for icon).
- Context menu: Reuse or add React context menu lib if present, or native Electron menu in main for renderer IPC.
- Update tests in desktop E2E fixtures for archive flow if it affects replay.

## Open Questions

### Resolved During Planning

- Confirm on button only, not menu: Yes, per user directive.
- Delete worktree on archive: Yes, as specified ("we should also delete the worktree").
- Grok vs Codex: Extend Codex path to Grok via shared client logic.

### Deferred to Implementation

- Exact icon for archive button (trash? folder-archive? follow theme).
- Whether archive moves to separate lens immediately or just filters from active.
- Error handling if worktree delete fails (e.g. locked files).

## High-Level Technical Design

- Renderer: Extend ThreadRow component with hover ArchiveButton (calls confirm dialog then IPC archiveThread(threadId)).
- Context menu: Add onContextMenu handler on list items, show Electron Menu with archive item (direct IPC).
- Main process: New IPC handler for archiveThread -> call app-server to archive, then deleteWorktreeIfPresent(thread).
- Worktree deletion: Use ProcessRunner for `git worktree remove <path>`.
- Persistence: Leverage existing archived merge; update thread/read to reflect archived state.

## Implementation Units

- [x] **Unit 1: Plan and backend/archive handler**
  - Create/update plan (this doc).
  - Add archiveThread IPC in desktop main (apps/desktop/src/main/ipc/*).
  - Extend codex-app-server/client.ts or grok equivalent for archiving call (thread/archive? or update with archived flag).
  - Implement worktree deletion (new method in backend-registry or tool).
  - Test: unit for worktree cleanup.

- [x] **Unit 2: UI hover button and confirmation**
  - Update thread list/row in renderer for mouse-over archive icon.
  - Add confirmation dialog (reuse existing modal/confirm pattern per style guide).
  - Wire to IPC on confirm.
  - Follow UI-THEME.md for styling/hover.

- [x] **Unit 3: Right-click context menu**
  - Add context menu to thread list items.
  - Menu item "Archive Thread" -> direct IPC (no dialog).
  - Style per desktop-style-guide.md (calm, editorial).

- [x] **Unit 4: Tests and parity**
  - Update E2E replay fixture or add test for archive flow.
  - Ensure Grok threads support archived state like Codex.
  - Verify worktree is deleted, thread hidden from active lists.

Start with Unit 1 (plan is decision artifact). Align all changes to desktop style guide and UI theme. Do not invent new copy or patterns.

## Completion Notes

- Added Codex `thread/archive` invocation and Grok App Server `thread/archive` support.
- Added desktop IPC/preload/renderer archive wiring.
- Archive removes the thread from active navigation, emits `thread/archived`, and leaves replay readable.
- Worktree cleanup uses `git worktree remove --force` and deletes the local branch when it is not protected.
- Sidebar hover archive requires confirmation; right-click context menu archives directly.
- Verified with focused main/renderer tests, full agent-core tests, and package typechecks.
