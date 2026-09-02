import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  clampDetailsHeight,
  DEFAULT_SAVINGS_LAYOUT,
  readStoredSavingsLayout,
  SAVINGS_DETAILS_MIN_HEIGHT,
  SAVINGS_RESULTS_MIN_HEIGHT,
  writeStoredSavingsLayout,
} from "../token-miser-savings-layout";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  path.resolve(testDir, "../../../styles/app.css"),
  "utf8",
);

function extractRuleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`),
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

afterEach(() => {
  window.localStorage.clear();
});

describe("Savings lens layout preferences", () => {
  it("starts with every reference section folded", () => {
    expect(readStoredSavingsLayout()).toEqual(DEFAULT_SAVINGS_LAYOUT);
    expect(DEFAULT_SAVINGS_LAYOUT.openSections).toEqual([]);
    expect(DEFAULT_SAVINGS_LAYOUT.detailsHeight).toBeUndefined();
  });

  it("round-trips a stored split", () => {
    writeStoredSavingsLayout({
      detailsHeight: 220,
      openSections: ["code-mode"],
    });
    expect(readStoredSavingsLayout()).toEqual({
      detailsHeight: 220,
      openSections: ["code-mode"],
    });
  });

  /* A renamed section would otherwise keep unfolding a row that no longer
     exists, and the operator would have no way to fold it again. */
  it("drops section keys it does not recognize", () => {
    window.localStorage.setItem(
      "pwragent.toolOutput.savingsLayout",
      JSON.stringify({ openSections: ["decisions", "gates", 7] }),
    );
    expect(readStoredSavingsLayout().openSections).toEqual(["decisions"]);
  });

  it("ignores a stored height that is not a usable number", () => {
    for (const detailsHeight of [Number.NaN, Infinity, "220", null]) {
      window.localStorage.setItem(
        "pwragent.toolOutput.savingsLayout",
        JSON.stringify({ detailsHeight, openSections: [] }),
      );
      expect(readStoredSavingsLayout().detailsHeight).toBeUndefined();
    }
  });

  it("survives a corrupt entry rather than failing the lens", () => {
    window.localStorage.setItem("pwragent.toolOutput.savingsLayout", "{oops");
    expect(readStoredSavingsLayout()).toEqual(DEFAULT_SAVINGS_LAYOUT);
  });
});

describe("clampDetailsHeight", () => {
  it("leaves the results list its floor", () => {
    expect(clampDetailsHeight(600, 700)).toBe(700 - SAVINGS_RESULTS_MIN_HEIGHT);
  });

  it("keeps a height that already clears the floor", () => {
    expect(clampDetailsHeight(200, 700)).toBe(200);
  });

  it("never drags the stack away to nothing", () => {
    expect(clampDetailsHeight(-40, 700)).toBe(SAVINGS_DETAILS_MIN_HEIGHT);
  });

  /* A window too short for both still has to produce a number. The stack wins
     the arithmetic here and loses it in flexbox, where `flex-shrink` hands the
     space back to the list. */
  it("falls back to the stack minimum in a window shorter than the floor", () => {
    expect(clampDetailsHeight(400, 120)).toBe(SAVINGS_DETAILS_MIN_HEIGHT);
  });
});

/**
 * The floor only works if the stylesheet agrees with the module the grip
 * clamps against. Two numbers that must match, in two files, is exactly the
 * pair that drifts silently — a smaller CSS value reopens the one-row bug and
 * every test above still passes.
 */
describe("results-list floor", () => {
  it("matches SAVINGS_RESULTS_MIN_HEIGHT in app.css", () => {
    const declared = extractRuleBody(".incident-explorer__gates")
      .match(/min-height:\s*(\d+)px;/)?.[1];
    expect(Number(declared)).toBe(SAVINGS_RESULTS_MIN_HEIGHT);
  });

  it("lets the reference stack shrink so that floor can be honoured", () => {
    const stack = extractRuleBody(".incident-explorer__savings-details");
    expect(stack).toMatch(/flex:\s*0 1 auto;/);
    expect(stack).toMatch(/min-height:\s*0;/);
    expect(stack).toMatch(/overflow-y:\s*auto;/);
  });
});
