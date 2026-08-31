import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const setTokenMock = vi.fn();
const restConstructor = vi.fn();

// Stub discord.js at the module boundary. We assert that
// `validateCredentials` constructs a REST client with API version 10,
// calls `setToken(token)`, and dispatches the current-application route exactly
// once. No gateway, no Client, no shard manager.
vi.mock("discord.js", () => {
  class MockREST {
    constructor(options: unknown) {
      restConstructor(options);
    }
    setToken(token: string) {
      setTokenMock(token);
      return this;
    }
    get(route: string) {
      return getMock(route);
    }
  }
  return {
    REST: MockREST,
    Routes: {
      oauth2CurrentApplication: () => "/oauth2/applications/@me",
    },
  };
});

import {
  discoverDiscordApplicationId,
  validateCredentials,
} from "../validate-credentials.ts";

const TEST_APPLICATION_ID = "1480556454498009351";

beforeEach(() => {
  getMock.mockReset();
  setTokenMock.mockReset();
  restConstructor.mockReset();
});

describe("Discord validateCredentials", () => {
  it("returns ok with the bare username for modern (discriminator '0') accounts", async () => {
    getMock.mockResolvedValue({
      bot: {
        username: "pwragent",
        discriminator: "0",
      },
      id: TEST_APPLICATION_ID,
      name: "PwrAgent",
    });
    const result = await validateCredentials({ botToken: "BotTokenABC" });
    expect(result.status).toBe("ok");
    expect(result.account).toBe("pwragent");
    expect(result.detail).toBe("discord.com/api/v10");
    expect(restConstructor).toHaveBeenCalledExactlyOnceWith({ version: "10" });
    expect(setTokenMock).toHaveBeenCalledExactlyOnceWith("BotTokenABC");
    expect(getMock).toHaveBeenCalledExactlyOnceWith("/oauth2/applications/@me");
  });

  it("uses the legacy username#discriminator format for old accounts", async () => {
    getMock.mockResolvedValue({
      bot: {
        username: "pwragent",
        discriminator: "4421",
      },
      id: TEST_APPLICATION_ID,
    });
    const result = await validateCredentials({ botToken: "BotTokenABC" });
    expect(result.account).toBe("pwragent#4421");
  });

  it("returns the application ID discovered from the bot token", async () => {
    getMock.mockResolvedValue({ id: TEST_APPLICATION_ID, name: "PwrAgent" });

    await expect(
      discoverDiscordApplicationId({ botToken: "BotTokenABC" }),
    ).resolves.toBe(TEST_APPLICATION_ID);
    expect(getMock).toHaveBeenCalledExactlyOnceWith("/oauth2/applications/@me");
  });

  it("rejects an invalid application identity response", async () => {
    getMock.mockResolvedValue({ id: "not-a-snowflake", name: "PwrAgent" });

    const result = await validateCredentials({ botToken: "BotTokenABC" });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("invalid current application ID");
  });

  it("returns failed with the SDK error message on rejection", async () => {
    getMock.mockRejectedValue(new Error("DiscordAPIError[0]: 401: Unauthorized"));
    const result = await validateCredentials({ botToken: "bad-token" });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("401: Unauthorized");
  });

  it("returns unset without constructing a REST client when token is empty", async () => {
    const result = await validateCredentials({ botToken: "" });
    expect(result.status).toBe("unset");
    expect(restConstructor).not.toHaveBeenCalled();
    expect(setTokenMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("clips long error messages to the contract limit", async () => {
    const long = "A".repeat(500);
    getMock.mockRejectedValue(new Error(long));
    const result = await validateCredentials({ botToken: "x" });
    expect(result.status).toBe("failed");
    expect(result.errorMessage?.length).toBeLessThanOrEqual(240);
    expect(result.errorMessage?.endsWith("…")).toBe(true);
  });
});
