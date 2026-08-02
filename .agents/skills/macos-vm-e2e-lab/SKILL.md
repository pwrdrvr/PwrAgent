---
name: macos-vm-e2e-lab
description: >-
  Set up and operate PwrAgent's Tart-based macOS VM lab. It keeps headed
  Playwright/Electron E2E runs off the host desktop and can provide a guarded,
  network-isolated self-hosted GitHub Actions lane for macOS/ARM64 E2E and
  visual-regression coverage. Use when a user mentions Tart, a local macOS VM,
  self-hosted macOS runners, E2E windows stealing focus, or PwrAgent visual
  goldens.
compatibility: >-
  Apple Silicon Mac host with Homebrew, Tart, and an authenticated gh CLI.
  Plan for about 80 GB free disk. The first softnet sudoers rule and the GitHub
  Actions external-contributor setting require a human operator.
---

# PwrAgent macOS VM E2E lab

## What this provides

The lab has two related roles:

1. A trusted development VM runs headed Electron Playwright tests on the
   guest display. The host desktop never flashes, loses focus, or receives test
   windows.
2. A shared PwrDrvr organization runner group serves PwrAgent and PwrSnap's
   macOS E2E lanes. Its runner VMs boot with `softnet`, which permits Internet
   access but blocks RFC1918/private host-network access.

Tart uses Apple Virtualization.framework, which is the supported route for
macOS guests on Apple Silicon. Treat Tart and softnet as host tools, not
runtime dependencies of PwrAgent.

## One-time host setup

Copy the bundled scripts to their stable operating location. The scripts keep
their SSH key, logs, and failed-test artifacts there.

```bash
lab_root="$HOME/pwragent-mac-vm"
mkdir -p "$lab_root"
cp -R .agents/skills/macos-vm-e2e-lab/scripts/. "$lab_root/"
chmod +x "$lab_root"/*.sh "$lab_root"/runner/*.sh

brew install cirruslabs/cli/tart cirruslabs/cli/softnet git-lfs
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest pwragent-sequoia-base
```

The base-image pull is large and can take a while. Keep
`pwragent-sequoia-base` pristine: never boot it. The lab clones it into its
working VMs. Apple allows at most two macOS guests per host, so normally run a
dev VM plus one runner VM, not a third guest.

## Running E2E off the desktop

```bash
cd ~/pwragent-mac-vm
./provision-dev.sh
./run-e2e.sh main
./run-e2e.sh my-branch --grep "approval"
./run-e2e.sh --local /absolute/path/to/PwrAgent e2e/visual-regression.spec.ts
```

`--local` pushes the local repository's committed `HEAD` to the VM over SSH as
the private `e2e-local` branch. Use it for unpushed work; do not push a WIP
branch to a public remote only to run tests. Uncommitted changes do not travel,
so commit a disposable WIP checkpoint first when necessary.

The test command runs inside tmux session `e2e` in the VM. Ctrl-C on the host
log tail detaches from it without terminating the test. Failed-run artifacts
are copied back to `~/pwragent-mac-vm/artifacts/`.

Use `./vnc.sh [vm-name]` to inspect the guest display if needed. It opens macOS
Screen Sharing against the guest itself; it does not open a window on the host
until you explicitly ask to view the VM.

## Visual-regression goldens

PwrAgent's macOS golden images are PNG files under
`apps/desktop/e2e/*.spec.ts-snapshots/` and are intentionally tracked in Git
LFS. Generate or update them only inside this VM lab, matching the macOS/ARM64
CI renderer:

```bash
cd ~/pwragent-mac-vm
./run-e2e.sh --local /absolute/path/to/PwrAgent \
  e2e/visual-regression.spec.ts --update-snapshots
```

Review the generated files before committing them. `git lfs status` should
list each new `.png` baseline as an LFS object rather than an ordinary Git
blob. Do not generate macOS goldens on a Linux host or compare them against a
different platform's output.

## Self-hosted GitHub Actions runner

The workflow job targets the shared organization runner label:

```yaml
runs-on: [self-hosted, macOS, ARM64, pwrdrvr-macos]
```

The `PwrDrvr macOS` runner group is selected-repository only: it grants
access to exactly `pwrdrvr/PwrAgent` and `pwrdrvr/PwrSnap`, not the whole
organization. Do not create a repository-scoped PwrAgent runner alongside it.

One human action is required before any runner VM can use softnet (agents must
not enter a sudo password or change this system policy themselves):

```bash
echo "$USER ALL=(ALL) NOPASSWD: $(brew --prefix)/bin/softnet" | \
  sudo tee /etc/sudoers.d/softnet
sudo -n "$(brew --prefix)/bin/softnet" --help
```

Then stage and install the always-on runner:

```bash
cd ~/pwragent-mac-vm
./runner/provision-runner-base.sh
./runner/configure-shared-runner-group.sh
./runner/install-launch-agent.sh
```

The persistent runner is the normal mode: it occupies one VM slot, keeps its
tool cache warm, and serves one job at a time. Re-baseline it with
`tart stop pwragent-runner && tart delete pwragent-runner` before starting it
again. `run-ephemeral-runner.sh` remains available when one-clean-VM-per-job
is worth the setup cost. On this Mac, migrate the existing
`~/pwrsnap-mac-vm` persistent runner into the shared group instead of starting
another runner VM; the two guest slots are already valuable for development.

For a foreground diagnostic session, run
`./runner/run-persistent-runner.sh` instead of installing launchd; it owns the
terminal until stopped. A first registration or re-baseline needs the
organization-admin permission used by `configure-shared-runner-group.sh`.
An already registered persistent runner restarts through launchd without that
organization API call.

## Runner security contract

PwrAgent is public, so do not weaken any of these layers:

1. The workflow excludes fork-head PRs from the self-hosted job.
2. The organization runner group grants access only to PwrAgent and PwrSnap.
3. The runner VM must boot with `--net-softnet`, and its script verifies that
   private network space cannot be reached before registration.
4. GitHub Actions must require approval for external contributors in the
   repository settings.
5. `git-lfs` must be installed and on the runner job PATH before checkout;
   actions-runner snapshots the PATH during `config.sh`.

Never register a runner when its private-network probe fails. Never use the
trusted dev VM as the CI runner.

## Operational gotchas

Read [the troubleshooting reference](references/troubleshooting.md) before
changing the scripts or diagnosing a stuck VM. In particular: headless guest
display resolution needs an in-guest CoreGraphics fix, scripts sent over SSH
must prevent stdin-hungry commands from consuming their heredoc, and the
AppleParavirtGPU is disabled for VM E2E with
`PWRAGENT_E2E_DISABLE_GPU=1`.
