import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve(specDir, "../../../packages/pwragent/src", file)).href);
const ref = { backend: "claude" as const, threadId: "00000000-0000-4000-8000-000000000001" };
const archivedId = "00000000-0000-4000-8000-000000000002";

test.beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(specDir, "../../../packages/pwragent/scripts/build.mjs")], {
    cwd: path.resolve(specDir, "../../.."), stdio: "pipe",
  });
});

test("desktop and Outpost preserve overlay permissions for legacy Claude metadata without an execution mode", async () => {
  const ref = { backend: "claude" as const, threadId: "00000000-0000-4000-8000-000000000003" };
  const app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const state = path.dirname(stateDbPathForHomeRoot(homeRoot));
      await mkdir(path.join(state, "claude"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(state, "claude", `${ref.threadId}.json`), JSON.stringify({ cwd: homeRoot,
        thread: { id: ref.threadId, source: "claude", title: "Legacy Claude permissions", titleSource: "explicit",
          createdAt: 1, updatedAt: 2, linkedDirectories: [] } }), { mode: 0o600 });
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try { await new SqliteOverlayStore(db).setThreadExecutionMode({ ...ref, executionMode: "auto" }); }
      finally { db.close(); }
    },
  });
  try {
    await expect(app.window.getByRole("button", { name: /Legacy Claude permissions/i }).first()).toBeVisible();
    const desktop = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return api.getNavigationSelectedDetail!({ protocol: 2, ref });
    }, ref);
    expect(desktop.thread?.executionMode).toBe("auto");
    await app.closeApplication();
    const state = path.dirname(stateDbPathForHomeRoot(app.homeRoot));
    expect(JSON.parse(await readFile(path.join(state, "claude", `${ref.threadId}.json`), "utf8")).thread.executionMode).toBeUndefined();
    const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
    const profile = openOutpostProfileRuntime({ stateDirectory: state, profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(path.join(state, "headless"), { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const owner = new HeadlessBackend({ workspace: app.homeRoot, store, projects: { list: () => [] },
        onFailure(error: unknown) { throw error; } }, () => {});
      const outpost = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
      expect(outpost.thread.executionMode).toBe(desktop.thread!.executionMode);
    } finally { profile.close(); }
  } finally { await app.close(); }
});

test("desktop Claude metadata edits reach actual Outpost without a startup inventory or provider activation", async () => {
  const app = await launchElectronApp({ secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const state = path.dirname(stateDbPathForHomeRoot(homeRoot));
      await mkdir(path.join(state, "claude"), { recursive: true, mode: 0o700 });
      for (const id of [ref.threadId, archivedId]) await writeFile(path.join(state, "claude", `${id}.json`), JSON.stringify({
        cwd: homeRoot, sdkSessionId: `private-sdk-${id}`, thread: { id, source: "claude", title: "Invented Claude profile",
          titleSource: "derived", createdAt: 1, updatedAt: 2, executionMode: "auto", model: "sonnet",
          linkedDirectories: [{ id: homeRoot, kind: "local", path: homeRoot, label: "Fixture" }],
          ...(id === archivedId ? { archivedAt: 3 } : {}) },
      }), { mode: 0o600 });
    },
  });
  try {
    await expect(app.window.getByRole("button", { name: /Invented Claude profile/i }).first()).toBeVisible();
    const result = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = await api.getNavigationSelectedDetail!({ protocol: 2, ref });
      await api.renameThread!({ ...ref, name: "Desktop changed Claude metadata" });
      await api.setThreadPin!({ ...ref, pinnedRank: "2048" });
      await api.markThreadSeen!({ ...ref, seenAt: 10000, seenUpdatedAt: 2 });
      await api.setThreadExecutionMode!({ ...ref, executionMode: "default" });
      const after = await api.getNavigationSelectedDetail!({ protocol: 2, ref });
      await api.archiveThread!(ref);
      return { before, after };
    }, ref);
    expect(result.before.thread).toMatchObject({ title: "Invented Claude profile", titleSource: "derived" });
    expect(result.after.thread).toMatchObject({ title: "Desktop changed Claude metadata", titleSource: "explicit", pinnedRank: "2048" });
    await app.closeApplication();
    const state = path.dirname(stateDbPathForHomeRoot(app.homeRoot));
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try { new ProviderThreadSnapshotStore(db).replace({ backend: "claude", observedAt: Date.now(), threads: [] }); }
    finally { db.close(); }
    const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
    const profile = openOutpostProfileRuntime({ stateDirectory: state, profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(path.join(state, "headless"), { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const owner = new HeadlessBackend({ workspace: app.homeRoot, store, projects: { list: () => [] },
        onFailure(error: unknown) { throw error; } }, () => {});
      const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
      expect(detail.identity).toBe("archived");
      expect(detail.thread).toMatchObject({ title: result.after.thread!.title, titleSource: "explicit", pinnedRank: "2048",
        executionMode: "default", inbox: { inInbox: result.after.thread!.inbox.inInbox } });
      expect((await owner.handle("lookupArchivedThreads", { backend: "claude", threadIds: [archivedId] })).threads)
        .toMatchObject([{ id: archivedId, title: "Invented Claude profile" }]);
      expect(JSON.stringify(detail)).not.toContain("private-sdk-");
      await expect(owner.handle("readThread", ref)).rejects.toThrow("executes Codex only");
    } finally { profile.close(); }
  } finally { await app.close(); }
});
