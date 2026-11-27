---
name: pwragent-profile-scaling
description: Replay the matched PwrAgent 1.5.x large-profile performance investigation on a release, baseline or candidate. Use for the anonymous topology, historical work counters, fixed-seed models and native lens-switch control. Use pwragent-scaling-audit for investigating a new scaling mechanism.
---

# Replay the profile scaling audit

Run commands from the harness checkout. Use Node and pnpm from the target checkout's repository guidance, Python 3.9+, and a separate frozen pnpm install in each target. Reserve four local CPU slots following [local CPU checkout](../../../docs/local-cpu-checkout.md). The launcher runs one Vitest worker with the measured revision's native setup and fixtures. Every workload uses synthetic rows or an isolated store.

```sh
python3 scripts/scaling-audit/run.py --suites pricing token-miser --output .local/pricing-miser
python3 scripts/scaling-audit/run.py --suites live-threads --output .local/live-threads
python3 scripts/scaling-audit/run.py --suites terminal reopen --output .local/terminal-reopen
python3 scripts/scaling-audit/run.py --base /path/to/installed-base --output .local/base-head --cases 25
```

The candidate defaults to this checkout including working changes. Use clean pinned checkouts when attributing results to commits. Select another with `--candidate`. Give each run a fresh output directory. The same harness code, family seeds and case counts run on both sides. The runner stages exclusive temporary modules beside repository test helpers and cleans them up on exit. Only its dedicated Vitest configuration discovers those modules.

## Read a comparison

Start with `summary.md`. In `results.json`, match the revision, suite, scenario dimensions and counter name. The comparison exits nonzero for increased deterministic work, missing scenarios or failed oracles. An improvement may trade a full join for targeted reads. Inspect both counters before judging a change. SQLite durations and serialized Pricing bytes are diagnostics. A property failure records its seed, assertion and shrink path in the revision's `work.jsonl`; `vitest.json` records the error. For a new mechanism, use the [scaling audit skill](../pwragent-scaling-audit/SKILL.md) to choose dimensions and reduce a regression to an ordinary low-cost test.

The PR label `ci:scaling-audit` compares the pinned base and head with 25 cases for each of the 37 matched assertions. Both sides run the following probes with one worker.

| Suite | Inputs and measured work |
|---|---|
| Navigation | Cold and expired Attention reads, eight batched then eight separate status updates at 869, 1,738 and 3,476 rows. Nine uniform scenarios vary pins and project concentration and add start/archive. Count provider lists, checkout paths, joined, targeted and projected directory rows. Live-index revisions also count copied array slots and predicate evaluations. |
| SQLite | Twelve status changes at 435, 869 and 1,738 live threads with 2,807 archived overlays. Vary archive pressure independently at 869 live rows with 0 and 5,614 archived. Count full joins, input rows, compact overlay rows and checkout paths. |
| Turn lifecycle and held Auto-fix | Deliver ordinary completion or Stop for 1, 4 and 16 targets with 8–32 unrelated records per category. Count activity and review records visited. Deliver eight terminal or forge events with 0–64 held reviews and count review reads and stack-hold checks. |
| Pricing | Start, meter and complete 64 turns while reading a four-row historical page after every completion. Sample cumulative publication rows/bytes, rows returned by SQL, full-ledger processing and page output at 8, 16, 32 and 64 turns. |
| Token Miser and grouped Pricing | Vary 24/96 historical turns, 8/32 gates and 2/8 visible rows independently and at the joint maximum. Compare empty ACP and Codex controls with stored monitor cards, persisted Token Miser metadata alone and live gates backed by stored records. Count materialized usage, card and metadata rows, running-total folds and published Pricing rows. |
| Federation | Vary 2–8 peers, queue depth 8–32 and 4–16 simultaneous redeliveries. Check admission and receipt identity, count warm label/ID/input accesses, queue copies and committed writes. |
| Transcript | Cross 60–240 entries with 3–24 reviews, reopen 50–400 messages with legacy monitor attribution, and stream eight deltas across 8–64 historical edit turns. Count field reads and replaced edit objects. |
| Live threads | Keep 1, 10 or 20 turns active in one renderer session cache with 8 or 64 prior messages each. Deliver four interleaved tool calls and assistant replies per thread, individually or in React batches. Check expanded output while it streams and reselect every thread to verify its completed transcript. |

