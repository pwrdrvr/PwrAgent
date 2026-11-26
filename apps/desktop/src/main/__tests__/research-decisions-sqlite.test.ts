import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
