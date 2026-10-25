---
name: sandboxer-verification
description: >-
  Run PwrAgent's unit tests, lint, typecheck, and Linux desktop E2E in a
  Sandboxer cloud sandbox instead of on the local machine.
  Use when the thread has the Sandboxer MCP (create_sandbox and exec tools)
  and a change needs `pnpm test`, `pnpm lint`, `pnpm typecheck`, or
  `pnpm test:desktop-e2e`. Sandboxer is Ubuntu only: it does not verify
  macOS or Windows behavior.
---

# Verify on Sandboxer

Sandboxer gives this thread an Ubuntu 24.04 x64 VM with root, Git, Docker,
Node, and Python. The checks here mirror the CI `Lint`, `Test`, and
`Linux Desktop E2E` jobs. Run them in the VM and keep the local machine free.

[`scripts/sandboxer/verify.sh`](../../../scripts/sandboxer/verify.sh) runs in
the VM. It installs the Node version from `.nvmrc`, the pinned pnpm, and the
E2E window manager, then runs each check with a log and a status line.

## Measured on a `large` sandbox (2026-10-25)

`large` is 8 vCPUs and 15 GB. CPU is the mean of 1-second `/proc/stat`
samples over the step, as a share of all 8 vCPUs.

| Step | Command | Time | Mean CPU | p90 CPU |
| --- | --- | --- | --- | --- |
| First setup | `verify.sh setup` | 17 s | | |
| Setup, later worktree | `verify.sh setup` | 2 s | | |
| Lint job (`pnpm lint`) | `verify.sh lint` | 46 s | | |
| Unit tests, one run | `verify.sh unit` | 132 to 165 s | 76% | 92% |
| Unit tests, two shards | `verify.sh unit --shards 2` | 127 s | 95% | 98% |
| E2E, one lane | `verify.sh e2e` | 585 to 739 s | 20% | 32% |
| E2E, two lanes | `verify.sh e2e --lanes 2` | 360 to 394 s | 40% | 56% |
| E2E, four lanes | `verify.sh e2e --lanes 4` | 299 s | 61% | 85% |

`all` uses two unit shards and four E2E lanes.

- Vitest already runs one worker per core. A single run leaves the CPU idle
  while it starts and finishes. Two shards fill those gaps and use about the
  same CPU time, so more shards cannot help on 8 vCPUs.
- Playwright runs one Electron worker per lane, and one lane uses under two
  cores. Four lanes passed all 272 tests with no retry. Lane 1 holds the
  66 `a11y.spec.ts` tests and ends last. For its final 75 s it runs alone at
  about 20% CPU. More lanes would not shorten that lane.

## 1. Get a sandbox

Use one sandbox per thread. Name it `pwragent-<branch>`, with each `/`
replaced by `-`, so `list_sandboxes` shows which thread owns it.

Call `list_sandboxes` first. If this thread's sandbox exists, use its ID.
`resume_sandbox` brings back a stopped one in about 2 s.

Otherwise call `create_sandbox` with `from: "pwragent-base"`,
`type: "large"`, the name, and `ttlSeconds: 3600`. The `pwragent-base`
snapshot already holds Node, pnpm, the E2E packages, the Electron download, a
warm pnpm store, and a clone at `~/pwragent/repo`. A sandbox from it was ready
3 s after the call, and a fetched commit was ready to test 4 s later. The TTL
is a wall-clock stop timer, not an idle timer. Pass the `sandboxId` on every
later call. The MCP default is the last sandbox this server used, which can
be another task's.

If `pwragent-base` does not exist, create the sandbox without `from` and
clone the public repository once. A blob-less clone takes a few seconds, and
the first `verify.sh setup` installs the rest in about 17 s:

```sh
git clone -q --filter=blob:none https://github.com/pwrdrvr/PwrAgent.git ~/pwragent/repo
```

## 2. Send a commit

Verify a commit, not a dirty tree. Commit first; amend freely between runs.
Work in the local worktree:

```sh
sha="$(git rev-parse HEAD)"
git fetch -q origin
git branch -r --contains HEAD
```

If that lists any `origin/` branch, the commit is on GitHub and the VM can
fetch it by SHA. Skip the bundle.

Otherwise bundle only the commits that `origin/main` does not have. The
bundle is usually a few KB:

```sh
mkdir -p .local/sandboxer
git bundle create ".local/sandboxer/$sha.bundle" origin/main..HEAD
base64 < ".local/sandboxer/$sha.bundle" | tr -d '\n'
```

Pass that output to `write_file` with `encoding: "base64"` and the path
`/home/user/pwragent/<sha>.bundle`. The limit is 5 MiB. A bundle that large
means the branch is far ahead of `origin/main`; push it and fetch by SHA
instead.

Drive Sandboxer only through its MCP tools. Do not use the `sbx` CLI.

In the VM, fetch the commit and give it its own worktree. Never change a
tree while a check runs in it.

```sh
sha=<sha>
cd ~/pwragent/repo
git fetch -q origin
git fetch -q "../$sha.bundle" HEAD      # bundle only
git fetch -q origin "$sha"              # pushed commit only
git worktree add -q --detach "../wt/$sha" "$sha"
```

## 3. Run the checks

One MCP `exec` call can run for 600 seconds at most. A wait of about nine
minutes was dropped before that limit. Start the run in the background and
poll with calls of five minutes or less:

```sh
cd ~/pwragent/wt/<sha>
nohup scripts/sandboxer/verify.sh all > /dev/null 2>&1 &
```

```sh
cd ~/pwragent/wt/<sha>
for i in $(seq 1 55); do grep -q '^all ' .local/sandboxer/status 2>/dev/null && break; sleep 5; done
cat .local/sandboxer/status
```

