import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import type { ResearchActor, ResearchEvent } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
const actor = { backend: "codex", threadId: "coordinator", kind: "agent", turnId: "parent-turn", callId: "start" } as const;
const request = { objective: "Investigate race conditions", minutes: 10, workspaceMode: "none",
  approaches: [{ title: "Events", task: "Trace events" }, { title: "Lifetime", task: "Trace owners" }, { title: "Persistence", task: "Trace commits" }] } as const;
const mutableRequest = () => ({ ...request, approaches: [...request.approaches] });

beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  fixture = createTempStateDb("pwragent-research-");
  db = StateDb.open(fixture.dbPath);
  resetSqliteWriteMetrics();
});
afterEach(() => { db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function createService(overrides: Partial<ResearchPorts> = {}) {
  let worker = 0;
  const service = new ResearchService(new ResearchStore(db), {
    ownerId: "owner", ownerPid: 123, isOwnerAlive: () => false, now: () => 1000,
    schedule: () => () => {}, changed: () => {}, onError: (error) => { throw error; },
    stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}),
    spawn: async (_context, _task, _title, _mode, created) => {
      const result = { backend: "codex" as const, threadId: `worker-${++worker}`, turnId: `turn-${worker}` };
      created({ backend: result.backend, threadId: result.threadId });
      service.observeStart(result, result.turnId);
      return result;
    },
    ...overrides,
  });
  return service;
}

