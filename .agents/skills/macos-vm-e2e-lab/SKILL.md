---
name: macos-vm-e2e-lab
description: >-
  Route PwrAgent macOS Tart, self-hosted runner, headed E2E, and visual-golden
  work through an existing PwrSuiteLab checkout and its managed controllers.
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

## Resolve the lab checkout

1. Discover an existing PwrSuiteLab checkout from the current thread's
   attached or linked directories, known local project checkouts, or
   PwrAgent/Federation project metadata. An explicit operator pointer is also
   valid. Do not assume or hardcode a machine-specific pathname. Do not clone,
   install, or provision PwrSuiteLab as a fallback.
2. Use PwrSuiteLab's primary checkout for controllers. Do not select or operate
   from one of its disposable worktrees.
3. Read that checkout's `AGENTS.md`, then read the current `macos-tart`
   runbook and any applicable skill it identifies before running or diagnosing
   anything. The lab checkout is authoritative; do not reconstruct its
   procedure from this skill.
4. Confirm the required ignored config in the primary checkout with an exact
   filesystem existence test. Headed E2E uses
   `local-config/macos-tart.sh`; runner work uses
   `local-config/macos-runner.sh`. `rg --files`, `git ls-files`, and checks in
   other worktrees do not prove that a config is absent. Never read, print,
   copy, summarize, or expose the ignored config. If the exact default is
   absent, ask the operator only for an existing config path.
5. Follow the matching current PwrSuiteLab instructions:

   | Work | Skill in the PwrSuiteLab checkout |
   |---|---|
   | Headed E2E and visual goldens | The current `macos-tart` runbook/skill and `macos-tart/run-e2e.sh` |
   | Runner start, stop, pause, resume | `.agents/skills/operate-macos-gha-runner/SKILL.md` |
   | Runner inspection | `.agents/skills/inspect-macos-gha-runner/SKILL.md` |
   | Runner or E2E VM rebuild | `.agents/skills/rebuild-macos-lab-vm/SKILL.md` |
   | VNC, SSH, registration, recovery | `.agents/skills/manage-macos-gha-runner/SKILL.md` |
   | Windows probes or Windows E2E | `.agents/skills/use-windows-vm-lab/SKILL.md` |

If a usable primary checkout is not discoverable, ask the operator where the
existing checkout is or to attach it, then stop. If the requested work would
require private construction or access details, ask the operator to handle or
provide the supported PwrSuiteLab path, then stop. Do not invent a fallback
lab.

## Use the managed controller

Normal headed E2E and visual-golden generation use PwrSuiteLab's
`macos-tart/run-e2e.sh` controller. The controller owns starting the pet guest
when needed and applying the lab's configured strict transport. Use the
PwrAgent invocation documented in
[CONTRIBUTING.md](../../../CONTRIBUTING.md), subject to the current PwrSuiteLab
runbook and its approval gates.

For E2E lock, status, execution, or recovery, never run or recommend:

- bare `tart` commands, including `tart ip`;
- raw `ssh`;
- manual host-key acceptance or the global known-hosts file;
- password-prompting authentication;
- disabling strict host-key checking; or
- asking the operator to run any of those shortcuts.

Lab diagnosis and recovery must remain in PwrSuiteLab and use its current
skills/controllers with their approval gates. Do not bypass the controller to
inspect or repair the guest.

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
