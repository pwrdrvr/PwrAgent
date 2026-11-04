import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind, NavigationThreadSummary } from "@pwragent/shared";
import { createSubthreadTrays } from "../../renderer/src/features/navigation/subthread-trays";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { ProviderThreadSnapshotStore } from "../app-server/provider-thread-snapshot-store";

describe("archiving nested subthreads", () => {
  let db: StateDb;
  let store: SqliteOverlayStore;
  let tempDir: string;
  const identities = new Map<string, AppServerBackendKind>();
  beforeEach(() => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-archive-subthreads-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(db);
    identities.clear();
  });
  afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

  const link = async (id: string, parent: string, backend: AppServerBackendKind = "codex") => {
    identities.set(id, backend);
    await store.setThreadParent({ backend, threadId: id, parentThreadId: parent,
      parentThreadBackend: identities.get(parent) ?? "codex" });
  };
  const archive = async (id: string) => await store.observeArchivedThreads(
    [{ backend: identities.get(id) ?? "codex", threadId: id }], 1000, { promoteSubthreads: true },
  );
  const tray = async () => {
    const summaries: NavigationThreadSummary[] = [];
    for (const [id, source] of [["root", "codex"] as const, ...identities]) {
      const overlay = await store.getThreadOverlayState({ backend: source, threadId: id });
      if (overlay?.archiveRetentionStartedAt !== undefined) continue;
      summaries.push({ ...overlay, id, source, title: id, titleSource: "explicit", updatedAt: 0,
        linkedDirectories: [], inbox: { inInbox: false } });
    }
    const children = new Map<string, NavigationThreadSummary[]>();
    for (const summary of summaries) {
      if (!summary.parentThreadId) continue;
      const key = `${summary.parentThreadBackend}:${summary.parentThreadId}`;
      children.set(key, [...(children.get(key) ?? []), summary]);
    }
    return createSubthreadTrays(children, [summaries.find((row) => row.id === "root")!])
      .subtree("codex:root").map((row) => row.id);
  };

  it.each<AppServerBackendKind>(["codex", "claude", "acp:kimi"])(
    "preserves the rendered tray order across an archived %s child", async (backend) => {
      await link("before", "root");
      await link("parent", "root", backend);
      await link("after", "root");
      await link("child-b", "parent", "claude");
      await link("child-a", "parent");
      await link("deeper", "child-b");
      expect(await tray()).toEqual(["before", "parent", "child-b", "deeper", "child-a", "after"]);
      await archive("parent");
      expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
      expect((await store.getThreadOverlayState({ backend: "codex", threadId: "deeper" }))?.parentThreadId)
        .toBe("child-b");
      await archive("parent");
      expect(await tray()).toEqual(["before", "child-b", "deeper", "child-a", "after"]);
    },
  );

  it.each([["parent", "nested"], ["nested", "parent"]])(
    "keeps deeper survivors visible when archive order is %s then %s", async (first, second) => {
      await link("before", "root");
      await link("parent", "root");
      await link("after", "root");
      await link("nested", "parent");
      await link("survivor", "nested");
      for (const id of [first, second]) await archive(id);
      expect(await tray()).toEqual(["before", "survivor", "after"]);
    },
  );

  it("retains the nearest ancestor so deeper flattened rows do not jump past siblings", async () => {
    await link("branch", "root");
    await link("after", "root");
    await link("parent", "branch");
    await link("sibling", "branch");
    await link("survivor", "parent");
    await archive("parent");
    expect(await tray()).toEqual(["branch", "survivor", "sibling", "after"]);
  });

  it("does not move archived, reparented, remote-owned, or same-id foreign children", async () => {
    await link("parent", "root");
    await link("survivor", "parent");
    await link("archived", "parent");
    await store.observeArchivedThreads([{ backend: "codex", threadId: "archived" }], 500);
    await link("moved", "elsewhere");
    await store.setThreadParent({ backend: "claude", threadId: "remote", parentThreadId: "parent",
      parentThreadBackend: "codex", parentThreadInstanceId: "peer" });
    await store.setThreadParent({ backend: "claude", threadId: "foreign", parentThreadId: "parent",
      parentThreadBackend: "claude" });
    await archive("parent");
    expect(await tray()).toEqual(["survivor"]);
    for (const [backend, threadId, parentThreadId] of [
      ["codex", "archived", "parent"], ["codex", "moved", "elsewhere"],
      ["claude", "remote", "parent"], ["claude", "foreign", "parent"],
    ] as const) {
      expect((await store.getThreadOverlayState({ backend, threadId }))?.parentThreadId).toBe(parentThreadId);
    }
  });

  it("preserves creation order when legacy links have no saved ranks", async () => {
    await link("before", "root");
    await link("parent", "root");
    await link("after", "root");
    await link("child-b", "parent");
    await link("child-a", "parent");
    const summaries = ["after", "parent", "before", "child-b", "child-a"].map((id, index) => ({
      id, title: id, titleSource: "explicit" as const, linkedDirectories: [], source: "codex" as const,
      createdAt: index, updatedAt: index,
    }));
    new ProviderThreadSnapshotStore(db).replace({ backend: "codex", observedAt: 1, threads: summaries });
    await store.updateSubthreadOrder({ backend: "codex", parentThreadId: "root", threadIds: [] });
    await store.updateSubthreadOrder({ backend: "codex", parentThreadId: "parent", threadIds: [] });
    await archive("parent");
    expect(await tray()).toEqual(["before", "child-a", "child-b", "after"]);
  });

  it("recovers under the first live ancestor when an older archive left nested links behind", async () => {
    await link("before", "root");
    await link("old-archive", "root");
    await link("after", "root");
    await link("parent", "old-archive");
    await link("survivor", "parent");
    await store.observeArchivedThreads([{ backend: "codex", threadId: "old-archive" }], 500);
    await archive("parent");
    expect(await tray()).toEqual(["before", "survivor", "after"]);
  });

  it("preserves saved slots for siblings owned on other instances", async () => {
    await link("parent", "root");
    await link("survivor", "parent");
    await store.updateSubthreadOrder({ backend: "codex", parentThreadId: "root",
      threadIds: ["remote-before", "parent", "remote-after"] });
    await archive("parent");
    expect((await store.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
      .toEqual(["remote-before", "survivor", "remote-after"]);
  });

  it("rolls back every relationship and rank if promotion fails", async () => {
    await link("parent", "root");
    await link("child-a", "parent");
    await link("child-b", "parent");
    db.raw.exec(`CREATE TRIGGER fail_child_promotion BEFORE INSERT ON threads
      WHEN NEW.thread_id = 'codex:child-b' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    await expect(archive("parent")).rejects.toThrow("fixture failure");
    expect(await tray()).toEqual(["parent", "child-a", "child-b"]);
  });

  it("promotes 100 children in one boundary commit with no writes on repeated observations", async () => {
    await link("parent", "root");
    for (let index = 0; index < 100; index++) await link(`child-${index}`, "parent");
    const { writes } = await measureSqliteWrites(() => archive("parent"));
    expectSqliteWriteBudget({ scenario: "archive-subthread-promotion", writes,
      note: "One archive boundary promotes 100 children in one commit (~0.033 MB); 10 such archives/day cost ~0.33 MB/day. No per-child commits or idle writes (0 MB/day)." });
    const repeated = await measureSqliteWrites(() => archive("parent"));
    expectSqliteWriteBudget({ scenario: "archive-subthread-promotion-repeat", writes: repeated.writes,
      note: "Repeated archive notification or resumed cleanup after promotion: zero commits, 0 MB/day." });
  });
});
