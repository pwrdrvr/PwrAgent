# Troubleshooting the PwrAgent macOS VM E2E lab

## Headless display is 1024x768

Tart's configured display is a viewer hint. A headless
Virtualization.framework guest can boot at 1024x768, which makes Electron
window-height assertions fail. `provision-dev.sh` installs `~/bin/setres`, a
small CoreGraphics mode setter, plus an Aqua LaunchAgent that chooses 1920x1080
at login. `run-e2e.sh` calls it again at the beginning of each run.

Check the real display from the guest, not `system_profiler`:

```bash
ssh <guest> 'swift -e "import CoreGraphics; print(CGDisplayBounds(CGMainDisplayID()))"'
```

## The host cannot reach the guest

On newer macOS releases, Local Network privacy can block the host application
that owns the shell from reaching the Tart NAT subnet. Enable Local Network
permission for that terminal or agent host in System Settings, then restart
the application if it was already running when the permission changed.

## Provisioning silently stops partway through

The provisioning payload is fed to `ssh … 'bash -s'`. Commands such as
`brew install` can read stdin and consume the rest of the payload. Keep
`</dev/null` on stdin-hungry commands in the remote heredoc. Do not use
`curl | bash </dev/null`; download the script first, then invoke it with its
stdin redirected.

## E2E exits zero after a failure

`tee` masks a command failure unless the surrounding shell has `pipefail`.
The runner script intentionally executes the tmux payload under
`bash -c 'set -o pipefail; …'`. Preserve that shape if modifying the log
plumbing.

## Homebrew or git-lfs is absent in a Actions job

Non-interactive SSH shells do not source Homebrew's profile. The runner scripts
call `eval "$(/opt/homebrew/bin/brew shellenv)"` before `config.sh` and refresh
`~/actions-runner/.path` on every boot. The runner takes that path snapshot
when serving jobs; a missing Homebrew path makes an LFS checkout fail before
the job can repair itself.

## softnet fails or the isolation probe succeeds unexpectedly

If `tart run --net-softnet` complains about permissions, the human-operated
sudoers setup is incomplete. If the private-network probe can reach an RFC1918
address, stop immediately: the VM is not safe to register. Stop it, confirm
that it was started with `--net-softnet`, and verify the sudoers rule points to
the installed Homebrew softnet binary.

## A VM E2E run flakes or the guest reboots

AppleParavirtGPU can reset under Electron GPU-process load, stalling
WindowServer and occasionally panicking the guest. Both VM-run scripts and the
CI workflow set `PWRAGENT_E2E_DISABLE_GPU=1`; PwrAgent switches to software
rendering before Electron becomes ready. Keep that environment gate scoped to
the VM lane so local host E2E retains normal GPU coverage.
