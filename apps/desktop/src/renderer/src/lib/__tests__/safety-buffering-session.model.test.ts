import fc from "fast-check";
import { expect, it } from "vitest";
import {
  SAFETY_REVIEW_STATUS_TEXT,
  safetyReviewStatusText,
  transitionSafetyBuffering,
  type SafetyBufferingState,
} from "../safety-buffering-session";

type Event =
  | { method: "turn/safetyBuffering/updated"; params: { turnId: string; model: string; buffering: boolean; fasterModel?: string } }
  | { method: "item/agentMessage/delta"; params: { turnId?: string; delta: string } }
  | { method: "turn/completed" | "turn/failed" | "turn/cancelled"; params: { turnId?: string } }
  | { method: "turn/started"; params: { turnId: string } }
  | { method: "item/started" | "turn/modelRerouted" | "turn/verificationRequested"; params: { turnId: string } };

const turnId = fc.constantFrom("turn-a", "turn-b");
const eventArb: fc.Arbitrary<Event> = fc.oneof(
  fc.record({
    method: fc.constant("turn/safetyBuffering/updated" as const),
    params: fc.record({
      turnId,
      model: fc.constantFrom("gpt-6.2-sol", "gpt-6-luna"),
      buffering: fc.boolean(),
      fasterModel: fc.constantFrom("gpt-6-luna", "gpt-6-mini"),
    }),
  }),
  fc.record({
    method: fc.constant("item/agentMessage/delta" as const),
    params: fc.record({ turnId: fc.option(turnId, { nil: undefined }), delta: fc.constantFrom("", "Hi") }),
  }),
  fc.record({
    method: fc.constantFrom("turn/completed" as const, "turn/failed" as const, "turn/cancelled" as const),
    params: fc.record({ turnId: fc.option(turnId, { nil: undefined }) }),
  }),
  fc.record({ method: fc.constant("turn/started" as const), params: fc.record({ turnId }) }),
  fc.record({
    method: fc.constantFrom(
      "item/started" as const,
      "turn/modelRerouted" as const,
      "turn/verificationRequested" as const,
    ),
    params: fc.record({ turnId }),
  }),
);

/**
 * Oracle, read backwards from the end: the last hold that started is still in
 * effect unless a later event for its turn ended it — the provider releasing
 * it, model text streaming, the turn ending, or another turn starting.
 */
function heldAfter(events: readonly Event[]): SafetyBufferingState | undefined {
  const start = events.findLastIndex((event) =>
    event.method === "turn/safetyBuffering/updated" && event.params.buffering);
  if (start < 0) return undefined;
  const hold = events[start] as Extract<Event, { method: "turn/safetyBuffering/updated" }>;
  const held = hold.params.turnId;
  const ended = events.slice(start + 1).some((event) => {
    const forHeldTurn = event.params.turnId === undefined || event.params.turnId === held;
    switch (event.method) {
      case "turn/safetyBuffering/updated":
        return event.params.turnId === held && !event.params.buffering;
      case "item/agentMessage/delta":
        return forHeldTurn && event.params.delta !== "";
      case "turn/completed":
      case "turn/failed":
      case "turn/cancelled":
        return forHeldTurn;
      case "turn/started":
        return event.params.turnId !== held;
      default:
        return false;
    }
  });
  return ended ? undefined : { turnId: held, model: hold.params.model };
}

it("holds the status exactly while the provider's safety review is in effect", () => {
  fc.assert(fc.property(fc.array(eventArb, { maxLength: 14 }), (events) => {
    let session: { activeTurnId?: string; safetyBuffering?: SafetyBufferingState } = {
      activeTurnId: "turn-a",
    };
    events.forEach((event, index) => {
      session = transitionSafetyBuffering(session, event);
      expect(session.safetyBuffering).toEqual(heldAfter(events.slice(0, index + 1)));
    });
  }), { numRuns: 1_000 });
});

it("never names the faster model or offers a switch in the status", () => {
  const session = transitionSafetyBuffering({ activeTurnId: "turn-a" }, {
    method: "turn/safetyBuffering/updated",
    params: { turnId: "turn-a", model: "gpt-6.2-sol", buffering: true, fasterModel: "gpt-6-luna" },
  });
  expect(safetyReviewStatusText(session)).toBe(SAFETY_REVIEW_STATUS_TEXT);
  expect(SAFETY_REVIEW_STATUS_TEXT).not.toMatch(/luna|faster|switch|retry/i);
});

it("shows the status only while the held turn runs", () => {
  const held = { safetyBuffering: { turnId: "turn-a", model: "gpt-6.2-sol" } };
  expect(safetyReviewStatusText(held)).toBeUndefined();
  expect(safetyReviewStatusText({ ...held, backendReportedActive: true })).toBe(SAFETY_REVIEW_STATUS_TEXT);
  expect(safetyReviewStatusText({ ...held, activeTurnId: "turn-a" })).toBe(SAFETY_REVIEW_STATUS_TEXT);
  expect(safetyReviewStatusText({ activeTurnId: "turn-a" })).toBeUndefined();
  // A hold whose turn end this window missed does not label the next turn.
  expect(safetyReviewStatusText({ ...held, activeTurnId: "pending:send-2" })).toBeUndefined();
  expect(safetyReviewStatusText({ ...held, activeTurnId: "turn-b", backendReportedActive: true }))
    .toBeUndefined();
});

it("ends a hold when another turn starts that names itself only in turn.id", () => {
  const held = { safetyBuffering: { turnId: "turn-a", model: "gpt-6.2-sol" } };
  const next = transitionSafetyBuffering(held, {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-b" } },
  });
  expect(next.safetyBuffering).toBeUndefined();
  expect(transitionSafetyBuffering(held, {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-a" } },
  })).toBe(held);
});
