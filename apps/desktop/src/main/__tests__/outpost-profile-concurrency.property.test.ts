import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const identity = { backend: "codex" as const, threadId: "thread" };
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const native = (title = "Before"): AppServerThreadSummary => ({ id: identity.threadId, source: "codex", title,
  titleSource: "explicit", createdAt: 1, updatedAt: 100, linkedDirectories: [] });
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

async function fixture(codex: {
  renameThread?: (request: { threadId: string; name: string }) => Promise<{ threadId: string }>;
  listThreads?: (request: { archived: boolean }) => Promise<AppServerThreadSummary[]>;
}) {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "outpost-profile-race-")));
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"));
  const desktop = new SqliteOverlayStore(db);
  const inventory = new ProviderThreadSnapshotStore(db);
  await desktop.updateThreadMetadata(identity, { title: { text: "Before", source: "explicit", nativeName: "Before" }, seenAt: 1, seenUpdatedAt: 1 });
  inventory.replace({ backend: "codex", observedAt: 0, threads: [native()] });
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  const store = new JobStore(directory, { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
  const backend = new HeadlessBackend({ workspace: root, store, codex,
    projects: { list: () => [{ path: root, label: "Fixture" }] }, onFailure(error: unknown) { throw error; } }, () => {});
  return { desktop, inventory, backend, close() { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("a pending native rename preserves all newer canonical metadata, including the acknowledged read watermark", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 10000 }), fc.nat(10000), fc.boolean(), async (watermark, rank, archived) => {
    const entered = barrier(), release = barrier();
    const f = await fixture({ renameThread: async () => { entered.resolve(); await release.promise; return { threadId: identity.threadId }; } });
    try {
      const rename = f.backend.handle("renameThread", { ...identity, name: "After" });
      await entered.promise;
      // This is an actual owner command while its provider rename is pending.
      await f.backend.handle("markThreadSeen", { ...identity, seenAt: watermark, seenUpdatedAt: watermark });
      // A second WAL connection supplies independently owned pin/parent/settings facts.
      await f.desktop.updateThreadMetadata(identity, { pinnedRank: String(rank), parent: { backend: "claude", threadId: `parent-${rank}` },
        model: `model-${rank}`, executionMode: "auto", subthreadsCollapsed: true });
      if (archived) await f.desktop.setThreadArchiveTombstone({ ...identity, archivedAt: watermark });
      const expected = await f.desktop.getThreadMetadata(identity);
      expect(expected?.title?.text).toBe("Before");
      release.resolve();
      await rename;
      expect(await f.desktop.getThreadMetadata(identity)).toEqual({ ...expected,
        title: { text: "After", source: "explicit", nativeName: "After" } });
      expect(f.backend.runtime.ownsThread(identity.threadId)).toBe(!archived);
      if (!archived) expect(f.backend.summary(f.backend.owned(identity.threadId)).inbox.inInbox).toBe(100 > watermark);
    } finally { release.resolve(); f.close(); }
  }), { numRuns: 25, examples: [[100, 0, false]] });
});

it("a complete discovery begun before a desktop archive or restore cannot supersede that newer owner change", async () => {
  await fc.assert(fc.asyncProperty(fc.nat(10000), fc.integer({ min: 1, max: 10000 }),
    fc.constantFrom("archive" as const, "observe" as const, "restore" as const), async (start, gap, action) => {
      const entered = barrier(), release = barrier();
      let blocking = false, archived = action === "restore", title = "Before";
      const f = await fixture({ listThreads: async request => {
        const snapshot = request.archived === archived ? [native(title)] : [];
        if (blocking && request.archived) { entered.resolve(); await release.promise; }
        return snapshot;
      } });
      let now = start;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        if (archived) await f.desktop.setThreadArchiveTombstone({ ...identity, archivedAt: start });
        await f.backend.initialize();
        // Both provider walks capture membership before the desktop changes it.
        title = "Changed native title";
        blocking = true;
        const discovery = f.backend.refreshThreads();
        await entered.promise;
        now = start + gap;
        if (action === "observe") await f.desktop.observeArchivedThreads([identity], now);
        else await f.desktop.setThreadArchiveTombstone({ ...identity, ...(action === "archive" ? { archivedAt: now } : { restoredAt: now }) });
        archived = action !== "restore";
        const expected = await f.desktop.getThreadMetadata(identity);
        now += gap;
        release.resolve();
        await discovery;
        expect(f.backend.runtime.ownsThread(identity.threadId)).toBe(!archived);
        expect(f.backend.runtime.listOwnedThreads().map((thread: { id: string }) => thread.id)).toEqual(archived ? [] : [identity.threadId]);
        expect(f.backend.navigationIndex().threads.map((thread: { id: string }) => thread.id)).toEqual(archived ? [] : [identity.threadId]);
        expect(f.inventory.list().find(snapshot => snapshot.backend === "codex")?.observedAt).toBe(start);
        expect(await f.desktop.getThreadMetadata(identity)).toEqual(expected);
        // A later complete walk remains able to project the current provider state.
        blocking = false;
        now++;
        await f.backend.refreshThreads();
        expect(f.backend.runtime.ownsThread(identity.threadId)).toBe(!archived);
      } finally { release.resolve(); clock.mockRestore(); f.close(); }
    }), { numRuns: 25, examples: [[0, 1, "archive"], [0, 1, "observe"], [0, 1, "restore"]] });
});
