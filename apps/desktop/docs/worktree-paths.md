# Worktree Path Computation

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Worktree Path Computation

- **All worktree paths** must use the shared `computeWorktreePath` from `src/main/app-server/git-directory-service.ts`.
- There are two code paths that create worktrees: `prepareLaunchpadWorkspace` (in `git-directory-service.ts`) and `handoffLocalToWorktree` / `handoffLocalChangesToDetachedWorktree` (in `git-workspace-handoff-service.ts`). Both must use the same path builder.
- The naming pattern is `<root>/<hash>/<project-folder-name>` where `<hash>` is `Date.now().toString(36)` and `<project-folder-name>` is `path.basename(repoRoot)` preserving original casing.
- Do not introduce additional worktree path builders — centralize in `computeWorktreePath`.

## Worktree Roots and the Worktree Folder

`worktreesRootFor` picks `<root>` from Settings → Worktrees:

| Storage (`[worktrees] storage`) | Backend | Root |
| --- | --- | --- |
| `in-repo` | any | `<repo>/.worktrees` |
| `user-home` (default) | Codex | `$CODEX_HOME/worktrees` (default `~/.codex/worktrees`) |
| `user-home` + `base_directory_includes_codex` | Codex | `<folder>/.codex/worktrees` |
| `user-home` | others | `<folder>/.pwragent/worktrees` |

`<folder>` is `[worktrees] base_directory` when set, otherwise the home folder. Operators set it with
**Worktree folder → Choose…** in Settings → Worktrees, for example to keep worktrees on an external drive
instead of a small startup disk. **Use home folder** removes the key. It must be an absolute path. A
build without this setting ignores the key and uses the home folder.

- The folder names a parent, not the root: PwrAgent always appends `.pwragent/worktrees`. Path-based
  recognition (`isToolManagedWorktreePath` in `@pwragent/shared`) matches that suffix anywhere, so thread
  rows, project matching and maintenance need no new rules. Do not let the setting name the root directly.
- `computeWorktreePath` never creates the folder itself, only `.pwragent/worktrees` beneath it. With an
  external drive unmounted, `mkdir -p /Volumes/<drive>/…` would silently put worktrees on the startup disk,
  so allocation throws "Worktree folder … is not available" instead.
- The settings snapshot never stats the folder: on a stale network mount a stat can block the main
  process for the network timeout. Settings → Worktrees asks `settings:worktree-folder-check`
  (`checkWorktreeFolder` in `src/main/settings/worktree-folder-check.ts`) when it shows the folder and
  whenever the window regains focus, and shows **Checking…**, **Available**, **Not available**, or
  **Not responding** (no answer within 3 seconds). The check reads the configured folder itself; the
  renderer cannot name a path.
- Codex threads keep `$CODEX_HOME/worktrees` unless **Use for Codex threads too**
  (`base_directory_includes_codex = true`) is on. Codex Desktop lists an owner-marked worktree
  (`codex-thread.json` in its Git directory) only under `$CODEX_HOME/worktrees` (#164), so it does not
  show worktrees in the folder. The Codex CLI and App Server treat the folder as an ordinary `cwd`.
- Changing the folder does not move existing worktrees. Archive and hibernation manage the home root and
  the folder's root (`managedMaintenanceRoots` in `backend-registry-wiring.ts`), so older worktrees age out.
- A worktree on a different volume from its repository is fine: git records absolute paths, and handoff
  moves changes with git commands, not filesystem renames.

## Worktrees on Another Drive

`git worktree prune`, and `git gc` after `gc.worktreePruneExpire`, delete the Git records of a worktree
whose folder is missing; the checkout is then no longer a working tree. An unplugged drive looks
exactly like that. So every worktree PwrAgent creates or restores on a different volume from its
repository is locked with `PWRAGENT_WORKTREE_LOCK_REASON` (`src/main/app-server/worktree-volume-lock.ts`),
as Git's documentation advises for removable media.

- Create and remove worktrees only with `addManagedWorktree` and `removeManagedWorktree`
  (`src/main/app-server/managed-worktree.ts`). Each caller passes its own Git runner, so environment and
  Windows process ownership stay with the caller (`removeGit` runs the remove alone when it needs
  options the unlock must not get). `managed-worktree-guard.test.ts` fails on a raw `git worktree`
  add, remove, lock, or unlock anywhere else in the main process.
- The add locks the new worktree when its volume differs from the repository's (`stat().dev`), and
  never fails creation over the lock.
- The remove clears only PwrAgent's own lock, so a lock someone else set still stops the removal. It
  reads only this worktree's `locked` file (never `git worktree list`, which would make archiving a fleet
  quadratic), or, when the checkout folder may be gone, the `lock` record the caller passes.
- A thread handed in from another instance is created by `packages/federation`, which cannot import
  desktop code. The desktop wrapper in `src/main/federation/thread-instance-handoff-service.ts` calls
  `lockExternallyAddedWorktree` after the import and `unlockBeforeExternalRemoval` before its rollback.
- Recovery (`worktree-recovery-service.ts`) clears PwrAgent's lock only when the worktree's `<hash>`
  container still exists. With the drive unplugged the container is gone too, and recovery refuses
  with "The drive that holds … is not connected" rather than recreating the checkout on the startup disk.
