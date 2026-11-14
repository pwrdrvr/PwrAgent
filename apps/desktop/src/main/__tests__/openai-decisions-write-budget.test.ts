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

// Each operation runs once per Agent tool call: never per turn, per streamed
// event, or on a timer. Register, update and delete are one commit each;
// invoke reads the registry and writes one usage line per HTTP attempt that
// returned usage (the ledger's usage line and its turn row, one transaction).
it("costs one commit per registry change and one per invoked request", async () => {
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
      recordUsageLine: async (line) => { await overlay.upsertThreadUsageLine({ line }); },
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
      ["openai-decisions-invoke", "one decisions_invoke tool call that returned usage: the registry read plus one usage line and its turn row, the same ledger write as any helper monitor line. ~7 MB/day at 100 invokes/day, ~70 MB/day at 1,000.", async () =>
        await service.invoke(caller, { name: "budget_rule", input: "Server down" })],
      ["openai-decisions-delete", "one decisions_delete tool call (every version soft-deleted in one statement): ~0.8 MB/day at 100 deletes/day.", () => service.delete(caller, { name: "budget_rule" })],
    ];
    for (const [scenario, note, run] of scenarios) {
      const { writes } = await measureSqliteWrites(run);
      expect(writes.commits).toBe(1);
      expectSqliteWriteBudget({ scenario, note, writes });
    }
  } finally {
    db.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});
