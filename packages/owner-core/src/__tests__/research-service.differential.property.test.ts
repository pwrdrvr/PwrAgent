import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ResearchEvent, ResearchThread } from "@pwragent/shared/research";
import { ResearchService, type ResearchPorts } from "../research-service";
import { emptyResearchDifferentialCoverage, expectResearchServicesAgree, researchDifferentialBoundsStepArb, researchDifferentialStepArb } from "./fixtures/research-differential";
import { MemoryResearchStorage } from "./fixtures/research-memory-storage";
import { ReplayMemoryStorage, ReplayResearchService } from "./fixtures/research-service-replay-reference";

const uuid = vi.hoisted(() => ({ next: (): string => { throw new Error("No world is taking its turn"); } }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: () => uuid.next() }));

describe("research service, validated against projections", () => {
  it("accepts, refuses and records exactly what the replay-based service does, for generated commands, observations, redeliveries, stale versions and restarts", async () => {
    const coverage = emptyResearchDifferentialCoverage();
    await fc.assert(fc.asyncProperty(fc.array(researchDifferentialStepArb, { size: "max", minLength: 15, maxLength: 45 }), async (steps) => {
      const storage = new MemoryResearchStorage();
      await expectResearchServicesAgree(uuid, steps, storage, (id) => storage.records.get(id), coverage);
    }), { numRuns: 30 });
    // The comparison means nothing if the sequences never get past a refusal, or never meet one.
    for (const type of ["worker", "status", "finding", "submission", "review", "item_work", "delivery", "bounds"]) expect(coverage.events[type] ?? 0, `${type} events recorded`).toBeGreaterThan(0);
    for (const kind of ["finding", "submit", "review", "work", "assign", "start", "bounds"]) {
      expect(coverage.accepted[kind] ?? 0, `${kind} accepted`).toBeGreaterThan(0);
      expect(coverage.refused[kind] ?? 0, `${kind} refused`).toBeGreaterThan(0);
    }
    expect(Object.keys(coverage.refusals).length).toBeGreaterThan(10);
  });

  it("agrees on the operator's bounds: changes to them, and the per-worker limits and total worker time their timers enforce", async () => {
    const coverage = emptyResearchDifferentialCoverage();
    await fc.assert(fc.asyncProperty(fc.array(researchDifferentialBoundsStepArb, { size: "max", minLength: 15, maxLength: 45 }), async (steps) => {
      const storage = new MemoryResearchStorage();
      await expectResearchServicesAgree(uuid, steps, storage, (id) => storage.records.get(id), coverage);
    }), { numRuns: 30 });
    // Each bound has to be reached, changed and refused for the comparison to cover it.
    for (const type of ["bounds", "worker:turn-limit", "status:worker-time"]) expect(coverage.events[type] ?? 0, `${type} events recorded`).toBeGreaterThan(0);
    expect(coverage.accepted.bounds ?? 0).toBeGreaterThan(0);
    expect(coverage.accepted.resume ?? 0, "resumes accepted").toBeGreaterThan(0);
    for (const refusal of ["Only the operator can change a run's bounds", "Choose 1–64 workers"]) expect(coverage.refusals[refusal] ?? 0, refusal).toBeGreaterThan(0);
  });

  /**
   * Generated sequences rarely line up a takeover, a queued resume and a lowered per-worker limit, so this drives
   * that path directly: both services must withdraw the same resume messages and record the same journal.
   */
  it("agrees on withdrawing resumes that a lowered per-worker limit has already passed", async () => {
    const scenario = fc.integer({ min: 1, max: 3 }).chain((workers) => fc.record({
      restarts: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: workers, maxLength: workers }),
      quitAt: fc.integer({ min: 101, max: 200 }), closed: fc.integer({ min: 0, max: 200 }), limit: fc.integer({ min: 1, max: 500 }),
      inFlight: fc.boolean(), startedOnCancel: fc.boolean(),
    }));
    let withdrawals = 0;
    await fc.assert(fc.asyncProperty(scenario, async (input) => {
      const replay = new ReplayMemoryStorage();
      const projection = new MemoryResearchStorage();
      const expected = await driveResumeLimit((ports) => new ReplayResearchService(replay, ports) as unknown as Driven, () => replay.records, input);
      const actual = await driveResumeLimit((ports) => new ResearchService(projection, ports) as unknown as Driven, () => projection.records, input);
      expect(actual).toEqual(expected);
      withdrawals += expected.journals.flat().filter((event) => event.commandId.startsWith("resume-withdrawn:") && event.data.type === "worker" && /per-worker time limit/.test(event.data.note ?? "")).length;
    }), { numRuns: 60 });
    expect(withdrawals, "resumes withdrawn at the limit").toBeGreaterThan(0);
  });
});

