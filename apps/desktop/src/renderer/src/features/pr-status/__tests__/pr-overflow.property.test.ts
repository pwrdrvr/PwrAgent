import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { resolvePrChipPresentation } from "../pr-chip-state";
import { prOverflowLabel, resolvePrOverflow, resolvePrRollup } from "../pr-rollup";

/**
 * Mission Control's PR chips: the lead PR's chip and a `+N PRs` chip.
 *
 * - No PR is lost or shown twice: the lead plus the rest is every PR.
 * - The lead is the one open PR when exactly one is open, else the top of
 *   the list, and a check changing never moves it.
 * - A failing open PR behind the overflow chip still turns it red.
 */

type Spec = {
  lifecycle: "open" | "merged" | "closed";
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

const specsArb = fc.array(specArb, { minLength: 2, maxLength: 12 });

function build(specs: Spec[]): PrSummary[] {
  return specs.map((spec, index) => {
    const number = 100 + index;
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

describe("resolvePrOverflow", () => {
  it("draws nothing extra for fewer than two PRs", () => {
    fc.assert(fc.property(fc.array(specArb, { maxLength: 1 }), (specs) => {
      expect(resolvePrOverflow(build(specs))).toBeUndefined();
    }));
  });

  it("shows every PR exactly once: the lead, then the rest in list order", () => {
    fc.assert(fc.property(specsArb, (specs) => {
      const prs = build(specs);
      const overflow = resolvePrOverflow(prs)!;
      const ordered = resolvePrRollup(prs)!.ordered;
      expect([overflow.lead, ...overflow.rest].map((pr) => pr.url).sort())
        .toEqual(prs.map((pr) => pr.url).sort());
      expect(overflow.rest).toEqual(ordered.filter((pr) => pr !== overflow.lead));
      expect(prOverflowLabel(overflow.rest.length))
        .toBe(`+${prs.length - 1} ${prs.length === 2 ? "PR" : "PRs"}`);
    }));
  });

  it("leads with the one open PR, else the top of the list", () => {
    fc.assert(fc.property(specsArb, (specs) => {
      const prs = build(specs);
      const overflow = resolvePrOverflow(prs)!;
      const open = prs.filter((pr) => pr.lifecycleState === "open");
      if (open.length === 1) {
        expect(overflow.lead).toBe(open[0]);
      } else {
        expect(overflow.lead).toBe(resolvePrRollup(prs)!.ordered[0]);
      }
    }));
  });

  it("keeps the lead when only checks change", () => {
    const checks = fc.constantFrom<Spec["checks"]>("passing", "pending", "failing");
    fc.assert(fc.property(
      specsArb.chain((specs) =>
        fc.tuple(fc.constant(specs), fc.array(checks, {
          minLength: specs.length,
          maxLength: specs.length,
        }))),
      ([specs, nextChecks]) => {
        const before = resolvePrOverflow(build(specs))!.lead.url;
        const after = resolvePrOverflow(
          build(specs.map((spec, index) => ({ ...spec, checks: nextChecks[index]! }))),
        )!.lead.url;
        expect(after).toBe(before);
      },
    ));
  });

  it("turns the overflow chip red when a hidden open PR is failing", () => {
    fc.assert(fc.property(specsArb, (specs) => {
      const overflow = resolvePrOverflow(build(specs))!;
      const state = resolvePrChipPresentation(overflow.restRepresentative).chipState;
      const hiddenOpen = overflow.rest.filter((pr) => pr.lifecycleState === "open");
      if (hiddenOpen.some((pr) => pr.checkState === "failing")) {
        expect(state).toBe("failing");
      }
      if (hiddenOpen.length > 0) {
        expect(overflow.restRepresentative.lifecycleState).toBe("open");
      }
    }));
  });
});
