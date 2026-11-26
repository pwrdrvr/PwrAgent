import { describe, expect, it } from "vitest";
import { formatToolIdentifier } from "../../shared/tool-activity";
import { buildCodexConnectionMcpConfig } from "../app-server/codex-thread-config";
import type { McpConnectionBridgeRegistration } from "../mcp-connections/mcp-connection-gateway-service";

function registration(name: string): McpConnectionBridgeRegistration {
  return {
    server: {
      name,
      command: "/bin/node",
      args: ["/test/bridge.js"],
      env: { PWRAGENT_MCP_CONNECTION_NAME: name },
    },
    bindThread: () => undefined,
    revoke: () => undefined,
  };
}

describe("buildCodexConnectionMcpConfig", () => {
  it.each([
    ["a-0", /^pwragent_0_a_h0_[0-9a-f]{32}$/u],
    ["pwrsuitelab-control", /^pwragent_0_pwrsuitelab_hcontrol_[0-9a-f]{32}$/u],
  ])("registers %s under the namespace Codex exposes to the model", (name, alias) => {
    const config = buildCodexConnectionMcpConfig([registration(name)]);
    expect(Object.keys(config?.mcp_servers ?? {})).toEqual([expect.stringMatching(alias)]);
  });

  it("preserves punctuation and distinguishes custom connections from PwrSnap in tool activity", () => {
    const ids = ["a-", "builtin-pwrsnap", "builtin_pwrsnap", "pwrsnap"];
    const config = buildCodexConnectionMcpConfig(ids.map(registration));
    const labels = Object.keys(config?.mcp_servers ?? {}).map((alias) => formatToolIdentifier(alias, "inspect"));
    expect(labels).toEqual(ids.map((id) => `${id}/inspect`));
  });

  it("leaves the agent's own servers alone by default", () => {
    const config = buildCodexConnectionMcpConfig(
      [registration("pwrsnap")],
      ["linear", "sentry"],
    );
    const servers = config?.mcp_servers as Record<string, unknown>;
    expect(Object.keys(servers)).not.toContain("linear");
    expect(Object.keys(servers)).not.toContain("sentry");
  });

  it("turns off every inherited server when the thread isolates", () => {
    const config = buildCodexConnectionMcpConfig(
      [registration("pwrsnap")],
      ["linear", "sentry"],
      { isolateFromInherited: true },
    );
    const servers = config?.mcp_servers as Record<string, unknown>;
    expect(servers.linear).toEqual({ enabled: false });
    expect(servers.sentry).toEqual({ enabled: false });
    // The bridge still has to reach the thread, so isolation must not
    // suppress the managed connection it was asked to keep.
    const bridge = Object.entries(servers).find(
      ([, value]) => (value as { enabled?: boolean }).enabled === true,
    );
    expect(bridge).toBeTruthy();
  });

  it("produces an isolating config even with no managed connections", () => {
    // "PwrAgent connections only" with nothing selected means no MCP at all,
    // which is a real selection and must not fall back to undefined.
    const config = buildCodexConnectionMcpConfig([], ["linear"], {
      isolateFromInherited: true,
    });
    expect(config?.mcp_servers).toEqual({ linear: { enabled: false } });
    expect(buildCodexConnectionMcpConfig([], ["linear"])).toBeUndefined();
  });
});
