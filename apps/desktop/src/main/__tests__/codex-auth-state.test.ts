import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAuthState, isCodexAuthenticationFailure } from "../codex-auth-state";

describe("Codex rejected authentication", () => {
  it.each([
    "Your access token could not be refreshed. Please log out and sign in again.",
    'Failed to refresh token: 401 Unauthorized: {"code":"invalid_refresh_token"}',
    "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized",
    "Could not parse your authentication token. Please try signing in again.",
  ])("recognizes %s", (message) => {
    expect(isCodexAuthenticationFailure(message)).toBe(true);
  });

  it.each(["MCP server returned 401 Unauthorized", "429 Too Many Requests", "Failed to refresh token: connection timed out"])(
    "does not log out on unrelated failures: %s", (message) => {
      expect(isCodexAuthenticationFailure(message)).toBe(false);
    },
  );

  it("latches rejection per home until verified recovery, notifying only at boundaries", () => {
    const state = new CodexAuthState();
    const changes: string[] = [];
    state.subscribe((home) => changes.push(home));
    state.reject("/fixture/default");
    state.reject("/fixture/default");
    expect(state.isBlocked("/fixture/default")).toBe(true);
    expect(state.isBlocked("/fixture/work")).toBe(false);
    expect(() => state.assertAvailable("/fixture/default")).toThrow("sign in");
    state.verified("/fixture/work");
    expect(state.isBlocked("/fixture/default")).toBe(true);
    state.verified("/fixture/default");
    expect(() => state.assertAvailable("/fixture/default")).not.toThrow();
    const normalizedHome = path.resolve("/fixture/default");
    expect(changes).toEqual([normalizedHome, normalizedHome]);
  });
});
