import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

// An overlay is presentation metadata. Only a native member, a committed
// legacy import or a durable job can establish an independently readable owner.
it("does not turn arbitrary stale overlays into retained Codex owner identities", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.boolean(), async (threadId, titled) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-overlay-owner-")));
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const ref = { backend: "codex", threadId };
      const facts = { pinnedRank: "1024", model: "retained-model", fastMode: true,
        ...(titled ? { title: { text: "Saved overlay title", source: "derived" } } : {}) };
      store.threadRegistry.updateThreadMetadata(ref, facts);
      const owner = new HeadlessBackend({ workspace: root, store, projects: { list: () => [] },
        onFailure(error: unknown) { throw error; }, codex: { listThreads: async () => [] } }, () => {});
      await owner.initialize();
      expect((await owner.handle("resolveThread", ref)).thread).toBeUndefined();
      expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe("unresolved");
      expect([...owner.threads.values()]).toEqual([]);
      expect(store.threadRegistry.getThreadMetadata(ref)).toMatchObject(facts);
    } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 20 });
});

// A complete provider walk owns native membership. An imported owner not yet
// confirmed by that provider and a durable acceptance are independent facts.
it("models complete native Codex retirement without retiring pending imports or accepted-job identity across reopen", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("active", "archive", "absent", "reopen"), { minLength: 1, maxLength: 12 }),
    fc.boolean(), async (generated, acknowledged) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-codex-member-")));
      const directory = path.join(root, "headless");
      mkdirSync(path.join(directory, "jobs"), { recursive: true, mode: 0o700 });
      const identity = { version: 1 as const, workspace: root, codexHome: path.join(root, "codex") };
      writeFileSync(path.join(directory, "identity.json"), JSON.stringify(identity));
      writeFileSync(path.join(directory, "threads.json"), JSON.stringify({ version: 1, threads: [
        { id: "pending", title: "Pending imported title", titleSource: "derived", sandbox: "read-only" },
      ] }));
      writeFileSync(path.join(directory, "jobs/accepted.json"), JSON.stringify({ version: 1, id: "accepted", status: "completed",
        fingerprint: "confirmed-input", threadId: "accepted-thread", turnId: "confirmed-turn", sandbox: "read-only",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
      const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
      const overlay = new SqliteOverlayStore(db);
      const ref = { backend: "codex" as const, threadId: "native" };
      const facts = { pinnedRank: "1024", parent: { backend: "claude" as const, threadId: "parent" }, seenAt: 10,
        seenUpdatedAt: 2, model: "retained-model", reasoningEffort: "high", fastMode: true };
      await overlay.updateThreadMetadata(ref, { ...facts,
        ...(acknowledged ? { title: { text: "Native", source: "derived", nativeName: "Native" } as const } : {}) });
      new AcpSessionStore(db).upsertSession({ backendId: "acp:fixture", sessionId: "native", title: "Other backend", titleSource: "explicit",
        createdAt: 1, updatedAt: 2, status: "idle", executionMode: "default" });
      const native = { id: "native", source: "codex" as const, title: "Native", titleSource: "explicit" as const, createdAt: 1, updatedAt: 2, linkedDirectories: [] };
      new ProviderThreadSnapshotStore(db).replace({ backend: "codex", observedAt: 1, threads: [native] });
      let profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
      let state = "active";
      const create = () => {
        const store = new JobStore(directory, identity, profile);
        const runtime = { workspace: root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; },
          codex: { listThreads: async ({ archived }: { archived: boolean }) => state !== "absent" && archived === (state === "archive")
            ? [native, { ...native, id: "accepted-thread" }] : [],
            renameThread: async () => { throw new Error("An absent pending import must not be published"); } } };
        return { store, owner: new HeadlessBackend(runtime, () => {}) };
      };
      let { store, owner } = create();
      const accepted = store.get("accepted");
      try {
        await owner.initialize();
        // Include the named minimal counterexample in every generated history.
        for (const operation of ["absent", "reopen", ...generated]) {
          if (operation === "reopen") {
            profile.close();
            profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
            ({ store, owner } = create());
            await owner.initialize();
          } else { state = operation; await owner.refreshThreads(); }
          const resolved = (await owner.handle("resolveThread", ref)).thread;
          expect(Boolean(resolved)).toBe(state !== "absent");
          if (resolved) expect(resolved).toMatchObject({ pinnedRank: facts.pinnedRank, model: facts.model, fastMode: facts.fastMode,
            reasoningEffort: facts.reasoningEffort, parentThreadId: "parent", title: "Native",
            titleSource: acknowledged ? "derived" : "explicit" });
          expect([...owner.threads.values()].some((thread: { id: string }) => thread.id === "native")).toBe(state !== "absent");
          expect((await owner.handle("lookupArchivedThreads", { backend: "codex", threadIds: ["native"] })).threads.length).toBe(state === "archive" ? 1 : 0);
          expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe(state === "absent" ? "unresolved" : state === "archive" ? "archived" : "present");
          expect((await owner.handle("resolveThread", { threadId: "pending" })).thread).toMatchObject({ title: "Pending imported title", titleSource: "derived" });
          expect((await owner.handle("resolveThread", { threadId: "accepted-thread" })).thread).toBeDefined();
          expect(store.get("accepted")).toEqual(accepted);
          expect((await owner.handle("resolveThread", { backend: "acp:fixture", threadId: "native" })).thread.title).toBe("Other backend");
          expect(await overlay.getThreadMetadata(ref)).toMatchObject(facts);
        }
      } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
    }), { numRuns: 20 });
});

