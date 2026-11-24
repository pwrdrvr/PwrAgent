import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_NOTIFICATION_WINDOW_MS,
  type AgentNotificationLimits,
  type NotifyOperatorToolArgs,
  type NotifyOperatorToolResult,
  type ScheduledThreadAction,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import { MemoryScheduledThreadActionPayloadStore } from "@pwragent/sqlite-storage/scheduled-thread-action-payload-store";
import type { PwrAgentThreadInspectionResponse } from "@pwragent/shared/contracts/thread-tools";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { AgentNotificationCenter } from "../scheduled-actions/agent-notification-center";
import { buildAgentNotificationToolHandler, readNotificationArgs } from "../scheduled-actions/agent-notification-tool";
import {
  ScheduledThreadActionService,
  schedulerOwnerId,
} from "../scheduled-actions/scheduled-thread-action-service";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

const MINUTE = 60_000;
const THREADS = [
  { backend: "codex" as const, threadId: "thread-notice-a" },
  { backend: "claude" as const, threadId: "thread-notice-b" },
];
type Thread = (typeof THREADS)[number];
const LEASE_MS = 30_000;
const FIRST_PROCESS_ID = 9_100_000;

/**
 * The real scheduler and store over a real database. `deliveries` is the
 * operator's record of every notice shown, which no crash erases, so it is
 * the oracle for "how many times was this notice delivered".
 */
class NoticeWorld {
  clock = 1_800_000_000_000;
  alive = false;
  /** The next delivery kills the process after showing the notice. */
  crashAfterDelivery = false;
  limits: AgentNotificationLimits = { maxPerThreadPerDay: 4, maxPerProfilePerDay: 6, maxScheduledPerThread: 3 };
  readonly deliveries: Array<{ id: string; at: number }> = [];
  service!: ScheduledThreadActionService;
  store!: ScheduledThreadActionStore;
  private generation = 0;
  private readonly payloads = new MemoryScheduledThreadActionPayloadStore();
  private tool!: ReturnType<typeof buildAgentNotificationToolHandler>;
  private pending: Promise<void>[] = [];

  constructor(readonly db: StateDb) {}

  deliveredCount(id: string): number {
    return this.deliveries.filter((delivery) => delivery.id === id).length;
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    const processId = FIRST_PROCESS_ID + generation;
    const instanceId = `notice-world-${generation}`;
    const live = (): boolean => this.alive && this.generation === generation;
    this.store = new ScheduledThreadActionStore(this.db, this.payloads);
    this.service = new ScheduledThreadActionService({
      registry: this.registry(),
      store: this.store,
      now: () => this.clock,
      ownerId: schedulerOwnerId({ processId, instanceId, startedAt: this.clock }),
      ownerProbes: {
        currentProcessId: processId,
        isProcessAlive: (candidate) => live() && candidate === processId,
        isRuntimeIdentityLive: (identity) => live() && identity.instanceId === instanceId,
      },
      setTimer: () => ({}) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      setLeaseTimer: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
      clearLeaseTimer: () => undefined,
      agentNotificationLimits: () => this.limits,
      deliverAgentNotification: async (action) => {
        if (!live()) return await new Promise<void>(() => undefined);
        this.deliveries.push({ id: action.id, at: this.clock });
        if (this.crashAfterDelivery) {
          this.crashAfterDelivery = false;
          this.crash();
          // The dead process never records the delivery.
          return await new Promise<void>(() => undefined);
        }
      },
    });
    const evaluate = this.service.evaluateDueActions.bind(this.service);
    this.service.evaluateDueActions = () => {
      const pending = evaluate();
      this.pending.push(pending);
      return pending;
    };
    this.tool = buildAgentNotificationToolHandler(this.service, () => this.clock);
    this.alive = true;
    this.service.start();
    await this.settle();
  }

  crash(): void {
    if (!this.alive) return;
    this.alive = false;
    this.service.dispose();
    this.generation += 1;
    this.pending = [];
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.service.dispose();
  }

  async restart(): Promise<void> {
    this.crash();
    this.clock += LEASE_MS + 1;
    await this.start();
  }

