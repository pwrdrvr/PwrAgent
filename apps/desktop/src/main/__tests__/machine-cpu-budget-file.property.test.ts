import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import {
  createMachineCpuBudgetPublisher,
  machineCpuBudgetFilePath,
  type MachineCpuBudgetSnapshot,
} from "../resource-checkouts/machine-cpu-budget-file";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { resolveLocalCpuBudget } from "../../../../../scripts/local-cpu-budget.mjs";

/**
 * Rule: a profile's published machine-CPU budget snapshot mirrors exactly the
 * active granted machine-CPU allocations owned by threads on that profile, with
 * their exact units, deadlines, and worktree directories. When grants expire,
 * are released, or the service closes, the snapshot clears so commands never
 * observe stale budgets.
 */

type ModelGrant = {
  allocationId: string;
  generation: number;
  threadId: string;
  units: number;
  deadlineAt: number;
  directory: string;
};

type Step =
  | { kind: "request"; threadIndex: number; units: number; durationMs: number }
  | { kind: "release"; threadIndex: number }
  | { kind: "advance"; deltaMs: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("request" as const),
    threadIndex: fc.integer({ min: 0, max: 3 }),
    units: fc.integer({ min: 1, max: 4 }),
    durationMs: fc.integer({ min: 1_000, max: 10_000 }),
  }),
  fc.record({
    kind: fc.constant("release" as const),
    threadIndex: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({
    kind: fc.constant("advance" as const),
    deltaMs: fc.integer({ min: 500, max: 6_000 }),
  }),
);

describe("machine CPU budget file publication", () => {
  it("tracks active thread grants across request, release, expiry, and shutdown", async () => {
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 14 }), async (steps) => {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pwragent-cpu-budget-pub-")));
      let now = 10_000;
      const directories = new Map<string, string[]>();
      for (let index = 0; index < 4; index += 1) {
        const threadId = `thread-${index}`;
        const worktree = path.join(root, "worktrees", threadId);
        directories.set(threadId, [worktree]);
      }

      const publisher = createMachineCpuBudgetPublisher({
        pwragentRoot: root,
        profile: "default",
        instanceId: "inst-default",
        localThreadDirectories: ({ threadId }) => directories.get(threadId),
      });
      const service = new DesktopResourceCheckoutService({
        viewer: { instanceId: "inst-default", instanceLabel: "Studio", profile: "default", machineId: "mach-1" },
        machineStore: openResourceCheckoutStore(path.join(root, "resource-checkouts.db"), "mach-1"),
        machineCpuCount: 8,
        bindings: [],
        now: () => now,
        requestPeer: async () => { throw new Error("Offline"); },
        machineCpuBudgetPublisher: publisher,
        warn: () => {},
      });

      const budgetPath = machineCpuBudgetFilePath(root, "default");
      const activeByThread = new Map<string, ModelGrant>();
      let keyCounter = 0;

      try {
        const resourceId = service.read().resources[0]!.resourceId;
        const assertMatchesModel = () => {
          for (const [threadId, grant] of activeByThread) {
            if (grant.deadlineAt <= now) activeByThread.delete(threadId);
          }
          if (activeByThread.size === 0) {
            expect(existsSync(budgetPath)).toBe(false);
            for (const [threadId, dirs] of directories) {
              expect(resolveLocalCpuBudget({
                cwd: dirs[0]!,
                env: { PWRAGENT_HOME: root, PWRAGENT_BACKEND: "claude", PWRAGENT_THREAD_ID: threadId },
                now,
                fallback: null,
              })).toBeUndefined();
            }
            return;
          }
          expect(existsSync(budgetPath)).toBe(true);
          const parsed = JSON.parse(readFileSync(budgetPath, "utf8")) as MachineCpuBudgetSnapshot;
          expect(parsed.version).toBe(1);
          expect(parsed.capacity).toBe(8);
          const actual = [...parsed.grants].sort((a, b) => a.threadId.localeCompare(b.threadId));
          const expected = [...activeByThread.values()]
            .map((grant) => ({
              allocationId: grant.allocationId,
              units: grant.units,
              deadlineAt: grant.deadlineAt,
              backend: "claude",
              threadId: grant.threadId,
              directories: [grant.directory],
            }))
            .sort((a, b) => a.threadId.localeCompare(b.threadId));
          expect(actual).toEqual(expected);

          // Oracle check: the repo reader resolves every active worktree to its exact granted units.
          for (const grant of activeByThread.values()) {
            const resolved = resolveLocalCpuBudget({
              cwd: grant.directory,
              env: { PWRAGENT_HOME: root },
              now,
            });
            expect(resolved?.units).toBe(grant.units);
          }
        };

        for (const step of steps) {
          if (step.kind === "advance") {
            now += step.deltaMs;
            service.read();
          } else if (step.kind === "request") {
            const threadId = `thread-${step.threadIndex}`;
            if (activeByThread.has(threadId)) continue;
            const used = [...activeByThread.values()]
              .filter((grant) => grant.deadlineAt > now)
              .reduce((sum, grant) => sum + grant.units, 0);
            if (used + step.units > 8) continue;
            const result = await service.perform({
              kind: "request",
              idempotencyKey: `req-${keyCounter++}`,
              resourceId,
              purpose: `work-${step.threadIndex}`,
              expectedDurationMs: step.durationMs,
              units: step.units,
            }, service.threadActor("claude", threadId));
            expect(result.outcome).toBe("granted");
            if (result.outcome === "granted") {
              activeByThread.set(threadId, {
                allocationId: result.allocationId,
                generation: result.generation,
                threadId,
                units: step.units,
                deadlineAt: now + step.durationMs,
                directory: directories.get(threadId)![0]!,
              });
            }
          } else if (step.kind === "release") {
            const threadId = `thread-${step.threadIndex}`;
            const held = activeByThread.get(threadId);
            if (!held || held.deadlineAt <= now) continue;
            const result = await service.perform({
              kind: "release",
              idempotencyKey: `rel-${keyCounter++}`,
              resourceId,
              allocationId: held.allocationId,
              generation: held.generation,
            }, service.threadActor("claude", threadId));
            expect(result.outcome).toBe("accepted");
            activeByThread.delete(threadId);
          }
          assertMatchesModel();
        }
      } finally {
        await service.close(0);
        expect(existsSync(budgetPath)).toBe(false);
        rmSync(root, { recursive: true, force: true });
      }
    }), { numRuns: 25 });
  });
});
