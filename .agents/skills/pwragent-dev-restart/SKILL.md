---
name: pwragent-dev-restart
description: Safely restart the local PwrAgent Electron development app after pulling, rebasing, or merging changes. Use when Codex is running inside or alongside the PwrAgent dev app and a normal restart could kill the current session before `pnpm dev` is relaunched.
---

# PwrAgent Dev Restart

Use this skill when the running Electron app must be stopped and restarted from a freshly updated checkout, especially after merging a PR.

Run the commands below from the checkout you want to restart. The script derives
its default root from its own location, so it targets the checkout it ships in,
including a git worktree.

## Workflow

1. Confirm the target checkout is updated and clean enough to run:

   ```bash
   git status --short --branch
   ```

   ```bash
   git log -1 --oneline --decorate
   ```

2. Dry-run the restart to see which processes would be stopped:

   ```bash
   .agents/skills/pwragent-dev-restart/scripts/restart-pwragent-dev.zsh schedule --delay 30 --dry-run
   ```

3. Schedule the restart and answer the user before the delay expires:

   ```bash
   .agents/skills/pwragent-dev-restart/scripts/restart-pwragent-dev.zsh schedule --delay 30
   ```

4. After the delay, verify the app came back:

   ```bash
   tail -120 .local/pwragent-dev-restart.log
   ```

   ```bash
   pgrep -fl "$PWD|PwrAgent|pnpm.*dev|electron-vite"
   ```

## Script Notes

- The script stops processes matching the target checkout path and their bounded parent dev-server chain, then starts `pnpm dev:dev` from the checkout.
- The script discovers running processes by checkout path. It does not require a pidfile or a previous skill-started instance.
- It excludes Codex helper processes whose serialized command payloads mention the checkout path but are not part of the PwrAgent dev process tree.
- With `--detach-start`, the script starts the dev command in a detached `tmux` session when `tmux` is available. This survives parent command cleanup while keeping the dev logs in the configured restart log.
- It uses a `nohup` sleep wrapper for the delayed timer. Do not use `launchctl submit` here: launchd can keep descendant `pnpm dev` processes in the submitted job context and relaunch them after they exit.
- Default root is derived from the script location: the checkout that contains
  `.agents/skills/pwragent-dev-restart/scripts/restart-pwragent-dev.zsh`. Pass
  `--root PATH` to target a different checkout.
- The root must be a pnpm workspace root (`package.json` and
  `pnpm-workspace.yaml`). The script stops processes whose command line matches
  the root path, so it refuses a broad root that would match unrelated
  processes.
- Default log is `<root>/.local/pwragent-dev-restart.log`.
- Use `--dry-run` before scheduling unless the user explicitly asks to restart immediately.
