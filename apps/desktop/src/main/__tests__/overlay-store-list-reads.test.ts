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

  it("observes external changes and deletion on the next read and isolates returned mutations", async () => {
    db.close();
    const temp = createTempStateDb("pwragent-list-reads-"); tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath); store = new SqliteOverlayStore(db);
    const other = new Database(temp.dbPath);
    const read = () => store.getThreadOverlayStates({ backend: "codex", threadIds: ["same"] });
    try {
      seed("same");
      (await read()).same!.model = "mutated";
      expect((await read()).same?.model).toBe("fixture-model");
      seed("same", "codex", other, "External"); pending("same", "pending", other);
      expect((await read()).same).toMatchObject({ model: "External", prAutoDispatchPending: { fingerprint: "fingerprint" } });
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

  it("does not retain transaction results after rollback", async () => {
    seed("same");
    db.raw.exec("BEGIN");
    seed("same", "codex", db.raw, "Uncommitted");
    expect((await store.getThreadOverlayStates({ backend: "codex", threadIds: ["same"] })).same?.model).toBe("Uncommitted");
    db.raw.exec("ROLLBACK");
    expect((await store.getThreadOverlayStates({ backend: "codex", threadIds: ["same"] })).same?.model).toBe("fixture-model");
  });
});
