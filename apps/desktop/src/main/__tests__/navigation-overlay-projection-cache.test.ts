import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let db: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;
beforeEach(() => { db = openInMemoryStateDb(); store = new SqliteOverlayStore(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); if (tempDir) removeTempStateDbDir(tempDir); tempDir = undefined; });

function seed(id: string, model = "fixture-model", target = db.raw, backend = "codex") {
  target.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)")
    .run(`${encodeURIComponent(backend)}:${id}`, JSON.stringify({ backend, threadId: id, model,
      immutableUsageActivities: [{ text: "contrived history ".repeat(1000) }],
    }));
}

function projectionCounts() {
  const original = db.raw.prepare.bind(db.raw);
  const counts: number[] = [];
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = original(sql);
    if (sql.includes("SELECT thread_id, json_object(")) {
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation((...args: unknown[]) => {
        counts.push((JSON.parse(args[1] as string) as string[]).length);
        return iterate(...args);
      });
    }
    return statement;
  });
  return counts;
}

const provider = (id: string): AppServerThreadSummary => ({
  id, source: "codex", title: `Thread ${id}`, titleSource: "explicit", updatedAt: 1, linkedDirectories: [],
});
const read = (threads: AppServerThreadSummary[]) => store.readNavigationQueryIndex({ backend: "all", threads });

describe("navigation overlay projection reuse", () => {
  it.each([10, 100, 1000])("projects %i unchanged payloads once across repeated full index reads", async (count) => {
    const threads = Array.from({ length: count }, (_, i) => provider(String(i)));
    db.raw.transaction(() => { for (const thread of threads) seed(thread.id); })();
    const counts = projectionCounts();
    for (let refresh = 0; refresh < 3; refresh++) {
      const result = read(threads);
      expect(result.threads).toHaveLength(count);
      expect(result.threads[0]?.model).toBe("fixture-model");
      result.threads[0]!.model = "caller mutation";
    }
    expect(counts).toEqual([count]);
    await store.setThreadExecutionMode({ backend: "codex", threadId: "0", executionMode: "full-access" });
    expect(read(threads).threads.find((thread) => thread.id === "0")?.executionMode).toBe("full-access");
    expect(counts).toEqual([count, 1]);
    // Provider data is never certified by a SQLite generation.
    expect(read([{ ...threads[0]!, title: "New provider title" }]).threads[0]?.title).toBe("New provider title");
    expect(counts).toEqual([count, 1]);
  });

  it("observes unknown local writes, missing identities, and provider ownership", () => {
    seed("same"); seed("same", "grok-model", db.raw, "acp:grok");
    const threads = [provider("same"), { ...provider("same"), source: "acp:grok" as const }, provider("missing")];
    const counts = projectionCounts();
    expect(read(threads).threads.map((thread) => thread.model)).toEqual(["fixture-model", "grok-model", undefined]);
    read(threads);
    expect(counts).toEqual([3]);
    seed("missing", "arrived");
    expect(read(threads).threads.find((thread) => thread.id === "missing")?.model).toBe("arrived");
    expect(counts).toEqual([3, 3]);
    db.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:same");
    expect(read(threads).threads.find((thread) => thread.id === "same" && thread.source === "codex")?.model).toBeUndefined();
  });

  it("observes cross-connection changes and deletion without a TTL", () => {
    db.close();
    const temp = createTempStateDb("pwragent-navigation-projections-"); tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath); store = new SqliteOverlayStore(db);
    const other = new Database(temp.dbPath);
    try {
      seed("same"); read([provider("same")]);
      seed("same", "external", other);
      expect(read([provider("same")]).threads[0]?.model).toBe("external");
      other.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:same");
      expect(read([provider("same")]).threads[0]?.model).toBeUndefined();
    } finally { other.close(); }
  });

  it("does not certify a rolled-back projection or mask an earlier unknown write", async () => {
    seed("same"); seed("other");
    const threads = [provider("same"), provider("other")];
    read(threads);
    db.raw.exec("BEGIN");
    await store.setThreadExecutionMode({ backend: "codex", threadId: "same", executionMode: "full-access" });
    expect(read(threads).threads[0]?.executionMode).toBe("full-access");
    db.raw.exec("ROLLBACK");
    expect(read(threads).threads[0]?.executionMode).not.toBe("full-access");
    seed("other", "unknown write");
    await store.setThreadExecutionMode({ backend: "codex", threadId: "same", executionMode: "full-access" });
    expect(read(threads).threads[1]?.model).toBe("unknown write");
  });

  it("enforces the remaining admission budget on both cold and cached rows", () => {
    seed("same");
    expect(() => store["readNavigationOverlayRows"](["codex:same"], 1)).toThrow("admission budget");
    store["readNavigationOverlayRows"](["codex:same"]);
    expect(() => store["readNavigationOverlayRows"](["codex:same"], 1)).toThrow("admission budget");
  });

  it("evicts compact payloads at the byte budget and leaves oversized rows uncached", () => {
    seed("a", "a".repeat(5 * 1024 * 1024));
    seed("b", "b".repeat(5 * 1024 * 1024));
    const rows = store["readNavigationOverlayRows"](["codex:a", "codex:b"]);
    expect(rows).toHaveLength(2);
    expect(store["navigationOverlayCache"]!.rows.size).toBe(1);
    expect(store["navigationOverlayCache"]!.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    seed("large", "x".repeat(8 * 1024 * 1024));
    expect(store["readNavigationOverlayRows"](["codex:large"])).toHaveLength(1);
    expect(store["navigationOverlayCache"]!.rows.has("codex:large")).toBe(false);
  });

  it("bounds retained identities and bytes", () => {
    const keys = Array.from({ length: 10_100 }, (_, i) => `codex:missing-${i}`);
    store["readNavigationOverlayRows"](keys);
    expect(store["navigationOverlayCache"]!.rows.size).toBeLessThanOrEqual(10_000);
    expect(store["navigationOverlayCache"]!.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    const hugeKey = "x".repeat(8 * 1024 * 1024 + 1);
    store["readNavigationOverlayRows"]([hugeKey]);
    expect(store["navigationOverlayCache"]!.rows.has(hugeKey)).toBe(false);
  });
});
