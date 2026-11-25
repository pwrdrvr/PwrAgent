import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { RESEARCH_MAX_MINUTES, RESEARCH_MAX_TIMER_MS, RESEARCH_MAX_WORKERS, type ResearchCommand, type StartResearchRequest } from "@pwragent/shared/research";
import { ResearchService, type ResearchPorts } from "../research-service";
import { MemoryResearchStorage } from "./fixtures/research-memory-storage";

const context = { kind: "agent", backend: "codex", threadId: "coordinator", turnId: "parent-turn", callId: "start" } as const;
const START = 1_000_000;
const DAY = 86_400_000;

/** A clock and timers the test advances. Timers run in due order, and a timer may arm another. */
function world() {
  let now = START;
  let counter = 0;
  const timers: Array<{ at: number; delay: number; fn: () => void; cancelled: boolean }> = [];
  const delays: number[] = [];
  const ports: ResearchPorts = {
    ownerId: "owner", ownerPid: 1, ownerStartedAt: 500, isOwnerAlive: () => false, now: () => now,
    schedule: (fn, delay) => { delays.push(delay); const timer = { at: now + delay, delay, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    changed: vi.fn(), onError: vi.fn(), stop: vi.fn(async () => {}), notify: vi.fn(async () => ({})), cancelQueued: vi.fn(async () => ({})),
    spawn: vi.fn(async (_context, _task, _title, _mode, created) => { const worker = { backend: "codex" as const, threadId: `worker-${++counter}`, turnId: `turn-${counter}` }; created(worker); return worker; }),
  };
  const service = new ResearchService(new MemoryResearchStorage(), ports);
  const advanceTo = async (target: number) => {
    for (;;) {
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true; now = Math.max(now, due.at); due.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = target;
  };
  return { service, ports, delays, advanceTo };
}
type Bounds = Pick<StartResearchRequest, "turnMinutes" | "totalWorkerMinutes">;
const request = (workers: number, minutes?: number, bounds: Bounds = {}): StartResearchRequest => ({ objective: "Investigate a queue race", workspaceMode: "none", ...(minutes !== undefined ? { minutes } : {}), ...bounds,
  approaches: Array.from({ length: workers }, (_, index) => ({ title: `Approach ${index + 1}`, task: `Trace part ${index + 1}` })) });
const finding = (key: string): ResearchCommand => ({ action: "finding", approachId: "a1", kind: "note", text: `Work ${key}`, paths: [] });
const operator = { backend: "codex", threadId: "coordinator", kind: "operator" } as const;
const MINUTE = 60_000;
const workerThread = (index: number) => ({ backend: "codex" as const, threadId: `worker-${index}` });
/** A candidate keeps the run open after its workers end, so a test sees what ends the run and what does not. */
const candidate = async (service: ResearchService, id: string) => await service.update(id, "candidate", { action: "submit", approachId: "a1", text: "Invented candidate", paths: [] }, context);

/**
 * A run's bounds are the operator's. The owner enforces the worker count and
 * time limit they chose and adds none of its own: any count a person would
 * plausibly ask for, and either no time limit or one of any length.
 */
describe("research run bounds are the operator's", () => {
  it("admits exactly the workers asked for, at any count up to the typo guard", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: RESEARCH_MAX_WORKERS }), async (workers) => {
      const { service, ports } = world();
      const { intentId } = service.prepare({ backend: "codex", threadId: "coordinator", objective: "Investigate a queue race", workers, workspaceMode: "none" });
      const run = await service.start({ ...request(workers), intentId }, context);
      expect(run.workerLimit).toBe(workers);
      expect(run.activeWorkers).toBe(workers);
      expect(ports.spawn).toHaveBeenCalledTimes(workers);
      service.close();
    }), { numRuns: 25, examples: [[9], [12], [RESEARCH_MAX_WORKERS]] });
    const { service } = world();
    for (const workers of [0, RESEARCH_MAX_WORKERS + 1, 2.5]) {
      expect(() => service.prepare({ backend: "codex", threadId: "coordinator", objective: "Investigate", workers, workspaceMode: "none" })).toThrow(`Choose 1–${RESEARCH_MAX_WORKERS} workers`);
    }
    await expect(service.start(request(RESEARCH_MAX_WORKERS + 1), context)).rejects.toThrow(`Research needs 1–${RESEARCH_MAX_WORKERS} workers`);
  });

  it("never ends a run by time when the operator set no limit", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 400 * DAY }), { minLength: 1, maxLength: 5 }), async (waits) => {
      const { service, delays, advanceTo } = world();
      const run = await service.start(request(2), context);
      expect(run.deadlineAt).toBeUndefined();
      // No limit means no deadline timer at all, not a very long one.
      expect(delays).toEqual([]);
      let at = START;
      for (const [index, wait] of waits.entries()) {
        at += wait;
        await advanceTo(at);
        const after = await service.update(run.id, `late-${index}`, finding(String(index)), context);
        expect(after.status).toBe("running");
      }
      service.close();
    }), { numRuns: 25 });
  });

  it("ends a run exactly at the operator's limit, however long, and accepts work until then", async () => {
    const minutes = fc.oneof(fc.integer({ min: 1, max: 600 }), fc.integer({ min: 121, max: 60 * 24 * 90 }), fc.constantFrom(121, 60 * 24 * 30, RESEARCH_MAX_MINUTES));
    await fc.assert(fc.asyncProperty(minutes, fc.double({ min: 0.01, max: 0.99, noNaN: true }), async (limit, fraction) => {
      const { service, delays, advanceTo } = world();
      const run = await service.start(request(1, limit), context);
      const deadline = START + limit * 60_000;
      expect(run.deadlineAt).toBe(deadline);
      // A limit longer than one timer can wait is waited in steps, never passed to a timer whole.
      await advanceTo(START + Math.floor((deadline - START) * fraction));
      expect(Math.max(...delays)).toBeLessThanOrEqual(RESEARCH_MAX_TIMER_MS);
      expect((await service.update(run.id, "before", finding("before"), context)).status).toBe("running");
      await advanceTo(deadline - 1);
      expect(service.snapshot(context).runs[0]!.status).toBe("running");
      await advanceTo(deadline);
      expect(service.snapshot(context).runs[0]!.status).toBe("deadline");
      await expect(service.update(run.id, "after", finding("after"), context)).rejects.toThrow("no longer accepting work");
      service.close();
    }), { numRuns: 25 });
  });

  it("refuses a time limit that is not a whole number of minutes", async () => {
    const { service } = world();
    for (const minutes of [0, -5, 1.5, Number.NaN, RESEARCH_MAX_MINUTES + 1]) {
      await expect(service.start(request(1, minutes), context)).rejects.toThrow("A research time limit is a whole number of minutes");
    }
  });

  it("binds the coordinator to the operator's choice of no limit as strictly as to a number", async () => {
    const { service } = world();
    const unlimited = service.prepare({ backend: "codex", threadId: "coordinator", objective: "Investigate a queue race", workers: 2, workspaceMode: "none" });
    await expect(service.start({ ...request(2, 30), intentId: unlimited.intentId }, context)).rejects.toThrow("exact objective");
    const limited = service.prepare({ backend: "codex", threadId: "coordinator", objective: "Investigate a queue race", workers: 2, minutes: 30, workspaceMode: "none" });
    await expect(service.start({ ...request(2), intentId: limited.intentId }, context)).rejects.toThrow("exact objective");
    expect((await service.start({ ...request(2, 30), intentId: limited.intentId }, context)).deadlineAt).toBe(START + 30 * 60_000);
  });
});

