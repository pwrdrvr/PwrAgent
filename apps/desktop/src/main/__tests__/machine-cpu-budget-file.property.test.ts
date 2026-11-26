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

  it("retries stale budget file deletion after a transient unlink failure", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pwragent-cpu-budget-retry-")));
    const budgetPath = machineCpuBudgetFilePath(root, "default");
    let remainingFailures = 1;
    const warnings: unknown[] = [];
    const publisher = createMachineCpuBudgetPublisher({
      pwragentRoot: root,
      profile: "default",
      instanceId: "inst-default",
      localThreadDirectories: () => [path.join(root, "wt")],
      removeFile: (filePath) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("EBUSY");
        }
        rmSync(filePath, { force: true });
      },
      warn: (error) => warnings.push(error),
    });

    try {
      publisher.sync({
        resourceId: "machine:m1:cpu",
        canonicalKey: "machine:m1:cpu",
        displayName: "This machine",
        kindLabel: "Machine compute",
        aliases: [],
        conflictDomainIds: ["machine:m1:cpu"],
        relatedResourceIds: [],
        placement: "machine",
        visibility: "machine",
        allocationScope: "machine",
        authorityId: "machine:m1:cpu",
        condition: "available",
        sharing: { mode: "counted", capacity: 18, inUse: 4, unitLabel: "CPU slots" },
        enforcement: { coverage: "advisory", summary: "", gaps: [] },
        allocations: [{
          allocationId: "alloc-1",
          state: "granted",
          holder: { kind: "thread", thread: { backend: "claude", threadId: "t1", title: "T1", instanceId: "inst-default" } },
          taskLabel: "tests",
          executorLabel: "No managed job",
          grantedAt: 1_000,
          deadlineAt: 60_000,
          renewalsUsed: 0,
          renewalsAllowed: 1,
          authorityEpoch: 1,
          generation: 1,
          units: 4,
          lastKnown: false,
          viewerOwns: false,
        }],
        queue: [],
        readiness: [],
        advertisements: [],
        routes: [],
        instructions: null,
        policy: { useScope: "", manageScope: "", maxHoldMs: 1_000, renewalRule: "", queueOrder: "backfill", costCeilingLabel: "", finalEffect: "" },
        cleanup: { state: "verified", detail: "" },
        recovery: null,
        recoveries: [],
        ownershipConflict: null,
        definition: { revision: 1, updatedAt: 1_000, publication: "published" },
        actions: {},
      }, 1_000);
      expect(existsSync(budgetPath)).toBe(true);

      // First cleanup hits transient EBUSY: file remains, so lastFingerprint must stay dirty.
      publisher.sync(undefined, 2_000);
      expect(warnings).toHaveLength(1);
      expect(existsSync(budgetPath)).toBe(true);

      // Next sync retries and deletes the stale file.
      publisher.sync(undefined, 3_000);
      expect(existsSync(budgetPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes the delegated executor thread when a machine CPU grant is handed off", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pwragent-cpu-budget-handoff-")));
    const requesterDir = path.join(root, "worktrees", "requester");
    const executorDir = path.join(root, "worktrees", "executor");
    const directories = new Map<string, string[]>([
      ["requester", [requesterDir]],
      ["executor", [executorDir]],
    ]);
    const now = 10_000;
    const publisher = createMachineCpuBudgetPublisher({
      pwragentRoot: root,
      profile: "default",
      instanceId: "inst-default",
      localThreadDirectories: ({ threadId }) => directories.get(threadId),
    });
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "inst-default", instanceLabel: "Studio", profile: "default", machineId: "mach-1" },
      machineStore: openResourceCheckoutStore(path.join(root, "resource-checkouts.db"), "mach-1"),
      machineCpuCount: 12,
      bindings: [],
      now: () => now,
      requestPeer: async () => { throw new Error("Offline"); },
      machineCpuBudgetPublisher: publisher,
      warn: () => {},
    });

    try {
      const resourceId = service.read().resources[0]!.resourceId;
      const grant = await service.perform({
        kind: "request",
        idempotencyKey: "req-handoff",
        resourceId,
        purpose: "delegated run",
        expectedDurationMs: 60_000,
        units: 6,
      }, service.threadActor("claude", "requester"));
      expect(grant.outcome).toBe("granted");
      if (grant.outcome !== "granted") return;

      const delegated = await service.perform({
        kind: "delegate_execution",
        idempotencyKey: "del-handoff",
        resourceId,
        allocationId: grant.allocationId,
        generation: grant.generation,
        authorityEpoch: 1,
        executor: { backend: "codex", threadId: "executor", instanceId: "inst-default" },
      }, service.threadActor("claude", "requester"), true);
      expect(delegated.outcome).toBe("accepted");

      expect(resolveLocalCpuBudget({
        cwd: executorDir,
        env: { PWRAGENT_HOME: root, PWRAGENT_BACKEND: "codex", PWRAGENT_THREAD_ID: "executor" },
        now,
        fallback: null,
      })?.units).toBe(6);
      expect(resolveLocalCpuBudget({
        cwd: requesterDir,
        env: { PWRAGENT_HOME: root, PWRAGENT_BACKEND: "claude", PWRAGENT_THREAD_ID: "requester" },
        now,
        fallback: null,
      })).toBeUndefined();
    } finally {
      await service.close(0);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
