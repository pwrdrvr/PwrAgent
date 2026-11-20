import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { resolvePrRollup } from "../pr-rollup";
import { build, modelOrder, specArb } from "./pr-rollup-order-model";

/**
 * The rollup popover is two stacks: open PRs above finished ones, each with
 * its newest entry on top. Opening a PR pushes it onto the open stack;
 * merging or closing one moves it to the top of the finished stack, where
 * it stays as later PRs finish above it.
 */

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
