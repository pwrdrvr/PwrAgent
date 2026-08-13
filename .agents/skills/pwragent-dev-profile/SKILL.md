---
name: pwragent-dev-profile
description: Start, stop, restart, and verify the local PwrAgent Electron development app with `PWRAGENT_PROFILE=dev` from the current checkout. Use when Codex needs to close any running dev-profile PwrAgent instance, launch `pnpm dev` in the current working directory, or confirm the dev-profile app came up.
---

# PwrAgent Dev Profile

Use this skill to manage the local PwrAgent Electron app for the `dev` profile from the checkout Codex is currently working in.

## Commands

Run commands from the repository root unless the user asks for a different checkout.

Start or restart the dev-profile app:

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh restart --root "$PWD"
```

Close the dev-profile app if it is running:

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh close --root "$PWD"
```

Check whether the dev-profile app is running:

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh status --root "$PWD"
```

List the profile's recorded app instances and messaging lease owner:

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh leases
```

Verify that a previously started instance is still up:

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh verify --root "$PWD"
```

## Workflow

1. Run `status` first when the user asks what is running or when closing processes may be surprising.
2. Run `restart` when the user asks to start the dev profile; it closes the prior managed dev-profile instance, starts `PWRAGENT_PROFILE=dev PWRAGENT_INSTANCE_ROOT="$PWD" pnpm dev` detached from the checkout, and waits until the app writes a matching profile runtime record.
3. For visual QA, use the emitted `Computer Use target` line. Target its exact
   checkout-local `appPath`, then verify the native window title is `PwrAgent`
   and the AX URL matches the emitted `rendererUrl`. Never target the generic
   `Electron` display name, shared `com.github.Electron` bundle id, or installed
   `com.pwrdrvr.pwragent` app: those can select a sibling project, another
   checkout, or a packaged build that does not contain the code under test.
4. Run `close` when the user only wants the dev-profile app stopped. Never
   `kill` the Electron PID by hand — see "Closing the app" below.
5. Relay the script output and the log path to the user. The default log is `.local/pwragent-dev-profile.log`.

## Closing the app

`close` signals the app's own process, **waits for it to actually exit**
(polling until gone or 30 seconds pass), and only then cleans up the `pnpm dev`
supervisor chain. Do not replace the wait with a fixed sleep, do not `kill` the
Electron PID yourself, and do not collapse the two phases back into one signal
to every matched pid — SIGTERMing the supervisor or a renderer alongside the
main process cuts short the very drain the wait exists to protect.

A SIGTERM'd app does not exit promptly. Note what SIGTERM does **not** do:
`installProcessShutdownHandlers` in `index.ts` calls `allowImmediateQuit()`, so
the signal path deliberately skips the quit-confirmation dialog and its
10-second countdown. That countdown belongs to Cmd-Q and window close, not to
this script.

What the wait is for is the phased drain that follows.
`disposeMainProcessResources` runs the before-quit phases under a 12-second
global budget (`MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS`), and the app-server phase
alone may take 7.5s, with messaging and federation at 4s each and renderer
teardown adding 2s. **The messaging and federation runtimes are stopped in
those phases**, so a SIGKILL landing mid-drain strands the profile's leases:
the next instance boots with federation off, names the dead PID as the lease
holder in Settings → Federation, and shows zero peers until the dead-owner
grace expires. Any federation-dependent UI then renders its empty state and
looks broken when it is not — observed on 2026-08-12 after a hand-rolled
`kill` that did not wait.

If the 30-second budget is exhausted, `close` escalates to SIGKILL but says
loudly that it did, and warns that the next launch may report federation off.

## Script Notes

- The script defaults to `--profile dev`, `--root "$PWD"`, `.local/pwragent-dev-profile.pid`, and `.local/pwragent-dev-profile.log`.
- Prefer `restart` over hand-running `PWRAGENT_PROFILE=dev pnpm dev`; the script passes `PWRAGENT_INSTANCE_ROOT`, starts a detached daemon helper, then uses the app's lease-backed runtime metadata in `~/.pwragent/profiles/dev/state/state.db` to find the Electron owner process.
- The detached daemon helper stops the `pnpm dev` supervisor when the first lease-backed Electron instance it started exits, so closing the spawned app does not leave a dev supervisor relaunching it.
- The daemon clears inherited `ELECTRON_EXEC_PATH`, `ELECTRON_CLI_ARGS`, and
  `ELECTRON_MAJOR_VER` before launching. An agent hosted by another Pwr-family
  Electron app can otherwise silently start this checkout through the host
  app's Electron installation.
- The script only targets the app instance whose recorded root hash matches the requested checkout, plus that instance's bounded `pnpm dev` / `electron-vite` parent chain.
- Use `leases` when debugging which process owns the profile messaging lease.
- If verification fails, inspect the last log lines printed by the script before retrying.
