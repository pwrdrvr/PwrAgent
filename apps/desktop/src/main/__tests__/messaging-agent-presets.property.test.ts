import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { MessagingBrowseSessionRecord } from "@pwragent/messaging-interface";
import { resolveMessagingAgentPreset } from "../messaging/core/messaging-agent-presets";

const session: MessagingBrowseSessionRecord = {
  id: "session", allowedActorIds: [], channel: { channel: "telegram", conversation: { id: "fixture", kind: "dm", isDirectMessage: true } },
  launchAction: "start_new_agent_thread", mode: "new_thread_options", agentPresetId: "preset", selectedProject: { label: "Local" },
  pageIndex: 0, pageSize: 8, createdAt: 1, updatedAt: 1, expiresAt: 2,
};

describe("messaging Agent preset connection resolution", () => {
  it("keeps the Agent launch usable when inventory rejects or stalls", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (hasSelection, stalls) => {
      const mcpConnectionIds = hasSelection ? ["fixture-connection"] : [];
      const listAgentPresetConnections = vi.fn(() => stalls ? new Promise<never>(() => {}) : Promise.reject(new Error("Inventory offline")));
      vi.useFakeTimers();
      try {
        const resolved = vi.fn();
        const rejected = vi.fn();
        void resolveMessagingAgentPreset({ listAgentPresetConnections,
          listAgentPresets: () => [{ id: "preset", name: "Fixture Agent", mcpConnectionIds, availableInMessaging: true }] }, session)
          .then(resolved, rejected);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(rejected).not.toHaveBeenCalled();
        expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ connectionIds: [], skippedNames: mcpConnectionIds }));
        expect(listAgentPresetConnections).toHaveBeenCalledTimes(hasSelection ? 1 : 0);
      } finally { vi.useRealTimers(); }
    }));
  });
});
