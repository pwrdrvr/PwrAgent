import { describe, expect, it } from "vitest";
import { stripTelegramBotMention } from "../telegram-adapter.ts";

describe("stripTelegramBotMention", () => {
  const USERNAME = "PwrAgentBot";

  it("strips a leading @username mention and returns the verb remainder", () => {
    expect(stripTelegramBotMention(`@${USERNAME} help`, USERNAME)).toBe("help");
  });

  it("preserves args after the verb", () => {
    expect(stripTelegramBotMention(`@${USERNAME} resume thread-42`, USERNAME)).toBe(
      "resume thread-42",
    );
  });

  it("matches case-insensitively (Telegram usernames are case-insensitive)", () => {
    expect(stripTelegramBotMention(`@${USERNAME.toLowerCase()} help`, USERNAME)).toBe(
      "help",
    );
    expect(stripTelegramBotMention(`@${USERNAME.toUpperCase()} help`, USERNAME)).toBe(
      "help",
    );
  });

  it("tolerates leading whitespace before the mention", () => {
    expect(stripTelegramBotMention(`   @${USERNAME} help`, USERNAME)).toBe("help");
  });

  it("returns an empty string when the mention is the entire message", () => {
    expect(stripTelegramBotMention(`@${USERNAME}`, USERNAME)).toBe("");
    expect(stripTelegramBotMention(`@${USERNAME}   `, USERNAME)).toBe("");
  });

  it("returns undefined when the message doesn't start with the mention", () => {
    expect(stripTelegramBotMention(`hi @${USERNAME} help`, USERNAME)).toBeUndefined();
    expect(stripTelegramBotMention("just text", USERNAME)).toBeUndefined();
  });

  it("returns undefined when a longer username matches as a prefix", () => {
    // `@PwrAgentBot2 help` must NOT match `PwrAgentBot` — it's a
    // different bot. The word-boundary check guards this.
    expect(stripTelegramBotMention(`@${USERNAME}2 help`, USERNAME)).toBeUndefined();
  });

  it("returns undefined when botUsername is unset", () => {
    expect(stripTelegramBotMention(`@${USERNAME} help`, undefined)).toBeUndefined();
  });
});
