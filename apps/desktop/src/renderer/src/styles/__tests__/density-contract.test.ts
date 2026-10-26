import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Density lives entirely in CSS (`<html data-density>` plus X-ray's
 * `data-xray-target` row), so its rules can only be held here. Each rule has
 * two halves: the live list, which the X-ray row and the density previews
 * must both escape, and the preview, which must show its own density
 * whatever the app's is.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/** Every selector list in app.css that mentions `needle`, with its body. */
function rulesMentioning(needle: string): Array<{ selectors: string[]; body: string }> {
  const rules: Array<{ selectors: string[]; body: string }> = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = match[1]!.trim();
    if (!selectorText.includes(needle)) continue;
    rules.push({
      selectors: splitSelectorList(selectorText),
      body: match[2]!,
    });
  }
  return rules;
}

/** Splits a selector list on its top-level commas, not those inside `:is(…)`. */
function splitSelectorList(selectorText: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selectorText.length; index += 1) {
    const char = selectorText[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      selectors.push(selectorText.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selectorText.slice(start).trim());
  return selectors;
}

describe("density rules", () => {
  for (const density of ["compact", "minimal"]) {
    it(`pairs every ${density} rule with its preview, outside the X-ray row and previews`, () => {
      const rules = rulesMentioning(`[data-density="${density}"]`);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        const live = rule.selectors.filter((selector) => selector.startsWith(":root"));
        const preview = rule.selectors.filter((selector) =>
          selector.startsWith(`.density-preview--${density} `));
        expect(live).toHaveLength(1);
        expect(preview).toHaveLength(1);
        expect(live[0]).toContain(`:root[data-density="${density}"] `);
        expect(live[0]).toContain(":not(:is(.density-preview, [data-xray-target]) *)");
        // X-ray lifts one row; it must not strip the density from the whole list.
        expect(live[0]).not.toContain("[data-xray]");
      }
    });
  }

  // The Directories and Pinned group headers are `.thread-row` buttons too.
  // A density rule that reached them moved their caret 8px right, and X-ray
  // moved it back.
  for (const density of ["compact", "minimal"]) {
    it(`keeps ${density}'s row rules off the directory and Pinned group headers`, () => {
      const rowRules = rulesMentioning(`[data-density="${density}"]`).filter((rule) =>
        rule.selectors.some((selector) => /\.thread-row(?![\w-])/.test(selector)));
      expect(rowRules.length).toBeGreaterThan(0);
      for (const rule of rowRules) {
        for (const selector of rule.selectors) {
          expect(selector).toContain(":not(.directory-row__summary)");
        }
      }
    });
  }

  it("tightens the title line only through the density row rules", () => {
    for (const density of ["compact", "minimal"]) {
      const row = rulesMentioning(`[data-density="${density}"]`).find((rule) =>
        /--thread-row-header-gap/.test(rule.body));
      expect(row?.body).toMatch(/--thread-row-header-gap:\s*4px/);
      expect(row?.body).toMatch(/--thread-row-action-gap:\s*2px/);
    }
    const header = rulesMentioning(".thread-row__header").find((rule) =>
      rule.selectors.includes(".thread-row__header"));
    expect(header?.body).toMatch(/gap:\s*var\(--thread-row-header-gap, 12px\)/);
  });

  it("keeps only essential chips in Minimal's flow", () => {
    const flow = rulesMentioning(".thread-row__chips:not(:is(.density-preview, [data-xray-target]) *) > :not(.thread-row__chip--essential)");
    expect(flow).toHaveLength(1);
    expect(flow[0]!.body).toMatch(/display:\s*none/);
  });

  for (const titleLine of [".thread-row__pr-rollup", ".thread-row__title-reactions", ".thread-row__title-draft"]) {
    it(`shows ${titleLine} on Minimal's title line only`, () => {
      const rules = rulesMentioning(titleLine);
      const base = rules.find((rule) => rule.selectors.includes(titleLine));
      expect(base?.body).toMatch(/display:\s*none/);
      const shown = rules.find((rule) =>
        rule.selectors.some((selector) =>
          selector.startsWith(':root[data-density="minimal"]') && selector.includes(titleLine)));
      expect(shown?.body).toMatch(/display:\s*inline-flex/);
    });
  }

  it("lets the title-line rollup hold no chip row open in Compact", () => {
    const gapless = rulesMentioning('[data-density="compact"]').find((rule) => /gap:\s*0/.test(rule.body));
    expect(gapless?.selectors[0]).toContain(":not(:has(.thread-row__chips .pr-chip))");
  });
});
