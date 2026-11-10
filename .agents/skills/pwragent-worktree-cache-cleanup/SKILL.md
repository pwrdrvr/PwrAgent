---
name: pwragent-worktree-cache-cleanup
description: Audit and manually clean a selected PwrAgent Git project's worktrees of repo-local Vitest caches and APFS-confirmed non-clone Electron runtimes, including conversion to shared clones. Use for operator-requested disk reclamation on macOS, not automatic product retention or worktree deletion.
---

# PwrAgent worktree cache cleanup

Use the [cleanup script](scripts/cleanup_worktree_caches.py) with
Python 3.9+ on macOS. Resolve script paths relative to this skill's directory.
This skill lives only in PwrAgent's `.agents/skills/`. Its script can audit
worktrees on older branches when invoked from a checkout containing this skill.

For Electron, prefer conversion to verified shared clones: use `audit-share`
and then `share` with an approved report. This includes busy worktrees when the
runtime itself is unused. A loaded runtime is preserved. Existing runtime bytes,
modes and links must match the package-checksummed artifact; modified runtimes
are preserved. Architecture comes from the installed Mach-O executable.

```sh
python3 scripts/cleanup_worktree_caches.py audit-share \
  --project /Users/huntharo/github/PwrAgnt \
  --report /private/tmp/pwragent-electron-sharing-plan.json
python3 scripts/cleanup_worktree_caches.py share \
  --project /Users/huntharo/github/PwrAgnt \
  --report /private/tmp/pwragent-electron-sharing-plan.json
```

`share` uses this checkout's merged Electron installer to prepare and verify the
version/platform/architecture-keyed cache. It independently clones each runtime,
checks contents and APFS private bytes/clone IDs/inodes, and publishes under the
installer lock. It leaves source and package declarations untouched. If activity
starts during publication, it restores or retains the original rather than
removing a loaded runtime. Per-path results go beside the plan as `.result.json`.

For cache removal, first produce a report using the selected repository:

```sh
python3 scripts/cleanup_worktree_caches.py audit \
  --project /Users/huntharo/github/PwrAgnt \
  --report /private/tmp/pwragent-worktree-cache-plan.json
```

Summarize candidate counts and private bytes, active worktrees, preserved
runtimes and metadata errors. Show the report path before proposing deletion.
A request to create the skill or run an audit does not authorize cleanup.
Require explicit approval of this report immediately before mutation; if that
approval is already present, proceed without asking again.

Apply only that approved report:

```sh
python3 scripts/cleanup_worktree_caches.py clean \
  --project /Users/huntharo/github/PwrAgnt \
  --report /private/tmp/pwragent-worktree-cache-plan.json
```

The script re-discovers registered worktrees with Git, checks their common Git
directory, and revalidates every candidate. Removed paths must still have the
approved identity and fingerprint. An edited report cannot add arbitrary paths.

- Cache discovery covers `node_modules/.vitest-cache` and
  `node_modules/.vite/vitest` at tracked package roots. Do not remove a whole
  `.vite` directory or assume an unfamiliar/custom cache path is Vitest data.
- Electron discovery covers physical pnpm package directories and a physical
  `node_modules/electron`. Package version and stock macOS bundle identity must
  agree. Unexpected root files, tracked files, escaping links, hardlinks and
  metadata failures cause preservation.
- `getattrlist` private size, clone ID and sharing flags are the filesystem
  oracle. Any shared-block flag preserves the entire runtime, including a clone
  with private modifications. `du`, equal hashes and private bytes alone do not
  establish that a runtime is unshared.
- For `audit`/`clean`, worktrees referenced by current-user processes are skipped,
  including open shells. For `audit-share`/`share`, activity is checked against the
  runtime itself; a shell or test elsewhere in the worktree does not block sharing.
  Process checks must succeed; do not bypass them when the execution
  sandbox denies `ps` or `lsof`. Request read-only host process access instead.
  The Electron installer lock prevents concurrent installation. Candidates are
  renamed and checked again before removal; new activity restores the old path
  when possible, otherwise reports the retained quarantine path.

This operation does not stop apps, delete worktrees, edit source, clean `.local`
or desktop `out/`, or remove global pnpm/Electron caches. Sharing may populate
the verified Electron extraction cache. No sudo or GUI is needed. Report allocated bytes separately from measured private bytes: APFS
snapshots can retain deleted blocks, so allocation is not an immediate free-space
promise. Zero private bytes alone also does not establish a clone. Report
per-path failures; do not retry a deletion blindly.

An older checkout can recreate a private runtime with its old installer. The
merged cache installer from PwrAgent #3580 must be present there to recreate a
shared clone. Deleting only `dist/` leaves package declarations and recovery
hooks intact; the normal environment/Dev lifecycle can reinstall it later.
