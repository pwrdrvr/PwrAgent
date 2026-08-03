import { describe, expect, it } from "vitest";
import { normalizeLatexMathDelimiters } from "../markdown-math";

describe("normalizeLatexMathDelimiters", () => {
  it("normalizes paired inline and display LaTeX delimiters", () => {
    const input = [
      String.raw`Inline \(a\in\mathbb R\).`,
      "",
      String.raw`\[`,
      String.raw`\forall b\in\mathbb Z,\;b=b.`,
      String.raw`\]`,
    ].join("\n");

    expect(normalizeLatexMathDelimiters(input)).toBe([
      String.raw`Inline $$a\in\mathbb R$$.`,
      "",
      "$$",
      String.raw`\forall b\in\mathbb Z,\;b=b.`,
      "$$",
    ].join("\n"));
  });

  it("keeps replacements length-preserving for source position consumers", () => {
    const input = String.raw`Before \(a=1\) and \[b=2\] after.`;
    expect(normalizeLatexMathDelimiters(input)).toHaveLength(input.length);
  });

  it("leaves unmatched and explicitly escaped delimiters unchanged", () => {
    const input = String.raw`Streaming \(a=1 and literal \\(b=2\\).`;
    expect(normalizeLatexMathDelimiters(input)).toBe(input);
  });

  it("skips repeated unmatched openers without hiding later valid math", () => {
    const unmatched = String.raw`\[`.repeat(10_000);
    const input = [
      unmatched,
      "```txt",
      String.raw`\[protected\]`,
      "```",
      String.raw`\[valid\]`,
    ].join("\n");

    const output = normalizeLatexMathDelimiters(input);

    expect(output.startsWith(unmatched)).toBe(true);
    expect(output).toContain(String.raw`\[protected\]`);
    expect(output.endsWith("$$valid$$")).toBe(true);
  });

  it("does not normalize delimiters inside inline or fenced code", () => {
    const input = [
      "Render \\(outside\\), not `\\(inside\\)`.",
      "",
      "```md",
      String.raw`\(fenced\)`,
      "```",
      "",
      "    \\(indented\\)",
    ].join("\n");

    expect(normalizeLatexMathDelimiters(input)).toBe([
      "Render $$outside$$, not `\\(inside\\)`.",
      "",
      "```md",
      String.raw`\(fenced\)`,
      "```",
      "",
      "    \\(indented\\)",
    ].join("\n"));
  });

  it("protects delimiters in quoted and list-nested fenced code", () => {
    const input = [
      "> ```md",
      String.raw`> \(quoted\)`,
      "> ```",
      "",
      "- ```md",
      String.raw`  \(listed\)`,
      "  ```",
    ].join("\n");

    expect(normalizeLatexMathDelimiters(input)).toBe(input);
  });

  it("does not treat list-like fence text inside a fence as its close", () => {
    const input = [
      "```md",
      "- ```",
      String.raw`\(stillFenced\)`,
      "```",
      String.raw`\(outside\)`,
    ].join("\n");

    expect(normalizeLatexMathDelimiters(input)).toBe([
      "```md",
      "- ```",
      String.raw`\(stillFenced\)`,
      "```",
      "$$outside$$",
    ].join("\n"));
  });

  it("does not close an unmatched code span on a later fence", () => {
    const input = [
      "An unmatched ` marker.",
      "",
      "```md",
      String.raw`\(fenced\)`,
      "```",
      "",
      String.raw`\(outside\)`,
    ].join("\n");

    expect(normalizeLatexMathDelimiters(input)).toBe([
      "An unmatched ` marker.",
      "",
      "```md",
      String.raw`\(fenced\)`,
      "```",
      "",
      "$$outside$$",
    ].join("\n"));
  });
});