/**
 * A per-worker time limit stops one worker whose turn runs longer than the
 * operator allowed. It ends nothing else: the run goes on, and the worker's
 * approach says why it stopped.
 */
describe("a per-worker time limit", () => {
  it("stops each worker exactly when its turn passes the limit, and only that worker", async () => {
    const scenario = fc.integer({ min: 1, max: 5 }).chain((workers) => fc.record({
      workers: fc.constant(workers),
      limit: fc.integer({ min: 1, max: 600 }),
      // When each worker's turn ends by itself, in minutes after the start; none for a turn that would run on.
      ends: fc.array(fc.option(fc.integer({ min: 1, max: 1200 }), { nil: undefined }), { minLength: workers, maxLength: workers }),
    }));
    await fc.assert(fc.asyncProperty(scenario, async ({ workers, limit, ends }) => {
      const { service, ports, advanceTo } = world();
      const run = await service.start(request(workers, undefined, { turnMinutes: limit }), context);
      expect(run.turnMinutes).toBe(limit);
      await candidate(service, run.id);
      const cutoff = START + limit * MINUTE;
      const natural = ends.flatMap((end, index) => end !== undefined && START + end * MINUTE < cutoff ? [{ index, at: START + end * MINUTE }] : []).sort((a, b) => a.at - b.at);
      for (const end of natural) {
        await advanceTo(end.at);
        service.observeEnd(workerThread(end.index + 1), `turn-${end.index + 1}`);
      }
      await advanceTo(cutoff - 1);
      expect(ports.stop).not.toHaveBeenCalled();
      await advanceTo(cutoff);
      const after = service.read(run.id, operator);
      const limited = Array.from({ length: workers }, (_, index) => index).filter((index) => !natural.some((end) => end.index === index));
      for (const [index, approach] of after.approaches.entries()) {
        if (limited.includes(index)) {
          expect(approach.state).toBe("stopped");
          expect(approach.note).toMatch(/per-worker time limit/);
        } else {
          expect(approach.state).toBe("ended");
          expect(approach.note).toBeUndefined();
        }
      }
      expect(vi.mocked(ports.stop).mock.calls.map(([worker]) => worker.threadId).sort()).toEqual(limited.map((index) => `worker-${index + 1}`).sort());
      // The limit belongs to each worker, never to the run.
      expect(after.status).toBe("running");
      service.close();
    }), { numRuns: 25 });
  });

  it("gives each new turn its own limit, and stops a worker already past a lowered limit", async () => {
    const { service, ports, advanceTo } = world();
    const run = await service.start(request(2, undefined, { turnMinutes: 30 }), context);
    await candidate(service, run.id);
    await advanceTo(START + 20 * MINUTE);
    service.observeEnd(workerThread(1), "turn-1");
    await service.observeStart(workerThread(1), "second-turn");
    // At 30 minutes worker 2's turn reaches the limit; worker 1's second turn is only 10 minutes in.
    await advanceTo(START + 30 * MINUTE);
    expect(service.read(run.id, operator).approaches.map((approach) => approach.state)).toEqual(["running", "stopped"]);
    await advanceTo(START + 45 * MINUTE);
    await service.update(run.id, "lower", { action: "bounds", turnMinutes: 10 }, operator);
    await advanceTo(START + 45 * MINUTE);
    expect(service.read(run.id, operator).approaches.map((approach) => approach.state)).toEqual(["stopped", "stopped"]);
    expect(vi.mocked(ports.stop).mock.calls.map(([worker]) => worker.turnId)).toEqual(["turn-2", "second-turn"]);
  });
});

