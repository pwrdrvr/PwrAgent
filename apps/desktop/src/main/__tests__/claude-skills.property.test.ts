import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { AppServerTurnInputItem } from "@pwragent/shared/contracts/normalized-app-server";
import { selectClaudeCommandRows } from "../claude/claude-commands";
import {
  claudeCommandCatalog,
  claudeSkillFileCandidates,
  claudeSkillLinks,
  claudeSkillPrompt,
  type ClaudeSkillEvidence,
  type ClaudeSkillFile,
} from "../claude/claude-skills";

// Names that collide in the ways matching can get wrong: one a prefix of
// another, a plugin-qualified name, and a name ending where punctuation does.
const SKILL_POOL = ["release", "release-notes", "pwragent-scaling-audit", "anthropic-skills:docx", "a", "loc"];
const PUNCTUATION = ["", ".", ",", "!", "?", ";", ":"];

/**
 * One whitespace-separated token of a prompt, with the text Claude must
 * receive for it. Built together, so the expected prompt never comes from the
 * code under test.
 */
type Token = { input: string; output: string; skill?: string };

function tokenArbitrary(known: readonly string[]): fc.Arbitrary<Token> {
  const unknown = SKILL_POOL.filter((name) => !known.includes(name));
  const word = fc.stringMatching(/^[a-z/.,!?]{1,6}$/).map((text): Token => ({ input: text, output: text }));
  const bare = fc.tuple(fc.constantFrom(...known), fc.constantFrom(...PUNCTUATION))
    .map(([name, mark]): Token => ({ input: `$${name}${mark}`, output: `/${name}${mark}`, skill: name }));
  const pickedLink = fc.constantFrom(...known)
    .map((name): Token => ({ input: `[$${name}](/repo/.claude/skills/${name}/SKILL.md)`, output: `/${name}`, skill: name }));
  // Once Claude has listed the folder's skills, a link to one it lacks stays
  // a link: `/name` would be an unknown command.
  const elsewhereLink = fc.constantFrom(...SKILL_POOL).map((name): Token => {
    const input = `[$${name}](/elsewhere/${name}/SKILL.md)`;
    return known.includes(name) ? { input, output: `/${name}`, skill: name } : { input, output: input };
  });
  const untouched = fc.constantFrom(
    "$HOME", "$5", "[$5](https://example.com/price)",
    ...known.map((name) => `$${name}x`),
    ...known.map((name) => `$${name}/`),
    // Markdown code is sent as typed.
    ...known.map((name) => `\`$${name}\``),
    ...known.map((name) => `\`x\`$${name}`),
    ...known.map((name) => `\`[$${name}](/r/${name}/SKILL.md)\``),
    ...unknown.map((name) => `$${name}`),
    ...unknown.map((name) => `[$${name}](https://example.com/${name})`),
  ).map((text): Token => ({ input: text, output: text }));
  return fc.oneof(word, bare, pickedLink, elsewhereLink, untouched);
}

type Item = { kind: "text"; tokens: Token[]; separators: string[] } | { kind: "image" };

function promptArbitrary() {
  return fc.subarray(SKILL_POOL, { minLength: 1 }).chain((known) => fc.record({
    known: fc.constant(known),
    items: fc.array(fc.oneof(
      { weight: 4, arbitrary: fc.array(fc.tuple(tokenArbitrary(known), fc.constantFrom(" ", "  ", "\n")), { minLength: 1, maxLength: 6 })
        .map((pairs): Item => ({ kind: "text", tokens: pairs.map(([token]) => token), separators: pairs.map(([, gap]) => gap) })) },
      { weight: 1, arbitrary: fc.constant<Item>({ kind: "image" }) },
    ), { minLength: 1, maxLength: 4 }),
  }));
}

function build(items: readonly Item[]): { input: AppServerTurnInputItem[]; expected: AppServerTurnInputItem[] } {
  const join = (item: Extract<Item, { kind: "text" }>, side: "input" | "output") =>
    item.tokens.map((token, index) => (index === 0 ? "" : item.separators[index]) + token[side]).join("");
  const skills = new Set(items.flatMap((item) => item.kind === "text" ? item.tokens.flatMap((token) => token.skill ? [token.skill] : []) : []));
  const input: AppServerTurnInputItem[] = [];
  const expected: AppServerTurnInputItem[] = [];
  for (const item of items) {
    if (item.kind === "image") {
      const image: AppServerTurnInputItem = { type: "image", url: "data:image/png;base64,aGVsbG8=" };
      input.push(image);
      expected.push(image);
      continue;
    }
    // Claude starts a block's opening `/skill` directly and hands it the rest
    // of the prompt, so with two skills named, an opening one goes inline.
    const lead = item.tokens[0]?.skill && skills.size > 1 ? " " : "";
    input.push({ type: "text", text: join(item, "input") });
    expected.push({ type: "text", text: lead + join(item, "output") });
  }
  return { input, expected };
}

