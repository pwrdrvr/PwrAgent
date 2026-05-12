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

Verify that a previously started instance is still up:

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh verify --root "$PWD"
```

## Workflow

1. Run `status` first when the user asks what is running or when closing processes may be surprising.
2. Run `restart` when the user asks to start the dev profile; it closes the prior managed dev-profile instance, starts `PWRAGENT_PROFILE=dev pnpm dev` detached from the checkout, and waits until the Electron dev process is visible.
3. Run `close` when the user only wants the dev-profile app stopped.
4. Relay the script output and the log path to the user. The default log is `.local/pwragent-dev-profile.log`.

## Script Notes

- The script defaults to `--profile dev`, `--root "$PWD"`, `.local/pwragent-dev-profile.pid`, and `.local/pwragent-dev-profile.log`.
- Prefer `restart` over hand-running `PWRAGENT_PROFILE=dev pnpm dev`; the script records a PID file and makes later cleanup deterministic.
- The script only targets the managed PID tree and root-scoped development commands such as `pnpm dev`, `electron-vite dev`, and Electron descendants. It does not kill arbitrary processes just because they are running under the same checkout.
- If verification fails, inspect the last log lines printed by the script before retrying.
