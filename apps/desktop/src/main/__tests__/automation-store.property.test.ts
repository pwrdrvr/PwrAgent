import fc from "fast-check";
import { expect, expectTypeOf, it } from "vitest";
import type { AutomationStorage } from "@pwragent/owner-core/automation-storage";
import { AutomationStore } from "../storage/automation-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

it("round trips named automation routes while leaving an unloaded definition for older stores", () => {
  const db = openInMemoryStateDb();
  try {
    fc.assert(fc.property(fc.uuid(), fc.boolean(), (connectionId, namedTrigger) => {
      const store = new AutomationStore(db);
      const legacy = { channel: "telegram" as const, conversationId: "-100111", conversationKind: "channel" as const };
      const named = { ...legacy, connectionId };
      const automation = store.createAutomation({
        backend: "codex", threadId: "owner", name: "Orchard updates", taskPrompt: "Check.",
        triggers: [{ kind: "inbound_message", id: "fixture", conversation: namedTrigger ? named : legacy }],
        outputActions: [{ kind: "messaging_target", id: "reply", target: namedTrigger ? legacy : named }],
        now: 1,
      });
      const stored = db.raw.prepare("SELECT payload FROM automations WHERE automation_id = ?")
        .get(automation.id) as { payload: string };
      const old = JSON.parse(stored.payload);
      expect(old.triggers).toEqual([]);
      expect(old.outputActions).toBeUndefined();
      expect(old.schedule).toBeUndefined();
      expect(new AutomationStore(db).getAutomation(automation.id)).toMatchObject({
        triggers: automation.triggers,
        outputActions: automation.outputActions,
      });
    }), { numRuns: 8 });
  } finally {
    db.close();
  }
});

it("keeps a definition whose bot selectors leave the ID absent readable by older stores", () => {
  // Downgrade rule: only a named route hides a definition from an older
  // PwrAgent. The editor's original-bot choice omits the ID, so those
  // definitions stay where an older reader enumerates and runs them.
  const db = openInMemoryStateDb();
  try {
    const route = fc.record({
      conversationId: fc.constantFrom("-1001234567890", "42"),
      named: fc.boolean(),
    });
    fc.assert(fc.property(fc.array(route, { minLength: 1, maxLength: 3 }), route, (sources, target) => {
      const store = new AutomationStore(db);
      const conversation = (entry: { conversationId: string; named: boolean }) => ({
        channel: "telegram" as const,
        ...(entry.named ? { connectionId: `mc_${"d".repeat(32)}` } : {}),
        conversationId: entry.conversationId,
        conversationKind: "channel" as const,
      });
      const triggers = sources.map((entry, index) => ({
        kind: "inbound_message" as const, id: `source-${index}`, conversation: conversation(entry),
      }));
      const automation = store.createAutomation({
        backend: "codex", threadId: "owner", name: "Orchard updates", taskPrompt: "Check.",
        triggers,
        outputActions: [{ kind: "messaging_target", id: "reply", target: conversation(target) }],
        now: 1,
      });
      const stored = db.raw.prepare("SELECT payload FROM automations WHERE automation_id = ?")
        .get(automation.id) as { payload: string };
      const old = JSON.parse(stored.payload);
      const anyNamed = target.named || sources.some((entry) => entry.named);
      expect(old.triggers).toEqual(anyNamed ? [] : automation.triggers);
      expect(old.connectionRouting === undefined).toBe(!anyNamed);
      expect(new AutomationStore(db).getAutomation(automation.id)?.triggers).toEqual(automation.triggers);
    }), { numRuns: 25 });
  } finally {
    db.close();
  }
});

const statusRank = {
  pending: 0,
  queued: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
  skipped: 3,
} as const;

const turnRow = (
  backend: "codex" | "claude",
  turnId: string | null,
  status: string,
  updatedAt: number,
  payload = "{}",
) => ({ backend, turnId, status, updatedAt, payload });

it("sums each run's latest price even when its history has been pruned", () => {
  const db = openInMemoryStateDb();
  try {
    fc.assert(fc.property(
      fc.nat(100),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.nat(100)), {
        minLength: 8,
        maxLength: 25,
      }),
      (firstCost, updates) => {
        db.raw.exec("DELETE FROM automations");
        const store = new AutomationStore(db, { runHistoryLimit: 1 });
        const automation = store.createAutomation({
          id: "cost", backend: "codex", threadId: "owner", name: "Costs",
          taskPrompt: "Check.", schedule: { kind: "interval", every: 5, unit: "minutes" },
          now: 1,
        });
        const latest = new Map([[0, firstCost]]);
        for (const index of [0, 1, 2]) {
          const id = `run-${index}`;
          const now = index + 2;
          store.createRun({ id, automationId: automation.id, trigger: "manual", now });
          store.markRunStarted({ runId: id, backendTurnId: `turn-${index}`, now });
          store.markRunTerminal({ runId: id, status: "completed", now });
          if (index === 0) {
            store.setRunUsage({ runId: id, usage: { totalCostMicros: firstCost }, now });
          }
        }
        expect(store.listRunsForAutomation(automation.id).map((run) => run.id)).toEqual(["run-2"]);
        expect(store.getAutomation(automation.id)?.lifetimeCost).toEqual({ since: 1, totalMicros: firstCost });

        for (const [step, [index, micros]] of updates.entries()) {
          latest.set(index, micros);
          for (let repeat = 0; repeat < 2; repeat += 1) {
            store.setRunUsage({ runId: `run-${index}`, usage: { totalCostMicros: micros }, now: step + 10 });
            expect(store.getAutomation(automation.id)).toMatchObject({
              lifetimeCost: {
                since: 1,
                totalMicros: [...latest.values()].reduce((sum, cost) => sum + cost, 0),
              },
            });
          }
        }
      },
    ), { numRuns: 30 });
  } finally {
    db.close();
  }
});

