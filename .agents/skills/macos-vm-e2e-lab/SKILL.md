---
name: macos-vm-e2e-lab
description: >-
  Route PwrAgent macOS Tart, self-hosted runner, headed E2E, and visual-golden
  work through PwrSuiteLab Control MCP, with managed-controller fallback only
  when MCP is unavailable.
  Use when a user mentions Tart, a local macOS VM, self-hosted macOS runners,
  E2E windows stealing focus, or PwrAgent visual goldens. Do not use for
  Windows VM probes or Windows E2E.
---

# PwrAgent macOS VM E2E lab

PwrAgent does not own the Tart lab, runner VMs, or guest OS baseline.
PwrSuiteLab does. Do not provision a product-local Tart lab from this
repository. Do not clone a Cirrus image or register a GitHub Actions runner
from these files.

Keep the boundary explicit: product tests and CI contracts belong in
PwrAgent; private lab inventory, configuration, transport, diagnosis, and
recovery belong only in PwrSuiteLab. Never copy private access values,
addresses, usernames, fingerprints, keys, configuration contents, host
inventory, or lab construction details into PwrAgent.

## Prefer PwrSuiteLab Control MCP

Discover the connected Control tools and obtain the current `tools/list`
schemas before invoking them. In PwrAgent, use `search_mcp_tools` and
`call_mcp_tool` for live connection tools. Read Control's served
`skill://manage-pwrlab-e2e/SKILL.md`, plus `skill://inspect-pwrlab/SKILL.md`
for status and `skill://operate-pwrlab/SKILL.md` for operations. Discover these
with `skills/list` and `skills/get`, then read their contents through
`resources/read`; older clients can use `resources/list` and `resources/read`.
The connected server's current schema and served skills are authoritative.
Do not require a local lab checkout or a Federation handoff for this MCP path.

An existing Operate grant authorizes matching exposed MCP operations within
the requested task without per-operation dialogs. A Read only grant does not.
Report an explicit `permission_denied`; do not switch transports to bypass it.
Rebuilding a VM or changing access remains a separate operator-authorized task.
Keep Control open and preserve its target, transport, and ownership guards.

### Required caller fields on every run and acquire

Place caller attribution beside `target` and `job`, never inside `job`:

```json
{
  "target": "<exact E2E target from lab_status>",
  "agent_name": "Codex",
  "project_name": "PwrAgent",
  "thread_name": "Verify macOS visual goldens",
  "job": {
    "repository": "/absolute/path/to/clean/committed/worktree",
    "setup": [["pnpm", "install", "--frozen-lockfile"]],
    "command": ["env", "PWRAGENT_E2E_DISABLE_GPU=1", "pnpm", "test:desktop-e2e", "e2e/visual-regression.spec.ts"],
    "artifacts": ["apps/desktop/test-results", "apps/desktop/playwright-report"],
    "timeout_seconds": 3600
  }
}
```

Replace `agent_name` with the calling agent (for example, `Claude Code` when
Claude is calling), `project_name` with the actual repository display name,
and `thread_name` with the current task title. The example assumes the guest
runtime versions required by current CI and `package.json`; see
[CONTRIBUTING.md](../../../CONTRIBUTING.md) for product setup requirements.
For `lab_e2e_acquire`, use the same top-level target and attribution but omit
`job`. Add `pr_number` as decimal digits in a string only when known.

### Submit and collect a headed test job

1. Call `lab_status` and select the exact target of the dedicated E2E role.
   Never select a GitHub Actions runner or use the physical host desktop.
   Refresh status before submitting another job; the VM may have stopped
   while preparing it. `lab_e2e_run` starts the configured VM when necessary.
2. Use this thread's clean, committed local worktree on the Control host.
   Only committed HEAD and locally available submodule/LFS content travel;
   obtain required LFS objects first. Never discard changes to make it clean.
   Select setup, runtime versions, commands, and artifacts from the repository's
   current package scripts and CI. See the product example in
   [CONTRIBUTING.md](../../../CONTRIBUTING.md).
3. Call `lab_e2e_run` with top-level `target`, `agent_name`, `project_name`,
   `thread_name`, and `job`. Both run and `lab_e2e_acquire` require those three
   attribution fields, including a run consuming an existing reservation.
   Use the actual agent, `PwrAgent` as the project, and the current thread title
   (or a descriptive task title if unavailable). Add `pr_number` as a string
   of decimal digits when known; omit it otherwise. Attribution is display
   metadata, not authorization; do not include credentials or local paths.
4. Set `job.repository` to the absolute worktree path, `job.command` to an
   argv array, `job.setup` to an ordered array of argv arrays, and
   `job.artifacts` to relative checkout paths. These are not shell strings.
   For a necessary shell function or compound command, explicitly use
   `["bash", "-c", "..."]` and source/select the required runtime there.
   Dependency installation runs in the guest; do not install host tools or
   copy host environment files or credentials as a workaround.
