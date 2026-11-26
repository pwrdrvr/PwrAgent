# Cohort maintenance

See [cohort history](../cohorts/README.md) for the original split and development benchmark.

## Verify checked-in snapshots

From the repository root, run the verifier against the checked-in cohort directory. It queries the GitHub PR refs on `origin` and may fetch missing objects.

```bash
node .agents/skills/managed-review-eval/scripts/extract-cohorts.mjs --verify
```

This checks Git reachability of the pinned snapshots, unique PR numbers across splits, and machine-local paths in decoded cohort fields. Ref reachability can change after history is rewritten. Review provenance is a separate check. Historical cases whose original review range could not be confirmed are marked `reviewedRangeVerified: false`.

## Stage a new cohort

If the verified inventory is short of native Claude cases, read [Collect native Claude baselines](native-claude-baselines.md) for immutable dispatch, private settlement, and the fresh split checks.

Use the read-only PwrAgent profile database (`~/.pwragent/profiles/<profile>/state/state.db`). Select the source profile explicitly and stage the draft away from the checked-in files.

```bash
skill=.agents/skills/managed-review-eval
work=.local/managed-review-eval
node "$skill/scripts/extract-cohorts.mjs" \
  --repo "$PWD" --profile default --out "$work/new-cohorts" --seed 20261125
```

The extractor excludes PRs from the published cohorts and from any additional directory supplied by `--exclude-cohorts`. Use `--seed-dev1` only for a verified development cohort. New baselines require a frozen PR snapshot for native Codex or a verified dispatch receipt for native Claude, the native review artifact, and settled findings. The extractor records which proof it verified. Older exports without this proof are provisional. Finding locations are resolved relative to the captured workspace. Keep blind draft cases out of the tuning context and review staged development artifacts for sensitive material before publishing.
