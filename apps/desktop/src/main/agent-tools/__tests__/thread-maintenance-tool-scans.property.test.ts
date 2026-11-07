import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMaintenanceScan } from "@pwragent/shared";
import {
  ThreadMaintenanceToolScans,
  type ThreadMaintenanceToolScanOutcome,
} from "../thread-maintenance-tool-scans";

const WAIT_MS = 40_000;
const PROJECTS = ["/repo/a", "/repo/b", undefined] as const;

type Step =
  | { kind: "start"; gap: number; project: number; duration: number; fails: boolean }
  | { kind: "read"; gap: number; pick: number };

type ModelScan = { scanId: string; key: number; endsAt: number; fails: boolean };

function fakeScan(scanId: string, projectKey: string | undefined): ThreadMaintenanceScan {
  return {
    scanId, startedAt: 0, finishedAt: 0,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    ...(projectKey ? { projectKey } : {}),
    spaceSource: "none",
    threads: { checked: 0, projects: [], kept: {} },
    checkouts: { items: [], kept: {}, emptyFolders: 0 },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("start" as const),
    gap: fc.integer({ min: 0, max: 90_000 }),
    project: fc.integer({ min: 0, max: PROJECTS.length - 1 }),
    // Scans from instant to well past one call's wait, as on a large fleet.
    duration: fc.integer({ min: 0, max: 150_000 }),
    fails: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("read" as const), gap: fc.integer({ min: 0, max: 90_000 }), pick: fc.nat() }),
);

describe("thread maintenance tool scans", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  // Model: every call answers within its wait, however long the scan runs.
  // A start joins the running scan for the same request and otherwise begins
  // one. A call reports the scan finished exactly when the scan ended within
  // its wait, and the finished scan is the one the service produced under the
  // scanId the call reported (oracle: the service's own result).
  it("answers within the wait and reports the scan the service produced", async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
      vi.setSystemTime(0);
      const produced = new Map<string, ThreadMaintenanceScan>();
      const plans: { duration: number; fails: boolean }[] = [];
      let ids = 0;
      const scan = vi.fn((request: { projectKey?: string; scanId: string }) => {
        const plan = plans.shift()!;
        return new Promise<ThreadMaintenanceScan>((resolve, reject) => {
          setTimeout(() => {
            if (plan.fails) return reject(new Error(`scan ${request.scanId} failed`));
            const result = fakeScan(request.scanId, request.projectKey);
            produced.set(request.scanId, result);
            resolve(result);
          }, plan.duration);
        });
      });
      const scans = new ThreadMaintenanceToolScans({
        scan, getScan: (scanId) => produced.get(scanId), newId: () => `scan-${++ids}`,
      });
      const model: ModelScan[] = [];
      let now = 0;
      for (const item of steps) {
        await vi.advanceTimersByTimeAsync(item.gap);
        now += item.gap;
        let call: Promise<ThreadMaintenanceToolScanOutcome>;
        let target: ModelScan | undefined;
        if (item.kind === "start") {
          target = model.find((entry) => entry.key === item.project && entry.endsAt > now);
          if (!target) {
            target = { scanId: `scan-${ids + 1}`, key: item.project, endsAt: now + item.duration, fails: item.fails };
            model.push(target);
            plans.push({ duration: item.duration, fails: item.fails });
          }
          const projectKey = PROJECTS[item.project];
          call = scans.start(projectKey ? { projectKey } : {}, WAIT_MS);
        } else {
          target = model.length ? model[item.pick % model.length] : undefined;
          call = scans.read(target?.scanId ?? "unknown", WAIT_MS);
        }
        let outcome: ThreadMaintenanceToolScanOutcome | undefined;
        void call.then((value) => { outcome = value; });
        await vi.advanceTimersByTimeAsync(WAIT_MS);
        now += WAIT_MS;
        expect(outcome, "the call answered within its wait").toBeDefined();
        if (!target) {
          expect(outcome).toEqual({ kind: "missing" });
          continue;
        }
        const endedInTime = target.endsAt <= now;
        // A scan ending exactly as the wait ends may land on either side.
        if (target.endsAt === now) continue;
        if (!endedInTime) {
          expect(outcome).toMatchObject({ kind: "running", scanId: target.scanId });
        } else if (target.fails) {
          expect(outcome).toMatchObject({ kind: "failed", scanId: target.scanId });
        } else {
          expect(outcome).toEqual({ kind: "finished", scan: produced.get(target.scanId) });
          expect(outcome!.kind === "finished" && outcome!.scan.scanId).toBe(target.scanId);
        }
      }
      expect(scan).toHaveBeenCalledTimes(model.length);
      await vi.runAllTimersAsync();
    }), { numRuns: 200 });
  });
});