  async tick(ms: number): Promise<void> {
    this.clock += ms;
    if (!this.alive) return;
    void this.service.evaluateDueActions();
    await this.settle();
  }

  async settle(): Promise<void> {
    // A crashed delivery never settles; the dead process's work is dropped.
    while (this.alive && this.pending.length > 0) {
      const batch = this.pending.splice(0);
      await Promise.race([Promise.all(batch), new Promise((resolve) => setTimeout(resolve, 0))]);
      if (!this.alive) return;
    }
  }

  async callTool(thread: Thread, args: NotifyOperatorToolArgs): Promise<PwrAgentThreadInspectionResponse> {
    const response = this.tool(args, thread);
    // A notice due now is delivered inside the call; a crash there never returns.
    const settled = await Promise.race([response, new Promise<undefined>((resolve) => setTimeout(resolve, 0))]);
    if (settled) return settled;
    if (!this.alive) return { ok: false, error: { code: "internal_error", message: "crashed" } };
    return await response;
  }

  async send(thread: Thread, delayMinutes: number): Promise<{ id: string } | { refused: string }> {
    const response = await this.callTool(thread, {
      action: "send",
      title: "Review the changelog",
      body: "You asked me to remind you: the 2.4 changelog draft is ready.",
      ...(delayMinutes > 0 ? { delayMinutes } : {}),
    });
    if (!response.ok) return { refused: response.error.message };
    return { id: (response.data as { notifications: NotifyOperatorToolResult }).notifications.notification!.notificationId };
  }

  private registry(): DesktopBackendRegistry {
    return {
      onEvent: () => () => undefined,
      onRestartGateChanged: () => () => undefined,
      isRestartGateClosed: () => false,
      publishLocalEvent: async () => undefined,
      markScheduledThreadBorn: async () => undefined,
      markScheduledThreadStartTerminal: async () => undefined,
      submitTurn: async () => { throw new Error("A notice must never start a turn."); },
      submitHeldTurn: async () => { throw new Error("A notice must never start a turn."); },
      cancelQueuedTurn: () => false,
    } as unknown as DesktopBackendRegistry;
  }
}