/**
 * Total worker time adds up every worker's turns, each from its start until
 * PwrAgent sees it end. The run ends when the sum reaches the operator's total,
 * and not before. Time no worker is running adds nothing.
 */
describe("total worker time", () => {
  type Step = { kind: "advance"; minutes: number } | { kind: "end" | "turn"; worker: number };
  const stepArb = (workers: number): fc.Arbitrary<Step> => fc.oneof(
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("advance" as const), minutes: fc.integer({ min: 1, max: 90 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constantFrom("end" as const, "turn" as const), worker: fc.integer({ min: 1, max: workers }) }) },
  );

  it("ends the run exactly when its workers' turns add up to the total", async () => {
    const scenario = fc.integer({ min: 1, max: 4 }).chain((workers) => fc.record({ workers: fc.constant(workers), total: fc.integer({ min: 1, max: 600 }),
      steps: fc.array(stepArb(workers), { minLength: 5, maxLength: 30 }) }));
    await fc.assert(fc.asyncProperty(scenario, async ({ workers, total, steps }) => {
      const { service, advanceTo } = world();
      const run = await service.start(request(workers, undefined, { totalWorkerMinutes: total }), context);
      expect(run.totalWorkerMinutes).toBe(total);
      await candidate(service, run.id);
      const limit = total * MINUTE;
      const model = { now: START, closed: 0, open: Array.from({ length: workers }, (): number | undefined => START), turns: Array.from({ length: workers }, () => 0), endedAt: undefined as number | undefined };
      const turnId = (worker: number) => model.turns[worker - 1] ? `turn-${worker}-${model.turns[worker - 1]}` : `turn-${worker}`;
      const used = (at: number) => model.closed + model.open.reduce<number>((sum, since) => sum + (since === undefined ? 0 : at - since), 0);
      for (const step of steps) {
        if (model.endedAt !== undefined) break;
        if (step.kind === "advance") {
          const target = model.now + step.minutes * MINUTE;
          const open = model.open.filter((since) => since !== undefined) as number[];
          // The first millisecond at which the open turns bring the sum to the total.
          const reached = used(model.now) >= limit ? model.now : open.length ? Math.ceil((limit - model.closed + open.reduce((sum, since) => sum + since, 0)) / open.length) : undefined;
          if (reached !== undefined && reached <= target) model.endedAt = reached;
          await advanceTo(target);
          model.now = target;
        } else if (step.kind === "end") {
          const since = model.open[step.worker - 1];
          if (since === undefined) continue;
          service.observeEnd(workerThread(step.worker), turnId(step.worker));
          model.closed += model.now - since;
          model.open[step.worker - 1] = undefined;
        } else {
          if (model.open[step.worker - 1] !== undefined) continue;
          model.turns[step.worker - 1]!++;
          await service.observeStart(workerThread(step.worker), turnId(step.worker));
          model.open[step.worker - 1] = model.now;
        }
        const header = service.snapshot(context).runs[0]!;
        expect(header.status).toBe(model.endedAt === undefined ? "running" : "deadline");
        if (model.endedAt !== undefined) {
          const stopping = service.read(run.id, operator).events.find((event) => event.data.type === "status" && event.data.status === "stopping");
          expect(stopping?.at).toBe(model.endedAt);
          expect(header.reason).toMatch(/Total worker time/);
        }
      }
      service.close();
    }), { numRuns: 25 });
  });

  it("refuses a total below what the workers have used, and runs on to a raised one", async () => {
    const { service, advanceTo } = world();
    const run = await service.start(request(2, undefined, { totalWorkerMinutes: 100 }), context);
    await candidate(service, run.id);
    await advanceTo(START + 30 * MINUTE);
    // Two workers for 30 minutes have used 60.
    await expect(service.update(run.id, "too-low", { action: "bounds", totalWorkerMinutes: 60 }, operator)).rejects.toThrow("Workers have already used 60 minutes");
    await service.update(run.id, "raise", { action: "bounds", totalWorkerMinutes: 200 }, operator);
    await advanceTo(START + 99 * MINUTE);
    expect(service.snapshot(context).runs[0]!.status).toBe("running");
    await advanceTo(START + 100 * MINUTE);
    expect(service.snapshot(context).runs[0]!.status).toBe("deadline");
  });
});

