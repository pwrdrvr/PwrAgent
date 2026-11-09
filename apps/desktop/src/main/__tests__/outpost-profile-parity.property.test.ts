import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const title = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,25}$/).map(value => value.trim());

it("fresh provider discovery replaces stale inventory without losing canonical owner facts", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(title, fc.nat(10000), async (name, seen) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-parity-")));
    const directory = path.join(root, "headless");
    mkdirSync(directory, { mode: 0o700 });
    const identity = { version: 1 as const, workspace: root, codexHome: path.join(root, "codex") };
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
    const overlay = new SqliteOverlayStore(db);
    const inventory = new ProviderThreadSnapshotStore(db);
    inventory.replace({ backend: "codex", observedAt: 1, threads: [{ id: "obsolete", source: "codex", title: "Stale", titleSource: "explicit", linkedDirectories: [] }] });
    await overlay.updateThreadMetadata({ backend: "codex", threadId: "fresh" }, { pinnedRank: "1024", seenAt: seen + 1, seenUpdatedAt: seen,
      parent: { backend: "claude", threadId: "parent" } });
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const provider = [{ id: "fresh", source: "codex", title: name, titleSource: "explicit", createdAt: 1, updatedAt: seen + 2, projectKey: root, linkedDirectories: [] }];
      const calls: unknown[] = [];
      const runtime = { workspace: root, store: new JobStore(directory, identity, profile), onFailure(error: unknown) { throw error; },
        projects: { list: () => [{ path: root, label: "fixture" }] },
        codex: { listThreads: async (params: { archived: boolean }) => { calls.push(params); return params.archived ? [] : structuredClone(provider); } } };
      const backend = new HeadlessBackend(runtime, () => {});
      await backend.initialize();
      const rows = (await backend.handle("backend.listThreads")).threads;
      expect(rows.map((row: { id: string }) => row.id)).toEqual(["fresh"]);
      expect(rows[0]).toMatchObject({ title: name, titleSource: "explicit", pinnedRank: "1024", parentThreadId: "parent", inbox: { inInbox: true } });
      expect(calls).toContainEqual(expect.objectContaining({ requireComplete: true, archived: false }));
      expect(calls).toContainEqual(expect.objectContaining({ requireComplete: true, archived: true }));
    } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});

it("every acknowledged Outpost rename changes the native provider name before publishing owner success", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.array(title, { minLength: 1, maxLength: 8 }), async names => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-title-")));
    const directory = path.join(root, "headless");
    mkdirSync(directory, { mode: 0o700 });
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
    const overlay = new SqliteOverlayStore(db);
    const identity = { backend: "codex" as const, threadId: "thread" };
    await overlay.updateThreadMetadata(identity, { title: { text: "Before", source: "explicit" } });
    // This oracle renames an already-native thread. Presentation metadata
    // alone is not evidence that an absent provider thread is owned.
    new ProviderThreadSnapshotStore(db).replace({ backend: "codex", observedAt: 1,
      threads: [{ id: "thread", source: "codex", title: "Before", titleSource: "explicit", linkedDirectories: [] }] });
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      let nativeName = "Before";
      const runtime = { workspace: root, store: new JobStore(directory, { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile),
        onFailure(error: unknown) { throw error; }, codex: { renameThread: async (request: { name: string }) => { nativeName = request.name; return { threadId: "thread" }; },
          readThreadName: async () => nativeName } };
      const published: string[] = [];
      const backend = new HeadlessBackend(runtime, (event: { notification: { method: string; params: { threadName?: string } } }) => {
        if (event.notification.method === "thread/name/updated") { expect(nativeName).toBe(event.notification.params.threadName); published.push(nativeName); }
      });
      for (const name of names) {
        await backend.handle("backend.renameThread", { ...identity, name });
        expect(nativeName).toBe(name);
        expect((await overlay.getThreadMetadata(identity))?.title).toMatchObject({ text: name, source: "explicit" });
      }
      expect(published).toEqual(names);
    } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});

it("a provider listing begun before an acknowledged rename cannot restore the old title", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(title, async name => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-title-race-")));
    mkdirSync(path.join(root, "headless"), { mode: 0o700 });
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      let nativeName = "Before";
      let wait: Promise<void> | undefined;
      let release: (() => void) | undefined;
      const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const runtime = { workspace: root, store, onFailure(error: unknown) { throw error; },
        projects: { list: () => [{ path: root, label: "fixture" }] },
        codex: { listThreads: async ({ archived }: { archived: boolean }) => {
          const snapshot = archived ? [] : [{ id: "thread", source: "codex", title: nativeName, titleSource: "explicit", linkedDirectories: [] }];
          await wait;
          return snapshot;
        }, renameThread: async ({ name }: { name: string }) => { nativeName = name; return { threadId: "thread" }; } } };
      const backend = new HeadlessBackend(runtime, () => {});
      await backend.initialize();
      wait = new Promise<void>(resolve => { release = resolve; });
      const listing = backend.refreshThreads();
      await Promise.resolve();
      await backend.handle("renameThread", { threadId: "thread", name: `After ${name}` });
      release!();
      await listing;
      expect(backend.summary(backend.owned("thread"))).toMatchObject({ title: `After ${name}`, titleSource: "explicit" });
    } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});

it("fresh complete provider archive membership outranks an unstamped retained owner flag", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 12 }), async states => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-archive-model-")));
    mkdirSync(path.join(root, "headless"), { mode: 0o700 });
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
    await new SqliteOverlayStore(db).updateThreadMetadata({ backend: "codex", threadId: "thread" }, { archived: false });
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      let archived = false;
      const runtime = { workspace: root, store: new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile),
        projects: { list: () => [{ path: root, label: "fixture" }] }, onFailure(error: unknown) { throw error; },
        codex: { listThreads: async (params: { archived: boolean }) => params.archived === archived
          ? [{ id: "thread", source: "codex", title: "Native", titleSource: "explicit", linkedDirectories: [] }] : [] } };
      const backend = new HeadlessBackend(runtime, () => {});
      await backend.initialize();
      for (const state of states) {
        archived = state;
        const active = await backend.handle("listThreads");
        const retired = await backend.handle("lookupArchivedThreads", { threadIds: ["thread"] });
        expect(active.threads.map((thread: { id: string }) => thread.id)).toEqual(state ? [] : ["thread"]);
        expect(retired.threads.map((thread: { id: string }) => thread.id)).toEqual(state ? ["thread"] : []);
      }
    } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});
