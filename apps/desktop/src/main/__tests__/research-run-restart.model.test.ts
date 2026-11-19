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

const coordinator: ResearchThread = { backend: "codex", threadId: "coordinator" };
const operator = { ...coordinator, kind: "operator" } as const;
const agent = { ...coordinator, kind: "agent", turnId: "coordinator-turn", callId: "start" } as const;
const workerThread = (index: number): ResearchThread => ({ backend: "codex", threadId: `worker-${index}` });
const request = (workers: number, minutes?: number): StartResearchRequest => ({ objective: "Invented objective", workspaceMode: "none", ...(minutes === undefined ? {} : { minutes }),
  approaches: Array.from({ length: workers }, (_, index) => ({ title: `Approach ${index + 1}`, task: "Invented task" })) });

/** Everything the processes of one test share: the clock, the timers armed, and the model work each started. */
type World = { now: number; generation: number; spawned: number; notified: ResearchThread[]; timers: Array<{ at: number; fire: () => void; live: boolean }>; errors: unknown[] };
const world = (): World => ({ now: 1_000_000, generation: 0, spawned: 0, notified: [], timers: [], errors: [] });

/** One PwrAgent process. Only the current generation is alive; every earlier one has quit or crashed. */
function launch(store: ResearchStore, shared: World): ResearchService {
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
    stop: async () => {},
    // The message is queued in the worker's thread; its turn is seen to start later.
    notify: async (_actor, target) => { shared.notified.push(target); return {}; },
    cancelQueued: async () => ({}), changed: () => {}, onError: (error) => { shared.errors.push(error); },
  };
  const service = new ResearchService(store, ports);
  service.initialize();
  return service;
}

/** Fire the timers that have come due, as the event loop would. */
async function advance(shared: World, to: number): Promise<void> {
  shared.now = to;
  // A long wait is taken in steps, so firing one timer can arm another that is already due.
  for (let due = shared.timers.filter((timer) => timer.live && timer.at <= to); due.length; due = shared.timers.filter((timer) => timer.live && timer.at <= to)) {
    for (const timer of due) { timer.live = false; timer.fire(); }
  }
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

type WorkerState = "running" | "cut-off" | "resuming" | "ended";
type Step = { kind: "quit" | "crash" | "resume" } | { kind: "turn" | "end" | "finding"; worker: number };
const stepArb = (workers: number): fc.Arbitrary<Step> => fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom<Step>({ kind: "quit" }, { kind: "crash" }) },
  { weight: 3, arbitrary: fc.constant<Step>({ kind: "resume" }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constantFrom("turn" as const, "end" as const, "finding" as const), worker: fc.integer({ min: 1, max: workers }) }) },
);

/**
 * A run belongs to its operator, not to a process. Quitting or crashing ends
 * the turns that were in flight and nothing else: the run stays running, the
 * next process holds it, every finding is kept, and no model work starts until
 * the operator resumes a worker or a worker's turn is seen to start.
 */
it("keeps a run running and resumable across any sequence of quits, crashes and resumes", async () => {
  const db = openInMemoryStateDb();
  try {
    const scenario = fc.integer({ min: 1, max: 5 }).chain((workers) => fc.record({ workers: fc.constant(workers), steps: fc.array(stepArb(workers), { maxLength: 24 }) }));
    await fc.assert(fc.asyncProperty(scenario, async ({ workers, steps }) => {
      db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
      const store = new ResearchStore(db);
      const shared = world();
      let service = launch(store, shared);
      const id = (await service.start(request(workers), agent)).id;
      const model = { states: Array.from({ length: workers }, (): WorkerState => "running"), turns: Array.from({ length: workers }, () => 0), findings: 0, notified: 0, exhausted: false };
      const turnId = (worker: number) => `turn-${worker}-${model.turns[worker - 1]}`;

      const check = () => {
        const run = service.read(id, operator);
        expect(run.status).toBe(model.exhausted ? "exhausted" : "running");
        expect(run.approaches.map((approach): WorkerState => approach.interrupted ? "cut-off" : approach.state === "starting" ? "resuming" : approach.state === "stopped" ? "cut-off" : approach.state as WorkerState)).toEqual(model.states);
        // A cut-off worker says so, and only a cut-off worker does.
        expect(run.approaches.map((approach) => Boolean(approach.interrupted))).toEqual(model.states.map((state) => state === "cut-off"));
        expect(run.activeWorkers).toBe(model.states.filter((state) => state === "running" || state === "resuming").length);
        expect(run.findings).toHaveLength(model.findings);
        // The start dispatched each worker once. Nothing since has, except a resume the operator asked for.
        expect(shared.spawned).toBe(workers);
        expect(shared.notified).toHaveLength(model.notified);
        expect(shared.errors).toEqual([]);
        if (!model.exhausted) {
          expect(run.ownerId).toBe(`process-${shared.generation}`);
          expect(service.snapshot(coordinator).writableRunIds).toEqual([id]);
        }
      };
      check();

      for (const step of steps) {
        const worker = "worker" in step ? step.worker : 0;
        const index = worker - 1;
        if (step.kind === "quit" || step.kind === "crash") {
          if (step.kind === "quit") service.close();
          service = launch(store, shared);
          if (!model.exhausted) model.states = model.states.map((state) => state === "ended" ? "ended" : "cut-off");
        } else if (step.kind === "resume") {
          const waiting = model.states.filter((state) => state === "cut-off").length;
          const resumed = service.update(id, `resume:${shared.notified.length}:${model.findings}:${shared.generation}:${model.turns.join(".")}`, { action: "resume" }, operator);
          if (model.exhausted || !waiting) await expect(resumed).rejects.toThrow();
          else {
            await resumed;
            model.states = model.states.map((state) => state === "cut-off" ? "resuming" : state);
            model.notified += waiting;
          }
        } else if (step.kind === "turn") {
          // A turn starts in the worker's thread: the resumed one, or one the operator started by typing there.
          model.turns[index]!++;
          await service.observeStart(workerThread(worker), turnId(worker));
          if (!model.exhausted) model.states[index] = "running";
        } else if (step.kind === "end") {
          // A worker being resumed has no turn yet, so there is none to end.
          if (model.states[index] === "resuming") continue;
          service.observeEnd(workerThread(worker), turnId(worker));
          if (!model.exhausted && model.states[index] === "running") {
            model.states[index] = "ended";
            // Only a run whose every worker ended is exhausted. One still waiting to be resumed has not ended.
            if (model.states.every((state) => state === "ended")) model.exhausted = true;
          }
        } else {
          // Only a worker with a turn under way can post.
          if (model.states[index] !== "running" && !model.exhausted) continue;
          const posted = service.update(id, `finding:${model.findings}:${shared.generation}`, { action: "finding", approachId: `a${worker}`, kind: "note", text: "Invented finding", paths: [] },
            { ...workerThread(worker), kind: "agent", turnId: turnId(worker), callId: `call-${model.findings}` });
          if (model.exhausted) await expect(posted).rejects.toThrow();
          else { await posted; model.findings++; }
        }
        check();
      }
      service.close();
    }), { numRuns: 150 });
  } finally { db.close(); }
});

