---
name: managed-review-eval
description: Extract permanently GitHub-survivable code-review eval cohorts from PwrAgent state, run headless PwrAgent managed code reviews (Codex and Antigravity Neon) against immutable PR snapshots, and score recall, diff-grounded precision, and blinded holistic quality using PwrAgent's built-in Decision model (`decisions_invoke`). Use when benchmarking managed review prompts, testing candidate-ledger or reviewer changes, building new dev/test cohorts, or verifying anti-overfitting generalization on held-out test sets.
---

# Managed Review Eval

Run reproducible, headless evaluations of PwrAgent's managed code review pipeline (`runMode: "pwragent-sub-agent"`) against permanently fetchable `pwrdrvr/PwrAgent` PR snapshots, and score every review with PwrAgent's built-in Decision model (`decisions_invoke` / `gpt-6-luna`).

## Anti-Overfitting Rules (Mandatory)

1. **Never inspect individual findings, diffs, or per-PR misses of any cohort with `"blind": true`** (`cohorts/test-1.json`, `cohorts/test-2.json`).
   - Do not open `test-1.json` or `test-2.json` to read individual cases, and do not read `results/*.json` or `eval-matrix-findings-scored.csv` from a blind test run.
   - Read only the aggregate scorecard printed by `aggregate-eval-scores.mjs` (which automatically suppresses per-case and per-finding details when `"blind": true`).
2. **Iterate and error-analyze only on `dev-1.json` and `dev-2.json`.**
3. **Validate generalization on `test-1.json` only after locking a candidate prompt/harness change on dev.**
4. **Keep `test-2.json` as a lockbox** for major architectural changes or release verification.
5. **Never read Codex-owned rollout/session files** in eval scripts. Cohort extraction reads only PwrAgent-owned `~/.pwragent/profiles/<profile>/state/state.db`.

## Prerequisites

- Local checkout of `pwrdrvr/PwrAgent` with `pnpm install` completed.
- Authenticated local provider CLIs for the arms you want to run (`codex` for Codex, `agy` for Antigravity Neon).
- Do not run inside an active PwrAgent profile you are sharing: the headless driver creates an isolated `PWRAGENT_HOME` inside `--out` (`<out>/pwragent-home`) with messaging, federation, and notifications disabled, while reusing `~/.codex` and `~/.gemini` credentials.
- All disposable build outputs, isolated profiles, and run artifacts belong under `.local/managed-review-eval/` (gitignored).

## Workflow

### 1. Verify (or Extract) Permanently Survivable Cohorts

Verify all checked-in cohorts (`dev-1`, `dev-2`, `test-1`, `test-2`) have disjoint PRs, zero machine-local paths, and permanently reachable GitHub refs (`origin/main` base + `refs/pull/<N>/head` tip/ancestor):

```bash
node .agents/skills/managed-review-eval/scripts/extract-cohorts.mjs --verify
```

To mine fresh cohorts from a local PwrAgent profile database (only selecting settled `pwrdrvr/PwrAgent` PRs reachable via `refs/pull/<N>/head` so force-pushed/dangling SHAs are never selected):

```bash
node .agents/skills/managed-review-eval/scripts/extract-cohorts.mjs \
  --repo "$(pwd)" \
  --profile default \
  --out .local/managed-review-eval/new-cohorts \
  --seed 20261125
```

### 2. Bundle the Headless Eval Driver

Rebuild after any edit to PwrAgent's managed review prompt (`apps/desktop/src/main/app-server/managed-review-prompt.md`) or review orchestration code:

```bash
node .agents/skills/managed-review-eval/scripts/build-eval-driver.mjs \
  --repo "$(pwd)" \
  --out .local/managed-review-eval/dist
```

This bundles `review-matrix-driver.ts` alongside the four sibling headless workers (`storage-maintenance-worker`, `claude-session-reader-worker`, `mcp-connection-bridge`, `token-miser-hook`) into `.local/managed-review-eval/dist/`.

### 3. Run the Headless Eval Matrix

Start with a 1-case smoke test before running a full 10-case cohort:

