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
  so allocation throws "Worktree folder … is not available" instead. Settings shows **Not available**.
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

- Lock after every `git worktree add` with `lockWorktreeOnSeparateVolume`. It compares the volumes
  (`stat().dev`) and never fails creation.
- Before every PwrAgent removal, call `unlockPwrAgentWorktreeLock`. It reads only this worktree's
  `locked` file (never `git worktree list`, which would make archiving a fleet quadratic) and clears
  only PwrAgent's own lock, so a lock someone else set still stops the removal.
- Recovery (`worktree-recovery-service.ts`) clears PwrAgent's lock only when the worktree's `<hash>`
  container still exists. With the drive unplugged the container is gone too, and recovery refuses
  with "The drive that holds … is not connected" rather than recreating the checkout on the startup disk.
