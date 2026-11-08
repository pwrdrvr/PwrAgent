import fc from "fast-check";
import { expect, expectTypeOf, it } from "vitest";
import type { AutomationStorage } from "@pwragent/owner-core/automation-storage";
import { AutomationStore } from "../storage/automation-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const statusRank = {
  pending: 0,
  queued: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
  skipped: 3,
} as const;

it("never moves an automation run backwards and keeps its first terminal outcome", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("queued", "started", "completed", "failed", "cancelled", "skipped"), {
      maxLength: 30,
    }),
    (events) => {
      // StateDb.open uses the migrated template in desktop-main, including for :memory:.
      const db = openInMemoryStateDb();
      try {
        const store: AutomationStorage = new AutomationStore(db);
        store.createAutomation({
          id: "automation-1",
          backend: "codex",
          threadId: "thread-1",
          name: "Lifecycle property",
          taskPrompt: "Check lifecycle",
          schedule: { kind: "interval", every: 5, unit: "minutes" },
          now: 0,
        });
        expect(store.createRun({
          id: "run-1", automationId: "automation-1", trigger: "manual", now: 0,
        })?.status).toBe("pending");

        let rank = statusRank.pending as number;
        let firstTerminal: { status: string; completedAt: number; errorMessage: string } | undefined;
        for (const [index, event] of events.entries()) {
          const now = index + 1;
          if (event === "queued") {
            store.markRunQueued({ runId: "run-1", queueEntryId: "queue-1", now });
          } else if (event === "started") {
            store.markRunStarted({ runId: "run-1", backendTurnId: "turn-1", now });
          } else {
            const outcome = { status: event, completedAt: now, errorMessage: `Outcome ${index}` };
            firstTerminal ??= outcome;
            store.markRunTerminal({ runId: "run-1", ...outcome, now });
          }

          const run = store.getRun("run-1");
          expect(run).toBeDefined();
          expect(statusRank[run!.status]).toBeGreaterThanOrEqual(rank);
          rank = statusRank[run!.status];
          if (firstTerminal) expect(run).toMatchObject(firstTerminal);
        }
      } finally {
        db.close();
      }
    },
  ), { numRuns: 50 });
});

it("exposes the complete automation persistence contract without a constructor or database", async () => {
  expectTypeOf<keyof AutomationStorage>().toEqualTypeOf<keyof AutomationStore>();
  expect(Object.keys(await import("../automations/automation-store"))).toEqual([]);
});