it("resolves turn ids by backend, update time, rowid, and running precedence", () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      backend: fc.constantFrom("codex" as const, "claude" as const),
      turnId: fc.constantFrom("generated-a", "generated-b", null),
      status: fc.constantFrom("queued", "running", "completed", "failed"),
      updatedAt: fc.nat(3),
      payload: fc.constantFrom("{}", "{", "null"),
    }), { maxLength: 20 }),
    (generated) => {
      const db = openInMemoryStateDb();
      try {
        const store = new AutomationStore(db);
        for (const backend of ["codex", "claude"] as const) {
          store.createAutomation({
            id: backend,
            backend,
            threadId: `owner-${backend}`,
            name: "Turn resolution",
            taskPrompt: "Check.",
            schedule: { kind: "interval", every: 5, unit: "minutes" },
            now: 0,
          });
        }
        const insert = db.raw.prepare(`INSERT INTO automation_runs
          (run_id, automation_id, backend, thread_id, status, trigger, backend_turn_id, created_at, updated_at, payload)
          VALUES (?, ?, ?, ?, ?, 'manual', ?, 0, ?, ?)`);
        // Include ambiguous and older stored rows that a normal run lifecycle
        // would not create today. A corrupt winner does not expose an older row.
        const rows = [
          turnRow("codex", "shared", "running", 3),
          turnRow("codex", "shared", "running", 3),
          turnRow("codex", "shared", "completed", 7),
          turnRow("claude", "shared", "running", 9),
          turnRow("codex", "late", "failed", 4),
          turnRow("codex", "late", "completed", 4),
          turnRow("codex", "stale", "queued", 2),
          turnRow("codex", "corrupt", "running", 2),
          turnRow("codex", "corrupt", "running", 3, "{"),
          turnRow("codex", "corrupt", "completed", 6),
          turnRow("codex", "corrupt-terminal", "completed", 4),
          turnRow("codex", "corrupt-terminal", "completed", 4, "null"),
          turnRow("codex", "", "running", 1),
          ...generated,
        ].map((row, index) => ({ ...row, id: `run-${index}`, rowid: index + 1 }));
        for (const row of rows) {
          insert.run(row.id, row.backend, row.backend, `owner-${row.backend}`, row.status, row.turnId, row.updatedAt, row.payload);
        }
        const turnIds = ["late", "shared", "stale", "corrupt", "corrupt-terminal", "", "missing", "generated-b", "shared", "generated-a"];
        const idOf = (row: typeof rows[number] | undefined) => row?.payload === "{}" ? row.id : undefined;

        const expectLookupsMatch = () => {
          for (const backend of ["codex", "claude"] as const) {
            const byRecency = rows.filter((row) => row.backend === backend)
              .sort((a, b) => b.updatedAt - a.updatedAt || b.rowid - a.rowid);
            const expectedBatch = new Map<string, string>();
            const seen = new Set<string>();
            // Batch insertion order follows the newest row per turn, even
            // when the chosen running row is older than a terminal duplicate.
            for (const turn of byRecency) {
              const turnId = turn.turnId;
              if (!turnId || !turnIds.includes(turnId) || seen.has(turnId)) continue;
              seen.add(turnId);
              const running = byRecency.find((row) => row.turnId === turnId && row.status === "running");
              const id = idOf(running ?? turn);
              if (id !== undefined) expectedBatch.set(turnId, id);
            }
            for (const backendTurnId of turnIds) {
              const params = { backend, backendTurnId };
              const matching = byRecency.filter((row) => row.turnId === backendTurnId);
              expect(store.findRunByBackendTurnId(params)?.id).toBe(idOf(matching[0]));
              expect(store.findRunningRunByBackendTurnId(params)?.id)
                .toBe(idOf(matching.find((row) => row.status === "running")));
            }
            expect([...store.findRunsByBackendTurnIds({ backend, backendTurnIds: turnIds })]
              .map(([turnId, run]) => [turnId, run.id])).toEqual([...expectedBatch]);
            expect(store.findRunsByBackendTurnIds({ backend, backendTurnIds: [] }).size).toBe(0);
          }
        };

        expectLookupsMatch();
        // Late pricing advances updated_at, so an older row can become the
        // newest match while its rowid, backend, and turn id stay the same.
        const late = rows[4]!;
        expect(store.setRunUsage({ runId: late.id, usage: { totalCostMicros: 5 }, now: 10 })?.usage)
          .toEqual({ totalCostMicros: 5 });
        late.updatedAt = 10;
        expectLookupsMatch();
      } finally {
        db.close();
      }
    },
  ), { numRuns: 30 });
});

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
