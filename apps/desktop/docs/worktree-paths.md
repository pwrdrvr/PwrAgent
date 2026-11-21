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
| `user-home` + folder + `base_directory_includes_codex` | Codex | `<folder>/codex` |
| `user-home` + folder | others | `<folder>` |
| `user-home`, no folder | others | `~/.pwragent/worktrees` |

`<folder>` is `[worktrees] base_directory`. Operators set it with **Worktree folder → Choose…** in
Settings → Worktrees, for example to keep worktrees on an external drive instead of a small startup
disk. **Use home folder** removes the key. It must be an absolute path. A build without this setting
ignores the key and uses the home folder.

- The folder is the root: worktrees go straight into it as `<folder>/<hash>/<project>`, with no
  `.pwragent/worktrees` in the path. Path-based recognition (`isToolManagedWorktreePath` and
  `toolWorktreeRootOwner` in `@pwragent/shared/worktree-paths`) still matches that suffix anywhere, and
  matches the folder through `setConfiguredWorktreeFolder`. The main process calls it at startup and on
  every `[worktrees]` change (`desktop-settings-singleton.ts`); each window calls it from its settings
  snapshot (`useDesktopSettings`). `<folder>/codex` decides before `<folder>`, so a Codex hash folder is
  never taken for a PwrAgent worktree. A folder chosen earlier is no longer recognized by path; threads
  keep their recorded worktree paths.
- A folder that already holds other files would make its subfolders look like worktrees, so it is
  refused: `checkWorktreeFolder` reports `in-use` unless the folder holds only hidden entries or carries
  `WORKTREE_FOLDER_MARKER` (`.pwragent-worktrees`). Worktree creation writes that marker before the
  first worktree, and maintenance counts the folder as a managed root only once it is marked. The
  `codex` subfolder is never a managed root (`isInManagedWorktreeRoot`), as `$CODEX_HOME/worktrees`
  never was.
- `computeWorktreePath` never creates the folder itself, only the `codex` subfolder and hash folders in
  it. With an external drive unmounted, `mkdir -p /Volumes/<drive>/…` would silently put worktrees on
  the startup disk, so allocation throws "Worktree folder … is not available" instead.
- The settings snapshot never stats the folder: on a stale network mount a stat can block the main
  process for the network timeout. Settings → Worktrees asks `settings:worktree-folder-check`
  (`checkWorktreeFolder` in `src/main/settings/worktree-folder-check.ts`) when it shows the folder and
  whenever the window regains focus, and shows **Checking…**, **Available**, **Not empty**,
  **Not available**, or **Not responding** (no answer within 3 seconds). The check reads the configured
  folder itself; the renderer cannot name a path. Worktree creation uses the same check, and a check
  joins a stat still running for that folder, so a hung mount never ties up more than one libuv
  threadpool thread.
- Codex threads keep `$CODEX_HOME/worktrees` unless **Use for Codex threads too**
  (`base_directory_includes_codex = true`) is on. Codex Desktop lists an owner-marked worktree
  (`codex-thread.json` in its Git directory) only under `$CODEX_HOME/worktrees` (#164), so it does not
  show worktrees in the folder. The Codex CLI and App Server treat the folder as an ordinary `cwd`.
- Changing the folder does not move existing worktrees. Archive and hibernation manage the home root,
  the folder, and the folder's `.pwragent/worktrees` that earlier builds used (`managedMaintenanceRoots`
  in `backend-registry-wiring.ts`), so older worktrees age out.
- A worktree on a different volume from its repository is fine: git records absolute paths, and handoff
  moves changes with git commands, not filesystem renames.

## Worktrees on Another Drive

`git worktree prune`, and `git gc` after `gc.worktreePruneExpire`, delete the Git records of a worktree
whose folder is missing; the checkout is then no longer a working tree. An unplugged drive looks
exactly like that. So every worktree PwrAgent creates or restores on a drive that can go away while its
repository stays is locked with `PWRAGENT_WORKTREE_LOCK_REASON` (`src/main/app-server/worktree-volume-lock.ts`),
as Git's documentation advises for removable media.

- Create and remove worktrees only with `addManagedWorktree` and `removeManagedWorktree`
  (`src/main/app-server/managed-worktree.ts`). Each caller passes its own Git runner, so environment and
  Windows process ownership stay with the caller (`removeGit` runs the remove alone when it needs
  options the unlock must not get). `managed-worktree-guard.test.ts` fails on a raw `git worktree`
  add, remove, lock, or unlock anywhere else in the main process.
- The add locks the new worktree only when `needsDriveLock` holds: its volume (`stat().dev`) differs from
  both the repository's and the home folder's. A prune runs in the repository, so a worktree on the
  repository's drive never looks missing, and the home folder's drive is always mounted. So a worktree in
  `$CODEX_HOME/worktrees` for a repository on an external drive stays unlocked, and Codex Desktop and plain
  `git worktree remove` keep working on it. The add never fails creation over the lock.
- The remove clears only PwrAgent's own lock, so a lock someone else set still stops the removal. It
  reads only this worktree's `locked` file (never `git worktree list`, which would make archiving a fleet
  quadratic), or, when the checkout folder may be gone, the `lock` record the caller passes.
- Every check that treats a lock as a hold must ask `readWorktreeLockHolder` and refuse only on
  `other`: archive admission (`checkArchiveRegistration`) and hibernation (`inspectHibernationWorkspace`).
  Treating PwrAgent's own drive lock as a hold makes every worktree on another drive impossible to
  archive or hibernate.
- Anyone else's lock is a request to keep the worktree. PwrAgent asks only when the operator starts
  the operation: the Handoff dialog's **Unlock it and archive the worktree**, the archive notice's
  **Unlock and Remove**, the maintenance dialog's checkout rows, and a messaging handoff's **Unlock and
  Hand Off** (which also needs `thread.control.archive`). The approval is `approvedLockReason`, the
  lock text the operator saw; `removeManagedWorktree` and archive admission (`lockApprovalMatches`)
  clear the lock only while it still says exactly that, and otherwise keep the worktree with a typed
  `WorktreeLockedError` (`worktree-locked` in results). Hibernation, the archive sweep, background
  retries and agent tools never pass an approval. Unapproved, the operation still completes: a handoff
  keeps the source worktree (deciding before any Git state moves) and an archive keeps the checkout.
- Unlock and Remove (`removeLockedThreadWorktrees`) takes every worktree of one owner in one call, so
  the archived checkouts are inventoried once. Each entry names the archived thread the operator saw
  it under; a checkout another archived thread owns by now is kept. The notice sends one call per
  owning instance. The maintenance archive step adds a kept row under its thread for each worktree
  the archive kept for its lock, with the same Unlock and Remove.
- The lock read and Unlock and Remove are federated (`backend.readThreadWorktreeLock`, `thread_detail`;
  `backend.removeLockedThreadWorktrees`, `turn_control`). An owner that predates them reads as no lock,
  so a handoff keeps the worktree, and Unlock and Remove reports that the owner needs an update.
- A thread handed in from another instance is created by `packages/federation`, which cannot import
  desktop code. The desktop wrapper in `src/main/federation/thread-instance-handoff-service.ts` calls
  `lockExternallyAddedWorktree` after the import and `unlockBeforeExternalRemoval` before its rollback.
- Recovery (`worktree-recovery-service.ts`) clears PwrAgent's lock only when the worktree's `<hash>`
  container still exists. With the drive unplugged the container is gone too, and recovery refuses
  with "The drive that holds … is not connected" rather than recreating the checkout on the startup disk.
