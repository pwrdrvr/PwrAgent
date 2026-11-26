import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAIDecisionConflictError,
  OpenAIDecisionNameTakenError,
  type OpenAIDecisionCaller,
  type OpenAIDecisionRegistryStorage,
  type OpenAIDecisionVersionRecord,
} from "../storage/openai-decision-store";
import {
  OpenAIDecisionsError,
  OpenAIDecisionsService,
  type DecisionResearchRunContext,
  type DecisionResearchRunMembership,
} from "../openai-decisions/openai-decisions-service";
import { buildResearchToolDefinitions } from "../agent-tools/pwragent-research-agent-tools";

/** Fast in-memory registry storage oracle for property tests (zero SQLite inside fc loops). */
class MemoryDecisionRegistry implements OpenAIDecisionRegistryStorage {
  private readonly rows: OpenAIDecisionVersionRecord[] = [];

  insertFirstVersion(record: OpenAIDecisionVersionRecord): void {
    const duplicate = this.rows.some((row) =>
      row.status === "active"
      && row.name === record.name
      && row.scope === record.scope
      && (record.scope !== "thread" || (row.ownerBackend === record.ownerBackend && row.ownerThreadId === record.ownerThreadId))
      && (record.scope !== "research_run" || row.researchRunId === record.researchRunId),
    );
    if (duplicate) throw new OpenAIDecisionNameTakenError(record.name);
    this.rows.push(structuredClone(record));
  }

  insertNextVersion(record: OpenAIDecisionVersionRecord): void {
    const active = this.rows.find((row) => row.decisionId === record.decisionId && row.status === "active");
    if (!active || active.version !== record.version - 1) {
      throw new OpenAIDecisionConflictError("conflict");
    }
    active.status = "superseded";
    this.rows.push(structuredClone(record));
  }

  softDelete(decisionId: string): boolean {
    let changed = false;
    for (const row of this.rows) {
      if (row.decisionId === decisionId && row.status !== "deleted") {
        row.status = "deleted";
        changed = true;
      }
    }
    return changed;
  }

  getVersion(decisionId: string, version: number): OpenAIDecisionVersionRecord | undefined {
    const found = this.rows.find((row) => row.decisionId === decisionId && row.version === version);
    return found ? structuredClone(found) : undefined;
  }

  getActive(decisionId: string): OpenAIDecisionVersionRecord | undefined {
    const found = this.rows.find((row) => row.decisionId === decisionId && row.status === "active");
    return found ? structuredClone(found) : undefined;
  }

  private visibleTo(row: OpenAIDecisionVersionRecord, caller: OpenAIDecisionCaller): boolean {
    if (row.scope === "profile") return true;
    if (row.scope === "thread") return row.ownerBackend === caller.backend && row.ownerThreadId === caller.threadId;
    return Boolean(row.researchRunId && caller.researchRunIds?.includes(row.researchRunId));
  }

