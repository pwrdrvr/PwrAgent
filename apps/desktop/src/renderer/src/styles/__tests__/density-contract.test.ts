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

/**
 * A nested tray row's left inset and chevron, as the cascade resolves them in
 * each density. The model names, per case, the rule that wins (the density
 * and X-ray rules out-rank the nested rule by specificity) and evaluates its
 * declared value with the custom properties the shell sets.
 */
describe("nested row inset", () => {
  const declaration = (selector: string, property: string): string => {
    const rule = rulesMentioning(selector).find((entry) => entry.selectors.includes(selector));
    const value = rule?.body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`))?.[1]?.trim();
    if (!value) throw new Error(`no ${property} on ${selector}`);
    return value;
  };
  const densityRule = (density: string, mentions: string, property: string): string => {
    const rule = rulesMentioning(`[data-density="${density}"]`).find((entry) =>
      entry.selectors[0]!.includes(mentions) && new RegExp(`(?:^|[;\\s])${property}:`).test(entry.body));
    const value = rule?.body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`))?.[1]?.trim();
    if (!value) throw new Error(`no ${density} ${property} rule for ${mentions}`);
    return value;
  };

  /** Evaluates a px length built from calc(), min() and the two custom properties. */
  function px(value: string, vars: Record<string, string>): number {
    let expression = value;
    for (let guard = 0; /var\(/.test(expression); guard += 1) {
      if (guard > 10) throw new Error(`unresolved ${value}`);
      expression = expression.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name: string, fallback?: string) => {
        const resolved = vars[name] ?? fallback;
        if (resolved === undefined) throw new Error(`no ${name} for ${value}`);
        return `(${resolved})`;
      });
    }
    const arithmetic = expression.replace(/min\(/g, "Math.min(").replace(/calc\(/g, "(").replace(/(\d)px/g, "$1");
    if (!/^(?:Math\.min|[\d\s.+\-*/(),])+$/.test(arithmetic)) throw new Error(`not arithmetic: ${arithmetic}`);
    return Number(new Function(`return ${arithmetic};`)());
  }

  /** The left side of `.thread-row`'s padding, from its longhand or any shorthand form. */
  const topLevelInset = (() => {
    const body = rulesMentioning(".thread-row").find((rule) => rule.selectors.includes(".thread-row"))!.body;
    const longhand = body.match(/(?:^|[;\s])padding-left:\s*([^;]+);/)?.[1];
    if (longhand) return px(longhand.trim(), {});
    const sides = declaration(".thread-row", "padding").split(/\s+/);
    return px(sides[[0, 0, 1, 1, 3][sides.length]!]!, {});
  })();
  const topLevelToggle = px(declaration(".thread-row__subthread-toggle", "left"), {});
  const shellInset = rulesMentioning(".thread-row-shell--nested")
    .find((rule) => rule.selectors.includes(".thread-row-shell--nested"))
    ?.body.match(/--thread-row-inline-start:\s*([^;]+);/)?.[1]?.trim();
  const nestedVars = (depth: number): Record<string, string> => ({
    "--thread-row-nested-depth": String(depth),
    ...(shellInset ? { "--thread-row-inline-start": shellInset } : {}),
  });

  type Layout = { inset: number; toggle: number };
  const layouts: Record<string, { top: Layout; nested: (depth: number) => Layout }> = {
    "mission-control": {
      top: { inset: topLevelInset, toggle: topLevelToggle },
      nested: (depth) => ({
        inset: px(declaration(".thread-row-shell--nested .thread-row", "padding-left"), nestedVars(depth)),
        toggle: px(declaration(".thread-row-shell--nested .thread-row__subthread-toggle", "left"), nestedVars(depth)),
      }),
    },
  };
  for (const density of ["compact", "minimal"]) {
    layouts[density] = {
      top: { inset: px(densityRule(density, " .thread-row:not(", "padding-left"), {}), toggle: topLevelToggle },
      nested: (depth) => ({
        inset: px(densityRule(density, " .thread-row:not(", "padding-left"), nestedVars(depth)),
        toggle: px(densityRule(density, ".thread-row-shell--nested", "left"), nestedVars(depth)),
      }),
    };
  }
  // X-ray lifts one row out of the list; it runs in Compact and Minimal only.
  const xrayInset = (vars: Record<string, string>) =>
    px(declaration(".thread-row-shell[data-xray-target] > .thread-row", "padding-left"), vars);

  /**
   * Selector specificity as [ids, classes/attributes/pseudo-classes, types],
   * enough for the selectors below: `:not()` and `:is()` take their most
   * specific argument, and `*` counts nothing.
   */
  function specificity(selector: string): [number, number, number] {
    const total: [number, number, number] = [0, 0, 0];
    const add = (part: [number, number, number]) => part.forEach((value, index) => { total[index]! += value; });
    let rest = selector;
    for (let match = rest.match(/:(?:not|is)\(/); match; match = rest.match(/:(?:not|is)\(/)) {
      let depth = 1;
      let end = match.index! + match[0].length;
      for (; depth > 0; end += 1) depth += rest[end] === "(" ? 1 : rest[end] === ")" ? -1 : 0;
      const inner = splitSelectorList(rest.slice(match.index! + match[0].length, end - 1)).map(specificity);
      add(inner.reduce((best, next) => (compare(next, best) > 0 ? next : best), [0, 0, 0]));
      rest = rest.slice(0, match.index) + " " + rest.slice(end);
    }
    total[0] += (rest.match(/#[\w-]+/g) ?? []).length;
    total[1] += (rest.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    total[2] += (rest.replace(/\[[^\]]+\]/g, " ").match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
    return total;
  }
  function compare(left: [number, number, number], right: [number, number, number]): number {
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  }
  const selectorsOf = (body: { selectors: string[] } | undefined) => body?.selectors ?? [];

  it("lets the density and X-ray rules out-rank the nested rules the model reads past", () => {
    const nestedRow = specificity(".thread-row-shell--nested .thread-row");
    const nestedToggle = specificity(".thread-row-shell--nested .thread-row__subthread-toggle");
    expect(compare(specificity(".thread-row-shell[data-xray-target] > .thread-row"), nestedRow)).toBeGreaterThan(0);
    for (const density of ["compact", "minimal"]) {
      const rules = rulesMentioning(`[data-density="${density}"]`);
      const row = rules.find((rule) => rule.selectors[0]!.includes(" .thread-row:not(") && /padding-left:/.test(rule.body));
      const toggle = rules.find((rule) => rule.selectors[0]!.includes(".thread-row-shell--nested"));
      expect(selectorsOf(row)).toHaveLength(2);
      expect(selectorsOf(toggle)).toHaveLength(2);
      for (const selector of selectorsOf(row)) expect(compare(specificity(selector), nestedRow), selector).toBeGreaterThan(0);
      for (const selector of selectorsOf(toggle)) expect(compare(specificity(selector), nestedToggle), selector).toBeGreaterThan(0);
    }
  });

  for (const [density, layout] of Object.entries(layouts)) {
    it(`${density}: steps each depth in 12px up to the cap, and keeps the chevron's top-level distance`, () => {
      const insets = [1, 2, 3, 4, 5, 6].map((depth) => layout.nested(depth).inset);
      expect(insets[0]).toBeGreaterThanOrEqual(layout.top.inset);
      for (let depth = 2; depth <= 6; depth += 1) {
        const step = insets[depth - 1]! - insets[depth - 2]!;
        expect(step, `depth ${depth}`).toBe(depth <= 4 ? 12 : 0);
      }
      for (let depth = 1; depth <= 6; depth += 1) {
        const nested = layout.nested(depth);
        expect(nested.inset - nested.toggle, `depth ${depth}`).toBe(layout.top.inset - layout.top.toggle);
      }
    });
  }

  it("lifts an X-ray row without moving its title, at any depth", () => {
    expect(xrayInset({})).toBe(layouts.compact!.top.inset);
    for (let depth = 1; depth <= 6; depth += 1) {
      expect(xrayInset(nestedVars(depth)), `depth ${depth}`).toBe(layouts.compact!.nested(depth).inset);
    }
  });
});
