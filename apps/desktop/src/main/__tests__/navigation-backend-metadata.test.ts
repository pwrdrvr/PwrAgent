import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import Database from "better-sqlite3";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { READ_NAVIGATION_BACKEND_METADATA } from "../state/navigation-backend-metadata";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

let tempDir: string | undefined;
let stateDb: StateDb;
let store: SqliteOverlayStore;
beforeEach(() => {
  tempDir = undefined;
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); stateDb.close();
  if (tempDir) removeTempStateDbDir(tempDir);
});
function useFile(): string {
  stateDb.close();
  const temp = createTempStateDb("navigation-backend-metadata-");
  tempDir = temp.tempDir;
  stateDb = StateDb.open(temp.dbPath);
  store = new SqliteOverlayStore(stateDb);
  return temp.dbPath;
}

const thread = { id: "selected", source: "codex" as const, title: "Selected",
  titleSource: "explicit" as const, linkedDirectories: [] };

describe("bounded backend navigation metadata", () => {
  it("does not parse a legacy multi-megabyte snapshot to read known identities", () => {
    stateDb.raw.prepare("INSERT INTO backends VALUES (?, ?)").run("codex", JSON.stringify({
      knownThreadKeys: ["codex:selected"], lastSnapshotHash: "x".repeat(9_300_000),
    }));
    const parse = vi.spyOn(JSON, "parse");
    expect(store["getBackend"]("codex")?.knownThreadKeys).toEqual(["codex:selected"]);
    expect(Math.max(...parse.mock.calls.map(([value]) => value.length))).toBeLessThan(1024);
    const index = stateDb.raw.prepare("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name = 'idx_backends_navigation_metadata'").get() as { bytes: number };
    expect(index.bytes).toBeLessThanOrEqual(4096);
  });

  it("persists a fixed-size digest and still detects snapshot changes", async () => {
    store["putThread"]("codex:selected", { backend: "codex", threadId: "selected",
      executionMode: "default", extraLinkedDirectories: [],
      agent: { name: "Selected", instructions: "x".repeat(1_000_000), instructionLineCount: 1,
        instructionsTooLong: false, updatedAt: 1 } });
    const params = { backend: "codex" as const, fetchedAt: 1, threads: [thread] };
    await store.reconcileNavigationSnapshot(params);
    const row = stateDb.raw.prepare("SELECT payload FROM backends WHERE scope = ?").get("codex") as { payload: string };
    expect(/^sha256:[a-f0-9]{64}$/.test(JSON.parse(row.payload).lastSnapshotHash)).toBe(true);
    expect(row.payload.length).toBeLessThan(256);
    expect((await store.reconcileNavigationSnapshot(params)).unchanged).toBe(true);
    expect((await store.reconcileNavigationSnapshot({ ...params, threads: [{ ...thread, title: "Changed" }] })).unchanged).toBe(false);
  });

  it("uses index columns with no payload access or JSON evaluation at read time", () => {
    const plan = stateDb.raw.prepare("EXPLAIN QUERY PLAN " + READ_NAVIGATION_BACKEND_METADATA).all("codex") as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("COVERING INDEX idx_backends_navigation_metadata"))).toBe(true);
    const code = stateDb.raw.prepare("EXPLAIN " + READ_NAVIGATION_BACKEND_METADATA).all("codex") as { opcode: string; p1: number; p2: number }[];
    const tableRoot = (stateDb.raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'backends'").get() as { rootpage: number }).rootpage;
    const tableCursor = code.find((op) => op.opcode === "OpenRead" && op.p2 === tableRoot)?.p1;
    expect(code.filter((op) => op.opcode === "Column" && op.p1 === tableCursor)).toEqual([]);
    expect(code.filter((op) => op.opcode === "Function")).toEqual([]);
  });

  it("backfills v64 without rewriting source rows and follows external legacy writes and rollback", () => {
    const file = useFile();
    const legacy = JSON.stringify({ knownThreadKeys: ["acp%3Agrok:old"], lastSnapshotHash: "x".repeat(1_000_000) });
    stateDb.raw.prepare("INSERT INTO backends VALUES (?, ?)").run("codex", legacy);
    stateDb.raw.exec("DROP INDEX idx_backends_navigation_metadata; PRAGMA user_version = 64");
    stateDb.close();
    stateDb = StateDb.open(file); store = new SqliteOverlayStore(stateDb);
    expect(store["getBackend"]("codex")).toEqual({ knownThreadKeys: ["acp:grok:old"], lastSnapshotHash: "legacy" });
    expect((stateDb.raw.prepare("SELECT payload FROM backends").get() as { payload: string }).payload === legacy).toBe(true);
    const other = new Database(file);
    try {
      other.prepare("UPDATE backends SET payload = ?").run(JSON.stringify({ knownThreadKeys: ["codex:new"], lastSnapshotHash: "y".repeat(1_000_000) }));
      expect(store["getBackend"]("codex")?.knownThreadKeys).toEqual(["codex:new"]);
      expect(() => stateDb.raw.transaction(() => {
        stateDb.raw.prepare("UPDATE backends SET payload = ?").run(JSON.stringify({ knownThreadKeys: [], lastSnapshotHash: "temporary" }));
        expect(store["getBackend"]("codex")?.knownThreadKeys).toEqual([]);
        throw new Error("rollback");
      })()).toThrow("rollback");
      expect(store["getBackend"]("codex")?.knownThreadKeys).toEqual(["codex:new"]);
      other.prepare("DELETE FROM backends WHERE scope = ?").run("codex");
      expect(store["getBackend"]("codex")).toBeUndefined();
    } finally { other.close(); }
  });

  it("projects selected configuration identically without global navigation reads or writes", async () => {
    useFile();
    store["putBackend"]("codex", { knownThreadKeys: ["codex:selected"], lastSnapshotHash: "initialized" });
    store["putThread"]("codex:selected", { backend: "codex", threadId: "selected",
      executionMode: "default", extraLinkedDirectories: [], parentThreadId: "parent", parentThreadBackend: "acp:grok",
      model: "selected-model", lastSeenUpdatedAt: 2, pinnedRank: "a" });
    const queue = { mode: "auto" as const, queuedAt: 5 };
    const summary = { ...thread, updatedAt: 3 };
    const previous = (await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 10, partial: true,
      threads: [summary], queuedExecutionModesByThreadKey: { "codex:selected": queue } })).threads[0];
    const globalRead = vi.spyOn(store, "reconcileNavigationSnapshot").mockRejectedValue(new Error("global reconciliation forbidden"));
    const managed = vi.spyOn(store as unknown as { listManagedSubAgentThreadKeys(): Set<string> }, "listManagedSubAgentThreadKeys").mockImplementation(() => { throw new Error("global relationships forbidden"); });
    const sql: string[] = [];
    const prepare = stateDb.raw.prepare.bind(stateDb.raw);
    vi.spyOn(stateDb.raw, "prepare").mockImplementation((query: string) => { sql.push(query); return prepare(query); });
    const { writes } = await measureSqliteWrites(async () => {
      for (let i = 0; i < 20; i++) {
        const detail = await store.projectNavigationThreadDetail({ thread: summary, queuedExecutionMode: queue });
        expect(detail).toEqual(previous);
      }
    });
    expect(globalRead).not.toHaveBeenCalled(); expect(managed).not.toHaveBeenCalled();
    expect(sql.some((query) => /FROM (thread_navigation_relationships|directory_launchpads|directory_overlays|launchpad_defaults)/i.test(query))).toBe(false);
    expectSqliteWriteBudget({ scenario: "navigation-detail-twenty-point-reads", writes,
      note: "Twenty selected configuration projections: no reconciliation, no persistence." });
  });

  it("budgets changed digest persistence and zero unchanged or partial persistence", async () => {
    useFile();
    await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 1, threads: [thread] });
    const { writes } = await measureSqliteWrites(async () => {
      await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 2, threads: [thread] });
      await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 3, threads: [thread], partial: true });
      await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 4, threads: [{ ...thread, title: "Changed" }] });
    });
    expectSqliteWriteBudget({ scenario: "navigation-backend-digest-reconciliation", writes,
      note: "One changed complete snapshot commits compact metadata and index; unchanged and partial reads add no commits." });
  });


  it("allows an explicit managed-child detail without changing navigation membership", async () => {
    store["putThread"]("codex:parent", { backend: "codex", threadId: "parent",
      executionMode: "default", extraLinkedDirectories: [], subAgents: [{ monitorId: "monitor",
        monitorThreadId: thread.id, task: "Worker", status: "running", createdAt: 1, updatedAt: 1 }] });
    expect((await store.reconcileNavigationSnapshot({ backend: "codex", fetchedAt: 1, partial: true, threads: [thread] })).threads).toEqual([]);
    expect((await store.projectNavigationThreadDetail({ thread })).id).toBe(thread.id);
  });

});
