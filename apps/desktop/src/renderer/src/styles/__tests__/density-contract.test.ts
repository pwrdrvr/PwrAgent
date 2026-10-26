import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Density lives entirely in CSS (`<html data-density>` plus `data-xray`), so
 * its rules can only be held here. Each rule has two halves: the live list,
 * which X-ray and the density previews must both escape, and the preview,
 * which must show its own density whatever the app's is.
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
      selectors: selectorText.split(",").map((selector) => selector.trim()),
      body: match[2]!,
    });
  }
  return rules;
}

describe("density rules", () => {
  for (const density of ["compact", "minimal"]) {
    it(`pairs every ${density} rule with its preview, outside X-ray and previews`, () => {
      const rules = rulesMentioning(`[data-density="${density}"]`);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        const live = rule.selectors.filter((selector) => selector.startsWith(":root"));
        const preview = rule.selectors.filter((selector) =>
          selector.startsWith(`.density-preview--${density} `));
        expect(live).toHaveLength(1);
        expect(preview).toHaveLength(1);
        expect(live[0]).toContain(`:root[data-density="${density}"]:not([data-xray])`);
        expect(live[0]).toContain(":not(.density-preview *)");
      }
    });
  }

  it("keeps only essential chips in Minimal's flow", () => {
    const flow = rulesMentioning(".thread-row__chips:not(.density-preview *) > :not(.thread-row__chip--essential)");
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