describe("research journal storage", () => {
  it("retains the board and exact review provenance after reopening a real database", async () => {
    const service = createService();
    const run = await service.start(mutableRequest(), actor);
    const worker: ResearchActor = { ...run.approaches[0]!.worker!, kind: "agent", callId: "post" };
    const posted = await service.update(run.id, "finding", { action: "finding", approachId: "a1", kind: "experiment", text: "Ordering reproduced the failure", paths: ["evidence/result.txt"] }, worker);
    await service.update(run.id, "candidate", { action: "submit", approachId: "a1", text: "Preserve event order", paths: [] }, actor);
    const submission = service.read(run.id, actor).submissions[0]!;
    await service.update(run.id, "review", { action: "review", submissionId: submission.id, decision: "accepted", reason: "Reproduction supports it" }, actor);
    const before = service.read(run.id, actor);
    expect(new ResearchStore(db).list(worker).map((r) => r.id)).toContain(run.id);
    db.close();
    db = StateDb.open(fixture.dbPath);
    const after = new ResearchStore(db).get(run.id)!;
    expect(after).toEqual(before);
    expect(after.findings[0]?.id).toBe(posted.findings[0]?.id);
    expect(after.submissions[0]?.review?.actor).toEqual(actor);
  });

  it("refuses a stale append from a second database connection and conflicting command reuse", async () => {
    const service = createService();
    const run = await service.start(mutableRequest(), actor);
    const second = StateDb.open(fixture.dbPath);
    try {
      const staleStore = new ResearchStore(second);
      const stale = staleStore.get(run.id)!;
      await service.update(run.id, "post", { action: "finding", approachId: "a1", kind: "note", text: "Evidence", paths: [] }, actor);
      const event: ResearchEvent = { seq: stale.revision + 1, commandId: "other", signature: "other", at: 1000, actor, data: { type: "status", status: "stopped", reason: "stale" } };
      expect(() => staleStore.append(run.id, stale.revision, event)).toThrow("changed");
      const stored = staleStore.get(run.id)!;
      expect(stored.status).toBe("running");
      const last = stored.events.at(-1)!;
      expect(() => staleStore.append(run.id, stored.revision, { ...last, signature: "different" })).toThrow("reused");
      staleStore.append(run.id, stored.revision, last);
      expect(staleStore.get(run.id)?.revision).toBe(stored.revision);
    } finally { second.close(); }
  });

  it("budgets worker startup and explicit findings, with zero writes for reads and redelivery", async () => {
    const service = createService();
    const start = await measureSqliteWrites(async () => await service.start(mutableRequest(), actor));
    expectSqliteWriteBudget({ scenario: "research-start-three-workers", note: "One run and three managed worker admissions; no provider transcripts or token events.", writes: start.writes });
    const run = service.snapshot(actor).runs[0]!;
    const command = { action: "finding", approachId: "a1", kind: "note", text: "Evidence", paths: [] } as const;
    const post = await measureSqliteWrites(async () => await service.update(run.id, "post", { ...command, paths: [] }, actor));
    expectSqliteWriteBudget({ scenario: "research-finding", note: "One explicit structured finding. No polling writes. Project using observed bytes per commit at one finding/minute, not one streamed token/event.", writes: post.writes });
    const idle = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i++) {
        service.snapshot(actor);
        service.read(run.id, actor);
        await service.update(run.id, "post", { ...command, paths: [] }, actor);
        service.observeEnd(run.approaches[0]!.worker!, "unrelated-turn");
      }
    });
    expectSqliteWriteBudget({ scenario: "research-reads-and-redelivery", note: "100 board reads, duplicate commands, and unrelated terminal observations: zero commits.", writes: idle.writes });
    const stop = await measureSqliteWrites(async () => await service.update(run.id, "stop", { action: "stop", reason: "Operator stopped" }, actor));
    expectSqliteWriteBudget({ scenario: "research-stop-three-workers", note: "Stop admission, three acknowledged worker cancellations, and terminal outcome.", writes: stop.writes });
  });

  it("budgets revision delivery and cancels only its recorded queued message", async () => {
    const cancelQueued = vi.fn(async () => ({}));
    const service = createService({ notify: async () => ({ queueEntryId: "research-feedback" }), cancelQueued });
    const run = await service.start(mutableRequest(), actor);
    await service.update(run.id, "submission", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, actor);
    const submissionId = service.read(run.id, actor).submissions[0]!.id;
    const revision = await measureSqliteWrites(async () => await service.update(run.id, "review", { action: "review", submissionId, decision: "revision_requested", reason: "Reproduce the counterexample" }, { ...actor, kind: "operator" }));
    expectSqliteWriteBudget({ scenario: "research-revision-feedback", note: "One review decision, delivery intent, and accepted queue receipt. No blind retry on an unknown receipt.", writes: revision.writes });
    await service.update(run.id, "stop", { action: "stop", reason: "Cancel" }, actor);
    expect(cancelQueued).toHaveBeenCalledExactlyOnceWith("research-feedback");
    expect(service.read(run.id, actor).status).toBe("stopped");
  });

  it("budgets terminal observations and restart recovery without polling writes", async () => {
    const service = createService();
    const prepared = await measureSqliteWrites(async () => service.prepare({ backend: actor.backend, threadId: actor.threadId,
      objective: request.objective, workers: 3, minutes: request.minutes, workspaceMode: request.workspaceMode }));
    expectSqliteWriteBudget({ scenario: "research-prepare", note: "Bind the operator's exact limits in memory before the coordinator receives the request. No execution or SQLite writes.", writes: prepared.writes });
    const run = await service.start({ ...mutableRequest(), ...prepared.result }, actor);
    const firstWorker = run.approaches[0]!.worker!;
    const terminal = await measureSqliteWrites(async () => service.observeEnd(firstWorker, firstWorker.turnId!));
    expectSqliteWriteBudget({ scenario: "research-worker-terminal", note: "One exact provider terminal event for an assigned worker; duplicate and unrelated terminal events do not write.", writes: terminal.writes });
    const secondWorker = run.approaches[1]!.worker!;
    service.observeEnd(secondWorker, secondWorker.turnId!);
    const lastWorker = run.approaches[2]!.worker!;
    const exhausted = await measureSqliteWrites(async () => service.observeEnd(lastWorker, lastWorker.turnId!));
    expectSqliteWriteBudget({ scenario: "research-exhausted", note: "The last worker ends without a candidate: retain its terminal event and the honest exhausted outcome.", writes: exhausted.writes });
    expect(service.read(run.id, actor).status).toBe("exhausted");
    await service.start(mutableRequest(), { ...actor, callId: "second-run" });
    const replacement = createService({ ownerId: "replacement", isOwnerAlive: () => false });
    const recovery = await measureSqliteWrites(async () => replacement.initialize());
    expectSqliteWriteBudget({ scenario: "research-recovery", note: "A dead owner's active run becomes interrupted. No workers are started and no periodic recovery writes are introduced.", writes: recovery.writes });
  });

  it("budgets admitted revision cancellation and settlement from exact provider evidence", async () => {
    const service = createService({ notify: async () => ({ queueEntryId: "feedback" }),
      cancelQueued: async () => ({ turnId: "revision-turn" }),
      stop: async (worker) => { if (worker.turnId === "revision-turn") throw new Error("Lost cancellation receipt"); },
    });
    const run = await service.start(mutableRequest(), actor);
    await service.update(run.id, "submission", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, actor);
    await service.update(run.id, "review", { action: "review", submissionId: service.read(run.id, actor).submissions[0]!.id, decision: "revision_requested", reason: "Check evidence" }, { ...actor, kind: "operator" });
    const stopping = await measureSqliteWrites(async () => await service.update(run.id, "stop", { action: "stop", reason: "Stop" }, actor));
    expect(stopping.result.status).toBe("stopping");
    expect(stopping.result.deliveries[0]).toMatchObject({ state: "unknown", turnId: "revision-turn" });
    expectSqliteWriteBudget({ scenario: "research-revision-cancel-unknown", note: "Stop admission, retain the exact newly admitted revision turn before cancellation, record its unknown receipt, and cancel three initial worker turns.", writes: stopping.writes });
    const settled = await measureSqliteWrites(async () => service.observeEnd(run.approaches[0]!.worker!, "revision-turn"));
    expect(service.read(run.id, actor).status).toBe("stopped");
    expectSqliteWriteBudget({ scenario: "research-revision-cancel-settled", note: "An exact provider terminal event settles the unknown delivery and the run. Duplicate terminal events do not write.", writes: settled.writes });
  });
});
