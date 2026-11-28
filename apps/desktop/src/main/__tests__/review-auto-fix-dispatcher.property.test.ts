import fc from "fast-check";
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
          scopedForgeWake: fc.boolean(),
          outcome: fc.constantFrom("normal" as const, "settle" as const, "archive" as const, "error" as const),
          outcomeDelayTicks: fc.integer({ min: 0, max: 3 }),
        }),
        async (s, scenario) => {
          const runId = ++runCounter;
          const reviewId = `rev-${runId}`;
          const reviewTurnId = `review-turn-${runId}`;
          const review = {
            ...makeReview(reviewId, true),
            context: { workspacePath: "/repo", pullRequest: {
              provider: "github.com", org: "example", repo: "atlas", number: 2,
              url: "https://github.com/example/atlas/pull/2",
            } },
          };
          const unrelated = { ...makeReview("unrelated"), threadId: "other-thread" };
          const runs = new ReviewAutoFixRuns();
          let unrelatedLookups = 0;
          let unrelatedTerminalLookups = 0;

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
          const wakeStack = () => {
            if (scenario.scopedForgeWake) dispatcher.wakeForPullRequest("github.com/example/atlas#1");
            else dispatcher.wake();
          };

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
            getReview: (id) => {
              if (id === reviewId) return review;
              if (id !== unrelated.id) return undefined;
              unrelatedLookups++;
              return unrelated;
            },
            isThreadArchived: (thread) => thread.threadId === THREAD.threadId && archived,
            readStackHold: async (candidate) => candidate.id === unrelated.id
              ? "Other stack is held"
              : await s.schedule(Promise.resolve().then(() => stackHold), "readStackHold"),
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

          await dispatcher.dispatch(unrelated.id);

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
            // A terminal event must do no review reads on another thread.
            const before = unrelatedLookups;
            dispatcher.onTurnEnded(THREAD, new Set([reviewTurnId]));
            unrelatedTerminalLookups += unrelatedLookups - before;
            if (scenario.emitIdle && !scenario.idleBeforeCompleted) {
              dispatcher.wake(THREAD);
            }
          })();

          // 4. Optional concurrent disruptions.
          if (scenario.flakyHoldFlip) {
            s.scheduleFunction(async () => {
              stackHold = stackHold ? undefined : "Held by #1: restack";
              wakeStack();
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
            wakeStack();
          }
          await s.waitIdle();

          expect(unrelatedTerminalLookups).toBe(0);
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

  it("rechecks when Codex emits status=idle before turn/completed during an in-flight admission check", async () => {
    const review = makeReview("rev-idle-race", true);
    let activeTurn = true;
    let autoFixStarts = 0;
    let releaseIdleCheck!: () => void;
    let checkCalls = 0;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => false,
      readStackHold: async () => undefined,
      threadHasActiveTurn: () => activeTurn,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async ({ canAdmit }) => {
        checkCalls++;
        if (checkCalls === 1) return { status: "busy" };
        if (checkCalls === 2) {
          // Simulates the idle-triggered check seeing activeTurn=true before turn/completed lands.
          const wasActive = activeTurn;
          await new Promise<void>((resolve) => { releaseIdleCheck = resolve; });
          if (wasActive) return { status: "busy" };
        }
        if (!(await canAdmit())) return { status: "busy" };
        if (activeTurn) return { status: "busy" };
        autoFixStarts++;
        return { status: "started" };
      },
      recordRun: () => {},
    });

    // 1. exitedReviewMode lands while review turn is active -> held waiting for turn admission.
    await dispatcher.dispatch(review.id);
    expect(autoFixStarts).toBe(0);
    // 2. Codex emits thread/status/changed(idle) 1ms before turn/completed.
    const idleDispatch = dispatcher.dispatch(review.id);
    await Promise.resolve();
    await Promise.resolve();
    // 3. turn/completed arrives while the idle check is still in flight.
    activeTurn = false;
    dispatcher.onTurnEnded(THREAD, new Set(["review-turn"]));
    releaseIdleCheck();
    await idleDispatch;

    expect(autoFixStarts).toBe(1);
  });

  it("rechecks when turn/completed arrives while the initial stack-hold check is still in flight", async () => {
    const review = makeReview("rev-initial-race", true);
    let activeTurn = true;
    let autoFixStarts = 0;
    let releaseInitialOverlay!: () => void;
    let attempt = 0;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => false,
      readStackHold: async () => undefined,
      threadHasActiveTurn: () => activeTurn,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async ({ canAdmit }) => {
        attempt++;
        const wasActive = activeTurn;
        if (attempt === 1) {
          await new Promise<void>((resolve) => { releaseInitialOverlay = resolve; });
        }
        if (wasActive || !(await canAdmit()) || activeTurn) return { status: "busy" };
        autoFixStarts++;
        return { status: "started" };
      },
      recordRun: () => {},
    });

    const initial = dispatcher.dispatch(review.id);
    await Promise.resolve();
    await Promise.resolve();
    activeTurn = false;
    dispatcher.onTurnEnded(THREAD, new Set(["review-turn"]));
    releaseInitialOverlay();
    await initial;

    expect(autoFixStarts).toBe(1);
  });

  it("resumes a lock-held review when the thread unlocks", async () => {
    const review = makeReview("rev-lock", true);
    let locked = true;
    let autoFixStarts = 0;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => false,
      readStackHold: async () => undefined,
      threadHasActiveTurn: () => false,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async ({ canAdmit }) => {
        if (locked || !(await canAdmit())) return { status: "busy" };
        autoFixStarts++;
        return { status: "started" };
      },
      recordRun: () => {},
    });

    await dispatcher.dispatch(review.id);
    expect(autoFixStarts).toBe(0);
    locked = false;
    dispatcher.wake(THREAD);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(autoFixStarts).toBe(1);
  });

  it("reports the stack hold on the queued run, then the current turn once admission resumes", async () => {
    // Counterexample: an idle thread held by a lower stack layer showed
    // "sends when the current turn ends" because the run carried no hold.
    const review = makeReview("rev-stack-hold", true);
    const runs = new ReviewAutoFixRuns();
    let stackHold: string | undefined = "Held by #12: CI running";
    let activeTurn = false;
    let clock = 1;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => false,
      readStackHold: async () => stackHold,
      threadHasActiveTurn: () => activeTurn,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async ({ canAdmit }) => {
        if (activeTurn || !(await canAdmit())) return { status: "busy" };
        runs.record(THREAD, review.id, { kind: "queue", status: "started", at: clock });
        return { status: "started" };
      },
      recordRun: (thread, id, event) => runs.record(thread, id, event),
      now: () => clock,
    });

    await dispatcher.dispatch(review.id);
    expect(runs.of(THREAD)[review.id]).toEqual({ phase: "queued", at: 1, hold: "Held by #12: CI running" });

    // The lower layer's reason changes; the run says so and keeps its time.
    clock = 2;
    stackHold = "Held by #12: needs restack";
    await dispatcher.dispatch(review.id);
    expect(runs.of(THREAD)[review.id]).toEqual({ phase: "queued", at: 1, hold: "Held by #12: needs restack" });

    // The stack clears while a turn runs: the run waits on that turn alone.
    clock = 3;
    stackHold = undefined;
    activeTurn = true;
    await dispatcher.dispatch(review.id);
    expect(runs.of(THREAD)[review.id]).toEqual({ phase: "queued", at: 1 });

    clock = 4;
    activeTurn = false;
    await dispatcher.dispatch(review.id);
    expect(runs.of(THREAD)[review.id]).toEqual({ phase: "running", at: 4 });
  });

  it("reports a stack hold that closes again at admission", async () => {
    // Counterexample: the gate cleared, then closed before admission; the
    // busy result left an idle thread saying it waits on the current turn.
    const review = makeReview("rev-admission-hold", true);
    const runs = new ReviewAutoFixRuns();
    let stackHold: string | undefined;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => false,
      readStackHold: async () => stackHold,
      threadHasActiveTurn: () => false,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async ({ canAdmit }) => {
        stackHold = "Held by #12: CI running";
        return (await canAdmit()) ? { status: "started" } : { status: "busy" };
      },
      recordRun: (thread, id, event) => runs.record(thread, id, event),
      now: () => 1,
    });

    await dispatcher.dispatch(review.id);
    expect(runs.of(THREAD)[review.id]).toEqual({ phase: "queued", at: 1, hold: "Held by #12: CI running" });
  });

  it("does not announce a cleared gate that admission closes again", async () => {
    // Counterexample from the scaling probe: the first check saw the stack
    // clear and admission saw it held, so every wake announced two changes.
    // Viewers must hear only real changes, however many wakes arrive.
    const review = makeReview("rev-flapping-gate", true);
    let changes = 0;
    const runs = new ReviewAutoFixRuns(() => { changes++; });
    let read = 0;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => false,
      readStackHold: async () => (read++ % 2 === 0 ? undefined : "Held by #12: CI running"),
      threadHasActiveTurn: () => false,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async ({ canAdmit }) => ((await canAdmit()) ? { status: "started" } : { status: "busy" }),
      recordRun: (thread, id, event) => runs.record(thread, id, event),
      now: () => 1,
    });

    await dispatcher.dispatch(review.id);
    const afterFirst = changes;
    for (let wake = 0; wake < 8; wake++) await dispatcher.dispatch(review.id);
    expect(changes).toBe(afterFirst);
    expect(runs.of(THREAD)[review.id]).toEqual({ phase: "queued", at: 1, hold: "Held by #12: CI running" });
  });

  it("cancels queued run state when a thread is archived while Auto-fix is held", async () => {
    const review = makeReview("rev-archive-held", true);
    const runs = new ReviewAutoFixRuns();
    let archived = false;
    let autoFixStarts = 0;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => archived,
      readStackHold: async () => "Held by #1: CI running",
      threadHasActiveTurn: () => false,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async () => {
        autoFixStarts++;
        return { status: "started" };
      },
      recordRun: (thread, id, event) => runs.record(thread, id, event),
      now: () => 1,
    });

    await dispatcher.dispatch(review.id);
    expect(runs.of(THREAD)[review.id]).toEqual({ phase: "queued", at: 1, hold: "Held by #1: CI running" });

    archived = true;
    dispatcher.onThreadArchived(THREAD);
    expect(runs.of(THREAD)[review.id]).toBeUndefined();
    expect(autoFixStarts).toBe(0);
  });

  it("cancels and does not re-hold an Auto-fix when thread/archived races with in-flight submitTurnIfIdle", async () => {
    const review = makeReview("rev-archive-inflight", true);
    const runs = new ReviewAutoFixRuns();
    let archived = false;
    let releaseSubmit!: () => void;
    let submitCalls = 0;

    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => archived,
      readStackHold: async () => undefined,
      threadHasActiveTurn: () => false,
      submitTurn: async () => ({ status: "started" }),
      submitTurnIfIdle: async () => {
        submitCalls++;
        if (submitCalls === 1) {
          await new Promise<void>((resolve) => { releaseSubmit = resolve; });
        }
        return archived ? { status: "busy" } : { status: "started" };
      },
      recordRun: (thread, id, event) => runs.record(thread, id, event),
      now: () => 1,
    });

    const inFlight = dispatcher.dispatch(review.id);
    await Promise.resolve();
    await Promise.resolve();

    archived = true;
    dispatcher.onThreadArchived(THREAD);
    releaseSubmit();
    await inFlight;

    expect(runs.of(THREAD)[review.id]).toBeUndefined();

    // Must not have been re-added to heldReviews after submitTurnIfIdle returned busy.
    archived = false;
    dispatcher.wake(THREAD);
    await Promise.resolve();
    await Promise.resolve();
    expect(submitCalls).toBe(1);
    expect(runs.of(THREAD)[review.id]).toBeUndefined();
  });

  it("releases a handoff on disposal while a stack check is in flight", async () => {
    const review = makeReview("rev-dispose");
    let finishCheck!: (hold: string | undefined) => void;
    const check = new Promise<string | undefined>((resolve) => { finishCheck = resolve; });
    let releases = 0;
    let admissionAttempts = 0;
    const dispatcher = new ReviewAutoFixDispatcher({
      getReview: () => review,
      isThreadArchived: () => false,
      readStackHold: () => check,
      suspendDispatch: () => () => { releases++; },
      submitTurn: async () => {},
      submitTurnIfIdle: async () => {
        admissionAttempts++;
        return { status: "started" };
      },
      recordRun: () => {},
    });
    dispatcher.onReviewLanded(review.id, THREAD, "review-turn");
    dispatcher.dispose();
    finishCheck(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    dispatcher.wake();
    expect({ releases, admissionAttempts }).toEqual({ releases: 1, admissionAttempts: 0 });
  });
});
