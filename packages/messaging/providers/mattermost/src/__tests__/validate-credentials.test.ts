import { beforeEach, describe, expect, it, vi } from "vitest";

import { validateCredentials } from "../validate-credentials.ts";

let fetchMock: ReturnType<typeof vi.fn>;

function buildOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
});

describe("Mattermost validateCredentials", () => {
  it("returns ok with the bot's username when the probe succeeds", async () => {
    fetchMock.mockResolvedValue(
      buildOkResponse({ id: "abc123", username: "pwragent" }),
    );
    const result = await validateCredentials(
      {
        botToken: "abcdef",
        serverUrl: "https://chat.example.com",
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.status).toBe("ok");
    expect(result.account).toBe("pwragent");
    expect(result.detail).toBe("chat.example.com");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://chat.example.com/api/v4/users/me");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer abcdef",
    });
  });

  it("returns unset without calling fetch when token is empty", async () => {
    const result = await validateCredentials(
      { botToken: "", serverUrl: "https://chat.example.com" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.status).toBe("unset");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unset without calling fetch when server URL is empty", async () => {
    const result = await validateCredentials(
      { botToken: "abc", serverUrl: "" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.status).toBe("unset");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns failed when the server URL is unparsable", async () => {
    const result = await validateCredentials(
      { botToken: "abc", serverUrl: "::not-a-url::" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Invalid Mattermost server URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns failed when the server responds with a non-2xx status", async () => {
    fetchMock.mockResolvedValue(
      new Response("token expired", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    const result = await validateCredentials(
      { botToken: "bad", serverUrl: "https://chat.example.com" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("401");
  });

  it("returns failed when fetch rejects (network error)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await validateCredentials(
      { botToken: "abc", serverUrl: "https://chat.example.com" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("ECONNREFUSED");
  });

  it("clips long error messages to the contract limit", async () => {
    fetchMock.mockRejectedValue(new Error("A".repeat(500)));
    const result = await validateCredentials(
      { botToken: "abc", serverUrl: "https://chat.example.com" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.status).toBe("failed");
    expect(result.errorMessage?.length).toBeLessThanOrEqual(240);
    expect(result.errorMessage?.endsWith("…")).toBe(true);
  });
});
