import { describe, expect, it } from "vitest";
import type { CodexMcpServerSummary } from "@pwragent/shared";
import {
  countMcpServerHealth,
  describeMcpServerTools,
  readMcpServerHealth,
} from "../mcp-server-health";

function server(
  overrides: Partial<CodexMcpServerSummary> & { name: string },
): CodexMcpServerSummary {
  return { authStatus: "unsupported", tools: [], ...overrides };
}

describe("readMcpServerHealth", () => {
  it("treats a missing startup report as unknown, not ready", () => {
    // `startupStatus` arrives on a notification the pane may never have been
    // mounted to receive. Calling that "ready" is what made a dead server and
    // a healthy one identical.
    expect(readMcpServerHealth(server({ name: "quiet" }))).toBe("unknown");
  });

  it("accepts published tools as proof the server answered", () => {
    expect(readMcpServerHealth(server({ name: "a", tools: ["t"] }))).toBe("ready");
  });

  it("puts sign-in ahead of a failed start", () => {
    expect(
      readMcpServerHealth(
        server({ name: "a", authStatus: "notLoggedIn", startupStatus: "failed" }),
      ),
    ).toBe("needsSignIn");
  });

  it("reports a cancelled start as failed", () => {
    expect(
      readMcpServerHealth(server({ name: "a", startupStatus: "cancelled" })),
    ).toBe("failed");
  });

  it("does not call a server mid-start ready on the strength of its tools", () => {
    expect(
      readMcpServerHealth(
        server({ name: "a", startupStatus: "starting", tools: ["t"] }),
      ),
    ).toBe("unknown");
  });
});

describe("describeMcpServerTools", () => {
  it("separates the two ways a server can have no tools", () => {
    const quiet = server({ name: "awsdocs", startupStatus: "ready" });
    const broken = server({ name: "atlassian", authStatus: "notLoggedIn" });
    expect(describeMcpServerTools(quiet, readMcpServerHealth(quiet)))
      .toBe("ready — no tools published");
    expect(describeMcpServerTools(broken, readMcpServerHealth(broken)))
      .toBe("no tools — sign-in required");
  });

  it("counts in singular and plural", () => {
    const one = server({ name: "a", tools: ["t"] });
    const many = server({ name: "b", tools: ["t", "u"] });
    expect(describeMcpServerTools(one, "ready")).toBe("1 tool");
    expect(describeMcpServerTools(many, "ready")).toBe("2 tools");
  });
});

describe("countMcpServerHealth", () => {
  it("counts health and tools rather than configuration", () => {
    expect(
      countMcpServerHealth([
        server({ name: "a", authStatus: "oAuth", tools: ["t1", "t2"] }),
        server({ name: "b", authStatus: "notLoggedIn" }),
        server({ name: "c", startupStatus: "failed" }),
        server({ name: "d" }),
      ]),
    ).toEqual({
      total: 4,
      tools: 2,
      ready: 1,
      needsSignIn: 1,
      failed: 1,
      unknown: 1,
    });
  });
});
