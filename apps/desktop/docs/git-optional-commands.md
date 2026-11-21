# Optional Git Commands

## Optional Git commands

The Git PwrAgent runs is whichever one the operator selected: the bundle, a
downloaded PwrDrvr release, or a path. They differ in what they can do, and a
version number does not say how. `git worktree reflink` is the first command
PwrAgent offers only when the selected Git has it.

### The rule

Before offering a command or option that not every supported Git has, run the
selected Git's own help for it inside a repository and read the option rows.

- **Do not infer support from the command existing, from the exit code, or
  from the version.** `2.56.1-dev-pwrgit.1` has `git worktree reflink` without
  `--verify-filters`; `.2` has both; both exit 0 for `-h`. A Git with no such
  subcommand exits 129 and prints the usage of its sibling subcommands.
- **Match the option's row,** including Git's `--[no-]name` spelling. The
  synopsis of `.2` also says `[-n | --verify-filters]`, a description can
  name another option, and an "unknown option" error names the one that is
  missing. `parseWorktreeReflinkHelp` reads rows only.
- **Run it inside a repository.** Outside one, Git prints
  `fatal: not a git repository` and no usage. That is not an answer about the
  Git, so it is not remembered.
- **Any repository will do.** The answer describes the Git, so the probe
  takes a short list of directories and asks in each until one prints a
  usage. A thread's first worktree being hibernated or deleted must not hide
  the command for its others. A run still happens only in its own target, and
  fails with "could not be run" when that target gives no usage.

### Whose answer it is

`WorktreeReflinkCapabilityProbe` (`src/main/git-worktree-reflink-capabilities.ts`)
keeps one answer, for one Git. A Git is identified by the selection
(`PWRAGENT_GIT_PATH`, the manual path, the release chosen with Use) together
with the executable it resolves to and that file's size, time and inode. Use,
Roll back, a manual path, and a release installed over the old path all give a
different identity, so no caller has to remember to invalidate.

- The help is read with the identity's own executable, and the answer is kept
  only when that identity was selected both before and after the read. A probe
  that finishes after the selection moved is discarded and the new selection
  is probed.
- The run uses the executable that answered. `WorktreeReflinkService.run`
  reads the capabilities again first.
- The renderer holds a `runtimeKey` with the capabilities it shows. A share
  sent with another Git's key does not run (`runtime-changed`). The dialog
  drops the operator's choices whenever the key changes, and ignores an
  answer that is not for its newest request (`worktree-storage-session.ts`).

### Filters

`--verify-filters` runs the repository's clean filters, such as Git LFS.

- An estimate is `--dry-run` and never carries `--verify-filters`. Git also
  refuses the pair.
- A share carries it only when the request says `verifyFilters: true`, which
  the dialog sends only with the box ticked for the Git on screen. The box
  starts unticked and is not persisted.
- Asking a Git without the option to verify is refused. It is never run
  unverified instead.

### Where it may run

Sharing replaces files, so the main process decides where, not the renderer.

- The directory is the thread's own record of it
  (`BackendRegistry.resolveThreadLinkedWorkspace`): a path linked to a thread
  on this machine that is not archived. An archived thread's retained
  checkout can be read, not changed. This check reads no pull requests.
- A share does not start while a turn, a reserved turn start, or a review is
  running in that worktree in **any** local thread
  (`BackendRegistry.workspaceHasActiveTurn`). Threads can share a worktree,
  so the dialog's own thread being idle is not enough. An estimate changes
  nothing and always runs.

The Share storage dialog is audited by `e2e/a11y.spec.ts` against a stand-in
Git selected with `PWRAGENT_GIT_PATH`
(`e2e/fixtures/worktree-storage-seeding.ts`), so its states do not depend on
the runner's filesystem.

`planWorktreeReflink` (`src/main/git-worktree-reflink.ts`) is the one place
the filter rules are applied. Its property tests, the probe's scheduler model, and
the session reducer's model switch between `.1` and `.2` and deliver late
answers on purpose; keep them when adding the next optional command.