`all` runs setup, then lint, unit in two shards, and E2E in four lanes, and
it continues after a failed check. Each invocation of `verify.sh` starts a
new `.local/sandboxer/status`. Each check appends
`<step> exit=<code> secs=<seconds>` to it, and `all` ends with
`all exit=<0|1>`. To poll a single step started in the background, wait for
its `^<step> ` line the same way.

Run one step when that is all the change needs. Arguments pass through:

```sh
scripts/sandboxer/verify.sh setup
scripts/sandboxer/verify.sh lint
scripts/sandboxer/verify.sh unit --shards 2
scripts/sandboxer/verify.sh unit apps/desktop/src/main/__tests__/backend-registry.test.ts
scripts/sandboxer/verify.sh e2e e2e/thread-branch-drift.spec.ts
scripts/sandboxer/verify.sh e2e --lanes 4
scripts/sandboxer/verify.sh e2e --shard=2/4
```

`--shards` must come first after `unit`. The shards share the worktree, and
each writes `.local/sandboxer/unit-shard<N>.log`; `unit.log` holds one exit
line per shard.

`--lanes` must come first after `e2e`. Lane 1 runs in the worktree. Each
later lane runs in a sibling worktree at the same commit, `<worktree>-lane<N>`,
because Playwright writes `test-results/` and `.local/` at fixed paths. The
script creates and updates those sibling worktrees itself. Each lane writes
`.local/sandboxer/e2e-lane<N>.log`, and `e2e.log` holds one exit line per
lane.

Run setup once per worktree before a single step. Run only one `verify.sh`
at a time in a worktree, because each step writes the same status file.
Run one E2E step at a time in a VM.

## 4. Read the results

Read logs with bounded output, never whole:

```sh
tail -n 30 .local/sandboxer/unit*.log
grep -nE '^\s+[0-9]+ (passed|failed|flaky|skipped)|^  [0-9]+\) ' .local/sandboxer/e2e*.log
```

Concurrent lanes load the VM more than one lane does. Without a retry, three
two-lane runs each had at most one unexpected failure, a different test each
time: `thread-image-fit.spec.ts:353` and `star-map-activity.spec.ts:11`. Each
then passed 5 of 5 alone. One four-lane run had none. Rerun an unexpected
failure or flaky test by itself before you treat it as caused by the change.

Playwright writes failure context to `apps/desktop/test-results/` in the
lane's own worktree. Find the files with `exec` and read the text ones, such
as `error-context.md`, with `read_file`. Pull a screenshot or trace only when
the text does not explain the failure: base64 output enters the thread
context.

Report the sandbox ID, the commit, and each status line. Name every failure.

## 5. Known differences from CI

- The VM sets `GH_TOKEN` for the Sandboxer account. `verify.sh` unsets
  `GH_TOKEN` and `GITHUB_TOKEN` before every check, as CI runs without them.
- `verify.sh e2e` sets `CI=1`, as the CI lane does: Playwright retries a
  failed test once, reports a test that passes on retry as flaky, and keeps
  failure screenshots and videos. Prefix the command with `CI=` to turn the
  retry off. Report every flaky test; a retry does not make it pass.
- Electron started without the setuid helper repair on this image. If it
  reports the fatal SUID sandbox error, run `pnpm fix:linux-sandbox` in the
  worktree. Never disable the Chromium sandbox.
- The VM's `/tmp` does not survive a cold boot. Keep work under
  `/home/user/pwragent`.
- Unlike the GitHub runner, the image installs real agent CLIs (`codex`,
  `claude`, `kimi`) and allows unprivileged user namespaces. A failure that
  appears only here can be a bug that the runner hides. #2867 fixed two.

## 6. Lifetime and cleanup

- Call `stop_sandbox` after each verification run. Stopping keeps a snapshot
  and stops compute billing. Stop and resume each took about 2 s, and the
  worktrees and `node_modules` survived.
- Keep the stopped sandbox for the thread's next run while its PR is open.
- Each verified commit leaves a worktree, and an E2E run with lanes leaves
  `<worktree>-lane<N>` beside it. Keep the latest commit's worktrees for their
  failure artifacts, and remove older ones with
  `git -C ~/pwragent/repo worktree remove --force <path>`.
- When the PR merges or closes, the sandbox should be deleted: every stopped
  sandbox keeps snapshots, and snapshots count against the account's storage
  allowance. The Sandboxer MCP has no delete tool yet. Until it does, stop the
  sandbox and report it as ready to delete. Use `delete_sandbox` as soon as
  the tool list includes it.
- Do not stop or delete a sandbox that another thread owns.

## 7. Refresh the base snapshot

Refresh `pwragent-base` when `pnpm-lock.yaml`, `.nvmrc`, the Electron
version, or `verify.sh setup` changes, or when its clone is far behind
`origin/main`.

The Sandboxer MCP cannot save a named snapshot yet, so this step needs the
operator. Prepare a builder sandbox from `pwragent-base` (or a fresh one with
the clone above), named `pwragent-base-builder`. In the builder:

```sh
cd ~/pwragent/repo
git fetch -q origin
git checkout -q --detach origin/main
scripts/sandboxer/verify.sh setup
rm -rf .local/sandboxer
git worktree list
```

`git worktree list` must show only `~/pwragent/repo`. Then ask the operator
to save the builder as `pwragent-base` and delete it. Saving under an
existing name replaces the snapshot; new sandboxes use the new one, and a
save took 3 s.

Every new sandbox gets a copy of the base, so never leave a worktree, a log,
or a credential in it. Sandboxer passes the account's `GH_TOKEN` to each
sandbox when it starts. The snapshot does not store it.
