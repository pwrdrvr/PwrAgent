import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodies = [
    ...css.matchAll(
      new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`, "g"),
    ),
  ].map((match) => match.groups?.body ?? "");
  if (bodies.length === 0) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return bodies.join("\n");
}

/**
 * The Token Miser summary line must fit inside its card at every string length
 * the component can produce.
 *
 * It did not. As one flex row of four items, the verdict — `white-space:
 * nowrap` plus `margin-left: auto`, so it can neither shrink nor wrap — took
 * its full intrinsic width first and the rest of the row was squeezed to
 * min-content behind it. Measured in headless Chromium against this
 * stylesheet, at the default 380px rail: `$0.002 evaluating · savings not
 * priced yet` (the verdict shown while a turn's gates are still unpriced)
 * pushed the summary's scrollWidth to 407px inside a 331px box, hung 76px past
 * the card's right border, and was clipped by the rail itself; "Token Miser"
 * broke across two lines and the decision counts stacked into a 63px-wide
 * ragged column eight lines tall.
 *
 * jsdom has no layout engine, so the invariant is pinned here in the
 * stylesheet — the same way `automations-scroll-contract` pins its scroller.
 * The shape that satisfies it: a two-row grid, so the counts get a full line of
 * their own instead of competing with the verdict for one line's width.
 */
describe("Token Miser summary line", () => {
  it("lays the summary out as a grid so the counts get their own row", () => {
    const body = ruleBody(".pricing-token-miser__summary");
    expect(body).toMatch(/display:\s*grid;/);
    // The verdict's track must stay flexible with a zero floor. `display:
    // grid` alone does not fix anything: with a third track of `auto` the
    // column sizes to the verdict's max-content and the overflow returns
    // exactly as it was, while every other assertion here still passes.
    expect(body).toMatch(
      /grid-template-columns:[^;]*minmax\(\s*0\s*,\s*1fr\s*\);/,
    );
  });

  it("gives the decision counts a full-width second row", () => {
    const body = ruleBody(".pricing-token-miser__count");
    // Row 2, spanning from the label column to the end: the counts never
    // share a line with the verdict, so neither one squeezes the other.
    expect(body).toMatch(/grid-row:\s*2;/);
    expect(body).toMatch(/grid-column:\s*2\s*\/\s*-1;/);
    expect(body).toMatch(/min-width:\s*0;/);
  });

  it("lets a long verdict wrap inside the card instead of overflowing it", () => {
    const body = ruleBody(".pricing-token-miser__verdict");
    // `nowrap` is what made a 277px verdict overflow a 331px row rather than
    // take a second line. It must not come back.
    expect(body).not.toMatch(/white-space:\s*nowrap;/);
    expect(body).toMatch(/min-width:\s*0;/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere;/);
    // And it stays on the header row, right-aligned. Left unpinned, an edit
    // could drop it onto row 2 with the counts — two items in one cell — and
    // nothing here would notice.
    expect(body).toMatch(/grid-row:\s*1;/);
    expect(body).toMatch(/grid-column:\s*3;/);
    expect(body).toMatch(/justify-self:\s*end;/);
  });

  it("ranks the awaiting-pricing figure as metadata, not as a verdict", () => {
    // While the gates are unpriced the figure is what they have cost, not
    // what they saved. In the settled accent it reads as good news that has
    // not been measured yet.
    const body = ruleBody('.pricing-token-miser__verdict[data-pending="true"]');
    expect(body).toMatch(/color:\s*var\(--text-(secondary|muted)\);/);
    expect(body).not.toMatch(/var\(--accent/);
  });

  it("keeps the product name on one line", () => {
    // "Token Miser" wrapping to "Token / Miser" was the loudest symptom of
    // the squeeze; the label is short and must never be the thing that gives.
    expect(ruleBody(".pricing-token-miser__label")).toMatch(
      /white-space:\s*nowrap;/,
    );
  });
});

/**
 * Token Miser's verdict is colored by degrees, and every surface — the rail
 * card, the per-turn fold, a gate's breakdown, and the savings window — takes
 * that color from one place.
 *
 * Before this, a 20% saving on the rail card painted in `--text-primary`,
 * exactly like a figure with no verdict at all, while the window painted the
 * same saving in the accent orange that marks an overhead elsewhere. The
 * operator could not tell a win from a loss at a glance.
 */
describe("Token Miser verdict colors", () => {
  it("maps each tier to exactly one verdict token", () => {
    expect(ruleBody('[data-savings-tier="good"]')).toMatch(
      /--savings-verdict:\s*var\(--savings-good\);/,
    );
    expect(ruleBody('[data-savings-tier="even"]')).toMatch(
      /--savings-verdict:\s*var\(--savings-even\);/,
    );
    expect(ruleBody('[data-savings-tier="over"]')).toMatch(
      /--savings-verdict:\s*var\(--savings-over\);/,
    );
    // Exceptional is great's ink with more around it, not a brighter green.
    expect(
      ruleBody('[data-savings-tier="exceptional"],\n[data-savings-tier="great"]'),
    ).toMatch(/--savings-verdict:\s*var\(--savings-great\);/);
  });

  it("colors every verdict figure through --savings-verdict", () => {
    for (const selector of [
      ".token-miser-summary-card__figure",
      ".token-miser-summary-card__percent",
      ".pricing-token-miser__verdict",
      ".incident-explorer__savings-percent",
      ".incident-explorer__savings-figure strong",
    ]) {
      expect(ruleBody(selector), selector).toMatch(
        /color:\s*var\(--savings-verdict,/,
      );
    }
  });

  it("never paints a verdict in the accent", () => {
    // The accent is the product's one highlight color. It said "look here"
    // for a saving and an overhead alike, which is what hid the sign.
    for (const selector of [
      ".token-miser-summary-card__figure",
      ".pricing-token-miser__verdict",
      ".incident-explorer__savings-figure strong",
    ]) {
      expect(ruleBody(selector), selector).not.toMatch(/var\(--accent/);
    }
  });

  it("keeps the retired sign flag out of the stylesheet", () => {
    // `data-negative` carried two states; the tier carries five. A rule left
    // on the old flag would match nothing and look like it still worked.
    expect(css).not.toMatch(/token-miser[^{]*\[data-negative/);
  });
});
