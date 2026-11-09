import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { AppServerBackendKind, AppServerThreadSummary } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const backends = ["codex", "claude", "acp:fixture"] as const;
const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,15}$/);

function native(backend: AppServerBackendKind, name: string, archived = false): AppServerThreadSummary {
  return { id: "00000000-0000-4000-8000-000000000001", source: backend, title: `${backend} ${name}`, titleSource: "explicit",
    createdAt: 10, updatedAt: 20, executionMode: "full-access", model: `${backend}-model`, fastMode: false,
    projectKey: "/fixture", linkedDirectories: [{ id: "fixture", kind: "local", path: "/fixture", label: "Fixture" }],
    ...(archived ? { archivedAt: 15 } : {}) };
}

it("every supported provider inventory round trips without changing another backend's identical thread ID", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ backend: fc.constantFrom(...backends), name: word }), { minLength: 1, maxLength: 12 }), async commands => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-provider-codec-")));
    const db = StateDb.open(path.join(root, "state.db"));
    const model = new Map<AppServerBackendKind, AppServerThreadSummary[]>();
    try {
      const store = new ProviderThreadSnapshotStore(db);
      for (const [revision, command] of commands.entries()) {
        const threads = [native(command.backend, command.name)];
        store.replace({ backend: command.backend, observedAt: revision, threads });
        model.set(command.backend, threads);
        expect(new ProviderThreadSnapshotStore(db).list().flatMap(snapshot => snapshot.threads))
          .toEqual([...model].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, rows]) => rows));
      }
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 25 });
});

it("discovers actual ACP session metadata without an installed agent or a retained inventory, including archives", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(word, fc.boolean(), fc.constantFrom("default", "auto", "full-access"), async (name, archived, executionMode) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-acp-discovery-")));
    mkdirSync(path.join(root, "headless"), { mode: 0o700 });
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
    const sessions = new AcpSessionStore(db);
    sessions.upsertSession({ backendId: "acp:removed", sessionId: "00000000-0000-4000-8000-000000000001", title: name, titleSource: "derived", cwd: root,
      createdAt: 1, updatedAt: 2, executionMode, status: "idle", ...(archived ? { archivedAt: 3 } : {}) });
    sessions.upsertSession({ backendId: "acp:removed", sessionId: "hidden", title: "Hidden helper", hidden: true,
      createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle" });
    await new SqliteOverlayStore(db).updateThreadMetadata({ backend: "acp:removed", threadId: "hidden" }, { pinnedRank: "1024" });
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const owner = new HeadlessBackend({ workspace: root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; } }, () => {});
      const ref = { backend: "acp:removed", threadId: "00000000-0000-4000-8000-000000000001" };
      const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
      expect(detail.identity).toBe(archived ? "archived" : "present");
      expect(detail.thread).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", source: "acp:removed", title: name, titleSource: "derived", executionMode });
      expect((await owner.handle("resolveThread", { backend: "acp:removed", threadId: "hidden" })).thread).toBeUndefined();
      expect((await owner.handle("listThreads", { backend: "all" })).threads.some((thread: AppServerThreadSummary) => thread.id === "hidden")).toBe(false);
      sessions.upsertSession({ ...sessions.getSession("acp:removed", "00000000-0000-4000-8000-000000000001")!, title: `Changed ${name}`, archivedAt: undefined });
      expect((await owner.handle("resolveThread", ref)).thread.title).toBe(`Changed ${name}`);
    } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 25 });
});