/**
 * A bound the operator did not set does not exist: no timer waits for it and
 * nothing is written for it, however the workers' turns go.
 */
it("arms no timer and writes nothing for bounds the operator did not set", async () => {
  const steps = fc.array(fc.record({ worker: fc.integer({ min: 1, max: 3 }), turn: fc.boolean(), wait: fc.integer({ min: 1, max: 600 }) }), { minLength: 1, maxLength: 20 });
  await fc.assert(fc.asyncProperty(steps, async (steps) => {
    const { service, delays, advanceTo } = world();
    const run = await service.start(request(3), context);
    let at = START;
    for (const [index, step] of steps.entries()) {
      at += step.wait * MINUTE;
      await advanceTo(at);
      if (step.turn) await service.observeStart(workerThread(step.worker), `turn-${step.worker}-${index}`);
      else service.observeEnd(workerThread(step.worker), `turn-${step.worker}`);
    }
    expect(delays).toEqual([]);
    const events = service.read(run.id, operator).events;
    expect(events.filter((event) => event.data.type === "bounds" || (event.data.type === "worker" && /limit/.test(event.data.note ?? "")))).toEqual([]);
    service.close();
  }), { numRuns: 25 });
});

/**
 * Changing bounds on a live run is the operator's act, recorded as one journal
 * event. A raised count admits more workers; a lowered one stops nobody and
 * admits no one until fewer than the new count hold a slot. The time limit
 * counts from the run's start, so raising it extends the run and removing it
 * leaves no end. The coordinator agent cannot change any of it.
 */
