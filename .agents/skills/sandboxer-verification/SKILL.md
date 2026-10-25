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

## Measured on a new `large` sandbox (2026-10-25, based on `d8ee319d5`)

| Step | Command | Time | Includes |
| --- | --- | --- | --- |
| First setup | `verify.sh setup` | 17 s | Node download, apt packages, `pnpm install` |
| Setup, later worktree | `verify.sh setup` | 2 s | `pnpm install` from the VM's store |
| Lint job | `verify.sh lint` | 46 s | `pnpm lint`: every CI Lint check, typecheck included |
| Unit tests | `verify.sh unit` | 132 s | 1,271 files, about 20,000 tests |
| Linux desktop E2E | `verify.sh e2e` | 585 s | 278 tests, one Playwright worker |

`large` is 8 vCPUs and 15 GB. Playwright runs one worker, so E2E time does
not improve with a larger machine.

## 1. Get a sandbox

Reuse the thread's sandbox. Call `list_sandboxes` first. If this thread
already has one, use its ID. `resume_sandbox` brings back a stopped one.

Otherwise call `create_sandbox` with `type: "large"`, a `name` for the work,
and `ttlSeconds: 7200`. The TTL is a wall-clock stop timer, not an idle
timer. Pass the `sandboxId` on every later call. The MCP default is the last
sandbox this server used, which can be another task's.

Clone the public repository once. A blob-less clone takes a few seconds:

```sh
git clone -q --filter=blob:none https://github.com/pwrdrvr/PwrAgent.git ~/pwragent/repo
```

## 2. Send a commit

Verify a commit, not a dirty tree. Commit first; amend freely between runs.
Work in the local worktree:

```sh
sha="$(git rev-parse HEAD)"
git fetch -q origin
git merge-base --is-ancestor HEAD origin/main && echo "on origin/main"
```

If the commit is on GitHub (on `origin/main` or on a pushed branch), the VM
can fetch it by SHA. Skip the bundle.

Otherwise bundle only the commits that `origin/main` does not have. The
bundle is usually a few KB:

```sh
mkdir -p .local/sandboxer
git bundle create ".local/sandboxer/$sha.bundle" origin/main..HEAD
sbx scp ".local/sandboxer/$sha.bundle" "<sandbox-id>:/home/user/pwragent/$sha.bundle"
```

`sbx` is the Sandboxer CLI that runs the MCP. If the local shell cannot run
it, send the bundle with `write_file` and `encoding: "base64"` (5 MiB limit).

In the VM, fetch the commit and give it its own worktree. Never change a
tree while a check runs in it.

```sh
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

`all` runs setup, then lint, unit, and E2E, and it continues after a failed
check. Each check appends `<step> exit=<code> secs=<seconds>` to
`.local/sandboxer/status`, and the final line is `all exit=<0|1>`.

Run one step when that is all the change needs. Arguments pass through:

```sh
scripts/sandboxer/verify.sh setup
scripts/sandboxer/verify.sh lint
scripts/sandboxer/verify.sh unit apps/desktop/src/main/__tests__/backend-registry.test.ts
scripts/sandboxer/verify.sh e2e e2e/thread-branch-drift.spec.ts
scripts/sandboxer/verify.sh e2e --shard=2/4
```

Run setup once per worktree before a single step. Run only one `verify.sh`
at a time in a worktree, because each step writes the same status file.
Run one E2E at a time in a VM.

## 4. Read the results

Read logs with bounded output, never whole:

```sh
tail -n 30 .local/sandboxer/unit.log
grep -nE '^\s+[0-9]+ (passed|failed|flaky|skipped)|^  [0-9]+\) ' .local/sandboxer/e2e.log
```

Playwright writes failure context to `apps/desktop/test-results/`. Read one
file with `read_file`, or copy a directory back with `sbx scp --recursive`
into a `.local/` directory.

Report the sandbox ID, the commit, and each status line. Name every failure.

## 5. Known differences from CI

- The VM sets `GH_TOKEN` for the Sandboxer account. `verify.sh` unsets
  `GH_TOKEN` and `GITHUB_TOKEN` before every check, as CI runs without them.
- The local default is `CI` unset: no Playwright retry and no failure
  screenshots or videos. Add `CI=1` to a step to match CI's single retry and
  failure artifacts.
- Electron started without the setuid helper repair on this image. If it
  reports the fatal SUID sandbox error, run `pnpm fix:linux-sandbox` in the
  worktree. Never disable the Chromium sandbox.
- The VM's `/tmp` does not survive a cold boot. Keep work under
  `/home/user/pwragent`.

### Two E2E tests fail here and pass on CI

On 2026-10-25, a full E2E run at `d8ee319d5` reported 270 passed, 6 skipped,
and these 2 failed. Both fail every time in the VM. Both expose a bug that
GitHub's runner hides; neither is caused by the change under test.

- `e2e/federation-remote-window.spec.ts:1738` waits for `review/start` and
  times out. The image installs real agent CLIs: `/usr/bin/codex`,
  `/usr/bin/claude`, and `/usr/local/bin/kimi`. The test gives a fake Codex to
  the owner only. The viewer finds the real Codex, and with a local Codex the
  viewer's remote sub-thread review never reaches the owner. The runner has no
  Codex. With the Codex CLI hidden, the test passes.
- `e2e/onboarding-wizard.spec.ts:593` fails in teardown with "Electron close
  timed out". This kernel allows unprivileged user namespaces, so the
  graduated `personal` instance starts. On the runner the relaunch cannot
  start, and the test takes its "bootstrap process didn't exit within 20s"
  fallback. When `personal` does start, it inherits the bootstrap's DevTools
  sockets. `killGraduatedProfileInstances` then cannot find it, because
  Chromium moves `--profile` ahead of the profile name in the process title.

Treat only these two as expected failures. Do not uninstall the image's agent
CLIs or disable user namespaces to make them pass. Other work in the VM can
need those CLIs, and the namespace setting affects the whole VM.
Remove this section when the bugs are fixed.

## 6. Finish

Call `stop_sandbox` when the thread's verification is done. Stopping keeps a
snapshot and stops billing; `resume_sandbox` brings it back. Do not delete a
sandbox that holds work another thread may need.