async function withWorld<T>(run: (world: NoticeWorld) => Promise<T>): Promise<T> {
  const db = openInMemoryStateDb();
  const world = new NoticeWorld(db);
  try {
    await world.start();
    return await run(world);
  } finally {
    world.dispose();
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Model: send now or later, cancel, tick, crash mid-delivery and restart.
//
// Oracles: the operator's own delivery record. No notice is delivered twice
// or before its time, a cancelled notice is never delivered, and every notice
// still waiting when its time comes is delivered once the owner runs. Bounds:
// a send is accepted exactly when the reference count of accepted sends in the
// rolling window, and of waiting notices, is under the operator's bound.
// ---------------------------------------------------------------------------

type Accepted = { id: string; thread: Thread; createdAt: number; dueAt: number };
type Model = {
  accepted: Accepted[];
  cancelled: Set<string>;
  /** Notices a crash interrupted mid-delivery: shown once, then marked failed. */
  interrupted: Set<string>;
};

function expectedRefusal(model: Model, world: NoticeWorld, thread: Thread, dueAt: number): boolean {
  const since = world.clock - AGENT_NOTIFICATION_WINDOW_MS;
  const inWindow = model.accepted.filter((notice) => notice.createdAt > since);
  const onThread = inWindow.filter((notice) => notice.thread.threadId === thread.threadId);
  const waitingOnThread = model.accepted.filter((notice) =>
    notice.thread.threadId === thread.threadId
    && !model.cancelled.has(notice.id)
    && world.deliveredCount(notice.id) === 0
    && !model.interrupted.has(notice.id)).length;
  const { maxPerThreadPerDay, maxPerProfilePerDay, maxScheduledPerThread } = world.limits;
  return (maxScheduledPerThread > 0 && dueAt > world.clock && waitingOnThread >= maxScheduledPerThread)
    || (maxPerThreadPerDay > 0 && onThread.length >= maxPerThreadPerDay)
    || (maxPerProfilePerDay > 0 && inWindow.length >= maxPerProfilePerDay);
}

function checkOracle(model: Model, world: NoticeWorld): void {
  const byId = new Map(model.accepted.map((notice) => [notice.id, notice]));
  for (const delivery of world.deliveries) {
    const notice = byId.get(delivery.id);
    expect(notice, `an unknown notice ${delivery.id} was delivered`).toBeDefined();
    expect(world.deliveredCount(delivery.id), `notice ${delivery.id} was delivered twice`).toBe(1);
    expect(delivery.at, `notice ${delivery.id} was delivered early`).toBeGreaterThanOrEqual(notice!.dueAt);
    expect(model.cancelled.has(delivery.id), `cancelled notice ${delivery.id} was delivered`).toBe(false);
  }
  if (!world.alive) return;
  // Liveness: what came due while the owner ran has been delivered.
  for (const notice of model.accepted) {
    if (notice.dueAt > world.clock || model.cancelled.has(notice.id) || model.interrupted.has(notice.id)) continue;
    expect(world.deliveredCount(notice.id), `due notice ${notice.id} was not delivered`).toBe(1);
  }
}

type Command = fc.AsyncCommand<Model, NoticeWorld>;
const command = (name: string, run: (model: Model, world: NoticeWorld) => Promise<void>): Command => ({
  check: () => true,
  toString: () => name,
  run: async (model, world) => {
    await run(model, world);
    checkOracle(model, world);
  },
});

const commands = [
  fc.tuple(fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 90 }), fc.boolean()).map(([which, delay, crash]) =>
    command(`send(${which}, ${delay}m${crash ? ", crash" : ""})`, async (model, world) => {
      if (!world.alive) return;
      const thread = THREADS[which]!;
      const dueAt = world.clock + delay * MINUTE;
      const refuse = expectedRefusal(model, world, thread, dueAt);
      const createdAt = world.clock;
      world.crashAfterDelivery = crash && delay === 0;
      const before = new Set(world.deliveries.map((delivery) => delivery.id));
      const result = await world.send(thread, delay);
      world.crashAfterDelivery = false;
      if (!world.alive) {
        // Crashed while delivering: the notice was accepted and shown once.
        const shown = world.deliveries.find((delivery) => !before.has(delivery.id));
        expect(refuse).toBe(false);
        expect(shown).toBeDefined();
        model.accepted.push({ id: shown!.id, thread, createdAt, dueAt });
        model.interrupted.add(shown!.id);
        return;
      }
      expect("refused" in result, "refused" in result ? result.refused : "accepted").toBe(refuse);
      if ("id" in result) model.accepted.push({ id: result.id, thread, createdAt, dueAt });
    })),
  fc.integer({ min: 1, max: 6 * 60 }).map((minutes) => command(`tick(${minutes}m)`, async (_model, world) => {
    await world.tick(minutes * MINUTE);
  })),
  fc.tuple(fc.nat(), fc.boolean()).map(([pick, byAgent]) => command(`cancel(${pick}, ${byAgent ? "agent" : "operator"})`, async (model, world) => {
    if (!world.alive || model.accepted.length === 0) return;
    const notice = model.accepted[pick % model.accepted.length]!;
    const deliveredBefore = world.deliveredCount(notice.id);
    const ok = byAgent
      ? (await world.callTool(notice.thread, { action: "cancel", notificationId: notice.id })).ok
      : await world.service.cancel({ id: notice.id }).then(
          (response) => response.action.status === "cancelled",
          () => false,
        );
    if (!ok) return;
    expect(deliveredBefore, `notice ${notice.id} was cancelled after delivery`).toBe(0);
    model.cancelled.add(notice.id);
  })),
  fc.constant(command("restart", async (_model, world) => { await world.restart(); })),
  fc.constant(command("long-tick", async (_model, world) => { await world.tick(25 * 60 * MINUTE); })),
];

