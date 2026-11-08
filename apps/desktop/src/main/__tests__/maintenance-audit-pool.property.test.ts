import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { mapMaintenanceAudit } from "../app-server/maintenance-audit-pool";

describe("read-only maintenance audit scheduling", () => {
  // Model: at most six independent reads, one pause per 25 items, and the
  // input order returned even when different reads yield different times.
  it("preserves the ordered result with bounded work and batch pacing", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ value: fc.integer(), yields: fc.nat({ max: 4 }) }), { maxLength: 85 }), async (items) => {
      let active = 0, peak = 0;
      const checkpoint = vi.fn(async () => {}), assertCurrent = vi.fn();
      const result = await mapMaintenanceAudit(items, { checkpoint, assertCurrent }, async (item) => {
        active += 1; peak = Math.max(peak, active);
        try {
          for (let count = 0; count <= item.yields; count++) await Promise.resolve();
          return item.value;
        } finally { active -= 1; }
      });
      expect(result).toEqual(items.map((item) => item.value));
      expect(active).toBe(0);
      expect(peak).toBe(Math.min(6, items.length));
      expect(assertCurrent).toHaveBeenCalledTimes(items.length);
      expect(checkpoint).toHaveBeenCalledTimes(Math.ceil(items.length / 25));
    }));
  });

  it("stops scheduling and drains started reads before reporting failure", async () => {
    const gates: { resolve: () => void; reject: (error: Error) => void }[] = [];
    let failedRead = false, settled = false;
    const result = mapMaintenanceAudit(Array.from({ length: 30 }), { checkpoint: async () => {}, assertCurrent() {} }, async () => {
      try { await new Promise<void>((resolve, reject) => gates.push({ resolve, reject })); }
      catch (error) { failedRead = true; throw error; }
    }).then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
    await vi.waitFor(() => expect(gates).toHaveLength(6));
    const error = new Error("Read was cancelled");
    gates[0]!.reject(error);
    await vi.waitFor(() => expect(failedRead).toBe(true));
    expect(settled).toBe(false);
    for (const gate of gates.slice(1)) gate.resolve();
    expect(await result).toBe(error);
    expect(gates).toHaveLength(6);
  });
});
