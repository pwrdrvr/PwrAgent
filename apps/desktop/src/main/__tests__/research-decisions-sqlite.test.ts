import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decisionProvidersReadiness } from "@pwragent/shared/decision-models";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";
import * as batchFiles from "../openai-decisions/decision-batch-files";
import { OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";

describe("OpenAIDecisionStore research_run SQLite schema and migration", () => {
  it("upgrades legacy openai_decision_versions tables and persists research_run scope in SQLite", () => {
    const fixture = createTempStateDb("openai-decisions-research-scope-");
    const db = StateDb.open(fixture.dbPath);
    try {
      // Simulate a pre-migration database with the old 2-scope CHECK constraint.
      db.raw.exec(`
        DROP TABLE openai_decision_versions;
        CREATE TABLE openai_decision_versions (
          decision_id       TEXT NOT NULL,
          version           INTEGER NOT NULL,
          name              TEXT NOT NULL,
          scope             TEXT NOT NULL CHECK (scope IN ('profile', 'thread')),
          owner_backend     TEXT NOT NULL,
          owner_thread_id   TEXT,
          status            TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
          provider          TEXT NOT NULL DEFAULT 'openai',
          questions_json    TEXT NOT NULL,
          prefix_text       TEXT,
          input_schema_json TEXT NOT NULL,
          prompt_cache_key  TEXT NOT NULL,
          created_at        INTEGER NOT NULL,
          PRIMARY KEY (decision_id, version),
          CHECK (scope = 'profile' OR owner_thread_id IS NOT NULL)
        );
        INSERT INTO openai_decision_versions (
          decision_id, version, name, scope, owner_backend, owner_thread_id, status, provider,
          questions_json, prefix_text, input_schema_json, prompt_cache_key, created_at
        ) VALUES (
          'legacy-id', 1, 'legacy_rule', 'profile', 'codex', NULL, 'active', 'openai',
          '[{"type":"predicate","instructions":"Legacy?"}]', NULL, '{"type":"string"}', 'abc', 100
        );
      `);
      db.close();

      // Reopen triggers automatic schema migration.
      const reopened = StateDb.open(fixture.dbPath);
      try {
        const store = new OpenAIDecisionStore(reopened);
        expect(store.getActive("legacy-id")?.name).toBe("legacy_rule");

        store.insertFirstVersion({
          decisionId: "run-dec-1",
          version: 1,
          name: "paper_rubric",
          scope: "research_run",
          ownerBackend: "codex",
          ownerThreadId: "coord-1",
          researchRunId: "run-38",
          status: "active",
          provider: "openai",
          questions: [{ type: "predicate", instructions: "Is proof valid?" }],
          inputSchema: { type: "string" },
          promptCacheKey: "k1",
          createdAt: 200,
        });

        expect(store.listActiveForResearchRun("run-38").map((r) => r.decisionId)).toEqual(["run-dec-1"]);
        expect(store.listVisible({ backend: "codex", threadId: "worker-1", researchRunIds: ["run-38"] })
          .map((r) => r.decisionId)).toContain("run-dec-1");
        expect(store.listVisible({ backend: "codex", threadId: "outsider", researchRunIds: [] })
          .map((r) => r.decisionId)).not.toContain("run-dec-1");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("caches on-disk participant batch JSONL files across repeated researchRunDecisionsSnapshot, researchRunBatchPage, and researchRunResultsFile calls", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "research-decisions-cache-"));
    const dbFixture = createTempStateDb("research-decisions-cache-db-");
    const db = StateDb.open(dbFixture.dbPath);
    try {
      const store = new OpenAIDecisionStore(db);
      const batchDir = (caller: { backend: string; threadId: string }) =>
        path.join(tempDir, caller.backend, caller.threadId);
      const ctx = {
        runId: "run-cache",
        createdAt: 1_000,
        status: "running" as const,
        isCoordinator: true,
        participants: [
          { thread: { backend: "codex", threadId: "coord-1" }, role: "coordinator" as const },
          { thread: { backend: "codex", threadId: "worker-1" }, role: "worker" as const, approachId: "a1", approachTitle: "A1" },
        ],
      };
      const writerService = new OpenAIDecisionsService({
        store,
        readApiKey: async () => "sk-test-cache-fixture",
        readAccountSettings: () => ({}),
        profileId: () => "profile-test",
        recordUsageLines: async () => {},
        batchResultsDirectory: batchDir,
        resolveCallerResearchRuns: () => [{ runId: "run-cache", status: "running", createdAt: 1_000, isCoordinator: true }],
        resolveResearchRunContext: () => ctx,
        fetch: async () => new Response(JSON.stringify({
          id: "dec_cache",
          model: "gpt-6-luna",
          answers: [{ type: "predicate", value: "yes", probability: 0.9 }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });

      await writerService.register({ backend: "codex", threadId: "coord-1" }, {
        name: "cache_rubric",
        scope: "research_run",
        researchRunId: "run-cache",
        instructions: "Valid?",
        question: { type: "predicate" },
        inputSchema: { type: "string" },
      });
      const created = await writerService.invoke({ backend: "codex", threadId: "worker-1" }, {
        name: "cache_rubric",
        inputs: ["item 1", "item 2"],
      }) as { batchId: string };
      await writerService.close();

      // Fresh service instance simulates restart so the batch lives on disk only (not in memory).
      const readerService = new OpenAIDecisionsService({
        store,
        readApiKey: async () => "sk-test-cache-fixture",
        readAccountSettings: () => ({}),
        profileId: () => "profile-test",
        recordUsageLines: async () => {},
        batchResultsDirectory: batchDir,
      });
      const readSpy = vi.spyOn(batchFiles, "readDecisionBatchFile");
      try {
        const readiness = decisionProvidersReadiness({
          openaiEnabled: true,
          openaiKey: true,
          jevKey: false,
          decisionModels: { model: "off", local: { enabled: false }, jev: { enabled: false } },
        });
        const snap1 = await readerService.researchRunDecisionsSnapshot(ctx, readiness);
        const snap2 = await readerService.researchRunDecisionsSnapshot(ctx, readiness);
        const resultsPath = await readerService.researchRunResultsFile(ctx, created.batchId);
        expect(snap1.batches.map((b) => b.batchId)).toEqual([created.batchId]);
        expect(snap2.batches.map((b) => b.batchId)).toEqual([created.batchId]);
        expect(resultsPath).toContain(created.batchId);
        // Only ONE disk parse across 2 snapshot polls + 1 resultsFile lookup!
        expect(readSpy).toHaveBeenCalledTimes(1);

        // Two page reads on the same unchanged file parse it only once via railFileRecordFor.
        const page1 = await readerService.researchRunBatchPage(ctx, { batchId: created.batchId, status: "all", from: 0, limit: 1 });
        const page2 = await readerService.researchRunBatchPage(ctx, { batchId: created.batchId, status: "all", from: 1, limit: 1 });
        expect(page1.items).toHaveLength(1);
        expect(page2.items).toHaveLength(1);
        expect(readSpy).toHaveBeenCalledTimes(2);
      } finally {
        readSpy.mockRestore();
        await readerService.close();
      }
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(dbFixture.tempDir, { recursive: true, force: true });
    }
  });

  it("refreshes MCP research tool descriptions dynamically when decision readiness changes after boot", async () => {
    let decisionsReady = false;
    const server = new AgentToolMcpServer({
      resolveCallContext: () => ({ backend: "claude", threadId: "t1", turnId: "turn-1" }),
      resolveCatalogs: async () => resolveAgentToolCatalogs({
        researchHandler: async () => ({}),
        researchDecisionsReady: await Promise.resolve(decisionsReady),
      }),
    });
    const listTools = async () =>
      await (server as unknown as {
        resolveMcpTools: (ctx: { backend: "claude"; threadId: string }) => Promise<Array<{ name: string; description: string }>>;
      }).resolveMcpTools({ backend: "claude", threadId: "t1" });

    const before = await listTools();
    expect(before.find((t) => t.name === "research_start")?.description).not.toContain("decisions_register");

    decisionsReady = true;
    const after = await listTools();
    expect(after.find((t) => t.name === "research_start")?.description).toContain("decisions_register");

    decisionsReady = false;
    const disabledAgain = await listTools();
    expect(disabledAgain.find((t) => t.name === "research_start")?.description).not.toContain("decisions_register");
  });
});
