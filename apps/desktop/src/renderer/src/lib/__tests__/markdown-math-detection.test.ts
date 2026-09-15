import { describe, expect, it } from "vitest";
import { hasPotentialMarkdownMath } from "../markdown-math-detection";

describe("hasPotentialMarkdownMath", () => {
  it.each([
    "$$x$$", "$$$x$$$", "$$\nx\n$$", "$$\nx", "text $$",
    String.raw`\(x\)`, String.raw`\[x\]`, String.raw`unfinished \(`,
    "```math\nx\n```", "~~~math\nx\n~~~", "> ```math\nx",
    "- ````math extra\nx", "```m&#97;th\nx", "~~~&#109;ath\nx",
    "```m&#x61;th\nx", "```math&#32;extra\nx",
  ])("accepts supported syntax and streaming openers: %s", (text) => {
    expect(hasPotentialMarkdownMath(text)).toBe(true);
  });

  it.each([
    "", "Ordinary **Markdown**", "A $5 part and $10 part", "$x$",
    "```ts\nconst x = 1;\n```", "~~~python\nprint('hello')\n~~~",
    "A `code span`", "[link](https://example.com)", "Streaming \\",
    "`".repeat(100_000), "~".repeat(100_000),
  ])("does not request math for ordinary text", (text) => {
    expect(hasPotentialMarkdownMath(text)).toBe(false);
  });

  it.each([
    String.raw`\$\$x`, // No adjacent dollar pair, so no math hint.
  ])("ignores independently escaped dollar signs", (text) => {
    expect(hasPotentialMarkdownMath(text)).toBe(false);
  });

  it.each([
    "`$$x$$`", String.raw`\\(literal\\)`, "```txt\n$$x$$\n```",
    "    $$x$$", "```mathematica\nx\n```", "```a&amp;b\nx\n```",
  ])("allows harmless source false positives: %s", (text) => {
    expect(hasPotentialMarkdownMath(text)).toBe(true);
  });
});
