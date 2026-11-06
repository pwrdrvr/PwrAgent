import { describe, expect, it } from "vitest";
import {
  backendDrawsCommandChips,
  buildCommandChipTooltip,
  describeLeadingCommand,
  findLeadingCommand,
  leadingCommandArgumentHint,
  type ComposerChipCommand,
} from "../composer-command-chip";

const CODE_REVIEW: ComposerChipCommand = {
  aliases: ["review"],
  argumentHint: "[low|medium|high] [--fix]",
  description: "Review the current diff",
  name: "code-review",
};
const COMPACT: ComposerChipCommand = { name: "compact" };
const COMMANDS = [CODE_REVIEW, COMPACT];

// Oracle: Claude reads a command only when the prompt starts with `/name`
// followed by whitespace or nothing. The chip must claim exactly those drafts.
function claudeRunsCommand(draft: string, names: readonly string[]): string | undefined {
  if (!draft.startsWith("/")) return undefined;
  const token = draft.slice(1).split(/\s/, 1)[0] ?? "";
  return names.includes(token.toLowerCase()) ? `/${token}` : undefined;
}

describe("findLeadingCommand", () => {
  const names = ["code-review", "review", "compact"];
  const drafts = [
    "/code-review", "/code-review ", "/code-review high --fix", "/code-review\nnotes",
    "/CODE-REVIEW high", "/review", "/compact", " /code-review", "x /code-review",
    "/code-reviewer", "/code-review/x", "/", "", "/unknown high", "$code-review",
  ];

  it("agrees with where Claude reads a command, for every draft", () => {
    for (const draft of drafts) {
      const expected = claudeRunsCommand(draft, names);
      // `/code-review/x` is one path-like token to Claude too.
      const found = findLeadingCommand(draft, COMMANDS);
      expect(found?.text, draft).toBe(expected);
    }
  });

  it("resolves an alias to its command", () => {
    expect(findLeadingCommand("/review high", COMMANDS)?.command).toBe(CODE_REVIEW);
  });
});

describe("leadingCommandArgumentHint", () => {
  it("draws the hint only until an argument is typed", () => {
    const hint = (draft: string) =>
      leadingCommandArgumentHint(findLeadingCommand(draft, COMMANDS));
    expect(hint("/code-review")).toBe(" [low|medium|high] [--fix]");
    expect(hint("/code-review ")).toBe("[low|medium|high] [--fix]");
    expect(hint("/code-review   ")).toBe("[low|medium|high] [--fix]");
    expect(hint("/code-review h")).toBeUndefined();
    expect(hint("/code-review \n")).toBeUndefined();
    expect(hint("/compact ")).toBeUndefined();
    expect(hint("hello")).toBeUndefined();
  });
});

describe("buildCommandChipTooltip", () => {
  it("names the usage line, then the description", () => {
    expect(buildCommandChipTooltip(CODE_REVIEW)).toBe(
      "/code-review [low|medium|high] [--fix]\nReview the current diff",
    );
    expect(buildCommandChipTooltip(COMPACT)).toBe("/compact");
  });
});

describe("backendDrawsCommandChips", () => {
  it("chips commands for Claude and ACP agents, not Codex", () => {
    expect(backendDrawsCommandChips("claude")).toBe(true);
    expect(backendDrawsCommandChips("acp:grok")).toBe(true);
    expect(backendDrawsCommandChips("acp:qwen")).toBe(true);
    expect(backendDrawsCommandChips("codex")).toBe(false);
    expect(backendDrawsCommandChips(undefined)).toBe(false);
  });
});

describe("describeLeadingCommand", () => {
  const base = { commands: COMMANDS, showHint: true, skillTokens: [] };

  it("draws the chip and hint for a leading command", () => {
    expect(describeLeadingCommand({ ...base, draft: "/code-review " })).toEqual({
      chip: {
        text: "/code-review",
        tooltip: "/code-review [low|medium|high] [--fix]\nReview the current diff",
      },
      hint: "[low|medium|high] [--fix]",
    });
  });

  it("keeps the chip but not the hint when something else owns that space", () => {
    expect(describeLeadingCommand({ ...base, draft: "/code-review ", showHint: false }))
      .toEqual({ chip: expect.objectContaining({ text: "/code-review" }) });
  });

  it("draws nothing when a mention chip starts the prompt", () => {
    expect(describeLeadingCommand({
      ...base,
      draft: "/code-review ",
      skillTokens: [{ index: 0 }],
    })).toEqual({});
  });
});
