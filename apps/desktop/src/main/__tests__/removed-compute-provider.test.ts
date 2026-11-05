import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { mcpConnectionIdsForNewThread } from "@pwragent/shared";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";

it("never offers the removed compute provider for any legacy profile choices", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-removed-compute-"));
  const configPath = path.join(root, "config.toml");
  try {
    fc.assert(fc.property(
      fc.boolean(), fc.boolean(), fc.constantFrom("hosted", "local_cli"),
      fc.constantFrom("auto", "approve", "prompt"),
      (enabled, selected, transport, approval) => {
        const source = `# Preserve retired settings and operator comments\n[mcp_connections]\nsandboxer_enabled = ${enabled}\nsandboxer_select_for_new_threads = ${selected}\nsandboxer_transport = "${transport}"\nsandboxer_tool_approval = "${approval}"\n`;
        fs.writeFileSync(configPath, source);
        const registry = new McpConnectionRegistry({ configPath });
        const connections = registry.list();
        expect(registry.get("builtin:sandboxer")).toBeUndefined();
        expect(connections.map((connection) => connection.id)).toEqual(["pwrsnap", "pwrgit"]);
        expect(mcpConnectionIdsForNewThread(connections.map((connection) => ({
          ...connection, configured: true, state: "ready" as const,
        })))).not.toContain("builtin:sandboxer");
        registry.setEnabled("pwrsnap", false);
        expect(fs.readFileSync(configPath, "utf8")).toContain(source.trim());
        const custom = registry.create({ displayName: "Sandboxer", serverUrl: "https://unrelated.example/mcp" });
        expect(custom.id).toBe("sandboxer");
        expect(registry.get(custom.id)?.kind).toBe("remote");
        expect(registry.get("builtin:sandboxer")).toBeUndefined();
      },
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("withholds the retired built-in when an older instance owns the gateway", async () => {
  const service = new McpConnectionGatewayService({ leaseManager: null, settings: {} as never });
  const retired = { id: "builtin:sandboxer", enabled: true, configured: true, selectForNewThreads: true, state: "ready" };
  const active = { ...retired, id: "unrelated-provider" };
  const registerOwnerBridge = vi.fn();
  Object.assign(service, {
    ensureOwnerBroker: async () => ({ owned: false, holder: {} }),
    requestOwnerBroker: async () => [retired, active],
    registerOwnerBridge,
  });
  try {
    expect(await service.listConnections()).toEqual([active]);
    expect(mcpConnectionIdsForNewThread([retired, active] as never)).toEqual([active.id]);
    await expect(service.registerBridge(retired.id, "old-thread")).rejects.toThrow("retired");
    expect(registerOwnerBridge).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});
