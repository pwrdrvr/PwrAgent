import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { transitionQueueNotice, type QueueNoticeEvent, type QueueNoticeState, type QueueNoticeOutcome } from "../queue-notice-lifecycle";

describe("queue notice lifecycle", () => {
  it("binds once on owner start and retires once after notice readiness in every delivery order", () => {
    const outcome = fc.record({ status: fc.constantFrom("started" as const, "cancelled" as const, "failed" as const), turnId: fc.option(fc.uuid(), { nil: undefined }) });
    fc.assert(fc.property(fc.array(outcome, { minLength: 1, maxLength: 12 }), fc.nat(12), fc.nat(12),
      (outcomes, acceptedAt, readyAfter) => {
        const events: QueueNoticeEvent<string>[] = outcomes.map((value) => ({ type: "ownerOutcome", outcome: value }));
        const acceptance = acceptedAt % (events.length + 1);
        events.splice(acceptance, 0, { type: "accepted", entry: "input" });
        events.splice(acceptance + 1 + readyAfter % (events.length - acceptance), 0, { type: "noticeReady" });
        // Re-deliver every event. The model is just three facts and the first
        // owner outcome; it does not duplicate the implementation's phases.
        let accepted = false;
        let ready = false;
        let firstOutcome: QueueNoticeOutcome | undefined;
        let retired = false;
        let started = false;
        let state: QueueNoticeState<string> | undefined;
        for (const event of events.flatMap((value) => [value, value])) {
          if (event.type === "accepted") accepted = true;
          if (event.type === "noticeReady") ready = true;
          if (event.type === "ownerOutcome") firstOutcome ??= event.outcome;
          const shouldRetire = accepted && ready && Boolean(firstOutcome) && !retired;
          const shouldStart = accepted && firstOutcome?.status === "started" && Boolean(firstOutcome.turnId) && !started;
          const transition = transitionQueueNotice(state, event);
          state = transition.state;
          expect(Boolean(transition.retire)).toBe(shouldRetire);
          expect(Boolean(transition.started)).toBe(shouldStart);
          if (transition.started) {
            expect(transition.started).toEqual({ entry: "input", turnId: firstOutcome?.turnId });
            started = true;
          }
          if (transition.retire) {
            expect(transition.retire).toEqual({ entry: "input", outcome: firstOutcome });
            retired = true;
          }
        }
        expect(retired).toBe(true);
        expect(state?.phase).toBe("settled");
      }), { numRuns: 500 });
  });
});
