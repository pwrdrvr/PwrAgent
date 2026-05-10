---
name: pwragent-dev-restart
description: Safely restart the local PwrAgent Electron development app after pulling, rebasing, or merging changes. Use when Codex is running inside or alongside the PwrAgent dev app and a normal restart could kill the current session before `pnpm dev` is relaunched.
---

# PwrAgent Dev Restart

Use this skill when the running Electron app must be stopped and restarted from a freshly updated checkout, especially after merging a PR into `~/github/PwrAgnt`.

## Workflow

1. Confirm the target checkout is updated and clean enough to run:

   ```bash
   git -C /Users/huntharo/github/PwrAgnt status --short --branch
   git -C /Users/huntharo/github/PwrAgnt log -1 --oneline --decorate
   ```

2. Dry-run the restart to see which processes would be stopped:

   ```bash
   .agents/skills/pwragent-dev-restart/scripts/restart-pwragent-dev.zsh \
     schedule --root /Users/huntharo/github/PwrAgnt --delay 30 --dry-run
   ```

3. Schedule the restart and answer the user before the delay expires:

   ```bash
   .agents/skills/pwragent-dev-restart/scripts/restart-pwragent-dev.zsh \
     schedule --root /Users/huntharo/github/PwrAgnt --delay 30
   ```

4. After the delay, verify the app came back:

   ```bash
   tail -120 /Users/huntharo/github/PwrAgnt/.local/pwragent-dev-restart.log
   pgrep -fl '/Users/huntharo/github/PwrAgnt|PwrAgent|pnpm.*dev|electron-vite'
   ```

## Script Notes

- The script stops processes matching the target checkout path and their bounded parent dev-server chain, then starts `pnpm dev` from the checkout.
- It uses `launchctl submit` on macOS for the delayed timer, then starts `pnpm dev` detached and removes the one-shot launchd job. If `launchctl` is unavailable or submission fails, it falls back to `nohup`.
- Default root is `/Users/huntharo/github/PwrAgnt`.
- Default log is `<root>/.local/pwragent-dev-restart.log`.
- Use `--dry-run` before scheduling unless the user explicitly asks to restart immediately.
