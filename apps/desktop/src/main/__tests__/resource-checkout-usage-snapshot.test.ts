import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";

/**
 * Rule: the operator snapshot carries what this process observed of each
 * resource, including changes another profile made to the shared pool, and
 * time passing alone never publishes a new revision. The renderer extends
 * the last point to now until the next revision.
 */
describe("resource checkout usage in the snapshot", () => {
  it("records another profile's checkout and leaves revisions to state changes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-usage-snapshot-"));
    let clock = 1_000;
    const services = ["default", "dev"].map((profile) => new DesktopResourceCheckoutService({
      viewer: { instanceId: profile, instanceLabel: "Studio", profile, machineId: "host" },
      machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), "host"), machineCpuCount: 4,
      bindings: [], now: () => clock, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
    }));
    const [owner, watcher] = services as [DesktopResourceCheckoutService, DesktopResourceCheckoutService];
    try {
      const first = watcher.read();
      const resourceId = first.resources[0]!.resourceId;
      expect(first.resources[0]!.usage).toEqual({ observedSince: 1_000, points: [{ at: 1_000, held: 0, waiting: 0 }] });

      clock = 5_000;
      const idle = watcher.read();
      expect(idle.revision).toBe(first.revision);
      expect(idle.resources[0]!.usage!.points).toHaveLength(1);

      clock = 8_000;
      await owner.perform({
        kind: "request", idempotencyKey: "a", resourceId, purpose: "build", expectedDurationMs: 60_000, units: 3,
      }, owner.threadActor("codex", "a"));
      await owner.perform({
        kind: "request", idempotencyKey: "b", resourceId, purpose: "tests", expectedDurationMs: 60_000, units: 2,
      }, owner.threadActor("codex", "b"));
      clock = 9_000;
      const busy = watcher.read();
      expect(busy.revision).toBeGreaterThan(idle.revision);
      expect(busy.resources[0]!.usage!.points).toEqual([
        { at: 1_000, held: 0, waiting: 0 },
        { at: 9_000, held: 3, waiting: 2 },
      ]);
    } finally {
      await Promise.all(services.map((service) => service.close()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
