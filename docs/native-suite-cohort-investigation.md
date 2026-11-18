# Native macOS suite deadline investigation

This records the disposition of the native macOS failure cohort investigated
through PR #3876. Historical failed results remain preserved. An outer deadline
without a seed or causal trace does not identify which invariant failed, and a
later isolated or full-suite pass does not establish host contention as its cause.

## Evidence retained

| Run | Recorded outcome | Immutable full-log SHA-256 |
| --- | --- | --- |
| `a2a1ef72e` | 33 failed tests in 25 files; 34 blocks including a suite block, 29 deadlines; 29,092 passed, 107 skipped; 391.83 s | `7217ba16b2673a3a954b179a8085ecf27a329e6ef5c78b0683960868eb7d3a8c` |
| `c2cff476d`, request-budget validation | 20 failures in eight files; 29,143 passed, 107 skipped; 417.95 s | `de8e2e33357b003cfdb4f3139ed70e3eeff4f34585103f5f91ec4978c7ac20da` |
| `1025a96c3`, inbound-turn extraction | Five deadlines; 29,274 passed, 107 skipped; 387.66 s | `8bdff29bf3d8c619545dd8ba9d392db4e269e25e1c5afb5676a0cdf9fe268759` |
| `f1566ee45`, headless follow-up | Three renderer deadlines; 29,258 passed, 107 skipped; 315.45 s | Retained with the parsed failures in `headless-followup/` |
| `7b07f1bf5`, selection-owner fix | 29,421 passed, 108 skipped; 274.42 s | `0fa99284348896a696aca8b5df7acb8e47c132ac703ba2b7adceb5446322c4f6` |

Local evidence lives under `.local/native-suite-cohort/`: `investigation.json`,
`headless-followup/`, `bounded-work/`, `selection-lifetime/`, and `completion/`.
The original source logs remain at their recorded locations; copies and hashes
are retained. The per-file disposition and source hashes are
`completion/dispositions.json`. These ignored artifacts include controlled
pre-fix failures and successful fixed comparisons; no failed result is replaced
by a successful rerun.

## Rules corrected independently of the initiating deadlines

