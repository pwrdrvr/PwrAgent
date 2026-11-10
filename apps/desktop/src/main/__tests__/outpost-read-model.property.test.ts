import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

it("seen bursts obey the shared storage oracle and preserve all canonical metadata", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async watermark => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-read-model-")));
      const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
      const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
      try {
        const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
        const ref = { backend: "codex", threadId: "thread" };
        store.inventory.replace({ backend: "codex", observedAt: 1, threads: [{ id: "thread", source: "codex", title: "Canonical",
          titleSource: "explicit", linkedDirectories: [], createdAt: 1, updatedAt: watermark + 1 }] });
        const metadata = { model: "gpt-5.5", reasoningEffort: "high", reasoningEffortsByModel: { "gpt-5.5": "high" },
          modelMigrationRevision: "retained", modelSettingsManuallyUpdatedAt: 1, fastMode: false };
        store.threadRegistry.updateThreadMetadata(ref, metadata);
        new SqliteOverlayStore(db).initializeNavigationUnreadBaseline([]);
        const backend = new HeadlessBackend({ workspace: root, store, projects: { list: () => [] } }, () => {});
        const seenAt = 2_000_000_000_000;
        const { writes } = await measureSqliteWrites(async () => {
          for (let index = 0; index < 100; index++) {
            await backend.handle("markThreadSeen", { ...ref, seenAt: seenAt + index, ...(index ? {} : { seenUpdatedAt: watermark }) });
          }
        });
        expect(writes.commits).toBe(1);
        expectSqliteWriteBudget({ scenario: "outpost-seen-burst-100", note: "100 owner seen commands in one stamp interval; omitted watermarks stay unchanged and only the first command commits", writes });
        expect(store.threadRegistry.getThreadMetadata(ref)).toMatchObject({ ...metadata, seenAt, seenUpdatedAt: watermark });
        const passive = await measureSqliteWrites(async () => {
          for (let index = 0; index < 100; index++) {
            const resolved = (await backend.handle("resolveThread", ref)).thread;
            const detail = await backend.handle("getNavigationSelectedDetail", { protocol: 2, ref });
            const page = await backend.handle("getNavigationQueryPage", { protocol: 2, query: { kind: "lens", lens: "inbox" } });
            expect(resolved.inbox).toEqual(detail.thread.inbox);
            expect(resolved.inbox).toEqual(page.entries[0].row.inbox);
            expect(resolved.inbox.inInbox).toBe(true);
            expect(detail.thread).toMatchObject({ model: metadata.model, reasoningEffort: metadata.reasoningEffort, modelMigrationRevision: metadata.modelMigrationRevision });
          }
        });
        expectSqliteWriteBudget({ scenario: "outpost-read-model-passive-100", note: "100 resolve, selected detail and navigation reads over the shared canonical projection; no SQLite commits", writes: passive.writes });
      } finally { db.close(); profile.close(); rmSync(root, { recursive: true, force: true }); }
    }), { numRuns: 5 });
  } finally { vi.unstubAllEnvs(); }
});
