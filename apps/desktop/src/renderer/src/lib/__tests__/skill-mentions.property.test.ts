import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseSkillMentionParts, type SkillMentionPart } from "../skill-mentions";

// The original renderer regex defines both the accepted syntax and which overlapping start wins.
const MENTION_ORACLE = /\[([$@][^\]\r\n]+)\]\(([^)\r\n]+)\)/g;

function expectedParts(text: string): SkillMentionPart[] {
  const parts: SkillMentionPart[] = [];
  let end = 0;
  for (const match of text.matchAll(MENTION_ORACLE)) {
    if (match.index > end) parts.push({ type: "text", text: text.slice(end, match.index) });
    const [, label, path] = match;
    parts.push({ type: label.startsWith("@") ? "directory" : "skill", label, name: label.slice(1), path });
    end = match.index + match[0].length;
  }
  if (end < text.length || !parts.length) parts.push({ type: "text", text: text.slice(end) });
  return parts;
}

const draft = fc.array(fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("[$", "[@", "a", " ") },
  { weight: 2, arbitrary: fc.constantFrom("[", "$", "@", "]", "(", ")", "/", "\n", "\r") },
  { weight: 1, arbitrary: fc.constantFrom("](", "[$a] ", "[$a](a)", "[@a](/)", "[$[]") },
), { maxLength: 60, size: "max" }).map((tokens) => tokens.join(""));

describe("parseSkillMentionParts", () => {
  it("returns exactly the parts selected by the original regex", () => {
    fc.assert(fc.property(draft, (text) => {
      expect(parseSkillMentionParts(text)).toEqual(expectedParts(text));
    }));
  });

  it("scans each draft once", () => {
    fc.assert(fc.property(draft, (text) => {
      const work = { chars: 0 };
      parseSkillMentionParts(text, work);
      expect(work.chars).toBe(text.length);
    }));
  });

  it.each([
    ["unclosed skill names", "[$a ".repeat(2_000)],
    ["unclosed directory names", "[@a ".repeat(2_000)],
    ["names without targets", "[$a] ".repeat(2_000)],
    ["unclosed targets", "[$a](x ".repeat(2_000)],
    ["overlapping starts", "[$[$[$["],
    ["a trailing opening bracket in a name", "[$["],
  ])("preserves %s as text in one pass", (_description, text) => {
    const work = { chars: 0 };
    expect(parseSkillMentionParts(text, work)).toEqual([{ type: "text", text }]);
    expect(work.chars).toBe(text.length);
  });

  it("keeps a directory link immediately after nested skill starts", () => {
    expect(parseSkillMentionParts("[$[$][@a](/)")).toEqual([
      { type: "text", text: "[$[$]" },
      { type: "directory", label: "@a", name: "a", path: "/" },
    ]);
  });

  it("keeps the link immediately after a name without a target", () => {
    expect(parseSkillMentionParts("[$[][$a](b)")).toEqual([
      { type: "text", text: "[$[]" },
      { type: "skill", label: "$a", name: "a", path: "b" },
    ]);
  });
});
