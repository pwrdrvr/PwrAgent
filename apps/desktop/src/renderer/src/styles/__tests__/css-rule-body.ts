import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared reader for the stylesheet-contract tests in this directory.
 *
 * jsdom performs no layout, so a layout invariant can only be pinned by
 * asserting the declarations that produce it. Three tests had grown their own
 * copy of this regex; a copy that gets a CSS rule boundary wrong is wrong
 * quietly, and fixing one copy leaves the others broken.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));

export const appCss = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/**
 * Bodies of every top-level rule whose selector line is exactly `selector`.
 * Plural because a selector can also appear in a grouped rule, and a caller
 * usually wants the standalone block rather than whichever came first.
 */
export function cssRuleBodies(selector: string, css: string = appCss): string[] {
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

/** Every matching rule body joined, for a selector declared more than once. */
export function cssRuleBody(selector: string, css: string = appCss): string {
  return cssRuleBodies(selector, css).join("\n");
}

/** The first matching rule body only. */
export function firstCssRuleBody(
  selector: string,
  css: string = appCss,
): string {
  return cssRuleBodies(selector, css)[0]!;
}
