import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import {
  AGENT_FOLLOW_UP_FIRED_WINDOW_MS,
  AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD,
  AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW,
  AGENT_FOLLOW_UP_MIN_DELAY_MS,
  type ScheduleFollowUpToolResult,
} from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { buildThreadPendingWakes, type ThreadPendingWakeReaders } from "../app-server/thread-pending-wakes";
import { AgentFollowUpWorld, FOLLOW_UP_THREAD, type CrashPoint } from "./helpers/agent-follow-up-world";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

const MINUTE = 60_000;

function assertFollowUpProperty<T>(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  property: fc.IAsyncProperty<T>,
  numRuns: number,
): Promise<void> {
  const run = fc.assert(property, {
    numRuns,
    // The world uses promise-based fakes. Give Vitest's deadline a turn
    // between cases, then stop before opening another database, even during shrinking.
    plugins: [fc.beforeEach(async () => {
      context.signal.throwIfAborted();
      await yieldToEventLoop();
      context.signal.throwIfAborted();
    })],
  });
  // Vitest can time out the callback before its promise settles. Keep the
  // current case and its database teardown out of the next test's write budget.
  context.onTestFinished(async () => { await Promise.allSettled([run]); });
  return run;
}

async function withWorld<T>(
  run: (world: AgentFollowUpWorld) => Promise<T>,
  options: { reuseProcessId?: boolean } = {},
): Promise<T> {
  const db = openInMemoryStateDb();
  const world = new AgentFollowUpWorld(db);
  try {
    world.reuseProcessId = options.reuseProcessId ?? false;
    await world.start();
    return await run(world);
  } finally {
    world.dispose();
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Model: create, fire, cancel, crash, restart and lock.
//
// Oracle: the provider's own record of accepted turns (`world.admissions`),
// which no crash erases. Admitted turns never exceed follow-ups, no follow-up
// is admitted twice, a cancelled follow-up never ran, and a held follow-up
// starts exactly once after unlock, including across a restart.
// ---------------------------------------------------------------------------

type Model = {
  /** Every follow-up a create returned, in order. */
  created: string[];
  /** Follow-ups a cancel reported cancelled, with the turns admitted by then. */
  cancelled: Map<string, number>;
  /** Follow-ups in flight when a process died, for the visible-failure rule. */
  inFlightAtCrash: Set<string>;
};

function checkOracle(model: Model, world: AgentFollowUpWorld): void {
  const created = new Set(model.created);
  expect(world.admissions.length).toBeLessThanOrEqual(model.created.length);
  for (const { actionId } of world.admissions) {
    expect(created.has(actionId), `an unknown follow-up ${actionId} was admitted`).toBe(true);
    expect(world.admittedCount(actionId), `follow-up ${actionId} was admitted more than once`).toBe(1);
  }
  for (const [actionId, admittedAtCancel] of model.cancelled) {
    expect(world.admittedCount(actionId), `follow-up ${actionId} was admitted after its cancel`).toBe(admittedAtCancel);
  }
}

/** A tripped loop guard keeps the thread's follow-ups waiting until a rearm. */
function followUpsSuspended(world: AgentFollowUpWorld): boolean {
  return world.service.agentFollowUpProtection(FOLLOW_UP_THREAD).suspendedAt !== undefined;
}

type Command = fc.AsyncCommand<Model, AgentFollowUpWorld>;
const command = (
  name: string,
  run: (model: Model, world: AgentFollowUpWorld) => Promise<void>,
  check: (model: Readonly<Model>) => boolean = () => true,
): Command => ({
  check,
  toString: () => name,
  run: async (model, world) => {
    await run(model, world);
    checkOracle(model, world);
  },
});

const commands = [
  fc.integer({ min: 1, max: 2 }).map((minutes) => command(`create(${minutes}m)`, async (model, world) => {
    if (!world.alive) return;
    const result = await world.create(minutes);
    if ("id" in result) model.created.push(result.id);
  })),
  // Mostly long enough to bring a follow-up due; sometimes not.
  fc.integer({ min: 30_000, max: 3 * MINUTE }).map((ms) => command(`tick(${ms})`, async (_model, world) => {
    await world.tick(ms);
  })),
  fc.tuple(fc.nat(), fc.boolean()).map(([pick, byAgent]) => command(
    `cancel(${pick}, ${byAgent ? "agent" : "operator"})`,
    async (model, world) => {
      if (!world.alive || model.created.length === 0) return;
      const id = model.created[pick % model.created.length]!;
      const admittedBefore = world.admittedCount(id);
      // Cancelling a failed row only dismisses it from the queue. It makes no
      // promise about a turn the crash may already have started.
      if (world.store.get(id)?.status === "failed") return;
      const ok = byAgent
        ? (await world.callTool({ action: "cancel", followUpId: id })).ok
        : await world.service.cancel({ id }).then(
            (response) => response.action.status === "cancelled",
            () => false,
          );
      await world.settle();
      if (!ok) return;
      expect(admittedBefore, `follow-up ${id} was reported cancelled after it ran`).toBe(0);
      if (!model.cancelled.has(id)) model.cancelled.set(id, admittedBefore);
    },
  )),
  fc.boolean().map((locked) => command(locked ? "lock" : "unlock", async (_model, world) => {
    if (!world.alive) return;
    await world.setLocked(locked);
    // An unlock on an idle, open thread starts every follow-up a lock held,
    // whichever process the lock held it in. A crash during the unlock leaves
    // the rest for the next launch, which the final phase checks.
    if (!locked && world.alive && !world.busy && !world.gateClosed && !followUpsSuspended(world)) {
      for (const action of world.actions()) {
        expect(action.status, `follow-up ${action.id} is still held after unlock`).not.toBe("held");
      }
    }
  })),
  fc.boolean().map((busy) => command(busy ? "turnStarts" : "turnEnds", async (_model, world) => {
    if (world.alive) await world.setBusy(busy);
  })),
  fc.boolean().map((closed) => command(closed ? "gateCloses" : "gateOpens", async (_model, world) => {
    if (world.alive) await world.setGateClosed(closed);
  })),
  fc.constantFrom<CrashPoint>("before_admit", "after_admit", "after_queue_start").map((point) =>
    // The crash, if it happens, lands inside a later command's dispatch.
    command(`armCrash(${point})`, async (_model, world) => {
      if (world.alive) world.armedCrash = point;
    })),
  fc.constant(command("restart", async (model, world) => {
    for (const action of world.actions()) {
      if (action.status === "dispatching" || action.status === "queued") model.inFlightAtCrash.add(action.id);
    }
    await world.restart();
    // Claimed and not confirmed: it fails visibly and is never sent again.
    for (const id of model.inFlightAtCrash) {
      const action = world.store.get(id);
      expect(action?.status, `follow-up ${id} was in flight at the stop`).toBe("failed");
      expect(action?.errorMessage).toBeTruthy();
    }
    model.inFlightAtCrash.clear();
  })),
];

describe("agent follow-up lifecycle model", () => {
  it("admits each follow-up at most once, never after a cancel, and once after a lock releases it, across crash and restart", async (context) => {
    // fast-check's default size stops near ten commands, too few to reach a
    // crash behind a busy thread; ask for the whole range.
    const scenarios = fc.commands(commands, { maxCommands: 40, size: "max" });
    await assertFollowUpProperty(context, fc.asyncProperty(scenarios, fc.boolean(), async (cmds, reuseProcessId) => {
      await withWorld(async (world) => {
        const model: Model = { created: [], cancelled: new Map(), inFlightAtCrash: new Set() };
        await fc.asyncModelRun(() => ({ model, real: world }), cmds);
        // Whatever state the run ended in, a clean launch and a long idle
        // must not start anything that was cancelled or already started.
        for (const action of world.actions()) {
          if (action.status === "dispatching" || action.status === "queued") model.inFlightAtCrash.add(action.id);
        }
        world.locked = false;
        world.busy = false;
        world.gateClosed = false;
        await world.restart();
        await world.tick(10 * MINUTE);
        await world.tick(10 * MINUTE);
        checkOracle(model, world);
        for (const id of model.inFlightAtCrash) expect(world.store.get(id)?.status).toBe("failed");
        // Unlocked and idle: everything that was neither cancelled nor failed
        // ran exactly once, wherever a lock had held it.
        if (followUpsSuspended(world)) return;
        for (const action of world.actions()) {
          if (action.status === "cancelled" || action.status === "failed") continue;
          expect(action.status, `follow-up ${action.id} never started`).toBe("started");
          expect(world.admittedCount(action.id)).toBe(1);
        }
      }, { reuseProcessId });
    }), 50);
  });

  it("retires a cancelled model before another test can measure writes", async (context) => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (caseCount) => {
      const controller = new AbortController();
      const paused = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const reason = new Error("Test deadline elapsed");
      const onTestFinished = vi.fn<TestContext["onTestFinished"]>();
      let opened = 0;
      let closed = 0;
      const model = assertFollowUpProperty({
        signal: controller.signal,
        onTestFinished,
      }, fc.asyncProperty(fc.constant(null), async () => {
        if (++opened === caseCount) {
          paused.resolve();
          await resume.promise;
        }
        closed += 1;
      }), caseCount + 1);
      const result = model.catch((error: unknown) => error);
      let closedBeforeNextTest: number;
      try {
        await paused.promise;
        controller.abort(reason);
        expect(onTestFinished).toHaveBeenCalledTimes(1);
        const [[finish]] = onTestFinished.mock.calls;
        const cleanup = Promise.resolve(finish(context)).then(() => closed);
        // Leave the case paused while a finish hook that returned early could settle.
        expect(await Promise.race([cleanup, yieldToEventLoop("paused")])).toBe("paused");
        resume.resolve();
        closedBeforeNextTest = await cleanup;
      } finally {
        resume.resolve();
        await result;
      }
      expect(await result).toMatchObject({ cause: reason });
      expect({ opened, closedBeforeNextTest }).toEqual({ opened: caseCount, closedBeforeNextTest: caseCount });
    }), { examples: [[1]], numRuns: 10 });
  });

  it("waits for due action publication before reporting the world settled", async () => {
    await withWorld(async (world) => {
      await world.create(1);
      const publishing = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      world.onPublish = async () => {
        publishing.resolve();
        await resume.promise;
      };
      const order: string[] = [];
      const tick = world.tick(2 * MINUTE).then(() => { order.push("settled"); });
      await publishing.promise;
      // Cross the old setImmediate boundary while publication is still blocked.
      await yieldToEventLoop();
      order.push("released");
      resume.resolve();
      await tick;
      expect(order).toEqual(["released", "settled"]);
    });
  });

  it("starts a lock-held follow-up once on unlock and records it as started", async () => {
    await withWorld(async (world) => {
      await world.setLocked(true);
      const created = await world.create(1);
      if (!("id" in created)) throw new Error(created.refused);
      await world.tick(2 * MINUTE);
      expect(world.store.get(created.id)).toMatchObject({ status: "held" });
      expect(world.admittedCount(created.id)).toBe(0);

      await world.setLocked(false);
      expect(world.admittedCount(created.id)).toBe(1);
      expect(world.store.get(created.id)).toMatchObject({ status: "started" });
      await world.restart();
      await world.tick(10 * MINUTE);
      expect(world.admittedCount(created.id)).toBe(1);
    });
  });

  it.each([true, false])("starts a lock-held follow-up once after a restart, unlocked before the restart: %s", async (unlockFirst) => {
    await withWorld(async (world) => {
      await world.setLocked(true);
      const created = await world.create(1);
      if (!("id" in created)) throw new Error(created.refused);
      await world.tick(2 * MINUTE);
      expect(world.store.get(created.id)).toMatchObject({ status: "held" });

      // The hold lived in the dead process's queue. Unlocking while no
      // process runs is a write the next launch reads.
      world.crash();
      if (unlockFirst) world.locked = false;
      await world.restart();
      await world.setLocked(false);
      await world.tick(MINUTE);
      expect(world.admittedCount(created.id)).toBe(1);
      expect(world.store.get(created.id)).toMatchObject({ status: "started" });
      await world.restart();
      await world.tick(10 * MINUTE);
      expect(world.admittedCount(created.id)).toBe(1);
    });
  });

  it("sends a lock-held operator action with Send Now after a restart and unlock", async () => {
    await withWorld(async (world) => {
      await world.setLocked(true);
      const operator = await world.service.create({
        ...FOLLOW_UP_THREAD, kind: "turn", origin: "desktop", scheduledFor: world.clock + MINUTE,
        displayText: "Operator message", turn: { input: [{ type: "text", text: "Operator message" }] },
      });
      await world.tick(2 * MINUTE);
      expect(world.store.get(operator.action.id)).toMatchObject({ status: "held" });
      await world.restart();
      // Still locked: Send Now keeps it held behind the lock instead of failing.
      await world.service.sendNow({ id: operator.action.id });
      await world.settle();
      expect(world.store.get(operator.action.id)).toMatchObject({ status: "held" });
      expect(world.admittedCount(operator.action.id)).toBe(0);
      await world.setLocked(false);
      expect(world.admittedCount(operator.action.id)).toBe(1);
      expect(world.store.get(operator.action.id)).toMatchObject({ status: "started" });
    });
  });

  it("fails a lock-held follow-up whose unlock started it just before a crash, and never sends it again", async () => {
    await withWorld(async (world) => {
      await world.setLocked(true);
      const created = await world.create(1);
      if (!("id" in created)) throw new Error(created.refused);
      await world.tick(2 * MINUTE);
      world.armedCrash = "after_queue_start";
      await world.setLocked(false);
      expect(world.alive).toBe(false);
      expect(world.admittedCount(created.id)).toBe(1);

      await world.restart();
      await world.tick(10 * MINUTE);
      expect(world.store.get(created.id)).toMatchObject({ status: "failed" });
      expect(world.admittedCount(created.id)).toBe(1);
    });
  });

  it("leaves a follow-up an unlock never reached for the next launch when the process dies mid-unlock", async () => {
    await withWorld(async (world) => {
      await world.setLocked(true);
      const first = await world.create(1);
      const second = await world.create(1);
      if (!("id" in first) || !("id" in second)) throw new Error("create refused");
      await world.tick(MINUTE);
      expect(world.actions().map((action) => action.status)).toEqual(["held", "held"]);
      world.armedCrash = "after_queue_start";
      await world.setLocked(false);
      expect(world.alive).toBe(false);

      await world.restart();
      await world.tick(10 * MINUTE);
      // The start the crash interrupted fails visibly; the hold it never
      // reached starts once.
      const [started, unreached] = world.admittedCount(first.id) === 1 ? [first.id, second.id] : [second.id, first.id];
      expect(world.store.get(started)).toMatchObject({ status: "failed" });
      expect(world.admittedCount(started)).toBe(1);
      expect(world.store.get(unreached)).toMatchObject({ status: "started" });
      expect(world.admittedCount(unreached)).toBe(1);
    });
  });

  it("re-admits a lock hold by its stored cause after a later build rewords the refusal", async () => {
    await withWorld(async (world) => {
      await world.setLocked(true);
      const created = await world.create(1);
      if (!("id" in created)) throw new Error(created.refused);
      await world.tick(2 * MINUTE);
      expect(world.store.get(created.id)).toMatchObject({ status: "held", holdCause: "thread_lock" });
      world.db.raw.prepare("UPDATE scheduled_thread_actions SET error_message = ? WHERE action_id = ?")
        .run("Paused until the operator lifts the hold.", created.id);

      await world.restart();
      await world.setLocked(false);
      expect(world.admittedCount(created.id)).toBe(1);
      expect(world.store.get(created.id)).toMatchObject({ status: "started" });
    });
  });

  it("re-admits a hold an older build stored with only its lock refusal, and leaves other holds to the operator", async () => {
    await withWorld(async (world) => {
      await world.setLocked(true);
      const hold = (id: string, reason: string): void => {
        world.store.create({
          id, ...FOLLOW_UP_THREAD, kind: "turn", origin: "desktop", scheduledFor: world.clock + 60 * MINUTE,
          displayText: id, turn: { input: [{ type: "text", text: id }] }, now: world.clock,
        });
        world.store.claim(id, { now: world.clock, ownerId: "scheduler:1:legacy", leaseExpiresAt: world.clock + 30_000 });
        // Older builds stored neither a holder nor a cause.
        world.store.markHeld(id, `scheduled-turn:${id}`, reason, world.clock);
      };
      hold("scheduled-action:legacy-lock", "This thread is locked. Unlock it to send.");
      hold("scheduled-action:steer", "Wait for the active turn to finish before retrying this message.");

      await world.restart();
      await world.setLocked(false);
      await world.tick(10 * MINUTE);
      expect(world.admittedCount("scheduled-action:legacy-lock")).toBe(1);
      expect(world.store.get("scheduled-action:legacy-lock")).toMatchObject({ status: "started" });
      expect(world.admittedCount("scheduled-action:steer")).toBe(0);
      expect(world.store.get("scheduled-action:steer")).toMatchObject({ status: "held" });
    });
  });

  it("holds due follow-ups behind the restart gate", async () => {
    await withWorld(async (world) => {
      const created = await world.create(1);
      if (!("id" in created)) throw new Error(created.refused);
      await world.setGateClosed(true);
      await world.tick(5 * MINUTE);
      expect(world.admittedCount(created.id)).toBe(0);
      await world.setGateClosed(false);
      expect(world.admittedCount(created.id)).toBe(1);
    });
  });

  it.each<CrashPoint>(["before_admit", "after_admit", "after_queue_start"])(
    "fails a follow-up visibly after a crash at %s and never replays it",
    async (point) => {
      await withWorld(async (world) => {
        if (point === "after_queue_start") await world.setBusy(true);
        const created = await world.create(1);
        if (!("id" in created)) throw new Error(created.refused);
        world.armedCrash = point;
        await world.tick(2 * MINUTE);
        if (point === "after_queue_start") await world.setBusy(false);
        expect(world.alive).toBe(false);
        const admittedAtCrash = world.admittedCount(created.id);
        expect(admittedAtCrash).toBe(point === "before_admit" ? 0 : 1);

        await world.restart();
        await world.tick(10 * MINUTE);
        expect(world.store.get(created.id)).toMatchObject({ status: "failed" });
        expect(world.admittedCount(created.id)).toBe(admittedAtCrash);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Property: no sequence of create-on-wake calls exceeds the guard.
//
// The agent is an adversary: on every wake it schedules as many follow-ups as
// it is allowed, as soon as it is allowed, and cancels and re-creates them to
// try to reset protection. Elapsed real time (`trueTime`) is the oracle's
// clock; the wall clock the service reads can be rolled back under it.
// ---------------------------------------------------------------------------

const guardStep = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 20 * MINUTE }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 5 * 60 * MINUTE }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("rollback" as const), ms: fc.integer({ min: 1, max: 30 * 60 * MINUTE }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("restart" as const), ms: fc.constant(0) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("churn" as const), ms: fc.constant(0) }) },
);

