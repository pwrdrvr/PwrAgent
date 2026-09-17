import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StateDb } from "../state/state-db";
import { attachSqliteWriteMetrics, measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { TokenMiserStore } from "../token-miser/token-miser-store";

const roots: string[] = [];
const databases: StateDb[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const params = {
  threadId: "owner", turnId: "turn", toolUseId: "tool", toolName: "Code Mode",
  output: "PRIVATE_ORIGINAL", replacementCharacters: 10,
  summary: { summary: "PRIVATE_SUMMARY", usefulDetails: [] },
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miser-sqlite-"));
  roots.push(root);
  const stateDb = StateDb.open(path.join(root, "state.db"));
  databases.push(stateDb);
  const legacy = path.join(root, "objects");
  return { root, legacy, stateDb, store: new TokenMiserStore(legacy, { stateDb }) };
}
it("stores accounting in the profile database without creating per-result files", async () => {
  const { store, legacy, stateDb } = await fixture();
  const entry = await store.store(params);
  const row = stateDb.raw.prepare("SELECT payload FROM token_miser_objects WHERE object_id = ?").get(entry.objectId) as { payload: string };
  expect(JSON.parse(row.payload)).toMatchObject({ objectId: entry.objectId, threadId: "owner" });
  expect(row.payload).not.toContain("PRIVATE_");
  await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
});
it("reads committed accounting across connections without touching legacy files", async () => {
  const { store, root, legacy } = await fixture();
  const stateDb = StateDb.open(path.join(root, "state.db"));
  databases.push(stateDb);
  const reader = new TokenMiserStore(legacy, { stateDb });
  const entry = await store.store(params);
  const read = vi.spyOn(fs, "readFile");
  const list = vi.spyOn(fs, "readdir");
  expect(await reader.listMetadata("owner")).toHaveLength(1);
  await store.stopReplayTracking({ objectId: entry.objectId, stoppedAt: 123 });
  expect((await reader.readMetadata(entry.objectId, "owner"))?.replayTrackingStoppedAt).toBe(123);
  expect(read).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

it("migrates threaded and flat records, observations and archive state without retaining content", async () => {
  const { store, legacy, stateDb } = await fixture();
  const entry = (await store.stage(params)).metadata;
  const key = createHash("sha256").update("owner").digest("hex");
  const thread = path.join(legacy, "threads", key);
  const observations = path.join(thread, "code-mode-observations");
  await fs.mkdir(observations, { recursive: true });
  await fs.writeFile(path.join(legacy, `${entry.objectId}.json`), JSON.stringify(entry));
  await fs.writeFile(path.join(thread, `${entry.objectId}.json`), JSON.stringify({ ...entry, retrievedCharacters: 77, summary: params.summary }));
  await fs.writeFile(path.join(legacy, `${entry.objectId}.txt`), params.output);
  await fs.writeFile(path.join(thread, "archived"), "archived-generation");
  await fs.writeFile(path.join(thread, "retention-generation"), "older-generation");
  await fs.writeFile(path.join(observations, "observation.json"), JSON.stringify({
    version: 1, observationId: "observation", threadId: "owner", turnId: "turn",
    callId: "call", cellId: "cell", createdAt: 123, outputCharacters: 100,
    maxOutputTokens: 100, scriptStatus: "completed", retrieval: false,
    capturedNestedInvocationCount: 1, script: "PRIVATE_SCRIPT", outputPreview: "PRIVATE_PREVIEW",
  }));
  await store.prune({ maxAgeMs: 0, maxBytes: 0 });
  expect((await store.readMetadata(entry.objectId))?.retrievedCharacters).toBe(77);
  expect(await store.listCodeModeObservations("owner")).toHaveLength(1);
  expect(JSON.stringify(stateDb.raw.prepare("SELECT payload FROM token_miser_objects UNION ALL SELECT payload FROM token_miser_observations").all())).not.toContain("PRIVATE_");
  await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(store.stage(params)).rejects.toThrow("archived");
  await store.restoreThread("owner");
  expect(await store.readAll({ objectId: entry.objectId, threadId: "owner" })).toBeUndefined();
});

it("uses the thread index for scoped accounting and observation reads", async () => {
  const { stateDb } = await fixture();
  const objects = stateDb.raw.prepare("EXPLAIN QUERY PLAN SELECT payload FROM token_miser_objects WHERE thread_id = ? ORDER BY created_at DESC").all("owner");
  const observations = stateDb.raw.prepare("EXPLAIN QUERY PLAN SELECT payload FROM token_miser_observations WHERE thread_id = ? ORDER BY created_at").all("owner");
  expect(JSON.stringify(objects)).toContain("idx_token_miser_objects_thread");
  expect(JSON.stringify(observations)).toContain("idx_token_miser_observations_thread");
});

it("budgets durable acceptance, observations, replay buffering and turn flushes", async () => {
  const { store, root, stateDb } = await fixture();
  attachSqliteWriteMetrics({ db: stateDb.raw, dbPath: path.join(root, "state.db") });
  const { result: entry, writes: accepted } = await measureSqliteWrites(() => store.store(params));
  const { writes: observed } = await measureSqliteWrites(() => store.recordCodeModeObservation({
    threadId: "owner", turnId: "turn", callId: "call", cellId: "cell", outputCharacters: 100,
    maxOutputTokens: 100, scriptStatus: "completed", retrieval: false, capturedNestedInvocationCount: 1,
  }));
  const entries = [entry];
  for (let index = 0; index < 9; index += 1) entries.push(await store.store({ ...params, toolUseId: `tool-${index}` }));
  const { writes: replayed } = await measureSqliteWrites(async () => {
    for (let request = 1; request <= 100; request += 1) {
      for (const object of entries) await store.recordParentModelRequest({ objectId: object.objectId, cumulativeInputTokens: request * 100 });
    }
  });
  const { writes: flushed } = await measureSqliteWrites(() => store.flushThread("owner"));
  expectSqliteWriteBudget({ scenario: "token-miser-accept", note: "One accepted gate; original content stays in memory.", writes: accepted });
  expectSqliteWriteBudget({ scenario: "token-miser-observation", note: "One Code Mode output observation.", writes: observed });
  expectSqliteWriteBudget({ scenario: "token-miser-replay-buffer", note: "100 model requests across ten gates, buffered in RAM.", writes: replayed });
  expectSqliteWriteBudget({ scenario: "token-miser-turn-flush", note: "Flush ten gate counters in one turn-boundary transaction.", writes: flushed });
});
