import { describe, expect, it } from "vitest";
import type { CodexMcpAuthStatus } from "../contracts/agent";
import type { McpConnectionRuntimeState } from "../contracts/mcp-connections";
import {
  describeMcpAuthStatus,
  describeMcpConnectionAuth,
  formatMcpAuthStatus,
} from "../mcp-auth-status";

const ALL_STATUSES: CodexMcpAuthStatus[] = [
  "unknown",
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
];

describe("formatMcpAuthStatus", () => {
  // Both MCP surfaces used to carry their own copy of this switch and had
  // already drifted ("No login" vs "No authentication"). Asserting the full
  // enum here means a sixth protocol value cannot ship as a silent blank.
  it("labels every protocol value", () => {
    for (const status of ALL_STATUSES) {
      expect(formatMcpAuthStatus(status)).toMatch(/\S/);
      expect(describeMcpAuthStatus(status).description).toMatch(/\S/);
    }
  });

  it("names the operator's state rather than the mechanism", () => {
    expect(formatMcpAuthStatus("oAuth")).toBe("Signed in");
    expect(formatMcpAuthStatus("bearerToken")).toBe("Signed in · token");
  });

  it("does not describe a server that needs no auth as signed out", () => {
    expect(formatMcpAuthStatus("unsupported")).toBe("No sign-in needed");
  });

  it("warns only where the operator has something to do", () => {
    expect(describeMcpAuthStatus("notLoggedIn").tone).toBe("warn");
    for (const status of ALL_STATUSES.filter((value) => value !== "notLoggedIn")) {
      expect(describeMcpAuthStatus(status).tone).not.toBe("warn");
    }
  });

  it("offers sign-in exactly where the pane can start one", () => {
    const canSignIn = ALL_STATUSES.filter(
      (status) => describeMcpAuthStatus(status).canSignIn,
    );
    expect(canSignIn).toEqual(["notLoggedIn", "oAuth"]);
  });
});

describe("describeMcpConnectionAuth", () => {
  // Settings lists managed connections directly above Codex's servers. One
  // state in two dialects -- `Not set up` above `Sign-in required`, `Ready`
  // above `Signed in` -- read as two different conditions.
  it("labels a managed connection in the Codex list's words", () => {
    expect(
      describeMcpConnectionAuth({ configured: true, state: "ready" }),
    ).toMatchObject({
      label: describeMcpAuthStatus("oAuth").label,
      tone: describeMcpAuthStatus("oAuth").tone,
    });
    for (const input of [
      { configured: false, state: "disconnected" },
      { configured: true, state: "reauthorization_required" },
    ] as const) {
      expect(describeMcpConnectionAuth(input)).toMatchObject({
        label: describeMcpAuthStatus("notLoggedIn").label,
        tone: "warn",
      });
    }
  });

  it("stays signed in through states that are not about the credential", () => {
    const signedIn: McpConnectionRuntimeState[] = [
      "ready",
      "connecting",
      "refreshing",
      // The server is down; the credential PwrAgent holds is not the problem.
      "temporarily_unavailable",
    ];
    for (const state of signedIn) {
      expect(describeMcpConnectionAuth({ configured: true, state }).label)
        .toBe("Signed in");
    }
  });

  it("says who holds the credential", () => {
    expect(
      describeMcpConnectionAuth({ configured: true, state: "ready" })
        .description,
    ).toMatch(/PwrAgent holds/);
  });
});