describe("claudeSkillPrompt", () => {
  it("rewrites every skill mention to /name and leaves all other text as typed", () => {
    fc.assert(fc.property(promptArbitrary(), ({ known, items }) => {
      const { input, expected } = build(items);
      expect(claudeSkillPrompt(input, new Set(known))).toEqual(expected);
    }));
  });

  it("lets a block that opens with a skill start it directly only when the prompt names no other", () => {
    fc.assert(fc.property(promptArbitrary(), ({ known, items }) => {
      const output = claudeSkillPrompt(build(items).input, new Set(known));
      const named = new Set(items.flatMap((item) => item.kind === "text"
        ? item.tokens.flatMap((token) => token.skill ? [token.skill] : [])
        : []));
      items.forEach((item, index) => {
        if (item.kind !== "text" || !item.tokens[0]?.skill) return;
        const sent = output[index];
        expect(sent?.type === "text" && sent.text.startsWith("/")).toBe(named.size === 1);
      });
    }));
  });

  it("is unchanged by a second pass", () => {
    fc.assert(fc.property(promptArbitrary(), ({ known, items }) => {
      const once = claudeSkillPrompt(build(items).input, new Set(known));
      expect(claudeSkillPrompt(once, new Set(known))).toEqual(once);
    }));
  });

  it.each([
    ["a prompt that opens with its only skill", "$release ship v2", "/release ship v2"],
    ["a mention mid-prompt", "please run $release now.", "please run /release now."],
    ["two skills, the first opening the prompt", "$release then $loc", " /release then /loc"],
    ["a picked link", "[$release](/r/.claude/skills/release/SKILL.md) v2", "/release v2"],
    ["a longer skill sharing a prefix", "$release-notes", "/release-notes"],
    ["shell variables", "echo $HOME $5", "echo $HOME $5"],
    ["a fenced block", "```sh\necho $release\n```\nthen $loc", "```sh\necho $release\n```\nthen /loc"],
    ["an unclosed fence", "$loc\n```\n$release", "/loc\n```\n$release"],
    ["inline code", "run `$release` then $release", "run `$release` then /release"],
    ["a mention touching inline code", "`x`$release", "`x`$release"],
    ["a link to a skill Claude lacks", "[$foo](/u/.codex/skills/foo/SKILL.md) do X", "[$foo](/u/.codex/skills/foo/SKILL.md) do X"],
  ])("handles %s", (_name, text, expected) => {
    expect(claudeSkillPrompt([{ type: "text", text }], new Set(["release", "release-notes", "loc"])))
      .toEqual([{ type: "text", text: expected }]);
  });

  // Before Claude lists the folder's skills, the picker's link is the only
  // evidence: it points at a SKILL.md.
  it.each([
    ["a picked link", "[$release](/r/.claude/skills/release/SKILL.md) v2", "/release v2"],
    ["a link to another file", "[$release](/r/notes.md) v2", "[$release](/r/notes.md) v2"],
    ["a bare mention", "$release v2", "$release v2"],
  ])("before the skills are listed, handles %s", (_name, text, expected) => {
    expect(claudeSkillPrompt([{ type: "text", text }], undefined)).toEqual([{ type: "text", text: expected }]);
  });
});

// The pattern the scanner replaces, kept as its oracle.
const SKILL_LINK_ORACLE = /\[\$([^\]\r\n]+)\]\(([^)\r\n]+)\)/g;
// Every character the pattern treats specially, plus filler.
const LINK_ALPHABET = ["[", "$", "]", "(", ")", "a", "/", " ", "\n", "\r", "[$", "](", "[$a](b)"];
// Weighted toward starts that fail on the same line, the input that costs most.
const linkText = fc.array(fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom("[$", "a", " ", "](") },
  { weight: 3, arbitrary: fc.constantFrom(...LINK_ALPHABET) },
), { maxLength: 40, size: "max" }).map((parts) => parts.join(""));