describe("agent follow-up loop guard", () => {
  it("bounds self-waking across restart and clock rollback, and stays suspended once tripped", async (context) => {
    await assertFollowUpProperty(context, fc.asyncProperty(
      fc.array(guardStep, { minLength: 1, maxLength: 60 }),
      fc.integer({ min: 1, max: 12 }),
      async (steps, burst) => {
        await withWorld(async (world) => {
          let suspendedWithAdmissions: number | undefined;
          const greedyCreate = async (): Promise<void> => {
            for (let index = 0; index < burst; index += 1) {
              const before = world.clock;
              const result = await world.create(1);
              if (!("id" in result)) continue;
              // Minimum delay: nothing an agent creates is due within a minute.
              expect(world.store.get(result.id)!.scheduledFor - before).toBeGreaterThanOrEqual(AGENT_FOLLOW_UP_MIN_DELAY_MS);
            }
          };
          world.onWake = greedyCreate;
          const check = (): void => {
            expect(world.store.countActiveAgentFollowUps(FOLLOW_UP_THREAD))
              .toBeLessThanOrEqual(AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD);
            // Every admission, with the ones in the real 24 hours before it.
            for (const admission of world.admissions) {
              const inWindow = world.admissions.filter((other) =>
                other.trueTime <= admission.trueTime
                && other.trueTime > admission.trueTime - AGENT_FOLLOW_UP_FIRED_WINDOW_MS).length;
              expect(inWindow).toBeLessThanOrEqual(AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW);
            }
            const suspended = world.service.agentFollowUpProtection(FOLLOW_UP_THREAD).suspendedAt !== undefined;
            if (suspendedWithAdmissions !== undefined) {
              // Only the operator rearms. Time, restarts and churn do not.
              expect(suspended).toBe(true);
              expect(world.admissions.length).toBe(suspendedWithAdmissions);
            } else if (suspended) {
              suspendedWithAdmissions = world.admissions.length;
            }
          };
          await greedyCreate();
          check();
          for (const step of steps) {
            if (step.kind === "advance") await world.tick(step.ms);
            else if (step.kind === "rollback") world.clock -= step.ms;
            else if (step.kind === "restart") await world.restart();
            else {
              // Cancel everything and schedule it again, to try for a reset.
              const listed = await world.callTool({ action: "list" });
              const rows = listed.ok ? (listed.data as { followUps: ScheduleFollowUpToolResult }).followUps.followUps ?? [] : [];
              for (const row of rows) await world.callTool({ action: "cancel", followUpId: row.followUpId });
              await greedyCreate();
            }
            check();
          }
          // A full day later, after another launch, nothing new has fired.
          if (suspendedWithAdmissions !== undefined) {
            await world.restart();
            await world.tick(AGENT_FOLLOW_UP_FIRED_WINDOW_MS + MINUTE);
            await greedyCreate();
            await world.tick(5 * MINUTE);
            check();
          }
        });
      },
    ), 40);
  });

  it("trips on the thirteenth follow-up in a day and fires again only after the operator rearms", async () => {
    await withWorld(async (world) => {
      const fire = async (): Promise<string> => {
        const created = await world.create(1);
        if (!("id" in created)) throw new Error(created.refused);
        await world.tick(2 * MINUTE);
        return created.id;
      };
      for (let index = 0; index < AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW; index += 1) {
        expect(world.admittedCount(await fire())).toBe(1);
      }
      const tripped = await fire();
      expect(world.admittedCount(tripped)).toBe(0);
      // It waits, visibly suspended, instead of failing or vanishing.
      expect(world.store.get(tripped)).toMatchObject({ status: "scheduled" });
      expect(world.store.listPendingWakes({ ...FOLLOW_UP_THREAD, endedLimit: 0 }).actions)
        .toEqual([expect.objectContaining({ id: tripped, origin: "agent", followUpSuspended: true })]);
      expect(world.store.nextScheduledAt()).toBeUndefined();
      const listed = await world.callTool({ action: "list" });
      expect(listed).toMatchObject({ ok: true, data: { followUps: { suspended: true } } });
      // Send Now is not a way around it either, a day later or after a launch.
      await world.restart();
      await world.tick(AGENT_FOLLOW_UP_FIRED_WINDOW_MS + MINUTE);
      await expect(world.service.sendNow({ id: tripped })).rejects.toThrow("suspended");
      expect(world.admittedCount(tripped)).toBe(0);

      // The operator's own scheduled message on the same thread still fires.
      const operator = await world.service.create({
        ...FOLLOW_UP_THREAD, kind: "turn", origin: "desktop", scheduledFor: world.clock + MINUTE,
        displayText: "Operator message", turn: { input: [{ type: "text", text: "Operator message" }] },
      });
      await world.tick(2 * MINUTE);
      expect(world.admittedCount(operator.action.id)).toBe(1);
      expect(world.admittedCount(tripped)).toBe(0);

      await world.service.rearmAgentFollowUps(FOLLOW_UP_THREAD);
      await world.settle();
      expect(world.admittedCount(tripped)).toBe(1);
    });
  });

  it("still reports a suspension after the operator cancels the last waiting follow-up", async () => {
    await withWorld(async (world) => {
      const readers: ThreadPendingWakeReaders = {
        prWatches: async () => [], prWatchHistory: async () => [], autoFix: async () => [], dependencies: async () => [],
        scheduledActions: (thread, endedLimit) => world.store.listPendingWakes({ ...thread, endedLimit }),
        monitors: () => [], recentSubAgents: async () => [], backendTasks: async () => [], backendWakes: () => [],
        hold: async () => undefined, heldEntries: () => [],
      };
      // Oracle: Waiting for reports a suspension exactly when the guard holds one.
      const expectProjectionMatchesGuard = async (): Promise<void> => {
        const list = await buildThreadPendingWakes(readers, FOLLOW_UP_THREAD, { endedLimit: 0 });
        expect(list.followUpsSuspended === true).toBe(followUpsSuspended(world));
      };
      const fire = async (): Promise<string> => {
        const created = await world.create(1);
        if (!("id" in created)) throw new Error(created.refused);
        await world.tick(2 * MINUTE);
        return created.id;
      };
      for (let index = 0; index < AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW; index += 1) await fire();
      await expectProjectionMatchesGuard();
      const tripped = await fire();
      expect(followUpsSuspended(world)).toBe(true);
      await expectProjectionMatchesGuard();

      // Cancelling does not rearm, so the operator must still see the notice.
      await world.service.cancel({ id: tripped });
      expect(world.store.listPendingWakes({ ...FOLLOW_UP_THREAD, endedLimit: 0 }))
        .toEqual({ actions: [], followUpsSuspended: true });
      expect(followUpsSuspended(world)).toBe(true);
      await expectProjectionMatchesGuard();
      await world.restart();
      await world.tick(AGENT_FOLLOW_UP_FIRED_WINDOW_MS + MINUTE);
      await expectProjectionMatchesGuard();

      // An operator action on the thread is not an agent follow-up and is not marked.
      const operator = await world.service.create({
        ...FOLLOW_UP_THREAD, kind: "turn", origin: "desktop", scheduledFor: world.clock + 60 * MINUTE,
        displayText: "Operator message", turn: { input: [{ type: "text", text: "Operator message" }] },
      });
      const listed = world.store.listPendingWakes({ ...FOLLOW_UP_THREAD, endedLimit: 0 });
      expect(listed.followUpsSuspended).toBe(true);
      expect(listed.actions).toEqual([expect.objectContaining({ id: operator.action.id })]);
      expect(listed.actions[0]).not.toHaveProperty("followUpSuspended");

      await world.service.rearmAgentFollowUps(FOLLOW_UP_THREAD);
      expect(world.store.listPendingWakes({ ...FOLLOW_UP_THREAD, endedLimit: 0 })).not.toHaveProperty("followUpsSuspended");
      await expectProjectionMatchesGuard();
    });
  });

  it("suspends a thread whose guard row cannot be read, and other due work still fires", async () => {
    const db = openInMemoryStateDb();
    const world = new AgentFollowUpWorld(db);
    try {
      await world.start();
      const first = await world.create(1);
      if (!("id" in first)) throw new Error(first.refused);
      await world.tick(2 * MINUTE);
      expect(world.admittedCount(first.id)).toBe(1);
      db.raw.prepare("UPDATE thread_agent_follow_up_guards SET payload = '{'").run();

      const blocked = await world.create(1);
      if (!("id" in blocked)) throw new Error(blocked.refused);
      const operator = await world.service.create({
        ...FOLLOW_UP_THREAD, kind: "turn", origin: "desktop", scheduledFor: world.clock + MINUTE,
        displayText: "Operator message", turn: { input: [{ type: "text", text: "Operator message" }] },
      });
      await world.tick(2 * MINUTE);
      // An allowance that cannot be counted is not spent, and it stalls nothing else.
      expect(world.admittedCount(blocked.id)).toBe(0);
      expect(world.admittedCount(operator.action.id)).toBe(1);
      expect(world.store.listPendingWakes({ ...FOLLOW_UP_THREAD, endedLimit: 0 }).actions)
        .toEqual([expect.objectContaining({ id: blocked.id, followUpSuspended: true })]);

      await world.service.rearmAgentFollowUps(FOLLOW_UP_THREAD);
      await world.settle();
      expect(world.admittedCount(blocked.id)).toBe(1);
    } finally {
      world.dispose();
      db.close();
    }
  });
});

