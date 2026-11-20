import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadDependency } from "@pwragent/shared/contracts/thread-dependencies";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadDependencyCoordinator } from "../app-server/thread-dependency-coordinator";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

const dependency = (id: string, patch: Partial<ThreadDependency> = {}): ThreadDependency => ({
  id, backend: "codex", threadId: "consumer", mode: "any", onFailure: "notify",
  conditions: [{ backend: "codex", threadId: "worker", when: "turn_completed", turnId: id }],
  continuation: `Collect result ${id}`, status: "waiting", evidence: [], createdAt: 1, updatedAt: 1,
  ...patch,
});

async function withStore(run: (store: ThreadDependencyStore) => void | Promise<void>) {
  const { tempDir, dbPath } = createTempStateDb("dependency-registration-");
  const db = StateDb.open(dbPath);
  try { await run(new ThreadDependencyStore(db.raw)); }
  finally { db.close(); removeTempStateDbDir(tempDir); }
}

describe("dependency registration admission", () => {
  it("stops admitting existing waits after one delivery becomes uncertain", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (count) => {
      await withStore(async (store) => {
        const waits = Array.from({ length: count }, (_, index) => dependency(`wait-${index}`));
        waits.forEach((item) => store.register(item));
        const submit = vi.fn(async () => {
          if (submit.mock.calls.length === 1) throw new Error("Transport lost after possible admission");
          return { status: "started" as const, turnId: "continued" };
        });
        const coordinator = new ThreadDependencyCoordinator({
          store, submit, changed: async () => {},
          readThread: async () => ({ turns: waits.map((item) => ({ id: item.id, status: "completed" as const })), prs: [] }),
        });
        await coordinator.reconcile();
        await coordinator.reconcile();
        expect(submit).toHaveBeenCalledTimes(1);
        expect(store.active().filter((item) => item.error)).toHaveLength(1);
        store.dismiss("codex", "consumer", "wait-0", 2);
        // Review releases every held wait at once; the consumer's queue
        // shares them in one delivery instead of one turn each.
        await coordinator.reconcile();
        expect(submit).toHaveBeenCalledTimes(count);
      });
    }), { numRuns: 10 });
  });

  it("requires delivery review before changed plans or worker turns can add another agent wake", async () => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.string({ minLength: 1 }), async (turnId, continuation) => {
      await withStore(async (store) => {
        const original = store.register(dependency("uncertain"));
        store.replace(original, { ...original, status: "dispatching", error: "Admission is uncertain" });
        const { writes } = await measureSqliteWrites(() => {
          expect(() => store.register(dependency(turnId, { continuation }))).toThrow("delivery needs review");
        });
        expectSqliteWriteBudget({
          scenario: "thread-dependencies-review-refusal", writes,
          note: "Refusing a replacement agent wake while delivery needs review: zero commits and 0 MB/day.",
        });
        expect(store.active()).toHaveLength(1);
        // Human reminders and a different consumer do not start this thread.
        expect(store.register(dependency("reminder", { deliver: "operator" })).id).toBe("reminder");
        expect(store.register(dependency("other", { threadId: "other-consumer" })).id).toBe("other");
        store.dismiss("codex", "consumer", original.id, 2);
        expect(store.register(dependency(turnId, { continuation })).id).toBe(turnId);
      });
    }), { numRuns: 25 });
  });

  it("retires reviewed uncertain deliveries together, never replays them, and then admits the held waits", async () => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 31 }), fc.integer({ min: 0, max: 3 }), fc.boolean(),
      async (claims, held, includeStranger) => {
        await withStore(async (store) => {
          const uncertainIds = Array.from({ length: claims }, (_, index) => `claim-${index}`);
          // Waits registered before the claims went uncertain, now held behind them.
          const heldIds = Array.from({ length: Math.min(held, 32 - claims) }, (_, index) => `held-${index}`);
          const registered = [...uncertainIds, ...heldIds].map((id) => store.register(dependency(id)));
          for (const item of registered) {
            store.replace(item, uncertainIds.includes(item.id)
              ? { ...item, status: "dispatching", dispatchOwnerPid: 1, error: "Continuation delivery needs review: provider error" }
              : { ...item, status: "ready", outcome: "success" });
          }
          const submit = vi.fn(async () => ({ status: "started" as const, turnId: "continued" }));
          const coordinator = new ThreadDependencyCoordinator({
            store, submit, changed: async () => {}, now: () => 5,
            readThread: async () => ({ turns: [...uncertainIds, ...heldIds].map((id) => ({ id, status: "completed" as const })), prs: [] }),
          });
          const request = { action: "dismiss" as const, backend: "codex" as const, threadId: "consumer" };
          // A list naming anything but an uncertain delivery changes nothing.
          if (includeStranger && heldIds.length) {
            await expect(coordinator.manage({ ...request, dependencyIds: [...uncertainIds, heldIds[0]!] })).rejects.toThrow("Only an uncertain delivery");
            expect(store.active().filter((item) => item.status === "dispatching")).toHaveLength(claims);
          }
          await coordinator.reconcile();
          expect(submit).not.toHaveBeenCalled();
          const { writes } = await measureSqliteWrites(() => {
            store.dismissMany("codex", "consumer", uncertainIds, 5);
          });
          expect(writes.commits).toBe(1);
          expect(store.list("codex", "consumer").filter((item) => uncertainIds.includes(item.id)).every((item) => item.status === "dismissed")).toBe(true);
          // Dismissal releases the held waits, and all of them are admitted.
          await coordinator.reconcile();
          expect(submit).toHaveBeenCalledTimes(heldIds.length);
          for (const call of submit.mock.calls as unknown as [{ messageOrigin: { dependencyId: string } }][]) {
            expect(uncertainIds).not.toContain(call[0].messageOrigin.dependencyId);
          }
        });
      },
    ), { numRuns: 25 });
  });

  it("budgets one commit to dismiss 32 reviewed deliveries", async () => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    await withStore(async (store) => {
      const ids = Array.from({ length: 32 }, (_, index) => `claim-${index}`);
      for (const item of ids.map((id) => store.register(dependency(id)))) {
        store.replace(item, { ...item, status: "dispatching", error: "Continuation delivery needs review: provider error" });
      }
      const coordinator = new ThreadDependencyCoordinator({
        store, submit: vi.fn(), changed: async () => {}, readThread: async () => ({ turns: [], prs: [] }),
      });
      const { writes } = await measureSqliteWrites(async () => {
        await coordinator.manage({ action: "dismiss", backend: "codex", threadId: "consumer", dependencyIds: ids });
      });
      expectSqliteWriteBudget({
        scenario: "thread-dependencies-review-dismiss-32",
        note: "The reviewed cleanup of 32 uncertain deliveries: one commit (~21 KB WAL), only when the operator confirms a review; no timer or per-event cost.",
        writes,
      });
      expect(store.active()).toEqual([]);
      await expect(coordinator.manage({ action: "dismiss", backend: "codex", threadId: "consumer", dependencyIds: ids }))
        .rejects.toThrow("Only an uncertain delivery");
    });
  });

  it("keeps the per-thread cap across different plans and pinned turns", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 33, max: 40 }), async (attempts) => {
      await withStore((store) => {
        for (let index = 0; index < attempts; index++) {
          const candidate = dependency(`wait-${index}`);
          if (index < 32) store.register(candidate);
          else expect(() => store.register(candidate)).toThrow("32 active dependencies");
        }
        expect(store.active()).toHaveLength(32);
        // An identical retry at capacity returns its existing registration.
        expect(store.register(dependency("wait-0")).id).toBe("wait-0");
      });
    }), { numRuns: 10 });
  });
});
