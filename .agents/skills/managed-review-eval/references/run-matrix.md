# Running the review matrix

The driver defaults to a read-only Codex sandbox and Antigravity Neon in Plan mode. It stages the pinned merge-base-to-head diff as a patch in the Neon workspace and tells Neon to open it with a file-reading tool. The driver declines command approvals. Use `--allow-full-access` only with explicit operator authorization for that run. The isolated `PWRAGENT_HOME` separates application state. Full Access reviewers can reach the checkout and host credentials, so use a disposable environment with dedicated provider credentials when practical. See the [Full Access escalation policy](../../../../apps/desktop/docs/full-access-escalation.md).

Use Node 24, an installed PwrAgent worktree, and the CLI for each requested arm (`codex` for Codex or `agy` for Antigravity Neon). The matrix exercises managed review. Native Codex and Claude reviews supply the cohort baselines.

Rebuild after changes to the driver or the managed review implementation, including the guidance used by the [prompt builder](../../../../apps/desktop/src/main/app-server/managed-review.ts).

Build and pass `--repo` from the candidate source checkout. A linked Git worktree is fine. The driver reads the pinned commits from that checkout and stages each cell in its own shallow repository under `<out>/workspaces/`. The reviewer starts at the pinned head. Its local `.git` contains the base, head, and enough history to reproduce the exact merge base. The checkout has its own object store and a public GitHub `origin` for PR validation.

The driver disables system and global Git configuration for reviewer processes with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` set to the platform null device. Fetches needed to populate the source checkout can still use the operator's usual Git authentication.

```bash
skill=.agents/skills/managed-review-eval
work=.local/managed-review-eval
run="$work/runs/dev-1-candidate"

node "$skill/scripts/build-eval-driver.mjs" --repo "$PWD" --out "$work/dist"

node "$work/dist/review-matrix-driver.js" \
  --repo "$PWD" --cohort "$skill/cohorts/dev-1.json" --out "$run" \
  --cases pr4385-codex --arms codex,neon
```

Confirm each requested arm returned a completed structured result. To run the full development cohort with identical settings, repeat the command with `--cases all`. The driver runs arms in order for each PR head and applies `--concurrency` across different cases. `--neon-model` requires an exact model ID from the provider catalog. The driver records the reviewer checkout path in each result and resumes only structured results whose snapshot, bundled code, model, effort, and access match the current cell. Use `--force` to rerun matching cells. Use a separate run directory to retain the previous comparison.

The local driver refuses blind evaluation before launching a reviewer. Blind evaluation needs a separate reviewer environment that cannot read the baseline or scoring files, including from repository history. A private native Claude collection plan contains only prospective targets and can still run with aggregate output.

For an accepted turn that times out, the worker interrupts the review and waits for terminal evidence before its slot runs another case. If acceptance or termination is uncertain, the driver stops admitting cases and shuts down the owner.
