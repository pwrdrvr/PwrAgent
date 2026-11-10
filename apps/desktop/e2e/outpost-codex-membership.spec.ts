import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve(specDir, "../../../packages/pwragent/src", file)).href);

test.beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(specDir, "../../../packages/pwragent/scripts/build.mjs")], {
    cwd: path.resolve(specDir, "../../.."), stdio: "pipe",
  });
});

test("desktop and Outpost retire confirmed native Codex membership while pending imports and accepted jobs survive", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const ref = { backend: "codex" as const, threadId: "thread-smoke" };
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      const headless = path.join(stateDirectory, "headless");
      await mkdir(path.join(headless, "jobs"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(headless, "identity.json"), JSON.stringify({ version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }));
      await writeFile(path.join(headless, "threads.json"), JSON.stringify({ version: 1, threads: [
        { id: "pending-import", title: "Pending imported owner", titleSource: "derived", sandbox: "read-only" },
      ] }));
      await writeFile(path.join(headless, "jobs/accepted.json"), JSON.stringify({ version: 1, id: "accepted", status: "completed",
        fingerprint: "accepted-input-identity", threadId: "accepted-owner", turnId: "accepted-turn", sandbox: "read-only",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: homeRoot });
      try {
        const store = new JobStore(headless, { version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }, profile);
        store.threadRegistry.updateThreadMetadata(ref, { title: { text: "Replay smoke thread", source: "derived", nativeName: "Replay smoke thread" },
          pinnedRank: "1024", seenAt: 10, seenUpdatedAt: 2, model: "retained-model", fastMode: true });
      } finally { profile.close(); }
    },
  });
  let reopened: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  let archivedReopened: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    await expect(app.window.getByRole("button", { name: /Replay smoke thread/i }).first()).toBeVisible();
    const native = await app.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.getNavigationSelectedDetail!({ protocol: 2, ref: identity })).thread!;
    }, ref);
    expect(native).toMatchObject({ title: "Replay smoke thread", titleSource: "derived", pinnedRank: "1024" });
    await app.closeApplication();
    const stateDirectory = path.dirname(stateDbPathForHomeRoot(app.homeRoot));
    const identity = { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") };
    let present = true;
    for (let round = 0; round < 2; round++) {
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: app.homeRoot });
      try {
        const store = new JobStore(path.join(stateDirectory, "headless"), identity, profile);
        const job = store.get("accepted");
        let entered!: () => void;
        let release!: () => void;
        const renaming = new Promise<void>(resolve => { entered = resolve; });
        const provider = new Promise<void>(resolve => { release = resolve; });
        const owner = new HeadlessBackend({ workspace: app.homeRoot, store, projects: { list: () => [] },
          onFailure(error: unknown) { throw error; }, codex: { listThreads: async ({ archived }: { archived: boolean }) => present
            ? [{ ...native, id: archived ? "archived-native" : native.id }] : [],
          renameThread: async () => { entered(); await provider; return { threadId: ref.threadId }; } } }, () => {});
        await owner.initialize();
        if (round === 0) {
          expect(owner.threads.get(ref.threadId)).toMatchObject({ pinnedRank: "1024" });
          expect(owner.threads.get("archived-native").archived).toBe(true);
          const rename = owner.handle("renameThread", { ...ref, name: "Renamed native" });
          try {
            await renaming;
            await owner.handle("markThreadSeen", { ...ref, seenAt: 123, seenUpdatedAt: 2 });
            await owner.handle("setThreadModelSettings", { ...ref, model: "after-model", reasoningEffort: "high", serviceTier: "priority" });
            await owner.handle("setThreadExecutionMode", { ...ref, executionMode: "auto" });
            const latest = store.threadRegistry.getThreadMetadata(ref);
            release();
            await rename;
            expect(store.threadRegistry.getThreadMetadata(ref)).toEqual({ ...latest,
              title: { text: "Renamed native", source: "explicit", nativeName: "Renamed native" } });
          } finally { release(); await rename; }
          present = false;
          await owner.refreshThreads();
        }
        expect((await owner.handle("resolveThread", ref)).thread).toBeUndefined();
        expect(owner.threads.get("archived-native")).toBeUndefined();
        expect(owner.threads.get("pending-import").title).toBe("Pending imported owner");
        expect(owner.threads.get("accepted-owner")).toBeDefined();
        expect(store.get("accepted")).toEqual(job);
        expect(job).toMatchObject({ fingerprint: "accepted-input-identity", threadId: "accepted-owner", turnId: "accepted-turn", status: "completed" });
        expect(store.threadRegistry.getThreadMetadata(ref)).toMatchObject({ pinnedRank: "1024", seenAt: 123, seenUpdatedAt: 2,
          model: "after-model", reasoningEffort: "high", serviceTier: "priority", executionMode: "auto", fastMode: true });
      } finally { profile.close(); }
    }
    const fixture = JSON.parse(await readFile(path.join(specDir, "fixtures/smoke/replay.fixture.json"), "utf8"));
    for (const step of fixture.steps) if (step.method === "thread/list") step.result = [];
    const emptyFixture = path.join(app.homeRoot, "empty-codex.fixture.json");
    await writeFile(emptyFixture, JSON.stringify(fixture));
    reopened = await launchElectronApp({ homeRoot: app.homeRoot, secretStorage: "memory", fixturePath: emptyFixture });
    const absent = await reopened.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.getNavigationSelectedDetail!({ protocol: 2, ref: identity });
    }, ref);
    expect(absent.identity).toBe("unresolved");
    await expect(reopened.window.getByRole("button", { name: /Replay smoke thread/i })).toHaveCount(0);
    // The same actual Electron owner must retain both durable identities after
    // the Outpost retired the separate native member and restarted twice.
    const retained = await reopened.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const identities = ["pending-import", "accepted-owner"].map(threadId => ({ backend: "codex" as const, threadId }));
      const details = await Promise.all(identities.map(ref => api.getNavigationSelectedDetail!({ protocol: 2, ref })));
      const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", backend: "codex",
        query: { kind: "exact", identities } });
      return { details, ids: page.entries.map(entry => entry.row.id).sort() };
    });
    expect(retained.ids).toEqual(["accepted-owner", "pending-import"]);
    expect(retained.details[0].thread).toMatchObject({ title: "Pending imported owner", titleSource: "derived" });
    expect(retained.details[1].thread).toBeDefined();
    await reopened.closeApplication();
    // Current owner archive observations also apply to identities retained
    // independently of native membership, including an exact timestamp zero.
    const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: app.homeRoot });
    const retainedRefs = ["pending-import", "accepted-owner"].map(threadId => ({ backend: "codex" as const, threadId }));
    try {
      const store = new JobStore(path.join(stateDirectory, "headless"), identity, profile);
      for (const ref of retainedRefs) store.threadRegistry.updateThreadMetadata(ref, { archiveRetentionStartedAt: 0 });
      const owner = new HeadlessBackend({ workspace: app.homeRoot, store, projects: { list: () => [] },
        onFailure(error: unknown) { throw error; }, codex: { listThreads: async () => [] } }, () => {});
      await owner.initialize();
      for (const ref of retainedRefs) expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe("archived");
    } finally { profile.close(); }
    archivedReopened = await launchElectronApp({ homeRoot: app.homeRoot, secretStorage: "memory", fixturePath: emptyFixture });
    const archived = await archivedReopened.window.evaluate(async refs => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const details = await Promise.all(refs.map(ref => api.getNavigationSelectedDetail!({ protocol: 2, ref })));
      const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", backend: "codex",
        query: { kind: "lens", lens: "recents" } });
      return { details, activeIds: page.entries.map(entry => entry.row.id).filter(id => refs.some(ref => ref.threadId === id)) };
    }, retainedRefs);
    expect(archived.details.map(detail => detail.thread?.archivedAt)).toEqual([0, 0]);
    expect(archived.activeIds).toEqual([]);
  } finally { await archivedReopened?.close(); await reopened?.close(); await app.close(); }
});
