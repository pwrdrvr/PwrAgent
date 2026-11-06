import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadHandoffProgress } from "@pwragent/shared";
import {
  reduceThreadHandoffTransfers,
  THREAD_HANDOFF_PHASE_ORDER,
  threadHandoffPercent,
  threadHandoffSecondsLeft,
  type ThreadHandoffTransferEvent,
  type ThreadHandoffTransfers,
} from "../thread-handoff-transfer";

const HANDOFF = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER = "1f0e0d0c-0b0a-4908-8706-050403020100";
const TOTAL = 1_000;

const started: ThreadHandoffTransferEvent = {
  type: "started",
  at: 0,
  handoffId: HANDOFF,
  sourceThreadId: "thread-1",
  threadKey: "codex:thread-1",
  title: "Release v0.17",
  targetLabel: "studio-mac / default",
  choice: { targetInstanceId: "pwr_studio", operation: "copy" },
};

// Main can deliver anything: late events from an earlier step, a byte count
// below one already shown, a report for another handoff or thread, and
// reports after the call settled. The generator covers all of them.
const progressArb: fc.Arbitrary<ThreadHandoffProgress> = fc.record({
  handoffId: fc.constantFrom(HANDOFF, HANDOFF, HANDOFF, OTHER),
  sourceThreadId: fc.constantFrom("thread-1", "thread-1", "thread-2"),
  phase: fc.constantFrom(...THREAD_HANDOFF_PHASE_ORDER),
  bytesCommitted: fc.option(fc.integer({ min: 0, max: TOTAL }), { nil: undefined }),
  bytesSent: fc.option(fc.integer({ min: 0, max: TOTAL }), { nil: undefined }),
  bytesTotal: fc.option(fc.constant(TOTAL), { nil: undefined }),
  resumedFromBytes: fc.option(fc.integer({ min: 0, max: TOTAL }), { nil: undefined }),
  link: fc.constantFrom("connected" as const, "waiting" as const),
  cancelable: fc.boolean(),
  transport: fc.constantFrom("resumable" as const, "single_shot" as const),
}).map((progress) => {
  const clean = { ...progress } as ThreadHandoffProgress;
  for (const key of Object.keys(clean) as (keyof ThreadHandoffProgress)[]) {
    if (clean[key] === undefined) delete clean[key];
  }
  return clean;
});

const eventArb: fc.Arbitrary<(at: number) => ThreadHandoffTransferEvent> = fc.oneof(
  { weight: 8, arbitrary: progressArb.map((progress) => (at: number) => ({ type: "progress" as const, at, progress })) },
  { weight: 1, arbitrary: fc.constant(() => ({ type: "cancel-requested" as const, handoffId: HANDOFF })) },
  { weight: 1, arbitrary: fc.constantFrom("dialog" as const, "toast" as const).map((view) => () => ({ type: "show" as const, handoffId: HANDOFF, view })) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      () => ({ type: "cancelled" as const, handoffId: HANDOFF }),
      () => ({ type: "failed" as const, handoffId: HANDOFF, error: "Receiver went away." }),
      () => ({
        type: "succeeded" as const,
        handoffId: HANDOFF,
        result: {
          handoffId: HANDOFF,
          sourceThreadId: "thread-1",
          instanceId: "pwr_studio",
          backend: "codex" as const,
          threadId: "thread-9",
          directoryPath: "/w",
          sourceArchived: false,
          warnings: [],
        },
      }),
    ),
  },
);

describe("thread handoff transfer", () => {
  it("only moves forward, whatever order main reports in", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        let state: ThreadHandoffTransfers = reduceThreadHandoffTransfers({}, started);
        let at = 0;
        for (const make of events) {
          at += 100;
          const before = state[HANDOFF]!;
          const event = make(at);
          state = reduceThreadHandoffTransfers(state, event);
          const after = state[HANDOFF]!;

          // The saved point never moves backwards, and neither does the step list.
          expect(after.bytesCommitted ?? 0).toBeGreaterThanOrEqual(before.bytesCommitted ?? 0);
          // The bar may give back bytes a dropped link lost, never saved ones.
          if (after.bytesSent !== undefined) {
            expect(after.bytesSent).toBeGreaterThanOrEqual(after.bytesCommitted ?? 0);
          }
          expect(THREAD_HANDOFF_PHASE_ORDER.indexOf(after.phase))
            .toBeGreaterThanOrEqual(THREAD_HANDOFF_PHASE_ORDER.indexOf(before.phase));
          // Once the receiver may be creating the thread, Cancel stays off.
          if (!before.cancelable) expect(after.cancelable).toBe(false);
          // A settled handoff keeps its outcome; only where it is drawn changes.
          if (before.status !== "running") {
            expect({ ...after, view: before.view }).toEqual(before);
          }
          // A cancel is asked only of a running handoff that can still be cancelled.
          if (after.cancelRequested && !before.cancelRequested) {
            expect(before.status).toBe("running");
            expect(before.cancelable).toBe(true);
          }
          if (after.status !== "running") expect(after.cancelRequested).toBe(false);
          // A pending Cancel is only ever shown while it can still take effect.
          if (after.cancelRequested) expect(after.cancelable).toBe(true);
          // A report for another handoff or thread changes nothing.
          if (
            event.type === "progress"
            && (event.progress.handoffId !== HANDOFF || event.progress.sourceThreadId !== "thread-1")
          ) {
            expect(after).toBe(before);
          }
          const percent = threadHandoffPercent(after);
          if (percent !== undefined) {
            expect(percent).toBeGreaterThanOrEqual(0);
            expect(percent).toBeLessThanOrEqual(100);
          }
          // Time left is never shown while the link is down.
          if (after.link === "waiting") expect(threadHandoffSecondsLeft(after, at)).toBeUndefined();
          expect(Object.keys(state)).toEqual([HANDOFF]);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("estimates time left only after two seconds of byte counts", () => {
    let state = reduceThreadHandoffTransfers({}, started);
    const send = (at: number, bytesCommitted: number) => {
      state = reduceThreadHandoffTransfers(state, {
        type: "progress",
        at,
        progress: {
          handoffId: HANDOFF,
          sourceThreadId: "thread-1",
          phase: "send",
          bytesCommitted,
          bytesTotal: TOTAL,
          link: "connected",
          cancelable: true,
          transport: "single_shot",
        },
      });
    };
    send(0, 0);
    send(1_000, 100);
    expect(threadHandoffSecondsLeft(state[HANDOFF]!, 1_000)).toBeUndefined();
    send(2_000, 200);
    // 100 bytes a second with 800 left.
    expect(threadHandoffSecondsLeft(state[HANDOFF]!, 2_000)).toBe(8);
  });

  it("draws acknowledged bytes ahead of the last saved point", () => {
    let state = reduceThreadHandoffTransfers({}, started);
    state = reduceThreadHandoffTransfers(state, {
      type: "progress",
      at: 100,
      progress: {
        handoffId: HANDOFF,
        sourceThreadId: "thread-1",
        phase: "send",
        bytesCommitted: 0,
        bytesSent: 600,
        bytesTotal: TOTAL,
        link: "connected",
        cancelable: true,
        transport: "resumable",
      },
    });
    expect(state[HANDOFF]!.bytesCommitted).toBe(0);
    expect(threadHandoffPercent(state[HANDOFF]!)).toBe(60);
  });
});
