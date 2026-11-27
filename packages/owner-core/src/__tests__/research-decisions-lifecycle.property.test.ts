import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DecisionRunProvider } from "@pwragent/shared/decision-models";
import type { ResearchThread } from "@pwragent/shared/research";
import {
  ResearchService,
  researchItemWorkerPrompt,
  researchResumePrompt,
  researchWorkerPrompt,
  type ResearchExecutionContext,
  type ResearchPorts,
} from "../research-service";
import { MemoryResearchStorage } from "./fixtures/research-memory-storage";

const MINUTE = 60_000;
const coordinator: ResearchExecutionContext = {
  backend: "codex",
  threadId: "coord-1",
  kind: "agent",
  turnId: "coord-turn-1",
  callId: "coord-call-1",
};

type BatchTracker = {
  batchId: string;
  owner: ResearchThread;
  researchRunId?: string;
  background: boolean;
  active: boolean;
  cancelReason?: string;
};

function createHarness(options: {
  readyProviders?: readonly DecisionRunProvider[];
  trackBackgroundOccupancy?: boolean;
} = {}) {
  const storage = new MemoryResearchStorage();
  let clock = 10_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  let workerSeq = 0;
  const prompts: Array<{ worker: ResearchThread; prompt: string }> = [];
  const stoppedTurns: Array<{ threadId: string; turnId?: string }> = [];
  const batches: BatchTracker[] = [];
  const errors: unknown[] = [];

  const ports: ResearchPorts = {
    ownerId: "owner-1",
    ownerPid: 1,
    ownerStartedAt: 1,
    isOwnerAlive: () => true,
    now: () => clock,
    schedule: (fn, delay) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + Math.max(0, delay), fn });
      return () => { timers.delete(id); };
    },
    changed: () => {},
    onError: (error) => { errors.push(error); },
    readyDecisionProviders: () => options.readyProviders ?? [],
    cancelDecisionBatches: async (thread, reason, opts) => {
      for (const batch of batches) {
        if (!batch.active) continue;
        if (batch.owner.backend !== thread.backend || batch.owner.threadId !== thread.threadId) continue;
        if (opts?.researchRunId !== undefined && batch.researchRunId !== opts.researchRunId) continue;
        batch.active = false;
        batch.cancelReason = reason;
      }
    },
    ...(options.trackBackgroundOccupancy
      ? {
          hasActiveBackgroundDecisionBatch: (thread, runId) =>
            batches.some((batch) =>
              batch.active
              && batch.background
              && batch.owner.backend === thread.backend
              && batch.owner.threadId === thread.threadId
              && (runId === undefined || batch.researchRunId === undefined || batch.researchRunId === runId),
            ),
        }
      : {}),
    spawn: async (_context, task, _title, _workspaceMode, onCreated) => {
      workerSeq += 1;
      const worker = { backend: "codex" as const, threadId: `worker-${workerSeq}` };
      onCreated(worker);
      prompts.push({ worker, prompt: task });
      return { ...worker, turnId: `turn-${workerSeq}` };
    },
    stop: async (worker) => {
      stoppedTurns.push({ threadId: worker.threadId, turnId: worker.turnId });
    },
    notify: async (_context, target, text) => {
      prompts.push({ worker: target, prompt: text });
      return { turnId: `resume-turn-${++workerSeq}` };
    },
    cancelQueued: async () => ({}),
  };

  const service = new ResearchService(storage, ports);

  const advanceTo = async (targetMs: number) => {
    clock = targetMs;
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      timers.delete(id);
      timer.fn();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { service, storage, prompts, stoppedTurns, batches, errors, advanceTo, getClock: () => clock };
}

