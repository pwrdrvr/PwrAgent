---
name: boat-verification
description: >-
  Run PwrAgent repository checks on Boat when the operator approves or asks
  in this thread and the connected account can start a sandbox.
---

# Verify on Boat

1. **Check availability.** Call `manage_mcp_connections` with `action: list`.
   Look for `builtin:boat` with `state: ready` and `sandboxStart.canStart: true`.
   Boat's `account_status` can refresh the account limits. If Boat is full
   (for example, 2 of 2 on a trial), report the counts and reason and fall
   back to local checks or repository CI. Also fall back when the connection
   is unavailable or capacity is unknown. Skip the queue. Stop or delete an
   existing sandbox to make room only if this thread owns it and the operator agrees.
2. **Get approval in this thread.** If the operator has already asked for
   Boat, proceed once it is available. Otherwise, propose the checks, size and
   expected runtime if Boat would help. Say it bills per second while running
   and wait for approval. Use local checks or CI if approval is missing.
   Connection access and automatic tool approvals do not count.
3. **Create and push.** Use PwrAgent's `search_mcp_tools` for `builtin:boat`
   and `call_mcp_tool` with the returned tool names and schema revisions.
   Keep **Keep credentials out** enabled in the Boat settings. Call
   `create_sandbox` with a recognizable name and the operator's defaults for
   size and auto-stop. If a larger size or longer auto-stop exceeds their
   limits, the tool asks separately. Pass the returned sandbox ID on each
   sandbox call. Poll `get_sandbox` until `ready` or `idle`. If the start is
   refused for capacity or billing, report the reason and fall back.

   Call `push_workspace` for the assigned thread directory and use the
   returned `remotePath` as `cwd` for `exec`. The push includes tracked files
   and non-ignored untracked files, including local edits. Review what will
   be sent for secrets. `.env`, `.env.*` and `.envrc` are excluded even if
   tracked. Never send them by another route or handle the Boat API key.
   The copy starts at `pwragent-base` with no Git history or remotes.
4. **Set up and run checks.** Use Boat `exec` to match `.nvmrc` and the
   `packageManager` pin in `package.json`, then run `pnpm install --frozen-lockfile`
   in the pushed workspace. Install missing tooling in the sandbox under the
   sandbox user where possible. Run `pnpm lint` and `pnpm test` after setup.
   `pnpm lint` includes `pnpm typecheck`. If lint stops before that phase,
   run `pnpm typecheck` separately. Focus tests when appropriate and report
   which checks ran.

   Keep separate logs under ignored `.local/`, for example
   `pnpm test > .local/boat/unit.log 2>&1` after creating the directory.
   For long checks use `exec` with `detached: true` and poll `command_status`
   with the returned `processId` and a small `tailBytes` (for example 4096).
   Use `exec` with `tail -c 4096` or a bounded failure summary for log details.
   Report the workspace revision and any pushed local edits, sandbox ID,
   exit codes and failures. Keep full logs out of tool results.
5. **Pull intended edits and clean up.** Use `git status --short` to check
   for edits. If there are changes to keep, review them and use `pull_changes`
   with the same directory and `remotePath`. It applies them unstaged and
   leaves local files untouched on conflict. At the end, including after any
   failure, call `stop_sandbox` to end billing or `delete_sandbox` if permanent
   deletion is authorized. Confirm with `get_sandbox` or the deletion result.
   Check state before retrying a timed-out call. Report any unconfirmed
   cleanup. Auto-stop and PR cleanup are backstops.

Boat is a [Linux VM with desktop support](https://docs.boat.dev/desktop-streaming).
Linux desktop Playwright may run there if the sandbox has the Linux CI
prerequisites (Electron system libraries, Xvfb, Openbox and `xprop`) and can
launch Electron with sandboxing enabled. Follow the Linux Desktop E2E lane
in [CI](../../../.github/workflows/ci.yml) and the
[Linux sandbox setup rules](../../../docs/development-checks.md#linux-sandbox-setup).
Use CI if those prerequisites are missing. Do not run the suite on the
operator's Mac. Boat covers Linux behavior only. Use native CI or the matching
PwrSuiteLab route for macOS and Windows.

Never make a port public. Verification runs inside the VM. If a local client
needs access, `forward_port` binds only to `127.0.0.1` on the operator's computer.
Ask before `save_snapshot` and explain that named snapshots persist after
cleanup and cost a daily fee beyond the plan's included allowance. PwrAgent
neither tracks nor deletes them. See [Boat remote compute](../../../docs/boat-remote-compute.md)
and [Boat pricing](https://docs.boat.dev/pricing).