5. Save the request ID and `run_id`. Poll `lab_request_status` for the launch
   request; a completed launch with `job_state: running` is not a passed test.
   Use `lab_e2e_collect` with the target and saved run ID, polling its request
   if needed. Inspect the returned artifact directory and log, and report test
   exit code, setup failures, and missing artifacts. Never commit raw logs.
   Collection does not start a stopped VM: use `lab_e2e_start` for the exact
   target before collecting, within the authorized task. Do not rerun tests
   just to retrieve artifacts.

### Invalid arguments are not a permission diagnosis

`-32602` / `Invalid tool or arguments` can reject a call before dispatch.
Refresh tool discovery/schema and the served skill, then check required
attribution, top-level placement, string `pr_number`, and argv array shapes.
Do not infer a lost Operate grant, request a re-grant, or switch to scripts or
Federation from that error alone. If a corrected call still fails, report the
schema mismatch/error for diagnosis instead of repeatedly submitting it.
For a launch/transport failure, inspect any returned request and run IDs before
retrying: a guest job may already have started.

### Ownership, lock age, and recovery

Read the E2E role's `lock_state`, `owner_kind`, `session_active`, and
`host_lock_state` together. Report `lock_started_at` in UTC (`Z`) and the full
`lock_age_seconds`, not the chart window or Control uptime. Preserve unknown
or not-collected values; age is not an expiry or proof that recovery is safe.

A run claims the display before staging or setup; no preliminary acquire is
needed. It can consume this OAuth connection's reservation atomically, and the
guest releases its own workload lock on completion. Do not call
`lab_e2e_release` after that handoff. Release only this connection's interactive
reservation when finished; another connection does not inherit ownership.

An interrupted result is not a passing test. Preserve its lock until
`lab_e2e_recover` validates an orphan. Guarded recovery refuses live sessions,
live app reservations, malformed owners, and unknown transport state. Use
release for an owned reservation, recovery for a validated stale workload
lock. Never delete locks manually or treat age as permission for takeover.

## Controller fallback only when MCP is unavailable

If Control MCP is unavailable to the client, use the existing managed
controller path under the current PwrSuiteLab runbook. This fallback is not a
way around invalid arguments, permission denial, a busy target, or a safety
refusal. Preserve existing scoped authorizations; do not ask again for work
already authorized, and do not treat an MCP grant as blanket script approval.

1. Discover an existing PwrSuiteLab primary checkout through attached/linked
   directories, known project checkouts, or project metadata (Federation may
   help locate it only on this fallback path). Do not hardcode a host pathname,
   clone/install a lab, or operate controllers from a disposable lab worktree.
2. Read that checkout's `AGENTS.md`, current `macos-tart` runbook, and applicable
   skills. Follow their target-resolution and approval requirements. The lab
   checkout is authoritative for controller flags and recovery procedures.
3. Test required ignored configuration with an exact filesystem existence
   check: `local-config/macos-tart.sh` for headed E2E or
   `local-config/macos-runner.sh` for runners. Never read, print, copy, or expose
   the config. `rg --files`, `git ls-files`, or another worktree cannot prove
   its absence. If missing, ask only for an existing operator-supplied path.
4. For headed tests use `macos-tart/run-e2e.sh --confirm-live-run --workload
   pwragent --local <product-worktree> <playwright-arguments>` from that lab
   checkout. The flag asserts actual authorization; it does not grant it.
   Legacy scripts cannot consume a Control reservation. Do not release a
   reservation merely to bypass the MCP path.
5. For runner work use the lab's `operate-macos-gha-runner` or
   `inspect-macos-gha-runner` skills. Rebuilds use `rebuild-macos-lab-vm`;
   access/lifecycle recovery uses `manage-macos-gha-runner`. Windows work uses
   `use-windows-vm-lab`, not this macOS workflow.

If no usable primary checkout exists, ask for the existing lab pointer and
stop. Never invent a fallback lab. On either path, do not run or recommend bare
`tart` (including `tart ip`), raw SSH, manual host-key acceptance, global
known-hosts changes, password-prompting authentication, or disabled strict
host-key checking. Do not explore keys or ask the operator to take those
shortcuts. Diagnosis and recovery remain in PwrSuiteLab's supported tools.

## PwrAgent product facts

These stay in this repository because they are product or CI contracts,
not lab inventory:

- Generate macOS visual goldens only in the lab VM that matches the
  macOS/ARM64 CI renderer. The workflow is in
  [CONTRIBUTING.md](../../../CONTRIBUTING.md).
- The CI lane uses `runs-on: [self-hosted, macOS, ARM64, pwrdrvr-macos]`.
- The `PwrDrvr macOS` runner group is selected-repository only for
  PwrAgent and PwrSnap. Do not add a repository-scoped runner. Do not
  grant the rest of the organization access.
- Fork-head pull requests must not run on those machines.
- VM E2E sets `PWRAGENT_E2E_DISABLE_GPU=1`. Ordinary host E2E does not.
