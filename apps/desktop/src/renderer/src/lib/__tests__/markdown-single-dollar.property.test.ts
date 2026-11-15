import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { hasPotentialMarkdownMath } from "../markdown-math-detection";
import { markdownMathRuntime } from "../markdown-math-runtime";

function renderMath(source: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    children: markdownMathRuntime.normalize(source),
    remarkPlugins: [remarkGfm, ...markdownMathRuntime.remarkPlugins],
    rehypePlugins: markdownMathRuntime.rehypePlugins,
  }));
}

const expression = fc.oneof(
  fc.constantFrom("A", "B", "s", "-x", "-1", "(x,y)", "V^*", String.raw`\lambda\ge1`, String.raw`2^{O(\lambda)}`),
  fc.tuple(fc.constantFrom("x", "y", "n"), fc.integer({ min: 0, max: 99 }))
    .map(([variable, power]) => `${variable}^{${power}}`),
);

describe("single-dollar Markdown math", () => {
  // Both standard inline delimiters must typeset the same expression, and
  // the source-only loading hint must never hide supported math.
  it("agrees with the LaTeX-delimiter rendering oracle", () => {
    fc.assert(fc.property(expression, fc.constantFrom(".", ",", ")", ";", "\nnext", "-bit", " after"), (tex, suffix) => {
      const source = `Before $${tex}$${suffix}`;
      expect(renderMath(source)).toBe(renderMath(String.raw`Before \(${tex}\)` + suffix));
      expect(hasPotentialMarkdownMath(source)).toBe(true);
    }), { numRuns: 50 });
  });

  it("keeps generated prices literal beside real math", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 99_999 }),
      fc.integer({ min: 1, max: 99_999 }),
      expression,
      fc.constantFrom("*", "**", "_", "__", "~~", "***"),
      (first, second, tex, marker) => {
        const prices = `Parts cost $${first} and $${second}.`;
        for (const source of [
          `${prices} Formula ($${tex}$).`,
          `${prices} Code: \`$${tex}$\`. Formula $${tex}$.`,
          `${prices} Formula ${marker}$${tex}$${marker}.`,
        ]) {
          const html = renderMath(source);
          expect(html).toContain(prices);
          expect(html.match(/class="katex"/g)).toHaveLength(1);
          if (source.includes("Code:")) expect(html).toContain(`<code>$${tex}$</code>`);
        }
        expect(hasPotentialMarkdownMath(prices)).toBe(false);
      },
    ), { numRuns: 50 });
  });

  it("never suppresses parser-supported math at GFM cell boundaries", () => {
    fc.assert(fc.property(expression, fc.constantFrom("", " ", "  "), (tex, padding) => {
      const source = `|Value|Other|\n|---|---|\n|${padding}$${tex}$${padding}|text|`;
      const html = renderMath(source);
      expect(html).toContain("<table>");
      expect(html.match(/class="katex"/g)).toHaveLength(1);
      expect(hasPotentialMarkdownMath(source)).toBe(true);
    }), { numRuns: 50 });
  });
});
