import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveAgentPresetConnections } from "../contracts/agent-presets";
import { mcpConnectionIdsForNewThread, type McpConnectionStatus } from "../contracts/mcp-connections";

describe("Agent preset connection selection", () => {
  it("partitions only the saved IDs using the same readiness rule as new-thread defaults", () => {
    const id = fc.constantFrom("one", "two", "three", "four");
    const state = fc.constantFrom("disconnected", "connecting", "ready", "refreshing", "reauthorization_required", "temporarily_unavailable");
    const inventory = fc.uniqueArray(fc.record({ id, enabled: fc.boolean(), configured: fc.boolean(), state }), { selector: (item) => item.id });
    fc.assert(fc.property(fc.array(id), inventory, (ids, connections) => {
      const everywhereDefault = connections.map((item) => ({ ...item, selectForNewThreads: true })) as McpConnectionStatus[];
      const ready = mcpConnectionIdsForNewThread(everywhereDefault);
      const uniqueIds = [...new Set(ids)];
      expect(resolveAgentPresetConnections(ids, connections)).toEqual({
        selected: uniqueIds.filter((item) => ready.includes(item)),
        skipped: uniqueIds.filter((item) => !ready.includes(item)),
      });
    }));
  });
});
