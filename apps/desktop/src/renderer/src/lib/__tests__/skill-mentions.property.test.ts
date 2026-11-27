import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { listMentionedSkills, parseSkillMentionParts, type SkillMentionPart } from "../skill-mentions";

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

describe("listMentionedSkills", () => {
  const name = fc.constantFrom("a", "a.b", "a b", "a $b", "b", "[", "?", "🚀", "");
  const path = fc.constantFrom("/a", "/b", "/c");
  const catalog = fc.array(fc.record({ name, path }), { maxLength: 16, size: "max" });
  const token = fc.oneof(
    name.map((value) => `$${value}`),
    fc.tuple(name, path).map(([label, target]) => `[$${label}](${target})`),
    fc.constantFrom(" ", "\t", "/", "\n", ",", "!", "."),
  );

  it("retains catalog order, path identity and every literal name with a matching boundary", () => {
    fc.assert(fc.property(catalog, fc.array(token, { maxLength: 30, size: "max" }), (skills, tokens) => {
      const text = tokens.join("");
      const expected = new Map<string, { name: string; path: string }>();
      for (const part of expectedParts(text)) {
        if (part.type !== "skill") continue;
        expected.set(part.path, skills.find((skill) => skill.path === part.path) ?? { name: part.name, path: part.path });
      }
      for (const skill of skills) {
        const literal = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(^|\\s)\\$${literal}(?=$|\\s|[.,!?;:])`).test(text)) expected.set(skill.path, skill);
      }
      expect(listMentionedSkills(text, skills)).toEqual([...expected.values()]);
    }));
  });

  it("looks for bare mentions without restarting a draft search per catalog row", () => {
    const text = "See $s31, then $s31.";
    const skills = Array.from({ length: 32 }, (_, i) => ({ name: `s${i}` }));
    let fullSearches = 0;
    const exec = RegExp.prototype.exec;
    const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input) {
      if (input === text && this.lastIndex === 0) fullSearches += 1;
      return exec.call(this, input);
    });
    try {
      expect(listMentionedSkills(text, skills)).toEqual([skills[31]]);
    } finally {
      spy.mockRestore();
    }
    expect(fullSearches).toBeLessThanOrEqual(2);
  });

  it("resolves repeated explicit chips in one traversal of the catalog", () => {
    let pathReads = 0;
    const skills = Array.from({ length: 32 }, (_, i) => ({
      name: `s${i}`,
      get path() { pathReads += 1; return `/p/${i}`; },
    }));
    const result = listMentionedSkills("[$s31](/p/31) ".repeat(32), skills);
    expect(pathReads).toBeLessThanOrEqual(skills.length);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(skills[31]);
  });
});
