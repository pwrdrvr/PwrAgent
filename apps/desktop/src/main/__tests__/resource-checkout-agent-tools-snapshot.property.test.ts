import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";

/**
 * Rule: the Resources snapshot says whether this profile's agents have the
 * checkout tools, as the setting reads at that moment, and turning the
 * setting on or off publishes a new revision so an open Resources window
 * learns of it without a state change in the pool. Reading the same setting
 * again publishes nothing.
 */
describe("agent checkout tools in the Resources snapshot", () => {
  it("mirrors the setting and publishes a revision exactly when it flips", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async (settings) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-agent-tools-snapshot-"));
      let enabled = settings[0]!;
      const service = new DesktopResourceCheckoutService({
        viewer: { instanceId: "default", instanceLabel: "Studio", profile: "default", machineId: "host" },
        machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), "host"), machineCpuCount: 2,
        bindings: [], now: () => 1_000, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
        agentToolsEnabled: () => enabled,
      });
      const published: number[] = [];
      const unsubscribe = service.subscribe((revision) => published.push(revision));
      try {
        let previous = service.read();
        expect(previous.agentTools).toBe(enabled ? "enabled" : "disabled");
        for (const next of settings.slice(1)) {
          const flipped = next !== enabled;
          const before = published.length;
          enabled = next;
          const snapshot = service.read();
          expect(snapshot.agentTools).toBe(next ? "enabled" : "disabled");
          if (flipped) {
            expect(snapshot.revision).toBeGreaterThan(previous.revision);
            expect(published.slice(before)).toEqual([snapshot.revision]);
          } else {
            expect(snapshot.revision).toBe(previous.revision);
            expect(published).toHaveLength(before);
          }
          previous = snapshot;
        }
      } finally {
        unsubscribe();
        await service.close();
        rmSync(root, { recursive: true, force: true });
      }
    }), { numRuns: 25 });
  });

  it("reports the tools as off when the setting can't be read, warning once per failure streak", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-agent-tools-snapshot-"));
    const warnings: unknown[] = [];
    let failing = true;
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "default", instanceLabel: "Studio", profile: "default", machineId: "host" },
      machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), "host"), machineCpuCount: 2,
      bindings: [], now: () => 1_000, requestPeer: async () => { throw new Error("Offline"); },
      warn: (error) => warnings.push(error),
      agentToolsEnabled: () => {
        if (failing) throw new Error("config unreadable");
        return true;
      },
    });
    try {
      expect(service.read().agentTools).toBe("disabled");
      expect(service.read().agentTools).toBe("disabled");
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0])).toMatch(/Federation resources setting/);

      failing = false;
      expect(service.read().agentTools).toBe("enabled");
      failing = true;
      expect(service.read().agentTools).toBe("disabled");
      expect(warnings).toHaveLength(2);
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
