import fc from "fast-check";
fc.configureGlobal({numRuns:Number(process.env.AUDIT_CASES),seed:45894590});
import { describe, expect, it } from "vitest";
import type { ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import {
  ReviewAutoFixDispatcher,
  ReviewAutoFixRuns,
} from "../thread-reviews/review-auto-fix";

const THREAD = { backend: "codex" as const, threadId: "review-owner" };

function makeReview(id: string, open = true): ThreadReview {
  return {
    id,
    backend: THREAD.backend,
    threadId: THREAD.threadId,
    origin: "automatic",
    sourceKey: `source:${id}`,
    title: "Code review",
    summary: "One finding.",
    status: open ? "open" : "handled",
    items: [{
      id: `item:${id}`,
      title: "Fix race",
      body: "Do not drop wakeups.",
      priority: 2,
      status: open ? "open" : "addressed",
      createdAt: 1,
      updatedAt: 1,
    }],
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * Model: once a review lands with open findings on an unarchived thread and
 * every blocker (active review turn, stack hold, thread lock, blocking turns)
 * settles, Auto-fix starts exactly once, never while a stack hold is active,
 * and ahead of queued user messages when unheld at the review boundary.
 * Dispatch suspensions always return to zero.
 */
describe("review auto-fix dispatcher", () => {
  it("never strands Auto-fix, leaks suspensions, or violates stack holds across async interleavings", async () => {
    let runCounter = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.record({
          initialStackHold: fc.boolean(),
          idleBeforeCompleted: fc.boolean(),
          emitIdle: fc.boolean(),
          queuedUserMessages: fc.integer({ min: 0, max: 2 }),
          lockDuringReview: fc.boolean(),
          otherTurnAfterReview: fc.constantFrom("none" as const, "completed" as const, "failed" as const, "cancelled" as const),
          flakyHoldFlip: fc.boolean(),
          outcome: fc.constantFrom("normal" as const, "settle" as const, "archive" as const, "error" as const),
          outcomeDelayTicks: fc.integer({ min: 0, max: 3 }),
        }),
        async (s, scenario) => {
          const runId = ++runCounter;
          const reviewId = `rev-${runId}`;
          const reviewTurnId = `review-turn-${runId}`;
          const review = makeReview(reviewId, true);
          const runs = new ReviewAutoFixRuns();

          let activeTurnId: string | undefined = reviewTurnId;
          let stackHold: string | undefined = scenario.initialStackHold ? "Held by #1: CI running" : undefined;
          let locked = scenario.lockDuringReview;
          let archived = false;
          let dispatchSuspensions = 0;
          const queuedUser = Array.from({ length: scenario.queuedUserMessages }, (_, i) => `user-${i}`);
          const startedOrder: Array<{ kind: "auto-fix" | "user"; stackHeld: boolean }> = [];
          let autoFixCount = 0;
          let sendFailed = false;

          let dispatcher!: ReviewAutoFixDispatcher;

          const drainQueuedUser = () => {
            if (archived || dispatchSuspensions > 0 || locked || activeTurnId !== undefined || queuedUser.length === 0) return;
            const msg = queuedUser.shift()!;
            const userTurnId = `user-turn-${msg}`;
            activeTurnId = userTurnId;
            startedOrder.push({ kind: "user", stackHeld: stackHold !== undefined });
            s.scheduleFunction(async () => {
              activeTurnId = undefined;
              drainQueuedUser();
              dispatcher.onTurnEnded(THREAD, new Set([userTurnId]));
            })();
          };

          dispatcher = new ReviewAutoFixDispatcher({
            getReview: (id) => (id === reviewId ? review : undefined),
            isThreadArchived: () => archived,
            readStackHold: async () => await s.schedule(Promise.resolve().then(() => stackHold), "readStackHold"),
            threadHasActiveTurn: () => activeTurnId !== undefined,
            suspendDispatch: () => {
              dispatchSuspensions++;
              let released = false;
              return () => {
                if (released) return;
                released = true;
                dispatchSuspensions--;
                if (dispatchSuspensions === 0) drainQueuedUser();
              };
            },
            submitTurn: async () => {
              throw new Error("submitTurn should not run when readStackHold is wired");
            },
            submitTurnIfIdle: async (req) => {
              const busyBefore = await s.schedule(
                Promise.resolve().then(() => archived || locked || activeTurnId !== undefined),
                "submitTurnIfIdle:overlay",
              );
              if (busyBefore) return { status: "busy" };
              if (scenario.outcome === "error") {
                sendFailed = true;
                throw new Error("Inference unavailable");
              }
              if ((await req.canAdmit()) === false) return { status: "busy" };
              const handoff = Boolean(req.reviewAutoFixHandoff && req.messageOrigin.reviewAutoFix);
              if (
                archived
                || locked
                || activeTurnId !== undefined
                || dispatchSuspensions > (handoff ? 1 : 0)
                || (!handoff && queuedUser.length > 0)
              ) {
                return { status: "busy" };
              }
              const fixTurnId = `fix-turn-${runId}`;
              activeTurnId = fixTurnId;
              autoFixCount++;
              startedOrder.push({ kind: "auto-fix", stackHeld: stackHold !== undefined });
              runs.record(THREAD, reviewId, { kind: "queue", status: "started", at: 2 });
              s.scheduleFunction(async () => {
                activeTurnId = undefined;
                drainQueuedUser();
                dispatcher.onTurnEnded(THREAD, new Set([fixTurnId]));
              })();
              return { status: "started" };
            },
            recordRun: (thread, id, event) => runs.record(thread, id, event),
            now: () => 1,
          });

          // 1. Review artifact lands while review turn is still active.
          s.scheduleFunction(async () => {
            dispatcher.onReviewLanded(reviewId, THREAD, reviewTurnId);
          })();

          // 2. Codex thread/status/changed(idle) may arrive before turn/completed.
          if (scenario.emitIdle && scenario.idleBeforeCompleted) {
            s.scheduleFunction(async () => {
              dispatcher.wake(THREAD);
            })();
          }

          // 3. Review turn completes: queue release runs before listeners, as in DesktopBackendRegistry.
          s.scheduleFunction(async () => {
            activeTurnId = undefined;
            drainQueuedUser();
            dispatcher.onTurnEnded(THREAD, new Set([reviewTurnId]));
            if (scenario.emitIdle && !scenario.idleBeforeCompleted) {
              dispatcher.wake(THREAD);
            }
          })();

          // 4. Optional concurrent disruptions.
          if (scenario.flakyHoldFlip) {
            s.scheduleFunction(async () => {
              stackHold = stackHold ? undefined : "Held by #1: restack";
              dispatcher.wake();
            })();
          }
          if (scenario.otherTurnAfterReview !== "none") {
            s.scheduleFunction(async () => {
              if (activeTurnId === undefined && !archived) {
                const otherTurn = `other-${runId}`;
                activeTurnId = otherTurn;
                s.scheduleFunction(async () => {
                  activeTurnId = undefined;
                  drainQueuedUser();
                  dispatcher.onTurnEnded(THREAD, new Set([otherTurn]));
                })();
              }
            })();
          }
          const scheduleAfter = (ticks: number, action: () => void): void => {
            s.scheduleFunction(async () => {
              if (ticks > 0) {
                scheduleAfter(ticks - 1, action);
                return;
              }
              action();
            })();
          };
          if (scenario.outcome === "settle") {
            scheduleAfter(scenario.outcomeDelayTicks, () => {
              review.status = "handled";
              review.items[0]!.status = "addressed";
              dispatcher.wake(THREAD);
            });
          } else if (scenario.outcome === "archive") {
            scheduleAfter(scenario.outcomeDelayTicks, () => {
              archived = true;
              dispatcher.onThreadArchived(THREAD);
            });
          }

          await s.waitIdle();

          // Settle all remaining blockers.
          if (locked) {
            locked = false;
            dispatcher.wake(THREAD);
            drainQueuedUser();
          }
          if (stackHold) {
            stackHold = undefined;
            dispatcher.wake();
          }
          await s.waitIdle();

          // No dispatch suspension ever leaks.
          expect(dispatchSuspensions).toBe(0);
          // Auto-fix never runs while a stack hold is active.
          for (const entry of startedOrder) {
            if (entry.kind === "auto-fix") expect(entry.stackHeld).toBe(false);
          }
          // At most one Auto-fix start per review.
          expect(autoFixCount).toBeLessThanOrEqual(1);

          if (scenario.outcome === "normal") {
            expect(autoFixCount).toBe(1);
            if (!scenario.initialStackHold && !scenario.flakyHoldFlip && !scenario.lockDuringReview && scenario.queuedUserMessages > 0) {
              expect(startedOrder[0]?.kind).toBe("auto-fix");
            }
            expect(queuedUser).toHaveLength(0);
          } else if (scenario.outcome === "error") {
            expect(autoFixCount).toBe(0);
            expect(sendFailed).toBe(true);
            expect(runs.of(THREAD)[reviewId]).toMatchObject({ phase: "failed", reason: "Inference unavailable" });
            expect(queuedUser).toHaveLength(0);
          } else if (scenario.outcome === "archive") {
            expect(runs.of(THREAD)[reviewId]?.phase).not.toBe("queued");
            if (autoFixCount === 0) {
              expect(runs.of(THREAD)[reviewId]).toBeUndefined();
            }
            // Archiving must not leave the review stranded in heldReviews.
            archived = false;
            dispatcher.wake(THREAD);
            await s.waitIdle();
            expect(runs.of(THREAD)[reviewId]?.phase).not.toBe("queued");
          } else if (scenario.outcome === "settle") {
            expect(runs.of(THREAD)[reviewId]?.phase).not.toBe("queued");
            if (autoFixCount === 0) {
              expect(runs.of(THREAD)[reviewId]).toBeUndefined();
            }
          }
        },
      ),
    );
  });

});
