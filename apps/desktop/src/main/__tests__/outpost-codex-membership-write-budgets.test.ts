import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const budgetFile = "outpost-codex-membership-write-budgets.json";

it("budgets one atomic native retirement and zero repeated absent discoveries, late events and owner reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-codex-writes-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const ref = { backend: "codex" as const, threadId: "native" };
    await new SqliteOverlayStore(db).updateThreadMetadata(ref, { pinnedRank: "1024", seenUpdatedAt: 2 });
    let present = true;
    const runtime = { workspace: root, store, loadedThreads: new Set(), messagingTools: { buildDynamicToolSpecs: () => [] },
      turnQueue: { getAllQueuedEntries: () => [], drainAll() {} },
      projects: { list: () => [], resolve: () => root }, onFailure(error: unknown) { throw error; },
      codex: { listThreads: async ({ archived }: { archived: boolean }) => present && !archived
        ? [{ id: "native", source: "codex", title: "Native", titleSource: "explicit", linkedDirectories: [] }] : [],
        startThread: async () => ({ threadId: "created-native" }) } };
    let owner = new HeadlessBackend(runtime, () => {});
    await owner.initialize();
    present = false;
    const retirement = await measureSqliteWrites(() => owner.refreshThreads());
    expect(owner.threads.get("native")).toBeUndefined();
    expectSqliteWriteBudget({ budgetFile, scenario: "codex-native-retirement", writes: retirement.writes,
      note: "One complete active/archive boundary atomically marks native retirement and replaces inventory; one commit per boundary, no timer" });
    const passive = await measureSqliteWrites(async () => {
      for (let i = 0; i < 1000; i++) {
        if (i % 100 === 0) { owner = new HeadlessBackend(runtime, () => {}); await owner.initialize(); }
        await owner.refreshThreads();
        owner.event({ method: "thread/name/updated", params: { threadId: "native", threadName: "Late stale name" } });
        expect((await owner.handle("resolveThread", ref)).thread).toBeUndefined();
        expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe("unresolved");
      }
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "codex-retirement-passive", writes: passive.writes,
      note: "1000 complete absent discoveries/late-name events/point reads and ten owner reopens; zero commits and 0 MB/day" });
    const creation = await measureSqliteWrites(() => owner.handle("startThread"));
    expectSqliteWriteBudget({ budgetFile, scenario: "codex-confirmed-creation", writes: creation.writes,
      note: "Actual native thread/start confirmation retains its membership fact in the existing creation commit; no extra transaction" });
  } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});

it("native retirement and inventory publication roll back together on generated storage refusals", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("threads", "provider_thread_snapshots"), fc.uuid(), async (table, id) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-codex-atomic-")));
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
    try {
      const inventory = new ProviderThreadSnapshotStore(db);
      const overlay = new SqliteOverlayStore(db);
      const ref = { backend: "codex" as const, threadId: id };
      await overlay.updateThreadMetadata(ref, { pinnedRank: "1024" });
      inventory.replace({ backend: "codex", observedAt: 1, threads: [{ id, source: "codex", title: "Native", titleSource: "explicit", linkedDirectories: [] }] });
      const before = inventory.list();
      db.raw.exec(table === "threads"
        ? "CREATE TRIGGER refuse_retirement BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT, 'retirement refused'); END"
        : "CREATE TRIGGER refuse_retirement BEFORE INSERT ON provider_thread_snapshots BEGIN SELECT RAISE(ABORT, 'retirement refused'); END");
      expect(() => inventory.replace({ backend: "codex", observedAt: 2, threads: [] }, [id])).toThrow("retirement refused");
      expect(inventory.list()).toEqual(before);
      expect(await overlay.getThreadMetadata(ref)).toMatchObject({ pinnedRank: "1024" });
      expect((await overlay.getThreadMetadata(ref))?.nativeMembershipRetired).toBeUndefined();
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});