```bash
node .local/managed-review-eval/dist/review-matrix-driver.js \
  --repo "$(pwd)" \
  --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
  --out .local/managed-review-eval/runs/dev-1-candidate \
  --cases pr4385-codex \
  --arms codex,neon
```

Then run the full cohort (completed `<caseId>--<arm>.json` cells are skipped automatically on resume; pass `--force` to overwrite):

```bash
node .local/managed-review-eval/dist/review-matrix-driver.js \
  --repo "$(pwd)" \
  --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
  --out .local/managed-review-eval/runs/dev-1-candidate \
  --cases all \
  --arms codex,neon \
  --concurrency 2 \
  --timeout-ms 900000
```

Notes:
- Missing `headCommit` objects on a fresh clone are fetched automatically via `git fetch --no-tags --no-write-fetch-head origin refs/pull/<N>/head`.
- Each cell captures `status`, `elapsedSec`, `structured`, `findingsCount`, `findings`, `overallCorrectness`, `approvals`, and candidate ledger telemetry (`total`, `keep`, `drop`, `pending`) parsed from `profile-eval.main.log`.
- Run as a background task with `NotificationTimeoutSeconds: 1800`; never poll in a loop.

### 4. Prepare Diff-Grounded Decision Scoring Batches

Generate compact, diff-grounded chunks (`<= 37 KiB` each) for PwrAgent's built-in Decision model:

```bash
node .agents/skills/managed-review-eval/scripts/prepare-scoring-batches.mjs \
  --repo "$(pwd)" \
  --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
  --results .local/managed-review-eval/runs/dev-1-candidate/results \
  --out .local/managed-review-eval/runs/dev-1-candidate/scoring \
  --arms codex,neon
```

This creates three Decision evaluation sets:
- **Recall (`recall-chunk-*.json`):** compares every baseline finding (addressed, deferred, and declined) against each arm's published findings (`same_root_cause` predicate + `match_grade` choice).
- **Precision (`precision-chunk-*.json`):** pairs every candidate finding with its real `git diff` excerpt and baseline list (`matches_baseline` predicate, `concrete_defect` predicate, and 5-level `defect_value` score).
- **Blinded Holistic (`holistic-chunk-*.json`):** scores anonymized baseline, Codex, and Neon reviews on `signal_to_noise`, `actionability`, and `overall_quality` (`1–5`).

### 5. Score with PwrAgent's Decision Model (`decisions_invoke`)

Run `.agents/skills/managed-review-eval/scripts/run-decision-scoring.py` via `run_workflow` with `Args: { "scoringDir": "<abs-path-to-scoring-dir>" }` (or call `decisions_invoke` directly on each chunk JSON in `chunks-manifest.json`). A full 10-PR × 2-arm matrix (~200–240 items) costs roughly `$0.025–$0.035` on `gpt-6-luna`.

### 6. Aggregate Scores & Compare Against Baseline

```bash
node .agents/skills/managed-review-eval/scripts/aggregate-eval-scores.mjs \
  --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
  --results .local/managed-review-eval/runs/dev-1-candidate/results \
  --scoring .local/managed-review-eval/runs/dev-1-candidate/scoring \
  --out .local/managed-review-eval/runs/dev-1-candidate
```

If more than 20 Decision batches ran in one thread and older JSONL files rotated out of `~/.pwragent/profiles/<profile>/state/thread-assets/.../decision-batches/`, pass `--workflow-log <path-to-workflow-output.txt>` so the aggregator automatically recovers the inline results from the workflow child transcripts.

## Interpreting Results

- Compare **addressed recall** (both overall and split by Codex-baseline vs. Claude-baseline), **declined-item repetition**, **diff-grounded concrete defect rate**, **blinded holistic scores** (`SNR`, `Actionability`, `Overall`), **ledger drop rate**, and **latency**.
- `gpt-6-luna` sees only a single-file 950-character diff excerpt per finding in the Precision batch, so absolute `defect_value` scores are conservative for multi-file bugs; treat `defect_value` and `concrete_defect` as consistent relative comparisons across arms and prompt revisions, while `same_root_cause` recall and blinded holistic scores are directly interpretable.
- See [cohorts/README.md](cohorts/README.md) for the recorded `dev-1` baseline benchmark (`origin/main` `165910030`).