describe("agent notices", () => {
  it("deliver each notice at most once, on time, never after a cancel, and keep the operator's bounds", async () => {
    await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: 40 }), async (cmds) => {
      await withWorld(async (world) => {
        const model: Model = { accepted: [], cancelled: new Set(), interrupted: new Set() };
        await fc.asyncModelRun(() => ({ model, real: world }), cmds);
        // Everything still waiting is delivered once the owner runs past it.
        if (!world.alive) await world.restart();
        await world.tick(100 * 24 * 60 * MINUTE);
        checkOracle(model, world);
        for (const id of model.interrupted) {
          expect(world.store.get(id)?.status, `interrupted notice ${id} was not marked failed`).toBe("failed");
        }
      });
    }), { numRuns: 60 });
  });

  it("never spends or suspends the thread's follow-up allowance", async () => {
    // A notice is an agent-origin scheduled action like a follow-up. Before
    // notices were excluded from the follow-up guard, every notice claimed a
    // follow-up slot, and the thirteenth in a day suspended the thread's
    // follow-ups until the operator rearmed them.
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 30 }), async (count) => {
      await withWorld(async (world) => {
        world.limits = { maxPerThreadPerDay: 0, maxPerProfilePerDay: 0, maxScheduledPerThread: 0 };
        const thread = THREADS[0]!;
        for (let index = 0; index < count; index += 1) {
          const result = await world.send(thread, index % 2);
          expect("id" in result).toBe(true);
          await world.tick(2 * MINUTE);
        }
        const protection = world.service.agentFollowUpProtection(thread);
        expect(protection.firedInWindow).toBe(0);
        expect(protection.suspendedAt).toBeUndefined();
        expect(world.service.countActiveAgentFollowUps(thread)).toBe(0);
        expect(world.deliveries).toHaveLength(count);
      });
    }), { numRuns: 20 });
  });

  it("counts a cancelled notice against the daily bound, so cancel and resend cannot spend more", async () => {
    await withWorld(async (world) => {
      world.limits = { maxPerThreadPerDay: 2, maxPerProfilePerDay: 0, maxScheduledPerThread: 0 };
      const thread = THREADS[0]!;
      for (let index = 0; index < 2; index += 1) {
        const created = await world.send(thread, 30);
        if (!("id" in created)) throw new Error(created.refused);
        expect((await world.callTool(thread, { action: "cancel", notificationId: created.id })).ok).toBe(true);
      }
      const third = await world.send(thread, 30);
      expect(third).toMatchObject({ refused: expect.stringContaining("bound is 2") });
      await world.tick(AGENT_NOTIFICATION_WINDOW_MS);
      expect("id" in await world.send(thread, 0)).toBe(true);
    });
  });

  it("refuses edits and creates from operator surfaces", async () => {
    await withWorld(async (world) => {
      await expect(world.service.create({
        backend: "codex", threadId: "thread-notice-a", kind: "notification", scheduledFor: world.clock, displayText: "x",
      })).rejects.toThrow("notify_operator");
      const created = await world.send(THREADS[0]!, 30);
      if (!("id" in created)) throw new Error(created.refused);
      await expect(world.service.update({ id: created.id, scheduledFor: world.clock })).rejects.toThrow("cannot be edited");
    });
  });

  it("keeps notices out of schedule_follow_up's cancel", async () => {
    await withWorld(async (world) => {
      const created = await world.send(THREADS[0]!, 30);
      if (!("id" in created)) throw new Error(created.refused);
      await expect(world.service.cancelAgentFollowUp(THREADS[0]!, created.id)).rejects.toThrow("notify_operator");
      expect(world.store.get(created.id)?.status).toBe("scheduled");
    });
  });

  it("lists waiting notices before delivered ones, so a full list keeps what can be cancelled", async () => {
    await withWorld(async (world) => {
      world.limits = { maxPerThreadPerDay: 0, maxPerProfilePerDay: 0, maxScheduledPerThread: 0 };
      const waiting = await world.send(THREADS[0]!, 600);
      if (!("id" in waiting)) throw new Error(waiting.refused);
      for (let index = 0; index < 5; index += 1) {
        await world.send(THREADS[1]!, 0);
        await world.tick(MINUTE);
      }
      const listed = world.store.listAgentNotifications({ deliveredSince: 0, limit: 3 });
      expect(listed[0]).toMatchObject({ id: waiting.id, status: "scheduled" });
      expect(listed.slice(1).every((action) => action.status === "started")).toBe(true);
    });
  });

  it("refuses an agent's cancel of another thread's notice", async () => {
    await withWorld(async (world) => {
      const created = await world.send(THREADS[0]!, 30);
      if (!("id" in created)) throw new Error(created.refused);
      const response = await world.callTool(THREADS[1]!, { action: "cancel", notificationId: created.id });
      expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(world.store.get(created.id)?.status).toBe("scheduled");
    });
  });
});

