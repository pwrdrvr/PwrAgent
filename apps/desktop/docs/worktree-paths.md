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
- Codex threads keep `$CODEX_HOME/worktrees`, which Codex uses to recognize the checkouts it owns.
- Changing the folder does not move existing worktrees. Archive and hibernation manage the home root and
  the folder's root (`managedMaintenanceRoots` in `backend-registry-wiring.ts`), so older worktrees age out.
- A worktree on a different volume from its repository is fine: git records absolute paths, and handoff
  moves changes with git commands, not filesystem renames.
