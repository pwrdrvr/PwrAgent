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

function seed(scope = "all", keys = ["codex:known"], target = db.raw) {
  const payload = JSON.stringify({ knownThreadKeys: keys, lastSnapshotHash: "fixture-hash" });
  target.prepare("INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)").run(scope, payload);
  return Buffer.byteLength(payload, "utf8");
}

function payloadReads() {
  const counts = { reads: 0, bytes: 0 };
  const prepare = db.raw.prepare.bind(db.raw);
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (/SELECT payload FROM backends/.test(sql)) {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
        const row = get(...args) as { payload: string } | undefined;
        counts.reads++;
        counts.bytes += Buffer.byteLength(row?.payload ?? "", "utf8");
        return row;
      });
    }
    return statement;
  });
  return counts;
}

const read = () => store["getBackend"]("all");

describe("navigation backend payload reuse", () => {
  it.each([10, 1000, 10000])("reads %i known identities once across 15 unchanged index builds", (size) => {
    const bytes = seed("all", Array.from({ length: size }, (_, i) => `codex:fixture-${i}`));
    const counts = payloadReads();
    for (let i = 0; i < 15; i++) {
      const result = store.readNavigationQueryIndex({ backend: "all", threads: [{
        id: "fixture-0", source: "codex", title: "Fixture", titleSource: "explicit", updatedAt: 1, linkedDirectories: [],
      }] });
      expect(result.threads).toHaveLength(1);
      result.threads[0]!.title = "caller mutation";
    }
    expect(counts).toEqual({ reads: 1, bytes });
  });

  it("retains the backend cache across unrelated local thread writes", () => {
    const bytes = seed();
    const counts = payloadReads();
    read();
    db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:other", "{}");
    expect(read()?.knownThreadKeys).toEqual(["codex:known"]);
    expect(counts).toEqual({ reads: 1, bytes });
  });

  it("owns returned arrays and observes local inserts, updates, deletes, and scope identity", () => {
    seed(); seed("codex", ["codex:scoped"]);
    const first = read()!;
    first.knownThreadKeys.push("codex:caller-only"); first.lastSnapshotHash = "caller hash";
    expect(read()).toEqual({ knownThreadKeys: ["codex:known"], lastSnapshotHash: "fixture-hash" });
    expect(store["getBackend"]("codex")?.knownThreadKeys).toEqual(["codex:scoped"]);
    expect(read()?.knownThreadKeys).toEqual(["codex:known"]);
    db.raw.prepare("UPDATE backends SET payload = ? WHERE scope = ?")
      .run(JSON.stringify({ knownThreadKeys: ["acp%3Agrok:known"], lastSnapshotHash: "updated" }), "all");
    expect(read()).toEqual({ knownThreadKeys: ["acp:grok:known"], lastSnapshotHash: "updated" });
    db.raw.prepare("DELETE FROM backends WHERE scope = ?").run("all");
    expect(read()).toBeUndefined(); expect(read()).toBeUndefined();
    seed("all", ["codex:inserted"]);
    expect(read()?.knownThreadKeys).toEqual(["codex:inserted"]);
    const state = { knownThreadKeys: ["codex:local"], lastSnapshotHash: "local" };
    store["putBackend"]("all", state);
    state.knownThreadKeys.push("codex:later-mutation");
    expect(read()?.knownThreadKeys).toEqual(["codex:local"]);
  });

  it("observes external commits and deletion without a TTL", () => {
    db.close();
    const temp = createTempStateDb("pwragent-backend-cache-"); tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath); store = new SqliteOverlayStore(db);
    const other = new Database(temp.dbPath);
    try {
      seed(); read();
      seed("all", ["codex:external"], other);
      expect(read()?.knownThreadKeys).toEqual(["codex:external"]);
      other.prepare("DELETE FROM backends WHERE scope = ?").run("all");
      expect(read()).toBeUndefined();
      seed("all", ["codex:returned"], other);
      expect(read()?.knownThreadKeys).toEqual(["codex:returned"]);
    } finally { other.close(); }
  });

  it("shares local invalidation across stores and caches missing scopes", () => {
    const otherStore = new SqliteOverlayStore(db);
    const counts = payloadReads();
    expect(read()).toBeUndefined(); expect(read()).toBeUndefined();
    expect(counts).toEqual({ reads: 1, bytes: 0 });
    otherStore["putBackend"]("all", { knownThreadKeys: ["codex:other-store"] });
    expect(read()?.knownThreadKeys).toEqual(["codex:other-store"]);
    otherStore["getBackend"]("all");
    store["putBackend"]("all", { knownThreadKeys: ["codex:this-store"] });
    expect(otherStore["getBackend"]("all")?.knownThreadKeys).toEqual(["codex:this-store"]);
  });

  it("respects an existing SQLite snapshot while an external writer commits", () => {
    db.close();
    const temp = createTempStateDb("pwragent-backend-snapshot-"); tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath); store = new SqliteOverlayStore(db);
    const other = new Database(temp.dbPath);
    try {
      seed(); read();
      db.raw.exec("BEGIN");
      expect(read()?.knownThreadKeys).toEqual(["codex:known"]);
      seed("all", ["codex:external"], other);
      expect(read()?.knownThreadKeys).toEqual(["codex:known"]);
      db.raw.exec("COMMIT");
      expect(read()?.knownThreadKeys).toEqual(["codex:external"]);
    } finally { other.close(); }
  });

  it.each([false, true])("does not publish transaction state after rollback (warm=%s)", (warm) => {
    seed(); if (warm) read();
    db.raw.exec("BEGIN");
    seed("all", ["codex:uncommitted"]);
    expect(read()?.knownThreadKeys).toEqual(["codex:uncommitted"]);
    db.raw.exec("SAVEPOINT nested");
    seed("all", ["codex:nested"]);
    expect(read()?.knownThreadKeys).toEqual(["codex:nested"]);
    db.raw.exec("ROLLBACK TO nested");
    expect(read()?.knownThreadKeys).toEqual(["codex:uncommitted"]);
    db.raw.exec("ROLLBACK");
    expect(read()?.knownThreadKeys).toEqual(["codex:known"]);
    db.raw.transaction(() => { seed("all", ["codex:committed"]); read(); })();
    expect(read()?.knownThreadKeys).toEqual(["codex:committed"]);
    // A rollback without an intervening read must also leave no stale cache.
    db.raw.exec("BEGIN"); seed("all", ["codex:discarded"]); db.raw.exec("ROLLBACK");
    expect(read()?.knownThreadKeys).toEqual(["codex:committed"]);
  });
});
