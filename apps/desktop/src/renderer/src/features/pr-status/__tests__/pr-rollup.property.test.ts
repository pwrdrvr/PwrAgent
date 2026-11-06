import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { resolvePrRollup } from "../pr-rollup";

/**
 * The rollup popover is two stacks: open PRs above finished ones, each with
 * its newest entry on top. Opening a PR pushes it onto the open stack;
 * merging or closing one moves it to the top of the finished stack, where
 * it stays as later PRs finish above it.
 */

type Spec = {
  lifecycle: "open" | "merged" | "closed";
  /** Index into a shared pool of distinct times; undefined = not known. */
  createdSlot: number | undefined;
  finishedSlot: number | undefined;
  checks: "passing" | "pending" | "failing";
};

const specArb: fc.Arbitrary<Spec> = fc.record({
  lifecycle: fc.constantFrom("open", "merged", "closed"),
  createdSlot: fc.option(fc.nat(10_000), { nil: undefined }),
  finishedSlot: fc.option(fc.nat(10_000), { nil: undefined }),
  checks: fc.constantFrom("passing", "pending", "failing"),
});

function build(specs: Spec[]): PrSummary[] {
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
function modelOrder(prs: PrSummary[]): number[] {
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

describe("resolvePrRollup order properties", () => {
  it("lists open PRs newest first, above finished PRs newest first", () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 1, maxLength: 8 }), (specs) => {
        const prs = build(specs);
        const rollup = resolvePrRollup(prs)!;
        expect(rollup.ordered.map((pr) => pr.number)).toEqual(modelOrder(prs));
      }),
    );
  });

  it("moves a PR that merges to the top of the finished stack and keeps the rest in place", () => {
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 2, maxLength: 8 }),
        fc.nat(),
        (specs, pick) => {
          const openIndexes = specs.flatMap((spec, index) => (spec.lifecycle === "open" ? [index] : []));
          fc.pre(openIndexes.length > 0);
          const target = openIndexes[pick % openIndexes.length]!;
          const before = build(specs);
          const now = Math.max(
            0,
            ...before.map((pr) => pr.mergedAt ?? pr.closedAt ?? 0),
          ) + 1;
          const after = before.map((pr, index) => index === target
            ? { ...pr, lifecycleState: "merged" as const, state: "merged" as const, mergedAt: now }
            : pr);
          const finishedNumbers = (prs: PrSummary[]) =>
            resolvePrRollup(prs)!.ordered
              .filter((pr) => pr.lifecycleState !== "open")
              .map((pr) => pr.number);
          const openNumbers = (prs: PrSummary[]) =>
            resolvePrRollup(prs)!.ordered
              .filter((pr) => pr.lifecycleState === "open")
              .map((pr) => pr.number);
          const merged = before[target]!.number;
          expect(finishedNumbers(after)).toEqual([merged, ...finishedNumbers(before)]);
          expect(openNumbers(after)).toEqual(openNumbers(before).filter((n) => n !== merged));
        },
      ),
    );
  });

  it("puts every open PR above every finished PR", () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 1, maxLength: 8 }), (specs) => {
        const ordered = resolvePrRollup(build(specs))!.ordered;
        const firstFinished = ordered.findIndex((pr) => pr.lifecycleState !== "open");
        if (firstFinished >= 0) {
          expect(ordered.slice(firstFinished).every((pr) => pr.lifecycleState !== "open")).toBe(true);
        }
      }),
    );
  });

  it("still wears the least ready open PR on the chip, whatever the list order", () => {
    const rank = { failing: 1, pending: 3, passing: 4 } as const;
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 1, maxLength: 8 }), (specs) => {
        const prs = build(specs);
        const open = prs.filter((pr) => pr.lifecycleState === "open");
        fc.pre(open.length > 0);
        const least = Math.min(...open.map((pr) => rank[pr.checkState as keyof typeof rank]));
        const expected = open.find((pr) => rank[pr.checkState as keyof typeof rank] === least)!;
        expect(resolvePrRollup(prs)!.representative).toBe(expected);
      }),
    );
  });
});