describe("notify_operator arguments", () => {
  const now = 1_800_000_000_000;
  const base = { action: "send" as const, title: "Render finished", body: "The walkthrough render is done." };

  it("reads send now, a delay and an offset time", () => {
    expect(readNotificationArgs(base, now)).toMatchObject({ scheduledFor: now, notification: { urgency: "normal" } });
    expect(readNotificationArgs({ ...base, delayMinutes: 60 }, now)).toMatchObject({ scheduledFor: now + 60 * MINUTE });
    expect(readNotificationArgs({ ...base, at: "2027-01-15T09:00:00-05:00" }, now))
      .toMatchObject({ scheduledFor: Date.parse("2027-01-15T14:00:00Z") });
  });

  it("refuses a time without an offset, both times, and bad links", () => {
    expect(readNotificationArgs({ ...base, at: "2027-01-15T09:00:00" }, now)).toContain("offset");
    expect(readNotificationArgs({ ...base, at: "2027-01-15T09:00:00Z", delayMinutes: 5 }, now)).toContain("not both");
    expect(readNotificationArgs({ ...base, url: "javascript:alert(1)" }, now)).toContain("http");
    expect(readNotificationArgs({ ...base, url: "https://user:pw@example.com/" }, now)).toContain("credentials");
    expect(readNotificationArgs({ ...base, filePath: "relative/file.md" }, now)).toContain("absolute");
    expect(readNotificationArgs({ ...base, filePath: path.resolve("/work/atlas/build.bin") }, now)).toContain("preview");
    expect(readNotificationArgs({ ...base, url: "https://a.example", filePath: "/tmp/a" }, now)).toContain("not both");
    expect(readNotificationArgs({ ...base, title: "" }, now)).toContain("title");
    expect(readNotificationArgs({ ...base, body: "x".repeat(601) }, now)).toContain("600");
  });

  it("keeps an https link and an absolute file", () => {
    expect(readNotificationArgs({ ...base, url: "https://ci.example/runs/1" }, now))
      .toMatchObject({ notification: { link: { kind: "url", url: "https://ci.example/runs/1" } } });
    // An absolute path on this platform, kept in its normal form.
    const file = path.resolve("/work/atlas/notes.md");
    expect(readNotificationArgs({ ...base, filePath: file, urgency: "high" }, now))
      .toMatchObject({ notification: { urgency: "high", link: { kind: "file", path: path.normalize(file) } } });
  });
});