The Token Miser suite seeds isolated SQLite stores with generated records. It measures ordinary turns on the seeded thread and an unrelated thread before anyone opens Pricing. Separate cases read one completed turn's accounting, open Pricing, repeat an unchanged owner read, complete a turn, request the page locally and through Federation, redeliver identical gates and change a gate's parent. The metadata-only fixture starts without live gates or stored helper charges. The production owner can backfill charges on the first page read. The reporter compares every work counter separately, so a new targeted read can appear alongside a reduction in full-ledger folds.

The live-thread suite models the renderer from its agent-event subscription through one visible transcript in jsdom. Each round sends nine events with three output chunks and three assistant deltas. A virtual frame per wave keeps the schedule reproducible. Each result includes its absolute budgets for retention and indicator visits, transcript builds and input rows, React commits, and owner reads. Background-only deliveries must cause zero visible transcript builds. The retention budget allows one scan of all active sessions per event, so doubling the number of equally active threads can quadruple this work. Compare both delivery modes to distinguish per-event work from per-batch work.

Local defaults use 1,000 cases per assertion. The extra pin-demand, Git-cache, resize, dispatcher and historical incremental-index suites and headed control are locally selectable. Use `run.py --help` for suite names.

## Topology and historical replay

One copy has 869 live threads, 475 in the focus directory, 105 pins, 102 linked directories and 325 resolved parent links. Sixteen parent references have unknown targets. The archive control is 2,807 synthetic tombstones. Navigation sweeps 1/2/4 copies. SQLite varies live and archived cardinality independently. Pass `--copies 2 --archived 1000` to move those axes. Uniform navigation varies project concentration and pins separately. Export synthetic thread summaries, directory overlays, tombstones and unresolved IDs directly with:

```sh
node scripts/scaling-audit/generate.mjs 2 2807 mixed > .local/topology.json
```

Fold policies are `open`, `focus` and `mixed`. Fold placements, IDs, timestamps and ranks are synthetic. Owner probes use open/default state. The #4590 author owns subtree, fold, paging and renderer correctness.

Use [revisions.json](../../../scripts/scaling-audit/revisions.json) for exact commits. Obtain missing PR objects with `git fetch origin refs/pull/NUMBER/head`. Prepare a separate worktree at the pinned commit, install there and pass its directory to the harness:

```sh
git worktree add --detach .local/v152 be957c66c90d74d759f04e34bc1aed70658b2257
(cd .local/v152 && pnpm install --frozen-lockfile)
python3 scripts/scaling-audit/run.py --candidate .local/v152 --historical v152 --suites properties --output .local/v152-properties
```

Omit `--suites` with `--historical` to select that revision's measured workloads. The manifest covers 1.5.0–1.5.2, three main snapshots and the Pricing, navigation and terminal PR heads. Select `--historical pr4612` on its pinned head to replay grouped Pricing and Token Miser. The 1.5 releases use the local owner navigation loader. The pinned #4590 heads enable the historical incremental oracle. Revisions with the live navigation index also count slot copies and lens predicate evaluations via a Vitest transform that verifies both instrumentation sites. Absent counters indicate missing instrumentation. The matched corpus uses repository model sources wherever they still match and retains three audit versions whose repository tests evolved.

## Native paint control

Follow the [macOS VM lab skill](../macos-vm-e2e-lab/SKILL.md). Use an isolated, independently installed lab checkout at v150, v151, v152, main2 or pr4590b. Run `python3 scripts/scaling-audit/paint.py /path/to/lab-checkout .local/paint --repeats 3` with the harness available in the guest. It builds the target once and uses the inspect-only Playwright configuration for each fresh Electron launch. Pass `--list` to check discovery without starting the desktop. This simplified Codex-only control verifies 869 visible rows and 105 pins, discards two warm-ups per lens and records ten click-to-frame observations per lens. Report platform, GPU setting and spread with any timing claim.
