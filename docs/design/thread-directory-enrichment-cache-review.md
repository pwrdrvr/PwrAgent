# Thread directory enrichment: ownership and invalidation review

## Incident and scope

The September 6, 2026 main-process CPU session `65f58b`, captured at
08:35–08:40 America/Detroit, contains two distinct sources of work:

- Token Miser metadata/observation reads and buffer allocation. PR #2000 and
  its storage follow-up own those changes.
- `loadThreadDirectoryEnrichment` → `runGit` → `execFile` → native `spawn`.
  The captured bundle's `Yge` and `fw` frames map to these functions. Native
  spawning alone represents 8.4% of profile 0003 and 7.4% of profile 0005's
  sampled time, including idle. These percentages are not process CPU usage
  or a prediction of total CPU savings. Async stacks do not identify every
  initiating caller, so the profile does not prove which UI or messaging
  operation started each enrichment.

This review and change address directory enrichment. They do not replace the
Git working-state scheduler, Token Miser storage work, or Federation collection
paging in #2001. No live application restart or post-fix live CPU claim is made.

## What the earlier changes fixed

| Change | Owner and behavior | Why directory probes remained |
|---|---|---|
| [#1895](https://github.com/pwrdrvr/PwrAgent/pull/1895) | Discord receipt/admission runs before REST metadata enrichment; stage timings identify delays | Provider ingress does not own local Git enrichment |
| [#1914](https://github.com/pwrdrvr/PwrAgent/pull/1914) | Ordinary messaging navigation serves cached Git working state and schedules background convergence; review selection can still opt into awaited working state | Working-state hydration is distinct from Codex directory enrichment |
| [#1916](https://github.com/pwrdrvr/PwrAgent/pull/1916) | `ThreadInfoStore` retains known summaries and fields across query invalidation; point reads and messaging admission reuse them | Whole provider listings still run their own enrichment before recording summaries in the store |
| [#1921](https://github.com/pwrdrvr/PwrAgent/pull/1921) | Lifecycle-owned Full Access policy snapshot removes per-reply settings/config reload | Authorization policy does not own directory mappings |
| [#1922](https://github.com/pwrdrvr/PwrAgent/pull/1922) | Response-mode snapshot and off-path metadata updates remove admission waits; Codex default-agent admission avoids fleet capability listing | Does not change the enricher or its cache |
| [#1951](https://github.com/pwrdrvr/PwrAgent/pull/1951) | Registry owns bounded Git working-state rounds; base inference drops from 105 to 10 commands; absolute Git executable cached | The separate directory enricher still starts its three commands whenever its five-second cache expires |

The fixes are complementary. Moving work off an admission path and retaining
thread summaries did not give the lower directory-discovery layer the same
invalidation contract. Increasing the existing TTL would leave that mismatch.

## Stores and the gap between them

| Store | Identity / lifetime | What it answers |
|---|---|---|
| Registry `threadListCache` | Query shape / short reuse window; invalidated by mutations | Membership, ordering and bounded provider-list reuse |
| `ThreadInfoStore` | Instance + backend + thread / process lifetime | Last-known names, archival observations and summary rows; separate enriched summary slot survives cheap navigation polls |
| Overlay store | Backend + thread / SQLite | Operator workspace links, handoff authority and repaired source worktree links; `replaceWorkspaceLinkedDirectory` also invalidates obsolete retained summaries |
| `ProviderThreadSnapshotStore` | Backend / persisted startup snapshot | Initial navigation before provider refresh; persistence runs at the explicit startup-provider-refresh boundary, not every thread read |
| Directory enricher (before) | Trimmed project path / five seconds | Repository mapping **and** current branch in a single expiring object |
| Git working-state and directory-status caches | Workspace / dedicated freshness and scheduling policies | Dirty/untracked/unpushed state, review base and branch/status chips |

`readThreadList` calls `listCodexThreads`, which calls the Codex client with the
requested enrichment flag. The client enriches rows before the registry's
`rememberThreadListContexts` records them. No `ThreadInfoStore` lookup can
prevent work that has already happened inside that client call. Reusing the
entire retained row would also risk masking current provider membership,
titles, execution state and workspace changes.

Unenriched navigation has another route: source relationship reconciliation
and `backfillMissingCodexDirectoryRelationships` can enrich previously unknown
managed worktrees. Persisted overlay links avoid that backfill after successful
repair. Explicit enriched listings and selected-thread repair do not use that
overlay as the lower-level directory-discovery cache. A partial fallback is
also not proof that a directory was successfully resolved.

## Callers and required freshness

| Caller/path | Needs topology? | Needs live Git state? | Resolution |
|---|---|---|---|
| Known thread label, quit blockers, warm admission | No fresh topology | No | Existing `ThreadInfoStore` point read; zero new provider/Git reads |
| Terminal notification for a never-observed thread | No; title/project label suffice | No | Keep the existing coalesced cold provider lookup; change its explicit enrichment flag to false |
| Ordinary renderer/messaging navigation, prewarm | Missing source relationships only | Chips converge through separate owners | Existing cheap listing plus scoped backfill; confirmed topology no longer expires |
| Selected-thread directory repair | Yes, for that thread's current provider cwd | Current branch is returned with enrichment | Validate only that directory; reuse confirmed mapping |
| Explicit enriched listings, thread inspection/search, migration | Yes | Existing contract includes observed branch | Validate each distinct directory once per listing; cache topology across listings; refresh branch when HEAD changes |
| Workspace handoff / actions | Current workspace identity | Operations can need current branch | Preserve provider-fresh versus last-known distinction and existing action-specific branch probes |
| Review workspace/base selection | Yes, plus dirty/base state | Yes | Preserve explicit working-state opt-in and #1951 scheduling; no replacement with cached topology |

The default enrichment flag remains compatible. This change removes the known
label-only opt-in, not every enrichment caller. `observedGitBranch` participates
in shared navigation reconciliation and review branch choices, so retaining it
forever with an immutable directory mapping would be incorrect.

## New ownership and invalidation contract

The Codex client owns one directory-enricher instance. Its confirmed mapping
cache lasts for that client instance, independent of elapsed time or thread
query invalidation. It is not another SQLite store. Existing persisted
workspace links retain their authority; cold discovery after process restart
is still permitted.

`createGitDirectoryObserver` validates filesystem evidence on demand:

- The requested directory exists, is a directory, and has the same physical
  identity and resolved path. A missing path is unresolved, not an instruction
  to archive a thread.
- The nearest `.git` boundary is still the same. Walking the physical path
  returned by `realpath` detects a newly initialized nested repository and a
  repository containing a symlink target, without a timer or watcher.
- A `.git` pointer, worktree admin directory, `commondir`, common directory,
  repository/worktree config or worktree backlink change invalidates the mapping.
- Directory identity uses device, inode and birth time. Directory modification
  time is deliberately excluded: ordinary source edits, commits and sibling
  worktree creation do not change this workspace's repository relationship.
- File identity includes device, inode, birth time, size, mtime and ctime.
  Pointer contents are memoized by this signature; unchanged `.git` and
  `commondir` files are not reread.
- HEAD has a separate signature. A HEAD change with stable topology runs only
  `git rev-parse --abbrev-ref HEAD`. Git retains responsibility for branch and
  detached-HEAD interpretation; this code does not parse branch names.
- For [Git reftable storage](https://git-scm.com/docs/reftable), HEAD is a static
  compatibility file. The branch signature also includes the worktree and
  common `reftable/tables.list` file identities. Stack updates and compaction
  can therefore trigger a conservative one-command branch refresh, including
  when a ref other than HEAD changed; they do not rediscover topology. No
  reftable contents are read or parsed.
- An unversioned directory requires no Git subprocess. Its next observation
  still searches for a new `.git` boundary, so `git init` is visible immediately.

Cold successful repository discovery retains the existing three-command Git
implementation and its fallback semantics. Failures, incomplete observations,
missing directories and partial Git results are not memoized as successful
discoveries. Evidence is checked before and after a probe; a change while it is
in flight prevents that result from becoming the next cache answer. The next
lookup retries rather than publishing an obsolete generation indefinitely.

The pending map covers **validation as well as Git**. Normalized absolute path
aliases share the same in-flight operation. The client's listing-local promise
map extends sharing across mapper batches, including failed resolutions. It is
discarded after that listing, so a later listing revalidates external changes.

This deliberately uses on-demand filesystem validation rather than a TTL,
native watchers for every historical workspace, or a persistent cache whose
validity would have to be reconstructed after downtime. External tools can
change workspaces without emitting PwrAgent events. Filesystem metadata checks
remain proportional to distinct requested directories and ancestor depth;
provider pagination and live Git working-state probes are unchanged.

## Budgets and regression evidence

Checked-in counts live in `__tests__/fixtures/git-subprocess-budgets.json`.

| Scenario | Before | After |
|---|---:|---:|
| 20 enriched reads of one confirmed directory, each beyond the old TTL | 60 Git commands | 0 Git commands |
| 100 rows sharing two directories, one listing | 100 enricher calls | 2 validations |
| External branch checkout, topology unchanged | stale branch inside TTL; 3 commands after expiry | immediate branch refresh, 1 command |
| Non-Git directory | 3 failing Git commands on discovery | 0 Git commands |

The final red run restored all three original production files while retaining
the new tests: **16 regressions failed and one compatibility test passed**.
Failures included 60 warm Git commands instead of zero, 100 directory
validations instead of two, stale branches and workspace mappings, retained
failures, repeated pointer reads, and the label-only provider call still
requesting enrichment. The fixed files were restored in a `finally` block and
verified byte-for-byte. Red-run logs are retained locally under
`.local/directory-cache-review/`.

The suite also verifies unchanged topology after edits/commits, failed branch
refresh recovery, changes during an in-flight probe, and real Git worktree,
branch checkout and detached-HEAD behavior using contrived temporary repos.
Existing thread-info, thread-read, client, registry and working-state tests
remain necessary: the lower-level optimization must not weaken provider
freshness, handoff invalidation, review selection or admission.

## Costs and limits

No new SQLite write, commit, timer or persisted index is introduced. Incremental
SQLite write projection is **0 MB/day**. In-memory maps are keyed by observed
directories/pointer paths, not by refresh count; listing-local maps are released
when the listing completes.

This does not claim zero filesystem syscalls or zero Git processes throughout
PwrAgent. Initial valid repository discovery still costs three commands per
distinct directory per client lifetime. Broken repository/permission states
can retry on subsequent explicit observations. Working-state probes keep their
own budget. A post-fix live profile, after the independent Token Miser changes
are deployed, is needed to measure the remaining process CPU rather than infer
it by adding V8 profile percentages.

## Validation of this implementation

- Final focused run: 949 tests passed across the directory-cache, directory
  enricher, Codex client, thread-read budgets, thread-info store, backend
  registry, Git working-state service and provider snapshot store suites.
- Full `pnpm lint` passed: SQL, Codex-storage, colors, Electron policy,
  license gates, ESLint (0 errors, 47 warnings), typecheck and dependency
  boundaries.
- `pnpm build` and the main-bundle boundary check passed.
- `git diff --check` passed.
- One final test attempt exited 139 before reporting results. The native
  report shows V8 weak callbacks during worker isolate teardown; a September 5
  report predating this change has the same stack signature. The unchanged
  normal test command subsequently passed all 944 tests. No worker-pool,
  concurrency, timeout or retry setting was changed to obtain that result.

## Review follow-up: physical discovery and reftable

Three real-Git regressions reproduced both review findings before the fix:
symlink-to-subdirectory discovery, ordinary reftable checkout, and linked
reftable worktree checkout. The reftable tests also check detached HEAD and zero
Git commands on unchanged reads. Two synthetic stack-replacement cases cover
both manifest locations even on older Git versions that cannot initialize
reftable repositories; only an explicit unsupported-init-option error skips
those real-Git reftable cases.

Review validation: 949 tests across eight suites passed, including all five new
cases on Git 2.55.0. The three real-Git cases failed against the prior code.
