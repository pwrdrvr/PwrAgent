import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_SKILLS_INDEX_CHARS,
  isMcpSkillsMethod,
  offersMcpSkills,
  skillsAwareInstructions,
} from "../mcp-connections/mcp-skills-relay";

/*
 * The rules a thread's agent depends on when a server publishes skills:
 * a server's own instructions are never rewritten, the index stays bounded,
 * it names only skills the server listed, and it says so when it is partial.
 */

const text = fc.string({ unit: "binary", maxLength: 400 });
const skillUri = fc.stringMatching(/^skill:\/\/[a-z0-9.]{1,20}\/[a-z0-9-]{1,40}\/SKILL\.md$/u);
const entry = fc.oneof(
  { weight: 6, arbitrary: fc.record({ uri: skillUri, frontmatter: fc.record({ name: text, description: text }) }) },
  // What a server might also send: a wrong scheme, no name, or no object at all.
  { weight: 1, arbitrary: fc.record({ uri: text, frontmatter: fc.record({ name: text }) }) },
  { weight: 1, arbitrary: fc.record({ uri: skillUri }) },
  { weight: 1, arbitrary: fc.anything() },
);
const listed = fc.record(
  { skills: fc.array(entry, { maxLength: 80 }), nextCursor: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }) },
  { requiredKeys: ["skills"] },
);

const MORE = "More skills are listed by skills/list.";

function namedUris(skills: unknown[]): Set<string> {
  const uris = new Set<string>();
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    const { uri, frontmatter } = skill as { uri?: unknown; frontmatter?: { name?: unknown } };
    const name = frontmatter && typeof frontmatter === "object" ? frontmatter.name : undefined;
    if (typeof uri === "string" && uri.startsWith("skill://") && !/\s/u.test(uri)
      && typeof name === "string" && name.replace(/[\p{Cc}\s\p{Zl}\p{Zp}]/gu, "") !== "") uris.add(uri);
  }
  return uris;
}

describe("skills-aware instructions", () => {
  it("returns a server's own instructions unchanged, whatever it lists", () => {
    fc.assert(fc.property(text.filter((value) => value.trim() !== ""), listed, (instructions, page) => {
      expect(skillsAwareInstructions({ instructions, listed: page })).toBe(instructions);
    }));
  });

  it("stays within the index budget", () => {
    fc.assert(fc.property(listed, (page) => {
      expect((skillsAwareInstructions({ listed: page }) ?? "").length).toBeLessThanOrEqual(MAX_SKILLS_INDEX_CHARS);
    }));
  });

  it("names only skills the server listed, one per line", () => {
    fc.assert(fc.property(listed, (page) => {
      const index = skillsAwareInstructions({ listed: page });
      if (index === undefined) return;
      const valid = namedUris(page.skills);
      const [, ...rest] = index.split("\n");
      const lines = rest.at(-1) === MORE ? rest.slice(0, -1) : rest;
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const uri = /\((skill:\/\/\S+)\)$/u.exec(line)?.[1];
        expect(uri && valid.has(uri), line).toBe(true);
        expect(line).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      }
    }));
  });

  it("says more skills exist exactly when the index is partial", () => {
    fc.assert(fc.property(listed, (page) => {
      const index = skillsAwareInstructions({ listed: page });
      const valid = namedUris(page.skills);
      if (index === undefined) {
        expect(valid.size).toBe(0);
        return;
      }
      const shown = index.split("\n").filter((line) => line.startsWith("- ")).length;
      const validEntries = page.skills.filter((skill) => {
        const uri = (skill as { uri?: unknown } | null)?.uri;
        return typeof uri === "string" && valid.has(uri);
      }).length;
      const partial = shown < validEntries || (typeof page.nextCursor === "string" && page.nextCursor !== "");
      expect(index.endsWith(`\n${MORE}`)).toBe(partial);
    }));
  });

  it("has nothing to say when there are neither instructions nor skills", () => {
    expect(skillsAwareInstructions({})).toBeUndefined();
    expect(skillsAwareInstructions({ instructions: "  \n", listed: { skills: [] } })).toBeUndefined();
  });
});

describe("skills extension detection", () => {
  it("relays only a server that advertises the extension", () => {
    expect(offersMcpSkills({ extensions: { "io.modelcontextprotocol/skills": {} } })).toBe(true);
    expect(offersMcpSkills({ extensions: { "io.modelcontextprotocol/other": {} } })).toBe(false);
    expect(offersMcpSkills({})).toBe(false);
    expect(offersMcpSkills(undefined)).toBe(false);
  });

  it("recognizes the extension's three methods and nothing else", () => {
    expect(["skills/list", "skills/get", "resources/directory/read"].every(isMcpSkillsMethod)).toBe(true);
    expect(["resources/read", "tools/call", "skills/delete", undefined].some(isMcpSkillsMethod)).toBe(false);
  });
});
