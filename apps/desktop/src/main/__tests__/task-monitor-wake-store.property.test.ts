import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { TaskMonitorWakeStore } from "@pwragent/sqlite-storage/task-monitor-wake-store";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const PARENT = { backend: "codex", threadId: "release" } as const;
const PARENTS = [PARENT, { ...PARENT, threadId: "independent" }, { ...PARENT, backend: "claude" }] as const;
const THIRTY_MINUTES = 30 * 60_000;
const OUTCOME = fc.constantFrom("success", "failure", "cancelled", "fallback");
const command = fc.oneof(
  fc.record({ kind: fc.constant("report"), parent: fc.integer({ min: 0, max: 2 }), outcome: OUTCOME }),
  fc.record({ kind: fc.constantFrom("replay", "dispatch"), index: fc.nat(50), connection: fc.nat(1) }),
  fc.record({ kind: fc.constant("time"), delta: fc.constantFrom(-60_000, 1, 60_000, THIRTY_MINUTES) }),
  fc.record({ kind: fc.constantFrom("restart", "rearm") }),
);

describe("Job Monitor wake admission", () => {
  it("agrees with a lifecycle ledger across fresh outcomes, competing claims, replay, restart and rearm", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(OUTCOME, { minLength: 5, maxLength: 8 }),
      fc.array(command, { maxLength: 24, size: "max" }), async (scheduler, competing, commands) => {
        const temp = createTempStateDb("pwragent-monitor-wake-model-");
        let time = THIRTY_MINUTES;
        let runtime = 0;
        const open = () => {
          const db = StateDb.open(temp.dbPath);
          return { db, store: new TaskMonitorWakeStore(db.raw, () => time) };
        };
        let connections = [open(), open()];
        const parents = PARENTS.map(() => ({ generation: 0, tripped: false }));
        const reports: Array<{
          wake: typeof PARENTS[number] & { monitorId: string };
          parent: number;
          generation: number;
          outcome: "success" | "failure" | "cancelled" | "fallback";
          deliveryOwner?: string;
          lastAdmission?: number;
        }> = [];

        function create(parent: number, outcome: typeof reports[number]["outcome"]) {
          const report = {
            wake: { ...PARENTS[parent]!, monitorId: `monitor-${reports.length}` },
            parent, generation: parents[parent]!.generation, outcome,
          };
          reports.push(report);
          return report;
        }

        function claim(report: typeof reports[number], connection: number, dispatch = false) {
          const parent = parents[report.parent]!;
          const owner = `${runtime}:${connection}`;
          const store = connections[connection]!.store;
          const admittedBefore = report.lastAdmission !== undefined;
          const matchesLifecycle = dispatch
            ? admittedBefore && (report.deliveryOwner === undefined || report.deliveryOwner === owner)
            : !admittedBefore;
          let decision = "suppressed";
          if (!parent.tripped && report.generation === parent.generation && matchesLifecycle) {
            const times = reports.filter((other) => other.parent === report.parent && other.generation === parent.generation)
              .flatMap((other) => other.lastAdmission === undefined ? [] : [other.lastAdmission]);
            const now = Math.max(time, ...times);
            const otherWakesInWindow = reports.filter((other) => other !== report
              && other.parent === report.parent && other.generation === parent.generation
              && other.lastAdmission !== undefined && now - other.lastAdmission < THIRTY_MINUTES);
            if (otherWakesInWindow.length < 3) {
              report.lastAdmission = now;
              if (dispatch) report.deliveryOwner = owner;
              decision = "admitted";
            } else {
              decision = "review";
            }
          }
          const actual = dispatch ? store.dispatch(report.wake, owner, false) : store.reserve(report.wake, report.generation);
          expect(actual, `${report.wake.monitorId} reported ${report.outcome}`).toBe(decision);
          expect(store.read(report.wake)).toEqual(parent);
          if (decision === "review") {
            const review = store.claimReview(report.wake);
            if (typeof review === "string") throw new Error(`Expected a claimed review, received ${review}`);
            expect(connections[1 - connection]!.store.claimReview(report.wake)).toBe("pending");
            expect(store.settleReview(report.wake, review, "loop")).toBe(true);
            parent.tripped = true;
          }
          return actual;
        }

        function restart() {
          connections.forEach(({ db }) => db.close());
          runtime += 1;
          connections = [open(), open()];
        }

        function rearm(parent: number) {
          const state = parents[parent]!;
          expect(connections[0]!.store.rearm(PARENTS[parent]!)).toBe(state.tripped);
          if (state.tripped) {
            state.generation += 1;
            state.tripped = false;
          }
        }

        try {
          // Different terminal outcomes compete across two connections to a
          // profile. Every run must cross the production cap.
          const batch = competing.map((outcome, index) => {
            const report = create(0, outcome);
            return scheduler.schedule(Promise.resolve(), report.wake.monitorId).then(() => claim(report, index % 2));
          });
          await scheduler.waitIdle();
          const decisions = await Promise.all(batch);
          expect(decisions.filter((decision) => decision === "admitted")).toHaveLength(3);
          expect(decisions.filter((decision) => decision === "review")).toHaveLength(1);

          restart();
          expect(connections[0]!.store.read(PARENT).tripped).toBe(true);
          const held = reports.find((report) => report.lastAdmission !== undefined)!;
          claim(held, 1, true);
          rearm(0);
          claim(held, 0, true);
          claim(held, 1);
          const fresh = create(0, "success");
          claim(fresh, 0);
          claim(fresh, 1, true);
          restart();
          claim(fresh, 0, true);
          claim(fresh, 0);

          for (const step of commands) {
            switch (step.kind) {
              case "report": claim(create(step.parent, step.outcome), step.parent % 2); break;
              case "replay":
              case "dispatch": claim(reports[step.index % reports.length]!, step.connection, step.kind === "dispatch"); break;
              case "time": time += step.delta; break;
              case "restart": restart(); break;
              case "rearm": parents.forEach((_, parent) => rearm(parent)); break;
            }
            for (const [index, parent] of PARENTS.entries()) {
              expect(connections[1]!.store.read(parent)).toEqual(parents[index]);
            }
          }
        } finally {
          connections.forEach(({ db }) => db.close());
          removeTempStateDbDir(temp.tempDir);
        }
      }), { numRuns: 8 });
  });

  it("rechecks expired holds against fresh reservations and counts a late delivery from its dispatch time", () => {
    const db = StateDb.open(":memory:");
    let time = THIRTY_MINUTES;
    const store = new TaskMonitorWakeStore(db.raw, () => time);
    const wake = (id: string) => ({ ...PARENT, monitorId: id });
    try {
      expect(store.reserve(wake("old-hold"), 0)).toBe("admitted");
      time += THIRTY_MINUTES - 1;
      expect(store.reserve(wake("at-release"), 0)).toBe("admitted");
      expect(store.dispatch(wake("at-release"), "owner", false)).toBe("admitted");
      time += 1;
      expect(store.reserve(wake("fresh-1"), 0)).toBe("admitted");
      expect(store.reserve(wake("fresh-2"), 0)).toBe("admitted");
      expect(store.dispatch(wake("old-hold"), "owner", false)).toBe("review");
      const review = store.claimReview(PARENT);
      if (typeof review === "string") throw new Error(`Expected a claimed review, received ${review}`);
      expect(store.settleReview(PARENT, review, "loop")).toBe(true);

      expect(store.rearm(PARENT)).toBe(true);
      expect(store.dispatch(wake("legacy"), "owner", true)).toBe("suppressed");
      expect(store.reserve(wake("long-hold"), 1)).toBe("admitted");
      time += THIRTY_MINUTES - 1;
      expect(store.dispatch(wake("long-hold"), "owner", false)).toBe("admitted");
      time += 1;
      expect(store.reserve(wake("fresh-3"), 1)).toBe("admitted");
      expect(store.reserve(wake("fresh-4"), 1)).toBe("admitted");
      expect(store.reserve(wake("fresh-5"), 1)).toBe("review");
    } finally {
      db.close();
    }
  });

  it("recovers expired reviews across owners and opens the operator latch only for a current loop verdict", () => {
    fc.assert(fc.property(fc.constantFrom("loop", "continue", "unavailable"), fc.nat(30), (verdict, tail) => {
      const temp = createTempStateDb("pwragent-monitor-review-lease-");
      let now = THIRTY_MINUTES;
      const first = StateDb.open(temp.dbPath);
      const second = StateDb.open(temp.dbPath);
      const a = new TaskMonitorWakeStore(first.raw, () => now);
      const b = new TaskMonitorWakeStore(second.raw, () => now);
      const wake = (id: number) => ({ ...PARENT, monitorId: String(id) });
      try {
        for (let index = 0; index < 3; index++) expect(a.reserve(wake(index), 0)).toBe("admitted");
        expect(a.reserve(wake(3), 0)).toBe("review");
        const previous = a.claimReview(PARENT);
        if (typeof previous === "string") throw new Error(`Expected a claimed review, received ${previous}`);
        expect(b.claimReview(PARENT)).toBe("pending");
        now += 60_000 + tail;
        const current = b.claimReview(PARENT);
        if (typeof current === "string") throw new Error(`Expected a recovered review, received ${current}`);
        expect(a.settleReview(PARENT, previous, "loop")).toBe(false);
        expect(b.settleReview(PARENT, current, verdict)).toBe(true);
        expect(a.read(PARENT).tripped).toBe(verdict === "loop");
        expect(a.reserve(wake(3), 0)).toBe(verdict === "continue" ? "admitted" : "suppressed");
        expect(a.listAlerts()).toHaveLength(verdict === "loop" ? 1 : 0);
        if (verdict === "loop") {
          expect(b.acknowledge(PARENT, 0)).toBe(true);
          expect(a.listAlerts()).toEqual([]);
          expect(a.read(PARENT).tripped).toBe(true);
          expect(a.rearm(PARENT, 1)).toBe(false);
          expect(b.rearm(PARENT, 0)).toBe(true);
          expect(a.reserve(wake(3), 0)).toBe("suppressed");
          expect(a.reserve(wake(4), 1)).toBe("admitted");
        } else if (verdict === "unavailable") {
          expect(a.claimReview(PARENT)).toBe("settled");
          now += THIRTY_MINUTES;
          expect(a.reserve(wake(4), 0)).toBe("admitted");
        }
      } finally {
        first.close();
        second.close();
        removeTempStateDbDir(temp.tempDir);
      }
    }), { numRuns: 8, examples: [["loop", 0], ["continue", 0], ["unavailable", 0]] });
  });

  it("records SQLite commits for pending, admitted, tripped and rearmed wakes", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-job-monitor-writes-");
    const db = StateDb.open(temp.dbPath);
    const store = new TaskMonitorWakeStore(db.raw, () => THIRTY_MINUTES);
    const wake = (id: string) => ({ ...PARENT, monitorId: id });
    const measure = async (scenario: string, note: string, run: () => void) => {
      const { writes } = await measureSqliteWrites(run);
      expectSqliteWriteBudget({ scenario, note, writes });
    };
    try {
      await measure("job-monitor-wake-pending", "read the generation and check pending protection 100 times", () => {
        for (let index = 0; index < 100; index += 1) expect(store.read(PARENT).tripped).toBe(false);
      });
      await measure("job-monitor-wake-admitted", "reserve and claim dispatch of one final result", () => {
        expect(store.reserve(wake("first"), 0)).toBe("admitted");
        expect(store.dispatch(wake("first"), "owner", false)).toBe("admitted");
      });
      await measure("job-monitor-wake-release-check", "preview 100 operator releases without changing the dispatch receipt", () => {
        for (let index = 0; index < 100; index++) expect(store.canRelease(wake("first"), "owner", false)).toBe(true);
      });
      await measure("job-monitor-wake-unsent-steer", "release an owner claim for a definitively unsent steer", () => {
        store.releaseUnsent(PARENT, ["first"], "owner");
      });
      expect(store.dispatch(wake("first"), "new-owner", false)).toBe("admitted");
      expect(store.reserve(wake("second"), 0)).toBe("admitted");
      expect(store.reserve(wake("third"), 0)).toBe("admitted");
      const claim = () => {
        const review = store.claimReview(PARENT);
        if (typeof review === "string") throw new Error(`Expected a claimed review, received ${review}`);
        return review;
      };
      await measure("job-monitor-wake-reviewed", "claim one review and allow another tranche after differentiated work", () => {
        expect(store.reserve(wake("fourth"), 0)).toBe("review");
        expect(store.settleReview(PARENT, claim(), "continue")).toBe(true);
      });
      for (const id of ["fourth", "fifth", "sixth"]) expect(store.reserve(wake(id), 0)).toBe("admitted");
      await measure("job-monitor-wake-tripped", "claim a review and trip once on its verdict, then suppress 100 reports and a held dispatch", () => {
        expect(store.reserve(wake("seventh"), 0)).toBe("review");
        expect(store.settleReview(PARENT, claim(), "loop")).toBe(true);
        for (let index = 0; index < 100; index += 1) expect(store.reserve(wake(`blocked-${index}`), 0)).toBe("suppressed");
        expect(store.dispatch(wake("third"), "owner", false)).toBe("suppressed");
      });
      await measure("job-monitor-wake-acknowledged", "acknowledge a loop alert once without rearming", () => {
        expect(store.acknowledge(PARENT, 0)).toBe(true);
        expect(store.acknowledge(PARENT, 0)).toBe(false);
        expect(store.read(PARENT).tripped).toBe(true);
      });
      await measure("job-monitor-wake-rearmed", "rearm once and attempt to rearm again", () => {
        expect(store.rearm(PARENT)).toBe(true);
        expect(store.rearm(PARENT)).toBe(false);
      });
    } finally {
      db.close();
      removeTempStateDbDir(temp.tempDir);
      vi.unstubAllEnvs();
    }
  });
});