describe("ResearchService Decisions lifecycle and prompt gating", () => {
  it("cancels active and background worker batches (even after a worker turn ended) and run-scoped coordinator batches on stop/deadline/totalWorkerMinutes", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 4 }),
      fc.constantFrom("stop", "deadline", "totalWorkerMinutes") as fc.Arbitrary<"stop" | "deadline" | "totalWorkerMinutes">,
      fc.boolean(),
      async (workerCount, stopCause, firstWorkerEndedForBackground) => {
        // When the sole worker ends its turn, finishExploration moves the run to "exhausted" and clears
        // deadline/totalWorkerMinutes timers (tested explicitly via stopCause === "stop" below).
        fc.pre(!(workerCount === 1 && firstWorkerEndedForBackground && stopCause !== "stop"));
        const harness = createHarness({ readyProviders: ["openai"] });
        const approaches = Array.from({ length: workerCount }, (_, index) => ({
          title: `Direction ${index + 1}`,
          task: `Explore direction ${index + 1}`,
        }));
        const started = await harness.service.start({
          objective: "Test decision batch lifecycle cancellation",
          approaches,
          workspaceMode: "none",
          ...(stopCause === "deadline" ? { minutes: 5 } : {}),
          ...(stopCause === "totalWorkerMinutes" ? { totalWorkerMinutes: 2 } : {}),
        }, coordinator);

        const run = harness.service.read(started.id, coordinator);
        for (const approach of run.approaches) {
          const worker = approach.worker!;
          harness.batches.push({
            batchId: `batch_block_${worker.threadId}`,
            owner: { backend: worker.backend, threadId: worker.threadId },
            researchRunId: run.id,
            background: false,
            active: true,
          });
          harness.batches.push({
            batchId: `batch_bg_${worker.threadId}`,
            owner: { backend: worker.backend, threadId: worker.threadId },
            researchRunId: run.id,
            background: true,
            active: true,
          });
        }
        // Coordinator owns both a run-scoped batch AND an unrelated manual batch.
        harness.batches.push({
          batchId: "batch_coord_run",
          owner: { backend: coordinator.backend, threadId: coordinator.threadId },
          researchRunId: run.id,
          background: true,
          active: true,
        });
        harness.batches.push({
          batchId: "batch_coord_unrelated",
          owner: { backend: coordinator.backend, threadId: coordinator.threadId },
          background: true,
          active: true,
        });

        // Simulate worker-1 ending its model turn while its background batch continues.
        if (firstWorkerEndedForBackground) {
          const first = run.approaches[0]!.worker!;
          harness.service.observeEnd({ backend: first.backend, threadId: first.threadId }, first.turnId!);
        }

        if (stopCause === "stop") {
          await harness.service.stop(run.id, { ...coordinator, kind: "operator" }, "stopped", "Operator stopped run");
        } else if (stopCause === "deadline") {
          await harness.advanceTo(harness.getClock() + 5 * MINUTE + 1);
        } else {
          // Total worker time = 2 minutes across remaining active workers.
          const activeCount = Math.max(1, firstWorkerEndedForBackground ? workerCount - 1 : workerCount);
          const neededMs = Math.ceil((2 * MINUTE) / activeCount) + 1000;
          await harness.advanceTo(harness.getClock() + neededMs);
        }

        // Every worker batch (blocking and background, including ended-turn worker-1)
        // and the coordinator's run-scoped batch MUST be cancelled.
        for (const batch of harness.batches) {
          if (batch.batchId === "batch_coord_unrelated") {
            expect(batch.active).toBe(true);
          } else {
            expect(batch.active).toBe(false);
            expect(batch.cancelReason).toBeTruthy();
          }
        }
        expect(harness.errors).toEqual([]);
      },
    ), { numRuns: 20 });
  });

  it("cancels lingering background worker batches when stopping an already-exhausted single-worker run (counterexample [1, stop, true])", async () => {
    const harness = createHarness({ readyProviders: ["openai"] });
    const started = await harness.service.start({
      objective: "Exhausted run still cancels background batches on stop",
      approaches: [{ title: "Solo worker", task: "Run background batch" }],
      workspaceMode: "none",
    }, coordinator);
    const run = harness.service.read(started.id, coordinator);
    const worker = run.approaches[0]!.worker!;
    harness.batches.push(
      { batchId: "batch_solo_bg", owner: { backend: worker.backend, threadId: worker.threadId }, researchRunId: run.id, background: true, active: true },
      { batchId: "batch_coord_run", owner: { backend: coordinator.backend, threadId: coordinator.threadId }, researchRunId: run.id, background: true, active: true },
      { batchId: "batch_coord_unrelated", owner: { backend: coordinator.backend, threadId: coordinator.threadId }, background: true, active: true },
    );

    harness.service.observeEnd({ backend: worker.backend, threadId: worker.threadId }, worker.turnId!);
    expect(harness.service.read(run.id, coordinator).status).toBe("exhausted");

    await harness.service.stop(run.id, { ...coordinator, kind: "operator" }, "stopped", "Operator stopped exhausted run");
    expect(harness.batches.find((b) => b.batchId === "batch_solo_bg")?.active).toBe(false);
    expect(harness.batches.find((b) => b.batchId === "batch_coord_run")?.active).toBe(false);
    expect(harness.batches.find((b) => b.batchId === "batch_coord_unrelated")?.active).toBe(true);
    expect(harness.errors).toEqual([]);
  });

  it("cancels only the affected worker's batches on turnMinutes timeout and work(cancelled)", async () => {
    const harness = createHarness({ readyProviders: ["openai"] });
    const started = await harness.service.start({
      objective: "Per-worker cancellation isolation",
      approaches: [
        { title: "Approach A", task: "Task A" },
        { title: "Approach B", task: "Task B" },
      ],
      turnMinutes: 3,
      workspaceMode: "none",
    }, coordinator);

    const run = harness.service.read(started.id, coordinator);
    const workerA = run.approaches[0]!.worker!;
    const workerB = run.approaches[1]!.worker!;

    harness.batches.push(
      { batchId: "batch_a_bg", owner: { backend: workerA.backend, threadId: workerA.threadId }, researchRunId: run.id, background: true, active: true },
      { batchId: "batch_b_bg", owner: { backend: workerB.backend, threadId: workerB.threadId }, researchRunId: run.id, background: true, active: true },
    );

    // Cancel Approach A via work(cancelled) even after worker A ended its turn waiting on background batch.
    harness.service.observeEnd({ backend: workerA.backend, threadId: workerA.threadId }, workerA.turnId!);
    const itemA = harness.service.readItem(run.id, run.approaches[0]!.id, coordinator).item;
    await harness.service.work(
      run.id,
      "cancel-a",
      { action: "work", itemId: itemA.id, expectedVersion: itemA.version, state: "cancelled", reason: "Direction superseded" },
      { ...coordinator, kind: "operator" },
    );

    expect(harness.batches.find((b) => b.batchId === "batch_a_bg")?.active).toBe(false);
    expect(harness.batches.find((b) => b.batchId === "batch_b_bg")?.active).toBe(true);

    // Now advance past turnMinutes (3 min): worker B times out and its batch is cancelled.
    await harness.advanceTo(harness.getClock() + 3 * MINUTE + 1);
    expect(harness.batches.find((b) => b.batchId === "batch_b_bg")?.active).toBe(false);
    expect(harness.batches.find((b) => b.batchId === "batch_b_bg")?.cancelReason).toContain("3 minutes");
  });

  it("gates Decisions guidance in worker, resume, and item prompts on provider readiness", async () => {
    const unready = createHarness({ readyProviders: [] });
    await unready.service.start({
      objective: "No decision provider configured",
      approaches: [{ title: "Alpha", task: "Investigate" }],
      workspaceMode: "none",
    }, coordinator);
    expect(unready.prompts[0]!.prompt).not.toMatch(/decisions_list|decisions_invoke|Decision models are ready/);

    const ready = createHarness({ readyProviders: ["openai", "local"] });
    const started = await ready.service.start({
      objective: "OpenAI and Clef configured",
      approaches: [{ title: "Beta", task: "Score candidates" }],
      workspaceMode: "none",
    }, coordinator);
    expect(ready.prompts[0]!.prompt).toContain("OpenAI Decisions (gpt-6-luna)");
    expect(ready.prompts[0]!.prompt).toContain("local Clef");
    expect(ready.prompts[0]!.prompt).toContain(`researchRunId=${started.id}`);

    const approach = { id: "a1", title: "Beta", task: "Score", state: "running" as const, itemId: "item-1" };
    expect(researchWorkerPrompt("r1", "obj", approach, [])).not.toContain("decisions_list");
    expect(researchResumePrompt("r1", approach, [])).not.toContain("decisions_list");
    expect(researchItemWorkerPrompt("r1", approach, [])).not.toContain("decisions_list");
    expect(researchResumePrompt("r1", approach, ["jev"])).toContain("TypeSafe Jev");
    expect(researchItemWorkerPrompt("r1", approach, ["local"])).toContain("local Clef");
  });

  it("keeps run alive and holds worker slot while a worker awaits a background decision batch, then exhausts if batch ends without wake", async () => {
    const harness = createHarness({ readyProviders: ["jev"], trackBackgroundOccupancy: true });
    const started = await harness.service.start({
      objective: "Background batch wake-up survival",
      approaches: [{ title: "Score paragraphs", task: "Run background Jev batch" }],
      minutes: 15,
      workspaceMode: "none",
    }, coordinator);

    const run = harness.service.read(started.id, coordinator);
    const worker = run.approaches[0]!.worker!;
    const workerThread = { backend: worker.backend, threadId: worker.threadId };

    // Worker launches background batch and ends Turn 1 to wait for wake-up.
    harness.batches.push({
      batchId: "batch_bg_1",
      owner: workerThread,
      researchRunId: run.id,
      background: true,
      active: true,
    });
    harness.service.observeEnd(workerThread, worker.turnId!);

    // Run MUST remain "running" (not "exhausted"), and worker slot stays reserved against new assignments.
    expect(harness.service.read(run.id, coordinator).status).toBe("running");
    const finding = await harness.service.update(
      run.id,
      "coord-finding-1",
      { action: "finding", approachId: run.approaches[0]!.id, kind: "note", text: "Seed note", paths: [] },
      coordinator,
    );
    const findingItem = harness.service.read(run.id, coordinator).items.find((item) => item.type === "finding")!;
    await expect(harness.service.assign({
      runId: run.id,
      itemId: findingItem.id,
      expectedVersion: findingItem.version,
      task: "Should not steal background batch slot",
    }, coordinator)).rejects.toThrow("Research worker limit reached");
    expect(finding.status).toBe("running");

    // Batch finishes and wakes worker into Turn 2: turn is admitted (not killed) and can submit.
    harness.batches[0]!.active = false;
    await harness.service.observeStart(workerThread, "worker-wake-turn-2");
    expect(harness.stoppedTurns).toEqual([]);
    await harness.service.update(
      run.id,
      "worker-submit-1",
      { action: "submit", approachId: run.approaches[0]!.id, text: "Results from batch_bg_1", paths: [] },
      { ...workerThread, kind: "agent" },
    );
    harness.service.observeEnd(workerThread, "worker-wake-turn-2");
    expect(harness.service.read(run.id, coordinator).submissions).toHaveLength(1);

    // Separate 1-worker run: if background batch settles silently (no wake), observeDecisionBatchFinished exhausts the run.
    const silentRun = await harness.service.start({
      objective: "Silent cancel exhaustion",
      approaches: [{ title: "Solo", task: "Background batch" }],
      workspaceMode: "none",
    }, { ...coordinator, callId: "coord-call-2" });
    const silentWorker = harness.service.read(silentRun.id, coordinator).approaches[0]!.worker!;
    const silentThread = { backend: silentWorker.backend, threadId: silentWorker.threadId };
    harness.batches.push({
      batchId: "batch_silent",
      owner: silentThread,
      researchRunId: silentRun.id,
      background: true,
      active: true,
    });
    harness.service.observeEnd(silentThread, silentWorker.turnId!);
    expect(harness.service.read(silentRun.id, coordinator).status).toBe("running");

    harness.batches[1]!.active = false;
    harness.service.observeDecisionBatchFinished(silentThread);
    expect(harness.service.read(silentRun.id, coordinator).status).toBe("exhausted");
  });

  it("validates completed-run preconditions in stop before cancelling decision batches", async () => {
    const harness = createHarness({ readyProviders: ["openai"] });
    const started = await harness.service.start({
      objective: "Stop precondition check",
      approaches: [{ title: "Solo", task: "Work" }],
      workspaceMode: "none",
    }, coordinator);
    const run = harness.service.read(started.id, coordinator);
    const worker = run.approaches[0]!.worker!;
    harness.batches.push({
      batchId: "batch_precond",
      owner: { backend: worker.backend, threadId: worker.threadId },
      researchRunId: run.id,
      background: true,
      active: true,
    });

    harness.service.observeEnd({ backend: worker.backend, threadId: worker.threadId }, worker.turnId!);
    expect(harness.service.read(run.id, coordinator).status).toBe("exhausted");

    // Completing an exhausted run with no accepted submission must fail BEFORE cancelling batches.
    await expect(
      harness.service.stop(run.id, { ...coordinator, kind: "operator" }, "completed", "Premature finish"),
    ).rejects.toThrow("Accept a submission before completing the run");
    expect(harness.batches[0]!.active).toBe(true);
  });
});
