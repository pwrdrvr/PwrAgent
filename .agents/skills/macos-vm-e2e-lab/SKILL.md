---
name: macos-vm-e2e-lab
description: >-
  Route PwrAgent macOS Tart, self-hosted runner, headed E2E, and visual-golden
  work to PwrSuiteLab when a checkout is available. Use when a user mentions
  Tart, a local macOS VM, self-hosted macOS runners, E2E windows stealing
  focus, or PwrAgent visual goldens. Do not use for Windows VM probes or
  Windows E2E.
---

# PwrAgent macOS VM E2E lab

PwrAgent does not own the Tart lab, runner VMs, or guest OS baseline.
PwrSuiteLab does. Do not provision a product-local Tart lab from this
repository. Do not clone a Cirrus image or register a GitHub Actions runner
from these files.

## Prefer PwrSuiteLab

1. Resolve an existing PwrSuiteLab checkout from linked directories,
   Federation, MCP, or an explicit operator pointer. Do not assume a
   pathname. Do not clone, install, or provision PwrSuiteLab as part of a
   product task.
2. Use the attached primary checkout. Do not select a disposable worktree.
3. Confirm the ignored config with an exact filesystem test. Headed E2E
   uses `local-config/macos-tart.sh`. Runner work uses
   `local-config/macos-runner.sh`. `rg --files`, `git ls-files`, and other
   worktrees do not prove that a config is absent. Do not read, print, or
   copy the config. If the exact default is absent, ask the operator for
   an existing config path only.
4. Read the matching skill in that checkout and follow it:

   | Work | Skill in the PwrSuiteLab checkout |
   |---|---|
   | Headed E2E and visual goldens | `macos-tart/README.md` and `macos-tart/run-e2e.sh` |
   | Runner start, stop, pause, resume | `.agents/skills/operate-macos-gha-runner/SKILL.md` |
   | Runner inspection | `.agents/skills/inspect-macos-gha-runner/SKILL.md` |
   | Runner or E2E VM rebuild | `.agents/skills/rebuild-macos-lab-vm/SKILL.md` |
   | VNC, SSH, registration, recovery | `.agents/skills/manage-macos-gha-runner/SKILL.md` |
   | Windows probes or Windows E2E | `.agents/skills/use-windows-vm-lab/SKILL.md` |

If no checkout is discoverable, ask the operator for the lab pointer and
stop. Do not invent a fallback lab.

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