describe("changing a live run's bounds", () => {
  type Step =
    | { kind: "workers"; count: number }
    | { kind: "minutes"; minutes: number | null }
    | { kind: "turn" | "end"; worker: number }
    | { kind: "advance"; minutes: number }
    | { kind: "agent" };
  const stepArb = (workers: number): fc.Arbitrary<Step> => fc.oneof(
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("workers" as const), count: fc.integer({ min: 1, max: workers + 2 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("minutes" as const), minutes: fc.option(fc.integer({ min: 1, max: 400 }), { nil: null }) }) },
    { weight: 4, arbitrary: fc.record({ kind: fc.constantFrom("turn" as const, "end" as const), worker: fc.integer({ min: 1, max: workers }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("advance" as const), minutes: fc.integer({ min: 1, max: 120 }) }) },
    { weight: 1, arbitrary: fc.constant({ kind: "agent" as const }) },
  );

  it("follows the operator's latest bounds, one journal event per change", async () => {
    const scenario = fc.integer({ min: 1, max: 4 }).chain((workers) => fc.record({ workers: fc.constant(workers), minutes: fc.option(fc.integer({ min: 30, max: 300 }), { nil: undefined }),
      steps: fc.array(stepArb(workers), { minLength: 5, maxLength: 30 }) }));
    await fc.assert(fc.asyncProperty(scenario, async ({ workers, minutes, steps }) => {
      const { service, ports, advanceTo } = world();
      const run = await service.start(request(workers, minutes), context);
      await candidate(service, run.id);
      const model = { now: START, limit: workers, deadline: minutes === undefined ? undefined : START + minutes * MINUTE, running: Array.from({ length: workers }, () => true),
        turns: Array.from({ length: workers }, () => 0), changes: 0, stops: 0, ended: false };
      const turnId = (worker: number) => model.turns[worker - 1] ? `turn-${worker}-${model.turns[worker - 1]}` : `turn-${worker}`;
      const boundsEvents = () => service.read(run.id, operator).events.filter((event) => event.data.type === "bounds");
      for (const [index, step] of steps.entries()) {
        if (model.ended) break;
        if (step.kind === "workers") {
          await service.update(run.id, `workers-${index}`, { action: "bounds", workers: step.count }, operator);
          if (step.count !== model.limit) { model.limit = step.count; model.changes++; }
        } else if (step.kind === "minutes") {
          const deadline = step.minutes === null ? undefined : START + step.minutes * MINUTE;
          const changing = service.update(run.id, `minutes-${index}`, { action: "bounds", minutes: step.minutes }, operator);
          if (deadline !== undefined && deadline !== model.deadline && deadline <= model.now) await expect(changing).rejects.toThrow("already passed");
          else {
            await changing;
            if (deadline !== model.deadline) { model.deadline = deadline; model.changes++; }
          }
        } else if (step.kind === "agent") {
          await expect(service.update(run.id, `agent-${index}`, { action: "bounds", workers: model.limit + 1 }, { ...context, callId: `agent-${index}` })).rejects.toThrow("Only the operator");
        } else if (step.kind === "turn") {
          if (model.running[step.worker - 1]) continue;
          model.turns[step.worker - 1]!++;
          await service.observeStart(workerThread(step.worker), turnId(step.worker));
          // A worker taking a slot again is admitted only below the current count.
          if (model.running.filter(Boolean).length < model.limit) model.running[step.worker - 1] = true;
          else model.stops++;
        } else if (step.kind === "end") {
          if (!model.running[step.worker - 1]) continue;
          service.observeEnd(workerThread(step.worker), turnId(step.worker));
          model.running[step.worker - 1] = false;
        } else if (step.kind === "advance") {
          const target = model.now + step.minutes * MINUTE;
          await advanceTo(target);
          model.now = target;
          if (model.deadline !== undefined && model.deadline <= target) {
            model.stops += model.running.filter(Boolean).length;
            model.ended = true;
          }
        }
        const header = service.snapshot(context).runs[0]!;
        expect(header.status).toBe(model.ended ? "deadline" : "running");
        expect(header.workerLimit).toBe(model.limit);
        expect(header.deadlineAt).toBe(model.deadline);
        if (!model.ended) expect(header.activeWorkers).toBe(model.running.filter(Boolean).length);
        // Lowering the count never stopped anyone: every stop is a newcomer over the count, or the deadline.
        expect(ports.stop).toHaveBeenCalledTimes(model.stops);
        const recorded = boundsEvents();
        expect(recorded).toHaveLength(model.changes);
        expect(recorded.every((event) => event.actor.kind === "operator")).toBe(true);
      }
      service.close();
    }), { numRuns: 25 });
  });

  /**
   * A lowered count stops nobody holding a slot, and starts nobody new. Before, a worker whose start was in
   * flight when the count dropped was admitted and then stopped at once, while the next approach still started.
   */
  it("lets a worker already starting keep its slot, and starts no approach past a lowered count", async () => {
    const { service, ports } = world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let spawned = 0;
    ports.spawn = vi.fn(async (_context, _task, _title, _mode, created) => {
      const index = ++spawned;
      const worker = { backend: "codex" as const, threadId: `worker-${index}`, turnId: `turn-${index}` };
      created(worker);
      if (index === 2) await gate;
      return worker;
    });
    const starting = service.start(request(3), context);
    await new Promise((resolve) => setImmediate(resolve));
    const id = service.snapshot(context).runs[0]!.id;
    await service.update(id, "lower", { action: "bounds", workers: 1 }, operator);
    release();
    await starting;
    const run = service.read(id, operator);
    expect(run.approaches.map((approach) => approach.state)).toEqual(["running", "running", "stopped"]);
    expect(run.approaches[2]!.note).toMatch(/worker count/);
    expect(ports.spawn).toHaveBeenCalledTimes(2);
    expect(ports.stop).not.toHaveBeenCalled();
    expect(run.workerLimit).toBe(1);
  });

  it("refuses a change from anyone but the operator, and a time limit that has already passed", async () => {
    const { service, advanceTo } = world();
    const run = await service.start(request(2, 60), context);
    await expect(service.update(run.id, "agent", { action: "bounds", minutes: 120 }, context)).rejects.toThrow("Only the operator can change a run's bounds");
    await advanceTo(START + 40 * MINUTE);
    await expect(service.update(run.id, "past", { action: "bounds", minutes: 40 }, operator)).rejects.toThrow("That time limit has already passed: the run started 40 minutes ago");
    for (const bad of [{ workers: 0 }, { workers: RESEARCH_MAX_WORKERS + 1 }, { minutes: 1.5 }, { turnMinutes: 0 }, { totalWorkerMinutes: -1 }, {}]) {
      await expect(service.update(run.id, `bad-${JSON.stringify(bad)}`, { action: "bounds", ...bad }, operator)).rejects.toThrow();
    }
    expect(service.read(run.id, operator).events.filter((event) => event.data.type === "bounds")).toEqual([]);
    // Extending and then removing the limit: the run never ends by time.
    await service.update(run.id, "extend", { action: "bounds", minutes: 90 }, operator);
    expect(service.snapshot(context).runs[0]!.deadlineAt).toBe(START + 90 * MINUTE);
    await service.update(run.id, "remove", { action: "bounds", minutes: null }, operator);
    await advanceTo(START + 1000 * MINUTE);
    const removed = service.snapshot(context).runs[0]!;
    expect(removed.status).toBe("running");
    expect(removed.deadlineAt).toBeUndefined();
  });
});
