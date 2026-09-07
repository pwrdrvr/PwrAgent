# Bounded-navigation operator acceptance

PR [#2001](https://github.com/pwrdrvr/PwrAgent/pull/2001) is ready for operator
acceptance testing after the CI repair checkpoint `0d837ec07`. The earlier live
host evidence below was collected at `e71397043`. GitHub CI completion and
explicit operator merge approval are separate gates. The PR
remains a draft and must not be merged automatically.

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
