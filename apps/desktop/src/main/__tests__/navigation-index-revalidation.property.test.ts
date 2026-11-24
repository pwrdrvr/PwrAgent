import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { createNavigationQuerySnapshot } from "@pwragent/owner-core/navigation-query-projection";
import { NavigationIndexReadPool } from "../app-server/navigation-index-read-pool";

it("revalidates expired or invalidated inventories before reusing their backing", async () => {
  vi.useFakeTimers();
  try {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      fence: fc.constantFrom("event", "version", "expiry"),
      changed: fc.boolean(),
    }), { minLength: 3, maxLength: 15 }), async (steps) => {
      const pool = new NavigationIndexReadPool(100, 1_000);
      let title = "Initial";
      let version = 0;
      let observedAt = 0;
      const signals: AbortSignal[] = [];
      const load = async (signal: AbortSignal, _checkpoint: () => void, previous: () => ReturnType<typeof createNavigationQuerySnapshot> | undefined) => {
        signals.push(signal);
        return createNavigationQuerySnapshot({ observedAt: ++observedAt, directories: [], threads: [{
          id: "thread", source: "codex", title, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
        }] }, undefined, undefined, previous());
      };
      let current = await pool.read("owner", load, undefined, String(version));
      for (const [i, step] of steps.entries()) {
        if (step.changed) title += "!";
        if (step.fence === "event") pool.invalidate("owner");
        if (step.fence === "version") version++;
        if (step.fence === "expiry") await vi.advanceTimersByTimeAsync(101);

        const next = await pool.read("owner", load, undefined, String(version));
        expect(next.observedAt).toBe(i + 2);
        expect(signals[i]?.aborted).toBe(true);
        expect(next.threads[0]?.title).toBe(title);
        expect(next.threads[0] === current.threads[0]).toBe(!step.changed);
        expect(await pool.read("owner", load, undefined, String(version))).toBe(next);
        expect(pool.retainedUsage().entries).toBe(1);
        current = next;
      }
      await vi.advanceTimersByTimeAsync(1_001);
      expect(pool.retainedUsage()).toEqual({ entries: 0, bytes: 0 });
      const cold = await pool.read("owner", load, undefined, String(version));
      expect(cold.threads[0]).not.toBe(current.threads[0]);
      expect(cold.threads[0]).toEqual(current.threads[0]);
      await vi.advanceTimersByTimeAsync(1_001);
    }), { numRuns: 40 });
  } finally {
    vi.useRealTimers();
  }
});
