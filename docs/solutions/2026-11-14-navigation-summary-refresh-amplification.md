# Navigation summary refresh amplification

## Evidence

Investigated `origin/main` at `208b845a5` using the packaged PwrAgent 1.4.2
renderer CPU recording triggered at `2026-11-14T04:45:08.130Z`. The recording
lasts 63.239 seconds, with 48.248 seconds before the trigger. The interval of
interest is 46.248–48.248 seconds. No live application or profile was changed.

The release debug manifest identifies commit
`1e35ae6fcbcc132c093e8bc1ea236d5e69d12304`. Before resolving frames, the two
release JavaScript files were compared byte for byte with the installed ASAR:

| Bundle | Bytes | SHA-256 |
| --- | ---: | --- |
| `index-TBC2-FR7.js` | 1,171,037 | `3cfdc5712ce950ca682695969884ea0a2dfa533e25880db38cf49d0ac8743b47` |
| `useViewportTooltip-C3oi5ZVi.js` | 12,898 | `7aa0af19f6b576cb99655b40a5396403c160a64ae0300db3b77e05aa94d14264` |

The matching source maps resolve `CI` to `DesktopAppShell`, `SS` to
`useThreadNavigation`, and `id` to `DirectoriesList`. Approximately 813 ms of
the two-second interval includes React work; the shell accounts for about
221 ms, including about 133 ms in the navigation hook. Inclusive values
overlap. Native/program samples, GC and tooltip work also occur. This
recording does not account for all OS process CPU.

The adjacent diagnostics contain 166 renderer dispatches and 7 renderer
invalidations in that wall-clock window. All dispatches use one view/effect;
160 are attempt 1 and 6 are attempt 2. Main records 168 IPC starts, 157 index
cache hits, 5 index builds using cached registry data, and no provider RPC
starts. Repeated requests still cost publication and React work when their
source data is cached. Process and window boundaries can produce different
counts.

## Mechanism and correction

The earlier complete-child membership and incoming-page sizing fixes are
already present. Two other notifications lack a usable negative dependency:

- A successful background mounted-summary refresh publishes an instance-only
  `navigation/remoteThreadPins/changed`, even when one known row's metadata
  changed. A complete unrelated child page cannot identify that row.
- A PR status notification has a PR key rather than a thread ID. The child
  guard treats it as a possible membership change and refreshes every page.

Summary publication now optionally includes the changed row identities when
the full published populations have the same members and placement. Comparison
uses the last **published** rows, preserving changes committed before a
superseded archive check. Identity includes backend and the actual owner,
including children mounted from a third instance. Only known metadata fields
may differ; other and future fields withdraw the proof. Initial publication,
archive proofs, availability transitions and membership changes retain broad
notifications. More than 100 identities or 16 KiB also uses the broad path,
without reducing expanded pin capacity.

Complete child collections can exclude unrelated summary identities and PR
keys. Partial pages, incomplete coverage, nonzero retained ranges and pending
membership observations remain conservative. PR attachment changes withdraw
the PR-key exclusion until a current read is accepted, so a status update
cannot race an observation that first discovers its attachment. Directory and
selection dependencies retain their established refresh semantics.

The federation delivery test also demonstrates two distinct representations
of one owner status event: `navigation/invalidated` and the full detail event.
Both preserve its identity and reach the summary cache when the viewer wants
navigation and detail. Production diagnostics omit those identities, so their
paired records alone cannot establish duplicate payloads. No delivery-path
deduplication is introduced.

## Operation budgets

The mounted-sidebar fixture delivers each physical response in a separate
React task. All data is invented. Each row below applies independently to one
unrelated summary notification and one unrelated PR notification.

| Expanded mounted roots | Reads before → after | Child reads | Publications | React commits | Row renders |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 8 → 4 | 4 → 0 | 17 → 9 | 18 → 10 | 0 → 0 |
| 16 | 21 → 5 | 16 → 0 | 41 → 9 | 42 → 10 | 0 → 0 |
| 48 | 53 → 5 | 48 → 0 | 105 → 9 | 106 → 10 | 0 → 0 |

The larger fixtures retain expanded pinned ranges across refresh, including
the necessary continuation read. A controller-only fixture with 96 local and
mounted child resources changes from 96 reads / 193 publications to zero for
one unrelated summary notification. These are deterministic operation counts,
not an estimate of total CPU saved in the packaged application.

The new owner-publication property and renderer property failed on the
pre-fix implementation. The mounted render budgets also failed with the
original `navigation-window-queries.ts`, then passed after restoring the fix.
Properties compare accepted pages to the complete viewer population across
backend/owner collisions, attachment races and membership fences. Publication
tests cross the identity limit and retain all owner rows. Existing cancellation,
cursor/anchor, directory-scope and expanded-pin tests cover their original
contracts. The change introduces no SQLite writes (0 MB/day additional WAL).

Targeted verification uses `pnpm test` with these filters:

```text
remote-summary-publication.property.test.ts
remote-thread-summary-cache
federation-runtime.test.ts
navigation-summary-refresh.property.test.ts
navigation-refresh-render-budget.test.tsx
navigation-refresh-fanout.property.test.ts
navigation-window-queries
navigation-directory-scope.property.test.ts
pinned-navigation-retention.test.tsx
```

Correctness lint, typed lint and typecheck run locally. Sandboxer is dormant.
