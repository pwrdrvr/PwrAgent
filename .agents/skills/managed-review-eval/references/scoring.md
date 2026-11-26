# Scoring and aggregation

Use the same cohort and arms as the matrix. Pass the candidate source checkout as `--repo`. Preparation resolves absolute finding paths against the reviewer checkout recorded in each cell and reads the pinned Git diff from the source checkout. It can score archived results after the reviewer checkouts are removed. Preparation requires completed structured results for every cell. To score a smoke run, supply a one-case development cohort file that matches it.

Baselines must have a verified original review range with provenance. On development cohorts, `--allow-legacy-baselines` allows exploratory scoring of historical cases and labels the results provisional. Blind scoring requires verified baseline ranges and matching merge-base and head metadata in every candidate cell; results written by the [isolated reviewer runner](isolated-runner.md) preserve both fields and score identically on the controller side after ephemeral workspaces are deleted.

```bash
skill=.agents/skills/managed-review-eval
cohort="$skill/cohorts/dev-1.json"
run=.local/managed-review-eval/runs/dev-1-candidate
scoring="$run/scoring"

node "$skill/scripts/prepare-scoring-batches.mjs" \
  --repo "$PWD" --cohort "$cohort" --results "$run/results" \
  --out "$scoring" --arms codex,neon --judge-provider openai --allow-legacy-baselines
```

Preparation uses the same pinned merge-base-to-head range as the reviewer, writes anonymous holistic findings, and splits serialized chunks at 37 KiB. An input that exceeds the limit on its own requires a decision about what evidence to include before scoring.

## Invoke Decision batches

Use PwrAgent's built-in `decisions_invoke` tool. Choose `--judge-provider openai` or `--judge-provider jev` at preparation and keep that choice fixed across comparisons. Coordinate provider usage with the operator before invoking batches. The selected provider receives the evidence.

1. Discover `decisions_invoke` through PwrAgent tool search. The connected owner must advertise `inputsFile`, `outputFile`, and `inlineResults`. If those fields are missing, keep the prepared files for a session connected to an updated owner.
2. Print the pending call arguments. The plan contains definitions and file paths. The case evidence and answers stay in files.

   ```bash
   node "$skill/scripts/decision-file-batches.mjs" --scoring "$scoring"
   ```

3. For each `pending` entry, call `decisions_invoke` with its `arguments` object. Each call uses one file-backed batch with `inlineResults: false`. Keep the input and output paths in the active thread workspace, scratch directory, or temporary directory. During blind scoring, keep the contents of those files out of the tuning context.
4. Record the finished batches. This checks the input and definition hashes, provider, and answers before creating `decision-batches-summary.json`. Repeat the plan command to find remaining batches. Output filenames include both hashes, so changes to evidence or definitions get new batches.

   ```bash
   node "$skill/scripts/decision-file-batches.mjs" --scoring "$scoring" --record
   ```

## Aggregate and interpret

Aggregation checks the prepared cohort and result file digests and requires a successful answer set for every expected index. Prepare batches again after changing the cohort or rerunning a cell. Missing or mismatched chunks, failed items, and unanswered judgments make the scorecard incomplete.

```bash
node "$skill/scripts/aggregate-eval-scores.mjs" \
  --cohort "$cohort" --results "$run/results" --scoring "$scoring" --out "$run"
```

For blind cohorts, read only `aggregates` and `decisionScoring` from `eval-matrix-summary.json`. Compare addressed recall by baseline reviewer, declined-finding repetition, concrete-defect rate, holistic quality, candidate-ledger drop rate, and latency. Keep the cohort and judging definitions fixed across comparisons. Precision excerpts are limited to one file, so multi-file findings can lack important context.
