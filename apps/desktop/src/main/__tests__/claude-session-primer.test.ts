import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared";
import { buildClaudeSessionPrimer } from "../claude/claude-session-primer";

const message = (role: "user" | "assistant", text: string, id: string): AppServerThreadEntry =>
  ({ type: "message", id, role, text }) as AppServerThreadEntry;

const entries = fc.array(
  fc.tuple(fc.constantFrom("user" as const, "assistant" as const), fc.string({ maxLength: 12_000 })),
  { maxLength: 40 },
).map((rows) => rows.map(([role, text], index) => message(role, text, `m${index}`)));

describe("Claude session primer", () => {
  it("stays within its bound and keeps the newest messages, oldest first", () => {
    fc.assert(fc.property(entries, fc.integer({ min: 2_000, max: 60_000 }), (thread, maxChars) => {
      const primer = buildClaudeSessionPrimer(thread, maxChars);
      const nonEmpty = thread.filter((entry) => entry.type === "message" && entry.text.trim());
      if (!primer) {
        // Nothing to carry, or not even the newest message fits.
        // Messages are shortened to 8,000 characters, so the newest always
        // fits once the limit leaves room for one beside the header.
        if (nonEmpty.length) expect(maxChars).toBeLessThan(8_500);
        return;
      }
      expect(primer.length).toBeLessThanOrEqual(maxChars);
      const last = nonEmpty.at(-1)!;
      // The newest message is always the last one carried.
      if (last.type === "message" && last.text.trim().length < 1_000) {
        const line = `\n${last.role === "user" ? "Operator" : "Claude"}: ${last.text.trim()}\n\nEnd of the earlier conversation.`;
        expect(primer.endsWith(line.slice(1) + " The operator's new message follows.") || primer.includes(line)).toBe(true);
      }
    }));
  });

  it("labels who said what, notes what it leaves out, and carries nothing from an empty thread", () => {
    expect(buildClaudeSessionPrimer([])).toBeUndefined();
    expect(buildClaudeSessionPrimer([message("user", "   ", "a")])).toBeUndefined();
    const primer = buildClaudeSessionPrimer([
      message("user", "first question", "a"),
      message("assistant", "x".repeat(500), "b"),
      message("user", "latest question", "c"),
    ], 900)!;
    expect(primer).toContain("Operator: latest question");
    expect(primer).not.toContain("first question");
    expect(primer).toMatch(/\(\d+ earlier messages? (is|are) not included\.\)/);
    expect(primer).toContain("Tool calls and their output are not included");
  });
});