describe("agent notification center", () => {
  function centerWorld() {
    const native: Array<{ key: string; enabled: boolean }> = [];
    const cleared: string[] = [];
    const published: string[] = [];
    let notices: ScheduledThreadAction[] = [];
    const center = new AgentNotificationCenter({
      now: () => 1_800_000_000_000,
      listNotices: () => notices,
      nativeNotificationsEnabled: () => true,
      notifyNative: (params) => native.push({ key: params.key, enabled: params.enabled }),
      clearNative: (key) => cleared.push(key),
      showThread: () => undefined,
      threadLabel: async () => "Release notes draft",
      publishChanged: (thread) => { published.push(thread.threadId); },
    });
    const notice = (id: string, status: ScheduledThreadAction["status"] = "dispatching"): ScheduledThreadAction => ({
      id, backend: "codex", threadId: "thread-a", kind: "notification", origin: "agent", status,
      scheduledFor: 1_800_000_000_000, displayText: "t", createdAt: 1, updatedAt: 1_800_000_000_000,
      notification: { title: "Render finished", body: "Done.", urgency: "normal" },
    });
    return { center, native, cleared, published, notice, setNotices: (next: ScheduledThreadAction[]) => { notices = next; } };
  }

  it("shows a notice once, lists it once, and dismissal clears its native key", async () => {
    const world = centerWorld();
    const action = world.notice("n1");
    world.setNotices([action]);
    await world.center.deliver(action);
    await world.center.deliver(action);
    expect(world.native).toEqual([{ key: "agent-notification:n1", enabled: true }]);
    expect(world.center.snapshot()).toMatchObject({ unread: [{ id: "n1" }], scheduled: [], earlier: [] });
    expect(await world.center.dismiss("n1")).toBe(true);
    expect(world.cleared).toEqual(["agent-notification:n1"]);
    world.setNotices([world.notice("n1", "started")]);
    expect(world.center.snapshot()).toMatchObject({ unread: [], earlier: [{ id: "n1" }] });
    expect(await world.center.dismiss("n1")).toBe(false);
  });

  it("dismisses all at once and lists waiting notices soonest first", async () => {
    const world = centerWorld();
    await world.center.deliver(world.notice("n1"));
    await world.center.deliver(world.notice("n2"));
    expect(world.center.snapshot().unread.map((item) => item.id)).toEqual(["n2", "n1"]);
    expect(await world.center.dismissAll()).toBe(2);
    world.setNotices([
      { ...world.notice("later", "scheduled"), scheduledFor: 3 },
      { ...world.notice("sooner", "scheduled"), scheduledFor: 2 },
    ]);
    expect(world.center.snapshot()).toMatchObject({ unread: [], scheduled: [{ id: "sooner" }, { id: "later" }] });
  });
});

// ---------------------------------------------------------------------------
// Write budgets. A notice is three boundary transitions; dismissing one is
// process memory and writes nothing.
// ---------------------------------------------------------------------------

describe("agent notice write budgets", () => {
  async function measured(
    feature: (world: NoticeWorld) => Promise<void>,
    budget: { scenario: string; note: string },
  ): Promise<void> {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-agent-notice-budget-");
    const db = StateDb.open(temp.dbPath);
    const world = new NoticeWorld(db);
    try {
      await world.start();
      const { writes } = await measureSqliteWrites(() => feature(world));
      expectSqliteWriteBudget({ ...budget, writes });
    } finally {
      world.dispose();
      db.close();
      removeTempStateDbDir(temp.tempDir);
    }
  }

  it("holds ten notices sent now to their budget", async () => {
    await measured(async (world) => {
      world.limits = { maxPerThreadPerDay: 0, maxPerProfilePerDay: 0, maxScheduledPerThread: 0 };
      for (let index = 0; index < 10; index += 1) {
        const created = await world.send(THREADS[0]!, 0);
        if (!("id" in created)) throw new Error(created.refused);
        expect(world.store.get(created.id)).toMatchObject({ status: "started" });
      }
    }, {
      scenario: "agent-notice-ten-sent-now",
      note: "ten notify_operator notices sent now: three commits each (create, with its bound counts read in the same "
        + "transaction; claim; delivered). No follow-up guard write. Dismissing is process memory. Measured about "
        + "62 KB of WAL per notice: 3.7 MB/day at the default bound of 60 a profile a day, about 0.3 MB/day at five.",
    });
  });

  it("holds a scheduled notice delivered later to its budget", async () => {
    await measured(async (world) => {
      const created = await world.send(THREADS[0]!, 60);
      if (!("id" in created)) throw new Error(created.refused);
      await world.tick(61 * MINUTE);
      expect(world.store.get(created.id)).toMatchObject({ status: "started" });
    }, {
      scenario: "agent-notice-scheduled-delivered",
      note: "one notice scheduled an hour ahead and delivered when due: create, claim, delivered. The waiting hour writes nothing.",
    });
  });

  it("holds a scheduled notice cancelled before it is due to its budget", async () => {
    await measured(async (world) => {
      const created = await world.send(THREADS[0]!, 60);
      if (!("id" in created)) throw new Error(created.refused);
      expect((await world.callTool(THREADS[0]!, { action: "cancel", notificationId: created.id })).ok).toBe(true);
    }, {
      scenario: "agent-notice-cancel",
      note: "one notice scheduled and cancelled before it is due: create and cancel, two commits.",
    });
  });
});
