import fc from "fast-check";
import { expect, it } from "vitest";
import type { AutomationRunSourceMetadata } from "@pwragent/shared/contracts/automations";
import type { AutomationRunner } from "../automations/automation-runner";
import {
  AutomationScheduler,
  SKIP_MARKER_FLUSH_MS,
} from "../automations/automation-scheduler";
import { AutomationStore } from "../storage/automation-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/**
 * The rule: an inbound message dropped by the hourly run cap is counted on its
 * hour's throttle marker, and the marker is written at most once a minute.
 * After the scheduler stops, every marker's count is exact: the dropped
 * messages of its hour, no more and no fewer.
 *
 * The oracle is the scheduler's own admission: every message is either an
 * admitted (non-skipped) run or a drop, so the drops are the messages minus
 * the admitted runs. Writes are observed at the store, per marker.
 */

const AUTOMATION_ID = "automation-throttle";
const HOUR_MS = 60 * 60 * 1_000;

type Command =
  | { kind: "message" }
  | { kind: "advance"; ms: number }
  | { kind: "fireTimers" };

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ kind: "message" as const }) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 3 * SKIP_MARKER_FLUSH_MS })
      .map((ms) => ({ kind: "advance" as const, ms })),
  },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 0, max: 30 * SKIP_MARKER_FLUSH_MS })
      .map((ms) => ({ kind: "advance" as const, ms })),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "fireTimers" as const }) },
);

function source(key: number, now: number): AutomationRunSourceMetadata {
  return {
    kind: "messaging",
    sourceEventKey: `event-${key}`,
    receivedAt: now,
    matchedTriggerId: "trigger-inbound",
    actor: { platformUserId: "B1", isBot: true },
    conversation: { channel: "slack", conversationId: "C1" },
    message: { text: "ERROR" },
  } as unknown as AutomationRunSourceMetadata;
}

it("counts every throttled message exactly and writes a marker at most once a minute", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 3 }),
    fc.array(commandArbitrary, { minLength: 20, maxLength: 150 }),
    async (maxRunsPerHour, commands) => {
      const db = openInMemoryStateDb();
      try {
        let now = 1_000;
        let turn = 0;
        const runner: AutomationRunner = {
          async submitRun() {
            turn += 1;
            return { status: "started", queueEntryId: `queue-${turn}`, turnId: `turn-${turn}` };
          },
        };
        const store = new AutomationStore(db);
        const automation = store.createAutomation({
          id: AUTOMATION_ID,
          backend: "codex",
          threadId: "thread-1",
          name: "Throttled",
          taskPrompt: "Triage",
          inboundCoalesceWindowMs: 0,
          maxRunsPerHour,
          triggers: [{
            id: "trigger-inbound",
            kind: "inbound_message",
            conversation: { channel: "slack", conversationId: "C1" },
          }],
          now,
        });

        // Every write of a throttle marker, by marker id.
        const markerWrites = new Map<string, number[]>();
        const noteWrite = (id: string, at: number) => {
          if (!id.startsWith("automation-throttle:")) return;
          markerWrites.set(id, [...(markerWrites.get(id) ?? []), at]);
        };
        const createRun = store.createRun.bind(store);
        store.createRun = (input) => {
          const run = createRun(input);
          if (run && input.id) noteWrite(input.id, input.now ?? now);
          return run;
        };
        const coalesce = store.coalesceRateLimitedRun.bind(store);
        store.coalesceRateLimitedRun = (params) => {
          const before = store.getRun(params.runId)?.coalescedCount;
          const run = coalesce(params);
          if (run?.coalescedCount !== before) noteWrite(params.runId, params.now);
          return run;
        };

        const timers: Array<{ dueAt: number; fire: () => void; cleared: boolean }> = [];
        const scheduler = new AutomationScheduler({
          store,
          runner,
          now: () => now,
          setTimer: ((fire: () => void, ms: number) => {
            const timer = { dueAt: now + ms, fire, cleared: false };
            timers.push(timer);
            return timer;
          }) as unknown as typeof setTimeout,
          clearTimer: ((timer: { cleared: boolean }) => {
            timer.cleared = true;
          }) as unknown as typeof clearTimeout,
        });

        let messages = 0;
        for (const command of commands) {
          switch (command.kind) {
            case "message":
              messages += 1;
              await scheduler.runFromInboundEvent({
                automation,
                source: source(messages, now),
                now,
              });
              // Finish whatever started, so the lane is free for the next one.
              for (const run of store.listRunsForAutomation(AUTOMATION_ID, 1_000)) {
                if (run.status === "running") {
                  store.markRunTerminal({ runId: run.id, status: "completed", now });
                }
              }
              break;
            case "advance":
              now += command.ms;
              break;
            case "fireTimers":
              for (const timer of timers.splice(0)) {
                if (timer.cleared) continue;
                if (timer.dueAt <= now) timer.fire();
                else timers.push(timer);
              }
              break;
          }
        }
        // Writes before the stop are spaced by the flush window.
        for (const writes of markerWrites.values()) {
          for (let index = 1; index < writes.length; index += 1) {
            expect(writes[index]! - writes[index - 1]!).toBeGreaterThanOrEqual(SKIP_MARKER_FLUSH_MS);
          }
        }
        scheduler.stop();

        const runs = store.listRunsForAutomation(AUTOMATION_ID, 1_000);
        const admitted = runs.filter((run) => run.status !== "skipped").length;
        const markers = runs.filter((run) => run.skipReason === "rate_limited");
        const dropped = markers.reduce((sum, run) => sum + (run.coalescedCount ?? 0), 0);
        expect(dropped).toBe(messages - admitted);
        // One marker per wall-clock hour.
        // One marker per wall-clock hour, created in that hour.
        for (const [id, writes] of markerWrites) {
          const hour = Number(id.slice(id.lastIndexOf(":") + 1));
          expect(Math.floor(writes[0]! / HOUR_MS)).toBe(hour);
        }
        expect(markers).toHaveLength(markerWrites.size);
      } finally {
        db.close();
      }
    },
  ), { numRuns: 60 });
}, 30_000);
