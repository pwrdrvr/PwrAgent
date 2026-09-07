import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("moves against the complete owner order including unranked unloaded siblings", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    const children = Array.from({ length: 100 }, (_, i) => ({ id: `child-${i}`, createdAt: i }));
    for (const child of children) await store.setThreadParent({ backend: "codex", threadId: child.id, parentThreadId: "root" });
    // Only one manual rank exists; all other children use owner creation order.
    await store.updateSubthreadOrder({ backend: "codex", parentThreadId: "root", threadIds: ["child-0"] });
    const request = { backend: "codex" as const, parentThreadId: "root", children,
      move: { threadId: "child-0", anchorThreadId: "child-50", placement: "after" as const } };
    const expected = [...children.slice(50).reverse().map((child) => child.id), "child-0",
      ...children.slice(1, 50).reverse().map((child) => child.id)];
    const { writes } = await measureSqliteWrites(async () => {
      expect(await store.updateSubthreadOrder(request)).toEqual(expected);
    });
    expectSqliteWriteBudget({ scenario: "navigation-relative-child-move", writes,
      note: "One owner-validated move among 100 children: one commit per explicit drag; at 100 moves/day and ~4 KiB/commit, ~0.4 MB/day; no idle writes" });
    await store.setThreadParent({ backend: "codex", threadId: "child-50", parentThreadId: "another-root" });
    await expect(store.updateSubthreadOrder(request)).rejects.toThrow("no longer places");
  } finally { db.close(); }
});

it("inserts relative to the current owner order and preserves every unloaded sibling", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    const siblings = Array.from({ length: 100 }, (_, index) => `child-${index}`);
    for (const threadId of [...siblings, "new"]) {
      await store.setThreadParent({ backend: "codex", threadId, parentThreadId: "root" });
    }
    const request = { backend: "codex" as const, parentThreadId: "root", insertAfter: { threadId: "new", sourceThreadId: "child-50" } };
    const expected = [...siblings.slice(0, 51), "new", ...siblings.slice(51)];
    const { writes } = await measureSqliteWrites(async () => {
      expect(await store.updateSubthreadOrder(request)).toEqual(expected);
    });
    expectSqliteWriteBudget({ scenario: "navigation-relative-child-insertion", writes,
      note: "One owner-validated relative insertion among 101 children: one commit per explicit creation; at 100 creations/day and ~4 KiB/commit, ~0.4 MB/day; no idle writes" });
    const repeated = await measureSqliteWrites(async () => {
      expect(await store.updateSubthreadOrder(request)).toEqual(expected);
    });
    expect(repeated.writes.commits).toBe(1);
    expect(repeated.writes.rowsChanged).toBe(0);
    expect(repeated.writes.statements).toBe(0);
    await store.setThreadParent({ backend: "codex", threadId: "child-50", parentThreadId: "other-root" });
    await expect(store.updateSubthreadOrder(request)).rejects.toThrow("no longer places");
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
      .toEqual(expected);
  } finally { db.close(); }
});

it("rejects a same-id child owned by another parent instance", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    await store.setThreadParent({ backend: "codex", threadId: "new", parentThreadId: "root", parentThreadInstanceId: "peer" });
    await expect(store.updateSubthreadOrder({ backend: "codex", parentThreadId: "root",
      insertAfter: { threadId: "new", sourceThreadId: "root" } })).rejects.toThrow("no longer places");
  } finally { db.close(); }
});
