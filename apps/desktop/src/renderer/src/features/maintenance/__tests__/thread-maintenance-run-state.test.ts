import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadMaintenanceRun } from "@pwragent/shared";
import { newerRun, threadMaintenancePhase } from "../thread-maintenance-run-state";

function snapshots(count: number): ThreadMaintenanceRun[] {
  // What main publishes for one run: running snapshots, then one finished.
  return Array.from({ length: count }, (_, index) => ({
    runId: "run-1", revision: index + 1, scanId: "scan-1", running: index < count - 1, startedAt: 1,
    steps: [], problems: [],
  }));
}

describe("thread maintenance run state", () => {
  it("ends on main's last snapshot whatever order the dialog hears them in", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 8 }).chain((count) => fc.tuple(
        fc.constant(count),
        fc.shuffledSubarray(snapshots(count), { minLength: count, maxLength: count }),
      )),
      // The apply reply, events and fetches can each arrive at any point.
      ([count, delivered]) => {
        let shown: ThreadMaintenanceRun | undefined;
        for (const snapshot of delivered) shown = newerRun(shown, snapshot);
        expect(shown?.revision).toBe(count);
        expect(threadMaintenancePhase("run", shown)).toBe("finished");
      },
    ));
  });

  it("never lets a stale running snapshot reopen a finished run", () => {
    const [started, finished] = snapshots(2);
    const shown = newerRun(newerRun(undefined, finished), started);
    expect(shown).toBe(finished);
    expect(threadMaintenancePhase("run", shown)).toBe("finished");
  });

  it("shows any running run, and returns to the plan when none was shown", () => {
    const [running] = snapshots(2);
    for (const stored of ["plan", "scanning", "threads", "checkouts", "run"] as const) {
      expect(threadMaintenancePhase(stored, running)).toBe("running");
    }
    expect(threadMaintenancePhase("threads", undefined)).toBe("threads");
    expect(threadMaintenancePhase("run", undefined)).toBe("plan");
  });
});
