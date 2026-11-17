import { rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

// Register, update and delete run once per Agent tool call and are one commit
// each. Invoke writes nothing itself: usage is summed in memory and written
// as one transaction per 50 requests or 60 seconds, never per request.
it("costs one commit per registry change and one per 50 invoked requests", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("openai-decisions-writes-");
  const db = StateDb.open(fixture.dbPath);
  try {
    const overlay = new SqliteOverlayStore(db);
    const service = new OpenAIDecisionsService({
      store: new OpenAIDecisionStore(db),
      readApiKey: async () => "sk-test-write-budget-fixture-key",
      readAccountSettings: () => ({}),
      profileId: () => "test-profile",
      recordUsageLines: async (lines) => { await overlay.upsertThreadUsageLines({ lines }); },
      fetch: async () => new Response(JSON.stringify({
        model: "gpt-6-luna",
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 },
      }), { status: 200, headers: { "x-request-id": "req_budget" } }),
    });
    const caller = { backend: "codex", threadId: "thread-a" };
    const definition = {
      name: "budget_rule",
      instructions: "Is this urgent?",
      question: { type: "predicate" },
      inputSchema: { type: "string" },
    };
    const scenarios: Array<[string, string, () => unknown]> = [
      ["openai-decisions-register", "one decisions_register tool call. Agent-initiated, never per turn or timer: ~1.2 MB/day at 100 registrations/day.", () => service.register(caller, definition)],
      ["openai-decisions-update", "one decisions_update tool call (supersede + insert, one transaction): ~1.2 MB/day at 100 updates/day.", () =>
        service.update(caller, { ...definition, instructions: "Is this urgent today?" })],
      ["openai-decisions-invoke-batched", "120 decisions_invoke calls on one decision: usage summed in memory and written at 50, 100 and the final flush, one ledger line each. ~0.2 MB per 120 invokes, ~1.7 MB/day at 1,000 invokes/day.", async () => {
        for (let call = 0; call < 120; call += 1) {
          await service.invoke(caller, { name: "budget_rule", input: `Server down ${call}` });
        }
        await service.flushUsage();
      }],
      ["openai-decisions-delete", "one decisions_delete tool call (every version soft-deleted in one statement): ~0.8 MB/day at 100 deletes/day.", () => service.delete(caller, { name: "budget_rule" })],
    ];
    for (const [scenario, note, run] of scenarios) {
      const { writes } = await measureSqliteWrites(run);
      expect(writes.commits).toBe(scenario === "openai-decisions-invoke-batched" ? 3 : 1);
      expectSqliteWriteBudget({ scenario, note, writes });
    }
  } finally {
    db.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

// A batch's card on its thread is the one write a batch adds. It is
// rewritten at start, at each further tenth of its items, and at the end,
// so it costs at most 11 commits whatever the batch's size.
it("costs at most 11 card commits per batch, not one per item", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("openai-decisions-card-writes-");
  const db = StateDb.open(fixture.dbPath);
  try {
    const overlay = new SqliteOverlayStore(db);
    let wakes = 0;
    const service = new OpenAIDecisionsService({
      store: new OpenAIDecisionStore(db),
      readApiKey: async () => undefined,
      readSystemOneTarget: async () => ({ endpoint: "https://jev.test", model: "jev-latest", apiKey: "sk-test-card-budget-key" }),
      readAccountSettings: () => ({}),
      profileId: () => "test-profile",
      recordUsageLines: async () => undefined,
      // The registry's publishDecisionBatchCard writes the same row.
      reportBatch: async (report) => {
        await overlay.upsertThreadSubAgent({
          backend: "codex",
          threadId: report.caller.threadId,
          subAgent: {
            monitorId: `system:decision-batch:${report.batchId}`,
            task: report.task,
            status: report.status,
            createdAt: report.createdAt,
            updatedAt: report.updatedAt,
            agentName: "PwrAgent",
            lastMessage: report.message,
          },
        });
      },
      wakeThread: async () => { wakes += 1; },
      fetch: async () => new Response(JSON.stringify({ answers: { q1: { noul: 0.5 } } }), { status: 200 }),
    });
    const caller = { backend: "codex", threadId: "thread-a" };
    const { writes } = await measureSqliteWrites(async () => {
      await service.invoke(caller, {
        definition: { provider: "jev", instructions: "Is this urgent?", question: { type: "predicate" } },
        inputs: Array.from({ length: 500 }, (_, index) => `Server down ${index}`),
      });
    });
    expect(writes.commits).toBe(11);
    expect(wakes).toBe(0);
    expectSqliteWriteBudget({
      scenario: "openai-decisions-batch-card",
      note: "one 500-item decisions_invoke batch: its thread card written at start, at each tenth, and at the end. Item results stay in memory. 11 commits (~0.23 MB WAL) per batch whatever its size; ~1.2 MB/day at 5 large batches/day, ~12 MB/day at 50.",
      writes,
    });
  } finally {
    db.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});
