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
function launch(store: ResearchStore, shared: World, overrides: Partial<ResearchPorts> = {}): ResearchService {
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
  service.initialize();
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
