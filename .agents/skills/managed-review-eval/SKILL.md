---
name: managed-review-eval
description: Benchmark PwrAgent managed code reviews against pinned pull-request snapshots. Use for reviewer or prompt comparisons, evaluation cohort maintenance, and held-out validation.
---

# Managed Review Eval

Use the checked-in `pwrdrvr/PwrAgent` cohorts to evaluate the managed code review pipeline. Run repository commands from the PwrAgent root and keep generated artifacts in `.local/managed-review-eval/`.

- **Run or resume reviews.** Read [Running the matrix](references/run-matrix.md) for the access gate, arm selection, and smoke test.
- **Score existing reviews.** Read [Scoring and aggregation](references/scoring.md) for Decision invocation from Codex, result validation, and score interpretation.
- **Verify or build cohorts.** Read [Cohort maintenance](references/cohort-maintenance.md) for Git verification, source provenance, and staging a new split.

## Keep holdouts blind

- Tune prompts and inspect individual outcomes on development cohorts. Before starting a verified holdout, record the chosen code revision, bundle digest, reviewer models, reasoning settings, and judging definitions. Keep them fixed through validation. Reserve the final lockbox for major changes or release validation.
- For any cohort with `blind: true`, keep cases, diffs, intermediate results, and raw logs out of the tuning context and user-facing output. Report aggregate metrics only. Use scripts to process those files and omit `--allow-inspect-test`.
- Keep existing holdouts disjoint from future development cohorts. Verify overlap by PR number without displaying case identities.
