import { describe, expect, it } from "vitest";
import {
  isBuiltInMcpConnectionId, isLocalMcpConnectionKind, mcpConnectionIdsForNewThread,
  resolveMcpConnectionSetup, type McpConnectionStatus, type SandboxerRole,
} from "../mcp-connections";
import { describeMcpConnectionAuth } from "../../mcp-auth-status";

const connection: McpConnectionStatus = {
  id: "sandboxer", displayName: "Sandboxer", kind: "sandboxer", sandboxerRole: "compute",
  authMode: "local_cli", serverUrl: "sandboxer:compute", enabled: true,
  selectForNewThreads: false, toolApproval: "prompt", configured: true,
  state: "ready", sandboxerCliState: "signed_in", createdAt: 0, updatedAt: 0,
};

describe("Sandboxer contract", () => {
  it("reserves a local built-in compute connection and the future remote_agent role", () => {
    const futureRole: SandboxerRole = "remote_agent";
    expect(futureRole).not.toBe(connection.sandboxerRole);
    expect(isBuiltInMcpConnectionId("sandboxer")).toBe(true);
    expect(isLocalMcpConnectionKind("sandboxer")).toBe(true);
    expect(mcpConnectionIdsForNewThread([connection])).toEqual([]);
    expect(mcpConnectionIdsForNewThread([{ ...connection, selectForNewThreads: true }])).toEqual(["sandboxer"]);
    expect(mcpConnectionIdsForNewThread([{ ...connection, selectForNewThreads: true, enabled: false }])).toEqual([]);
  });

  it("shows actionable CLI states without OAuth claims", () => {
    for (const [sandboxerCliState, headline, configured] of [
      ["cli_missing", "CLI missing", false], ["not_signed_in", "Not signed in", false],
      ["unavailable", "Unavailable", false], ["signed_in", "Signed in", true],
    ] as const) {
      const status = { ...connection, sandboxerCliState, configured, detail: "CLI remedy" };
      expect(resolveMcpConnectionSetup({ connection: status, gatewayEnabled: true })).toMatchObject({ headline, detail: "CLI remedy", threadSelectable: configured });
      expect(describeMcpConnectionAuth(status)).toMatchObject({ canSignIn: false, description: "CLI remedy" });
    }
    expect(resolveMcpConnectionSetup({ connection: { ...connection, enabled: false }, gatewayEnabled: true }).state).toBe("parked");
    expect(resolveMcpConnectionSetup({ connection, gatewayEnabled: false }).state).toBe("gateway_off");
  });
});