it("a listing admitted before native creation cannot retire it, but a later complete absence can", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.uuid(), async threadId => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-codex-create-")));
    const directory = path.join(root, "headless");
    mkdirSync(directory, { mode: 0o700 });
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      let wait: Promise<void> | undefined;
      let release!: () => void;
      const runtime = { workspace: root, store: new JobStore(directory, { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile),
        turnQueue: { getAllQueuedEntries: () => [], drainAll() {} },
        loadedThreads: new Set(), messagingTools: { buildDynamicToolSpecs: () => [] }, projects: { list: () => [], resolve: () => root },
        onFailure(error: unknown) { throw error; }, codex: { listThreads: async () => { await wait; return []; },
          startThread: async () => ({ threadId }) } };
      const owner = new HeadlessBackend(runtime, () => {});
      await owner.initialize();
      wait = new Promise<void>(resolve => { release = resolve; });
      const discovery = owner.refreshThreads();
      await Promise.resolve();
      await owner.handle("startThread");
      release();
      await discovery;
      expect((await owner.handle("resolveThread", { threadId })).thread).toBeDefined();
      wait = undefined;
      const reopened = new HeadlessBackend(runtime, () => {});
      await reopened.initialize();
      expect((await reopened.handle("resolveThread", { threadId })).thread).toBeUndefined();
    } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});

it("failed or overlapping complete walks publish no partial retirement, and late events cannot resurrect a retired native", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.constantFrom("active", "archive"), fc.array(fc.constantFrom("thread/name/updated", "turn/completed", "thread/status/changed"),
    { minLength: 1, maxLength: 12 }), async (failure, events) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-codex-fail-")));
      mkdirSync(path.join(root, "headless"), { mode: 0o700 });
      const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
      try {
        const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
        let absent = false;
        let fail = false;
        let wait: Promise<void> | undefined;
        let release!: () => void;
        const native = { id: "native", source: "codex", title: "Native", titleSource: "explicit", linkedDirectories: [] };
        const runtime = { workspace: root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; },
          codex: { listThreads: async ({ archived, requireComplete }: { archived: boolean; requireComplete: boolean }) => {
            expect(requireComplete).toBe(true);
            await wait;
            if (fail && archived === (failure === "archive")) throw new Error("incomplete provider walk");
            return !absent && !archived ? [native] : [];
          } } };
        const owner = new HeadlessBackend(runtime, () => {});
        await owner.initialize();
        const before = store.inventory.list();
        absent = true; fail = true;
        wait = new Promise<void>(resolve => { release = resolve; });
        const first = owner.refreshThreads();
        const second = owner.refreshThreads();
        const refused = Promise.allSettled([first, second]);
        release();
        expect((await refused).map(result => result.status)).toEqual(["rejected", "rejected"]);
        expect(store.inventory.list()).toEqual(before);
        expect(store.threadRegistry.getThreadMetadata({ backend: "codex", threadId: "native" })).toBeUndefined();
        expect(owner.threads.get("native")).toBeDefined();
        fail = false; wait = undefined;
        await owner.refreshThreads();
        for (const method of events) owner.event({ method, params: { threadId: "native", threadName: "Late name", turn: { id: "late", status: "completed" } } });
        owner.syncJobs();
        expect(owner.threads.get("native")).toBeUndefined();
        expect([...owner.threads.values()]).toEqual([]);
      } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
    }), { numRuns: 20 });
});

it("publishes a pending imported title only after native confirmation, then retires that confirmed member", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z][a-z]{1,15}$/), async suffix => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-codex-pending-")));
    mkdirSync(path.join(root, "headless"), { mode: 0o700 });
    writeFileSync(path.join(root, "headless/threads.json"), JSON.stringify({ version: 1, threads: [
      { id: "pending", title: `Imported ${suffix}`, titleSource: "derived", sandbox: "read-only" },
    ] }));
    writeFileSync(path.join(root, "headless/identity.json"), JSON.stringify({ version: 1, workspace: root, codexHome: path.join(root, "codex") }));
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const ref = { backend: "codex", threadId: "pending" };
      let present = false;
      let nativeName = "Native before publication";
      let renames = 0;
      const runtime = { workspace: root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; },
        codex: { listThreads: async ({ archived }: { archived: boolean }) => present && !archived
          ? [{ id: "pending", source: "codex", title: nativeName, titleSource: "explicit", linkedDirectories: [] }] : [],
          renameThread: async ({ name }: { name: string }) => { nativeName = name; renames++; return { threadId: "pending" }; } } };
      const owner = new HeadlessBackend(runtime, () => {});
      await owner.initialize();
      expect(renames).toBe(0);
      expect(owner.threads.get("pending").title).toBe(`Imported ${suffix}`);
      present = true;
      await owner.refreshThreads();
      expect(renames).toBe(1);
      expect(nativeName).toBe(`Imported ${suffix}`);
      expect(store.threadRegistry.getThreadMetadata(ref).title).toEqual({ text: nativeName, source: "derived", nativeName });
      present = false;
      await owner.refreshThreads();
      expect(owner.threads.get("pending")).toBeUndefined();
      expect(renames).toBe(1);
    } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});
