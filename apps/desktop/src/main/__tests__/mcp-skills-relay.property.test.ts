import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_GATEWAY_SKILLS_BYTES,
  MAX_SKILLS_INDEX_CHARS,
  SKILLS_INDEX_INCOMPLETE as MORE,
  listedMcpSkills,
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
// Overlapping pages repeat entries, so some lists carry the same skill twice.
const skillList = fc.array(entry, { maxLength: 80 })
  .chain((skills) => fc.shuffledSubarray(skills).map((repeats) => [...skills, ...repeats]));
const listed = fc.record(
  { skills: skillList, nextCursor: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }) },
  { requiredKeys: ["skills"] },
);

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

  it("names each skill at most once", () => {
    fc.assert(fc.property(listed, (page) => {
      const uris = (skillsAwareInstructions({ listed: page }) ?? "").split("\n")
        .map((line) => /\((skill:\/\/\S+)\)$/u.exec(line)?.[1])
        .filter((uri) => uri !== undefined);
      expect(new Set(uris).size).toBe(uris.length);
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
      const partial = shown < valid.size || (typeof page.nextCursor === "string" && page.nextCursor !== "");
      expect(index.endsWith(`\n${MORE}`)).toBe(partial);
    }));
  });

  it("has nothing to say when there are neither instructions nor skills", () => {
    expect(skillsAwareInstructions({})).toBeUndefined();
    expect(skillsAwareInstructions({ instructions: "  \n", listed: { skills: [] } })).toBeUndefined();
  });
});

/*
 * A gateway thread gets the same skills as structured data. The index is the
 * oracle: whatever both have room for, they name the same skills in the same
 * order, cleaned by the same rules.
 */
describe("structured skills for gateway search", () => {
  const indexUris = (index: string | undefined): string[] => (index ?? "").split("\n")
    .map((line) => /\((skill:\/\/\S+)\)$/u.exec(line)?.[1])
    .filter((uri) => uri !== undefined);

  it("agrees with the instructions index on which skills come first", () => {
    fc.assert(fc.property(listed, (page) => {
      const structured = listedMcpSkills(page).skills.map((skill) => skill.uri);
      const indexed = indexUris(skillsAwareInstructions({ listed: page }));
      const shared = Math.min(structured.length, indexed.length);
      expect(structured.slice(0, shared)).toEqual(indexed.slice(0, shared));
    }));
  });

  it("names only listed skills, once each, on one clean line", () => {
    fc.assert(fc.property(listed, (page) => {
      const { skills } = listedMcpSkills(page);
      const valid = namedUris(page.skills);
      expect(new Set(skills.map((skill) => skill.uri)).size).toBe(skills.length);
      for (const skill of skills) {
        expect(valid.has(skill.uri)).toBe(true);
        expect(skill.name).not.toBe("");
        for (const value of [skill.name, skill.description ?? ""]) {
          expect(value).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
        }
      }
    }));
  });

  it("fits its byte budget and says when it left a skill out", () => {
    fc.assert(fc.property(listed, fc.integer({ min: 2, max: MAX_GATEWAY_SKILLS_BYTES }), (page, maxBytes) => {
      const { skills, complete } = listedMcpSkills(page, maxBytes);
      expect(Buffer.byteLength(JSON.stringify(skills))).toBeLessThanOrEqual(maxBytes);
      const unread = typeof page.nextCursor === "string" && page.nextCursor !== "";
      expect(complete).toBe(!unread && skills.length === namedUris(page.skills).size);
    }));
  });
});

describe("skills extension detection", () => {
  it("relays only a server that advertises the extension", () => {
    expect(offersMcpSkills({ extensions: { "io.modelcontextprotocol/skills": {} } })).toBe(true);
    expect(offersMcpSkills({ extensions: { "io.modelcontextprotocol/other": {} } })).toBe(false);
    expect(offersMcpSkills({})).toBe(false);
    expect(offersMcpSkills(undefined)).toBe(false);
  });

});
