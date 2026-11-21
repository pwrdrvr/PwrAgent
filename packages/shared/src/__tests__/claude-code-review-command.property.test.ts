import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isBareClaudeCodeReviewCommand } from "../review-command";

/**
 * Oracle: split on whitespace; the draft is bare when it is exactly one word
 * and that word is `/code-review` in any letter case.
 */
function oracle(input: string): boolean {
  const words = input.split(/\s+/).filter(Boolean);
  return words.length === 1 && words[0]!.toLowerCase() === "/code-review";
}

const whitespace = fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), maxLength: 3 });
const name = fc.constantFrom(
  "/code-review", "/CODE-REVIEW", "/Code-Review", "/code-reviewer", "/review", "code-review", "/code review",
);
const argument = fc.constantFrom("", "high", "ultra", "12", "--fix", "./src", "main");

describe("isBareClaudeCodeReviewCommand", () => {
  /**
   * Rule: only a bare `/code-review` opens PwrAgent's review panel or
   * messaging review; any argument, or any other command, is the agent's own.
   */
  it("is true exactly for /code-review with no arguments", () => {
    fc.assert(fc.property(whitespace, name, whitespace, argument, whitespace, (lead, command, gap, arg, tail) => {
      const input = `${lead}${command}${arg ? `${gap || " "}${arg}` : gap}${tail}`;
      expect(isBareClaudeCodeReviewCommand(input)).toBe(oracle(input));
    }));
  });
});
