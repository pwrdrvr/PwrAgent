import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let db: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;

beforeEach(() => { db = openInMemoryStateDb(); store = new SqliteOverlayStore(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); if (tempDir) removeTempStateDbDir(tempDir); tempDir = undefined; });

function seed(id: string, backend = "codex", target = db.raw, model = "fixture-model") {
  target.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)")
    .run(`${encodeURIComponent(backend)}:${id}`, JSON.stringify({ backend, threadId: id, model }));
}

function pending(id: string, status: string, target = db.raw, backend = "codex") {
  target.prepare(`INSERT OR REPLACE INTO pr_auto_dispatch_claims
    (backend, thread_id, pr_key, fingerprint, status, scheduled_at, created_at, updated_at, payload)
    VALUES (?, ?, 'pr', 'fingerprint', ?, 1, 1, 1, ?)`)
    .run(backend, id, status, JSON.stringify({ pending: { fingerprint: "fingerprint" }, prompt: "fixture" }));
}

describe("thread listing overlay reads", () => {
  it("preserves absent optional cleanup fields instead of manufacturing null tombstones", async () => {
    await store.observeArchivedThreads([{ backend: "codex", threadId: "archived" }], 1000);
    const identity = { backend: "codex" as const, threadId: "archived" };
    const projected = (await store.getArchiveCleanupOverlayStates({ backend: "codex", threadIds: ["archived", "missing"] })).archived;
    expect(projected).toMatchObject({ ...identity, extraLinkedDirectories: [] });
    for (const field of ["archiveTombstonedAt", "parentThreadId", "parentThreadBackend", "parentThreadInstanceId"] as const) {
      expect(projected?.[field]).toBeUndefined();
      expect(Object.hasOwn(projected!, field)).toBe(false);
    }
    await store.setThreadArchiveTombstone({ ...identity, archivedAt: 2000 });
    expect((await store.getArchiveCleanupOverlayStates({ backend: "codex", threadIds: ["archived"] })).archived?.archiveTombstonedAt).toBe(2000);
    await store.setThreadArchiveTombstone({ ...identity, restoredAt: 3000 });
    expect((await store.getArchiveCleanupOverlayStates({ backend: "codex", threadIds: ["archived"] })).archived?.archiveTombstonedAt).toBeUndefined();
  });

  it("budgets fresh listing projections without parsing transcript histories", async () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => String(index));
    const history = "contrived history ".repeat(400);
    db.raw.transaction(() => {
      for (const id of ids) {
        seed(id);
        const payload = {
          backend: "codex", threadId: id, model: "fixture-model", extraLinkedDirectories: [],
          parentThreadId: "parent", parentThreadBackend: "acp:grok", parentThreadInstanceId: "peer",
          worktreeSnapshots: [{ id: "snapshot", worktreePath: "/contrived/worktree" }],
          handoffOrigin: { groupingMode: "subthread" }, subAgents: [], pinnedRank: "a",
          immutableUsageActivities: [{ text: history }], managedReviewEntries: [{ text: history }],
          permissionTransitionLog: [{ note: history }], messagingBindingTransitionLog: [{ note: history }],
          turnFailureLog: [{ message: history }], questionnaireActivityLog: [{ text: history }],
        };
        db.raw.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?")
          .run(JSON.stringify(payload), `codex:${id}`);
      }
    })();
    const { immutableUsageActivities: _usage, managedReviewEntries: _reviews,
      permissionTransitionLog: _permissions, messagingBindingTransitionLog: _bindings,
      turnFailureLog: _failures, questionnaireActivityLog: _questions, ...metadata } =
      (await store.getThreadOverlayState({ backend: "codex", threadId: "0" }))!;
    const sql = vi.spyOn(db.raw, "prepare");
    const parse = vi.spyOn(JSON, "parse");
    const read = () => store.getThreadListingOverlayStates({ backend: "codex", threadIds: [...ids, "0", "missing"] });
    for (let refresh = 0; refresh < 3; refresh++) {
      const rows = await read();
      expect(Object.keys(rows)).toHaveLength(1_001);
      expect(rows["0"]).toMatchObject({ model: "fixture-model", parentThreadBackend: "acp:grok",
        parentThreadInstanceId: "peer", worktreeSnapshots: [{ id: "snapshot" }], pinnedRank: "a" });
      expect(rows["0"]).toEqual(metadata);
      expect(rows["0"]?.immutableUsageActivities).toBeUndefined();
      expect(rows.missing).toBeUndefined();
      rows["0"]!.extraLinkedDirectories.push({ id: "mutation", label: "mutation", kind: "local", path: "/contrived/mutation" });
    }
    expect(sql).toHaveBeenCalledTimes(9); // three indexed batches, no pending-claim payload reads
    expect(parse).toHaveBeenCalledTimes(3_000);
    const bytes = parse.mock.calls.reduce((sum, [payload]) => sum + Buffer.byteLength(payload), 0);
    expect(bytes).toBeLessThan(1_500_000);
    expect(parse.mock.calls.some(([payload]) => payload.includes("contrived history"))).toBe(false);
  });

  it.each([10, 100, 1_000])("batches %i overlays without per-thread SQL or extra parses", async (count) => {
    const ids = Array.from({ length: count }, (_, i) => String(i));
    db.raw.transaction(() => { for (const id of ids) seed(id); })();
    const prepareStatement = db.raw.prepare.bind(db.raw);
    let reads = 0;
    const plans: string[] = [];
    const prepare = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepareStatement(sql);
      const all = statement.all.bind(statement);
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
        reads++;
        plans.push(...(prepareStatement(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
          .map((row) => row.detail));
        return all(...params);
      });
      vi.spyOn(statement, "get").mockImplementation((...params: unknown[]) => { reads++; return get(...params); });
      return statement;
    });
    const parse = vi.spyOn(JSON, "parse");
    for (let refresh = 0; refresh < 3; refresh++) {
      const rows = await store.getThreadOverlayStates({ backend: "codex", threadIds: [...ids, ids[0]!] });
      expect(Object.keys(rows)).toHaveLength(count);
      expect(rows["0"]?.model).toBe("fixture-model");
    }
    expect(prepare).toHaveBeenCalledTimes(6 * Math.ceil(count / 500));
    expect(reads).toBe(6 * Math.ceil(count / 500));
    expect(plans.some((plan) => /SEARCH threads USING INDEX/.test(plan))).toBe(true);
    expect(plans.some((plan) => /SEARCH claims USING INDEX/.test(plan))).toBe(true);
    expect(plans.some((plan) => /SCAN (threads|claims)/.test(plan))).toBe(false);
    // Fresh mutable overlays remain O(n); duplicates add no parsing work.
    expect(parse).toHaveBeenCalledTimes(3 * count);
  });

  it("preserves missing keys, provider identity, and pending-claim semantics", async () => {
    seed("same"); seed("same", "acp:grok"); pending("same", "pending");
    const codex = await store.getThreadOverlayStates({ backend: "codex", threadIds: ["same", "missing", "__proto__"] });
    expect(codex.same?.prAutoDispatchPending?.fingerprint).toBe("fingerprint");
    expect(Object.hasOwn(codex, "missing")).toBe(true);
    expect(Object.hasOwn(codex, "__proto__")).toBe(true);
    expect(codex.missing).toBeUndefined();
    const acp = await store.getThreadOverlayStates({ backend: "acp:grok", threadIds: ["same"] });
    expect(acp.same?.backend).toBe("acp:grok");
    expect(acp.same?.prAutoDispatchPending).toBeUndefined();
    pending("same", "dispatching");
    expect((await store.getThreadOverlayStates({ backend: "codex", threadIds: ["same"] })).same?.prAutoDispatchPending).toBeUndefined();
    const prepare = vi.spyOn(db.raw, "prepare");
    expect(await store.getThreadOverlayStates({ backend: "codex", threadIds: [] })).toEqual({});
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["getThreadOverlayStates", "getThreadListingOverlayStates"] as const)("%s observes external changes, deletion and mutable return isolation", async (method) => {
    db.close();
    const temp = createTempStateDb("pwragent-list-reads-"); tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath); store = new SqliteOverlayStore(db);
    const other = new Database(temp.dbPath);
    const read = () => store[method]({ backend: "codex", threadIds: ["same"] });
    try {
      seed("same");
      (await read()).same!.model = "mutated";
      expect((await read()).same?.model).toBe("fixture-model");
      seed("same", "codex", other, "External"); pending("same", "pending", other);
      expect((await read()).same?.model).toBe("External");
      if (method === "getThreadOverlayStates") expect((await read()).same?.prAutoDispatchPending?.fingerprint).toBe("fingerprint");
      pending("same", "dispatched", other);
      expect((await read()).same?.prAutoDispatchPending).toBeUndefined();
      other.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:same");
      expect((await read()).same).toBeUndefined();
    } finally { other.close(); }
  });

  it("matches individual reads for legacy normalization and invalid pending payloads", async () => {
    seed("legacy");
    db.raw.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?").run(JSON.stringify({
      backend: "codex", threadId: "legacy",
      agent: { name: "Task", instructions: "Work only on the delegated task from the parent PwrAgent thread. Keep progress and results in this thread." },
      handoffOrigin: { taskTitle: "Task" },
    }), "codex:legacy");
    pending("legacy", "pending");
    db.raw.prepare("UPDATE pr_auto_dispatch_claims SET payload = 'invalid'").run();
    const individual = store["getThread"]("codex:legacy");
    expect(individual?.agent).toBeUndefined();
    expect((await store.getThreadOverlayStates({ backend: "codex", threadIds: ["legacy"] })).legacy).toEqual(individual);
  });

  it.each(["getThreadOverlayStates", "getThreadListingOverlayStates"] as const)("%s does not retain transaction results after rollback", async (method) => {
    seed("same");
    db.raw.exec("BEGIN");
    seed("same", "codex", db.raw, "Uncommitted");
    expect((await store[method]({ backend: "codex", threadIds: ["same"] })).same?.model).toBe("Uncommitted");
    db.raw.exec("ROLLBACK");
    expect((await store[method]({ backend: "codex", threadIds: ["same"] })).same?.model).toBe("fixture-model");
  });
});
