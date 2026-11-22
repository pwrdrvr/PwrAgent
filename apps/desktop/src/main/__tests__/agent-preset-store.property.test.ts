import { deleteAgentPreset, listAgentPresets, saveAgentPreset } from "@pwragent/sqlite-storage/agent-preset-store";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resetLaunchpadAfterMaterialize } from "../app-server/thread-launchpad-helpers";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

describe("Agent preset store", () => {
  it("round-trips explicit selections without duplicates or extra fields", () => {
    const db = openInMemoryStateDb();
    try {
      fc.assert(fc.property(fc.array(fc.string({ minLength: 1 }), { maxLength: 20 }), (ids) => {
        const saved = saveAgentPreset(db, {
          name: " Release reviewer ",
          instructions: " Check the change log. ",
          mcpConnectionIds: ids,
          ...{ executionMode: "full-access", instructionsDelivery: "workspace-file" },
        });
        const uniqueIds = ids.filter((id, index) => ids.indexOf(id) === index);
        expect(listAgentPresets(db)).toEqual([{
          id: saved.id,
          name: "Release reviewer",
          instructions: "Check the change log.",
          mcpConnectionIds: uniqueIds,
        }]);
        deleteAgentPreset(db, saved.id);
        expect(listAgentPresets(db)).toEqual([]);
      }));
    } finally {
      db.close();
    }
  });

  it("edits only the named record and refuses an edit after deletion", () => {
    const db = openInMemoryStateDb();
    try {
      const saved = saveAgentPreset(db, { name: "Release reviewer", mcpConnectionIds: [] });
      const other = saveAgentPreset(db, { name: "Triage", mcpConnectionIds: [] });
      expect(() => saveAgentPreset(db, { name: "release reviewer", mcpConnectionIds: [] })).toThrow("already has this name");

      const edited = saveAgentPreset(db, { id: saved.id, name: "Review notes", mcpConnectionIds: ["docs"] });
      expect(listAgentPresets(db)).toEqual([edited, other]);
      deleteAgentPreset(db, saved.id);
      expect(() => saveAgentPreset(db, edited)).toThrow("no longer exists");
      expect(listAgentPresets(db)).toEqual([other]);
    } finally {
      db.close();
    }
  });

  it("keeps the copied draft independent of its preset and consumes it on a registered launchpad", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("codex" as const, "claude" as const), async (remove, backend) => {
      const db = openInMemoryStateDb();
      try {
        const overlay = new SqliteOverlayStore(db);
        const preset = saveAgentPreset(db, { name: "Release reviewer", instructions: "Read the change log.", mcpConnectionIds: ["docs"] });
        const agent = { name: preset.name, instructions: preset.instructions };
        const defaults = { backend, executionMode: "default" as const, workMode: "local" as const };
        const launchpad = { ...defaults, directoryKey: "directory:fixture", directoryKind: "directory" as const,
          directoryLabel: "Fixture", createdAt: 1, updatedAt: 1, registeredAt: 1,
          prompt: "Review the release", agent, agentPresetId: preset.id,
          mcpConnectionIds: preset.mcpConnectionIds, mcpConnectionIdsFromDefaults: false };
        await overlay.upsertDirectoryLaunchpad(launchpad);
        if (remove) deleteAgentPreset(db, preset.id);
        else saveAgentPreset(db, { ...preset, name: "Incident triage", mcpConnectionIds: [] });

        const request = { directoryKey: launchpad.directoryKey };
        expect(await overlay.getDirectoryLaunchpad(request)).toMatchObject({ agent, mcpConnectionIds: ["docs"] });
        await resetLaunchpadAfterMaterialize({ defaultPrAutoDispatchEnabled: false, defaults, launchpad, overlayStore: overlay });
        const reset = await overlay.getDirectoryLaunchpad(request);
        expect(reset).toMatchObject({ ...defaults, registeredAt: 1, prompt: "" });
        expect(reset?.agent).toBeUndefined();
        expect(reset?.agentPresetId).toBeUndefined();
        expect(reset?.mcpConnectionIds).toBeUndefined();
      } finally {
        db.close();
      }
    }), { numRuns: 12 });
  });
});
