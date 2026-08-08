import { describe, expect, it } from "vitest";
import { filterBufferedSecrets } from "../filterBufferedSecrets";

describe("filterBufferedSecrets", () => {
  it("strips trailing newlines that clipboard pastes on macOS routinely include", () => {
    // Clipboard pastes on macOS routinely include a trailing newline.
    // The filter trims it before passing the value to keychain-write IPC.
    expect(
      filterBufferedSecrets({ mattermostBotToken: "mattermost-token\n" }),
    ).toEqual({ mattermostBotToken: "mattermost-token" });
  });

  it("strips leading + trailing whitespace alike", () => {
    expect(
      filterBufferedSecrets({ telegramBotToken: "  111:bot  " }),
    ).toEqual({ telegramBotToken: "111:bot" });
  });

  it("drops whitespace-only values entirely (treated as 'no value')", () => {
    expect(filterBufferedSecrets({ mattermostBotToken: "   " })).toEqual({});
    expect(filterBufferedSecrets({ mattermostBotToken: "\n\t " })).toEqual({});
  });

  it("drops empty-string values", () => {
    expect(filterBufferedSecrets({ mattermostBotToken: "" })).toEqual({});
  });

  it("preserves non-string sentinels by dropping them, not throwing", () => {
    // Defensive against future callers passing through unsanitized
    // data. The `Record<string, string>` type is advisory at
    // runtime since renderer state can land here from IPC bridges.
    const messy = {
      mattermostBotToken: "valid",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      telegramBotToken: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      discordBotToken: 123 as any,
    };
    expect(filterBufferedSecrets(messy)).toEqual({ mattermostBotToken: "valid" });
  });

  it("returns a fresh object — input is not mutated", () => {
    const input = { mattermostBotToken: " mattermost " };
    const result = filterBufferedSecrets(input);
    expect(input).toEqual({ mattermostBotToken: " mattermost " });
    expect(result).not.toBe(input);
  });

  it("passes through multiple valid secrets", () => {
    expect(
      filterBufferedSecrets({
        mattermostBotToken: "mattermost-key",
        telegramBotToken: "111:bot",
        slackBotToken: "xoxb-...",
      }),
    ).toEqual({
      mattermostBotToken: "mattermost-key",
      telegramBotToken: "111:bot",
      slackBotToken: "xoxb-...",
    });
  });
});
