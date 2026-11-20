import fc from "fast-check";
import { expect, it } from "vitest";
import {
  AUTOMATION_DAILY_RUN_LIMIT_WINDOW_MS,
  type AutomationRunSourceMetadata,
} from "@pwragent/shared";
import type { AutomationRunner } from "../automations/automation-runner";
import { AutomationScheduler } from "../automations/automation-scheduler";
import { AutomationStore } from "../storage/automation-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/**
 * The rule, from PWR-225: an automation's daily run limit is checked when a
 * run is admitted, so no sequence of triggers admits more runs than the limit
 * in any rolling 24 hours. It holds across a restart, which loses everything
 * the scheduler kept in memory, and across a clock set back, which leaves runs
 * stamped later than "now" behind.
 *
 * A restart here is a new store and scheduler over the same database: the
 * scheduler's timers, coalescing windows and caches are gone, and every
 * count is read back from the run rows, as after a real launch. (A file
 * database reopened per restart costs an fsync per commit on macOS, which
 * puts 40 runs far past the test timeout without testing anything more.)
 *
 * Every trigger kind admits runs here: schedule windows, inbound messages and
 * Run now. Runs finish at random, so the lane is sometimes busy and sometimes
 * free, and the operator sometimes resumes the automation while its runs are
 * still inside the window. The oracle is the run rows themselves: every run
 * that started, or will start, a turn is one the limit admitted.
 */

const INTERVAL_MS = 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const AUTOMATION_ID = "automation-limit";

type Command =
  | { kind: "advance"; ms: number }
  | { kind: "rollback"; ms: number }
  | { kind: "inbound" }
  | { kind: "runNow" }
  | { kind: "finishRun" }
  | { kind: "restart" }
  | { kind: "resume" };

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 12 * HOUR_MS }).map((ms) => ({ kind: "advance" as const, ms })) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 48 * HOUR_MS }).map((ms) => ({ kind: "rollback" as const, ms })) },
  { weight: 4, arbitrary: fc.constant({ kind: "inbound" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "runNow" as const }) },
  { weight: 3, arbitrary: fc.constant({ kind: "finishRun" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "restart" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "resume" as const }) },
);

function source(key: number, now: number): AutomationRunSourceMetadata {
  return {
    kind: "messaging",
    sourceEventKey: `event-${key}`,
    receivedAt: now,
    matchedTriggerId: "trigger-inbound",
    actor: { id: "user-1" },
    conversation: { channel: "slack", conversationId: "C1" },
  } as unknown as AutomationRunSourceMetadata;
}

it("never admits more runs than the daily limit in any rolling 24 hours", async () => {
  let reachedLimit = 0;
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 4 }),
    fc.constantFrom("coalesce" as const, "drop_missed" as const),
    fc.array(commandArbitrary, { minLength: 30, maxLength: 60 }),
    async (limit, backlogPolicy, commands) => {
      const db = openInMemoryStateDb();
      try {
      let now = 0;
      let turn = 0;
      let eventKey = 0;
      const runner: AutomationRunner = {
        async submitRun() {
          turn += 1;
          return { status: "started", queueEntryId: `queue-${turn}`, turnId: `turn-${turn}` };
        },
      };
      let store = new AutomationStore(db);
      store.createAutomation({
        id: AUTOMATION_ID,
        backend: "codex",
        threadId: "thread-1",
        name: "Limited",
        taskPrompt: "Run",
        backlogPolicy,
        schedule: { kind: "interval", every: 1, unit: "hours", anchorAt: 0 },
        inboundCoalesceWindowMs: 0,
        maxRunsPerHour: null,
        dailyRunLimit: limit,
        nextRunAt: INTERVAL_MS,
        now,
      });
      const build = () => new AutomationScheduler({
        store,
        runner,
        now: () => now,
        setTimer: (() => 0) as unknown as typeof setTimeout,
        clearTimer: () => undefined,
      });
      let scheduler = build();

      for (const command of commands) {
        const automation = store.getAutomation(AUTOMATION_ID)!;
        switch (command.kind) {
          case "advance":
            now += command.ms;
            await scheduler.evaluateDueAutomations();
            break;
          case "rollback":
            now = Math.max(0, now - command.ms);
            break;
          case "inbound":
            eventKey += 1;
            // As the service routes it: a paused automation records the
            // message as skipped; an enabled one runs it.
            if (automation.pausedReason === "daily_run_limit") {
              scheduler.recordSkipWhilePaused(automation, {
                trigger: "inbound_message",
                source: source(eventKey, now),
              });
            } else if (automation.status === "enabled") {
              await scheduler.runFromInboundEvent({
                automation,
                source: source(eventKey, now),
                now,
              });
            }
            break;
          case "runNow":
            await scheduler.runNow(AUTOMATION_ID, now);
            break;
          case "finishRun": {
            const running = store.listRunsForAutomation(AUTOMATION_ID, 500)
              .find((run) => run.status === "running");
            if (running) {
              await scheduler.handleTurnQueueUpdate({
                automationRunId: running.id,
                status: "terminal",
                terminalStatus: "turn/completed",
                now,
              });
            }
            break;
          }
          case "restart":
            store = new AutomationStore(db);
            scheduler = build();
            break;
          case "resume":
            if (automation.status === "paused") {
              store.resumeAutomation(AUTOMATION_ID, { nextRunAt: now + INTERVAL_MS, now });
            }
            break;
        }
      }

      const admitted = (db.raw.prepare(
        "SELECT created_at FROM automation_runs WHERE automation_id = ? AND status != 'skipped' ORDER BY created_at",
      ).all(AUTOMATION_ID) as Array<{ created_at: number }>).map((row) => row.created_at);
      // Every window that holds the most runs starts at one of them.
      for (const [index, start] of admitted.entries()) {
        let inWindow = 0;
        for (const at of admitted.slice(index)) {
          if (at < start + AUTOMATION_DAILY_RUN_LIMIT_WINDOW_MS) inWindow += 1;
        }
        expect(inWindow).toBeLessThanOrEqual(limit);
      }
      if (store.listRunsForAutomation(AUTOMATION_ID, 500)
        .some((run) => run.skipReason === "daily_limit")) {
        reachedLimit += 1;
      }
      } finally {
        db.close();
      }
    },
  ), { numRuns: 20 });
  // The generator must actually drive automations into their limit.
  expect(reachedLimit).toBeGreaterThan(5);
}, 20_000);
