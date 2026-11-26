# Collect native Claude baselines

Use this workflow when the verified inventory is short of Claude cases. Claude Code's local `/code-review` accepts a Git revision range. The collector sends `/code-review high <merge-base-sha>..<head-sha>` in a disposable checkout at the pinned head. Both operands are full commit IDs. It pairs that dispatch with the automatic Claude review artifact from the same completed turn. The extractor checks the pair against PwrAgent's normalized Claude transcript and settled review record. [Claude Code's local review targets](https://code.claude.com/docs/en/code-review-local)

A review by PR number can read a moving target. Historical reviews without this dispatch evidence stay out of the fresh splits. The balanced draw requires 3 Claude PRs with at least two declined findings and 9 other Claude PRs with at least two addressed or deferred findings. It also needs 6 verified Codex cases in each of the high-findings, medium-findings, and clean strata.

## Plan and collect

Use the same candidate source checkout for the bundle and the driver. Run inventory before spending provider usage. Coordinate the case cap and account with the operator.

```bash
skill=.agents/skills/managed-review-eval
work=.local/managed-review-eval
plan="$work/plans/collection-001.json"
run="$work/collection-001"

node "$skill/scripts/extract-cohorts.mjs" --repo "$PWD" --profile default --inventory --limit 10000
node "$skill/scripts/extract-cohorts.mjs" --repo "$PWD" --profile default --limit 10000 \
  --plan-claude "$plan" --plan-count 12
```

Set `--plan-count` to the operator-approved number for the batch. Planning freezes the exact commits before any new review and uses prior settlement counts to sample prospective strata. New reviews get their own outcomes. Add `--exclude-cohorts "$work/plans"` on subsequent batches to exclude earlier candidates. Use `--plan-noisy` to target a remaining stratum. Keep plan files and collection outputs private.

After approval, run the native arm by itself on Default Access.

```bash
node "$skill/scripts/build-eval-driver.mjs" --repo "$PWD" --out "$work/dist"
node "$work/dist/review-matrix-driver.js" --repo "$PWD" --cohort "$plan" \
  --out "$run" --arms claude-native --concurrency 2
```

The collector reports aggregate counts for a collection plan. Each run retains the dispatch receipts and its own `eval` profile. The existing split recipe uses recorded review outcomes to select cases. Keep new findings pending until those outcomes are available. When curating the collection, open its isolated profile with `PWRAGENT_HOME` set to `$run/pwragent-home` and `PWRAGENT_PROFILE=eval`. Keep case evidence out of tuning threads. [Review outcomes](../../../../docs/thread-reviews.md#finding-outcomes) · [Isolated profiles](../../../../docs/runtime-configuration.md)

Use the [file-backed Decision workflow](scoring.md) to score reviewer quality on the staged cases. Those judgments measure recall against the selected baseline and score candidate findings and reviews. The collector imports recorded outcomes from the isolated profile for cohort membership.

## Stage and verify

The extractor accepts a capture directory with `--claude-captures`. Repeat that flag for additional collection runs. Inventory reports valid captures awaiting settlement along with eligible cases and shortages. Stage a fresh draw once every stratum is full.

```bash
draft="$work/verified-cohorts"
node "$skill/scripts/extract-cohorts.mjs" --repo "$PWD" --profile default --limit 10000 \
  --claude-captures "$run" --inventory
node "$skill/scripts/extract-cohorts.mjs" --repo "$PWD" --profile default --limit 10000 \
  --claude-captures "$run" --out "$draft"
node "$skill/scripts/extract-cohorts.mjs" --repo "$PWD" --verify-staged --out "$draft"
```

The draw excludes every published PR and assigns new split names. Staged verification checks range flags, Git reachability, the recipe, blinding, paths, and overlap with published cohorts. Report aggregate results and coordinate publication with the operator after verification.
