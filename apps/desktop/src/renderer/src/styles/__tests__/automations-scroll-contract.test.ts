import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/**
 * Every top-level rule whose selector line is exactly `selector`. Plural
 * because several of these selectors also appear inside a grouped rule (the
 * header and the row share one grid definition), and the assertion below
 * wants the standalone block, not whichever came first.
 */
function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodies = [
    ...css.matchAll(
      new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`, "g"),
    ),
  ].map((match) => match.groups?.body ?? "");
  if (bodies.length === 0) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return bodies;
}

function ruleBody(selector: string): string {
  return ruleBodies(selector).join("\n");
}

/**
 * The Automations screen scrolls at `.automations-content`; everything inside
 * it must be free to exceed that box rather than be squeezed into it.
 *
 * `.automations-table` clips to its border radius with `overflow: hidden`, so
 * a shrunk table does not overflow visibly and does not scroll — it silently
 * eats its own content. Measured once at 179px tall holding 1309px of rows,
 * with no scrollbar anywhere on the page. jsdom has no layout engine, so the
 * invariant is pinned here in the stylesheet instead.
 */
describe("automations screen scrolling", () => {
  it("scrolls the content column", () => {
    expect(ruleBody(".automations-content")).toMatch(/overflow:\s*auto;/);
  });

  it("keeps the table at its natural height inside that column", () => {
    const body = ruleBody(".automations-table");
    expect(body).toMatch(/flex:\s*0\s+0\s+auto;/);
    // The pairing is the trap: shrinkable + clipped = unreachable content.
    expect(body).toMatch(/overflow:\s*clip;/);
  });

  it("clips with `clip` so sticky descendants still see the scroll container", () => {
    // `overflow: hidden` would make the table a scroll container of its own,
    // and every sticky header inside it would resolve against a box that
    // never scrolls — silently doing nothing.
    expect(ruleBody(".automations-table")).not.toMatch(/overflow:\s*hidden;/);
  });

  it("stacks the three sticky layers against the header height", () => {
    expect(ruleBody(".automations-table")).toMatch(
      /--automations-header-h:\s*\d+px;/,
    );
    expect(ruleBody(".automations-table__header")).toMatch(/top:\s*0;/);
    expect(ruleBody(".automations-table__row")).toMatch(
      /top:\s*var\(--automations-header-h\);/,
    );
    expect(
      ruleBody(".automations-table__history .automation-run-history__line"),
    ).toMatch(
      /top:\s*calc\(var\(--automations-header-h\)\s*\+\s*var\(--automation-row-h,\s*0px\)\);/,
    );
  });
});