/**
 * A time limit is the operator's bound on the run, so it counts on the wall
 * clock whether or not PwrAgent is open. A run with no limit has no timer to
 * re-arm and never ends by time.
 */
it("ends a run at its time limit across a restart, and never one with no limit", async () => {
  const db = openInMemoryStateDb();
  try {
    const scenario = fc.record({ minutes: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }), before: fc.integer({ min: 0, max: 100_000 }), closed: fc.integer({ min: 0, max: 100_000 }), crash: fc.boolean() });
    await fc.assert(fc.asyncProperty(scenario, async ({ minutes, before, closed, crash }) => {
      db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
      const store = new ResearchStore(db);
      const shared = world();
      const started = shared.now;
      let service = launch(store, shared);
      const id = (await service.start(request(2, minutes), agent)).id;
      const deadline = minutes === undefined ? undefined : started + minutes * 60_000;
      const expected = () => deadline !== undefined && shared.now >= deadline ? "deadline" : "running";

      await advance(shared, started + before * 60_000);
      expect(store.header(id)!.status).toBe(expected());
      // The process ends. Its timers end with it.
      if (!crash) service.close();
      for (const timer of shared.timers) timer.live = false;
      shared.now += closed * 60_000;
      service = launch(store, shared);
      await advance(shared, shared.now);
      expect(store.header(id)!.status).toBe(expected());
      // Whatever time remains is still counted from the start, by this process.
      if (deadline !== undefined) {
        await advance(shared, Math.max(shared.now, deadline - 1));
        expect(store.header(id)!.status).toBe(expected());
        await advance(shared, Math.max(shared.now, deadline));
        expect(store.header(id)!.status).toBe("deadline");
      } else expect(shared.timers.filter((timer) => timer.live)).toEqual([]);
      expect(shared.errors).toEqual([]);
      service.close();
    }), { numRuns: 80 });
  } finally { db.close(); }
});

it("budgets resuming a run's cut-off workers", async () => {
  // File-backed, so the recorded WAL size is what each commit costs on disk.
  const fixture = createTempStateDb("pwragent-research-restart-");
  const db = StateDb.open(fixture.dbPath);
  try {
    const store = new ResearchStore(db);
    const shared = world();
    const first = launch(store, shared);
    const id = (await first.start(request(8), agent)).id;
    first.close();

    // Taking the run over at launch is budgeted as "research-recovery", beside the other owner writes.
    const service = launch(store, shared);
    expect(store.header(id)).toMatchObject({ status: "running", ownerId: "process-2", activeWorkers: 0 });

    const resumed = await measureSqliteWrites(async () => await service.update(id, "request:resume", { action: "resume" }, operator));
    expect(resumed.result.activeWorkers).toBe(8);
    expect(shared.notified).toHaveLength(8);
    expectSqliteWriteBudget({ scenario: "research-resume-workers", note: "One operator resume of eight cut-off workers: one commit gives each its slot back. Each worker's turn start is the existing per-turn observation.", writes: resumed.writes });
    service.close();
  } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
});
