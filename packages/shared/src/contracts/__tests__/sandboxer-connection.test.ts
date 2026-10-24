import { describe, expect, it } from "vitest";
import {
  isBuiltInMcpConnectionId, isLocalMcpConnectionKind, mcpConnectionIdsForNewThread,
  mcpConnectionsForPeer, resolveMcpConnectionSetup, type McpConnectionStatus, type SandboxerRole,
} from "../mcp-connections";
import { describeMcpConnectionAuth } from "../../mcp-auth-status";

const connection: McpConnectionStatus = {
  id: "builtin:sandboxer", displayName: "Sandboxer", kind: "sandboxer", sandboxerRole: "compute",
  authMode: "local_cli", serverUrl: "sandboxer:compute", enabled: true,
  selectForNewThreads: false, toolApproval: "prompt", configured: true,
  state: "ready", sandboxerCliState: "signed_in", createdAt: 0, updatedAt: 0,
};

describe("Sandboxer contract", () => {
  it("reserves a local built-in compute connection and the future remote_agent role", () => {
    const futureRole: SandboxerRole = "remote_agent";
    expect(futureRole).not.toBe(connection.sandboxerRole);
    expect(isBuiltInMcpConnectionId("builtin:sandboxer")).toBe(true);
    expect(isBuiltInMcpConnectionId("sandboxer")).toBe(false);
    // Custom IDs accepted by previous releases cannot contain a colon.
    expect(connection.id).not.toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
    expect(isLocalMcpConnectionKind("sandboxer")).toBe(true);
    expect(mcpConnectionIdsForNewThread([connection])).toEqual([]);
    expect(mcpConnectionIdsForNewThread([{ ...connection, selectForNewThreads: true }])).toEqual(["builtin:sandboxer"]);
    expect(mcpConnectionIdsForNewThread([{ ...connection, selectForNewThreads: true, enabled: false }])).toEqual([]);
  });

  it("shows actionable CLI states without OAuth claims", () => {
    for (const [sandboxerCliState, headline, configured] of [
      ["cli_missing", "CLI missing", false], ["not_signed_in", "Not signed in", false],
      ["unavailable", "Unavailable", false],
    ] as const) {
      const status = { ...connection, sandboxerCliState, configured, detail: "CLI remedy" };
      expect(resolveMcpConnectionSetup({ connection: status, gatewayEnabled: true })).toMatchObject({ headline, detail: "CLI remedy", threadSelectable: configured });
      expect(describeMcpConnectionAuth(status)).toMatchObject({ canSignIn: false, description: "CLI remedy" });
    }
    const ready = resolveMcpConnectionSetup({ connection, gatewayEnabled: true });
    expect(ready).toMatchObject({ headline: "Signed in", threadSelectable: true, offersAvailabilitySwitch: true });
    // A sandbox outlives its thread, so the ready line says what stops it.
    expect(ready.detail).toContain("Closing the thread does not stop one");
    const parked = resolveMcpConnectionSetup({ connection: { ...connection, enabled: false }, gatewayEnabled: true });
    expect(parked.state).toBe("parked");
    expect(parked.detail).toMatch(/^Turn on Offer to threads/);
    expect(resolveMcpConnectionSetup({ connection, gatewayEnabled: false }).state).toBe("gateway_off");
  });

  it("does not call an account that can't start a machine ready", () => {
    for (const [sandboxerCliState, headline] of [
      ["no_plan", "No plan"], ["billing_issue", "Billing issue"],
      ["out_of_credit", "Out of credit"], ["cannot_start", "Can't start"],
    ] as const) {
      const status = { ...connection, sandboxerCliState, configured: false, state: "disconnected" as const, detail: "Account remedy" };
      expect(resolveMcpConnectionSetup({ connection: status, gatewayEnabled: true })).toMatchObject({
        headline, detail: "Account remedy", tone: "warn",
        threadSelectable: false, offersAvailabilitySwitch: false,
      });
      // The login itself is fine; the other chip names what the account lacks.
      expect(describeMcpConnectionAuth(status)).toMatchObject({ label: "Signed in", tone: "ok", canSignIn: false });
    }
  });

  it("keeps the billed account off a federation peer's list", () => {
    const local = { ...connection, sandboxerAccount: { email: "operator@example.com", planDollars: 20 } };
    const [peer] = mcpConnectionsForPeer([local]);
    expect(peer).not.toHaveProperty("sandboxerAccount");
    expect(peer).toMatchObject({ id: "builtin:sandboxer", sandboxerCliState: "signed_in", configured: true });
    expect(local.sandboxerAccount.email).toBe("operator@example.com");
  });
});
