import { describe, expect, it } from "vitest";
import { filterBufferedSecrets } from "../filterBufferedSecrets";

describe("filterBufferedSecrets", () => {
  it("strips trailing newlines that clipboard pastes on macOS routinely include", () => {
    // Reviewer flagged this as B1: a pasted xAI key with a trailing
    // \n was previously stored verbatim, then Grok auth failed with
    // a cryptic error. The filter now `.trim()`s before passing the
    // value to the keychain-write IPC.
    expect(
      filterBufferedSecrets({ grokApiKey: "xai-abc123\n" }),
    ).toEqual({ grokApiKey: "xai-abc123" });
  });

  it("strips leading + trailing whitespace alike", () => {
    expect(
      filterBufferedSecrets({ telegramBotToken: "  111:bot  " }),
    ).toEqual({ telegramBotToken: "111:bot" });
  });

  it("drops whitespace-only values entirely (treated as 'no value')", () => {
    expect(filterBufferedSecrets({ grokApiKey: "   " })).toEqual({});
    expect(filterBufferedSecrets({ grokApiKey: "\n\t " })).toEqual({});
  });

  it("drops empty-string values", () => {
    expect(filterBufferedSecrets({ grokApiKey: "" })).toEqual({});
  });

  it("preserves non-string sentinels by dropping them, not throwing", () => {
    // Defensive against future callers passing through unsanitized
    // data. The `Record<string, string>` type is advisory at
    // runtime since renderer state can land here from IPC bridges.
    const messy = {
      grokApiKey: "valid",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      telegramBotToken: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      discordBotToken: 123 as any,
    };
    expect(filterBufferedSecrets(messy)).toEqual({ grokApiKey: "valid" });
  });

  it("returns a fresh object — input is not mutated", () => {
    const input = { grokApiKey: " xai " };
    const result = filterBufferedSecrets(input);
    expect(input).toEqual({ grokApiKey: " xai " });
    expect(result).not.toBe(input);
  });

  it("passes through multiple valid secrets", () => {
    expect(
      filterBufferedSecrets({
        grokApiKey: "xai-key",
        telegramBotToken: "111:bot",
        slackBotToken: "xoxb-...",
      }),
    ).toEqual({
      grokApiKey: "xai-key",
      telegramBotToken: "111:bot",
      slackBotToken: "xoxb-...",
    });
  });
});
