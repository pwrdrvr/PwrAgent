# Bounded-navigation operator acceptance

PR [#2001](https://github.com/pwrdrvr/PwrAgent/pull/2001) has failed live operator
acceptance and is not ready for merge. The reported failures include cross-owner
child visibility, unstable directory/pin pages, query pressure, and oversized
selected detail. Repairs are under validation; passing fixtures alone does not
close these failures. The earlier live
host evidence below was collected at `e71397043`. GitHub CI completion and
explicit operator merge approval are separate gates. The PR
remains a draft and must not be merged automatically.

The live-failure repairs through `fcbcb2c71` pass the full unit suite (755 files,
10,853 tests, 7 skipped), desktop typecheck, targeted ESLint, and 15 affected
Electron E2E cases. The E2E cases include opening a thread and enabling Send with
738 historical sub-agent records exceeding 1 MiB. These are contrived-data
checks; comparison with the operator's existing M4/M5 Federation remains open.

The subsequent refresh/reconnect repairs at `fffdfb3ca` pass the full unit suite:
755 files, 10,856 tests, 7 skipped (131.60 seconds), plus desktop typecheck and
targeted ESLint. Loaded lists no longer insert loading paragraphs during
background refresh; canonical invalidation replaces pending exact results
within the original deadline instead of rejecting consumer demand. Disconnected
peers are distinguished from connected peers requiring an upgrade.
All 15 affected Electron E2E cases also pass at this checkpoint, covering
accessibility in both themes, thread-row lifecycle, shell readiness, and the
oversized selected-history composer regression.

Live Computer Use on the M4 confirmed the restored project pin order, local
child beneath its M5 parent, rendered transcript, and enabled Send with an
unsent probe that was cleared. Stability after reloading the newest fixes and
the composition of the observed 5.18 MB `backend.readThread` response remain
unverified. Size-only large-frame diagnostics are now available for that check.

## Star Map image-transfer repair

After both branch instances restarted, the operator measured an 8.27 MB Star Map
open. Size-only owner logs identify two concurrent `backend.readThread` replies
for the same card, each 3,450,478 bytes before transport encoding. Each carried
2,915,334 bytes of inline image URLs across message and activity copies. These
were transcript replies, not full navigation snapshots. This measurement does
not retrospectively classify the earlier 5.18 MB frame.

Signed repairs `450a6de8c`, `8708dad12` and `ce0ea97fc` materialize supported
inline transcript images into owner-scoped image references before Federation
serialization, include activity-detail images in that transformation, coalesce
identical concurrent remote reads, and defer lazy image sources until viewport
intersection. Image content remains available through the existing independent
image endpoint. No transcript content is truncated.

All 251 focused tests, desktop typecheck and targeted ESLint pass. Electron
regressions pass for large Star Map history, intrinsic image sizing, and a new
scroll case that verifies an offscreen image has no source or decoded pixels
until it enters the viewport. Live transfer volume and sidebar stability still
require comparison on the restarted M4/M5 instances with these fixes.

## Navigation CPU investigation

The operator supplied a main-process capture from the M5 branch instance:
`hot-cpu-2026-09-07-2109-649f05/main-hot-0002.cpuprofile`. Its trigger at
2026-09-08T01:16:44.644Z measured 72.62% CPU over 2.001 seconds. Weighted samples
attribute 1,144.9 ms inclusive to `buildLocalNavigationQueryIndex` /
`readNavigationQueryIndex`, including 773.1 ms in
`listManagedSubAgentThreadKeys` and 167.0 ms in `getBackend`. The 75.163-second
retained recording includes 73.354 seconds idle. The first navigation cluster
falls within the trigger interval.

This identifies a stall, not a proven regression: main already invokes the
managed-subagent helper and backend materialization from snapshot reconciliation.
The reported Python probe of the first helper query returned approximately
15.18 MB on main versus 447 KB with the branch projection. It excludes the
second query and normalization and is not a same-runtime end-to-end benchmark.
The inherited scan cost is assigned to a separate child based on current main;
[CPU PR coordination](https://github.com/pwrdrvr/PwrAgent/pull/2030#issuecomment-5577694164)
distinguishes it from Git/SSH deduplication and directory-enrichment diagnostics.

Code inspection on #2001 confirms cursor continuations reuse retained backing,
but a root-page refresh rebuilds the source index before comparing revisions.
Only concurrent builds share source work, with limits of eight physical builds
and 256 readers. The sidebar's fallback refresh is five minutes and foreground /
activity gated; events and explicit demand also initiate reads. These facts do
not establish which caller initiated the captured clusters.

A deterministic source test exposed one amplification path: transcript-only
events invalidated pending source sharing, starting two builds for unchanged
navigation. The source now uses the existing canonical navigation event filter;
text and token deltas preserve sharing, while title/status/membership changes
still require fresh work. The test failed before the repair. All 64 affected
source, admission, query and SQLite-budget tests pass afterwards, as do desktop
typecheck and targeted ESLint. Read-only query budgets remain zero commits and
0 MB/day additional WAL. No completed-index cache or new persistence was added.
Live CPU improvement remains to be measured.

The inherited helper repair from PR #2032 is integrated in signed `72f696a83`
and `720ecffd0`, preserving #2001's narrower subagent-field projection. Its
same-runtime synthetic comparison against `3c9c61281` measures 65.616 to
55.011 ms median for invalidated reads and 0.0049 ms for unchanged reads.
Identical backend normalization drops from 1.660 to 0.0784 ms. The 72 combined
source/query/helper regressions, desktop typecheck and targeted ESLint pass,
including shared-profile process writes, between-query commits, rollback and
zero-write budgets. Another 17 partial-navigation, handoff-repair and pin tests
pass (89 affected tests total). See the [measurement and limits](design/managed-subagent-navigation-reads.md).

## Upgrade requirement

Run the cutover build on every viewer, owner and gateway participating in the
acceptance Federation. Navigation requires protocol 2 on the complete route.
Old snapshot/list readers and single-frame peer directories receive an upgrade
error; there is no full-collection compatibility fallback. This is a coordinated
upgrade, not a mixed-alpha compatibility test.

The isolated host `dev` and `work` profiles were tested together. The default
profile and its messaging lease were left untouched. The test apps were closed
cleanly afterwards; no live messages or turns were submitted.

## Automated evidence

| Check | Result |
| --- | --- |
| Full workspace unit suite | 754 files; 10,803 passed, 7 skipped |
| Workspace typecheck and full ESLint | Passed |
| Dependency boundaries | Passed; 1,868 modules / 6,470 dependencies |
| SQL, Codex-storage, colors, licenses, Electron-version checks | Passed |
| Electron E2E | Initial 13-case remote/window/history set passed; after CI repairs, all 52 affected functional cases passed |
| Named completion regressions after documentation alignment | 67 passed across the three renamed-test suites |
| Read-only navigation SQLite budget | Zero commits; 0 MB/day additional WAL |

The protocol and regression map are in
[federation-navigation-v2.md](federation-navigation-v2.md) and the
[collection budget report](federation-collection-budgets.md). The allocation
report includes a separate 10,000-thread probe: largest response/serialization
53,199 bytes, sampled peak heap growth 28,423,584 bytes. This is an isolated
measurement, not a bound on all Electron heap allocations.

## Final live host checks

- `dev` gateway and `work` owner connected with `navigationQueryProtocol: 2`.
- Remote Attention returned ten rows / 25,142 bytes with an explicit cursor.
  An unchanged retained-range refresh returned zero rows / 681 bytes. The next
  page returned ten rows without duplicate identities.
- Main and native remote windows showed no alerts. Star Map displayed 19 cards
  in Instances and 13 in Projects, with explicit continuation controls.
- Visible search returned 25 results, including four remote title matches.
- Disabling `work` retained all 13 displayed project cards. Re-enabling it
  restored protocol-2 connectivity, with no Star Map or remote-window alerts.
- Earlier live checks in this PR verified Attention focus preserves unread
  review counts and explicit Load more reveals additional owner membership.

Screenshots containing real thread titles remain local and are not attached to
the PR. Native Computer Use could not start its pipe; Node REPL drove the visible
Electron windows through Playwright instead.

## Operator checklist

1. Start the cutover build on all participating machines and gateways. Confirm
   each expected peer connects; an upgrade error identifies an old participant.
2. Browse Attention, Inbox, Recents and Directories. Expand a large directory and
   load more. Verify counts, selected thread and back/forward history survive
   paging and lens changes. Attention focus should preserve unread; an accepted
   reply should clear it.
3. Open a remote native window and Star Map. Try Instances and Projects, load
   more, open a chat card, and search for a known remote thread. Check restored
   cards and geometry after reconnecting a peer.
4. Using a disposable thread, verify an unsent draft survives a restart and stays
   local. Queue a reply, navigate away from its row, and confirm accepted FIFO
   release works without requiring that row to stay loaded.
5. Try directory read actions and relative pin moves in a directory with unloaded
   rows. Verify unrelated pins stay in place and owner permission errors are clear.
6. Report any acceptance failures on this thread. Once acceptance and CI pass,
   explicitly approve the merge. Passing this checklist alone does not merge it.

Selected history retains its existing provider cursor and large-entry behavior.
The cutover bounds navigation membership and separates history demand; it does
not silently discard large transcript content to meet navigation byte budgets.

## CI follow-up on 2026-09-07

The watch for `d10139adb` failed on functional and visual E2E assertions, not on
node_modules cache restoration. Signed repairs through `0d837ec07` bind initial
selection to accepted primary rows, restore the unlinked breadcrumb, refresh
exact detail after owner-wide invalidation, and refit autocomplete before paint
and after composer resize. Replay fixtures now wait for their required initial
selection/transcript and expose created rows only after creation. Visual fixtures
pin both sides of IPC to the same clock so absolute deadlines remain valid.

The full suite after these repairs passed 10,803 tests in 754 files (7 skipped).
Typecheck, full ESLint and dependency boundaries passed. All 52 affected
functional E2E cases passed, including the queued-review cases that previously
left Send disabled. Existing visual goldens were not changed: local
host comparisons still show width differences consistent with scrollbar geometry; their authoritative
result must come from the macOS CI lane. Do not treat local functional success as
completed CI or merge approval.
