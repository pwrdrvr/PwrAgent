import { describe, expect, it } from "vitest";
import {
  mcpConnectionIdsForNewThread,
  resolveMcpConnectionSetup,
  type McpConnectionStatus,
} from "../contracts/mcp-connections";

function connection(
  overrides: Partial<McpConnectionStatus> & { id: string },
): McpConnectionStatus {
  return {
    displayName: overrides.id,
    serverUrl: `https://${overrides.id}.example/mcp`,
    authMode: "oauth",
    kind: "remote",
    enabled: true,
    selectForNewThreads: true,
    configured: true,
    state: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("mcpConnectionIdsForNewThread", () => {
  it("seeds only the connections marked for new threads", () => {
    expect(
      mcpConnectionIdsForNewThread([
        connection({ id: "datadog" }),
        connection({ id: "linear", selectForNewThreads: false }),
        // An owner broker from an older build answers without the flag.
        connection({ id: "legacy", selectForNewThreads: undefined }),
      ]),
    ).toEqual(["datadog"]);
  });

  /**
   * `enabled` is the outer gate. A connection the operator withheld from every
   * thread must not reach a new one because a second switch still says yes.
   */
  it("never seeds a connection that is not offered to threads", () => {
    expect(
      mcpConnectionIdsForNewThread([connection({ id: "parked", enabled: false })]),
    ).toEqual([]);
  });

  /**
   * The thread's MCP access panel offers an unhealthy connection as an
   * Authorize button, not a switch, so a seeded one would be a default the
   * operator could not turn off from the thread.
   */
  it("never seeds a connection without working credentials", () => {
    expect(
      mcpConnectionIdsForNewThread([
        connection({ id: "unauthorized", configured: false, state: "disconnected" }),
        connection({ id: "expired", state: "reauthorization_required" }),
      ]),
    ).toEqual([]);
  });

  it("still seeds a signed-in connection whose server is briefly away", () => {
    expect(
      mcpConnectionIdsForNewThread([
        connection({ id: "blip", state: "temporarily_unavailable" }),
        connection({ id: "refreshing", state: "refreshing" }),
      ]),
    ).toEqual(["blip", "refreshing"]);
  });
});

describe("resolveMcpConnectionSetup", () => {
  it("says a ready connection is also on for new threads", () => {
    const summary = resolveMcpConnectionSetup({
      connection: connection({ id: "datadog" }),
      gatewayEnabled: true,
    });
    expect(summary.state).toBe("ready");
    expect(summary.detail).toMatch(/selected on every new one/);
    expect(
      resolveMcpConnectionSetup({
        connection: connection({ id: "datadog", selectForNewThreads: false }),
        gatewayEnabled: true,
      }).detail,
    ).not.toMatch(/new/);
  });
});
