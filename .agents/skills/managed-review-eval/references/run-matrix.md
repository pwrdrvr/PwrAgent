# Running the review matrix

The driver defaults to a read-only Codex sandbox and Antigravity Neon in Plan mode. It declines approval requests that would expand access or require an operator decision. Use `--allow-full-access` only with explicit operator authorization for that run. The isolated `PWRAGENT_HOME` separates application state. Full Access reviewers can reach the checkout and host credentials, so use a disposable environment with dedicated provider credentials when practical. See the [Full Access escalation policy](../../../../apps/desktop/docs/full-access-escalation.md).

Use Node 24, an installed PwrAgent worktree, and the CLI for each requested arm (`codex` for Codex or `agy` for Antigravity Neon). The matrix exercises managed review. Native Codex and Claude reviews supply the cohort baselines.

Rebuild after changes to the driver or the managed review implementation, including the guidance used by the [prompt builder](../../../../apps/desktop/src/main/app-server/managed-review.ts).

```bash
skill=.agents/skills/managed-review-eval
work=.local/managed-review-eval
run="$work/runs/dev-1-candidate"

node "$skill/scripts/build-eval-driver.mjs" --repo "$PWD" --out "$work/dist"

node "$work/dist/review-matrix-driver.js" \
  --repo "$PWD" --cohort "$skill/cohorts/dev-1.json" --out "$run" \
  --cases pr4385-codex --arms codex,neon
```

Confirm each requested arm returned a completed structured result. To run the full development cohort with identical settings, repeat the command with `--cases all`. The driver fetches missing commit objects and resumes only structured results whose snapshot, bundled code, model, effort, and access match the current cell. Use `--force` to rerun matching cells. Use a separate run directory to retain the previous comparison.

A blind run prints aggregate cell counts. Keep its detailed local logs and cell files out of the tuning context. For an accepted turn that times out, the worker interrupts the review and waits for terminal evidence before its slot runs another case. If acceptance or termination is uncertain, the driver stops admitting cases and shuts down the owner.
