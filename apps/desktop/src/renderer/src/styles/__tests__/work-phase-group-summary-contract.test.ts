import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the inline alignment of a work-phase group's summary once it wraps.
 *
 * The collapsible summary renders inside a `<button>`, and the UA stylesheet
 * gives buttons `text-align: center`; `display: inline-flex` does not reset
 * it. A summary long enough to wrap ("Worked for 3m 49s · 3 tool updates:
 * Ran git diff main...HEAD, Read …") therefore centered every line inside the
 * text column. Measured in headless Chromium against this stylesheet at a
 * 600px column: line one started 22px right of the column and line two 184px.
 * The non-collapsible `<div>` label inherits `start` and never showed it; the
 * declaration sits on the rule the two share so they stay one shape.
 *
 * jsdom does not lay out text, so the wrap itself cannot be measured here.
 * What is asserted is the declaration the outcome depends on.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

const SHARED_SELECTOR =
  ".transcript-work-phase-group__toggle,\n.transcript-work-phase-group__label";

function sharedRuleBody(): string {
  const start = css.indexOf(`\n${SHARED_SELECTOR} {`);
  expect(start, "app.css should declare the shared toggle/label rule").toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

describe("work-phase group summary alignment", () => {
  it("starts wrapped summary lines at the text column", () => {
    expect(sharedRuleBody()).toContain("text-align: start;");
  });

  it("leaves no other rule re-centering the toggle or label", () => {
    // Comments go first: `.live-strip__row` is introduced by a comment that
    // names the toggle, and would otherwise read as one of its rules.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const overrides: string[] = [];
    for (const match of rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const [, selector = "", body = ""] = match;
      if (!/\.transcript-work-phase-group__(?:toggle|label)\b/.test(selector)) {
        continue;
      }
      for (const [, value] of body.matchAll(/text-align:\s*([^;]+);/g)) {
        if (value.trim() !== "start") {
          overrides.push(`${selector.trim()} → text-align: ${value.trim()}`);
        }
      }
    }
    expect(overrides).toEqual([]);
  });
});