describe("schedule_follow_up scope", () => {
  it("lists the operator's scheduled action and refuses to cancel it", async () => {
    await withWorld(async (world) => {
      const operator = await world.service.create({
        ...FOLLOW_UP_THREAD, kind: "turn", origin: "desktop", scheduledFor: world.clock + 60 * MINUTE,
        displayText: "Operator message", turn: { input: [{ type: "text", text: "Operator message" }] },
      });
      const listed = await world.callTool({ action: "list" });
      expect(listed).toMatchObject({ ok: true, data: { followUps: { followUps: [
        { followUpId: operator.action.id, setBy: "operator", cancellable: false },
      ] } } });
      expect(await world.callTool({ action: "cancel", followUpId: operator.action.id }))
        .toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(world.store.get(operator.action.id)).toMatchObject({ status: "scheduled" });
    });
  });

  it("cannot reach another thread's follow-up or name a thread in its arguments", async () => {
    await withWorld(async (world) => {
      const other = world.store.create({
        id: "scheduled-action:other", backend: "codex", threadId: "another-thread", kind: "turn", origin: "agent",
        scheduledFor: world.clock + 60 * MINUTE, displayText: "Other", turn: { input: [{ type: "text", text: "Other" }] },
        now: world.clock,
      });
      expect(await world.callTool({ action: "cancel", followUpId: other.id }))
        .toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(world.store.get(other.id)).toMatchObject({ status: "scheduled" });
      const smuggled = { action: "create", delayMinutes: 5, prompt: "Check", threadId: "another-thread", role: "admin" };
      expect(await world.callTool(smuggled as never)).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
      const listed = await world.callTool({ action: "list" });
      expect(listed).toMatchObject({ ok: true, data: { followUps: { followUps: [] } } });
    });
  });

  it("refuses a delay under one minute, a ninth waiting follow-up and the generic create path", async () => {
    await withWorld(async (world) => {
      expect(await world.callTool({ action: "create", delayMinutes: 0.5, prompt: "Check" }))
        .toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
      expect(await world.callTool({ action: "create", at: new Date(world.clock + 30_000).toISOString(), prompt: "Check" }))
        .toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
      for (let index = 0; index < AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD; index += 1) {
        expect(await world.create(30)).toHaveProperty("id");
      }
      expect(await world.create(30)).toHaveProperty("refused");
      await expect(world.service.create({
        ...FOLLOW_UP_THREAD, kind: "turn", origin: "agent", scheduledFor: world.clock + MINUTE,
        displayText: "Bypass", turn: { input: [{ type: "text", text: "Bypass" }] },
      })).rejects.toThrow("schedule_follow_up");
    });
  });

  it("keeps the asking contact's messaging source on the woken turn and the prompt out of SQLite", async () => {
    const temp = createTempStateDb("pwragent-agent-follow-up-");
    const db = StateDb.open(temp.dbPath);
    const world = new AgentFollowUpWorld(db);
    try {
      await world.start();
      const prompt = "UNIQUE-FOLLOW-UP-PROMPT check the canary dashboard";
      const provenance = { causalMessagingSource: { bindingId: "binding-1" } as never };
      const action = await world.service.createAgentFollowUp({
        ...FOLLOW_UP_THREAD, scheduledFor: world.clock + 5 * MINUTE, prompt, provenance,
      });
      expect(action.turn?.messageOrigin).toMatchObject({ kind: "pwragent", ...provenance });
      const dump = JSON.stringify(db.raw.prepare("SELECT * FROM scheduled_thread_actions").all())
        + JSON.stringify(db.raw.prepare("SELECT * FROM thread_agent_follow_up_guards").all());
      expect(dump).toContain(action.id);
      expect(dump).not.toContain("UNIQUE-FOLLOW-UP-PROMPT");
    } finally {
      world.dispose();
      db.close();
      removeTempStateDbDir(temp.tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Write budgets. One follow-up is a handful of boundary transitions; nothing
// here writes on a timer, a heartbeat or a streamed event.
// ---------------------------------------------------------------------------

describe("agent follow-up write budgets", () => {
  async function measured(
    arrange: (world: AgentFollowUpWorld) => Promise<void>,
    feature: (world: AgentFollowUpWorld) => Promise<void>,
    budget: { scenario: string; note: string },
  ): Promise<void> {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-agent-follow-up-budget-");
    const db = StateDb.open(temp.dbPath);
    const world = new AgentFollowUpWorld(db);
    try {
      world.heartbeatOnTick = false;
      await world.start();
      await arrange(world);
      const { writes } = await measureSqliteWrites(() => feature(world));
      expectSqliteWriteBudget({ ...budget, writes });
    } finally {
      world.dispose();
      db.close();
      removeTempStateDbDir(temp.tempDir);
    }
  }

  it("holds ten follow-ups on an idle thread to their budget", async () => {
    await measured(async () => undefined, async (world) => {
      for (let index = 0; index < 10; index += 1) {
        const created = await world.create(1);
        if (!("id" in created)) throw new Error(created.refused);
        await world.tick(2 * MINUTE);
        expect(world.store.get(created.id)).toMatchObject({ status: "started" });
      }
    }, {
      scenario: "agent-follow-up-ten-lifecycles",
      note: "ten agent follow-ups on an idle thread, each create through started: three commits each (create; "
        + "claim, with its loop-guard reservation in the same commit; started). Measured about 46 KB of WAL per "
        + "follow-up: 2.3 MB/day at 50 a day, and at most 12 fire per thread per day. No timer or heartbeat write.",
    });
  });

  it("holds one follow-up that waits behind an active turn to its budget", async () => {
    await measured(async (world) => await world.setBusy(true), async (world) => {
      const created = await world.create(1);
      if (!("id" in created)) throw new Error(created.refused);
      await world.tick(2 * MINUTE);
      expect(world.store.get(created.id)).toMatchObject({ status: "queued" });
      await world.setBusy(false);
      expect(world.store.get(created.id)).toMatchObject({ status: "started" });
    }, {
      scenario: "agent-follow-up-queued-lifecycle",
      note: "one agent follow-up that comes due behind an active turn: create, claim with guard reservation, "
        + "queued, started: four commits, the most one follow-up costs. Measured about 70 KB of WAL: 3.5 MB/day "
        + "if all 50 follow-ups a day waited behind a turn.",
    });
  });

  it("holds a lock-held follow-up, through a restart and the unlock, to its budget", async () => {
    await measured(async (world) => await world.setLocked(true), async (world) => {
      const created = await world.create(1);
      if (!("id" in created)) throw new Error(created.refused);
      await world.tick(2 * MINUTE);
      expect(world.store.get(created.id)).toMatchObject({ status: "held" });
      await world.restart();
      await world.setLocked(false);
      expect(world.store.get(created.id)).toMatchObject({ status: "started" });
    }, {
      scenario: "agent-follow-up-lock-held-restart",
      note: "one agent follow-up a lock holds across a restart: create, claim, held (recording its holder); the "
        + "next launch claims it from the dead holder and holds it again (two commits); the unlock queues it under "
        + "a lease before the start, then started. The restart costs two commits per held action and the unlock one "
        + "more than a direct start.",
    });
  });

  it("holds an agent's cancel to its budget", async () => {
    await measured(async () => undefined, async (world) => {
      const created = await world.create(30);
      if (!("id" in created)) throw new Error(created.refused);
      expect(await world.callTool({ action: "cancel", followUpId: created.id })).toMatchObject({ ok: true });
    }, {
      scenario: "agent-follow-up-cancel",
      note: "one agent follow-up created and cancelled before it fires: two commits, and the guard is not written.",
    });
  });

  it("holds the loop guard's trip, its idle time suspended, and the rearm to their budget", async () => {
    await measured(async (world) => {
      for (let index = 0; index < AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW; index += 1) {
        await world.create(1);
        await world.tick(2 * MINUTE);
      }
      await world.create(1);
    }, async (world) => {
      await world.tick(2 * MINUTE);
      expect(world.service.agentFollowUpProtection(FOLLOW_UP_THREAD).suspendedAt).toBeDefined();
      // Suspended for an hour of scheduler passes: nothing more is written.
      for (let pass = 0; pass < 360; pass += 1) await world.tick(10_000);
      await world.service.rearmAgentFollowUps(FOLLOW_UP_THREAD);
      await world.settle();
      expect(world.admissions).toHaveLength(AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW + 1);
    }, {
      scenario: "agent-follow-up-guard-trip-and-rearm",
      note: "the thirteenth follow-up in a day trips the guard (one commit), 360 scheduler passes while "
        + "suspended write nothing, then the operator's rearm (one commit) lets it fire (claim, started).",
    });
  });
});
