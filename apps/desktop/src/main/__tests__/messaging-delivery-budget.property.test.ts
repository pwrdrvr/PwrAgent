import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingDeliveryScope } from "@pwragent/messaging-interface";
import {
  MessagingDeliveryBudget,
  type MessagingDeliveryAdmission,
  type MessagingDeliveryPriority,
} from "../messaging/core/messaging-delivery-budget";

// Rules, from the budget's own comments and the controller that uses it:
// - The limit holds: in any `intervalMs` window, consumed admissions never
//   exceed `limit`, and low-priority traffic never takes the `reserved` slots.
// - A provider Retry-After is honored: nothing at all is admitted until the
//   cool-off (Retry-After plus the 2 s safety buffer) has passed, whatever
//   reads, denials or later shorter 429s run in between.
// - Denials consume nothing: a deferrable request with no cool-off is admitted
//   exactly when the admitted history leaves room, however many denials came
//   before it.
// - Reads are pure: `isScopeInSlowMode` (the status read) never changes what a
//   later `admit` answers.

const INTERVAL_MS = 10_000;
const LIMIT = 4;
const RESERVED = 1;
const SAFETY_BUFFER_MS = 2_000;

const scope: MessagingDeliveryScope = {
  platform: "telegram",
  id: "telegram:supergroup:-1001",
  kind: "group",
  budget: { limit: LIMIT, intervalMs: INTERVAL_MS, reserved: RESERVED },
};

const PRIORITIES: MessagingDeliveryPriority[] = [
  "critical_interactive",
  "final_turn",
  "user_command",
  "routine_status",
  "tool_progress",
  "stream_partial",
];
const DEFERRABLE = new Set<MessagingDeliveryPriority>([
  "critical_interactive",
  "final_turn",
  "user_command",
]);

type Op =
  | { kind: "advance"; ms: number }
  | { kind: "admit"; priority: MessagingDeliveryPriority; consumeCapacity: boolean }
  | { kind: "rate-limit"; retryAfterMs: number }
  | { kind: "read" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 4_000 }).map((ms) => ({ kind: "advance" as const, ms })) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 500 }).map((ms) => ({ kind: "advance" as const, ms })) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("admit" as const),
      priority: fc.constantFrom(...PRIORITIES),
      consumeCapacity: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 8_000 }).map((retryAfterMs) => ({ kind: "rate-limit" as const, retryAfterMs })) },
  { weight: 2, arbitrary: fc.constant({ kind: "read" as const }) },
);

function admitInput(op: Extract<Op, { kind: "admit" }>) {
  return {
    scope,
    priority: op.priority,
    ...(op.consumeCapacity ? {} : { consumeCapacity: false }),
  };
}

describe("MessagingDeliveryBudget model", () => {
  it("holds the limit, honors Retry-After, and never lets a denial consume capacity", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 120 }), (ops) => {
        let now = 1_000_000;
        const budget = new MessagingDeliveryBudget({ now: () => now });
        const consumed: number[] = [];
        let coolOffUntil = 0;
        for (const op of ops) {
          if (op.kind === "advance") {
            now += op.ms;
            continue;
          }
          if (op.kind === "read") {
            budget.isScopeInSlowMode(scope);
            continue;
          }
          if (op.kind === "rate-limit") {
            coolOffUntil = Math.max(
              coolOffUntil,
              now + op.retryAfterMs + SAFETY_BUFFER_MS,
            );
            budget.recordRateLimit({ scope, retryAfterMs: op.retryAfterMs, observedAt: now });
            continue;
          }
          const inWindow = consumed.filter((at) => at > now - INTERVAL_MS).length;
          const admission = budget.admit(admitInput(op));
          if (admission.outcome === "admitted") {
            expect(now).toBeGreaterThanOrEqual(coolOffUntil);
            if (op.consumeCapacity) {
              const ceiling = DEFERRABLE.has(op.priority) ? LIMIT : LIMIT - RESERVED;
              expect(inWindow).toBeLessThan(ceiling);
              consumed.push(now);
            }
          }
          if (DEFERRABLE.has(op.priority)) {
            // Slow mode never holds back deferrable priorities, so the
            // admitted history and the cool-off fully decide the answer.
            const free = now >= coolOffUntil
              && (!op.consumeCapacity || inWindow < LIMIT);
            expect(admission.outcome).toBe(free ? "admitted" : "deferred");
          }
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it("answers every admit the same whether or not status reads run in between", () => {
    fc.assert(
      fc.property(
        fc.array(opArb.filter((op) => op.kind !== "read"), { maxLength: 120 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 120 }),
        (ops, readsBefore) => {
          let now = 1_000_000;
          const plain = new MessagingDeliveryBudget({ now: () => now });
          const probed = new MessagingDeliveryBudget({ now: () => now });
          ops.forEach((op, index) => {
            for (let read = 0; read < (readsBefore[index] ?? 0); read += 1) {
              probed.isScopeInSlowMode(scope);
            }
            if (op.kind === "advance") {
              now += op.ms;
            } else if (op.kind === "rate-limit") {
              const info = { scope, retryAfterMs: op.retryAfterMs, observedAt: now };
              plain.recordRateLimit(info);
              probed.recordRateLimit(info);
            } else if (op.kind === "admit") {
              const expected: MessagingDeliveryAdmission = plain.admit(admitInput(op));
              expect(probed.admit(admitInput(op))).toEqual(expected);
            }
          });
        },
      ),
    );
  });

  it("frees capacity when the oldest admission leaves the window, however many denials came first", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gapMs: fc.integer({ min: 0, max: 2_000 }),
            priority: fc.constantFrom(...PRIORITIES),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (denials) => {
          let now = 1_000_000;
          const budget = new MessagingDeliveryBudget({ now: () => now });
          const oldest = now;
          for (let index = 0; index < LIMIT; index += 1) {
            expect(budget.admit({ scope, priority: "final_turn" }).outcome).toBe("admitted");
          }
          for (const denial of denials) {
            now = Math.min(now + denial.gapMs, oldest + INTERVAL_MS - 1);
            expect(budget.admit({ scope, priority: denial.priority }).outcome).not.toBe("admitted");
          }
          now = oldest + INTERVAL_MS;
          expect(budget.admit({ scope, priority: "final_turn" }).outcome).toBe("admitted");
        },
      ),
    );
  });

  it("keeps the longest Retry-After when a shorter one arrives later", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60_000 }),
        fc.array(
          fc.record({
            gapMs: fc.integer({ min: 0, max: 5_000 }),
            retryAfterMs: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: undefined }),
          }),
          { maxLength: 20 },
        ),
        (retryAfterMs, later) => {
          let now = 1_000_000;
          const budget = new MessagingDeliveryBudget({ now: () => now });
          let coolOffUntil = now + retryAfterMs + SAFETY_BUFFER_MS;
          budget.recordRateLimit({ scope, retryAfterMs, observedAt: now });
          for (const step of later) {
            now += step.gapMs;
            if (step.retryAfterMs !== undefined) {
              coolOffUntil = Math.max(coolOffUntil, now + step.retryAfterMs + SAFETY_BUFFER_MS);
              budget.recordRateLimit({ scope, retryAfterMs: step.retryAfterMs, observedAt: now });
            }
            budget.isScopeInSlowMode(scope);
            const admission = budget.admit({ scope, priority: "critical_interactive" });
            expect(admission.outcome).toBe(now < coolOffUntil ? "deferred" : "admitted");
          }
        },
      ),
    );
  });
});
