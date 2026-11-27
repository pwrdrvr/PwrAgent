---
name: pwragent-profile-scaling
description: Replay the matched PwrAgent 1.5.x large-profile performance investigation on a release, baseline or candidate. Use for the anonymous topology, historical work counters, fixed-seed models and native lens-switch control. Use pwragent-scaling-audit for investigating a new scaling mechanism.
---

# Replay the profile scaling audit

Run commands from the harness checkout. Use Node and pnpm from the target checkout's repository guidance, Python 3.9+, and a separate frozen pnpm install in each target. Reserve four local CPU slots following [local CPU checkout](../../../docs/local-cpu-checkout.md). The launcher runs one Vitest worker with the measured revision's native setup and fixtures. Every workload uses synthetic rows or an isolated store.

```sh
python3 scripts/scaling-audit/run.py --suites terminal reopen --output .local/terminal-reopen
python3 scripts/scaling-audit/run.py --base /path/to/installed-base --output .local/base-head --cases 25
```

The candidate defaults to this checkout including working changes. Use clean pinned checkouts when attributing results to commits. Select another with `--candidate`. Give each run a fresh output directory. The same harness code, family seeds and case counts run on both sides. The runner stages exclusive temporary modules beside repository test helpers and cleans them up on exit. Only its dedicated Vitest configuration discovers those modules.

## Read a comparison

Start with `summary.md`. In `results.json`, match the revision, suite, scenario dimensions and counter name. The comparison exits nonzero for increased deterministic work, missing scenarios or failed oracles. An improvement may trade a full join for targeted reads. Inspect both counters before judging a change. SQLite durations and serialized Pricing bytes are diagnostics. A property failure records its seed, assertion and shrink path in the revision's `work.jsonl`; `vitest.json` records the error. For a new mechanism, use the [scaling audit skill](../pwragent-scaling-audit/SKILL.md) to choose dimensions and reduce a regression to an ordinary low-cost test.

The PR label `ci:scaling-audit` compares the pinned base and head with 25 cases for each of the 37 matched assertions. It exercises shaped and uniform navigation, real SQLite overlays, provider completion and Stop, held review Auto-fixes, open Pricing, Federation retries, stream identity and transcript merge/reopen. Local defaults use 1,000 cases per assertion. The extra pin-demand, Git-cache, resize, dispatcher and historical incremental-index suites and headed control are locally selectable. Use `run.py --help` for suite names.

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

Omit `--suites` with `--historical` to select that revision's measured workloads. The manifest covers 1.5.0–1.5.2, three main snapshots and the Pricing, navigation and terminal PR heads. The 1.5 releases use the local owner navigation loader. Only the pinned #4590 heads enable the historical incremental oracle and two additional projection counters via a Vitest transform. Absent counters indicate missing instrumentation. The matched corpus uses repository model sources wherever they still match and retains three audit versions whose repository tests evolved.

## Native paint control

Follow the [macOS VM lab skill](../macos-vm-e2e-lab/SKILL.md). Use an isolated, independently installed lab checkout at v150, v151, v152, main2 or pr4590b. Run `python3 scripts/scaling-audit/paint.py /path/to/lab-checkout .local/paint --repeats 3` with the harness available in the guest. It builds the target once and uses the inspect-only Playwright configuration for each fresh Electron launch. Pass `--list` to check discovery without starting the desktop. This simplified Codex-only control verifies 869 visible rows and 105 pins, discards two warm-ups per lens and records ten click-to-frame observations per lens. Report platform, GPU setting and spread with any timing claim.
