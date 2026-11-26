---
name: pwragent-scaling-audit
description: >-
  Find quadratic or multiplicative work in PwrAgent with local model-based
  testing and scaling probes. Use when changing Federation protocol handling,
  Git or Git forge behavior, incoming transcript parsing or rendering, or
  transcript loading when returning to a thread.
---

# PwrAgent Scaling Audit

Audit the affected paths from the real entry point through the downstream work it triggers. Look for `O(n²)` and `O(n × m)` work that can hide behind a linear helper, a cache hit, or a small fixture. Fix the in-scope problems you reproduce.

## Find the work that can multiply

Name the dimensions, the unit of work, and the expected bound for the user action. Count work across the whole stream, refresh cycle, reconnect, or navigation. For example, scanning a growing buffer once per chunk is linear per scan and quadratic across a stream of fixed-size chunks.

| Path | Workloads and counters to consider |
| --- | --- |
| Federation protocol | Vary peers, rows per peer, event bursts, snapshot size, and reconnect or replay length. Count encodes and decodes, rows visited or rewritten, IPC messages, and broadcasts. Check whether one owner's change fans out unrelated rows or triggers a full snapshot per event. |
| Git | Vary repositories, worktrees, refs, and repeated refreshes. Count Git process starts, commands per repository or worktree, and refs or rows scanned. Include cold start, overlapping callers, and cache expiry so a warm cache cannot hide repeated work. |
| Git forge | Vary repositories, PRs or MRs, result pages, and poll or invalidation cycles. Count requests, pages, local Git starts, and rows rebuilt. Check for checkout-wide work triggered by one PR update, including background polling. |
| Incoming transcript | Vary accumulated text and chunk count independently, then vary history length and activity or message-part count. Try tiny chunks, delimiters split across chunks, incomplete markers, and long ordinary text. Count bytes scanned, copied, or parsed, unchanged row identities replaced, render commits, and layout reads as applicable. |
| Return to a thread | Vary turns, items, history pages, and switches between threads. Probe cold open, warm return, and return while updates or reads are in flight. Count pages and bytes loaded, rows merged or projected, and render work. Check for repeated hydration or reprojection of unchanged history. |

## Use two probes on the same path

1. **Explore with model-based testing (MBT).** Read the [property, model and oracle testing guide](../../../docs/property-model-oracle-testing.md). Generate valid operation sequences with the repo's fast-check setup or a seeded local harness. Compare state to an independent oracle, such as the owning instance, provider event order, or a simple reference implementation. Assert a work budget after each operation where practical. Vary order, boundaries, redelivery, and races that the real entry point can see. Use up to 1,000 seeds or variations for local discovery and force some sequences to reach the sizes and states under investigation. For expensive I/O, use fakes for bulk runs and verify a small case at the real boundary, such as Git commands in a temporary repository. Record the failing seed and shrink path or the exact sequence and dimensions. Keep exploratory harnesses, raised run counts, generated cases, and bulk outputs out of commits and CI.
2. **Measure growth with controlled inputs.** Run the same workload at `n`, `2n`, and `4n` or comparable sizes large enough to expose the suspected cost. For two dimensions, scale each independently and then both together. A product term can look linear with either dimension fixed. Hold other inputs and cache conditions steady within each series. Prefer deterministic counters at the boundary that does the work. Use repeated timings or profiles as supporting evidence when the cost is inside a library, browser layout, or another opaque layer. Repeat the same probes on the pre-fix and fixed paths.

The Browser Use audit counted historical card references replaced by a single streaming delta and measured parsing over a whole stream. The emoji shortcode audit counted cumulative characters scanned and full-document parse resets. The Markdown table audit counted layout reads on height-only growth and checked that all reads in a resize batch preceded writes. [Browser Use #4506](https://github.com/pwrdrvr/PwrAgent/pull/4506), [emoji shortcodes #4514](https://github.com/pwrdrvr/PwrAgent/pull/4514), [Markdown tables #4529](https://github.com/pwrdrvr/PwrAgent/pull/4529).

## Fix and keep the regression small

- Remove the repeated work at its source. Match the fix to the finding, such as parsing only the new suffix, indexing a lookup, preserving unchanged row identities, batching Git or forge work by the relevant repository, or scoping invalidation to the changed entity. Recheck ordering, deduplication, cache invalidation, and stream versus reload parity where relevant.
- Reproduce each finding on the old path with a reduced case. Commit named counterexamples and a cheap deterministic work assertion that fails on the old path and passes with the fix, such as a parser byte count, maximum Git starts per refresh, or unchanged row identity. Use the [generated-test CI budget](../../../docs/property-model-oracle-testing.md#what-to-check-in) for any checked-in property. Keep timing thresholds out of routine regression tests when operation counts cover the behavior.
- Report the measured path, workload sizes, before and after counts or growth, and the regression tests kept. If a suspected cliff did not reproduce, state the dimensions and cache conditions exercised.
