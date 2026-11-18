# CI audit evidence v1

Read-only shared handoff: `/Users/huntharo/.codex/worktrees/mwmjp6ou/PwrAgnt/.local/ci-audit/`.
Source baseline: `fcef4ee4c933c52d79c7ac23785bdcf6bbbf78a0`.

`manifest.json` is frozen on first collection: latest 200 unique runs of CI
workflow 261997450 (`.github/workflows/ci.yml`), ordered created_at/id descending,
all events/branches/conclusions. `runs/<runId>.json` contains original attempt 1
`run`, latest selection metadata `latest`, original `jobs`, and all run-level
`artifacts`. Run-level artifacts do not guarantee original-attempt provenance;
created_at and embedded attempt identifiers must be checked before attribution.
No timings means unknown, never zero. Recovered retries remain initial failures.

`jobs.jsonl` / `steps.jsonl`: runId, attempt, headSha, event, branch, jobId,
job, labels, runnerName, runnerImageVersion (null unless evidenced), conclusion,
durationS (nullable), queueAndDependencyS (nullable; includes dependency waits,
NOT pure scheduler queue). Steps add step and phase. Setup/build/test-command/
retry/report-check are distinct; test command includes startup and hooks.

`artifact-manifest.json`: runId, artifactId, name, sizeBytes, expired, createdAt,
state (downloaded/expired/budget-excluded/not-timing-artifact/unavailable), sha256,
members [{member,path,sha256}]. ZIP SHA is exact; member SHA is original bytes;
normalized evidence JSON has separate hashes in hashes.json. Only bounded JSON
members are materialized; HTML embedded reports may need separate parsing.
`summary.json`: coverage and observational job-label groups; n/total/p50/p90/
p95/max/IQR/MAD/CV. Different source revisions remain identifiable, labels do
not establish identical runner images. No unmatched speedup inference.

Classification candidate IDs: `UNIT:<repo-relative-path>:<line>` or
`E2E:<repo-relative-path>:<line>` at the stated source revision. Each candidate
must record source hash, assertion/fixture/mock features, protected behavior,
source-derived oracle/security/conformance obligations, surviving test ID and
exact subsumption evidence, timing provenance/coverage, uncertainty and decision.
No deletion from name/runtime/model opinion alone. Cross-track proposals exchange
compact candidate IDs and protected behavior, not source dumps. Each child owns
its isolated branch/report and discovers decision tools independently.

Reproduce: `python3 scripts/ci/audit-runs.py collect`, then `artifacts`, then
`summarize`. Existing manifest/cache is reused; use a fresh --root for a new
sample. Four metadata workers; bounded transport-only retries; 128 MiB per ZIP,
2 GiB total default. Budget exclusion is explicit. No CI mutation/rerun, registry,
release or credential reads. Cache and raw evidence stay ignored under .local.
