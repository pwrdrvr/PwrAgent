import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMeMock = vi.fn();
const botConstructor = vi.fn();

// Stub grammy at the module boundary so we don't issue real network
// calls. The test asserts that `validateCredentials` constructs a Bot
// with the provided token and calls `bot.api.getMe()` exactly once.
vi.mock("grammy", () => {
  return {
    Bot: vi.fn(function MockBot(token: string) {
      botConstructor(token);
      return {
        api: { getMe: getMeMock },
      };
    }),
    InputFile: class {},
  };
});

import { scrubBotToken, validateCredentials } from "../validate-credentials.ts";

beforeEach(() => {
  getMeMock.mockReset();
  botConstructor.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram validateCredentials", () => {
  it("returns ok with @username when getMe succeeds", async () => {
    getMeMock.mockResolvedValue({
      id: 1,
      is_bot: true,
      username: "pwragent_bot",
      first_name: "PwrAgent",
    });
    const result = await validateCredentials({ botToken: "12345:abcdef" });
    expect(result.status).toBe("ok");
    expect(result.account).toBe("@pwragent_bot");
    expect(result.detail).toBe("api.telegram.org");
    expect(botConstructor).toHaveBeenCalledExactlyOnceWith("12345:abcdef");
    expect(getMeMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to first_name when username is absent", async () => {
    getMeMock.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "PwrAgent",
    });
    const result = await validateCredentials({ botToken: "12345:abcdef" });
    expect(result.status).toBe("ok");
    expect(result.account).toBe("PwrAgent");
  });

  it("falls back to Bot #<id> when only id is present", async () => {
    // Defensive cover for SDK shape drift / partial responses.
    // Telegram's getMe contract guarantees username + first_name on
    // bot accounts, but we don't want a malformed response to render
    // an empty pill in the UI.
    getMeMock.mockResolvedValue({ id: 42 });
    const result = await validateCredentials({ botToken: "12345:abcdef" });
    expect(result.status).toBe("ok");
    expect(result.account).toBe("Bot #42");
  });

  it("falls back to a generic label when no identity fields are present", async () => {
    getMeMock.mockResolvedValue({});
    const result = await validateCredentials({ botToken: "12345:abcdef" });
    expect(result.status).toBe("ok");
    expect(result.account).toBe("Telegram bot");
  });

  it("returns failed with the SDK error message on rejection", async () => {
    getMeMock.mockRejectedValue(new Error("Call to 'getMe' failed: 401 Unauthorized"));
    const result = await validateCredentials({ botToken: "bad-token" });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("401 Unauthorized");
  });

  it("returns unset without constructing a Bot when token is empty", async () => {
    const result = await validateCredentials({ botToken: "" });
    expect(result.status).toBe("unset");
    expect(botConstructor).not.toHaveBeenCalled();
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it("clips long error messages to the contract limit", async () => {
    const long = "A".repeat(500);
    getMeMock.mockRejectedValue(new Error(long));
    const result = await validateCredentials({ botToken: "x" });
    expect(result.status).toBe("failed");
    expect(result.errorMessage?.length).toBeLessThanOrEqual(240);
    expect(result.errorMessage?.endsWith("…")).toBe(true);
  });

  it("scrubs the bot token from network-layer error messages", async () => {
    // Telegram puts the token IN THE URL PATH. When fetch fails at
    // the network layer (DNS, TLS, etc.), undici's error message can
    // contain the URL verbatim — token and all. The provider scrubs
    // any `/bot<token>` fragment before clipping so the result never
    // surfaces the credential to the renderer or logs.
    const token = "12345:s3cretBotToken";
    getMeMock.mockRejectedValue(
      new Error(
        `fetch failed: getaddrinfo ENOTFOUND api.telegram.org/bot${token}/getMe`,
      ),
    );
    const result = await validateCredentials({ botToken: token });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage).not.toContain(token);
    expect(result.errorMessage).toContain("/bot<redacted>/getMe");
  });
});

describe("scrubBotToken (Telegram URL token redaction)", () => {
  it("redacts a single occurrence", () => {
    expect(
      scrubBotToken("Failed at https://api.telegram.org/bot123:abc/getMe"),
    ).toBe("Failed at https://api.telegram.org/bot<redacted>/getMe");
  });

  it("redacts multiple occurrences in one message", () => {
    expect(
      scrubBotToken(
        "tried /bot111:zzz then fell back to /bot222:yyy/getMe",
      ),
    ).toBe("tried /bot<redacted> then fell back to /bot<redacted>/getMe");
  });

  it("leaves messages without /bot<...> untouched", () => {
    const message = "401 Unauthorized";
    expect(scrubBotToken(message)).toBe(message);
  });

  it("does not match a stray 'bot' substring without the leading slash", () => {
    // We only redact the URL form `/bot<token>`, not "bot" appearing
    // anywhere else (e.g. in a description like "Bot is not running").
    const message = "Bot is not running";
    expect(scrubBotToken(message)).toBe(message);
  });
});