type Driven = Pick<ResearchService, "initialize" | "close" | "observeStart" | "observeEnd"> & {
  start: (...args: Parameters<ResearchService["start"]>) => Promise<{ id: string }>;
  update: (...args: Parameters<ResearchService["update"]>) => Promise<unknown>;
};

/** One run: workers whose turns began at their own times, a quit, a takeover, a resume, then a new per-worker limit. */
async function driveResumeLimit(make: (ports: ResearchPorts) => Driven, records: () => Map<string, ResearchEvent[]>,
  input: { restarts: number[]; quitAt: number; closed: number; limit: number; inFlight: boolean; startedOnCancel: boolean }): Promise<{ journals: ResearchEvent[][]; calls: string[] }> {
  let ids = 0;
  uuid.next = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
  const coordinator: ResearchThread = { backend: "codex", threadId: "coordinator" };
  const agent = { ...coordinator, kind: "agent", turnId: "coordinator-turn", callId: "start" } as const;
  const operator = { ...coordinator, kind: "operator" } as const;
  const minute = 60_000;
  const started = 1_000_000;
  let now = started;
  let spawned = 0;
  const calls: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ports = (ownerId: string, resuming: boolean): ResearchPorts => ({
    ownerId, ownerPid: 1, ownerStartedAt: now, isOwnerAlive: () => false, now: () => now, schedule: () => () => {}, changed: () => {},
    onError: (error) => { calls.push(`onError ${error instanceof Error ? error.message : String(error)}`); },
    spawn: async (_context, _task, _title, _mode, created) => { const worker = { backend: "codex" as const, threadId: `worker-${++spawned}` }; created(worker); return { ...worker, turnId: `turn-${spawned}-0` }; },
    stop: async (worker) => { calls.push(`stop ${worker.threadId} ${worker.turnId}`); },
    notify: async (_actor, target) => { calls.push(`notify ${target.threadId}`); if (resuming && input.inFlight) await gate; return { queueEntryId: `queue-${target.threadId}` }; },
    cancelQueued: async (entry) => { calls.push(`cancel ${entry}`); return input.startedOnCancel ? { turnId: `late-${entry}` } : {}; },
  });
  let service = make(ports("owner-1", false));
  const { id } = await service.start({ objective: "Invented objective", workspaceMode: "none", turnMinutes: 10_000,
    approaches: input.restarts.map((_, index) => ({ title: `Approach ${index + 1}`, task: "Invented task" })) }, agent);
  await service.update(id, "candidate", { action: "submit", approachId: "a1", text: "Invented candidate", paths: [] }, agent);
  for (const [index, at] of input.restarts.map((minutes, index) => [index, minutes] as const).sort((a, b) => a[1] - b[1])) {
    now = started + at * minute;
    service.observeEnd({ backend: "codex", threadId: `worker-${index + 1}` }, `turn-${index + 1}-0`);
    await service.observeStart({ backend: "codex", threadId: `worker-${index + 1}` }, `second-${index + 1}`);
  }
  now = started + (input.quitAt + input.closed) * minute;
  service.close();
  service = make(ports("owner-2", true));
  service.initialize();
  const resuming = service.update(id, "resume", { action: "resume" }, operator);
  if (!input.inFlight) await resuming;
  else await new Promise((resolve) => setImmediate(resolve));
  await service.update(id, "lower", { action: "bounds", turnMinutes: input.limit }, operator);
  release();
  await resuming;
  service.close();
  return { journals: [...records().values()].map((events) => structuredClone(events)), calls };
}
