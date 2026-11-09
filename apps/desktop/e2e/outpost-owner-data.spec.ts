import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import type { AppServerThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedRetainedOutpostUnreadThread } from "./fixtures/outpost-owner-data-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve(specDir, "../../../packages/pwragent/src", file)).href);

test.beforeAll(() => {
  // The production JS imports Outpost's published bundle. A desktop-only
  // build does not produce it in a clean checkout.
  execFileSync(process.execPath, [path.resolve(specDir, "../../../packages/pwragent/scripts/build.mjs")], {
    cwd: path.resolve(specDir, "../../.."), stdio: "pipe",
  });
});

test("desktop baseline reads, metadata-only titles and archive observations survive actual Outpost takeover", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const overlay = new SqliteOverlayStore(db);
        const retained: AppServerThreadSummary = { id: identity.threadId, source: "codex", title: "Replay smoke thread",
          titleSource: "explicit", updatedAt: 1760000000000, linkedDirectories: [] };
        seedRetainedOutpostUnreadThread(db, retained);
        await overlay.setThreadExecutionMode({ backend: "codex", threadId: "metadata-only", executionMode: "auto" });
        await overlay.observeArchivedThreads([{ backend: "codex", threadId: "observed-archive" }], 1);
      } finally { db.close(); }
    },
  });
  try {
    await expect(app.window.getByRole("button", { name: /Replay smoke thread/i }).first()).toBeVisible();
    const desktop = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.getNavigationSelectedDetail!({ protocol: 2, ref })).thread;
    }, identity);
    expect(desktop?.inbox.inInbox).toBe(false);
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try { expect((await new SqliteOverlayStore(db).getThreadMetadata(identity))?.seenUpdatedAt).toBeUndefined(); }
    finally { db.close(); }
    const stateDirectory = path.dirname(stateDbPathForHomeRoot(app.homeRoot));
    const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(path.join(stateDirectory, "headless"),
        { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const backend = new HeadlessBackend({ workspace: app.homeRoot, store, projects: { list: () => [] },
        onFailure(error: unknown) { throw error; } }, () => {});
      expect(backend.summary(backend.owned(identity.threadId)).inbox.inInbox).toBe(desktop!.inbox.inInbox);
      expect(() => backend.owned("observed-archive")).toThrow("Thread is not owned");
      expect(backend.runtime.ownsThread("observed-archive")).toBe(false);
      const filtered = await backend.handle("getNavigationQueryPage", {
        protocol: 2, query: { kind: "lens", lens: "recents", filter: "untitled" },
      });
      expect(filtered.entries.map((entry: { row: { id: string; title: string; titleSource: string } }) => entry.row))
        .toEqual([expect.objectContaining({ id: "metadata-only", title: "Untitled thread", titleSource: "fallback" })]);
      await backend.handle("markThreadSeen", { threadId: identity.threadId, seenAt: Date.now() + 60000 });
      expect(backend.summary(backend.owned(identity.threadId)).inbox.inInbox).toBe(false);
    } finally { profile.close(); }
  } finally { await app.close(); }
});

test("the actual Outpost registry adopts legacy owner data and receives desktop metadata edits after shutdown", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  let headless = "";
  let legacyBytes = "";
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      headless = path.join(stateDirectory, "headless");
      await mkdir(path.join(headless, "jobs"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(headless, "identity.json"), JSON.stringify({ version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }));
      legacyBytes = JSON.stringify({ version: 1, threads: [{ id: identity.threadId, title: "Legacy Outpost owner title", titleSource: "explicit",
        createdAt: 1, sandbox: "read-only", pinnedRank: "1024", seenAt: 2, seenUpdatedAt: 1,
        parentThreadId: "legacy-parent", parentThreadBackend: "claude", messagingFileTools: true }] });
      await writeFile(path.join(headless, "threads.json"), legacyBytes);
      await writeFile(path.join(headless, "jobs/legacy.json"), JSON.stringify({ version: 1, id: "legacy", fingerprint: "retained", status: "running",
        threadId: identity.threadId, createdAt: "2026-01-01T00:00:00Z" }));
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: homeRoot });
      try {
        const store = new JobStore(headless, { version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }, profile);
        const backend = new HeadlessBackend({ workspace: homeRoot, store, onFailure(error: unknown) { throw error; } }, () => {});
        expect(store.get("legacy")).toMatchObject({ status: "unknown", fingerprint: "retained" });
        expect(await backend.threadRegistry.getThreadMetadata(identity)).toMatchObject({ title: { text: "Legacy Outpost owner title", source: "explicit" }, pinnedRank: "1024" });
      } finally { profile.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = (await api.getNavigationSelectedDetail!({ protocol: 2, ref })).thread;
      await api.setThreadPin!({ ...ref, pinnedRank: "8192" });
      await api.setThreadParent!({ ...ref, parentThreadId: null });
      const seenAt = Date.now() + 60_000;
      await api.markThreadSeen!({ ...ref, seenAt, seenUpdatedAt: before!.updatedAt });
      return { before, seenAt };
    }, identity);
    expect(result.before).toMatchObject({ pinnedRank: "1024", parentThreadId: "legacy-parent" });
    await app.closeApplication();
    const profile = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(headless, { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const backend = new HeadlessBackend({ workspace: app.homeRoot, store, onFailure(error: unknown) { throw error; } }, () => {});
      const metadata = await backend.threadRegistry.getThreadMetadata(identity);
      expect(metadata).toMatchObject({ title: { text: "Legacy Outpost owner title", source: "explicit" }, pinnedRank: "8192", seenAt: result.seenAt });
      expect(metadata.parent).toBeUndefined();
      const summary = backend.summary(backend.owned(identity.threadId));
      expect(summary.pinnedRank).toBe("8192");
      // Recovery is newer than the replay provider row. Acknowledging that
      // older row must not read the recovered job merely because seenAt is later.
      expect(summary.inbox.inInbox).toBe(summary.updatedAt > (metadata.seenUpdatedAt ?? metadata.seenAt ?? 0));
      expect(store.get("legacy")).toMatchObject({ status: "unknown", fingerprint: "retained" });
      expect(await readFile(path.join(headless, "legacy-owner-backup-v1/threads.json"), "utf8")).toBe(legacyBytes);
    } finally { profile.close(); }
  } finally { await app.close(); }
});
