import fc from "fast-check";
import type { PrSummary } from "@pwragent/shared";

/**
 * An independent statement of the PR list order (`resolvePrRollup().ordered`):
 * open PRs above finished ones, each stack newest first. Every list that
 * shows a thread's PRs in that order checks itself against this model.
 */

export type Spec = {
  lifecycle: "open" | "merged" | "closed";
  /** Index into a shared pool of distinct times; undefined = not known. */
  createdSlot: number | undefined;
  finishedSlot: number | undefined;
  checks: "passing" | "pending" | "failing";
};

export const specArb: fc.Arbitrary<Spec> = fc.record({
  lifecycle: fc.constantFrom("open", "merged", "closed"),
  createdSlot: fc.option(fc.nat(10_000), { nil: undefined }),
  finishedSlot: fc.option(fc.nat(10_000), { nil: undefined }),
  checks: fc.constantFrom("passing", "pending", "failing"),
});

export function build(specs: Spec[]): PrSummary[] {
  return specs.map((spec, index) => {
    const number = 100 + index;
    // Distinct times: the slot plus the index as a fraction.
    const time = (slot: number | undefined) =>
      slot === undefined ? undefined : 1_700_000_000_000 + slot * 1_000 + index;
    const finishedAt = time(spec.finishedSlot);
    return {
      provider: "github.com",
      number,
      org: "acme",
      repo: "orbit",
      url: `https://github.com/acme/orbit/pull/${number}`,
      state: spec.lifecycle === "open" ? spec.checks : spec.lifecycle,
      checkState: spec.checks,
      lifecycleState: spec.lifecycle,
      reviewState: "ready_for_review",
      mergeState: "mergeable",
      createdAt: time(spec.createdSlot),
      ...(spec.lifecycle === "merged" && finishedAt !== undefined ? { mergedAt: finishedAt } : {}),
      ...(spec.lifecycle === "closed" && finishedAt !== undefined ? { closedAt: finishedAt } : {}),
    };
  });
}

/** The model: an independent statement of the two stacks. */
export function modelOrder(prs: PrSummary[]): number[] {
  const indexed = prs.map((pr, index) => ({ pr, index }));
  const isOpen = (pr: PrSummary) => pr.lifecycleState === "open";
  const open = indexed.filter((entry) => isOpen(entry.pr));
  const finished = indexed.filter((entry) => !isOpen(entry.pr));
  // Not yet polled = just attached = newest; ties to the later attachment.
  const openRank = (entry: { pr: PrSummary; index: number }) =>
    [entry.pr.createdAt === undefined ? 1 : 0, entry.pr.createdAt ?? 0, entry.index];
  // Finished before timestamps existed = oldest.
  const finishedRank = (entry: { pr: PrSummary; index: number }) => {
    const at = entry.pr.mergedAt ?? entry.pr.closedAt;
    return [at === undefined ? 0 : 1, at ?? 0, entry.index];
  };
  const descending = (rank: (entry: { pr: PrSummary; index: number }) => number[]) =>
    (a: { pr: PrSummary; index: number }, b: { pr: PrSummary; index: number }) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i += 1) {
        if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
      }
      return 0;
    };
  return [
    ...open.sort(descending(openRank)),
    ...finished.sort(descending(finishedRank)),
  ].map((entry) => entry.pr.number);
}
