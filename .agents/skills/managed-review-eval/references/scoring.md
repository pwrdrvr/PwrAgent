# Scoring and aggregation

Use the same cohort and arms as the matrix. Preparation requires completed structured results for every cell. To score a smoke run, supply a one-case development cohort file that matches it.

Baselines must have a verified original review range. On development cohorts, `--allow-legacy-baselines` allows exploratory scoring of historical cases and labels the results provisional. Blind validation requires verified ranges for every case.

```bash
skill=.agents/skills/managed-review-eval
cohort="$skill/cohorts/dev-1.json"
run=.local/managed-review-eval/runs/dev-1-candidate
scoring="$run/scoring"

node "$skill/scripts/prepare-scoring-batches.mjs" \
  --repo "$PWD" --cohort "$cohort" --results "$run/results" \
  --out "$scoring" --arms codex,neon --allow-legacy-baselines
```

Preparation uses the same pinned merge-base-to-head range as the reviewer, writes anonymous holistic findings, and splits serialized chunks at 37 KiB. An input that exceeds the limit on its own requires a decision about what evidence to include before scoring.

## Invoke Decision batches

Use PwrAgent's built-in Decision tools. They send scoring evidence to the configured OpenAI provider and bill the operator's API project. If neither route is available, keep the chunks for a Decision-enabled PwrAgent session.

- **From Decision-enabled Codex for development cohorts**, discover `decisions_invoke` through PwrAgent tool search. Process each entry of `recall`, `precision`, and `holistic` in `chunks-manifest.json` in order. Use the matching entry from the prepared `scoring-definitions.json` as `definition` and pass the unchanged chunk array as `inputs`. Use `detail: "compact"`. If a batch runs in the background, use its `batchId` with `decisions_batch_results` after it finishes. Archive the files as described below.
- **With Antigravity's `run_workflow` available**, pass [run-decision-scoring.py](../scripts/run-decision-scoring.py) with `Args: { "scoringDir": "/absolute/path/to/scoring" }`. It archives results under `jsonl/` and creates the summary. It reuses completed archives only when the chunk and definitions match. For a blind cohort, use a runner that keeps case-level evidence and tool responses out of the tuning context.

### Record direct Decision results

Copy each completed batch's `resultsFile` to a stable path under `<scoring>/jsonl/` before launching more batches. PwrAgent rotates its own copies. Save `<scoring>/decision-batches-summary.json` as an object with `recall`, `precision`, and `holistic` arrays. Use one entry per manifest chunk in manifest order.

| Field | Source |
| --- | --- |
| `batchType` | The manifest key |
| `chunkIndex` | Zero-based position in that manifest array |
| `start`, `count`, `inputsSha256` | The manifest chunk entry |
| `definitionSha256` | The top-level manifest field |
| `batchId`, `succeeded`, `failed` | The final Decision batch response |
| `resultsFile` | Absolute path to the archived JSONL |
| `estimatedCostUsd` | The response's `usage.estimatedCostUsd`, when available |

## Aggregate and interpret

Aggregation requires a successful answer set for every expected index. Missing or mismatched chunks, failed items, and unanswered judgments make the scorecard incomplete.

```bash
node "$skill/scripts/aggregate-eval-scores.mjs" \
  --cohort "$cohort" --results "$run/results" --scoring "$scoring" --out "$run"
```

For blind cohorts, read only `aggregates` and `decisionScoring` from `eval-matrix-summary.json`. Compare addressed recall by baseline reviewer, declined-finding repetition, concrete-defect rate, holistic quality, candidate-ledger drop rate, and latency. Keep the cohort and judging definitions fixed across comparisons. Precision excerpts are limited to one file, so multi-file findings can lack important context.