it("retained owner reads preserve provider identity, native authority and canonical facts through arbitrary desktop updates", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    backend: fc.constantFrom("claude", "acp:fixture"), name: word, archived: fc.boolean(), seen: fc.boolean(),
  }), { minLength: 1, maxLength: 10 }), async commands => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-provider-read-")));
    mkdirSync(path.join(root, "headless"), { mode: 0o700 });
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
    const overlay = new SqliteOverlayStore(db);
    const inventory = new ProviderThreadSnapshotStore(db);
    for (const backend of backends) inventory.replace({ backend, observedAt: 1, threads: [native(backend, "Native")] });
    const acp = new AcpSessionStore(db);
    acp.upsertSession({ backendId: "acp:fixture", sessionId: "00000000-0000-4000-8000-000000000001", title: "acp:fixture Native",
      titleSource: "explicit", cwd: "/fixture", createdAt: 10, updatedAt: 20, executionMode: "full-access", status: "idle" });
    const claude = new ClaudeSessionStore(path.join(root, "claude"));
    await claude.save({ cwd: "/fixture", thread: native("claude", "Native") });
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const runtime = { workspace: root, store, onFailure(error: unknown) { throw error; },
        projects: { list: () => [{ path: root, label: "Fixture" }] }, codex: { listModels: async () => [] } };
      let owner = new HeadlessBackend(runtime, () => {});
      for (const [index, command] of commands.entries()) {
        const backend = command.backend as AppServerBackendKind;
        const ref = { backend, threadId: "00000000-0000-4000-8000-000000000001" };
        if (backend === "claude") await claude.save({ cwd: "/fixture", thread: { ...native(backend, "Native"),
          title: command.name, titleSource: "derived", ...(command.archived ? { archivedAt: 100 + index * 2 } : {}) } });
        else acp.upsertSession({ ...acp.getSession("acp:fixture", ref.threadId)!, title: command.name, titleSource: "derived",
          archivedAt: command.archived ? 100 + index * 2 : undefined });
        await overlay.updateThreadMetadata(ref, { title: { text: command.name, source: "derived", nativeName: `${backend} Native` },
          pinnedRank: `${index}`, seenUpdatedAt: command.seen ? 20 : 19, seenAt: 1000,
          executionMode: "full-access", parent: { backend: "codex", threadId: "parent" },
          ...(command.archived ? { archivedAt: 100 + index * 2 } : { restoredAt: 101 + index * 2 }) });
        if (index % 2) owner = new HeadlessBackend(runtime, () => {});
        const resolved = (await owner.handle("resolveThread", ref)).thread;
        expect(resolved).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", source: backend, title: command.name, titleSource: "derived",
          pinnedRank: `${index}`, parentThreadId: "parent", parentThreadBackend: "codex", executionMode: "full-access",
          linkedDirectories: backend === "claude" ? native(backend, "Native").linkedDirectories
            : [{ id: "/fixture", kind: "local", path: "/fixture", label: "fixture" }], inbox: { inInbox: !command.seen } });
        const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
        expect(detail.identity).toBe(command.archived ? "archived" : "present");
        expect(detail.thread).toEqual(resolved);
        const active = (await owner.handle("listThreads", { backend })).threads;
        expect(active.map((row: AppServerThreadSummary) => row.source)).toEqual(command.archived ? [] : [backend]);
        const archived = await owner.handle("lookupArchivedThreads", { ...ref, threadIds: ["00000000-0000-4000-8000-000000000001"], includeParent: true });
        expect(archived.threads.map((row: AppServerThreadSummary) => row.source)).toEqual(command.archived ? [backend] : []);
        expect(archived.parentLinks).toEqual([{ ...ref, parentThreadId: "parent", parentThreadBackend: "codex", parentThreadInstanceId: undefined }]);
        expect((await owner.handle("resolveThread", { backend: "codex", threadId: "00000000-0000-4000-8000-000000000001" })).thread.title).toBe("codex Native");
        const page = await owner.handle("getNavigationQueryPage", { protocol: 2, consumer: "remote-window", backend,
          query: { kind: "exact", identities: [ref] } });
        expect(page.entries.map((entry: { row: { ref: { backend: string } } }) => entry.row.ref.backend)).toEqual(command.archived ? [] : [backend]);
      }
      const all = (await owner.handle("listThreads", { backend: "all" })).threads;
      expect(new Set(all.map((row: AppServerThreadSummary) => row.source)).size).toBe(all.length);
      const advertised = await owner.handle("listBackends");
      for (const backend of backends.filter(value => value !== "codex")) {
        expect(advertised.backends.find((entry: { kind: string }) => entry.kind === backend))
          .toMatchObject({ available: false, capabilities: { listThreads: true, createThread: false, readThread: false, startTurn: false } });
        for (const method of ["startThread", "startTurn", "steerTurn", "interruptTurn", "controlActiveTurn", "renameThread", "markThreadSeen", "setThreadExecutionMode", "setThreadModelSettings", "readThread", "getNavigationQueueProjection"]) {
          await expect(owner.handle(method, { backend, threadId: "00000000-0000-4000-8000-000000000001", ref: { backend, threadId: "00000000-0000-4000-8000-000000000001" } })).rejects.toThrow("executes Codex only");
        }
      }
    } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 25 });
});
