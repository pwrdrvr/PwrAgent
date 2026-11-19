import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import type { ResearchRun, ResearchThread, StartResearchRequest } from "@pwragent/shared";
import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

beforeEach(() => { vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1"); resetSqliteWriteMetrics(); });
afterEach(() => vi.unstubAllEnvs());

const MINUTE = 60_000;
const coordinator: ResearchThread = { backend: "codex", threadId: "coordinator" };
const operator = { ...coordinator, kind: "operator" } as const;
const agent = { ...coordinator, kind: "agent", turnId: "coordinator-turn", callId: "start" } as const;
const workerThread = (index: number): ResearchThread => ({ backend: "codex", threadId: `worker-${index}` });
const request = (workers: number, bounds: Pick<StartResearchRequest, "minutes" | "turnMinutes" | "totalWorkerMinutes"> = {}): StartResearchRequest => ({ objective: "Invented objective", workspaceMode: "none", ...bounds,
  approaches: Array.from({ length: workers }, (_, index) => ({ title: `Approach ${index + 1}`, task: "Invented task" })) });

type World = { now: number; generation: number; spawned: number; stopped: string[]; timers: Array<{ at: number; fire: () => void; live: boolean }>; errors: unknown[] };
const world = (): World => ({ now: 1_000_000, generation: 0, spawned: 0, stopped: [], timers: [], errors: [] });

/** One PwrAgent process. Only the current generation is alive; every earlier one has quit or crashed. */
function launch(store: ResearchStore, shared: World, overrides: Partial<ResearchPorts> = {}, options: { initialize?: boolean } = {}): ResearchService {
  const generation = ++shared.generation;
  const ports: ResearchPorts = {
    ownerId: `process-${generation}`, ownerPid: 100 + generation, ownerStartedAt: shared.now,
    isOwnerAlive: (owner: Pick<ResearchRun, "ownerId">) => owner.ownerId === `process-${shared.generation}`,
    now: () => shared.now,
    schedule: (fire, delay) => { const timer = { at: shared.now + delay, fire, live: true }; shared.timers.push(timer); return () => { timer.live = false; }; },
    spawn: async (_context, _task, _title, _mode, created) => {
      const worker = { ...workerThread(++shared.spawned), turnId: `turn-${shared.spawned}-0` };
      created(worker);
      return worker;
    },
    stop: async (worker) => { shared.stopped.push(`${worker.threadId}:${worker.turnId}`); },
    // The resume message is queued in the worker's thread; its turn is seen to start later.
    notify: async () => ({}),
    cancelQueued: async () => ({}), changed: () => {}, onError: (error) => { shared.errors.push(error); },
    ...overrides,
  };
  const service = new ResearchService(store, ports);
  if (options.initialize !== false) service.initialize();
  return service;
}

/** Fire the timers that have come due, in due order, as the event loop would. */
async function advance(shared: World, to: number): Promise<void> {
  for (;;) {
    const due = shared.timers.filter((timer) => timer.live && timer.at <= to).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.live = false;
    shared.now = Math.max(shared.now, due.at);
    due.fire();
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  }
  shared.now = to;
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** The process ends: its timers end with it. */
function end(service: ResearchService, shared: World, crash: boolean): void {
  if (!crash) service.close();
  for (const timer of shared.timers) timer.live = false;
}

function reset(db: StateDb): ResearchStore {
  db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
  return new ResearchStore(db);
}

/**
 * A per-worker limit counts a turn on the wall clock. PwrAgent cannot see when
 * a turn ended while it was closed, so a turn cut off by a quit or crash counts
 * until the next launch takes the run over. A resumed worker continues that same
 * turn, so the time before the restart counts toward its limit. A worker past its
 * limit at launch is stopped for that reason, not offered for resume.
 */
it("counts a worker's turn across a restart toward its per-worker limit", async () => {
  const db = openInMemoryStateDb();
  try {
    const scenario = fc.record({ limit: fc.integer({ min: 10, max: 600 }), before: fc.integer({ min: 0, max: 700 }), closed: fc.integer({ min: 0, max: 700 }),
      wait: fc.integer({ min: 0, max: 300 }), crash: fc.boolean() });
    await fc.assert(fc.asyncProperty(scenario, async ({ limit, before, closed, wait, crash }) => {
      const store = reset(db);
      const shared = world();
      const started = shared.now;
      let service = launch(store, shared);
      const id = (await service.start(request(1, { turnMinutes: limit }), agent)).id;
      await service.update(id, "candidate", { action: "submit", approachId: "a1", text: "Invented candidate", paths: [] }, agent);
      const state = () => { const approach = service.read(id, operator).approaches[0]!; return { state: approach.state, interrupted: Boolean(approach.interrupted), limited: /per-worker time limit/.test(approach.note ?? "") }; };

      await advance(shared, started + before * MINUTE);
      if (before >= limit) {
        // The limit passed while PwrAgent was open.
        expect(state()).toEqual({ state: "stopped", interrupted: false, limited: true });
        expect(shared.stopped).toEqual(["worker-1:turn-1-0"]);
        return;
      }
      expect(state()).toEqual({ state: "running", interrupted: false, limited: false });
      end(service, shared, crash);
      shared.now += closed * MINUTE;
      service = launch(store, shared);
      await advance(shared, shared.now);
      const counted = before + closed;
      if (counted >= limit) {
        expect(state()).toEqual({ state: "stopped", interrupted: false, limited: true });
        await expect(service.update(id, "resume", { action: "resume" }, operator)).rejects.toThrow("No worker is waiting to be resumed");
      } else {
        expect(state()).toEqual({ state: "stopped", interrupted: true, limited: false });
        await service.update(id, "resume", { action: "resume" }, operator);
        await advance(shared, shared.now + wait * MINUTE);
        // Waiting for the resumed turn to start adds nothing: no turn is running.
        await service.observeStart(workerThread(1), "resumed-turn");
        const resumedAt = shared.now;
        const stopAt = resumedAt + (limit - counted) * MINUTE;
        await advance(shared, stopAt - 1);
        expect(state()).toEqual({ state: "running", interrupted: false, limited: false });
        await advance(shared, stopAt);
        expect(state()).toEqual({ state: "stopped", interrupted: false, limited: true });
        expect(shared.stopped).toEqual(["worker-1:resumed-turn"]);
      }
      // The run goes on: a per-worker limit never ends it.
      expect(store.header(id)!.status).toBe("running");
      expect(shared.errors).toEqual([]);
      service.close();
    }), { numRuns: 80 });
  } finally { db.close(); }
});

/**
 * Total worker time counts every turn up to the moment PwrAgent sees it end,
 * which for a turn cut off by a restart is the takeover at the next launch.
 * A total reached while PwrAgent was closed ends the run at launch.
 */
it("ends a run at its total worker time across a restart", async () => {
  const db = openInMemoryStateDb();
  try {
    const scenario = fc.record({ total: fc.integer({ min: 10, max: 1200 }), before: fc.integer({ min: 0, max: 400 }), closed: fc.integer({ min: 0, max: 400 }), crash: fc.boolean() });
    await fc.assert(fc.asyncProperty(scenario, async ({ total, before, closed, crash }) => {
      const store = reset(db);
      const shared = world();
      const started = shared.now;
      let service = launch(store, shared);
      const id = (await service.start(request(2, { totalWorkerMinutes: total }), agent)).id;
      await service.update(id, "candidate", { action: "submit", approachId: "a1", text: "Invented candidate", paths: [] }, agent);
      // Two workers running together use time twice as fast as the clock.
      const reachedAt = started + Math.ceil(total * MINUTE / 2);
      await advance(shared, started + before * MINUTE);
      if (started + before * MINUTE >= reachedAt) {
        expect(store.header(id)!.status).toBe("deadline");
        return;
      }
      end(service, shared, crash);
      shared.now += closed * MINUTE;
      service = launch(store, shared);
      await advance(shared, shared.now);
      const counted = 2 * (before + closed) * MINUTE;
      expect(store.header(id)!.status).toBe(counted >= total * MINUTE ? "deadline" : "running");
      if (counted < total * MINUTE) {
        // Nothing runs until the operator resumes the workers, so the run waits indefinitely.
        await advance(shared, shared.now + 10_000 * MINUTE);
        expect(store.header(id)!.status).toBe("running");
        await service.update(id, "resume", { action: "resume" }, operator);
        await service.observeStart(workerThread(1), "resumed-1");
        const resumedAt = shared.now;
        const left = total * MINUTE - counted;
        await advance(shared, resumedAt + left - 1);
        expect(store.header(id)!.status).toBe("running");
        await advance(shared, resumedAt + left);
        expect(store.header(id)!.status).toBe("deadline");
      }
      expect(shared.errors).toEqual([]);
      service.close();
    }), { numRuns: 80 });
  } finally { db.close(); }
});

/**
 * A process that takes a run over to answer a command answers it on the run as it now stands. Taking it over
 * can end the run: when every cut-off worker is past its limit and nothing was submitted, the run is exhausted.
 * The command then saw the header from before that, and recorded at a revision that no longer existed.
 */
it("answers a command that takes a run over on the run as the takeover left it", async () => {
  const db = openInMemoryStateDb();
  try {
    const scenario = fc.record({ limit: fc.integer({ min: 1, max: 120 }), over: fc.integer({ min: 0, max: 600 }), command: fc.constantFrom("stop" as const, "finding" as const, "bounds" as const) });
    await fc.assert(fc.asyncProperty(scenario, async ({ limit, over, command }) => {
      const store = reset(db);
      const shared = world();
      const first = launch(store, shared);
      const id = (await first.start(request(1, { turnMinutes: limit }), agent)).id;
      first.close();
      for (const timer of shared.timers) timer.live = false;
      shared.now += (limit + over) * MINUTE;
      // A second process that has not launched its startup recovery: the command itself takes the run over.
      const service = launch(store, shared, {}, { initialize: false });
      const attempt = command === "stop" ? service.update(id, "stop", { action: "stop", reason: "Stopped by the operator" }, operator)
        : command === "bounds" ? service.update(id, "bounds", { action: "bounds", workers: 2 }, operator)
          : service.update(id, "finding", { action: "finding", approachId: "a1", kind: "note", text: "Invented finding", paths: [] }, agent);
      const outcome = await attempt.then(() => "ok", (error: unknown) => error instanceof Error ? error.message : String(error));
      expect(outcome).not.toMatch(/Research run changed/);
      // The worker was past its limit, so the takeover stopped it, and with nothing submitted the run is exhausted.
      expect(store.header(id)!.status).toBe("exhausted");
      expect(store.readItem(id, "a1")).toMatchObject({ record: { state: "stopped", note: expect.stringMatching(/per-worker time limit/) } });
      expect(shared.errors).toEqual([]);
      service.close();
    }), { numRuns: 30 });
  } finally { db.close(); }
});

/**
 * A worker whose turn has reached the per-worker limit never starts another model turn of that turn. When the
 * operator lowers the limit while a cut-off worker's resume message waits in its queue, or is still being sent,
 * that message is withdrawn and the worker is recorded stopped at its limit. If the message had already started
 * a turn, that turn is stopped. A worker still under the new limit keeps its resume. When the queue cannot
 * confirm the withdrawal, the worker is unaccounted for, not stopped: recording it stopped would let a late turn
 * start with a fresh clock. If that turn does start, the limit stops it at once.
 */
it("withdraws a resume the lowered per-worker limit has already passed, and keeps the rest", async () => {
  const db = openInMemoryStateDb();
  try {
    const scenario = fc.integer({ min: 1, max: 3 }).chain((workers) => fc.record({
      // When each worker's current turn began, in minutes after the run started: a turn that ended and another that began.
      restarts: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: workers, maxLength: workers }),
      quitAt: fc.integer({ min: 101, max: 200 }), closed: fc.integer({ min: 0, max: 200 }), limit: fc.integer({ min: 1, max: 500 }),
      // The limit is lowered while the resume message waits in the queue, or while it is still being sent.
      inFlight: fc.boolean(),
      // Withdrawing a queued message succeeds, finds it already started a turn, or cannot be confirmed.
      cancel: fc.constantFrom("plain" as const, "started" as const, "error" as const),
    }));
    await fc.assert(fc.asyncProperty(scenario, async ({ restarts, quitAt, closed, limit, inFlight, cancel }) => {
      const store = reset(db);
      const shared = world();
      const started = shared.now;
      let service = launch(store, shared);
      const id = (await service.start(request(restarts.length, { turnMinutes: 10_000 }), agent)).id;
      await service.update(id, "candidate", { action: "submit", approachId: "a1", text: "Invented candidate", paths: [] }, agent);
      // Each worker's turn ends and a new one begins at its own time, so the workers carry different turn times.
      for (const [index, at] of restarts.map((minutes, index) => [index, minutes] as const).sort((a, b) => a[1] - b[1])) {
        await advance(shared, started + at * MINUTE);
        service.observeEnd(workerThread(index + 1), `turn-${index + 1}-0`);
        await service.observeStart(workerThread(index + 1), `second-${index + 1}`);
      }
      await advance(shared, started + quitAt * MINUTE);
      end(service, shared, false);
      shared.now += closed * MINUTE;

      const cancelled: string[] = [];
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      service = launch(store, shared, {
        notify: async (_actor, target) => { if (inFlight) await gate; return { queueEntryId: `queue-${target.threadId}` }; },
        cancelQueued: async (entry) => {
          cancelled.push(entry);
          if (cancel === "error") throw new Error("The queue did not answer");
          return cancel === "started" ? { turnId: `late-${entry}` } : {};
        },
      });
      await advance(shared, shared.now);
      const resuming = service.update(id, "resume", { action: "resume" }, operator);
      if (!inFlight) await resuming;
      else await new Promise((resolve) => setImmediate(resolve));
      await service.update(id, "lower", { action: "bounds", turnMinutes: limit }, operator);
      release!();
      await resuming;
      await advance(shared, shared.now);

      // Each worker's turn ran from its restart until the takeover, which ended it.
      const counted = restarts.map((at) => quitAt - at + closed);
      const past = counted.map((minutes) => minutes >= limit);
      const approaches = service.read(id, operator).approaches;
      expect(cancelled.sort()).toEqual(restarts.flatMap((_, index) => past[index] ? [`queue-worker-${index + 1}`] : []).sort());
      for (const [index, approach] of approaches.entries()) {
        if (!past[index]) expect(approach.state).toBe("starting");
        else if (cancel === "error") expect({ state: approach.state, interrupted: Boolean(approach.interrupted) }).toEqual({ state: "unknown", interrupted: false });
        else {
          expect({ state: approach.state, interrupted: Boolean(approach.interrupted) }).toEqual({ state: "stopped", interrupted: false });
          expect(approach.note).toMatch(/per-worker time limit/);
        }
      }
      // A message that had started a turn is stopped; nothing else is.
      expect(shared.stopped.sort()).toEqual(cancel === "started" ? restarts.flatMap((_, index) => past[index] ? [`worker-${index + 1}:late-queue-worker-${index + 1}`] : []).sort() : []);
      // No withdrawn worker is offered for resume again.
      if (past.every(Boolean)) await expect(service.update(id, "resume-again", { action: "resume" }, operator)).rejects.toThrow("No worker is waiting to be resumed");
      if (cancel === "error") {
        // An unconfirmed message that starts a turn after all is stopped at once, still at its limit.
        for (const [index] of restarts.entries()) if (past[index]) await service.observeStart(workerThread(index + 1), `unconfirmed-${index + 1}`);
        await advance(shared, shared.now);
        for (const [index, approach] of service.read(id, operator).approaches.entries()) {
          if (past[index]) expect({ state: approach.state, limited: /per-worker time limit/.test(approach.note ?? "") }).toEqual({ state: "stopped", limited: true });
        }
        expect(shared.stopped.sort()).toEqual(restarts.flatMap((_, index) => past[index] ? [`worker-${index + 1}:unconfirmed-${index + 1}`] : []).sort());
      }
      expect(shared.errors).toEqual([]);
      service.close();
    }), { numRuns: 60 });
  } finally { db.close(); }
});

it("budgets lowering the per-worker limit past a worker whose resume is queued", async () => {
  // File-backed, so the recorded WAL size is what each commit costs on disk.
  const fixture = createTempStateDb("pwragent-research-withdraw-");
  const db = StateDb.open(fixture.dbPath);
  try {
    const store = new ResearchStore(db);
    const shared = world();
    const first = launch(store, shared);
    const id = (await first.start(request(2, { turnMinutes: 600 }), agent)).id;
    await first.update(id, "candidate", { action: "submit", approachId: "a1", text: "Invented candidate", paths: [] }, agent);
    await advance(shared, shared.now + 90 * MINUTE);
    end(first, shared, false);
    const service = launch(store, shared, { notify: async (_actor, target) => ({ queueEntryId: `queue-${target.threadId}` }) });
    await service.update(id, "resume", { action: "resume" }, operator);

    const lowered = await measureSqliteWrites(async () => await service.update(id, "operator:lower", { action: "bounds", turnMinutes: 60 }, operator));
    expect(store.readItem(id, "a1")).toMatchObject({ record: { state: "stopped", note: expect.stringMatching(/per-worker time limit/) } });
    expectSqliteWriteBudget({ scenario: "research-bounds-withdraw-resumes", note: "One operator change lowers the per-worker limit past two workers whose resume messages are queued: one commit records the bounds, then one per worker records its message withdrawn and why it stopped.", writes: lowered.writes });
    expect(shared.errors).toEqual([]);
    service.close();
  } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
});

it("budgets changing a live run's bounds and stopping a worker at its limit", async () => {
  // File-backed, so the recorded WAL size is what each commit costs on disk.
  const fixture = createTempStateDb("pwragent-research-bounds-");
  const db = StateDb.open(fixture.dbPath);
  try {
    const store = new ResearchStore(db);
    const shared = world();
    const service = launch(store, shared);
    const id = (await service.start(request(8, { minutes: 120 }), agent)).id;

    const changed = await measureSqliteWrites(async () => await service.update(id, "operator:bounds", { action: "bounds", workers: 4, minutes: 240, turnMinutes: 30, totalWorkerMinutes: 600 }, operator));
    expect(changed.result).toMatchObject({ workerLimit: 4, deadlineAt: shared.now + 240 * MINUTE, turnMinutes: 30, totalWorkerMinutes: 600 });
    expectSqliteWriteBudget({ scenario: "research-bounds-change", note: "One operator change of a live run's bounds, all four at once: one commit records the bounds event.", writes: changed.writes });

    // Seven workers end; the eighth runs on until its per-worker limit stops it.
    for (let index = 1; index <= 7; index++) service.observeEnd(workerThread(index), `turn-${index}-0`);
    const stopped = await measureSqliteWrites(async () => await advance(shared, shared.now + 30 * MINUTE));
    expect(store.readItem(id, "a8")).toMatchObject({ record: { state: "stopped", note: expect.stringMatching(/per-worker time limit/) } });
    expectSqliteWriteBudget({ scenario: "research-turn-limit-stop", note: "A worker's per-worker time limit passes: one commit records it stopped and why, then one marks the run exhausted because no worker is left and nothing was submitted.", writes: stopped.writes });
    expect(shared.errors).toEqual([]);
    service.close();
  } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
});