- Recovery and fake-clock properties must retire before shared spies/clocks
  reset (#3853). Controlled overlap reproduced the exact recovery assertion and
  `[1000,7000,13000]` snapshot schedule.
- A liveness oracle must respect the first terminal reason and observe the
  actual socket disconnect (#3850).
- Blob abort/drop handoff must join the receiver generation that owns the
  transfer (#3856); the retained minimal case is the first dropped chunk/fence 0.
- Process fixtures must close admission on abort/stop and every close caller
  must join native process and pipe retirement (#3863).
- Mounted catalog/selection models must stop admission and UI actions after
  abort, keep roots scoped to the case, and join assertions before DOM cleanup
  (#3873/#3876).
- Ledger models must reject new cases before opening SQLite after abort or
  retirement. Every asynchronous test must settle before global spies and
  environment values reset (#3876). The whole-ledger differential oracle still
  runs its original 25 cases across 12–38 rows and the original repair barriers.
  Four controlled real-SQLite oracles cover clock ownership, abort admission,
  explicit retirement admission, and rejection before opening a database.

Earlier IPC/ledger readiness (#3838), attachment ownership (#3844), controller
ownership (#3820/#3854), and updater ownership (#3829/#3852) are retained. Their
changes are not duplicated here. The nine controller failures in the request-
budget run have an independent explanation in #3820. Its other eleven deadlines
still have no demonstrated initiating cause.

## Remaining observations

Every file below is included in the recorded cohort comparison. For files with
an independently proven fix, the initiating deadline remains unattributed unless
the rule above explicitly reproduces its assertion. No edit is justified solely
by an elapsed deadline. The exact historical OS `EPIPE`, grouped idle-write
failure, and renderer deadlines remain preserved; no SQLite-budget overflow has
been demonstrated.

| File | Disposition |
| --- | --- |
| `archive-cleanup-terminal.property.test.ts` | #3853 joins the timed-out property before recovery spies reset; exact later assertion reproduced. |
| `auto-updater.property.test.ts` | #3829 owns generated held-installer work; no new staging counterexample. |
| `auto-updater.request-budget.property.test.ts` | #3852 owns request-budget fixtures; keep its independent changes intact. |
| `backend-registry-wiring.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `checkout-directory-owners.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `checkout-hibernation.test.ts` | Historical deadlines remain unattributed. A [later multi-wave batch follow-up](checkout-hibernation-fixture-ownership.md) independently proves whole-test retirement and admission gaps. |
| `composer-bytecode.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `federation-resumable-blob.property.test.ts` | #3856 joins aborted/dropped receiver generations; exact dropped-chunk regression retained. |
| `federation-small-blob.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `federation-transport.test.ts` | #3850 corrects terminal-reason ownership and waits for native disconnect. |
| `headless-concurrency.oracle.test.ts` | #3863 gates process admission and joins native process/pipe retirement. |
| `headless-idle-write-budget.oracle.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `heap-monitor-cooldown.property.test.ts` | #3853 joins property/fake-clock work; exact later snapshot schedule reproduced. |
| `managed-git-verify.oracle.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `messaging-controller.test.ts` | #3820 covers nine failures; #3854 covers generated model lifetime. |
| `messaging-private-response-history.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `outpost-stdio-queue.oracle.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `overlay-store-list-reads.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `overlay-store-managed-subagent-scan.test.ts` | Real 1,000-parent read/write/parse invariants retained. Cold fixture seeding dominated checking; no independent deadline cause demonstrated. |
| `owner-conformance.test.ts` | Real desktop/Outpost owners close in test finally blocks; no independent cause demonstrated for the three historical deadlines. |
| `pr-auto-dispatch-limits.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `production-entry-host.oracle.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `quit-dialog-default-action.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `retained-owner-listing.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `shared-messaging-storage.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `shared-owner-metadata-storage.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `shared-token-miser-storage.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `thread-search-query-budget.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `thread-search-ranked.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `token-miser-ledger-persistence.property.test.ts` | #3876 follow-up joins async SQLite model work before spy/env reset and guards new-case/database admission. |
| `thread-meta-items.model.test.tsx` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `TodoModelPicker.property.test.tsx` | #3873 joins catalog cases and keeps DOM roots scoped to their owner. |
| `navigation-archive-group.property.test.ts` | Investigated deadline-only observation; no independent current invariant or readiness failure demonstrated. Preserve the historical failure without attributing it to load or isolated success. |
| `navigation-selection-publication.property.test.tsx` | #3876 joins selection histories and guards abort/readiness boundaries. |

## Measurements and interpretation

- The unchanged 1,000-parent fixtures spent 504–538 ms seeding versus 3–16 ms
  reading/checking; listing spent 967 ms seeding versus 58 ms checking. Bounds
  and assertions remain intact.
- The unchanged selection model recorded 38 histories, 257 selection steps and
  1,711 fixture queries. Inclusive totals were render 257 ms, drain 8,456 ms,
  query projection 140 ms and case work 17,679 ms. Instrumentation adds overhead;
  nested phase totals are not additive.
- The unchanged private-history probe recorded 17,012 settlements, 12,007,000
  reference-history visits and 73,167 identity projections. Its 1,000-session
  eviction/cardinality, late-settlement and replay coverage is unchanged.
- The unchanged ledger file passed 24 tests; the repricing property took about
  1,068 ms in that cold isolated measurement. This motivated lifetime probing,
  not an assertion that the historical deadline was caused by that cost.
- Blob's 3,349 scoped API invocations and zero physical fsyncs do not establish
  contention. Deadline seeds `1494783974` and `358152357` passed exact replay;
  the independent abort/drop regression `-2021815784`/path `0` failed pre-fix.
- Headless abort seed `-668954464`/path `0:0:0` shrank to one `startThread`
  after abort and replayed red pre-fix/green fixed. Other deadline reports printed
  no seed. No substitute seed was selected.

The investigation closes with these dispositions and retained evidence. A new
recorded counterexample, observable ownership/readiness violation, or native
process/filesystem trace can justify another causal fix. An isolated pass or
load-average sample cannot. Verification uses the worktree's own frozen
installation, default workers, deadlines and model bounds, the normal native
build hook and repository CI. The documented sandbox-only signing bootstrap is
rerun with the exact command natively; binaries and signature checks are not
changed. Protected recordings and SQLite budgets remain byte-identical to the
base. No local E2E run is claimed by these unit-test results.
