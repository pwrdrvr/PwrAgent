import { describe, expect, it } from "vitest";
import { appStyleRules as rules, hasMotionQuery } from "./css-style-rules";

/**
 * The Calm motion contract (Settings → General → Appearance).
 *
 * With `data-motion="calm"` on `<html>`, every looping animation in `app.css`
 * runs twice and rests. This gate makes the next looping indicator decide what
 * it does under Calm motion, the way `reduced-motion-contract.test.ts` makes
 * it decide under Reduce Motion.
 */
const CALM = ':root[data-motion="calm"] ';

const loopingRules = rules.filter((rule) =>
  /animation:[^;]*\binfinite\b/.test(rule.body),
);
const calmRules = rules.filter((rule) =>
  rule.selectors.some((selector) => selector.startsWith(CALM)),
);

/** Selectors whose Calm rule ends the loop: a finite count, or a shorthand without `infinite`. */
const calmSelectors = new Set(
  calmRules
    .filter((rule) =>
      /animation-iteration-count:\s*2\b/.test(rule.body)
      || (/(?:^|[;{\s])animation:/.test(rule.body) && !/\binfinite\b/.test(rule.body)))
    .flatMap((rule) => rule.selectors)
    .filter((selector) => selector.startsWith(CALM))
    .map((selector) => selector.slice(CALM.length)),
);

/** A loop that keeps running under Calm motion, and why. */
const CALM_EXEMPTIONS: Record<string, string> = {
  // A paired ring settles through `.pending-spinner--paired`. A standalone ring
  // is the only sign its control is busy, so it keeps spinning, as it does
  // under Reduce Motion.
  ".pending-spinner":
    "standalone busy ring with no text companion; paired rings settle by their `.pending-spinner--paired` modifier",
};

describe("app.css Calm motion contract", () => {
  it("finds the looping animations and the calm rules it gates", () => {
    expect(loopingRules.length).toBeGreaterThanOrEqual(5);
    expect(calmSelectors.has(".thinking-scanner__beam")).toBe(true);
    expect(calmSelectors.has(".pending-spinner--paired")).toBe(true);
  });

  it("gives every infinite animation a Calm motion decision", () => {
    const undecided = loopingRules
      .flatMap((rule) => rule.selectors)
      .filter((selector) =>
        !calmSelectors.has(selector) && !Object.hasOwn(CALM_EXEMPTIONS, selector));
    expect(undecided).toEqual([]);
  });

  it("keeps every calm rule under no-preference, so Reduce Motion still wins", () => {
    for (const rule of calmRules) {
      expect(hasMotionQuery(rule.atRules, "no-preference"), rule.selectors.join(", ")).toBe(true);
    }
  });

  it("starts each rest pose as the second run ends", () => {
    // A rest pose that lands mid-run would freeze the bar or ring part way.
    const restRules = calmRules.filter((rule) => /\bforwards\b/.test(rule.body));
    expect(restRules.length).toBeGreaterThanOrEqual(2);
    for (const rule of restRules) {
      const run = rule.body.match(/[\w-]+\s+([\d.]+)s\s+[\w-]+(?:\([^)]*\))?\s+2\b/);
      const rest = rule.body.match(/calm-motion-[\w-]+\s+0s\s+([\d.]+)s\s+forwards/);
      expect(run, rule.selectors.join(", ")).not.toBeNull();
      expect(rest, rule.selectors.join(", ")).not.toBeNull();
      expect(Number(rest![1])).toBeCloseTo(Number(run![1]) * 2, 5);
    }
  });

  it("rests the thinking beam in the reduced-motion pose", () => {
    const calmBeam = calmRules.find((rule) => rule.selectors.includes(`${CALM}.thinking-scanner__beam`));
    const reducedBeam = rules.find((rule) =>
      hasMotionQuery(rule.atRules, "reduce") && rule.selectors.includes(".thinking-scanner__beam"));
    const declaration = (body: string, property: string) =>
      body.match(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`))?.[1].trim();
    for (const property of ["opacity", "transform"]) {
      expect(declaration(calmBeam!.body, property)).toBe(declaration(reducedBeam!.body, property));
    }
  });
});
