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
const request = (workers: number, minutes?: number): StartResearchRequest => ({ objective: "Investigate a queue race", workspaceMode: "none", ...(minutes !== undefined ? { minutes } : {}),
  approaches: Array.from({ length: workers }, (_, index) => ({ title: `Approach ${index + 1}`, task: `Trace part ${index + 1}` })) });
const finding = (key: string): ResearchCommand => ({ action: "finding", approachId: "a1", kind: "note", text: `Work ${key}`, paths: [] });

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
    }), { numRuns: 30, examples: [[9], [12], [RESEARCH_MAX_WORKERS]] });
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
    }), { numRuns: 30 });
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
    }), { numRuns: 40 });
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
