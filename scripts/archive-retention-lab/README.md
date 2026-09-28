# Archived-thread retention lab

This is a diagnostic prototype, **not production cleanup**. See the
[recommendation](../../docs/design/archived-thread-retention.md) and
[aggregate evidence](../../docs/design/archived-thread-retention-measurements.json).
Run from this checkout's repository root using its installed dependencies.
It understands PwrAgent schema 63/64. No application is started or stopped.

The live default PwrAgent database is used only by `snapshot.py`, which opens
`~/.pwragent/profiles/default/state/state.db` in SQLite `mode=ro` and invokes
online backup. It does not use `StateDb.open` on the live file and does not set
source pragmas. Never substitute `cp state.db` for that step on a live profile.
No script opens Codex-owned files. `discover.py` uses the installed Codex App
Server's read APIs in the selected CLI environment; verify that it is the intended
provider/account scope before interpreting eligibility.

Database copies, IDs and intermediate logs must remain private and ignored.
The source scripts contain no operator data. A fresh run needs a new private
directory; snapshot/preparation/rebuild/startup diagnostics refuse to overwrite
their primary outputs. Avoid running two commands that use `run.db` concurrently.
Do not run the matrix, extras, repeats or one-off scenarios concurrently with
each other. Do not point these scripts at a production directory or replace
their paths with symlinks to live files.

## Reproduce

The measured run used `.local/archive-retention`, which is already ignored.
For a new run, use a new `.local` directory in the first seven commands. The
optional startup test and aggregate exporter currently use the original directory
explicitly; adjust those diagnostic paths if replaying into a new directory.
Keep all outputs private until the aggregate export has been inspected.

```sh
python3 scripts/archive-retention-lab/snapshot.py .local/archive-retention
python3 scripts/archive-retention-lab/discover.py .local/archive-retention
node scripts/archive-retention-lab/lab.mjs .local/archive-retention prepare
node scripts/archive-retention-lab/lab.mjs .local/archive-retention matrix
node scripts/archive-retention-lab/lab.mjs .local/archive-retention extras
node scripts/archive-retention-lab/lab.mjs .local/archive-retention repeats
node scripts/archive-retention-lab/lab.mjs .local/archive-retention recovery
node scripts/archive-retention-lab/lab.mjs .local/archive-retention sliced
node scripts/archive-retention-lab/rebuild.mjs .local/archive-retention
```

Additional measured cases:

```sh
node scripts/archive-retention-lab/lab.mjs .local/archive-retention one '{"mode":"owner-history","batch":10,"order":"table","yieldMs":0,"reclaim":true}'
node scripts/archive-retention-lab/lab.mjs .local/archive-retention one '{"mode":"owner-history","batch":10,"order":"table","yieldMs":5,"indexed":true,"pinnedReader":true}'
node scripts/archive-retention-lab/lab.mjs .local/archive-retention one '{"mode":"tool-detail","batch":10,"order":"table","yieldMs":5,"indexed":true,"reclaim":true}'
```

The run modes are intentionally different policies:

| Mode | Removes from positively archived, matching-overlay cohort |
|---|---|
| `cache` | Search documents and FTS rows only |
| `retain-overlay` | Search plus broad owned accounting/tool/provenance/Token Miser history; keeps overlays |
| `owner-history` | Previous mode plus overlays; projection delete trigger runs |
| `tool-detail` | Tool invocations/alerts/analysis and Token Miser objects/observations only; preserves search, overlays and all accounting |

None removes shared incoming references, external worktrees, provider transcripts
or Token Miser output files. None authorizes a production purge. The rebuild
uses the same `tool-detail` selection but recreates a compact retained database.
It validates complete retained row/rowid digests for every table, rather than
equating matching row counts with matching content. SQLite primary/unique
indexes are maintained during copy; explicit index construction is timed separately.

`matrix` runs all 1/5/10/20 sizes × thread-major/table-major/overlay-rowid order ×
0/5 ms yield. `extras` adds indexed predicates, concurrent readers/writers,
secure-delete/cache-size sensitivity, and retention variants. `repeats` repeats
the preferred indexed 5/10/20-thread cases twice more. `recovery` SIGKILLs only its
own subprocesses on a disposable `recovery.db`, before/after commit. `sliced`
limits deletes to 128 rows per table transaction for the largest candidate.

All deletion connections disable autocheckpoint for complete WAL-frame evidence.
Keep that distinction when interpreting disk growth. Base trial timings exclude
copy preparation, provider discovery and integrity validation; these costs are
reported separately. Concurrent WAL includes probe writes. Progress bookkeeping
is included in sliced/recovery trials, but not in the broad matrix. Row counts
and commit counts alone are never converted into WAL estimates.

## Verification and safe export

```sh
node --test scripts/archive-retention-lab/lab.check.mjs
pnpm exec vitest run --config scripts/archive-retention-lab/startup.config.mjs
python3 scripts/archive-retention-lab/report.py
```

The node tests use fully synthetic temporary databases and checked-in page/commit
budgets. The opt-in Vitest diagnostic opens fresh **copies** through the actual
`StateDb` implementation, tests current startup and simulated legacy auto-vacuum
conversion, and isolates `PWRAGENT_HOME` under `.local`. It runs in a fork process
because the native binding requires that ownership boundary. It does not change
the normal workspace test configuration.

The exporter has an explicit result-field allowlist. It exports table names,
column names, counts, page allocations and measurements, never `candidates.json`,
`provider-evidence.json`, DB files, payloads, titles, paths or identities. Inspect
the export before publishing. All unexported intermediate files remain operator
data even if their filenames sound diagnostic.

Experimental limitations: only one machine/profile; no synthetic power-loss,
disk-full or all-application semantic closure proof; no production owner fence,
mixed-version gate, UI, provider restore barrier, cutover or rollback utility.
The report specifies those as implementation requirements, not completed features.
