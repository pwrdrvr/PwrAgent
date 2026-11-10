import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const budgetFile = "outpost-acp-membership-write-budgets.json";

it("native ACP retirement costs its existing delete only and repeated absent reads never clean up or republish metadata", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-acp-writes-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  let profile: ReturnType<typeof openOutpostProfileRuntime> | undefined;
  try {
    const sessions = new AcpSessionStore(db);
    const ref = { backend: "acp:removed" as const, threadId: "removed" };
    sessions.upsertSession({ backendId: ref.backend, sessionId: ref.threadId, title: "Retired ACP", createdAt: 1, updatedAt: 2,
      archivedAt: 3, executionMode: "auto", status: "idle" });
    const overlay = new SqliteOverlayStore(db);
    await overlay.updateThreadMetadata(ref, { pinnedRank: "1024", parent: { backend: "codex", threadId: "parent" }, seenUpdatedAt: 2 });
    new ProviderThreadSnapshotStore(db).replace({ backend: ref.backend, observedAt: Date.now(), threads: [{ id: ref.threadId,
      source: ref.backend, title: "Retained older ACP", titleSource: "explicit", linkedDirectories: [], archivedAt: 3 }] });
    profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = { workspace: root, store, projects: { list: () => [] }, codex: { listModels: async () => [] },
      onFailure(error: unknown) { throw error; } };
    let owner = new HeadlessBackend(runtime, () => {});
    expect((await owner.handle("resolveThread", ref)).thread.title).toBe("Retired ACP");
    const retirement = await measureSqliteWrites(async () => {
      sessions.deleteSession(ref.backend, ref.threadId);
      expect((await owner.handle("resolveThread", ref)).thread).toBeUndefined();
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "acp-native-delete-retirement", writes: retirement.writes,
      note: "One existing native ACP deletion plus Outpost retirement; no overlay or inventory cleanup write" });
    const passive = await measureSqliteWrites(async () => {
      for (let i = 0; i < 1000; i++) {
        if (i % 100 === 0) owner = new HeadlessBackend(runtime, () => {});
        expect((await owner.handle("resolveThread", ref)).thread).toBeUndefined();
        expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe("unresolved");
        expect((await owner.handle("listThreads", { backend: "all" })).threads).toEqual([]);
        expect((await owner.handle("lookupArchivedThreads", { backend: ref.backend, threadIds: [ref.threadId], includeParent: true })).parentLinks).toEqual([]);
        expect((await owner.handle("getNavigationQueryPage", { protocol: 2, backend: ref.backend, consumer: "remote-window",
          query: { kind: "exact", identities: [ref] } })).entries).toEqual([]);
      }
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "acp-retired-membership-passive-reads", writes: passive.writes,
      note: "1000 absent ACP resolve/detail/list/archive/navigation rounds and ten owner reopens add zero SQLite writes (0 MB/day)" });
    expect(await overlay.getThreadMetadata(ref)).toMatchObject({ pinnedRank: "1024" });
  } finally { profile?.close(); db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
