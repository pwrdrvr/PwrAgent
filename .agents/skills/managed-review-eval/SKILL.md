---
name: managed-review-eval
description: Benchmark PwrAgent managed code reviews against pinned pull-request snapshots. Use for reviewer or prompt comparisons, evaluation cohort maintenance, and held-out validation.
---

# Managed Review Eval

The canonical evaluation suite now lives in the first-class `@pwragent/evals` workspace under [`evals/managed-review/`](../../../evals/managed-review/README.md). Run repeatable repository commands from the PwrAgent root and keep generated outputs under `evals/runs/` (gitignored):

- **Run development or blind holdout reviews** (automatically builds/caches `--rev` + `--prompt`, stages workspaces safely outside `~/.codex`, captures token/replay/cost metrics, and routes `blind: true` cohorts through OS isolation):
  ```bash
  pnpm eval:review -- --cohort dev-1 --arms codex,codex-native,neon --out evals/runs/dev-1-candidate
  pnpm eval:review -- --cohort dev-1 --rev v1.5.1 --arms codex,neon --out evals/runs/dev-1-v1.5.1
  pnpm eval:review -- --cohort test-1 --arms codex,neon --out evals/runs/test-1-candidate
  ```
- **Verify blind isolation with synthetic canaries:**
  ```bash
  pnpm eval:review:verify-isolation -- --arms codex,codex-native,neon
  ```
- **Score with PwrAgent's built-in decision models** (defaults to `--judge-provider jev`; supports `jev`, `local`, `openai`, `default`; `--mode mcp` uses PwrAgent's `decisions_invoke` proxy with no shell API key, `--mode direct` runs standalone):
  ```bash
  pnpm eval:review:score -- --run evals/runs/dev-1-candidate --judge-provider jev
  ```
- **Compare multiple runs/revisions/models/arms side-by-side:**
  ```bash
  pnpm eval:review:compare -- evals/runs/dev-1-v1.5.1 evals/runs/dev-1-candidate
  ```

Detailed reference guides remain in `references/`:
- [Running the matrix](references/run-matrix.md)
- [Isolated reviewer runner](references/isolated-runner.md)
- [Scoring and aggregation](references/scoring.md)
- [Cohort maintenance](references/cohort-maintenance.md)

## Keep holdouts blind

- Tune prompts and inspect individual outcomes on development cohorts (`dev-1`, `dev-2`). Before starting a verified holdout (`test-1`, `test-2`), record the chosen code revision, bundle digest, reviewer models, reasoning settings, and judging definitions. Keep them fixed through validation.
- For any cohort with `blind: true`, keep cases, diffs, intermediate results, and raw logs out of the tuning context and user-facing output. Report aggregate metrics only and omit `--allow-inspect-test`.
- Keep existing holdouts disjoint from future development cohorts. Verify overlap by PR number without displaying case identities.