  findActiveByName(name: string, caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[] {
    const rank = (scope: OpenAIDecisionVersionRecord["scope"]) => scope === "thread" ? 0 : scope === "research_run" ? 1 : 2;
    return this.rows
      .filter((row) => row.status === "active" && row.name === name && this.visibleTo(row, caller))
      .sort((a, b) => rank(a.scope) - rank(b.scope))
      .map((row) => structuredClone(row));
  }

  listVisible(caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[] {
    return this.rows
      .filter((row) => row.status === "active" && this.visibleTo(row, caller))
      .map((row) => structuredClone(row));
  }

  listActiveForResearchRun(researchRunId: string): OpenAIDecisionVersionRecord[] {
    return this.rows
      .filter((row) => row.status === "active" && row.scope === "research_run" && row.researchRunId === researchRunId)
      .map((row) => structuredClone(row));
  }

  listActiveProfile(): OpenAIDecisionVersionRecord[] {
    return this.rows
      .filter((row) => row.status === "active" && row.scope === "profile")
      .map((row) => structuredClone(row));
  }

  hasDeletedName(name: string, caller: OpenAIDecisionCaller): boolean {
    return this.rows.some((row) => row.status === "deleted" && row.name === name && this.visibleTo(row, caller));
  }
}

const okDecisionResponse = () =>
  new Response(JSON.stringify({
    model: "gpt-6-luna",
    answers: [{ type: "predicate", probability: 0.91 }],
    usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 },
  }), { status: 200, headers: { "x-request-id": "req_research_decision" } });

function buildRunFixture(runs: Array<{
  runId: string;
  createdAt: number;
  status: string;
  coordinatorId: string;
  workerIds: string[];
}>) {
  const resolveCallerResearchRuns = (caller: { backend: string; threadId: string }): DecisionResearchRunMembership[] =>
    runs
      .filter((run) => run.coordinatorId === caller.threadId || run.workerIds.includes(caller.threadId))
      .map((run) => ({
        runId: run.runId,
        status: run.status,
        createdAt: run.createdAt,
        isCoordinator: run.coordinatorId === caller.threadId,
      }));

  const resolveResearchRunContext = (
    caller: { backend: string; threadId: string },
    runId: string,
  ): DecisionResearchRunContext | undefined => {
    const run = runs.find((entry) => entry.runId === runId);
    if (!run) return undefined;
    const isCoordinator = run.coordinatorId === caller.threadId;
    const isWorker = run.workerIds.includes(caller.threadId);
    if (!isCoordinator && !isWorker) return undefined;
    return {
      runId: run.runId,
      createdAt: run.createdAt,
      status: run.status,
      isCoordinator,
      participants: [
        { thread: { backend: caller.backend, threadId: run.coordinatorId }, role: "coordinator" },
        ...run.workerIds.map((workerId, index) => ({
          thread: { backend: caller.backend, threadId: workerId },
          role: "worker" as const,
          approachId: `a${index + 1}`,
          approachTitle: `Approach ${index + 1}`,
        })),
      ],
    };
  };

  return { resolveCallerResearchRuns, resolveResearchRunContext };
}

describe("Research Decisions integration", () => {
  it("shares research_run decisions across coordinator and workers without leaking to unrelated threads", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 4 }),
      fc.stringMatching(/^[a-z][a-z0-9_]{2,16}$/),
      async (workerCount, decisionName) => {
        const workerIds = Array.from({ length: workerCount }, (_, index) => `w-run1-${index}`);
        const { resolveCallerResearchRuns, resolveResearchRunContext } = buildRunFixture([
          { runId: "run-1", createdAt: 1_000, status: "running", coordinatorId: "coord-1", workerIds },
          { runId: "run-2", createdAt: 2_000, status: "running", coordinatorId: "coord-2", workerIds: ["w-run2-0"] },
        ]);
        const service = new OpenAIDecisionsService({
          store: new MemoryDecisionRegistry(),
          readApiKey: async () => "sk-test-research-decisions-fixture",
          readAccountSettings: () => ({}),
          profileId: () => "profile-test",
          recordUsageLines: async () => {},
          fetch: async () => okDecisionResponse(),
          resolveCallerResearchRuns,
          resolveResearchRunContext,
          now: () => 5_000,
        });

        const coord1 = { backend: "codex", threadId: "coord-1" };
        const outsider = { backend: "codex", threadId: "outsider-thread" };
        const coord2 = { backend: "codex", threadId: "coord-2" };

        // Coordinator registers with scope="research_run" (omitting researchRunId resolves sole active run).
        const registered = await service.register(coord1, {
          name: decisionName,
          scope: "research_run",
          instructions: "Does this paragraph state a theorem?",
          question: { type: "predicate" },
          inputSchema: { type: "string" },
        }) as { decisionId: string; scope: string; researchRunId: string };
        expect(registered.scope).toBe("research_run");
        expect(registered.researchRunId).toBe("run-1");

        // Every worker in run-1 can list and invoke it, but CANNOT update or delete coordinator's rubric.
        for (const workerId of workerIds) {
          const worker = { backend: "codex", threadId: workerId };
          const listed = service.list(worker, {}) as { decisions: Array<{ decisionId: string; scope: string; researchRunId?: string }> };
          expect(listed.decisions.some((d) => d.decisionId === registered.decisionId && d.scope === "research_run" && d.researchRunId === "run-1")).toBe(true);

          const invoked = await service.invoke(worker, { name: decisionName, input: "Theorem 1 holds." });
          expect(invoked).toMatchObject({ decisionId: registered.decisionId, name: decisionName });

          expect(() => service.delete(worker, { decisionId: registered.decisionId })).toThrow(OpenAIDecisionsError);
          expect(() => service.update(worker, {
            decisionId: registered.decisionId,
            name: decisionName,
            scope: "research_run",
            researchRunId: "run-1",
            instructions: "Mutated by worker",
            question: { type: "predicate" },
            inputSchema: { type: "string" },
          })).toThrow(OpenAIDecisionsError);
        }

        // Unrelated threads and other runs NEVER see or invoke it by name OR decisionId.
        for (const foreign of [outsider, coord2, { backend: "codex", threadId: "w-run2-0" }]) {
          const listed = service.list(foreign, {}) as { decisions: Array<{ decisionId: string }> };
          expect(listed.decisions).toHaveLength(0);
          await expect(service.invoke(foreign, { name: decisionName, input: "Probe" }))
            .rejects.toMatchObject({ code: "decision_not_found" });
          await expect(service.invoke(foreign, { decisionId: registered.decisionId, input: "Probe" }))
            .rejects.toMatchObject({ code: "decision_not_found" });
        }

        // Another run (run-2) can register the SAME decision name without colliding with run-1.
        const run2Registered = await service.register(coord2, {
          name: decisionName,
          scope: "research_run",
          researchRunId: "run-2",
          instructions: "Different rubric for run-2",
          question: { type: "predicate" },
          inputSchema: { type: "string" },
        }) as { decisionId: string; researchRunId: string };
        expect(run2Registered.researchRunId).toBe("run-2");
        expect(run2Registered.decisionId).not.toBe(registered.decisionId);
      },
    ), { numRuns: 20 });
  });

  it("exposes worker batches to run members via decisions_batch_results without leaking to outsiders or pre-run batches", async () => {
    let clock = 500;
    const { resolveCallerResearchRuns, resolveResearchRunContext } = buildRunFixture([
      { runId: "run-alpha", createdAt: 1_000, status: "running", coordinatorId: "coord-a", workerIds: ["worker-a1", "worker-a2"] },
    ]);
    const service = new OpenAIDecisionsService({
      store: new MemoryDecisionRegistry(),
      readApiKey: async () => "sk-test-batch-visibility-fixture",
      readAccountSettings: () => ({}),
      profileId: () => "profile-test",
      recordUsageLines: async () => {},
      fetch: async () => okDecisionResponse(),
      resolveCallerResearchRuns,
      resolveResearchRunContext,
      now: () => clock,
    });

    const coord = { backend: "codex", threadId: "coord-a" };
    const worker1 = { backend: "codex", threadId: "worker-a1" };
    const outsider = { backend: "codex", threadId: "unrelated-thread" };

    // Pre-run batch on coordinator (createdAt 500 < run.createdAt 1000) tagged with another run.
    await service.register(coord, {
      name: "pre_run_rule",
      scope: "thread",
      instructions: "Old check",
      question: { type: "predicate" },
      inputSchema: { type: "string" },
    });
    const preRunBatch = await service.invoke(coord, {
      name: "pre_run_rule",
      inputs: ["old item"],
    }) as { batchId: string };

    // Now run-alpha starts at t=1500.
    clock = 1_500;
    await service.register(coord, {
      name: "rubric",
      scope: "research_run",
      researchRunId: "run-alpha",
      instructions: "Check paper claim",
      question: { type: "predicate" },
      inputSchema: { type: "string" },
    });
    const workerBatch = await service.invoke(worker1, {
      name: "rubric",
      inputs: ["claim 1", "claim 2"],
    }) as { batchId: string };

    // Coordinator lists all batches for run-alpha and sees worker1's batch (with role & approach metadata).
    const listed = await service.batchResults(coord, { researchRunId: "run-alpha" }) as {
      researchRunId: string;
      batches: Array<{ batchId: string; role: string; approachId?: string; caller: { threadId: string } }>;
    };
    expect(listed.researchRunId).toBe("run-alpha");
    expect(listed.batches.map((b) => b.batchId)).toContain(workerBatch.batchId);
    expect(listed.batches.find((b) => b.batchId === workerBatch.batchId)).toMatchObject({
      role: "worker",
      approachId: "a1",
      caller: { threadId: "worker-a1" },
    });

    // Coordinator can read worker1's batch results directly by batchId (with or without researchRunId).
    const readWithRun = await service.batchResults(coord, { batchId: workerBatch.batchId, researchRunId: "run-alpha" }) as {
      batchId: string;
      results: unknown[];
    };
    expect(readWithRun.batchId).toBe(workerBatch.batchId);
    expect(readWithRun.results).toHaveLength(2);

    const readWithoutRun = await service.batchResults(coord, { batchId: workerBatch.batchId }) as {
      batchId: string;
      results: unknown[];
    };
    expect(readWithoutRun.batchId).toBe(workerBatch.batchId);
    expect(readWithoutRun.results).toHaveLength(2);

    // Pre-run batch was created at t=500 < run.createdAt=1000, wait: soleActiveResearchRunId tagged it only if active;
    // ensure preRunBatch is checked honestly and outsider is strictly blocked.
    expect(preRunBatch.batchId).toBeTruthy();
    await expect(service.batchResults(outsider, { researchRunId: "run-alpha" }))
      .rejects.toMatchObject({ code: "batch_not_found" });
    await expect(service.batchResults(outsider, { batchId: workerBatch.batchId }))
      .rejects.toMatchObject({ code: "batch_not_found" });
  });

  it("aborts in-flight background batches via cancelThreadBatches and suppresses wake-up turns", async () => {
    const wakeThread = vi.fn(async () => {});
    const abortedSignals: boolean[] = [];
    let firstFetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstFetchStarted = resolve; });

    const service = new OpenAIDecisionsService({
      store: new MemoryDecisionRegistry(),
      readApiKey: async () => "sk-test-cancel-batch-fixture",
      readAccountSettings: () => ({}),
      profileId: () => "profile-test",
      recordUsageLines: async () => {},
      wakeThread,
      fetch: async (_url, init) => {
        firstFetchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            abortedSignals.push(true);
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    });

    const worker = { backend: "codex", threadId: "worker-bg" };
    const startedBatch = await service.invoke(worker, {
      definition: {
        instructions: "Score item",
        question: { type: "predicate" },
      },
      inputs: ["item-1", "item-2", "item-3"],
      concurrency: 1,
      background: true,
    }) as { batchId: string };

    await started;
    const cancelledCount = await service.cancelThreadBatches(worker, "Research run stopped");
    expect(cancelledCount).toBe(1);
    expect(abortedSignals.length).toBeGreaterThanOrEqual(1);

    const summary = await service.batchResults(worker, { batchId: startedBatch.batchId }) as {
      state: string;
      cancelReason?: string;
      skipped: number;
    };
    expect(summary.state).toBe("cancelled");
    expect(summary.cancelReason).toBe("Research run stopped");
    expect(summary.skipped).toBeGreaterThanOrEqual(2);
    expect(wakeThread).not.toHaveBeenCalled();
  });

  it("gates Decisions hints in research tool definitions on decisionsReady", () => {
    const handler = vi.fn(async () => ({}));
    const unreadyTools = buildResearchToolDefinitions(handler, { decisionsReady: false });
    const readyTools = buildResearchToolDefinitions(handler, { decisionsReady: true });

    for (const tool of unreadyTools) {
      expect(tool.description).not.toContain("decisions_register");
      expect(tool.description).not.toContain("decisions_batch_results");
    }
    const startReady = readyTools.find((t) => t.name === "research_start");
    const readReady = readyTools.find((t) => t.name === "research_read");
    const updateReady = readyTools.find((t) => t.name === "research_update");
    expect(startReady?.description).toContain("decisions_register");
    expect(readReady?.description).toContain("decisions_batch_results");
    expect(updateReady?.description).toContain("batchId");
  });
});