describe("claudeSkillLinks", () => {
  it("finds exactly the links the pattern matches", () => {
    fc.assert(fc.property(linkText, (text) => {
      const expected = [...text.matchAll(SKILL_LINK_ORACLE)].map((match) => ({
        start: match.index, end: match.index + match[0].length, name: match[1], target: match[2],
      }));
      expect(claudeSkillLinks(text)).toEqual(expected);
    }));
  });

  it("scans each character at most once", () => {
    fc.assert(fc.property(linkText, (text) => {
      const work = { chars: 0 };
      claudeSkillLinks(text, work);
      expect(work.chars).toBeLessThanOrEqual(text.length);
    }));
  });

  it.each([
    // A skip past the `]` of a name without a target missed the next link.
    ["[$[][$a](b)", [{ start: 4, end: 11, name: "a", target: "b" }]],
    ["[$x](y) [$](z) [$a](b", [{ start: 0, end: 7, name: "x", target: "y" }]],
  ])("finds the links in %j", (text, expected) => {
    expect(claudeSkillLinks(text)).toEqual(expected);
    expect(expected).toEqual([...text.matchAll(SKILL_LINK_ORACLE)].map((match) => ({
      start: match.index, end: match.index + match[0].length, name: match[1], target: match[2],
    })));
  });

  // Each of these scanned to the end of the line from every `[$` before.
  it.each([
    ["repeated starts", "[$[$[$["],
    ["unclosed names", "[$a ".repeat(2_000)],
    ["names without a target", "[$a] ".repeat(2_000)],
    ["unclosed targets", "[$a](x ".repeat(2_000)],
  ])("reads a long line of %s once", (_name, text) => {
    const work = { chars: 0 };
    expect(claudeSkillLinks(text, work)).toEqual([]);
    expect(work.chars).toBeLessThanOrEqual(text.length);
  });
});

const NAME_POOL = ["init", "review", "release", "deploy", "mcp__github__pr", "plugin:lint", "dot.name"];

function catalogArbitrary() {
  const row = fc.record({
    name: fc.constantFrom(...NAME_POOL),
    builtin: fc.boolean(),
  }).map(({ name, builtin }): SlashCommand => ({ name, description: `${name} (project)`, argumentHint: "", ...(builtin ? { builtin } : {}) }));
  const evidence = fc.record({
    name: fc.constantFrom(...NAME_POOL),
    kind: fc.constantFrom("skill", "command"),
    source: fc.constantFrom("userSettings", "projectSettings", "syncedSkills", "plugin"),
  }).map(({ name, kind, source }): ClaudeSkillEvidence => ({
    name, source, tokens: 1,
    path: kind === "skill" ? `/p/.claude/skills/${name}/SKILL.md` : `/p/.claude/commands/${name}.md`,
  }));
  const file = fc.constantFrom(...NAME_POOL)
    .map((name): [string, ClaudeSkillFile] => [name, { path: `/home/.claude/skills/${name}/SKILL.md`, scope: "claude-user" }]);
  return fc.record({
    commands: fc.array(row, { maxLength: 12, size: "max" }),
    terminal: fc.subarray(NAME_POOL),
    skillEvidence: fc.uniqueArray(evidence, { selector: (entry) => entry.name, maxLength: 7 }),
    files: fc.array(file, { maxLength: 7 }),
  });
}

describe("claudeCommandCatalog", () => {
  it("puts each command Claude would run in exactly one of / and $", () => {
    fc.assert(fc.property(catalogArbitrary(), ({ commands, terminal, skillEvidence, files }) => {
      const terminalCommands = new Set(terminal);
      const catalog = claudeCommandCatalog({ commands, terminalCommands, skillEvidence, skillFiles: new Map(files) });
      const shown = [...catalog.commands.map((entry) => entry.name), ...catalog.skills.map((entry) => entry.name)];
      expect(shown.toSorted()).toEqual(selectClaudeCommandRows(commands, terminalCommands).map((entry) => entry.name).toSorted());
    }));
  });

  it("offers a skill only where /name starts that skill's own SKILL.md", () => {
    fc.assert(fc.property(catalogArbitrary(), ({ commands, terminal, skillEvidence, files }) => {
      const skillFiles = new Map(files);
      const catalog = claudeCommandCatalog({ commands, terminalCommands: new Set(terminal), skillEvidence, skillFiles });
      for (const skill of catalog.skills) {
        // A built-in row of the same name is the one `/name` runs.
        expect(commands.some((entry) => entry.name === skill.name && entry.builtin)).toBe(false);
        expect(skill.path).toMatch(/[\\/]SKILL\.md$/);
        const listed = skillEvidence.find((entry) => entry.name === skill.name);
        // Claude's own listing outranks the folder lookup: a listed custom
        // command never becomes a skill because a folder shares its name.
        expect(skill.path).toBe(listed ? listed.path : skillFiles.get(skill.name)?.path);
        expect(skill.description).not.toMatch(/\(project\)$/);
      }
    }));
  });

  it("looks on disk only for plain names Claude did not list", () => {
    fc.assert(fc.property(catalogArbitrary(), ({ commands, terminal, skillEvidence }) => {
      for (const name of claudeSkillFileCandidates(commands, new Set(terminal), skillEvidence)) {
        expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
        expect(skillEvidence.some((entry) => entry.name === name)).toBe(false);
        expect(selectClaudeCommandRows(commands, new Set(terminal)).find((entry) => entry.name === name)?.builtin).toBeFalsy();
      }
    }));
  });
});
