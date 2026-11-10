import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const backends = ["acp:removed", "acp:other"] as const;
const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/);
type Command = { operation: "save" | "delete" | "overlay" | "reopen"; backend: typeof backends[number];
  name: string; archived: boolean; hidden: boolean; seen: boolean; mode: "default" | "auto" | "full-access" };

async function checkMembership(id: string, commands: Command[], finalOnly = false): Promise<void> {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-acp-members-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const sessions = new AcpSessionStore(db);
  const overlay = new SqliteOverlayStore(db);
  const inventory = new ProviderThreadSnapshotStore(db);
  const model = new Map<string, AcpSessionMetadata>();
  const seen = new Map<string, number>();
  const stale = (backend: typeof backends[number]): AppServerThreadSummary => ({ id, source: backend,
    title: "Stale inventory", titleSource: "explicit", createdAt: -1, updatedAt: -1, linkedDirectories: [], archivedAt: 1 });
  // A retained snapshot and canonical overlay are metadata, never membership.
  for (const backend of backends) inventory.replace({ backend, observedAt: Date.now() + 100_000, threads: [stale(backend)] });
  inventory.replace({ backend: "codex", observedAt: 1, threads: [{ id, source: "codex", title: "Colliding Codex", titleSource: "explicit", linkedDirectories: [] }] });
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = { workspace: root, store, projects: { list: () => [] }, codex: { listModels: async () => [] },
      onFailure(error: unknown) { throw error; } };
    let owner = new HeadlessBackend(runtime, () => {});
    for (const [index, command] of commands.entries()) {
      const backend = command.backend;
      const ref = { backend, threadId: id };
      if (command.operation === "save") {
        const session: AcpSessionMetadata = { backendId: backend, sessionId: id, title: command.name, titleSource: "derived",
          createdAt: 10, updatedAt: 100 + index, cwd: path.join(root, command.name), status: "idle", executionMode: command.mode,
          ...(command.archived ? { archivedAt: 200 + index } : {}), ...(command.hidden ? { hidden: true } : {}) };
        sessions.upsertSession(session); model.set(backend, session);
      } else if (command.operation === "delete") {
        sessions.deleteSession(backend, id); model.delete(backend);
      } else if (command.operation === "overlay") {
        const watermark = command.seen ? 10_000 : 0;
        seen.set(backend, watermark);
        await overlay.updateThreadMetadata(ref, { title: { text: "Stale canonical title", source: "explicit" },
          createdAt: -2, updatedAt: -2, cwd: "/stale", archived: true,
          pinnedRank: "1024", parent: { backend: "codex", threadId: "parent" }, subthreadOrder: ["child"], subthreadsCollapsed: true,
          seenAt: 100_000, seenUpdatedAt: watermark, model: "owner-model", reasoningEffort: "high", serviceTier: "flex", fastMode: true });
      } else owner = new HeadlessBackend(runtime, () => {});
      if (finalOnly && index < commands.length - 1) continue;

      for (const candidate of backends) {
        const identity = { backend: candidate, threadId: id };
        const session = model.get(candidate);
        const present = session !== undefined && !session.hidden;
        expect(sessions.getSession(candidate, id)).toEqual(session);
        const resolved = (await owner.handle("resolveThread", identity)).thread;
        const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref: identity });
        expect(resolved !== undefined).toBe(present);
        expect(detail.identity).toBe(!present ? "unresolved" : session.archivedAt ? "archived" : "present");
        if (present) {
          expect(resolved).toMatchObject({ title: session.title, titleSource: "derived", createdAt: 10, updatedAt: session.updatedAt,
            projectKey: session.cwd, executionMode: session.executionMode });
          expect(resolved.archivedAt).toBe(session.archivedAt);
          if (seen.has(candidate)) expect(resolved).toMatchObject({ pinnedRank: "1024", parentThreadId: "parent", parentThreadBackend: "codex",
            subthreadOrder: ["child"], subthreadsCollapsed: true, model: "owner-model", reasoningEffort: "high", serviceTier: "flex", fastMode: true,
            inbox: { inInbox: session.updatedAt > seen.get(candidate)! } });
        }
        expect(detail.thread).toEqual(resolved);
        const active = (await owner.handle("listThreads", { backend: candidate })).threads;
        expect(active.map((thread: AppServerThreadSummary) => thread.id)).toEqual(present && !session.archivedAt ? [id] : []);
        const archived = await owner.handle("lookupArchivedThreads", { backend: candidate, threadIds: [id], includeParent: true });
        expect(archived.threads.map((thread: AppServerThreadSummary) => thread.id)).toEqual(present && session.archivedAt ? [id] : []);
        expect(archived.parentLinks).toHaveLength(present ? 1 : 0);
        const page = await owner.handle("getNavigationQueryPage", { protocol: 2, consumer: "remote-window", backend: candidate,
          query: { kind: "exact", identities: [identity] } });
        expect(page.entries).toHaveLength(present && !session.archivedAt ? 1 : 0);
        await expect(owner.handle("readThread", identity)).rejects.toThrow("executes Codex only");
      }
      const all = (await owner.handle("listThreads", { backend: "all" })).threads;
      expect(all.filter((thread: AppServerThreadSummary) => thread.source.startsWith("acp:")).map((thread: AppServerThreadSummary) => thread.source).sort())
        .toEqual([...model.values()].filter(session => !session.hidden && !session.archivedAt).map(session => session.backendId).sort());
      expect((await owner.handle("resolveThread", { backend: "codex", threadId: id })).thread.title).toBe("Colliding Codex");
    }
  } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}

const command = fc.record({ operation: fc.constantFrom("save" as const, "delete" as const, "overlay" as const, "reopen" as const),
  backend: fc.constantFrom(...backends), name: word, archived: fc.boolean(), hidden: fc.boolean(), seen: fc.boolean(),
  mode: fc.constantFrom("default" as const, "auto" as const, "full-access" as const) });

it("native ACP membership is authoritative through deletion, hidden helpers, stale overlays, retained inventories and owner reopen", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.array(command, { minLength: 1, maxLength: 10 }),
    (id, commands) => checkMembership(id, commands)), { numRuns: 25 });
});

it("a deleted actual ACP session cannot resolve its retained pin overlay", async () => {
  const base = { backend: "acp:removed" as const, name: "A", archived: false, hidden: false, seen: true, mode: "auto" as const };
  await checkMembership("removed", [{ ...base, operation: "save" }, { ...base, operation: "overlay" },
    { ...base, operation: "delete" }], true);
});

it("actual ACP title, provenance, workspace, times, archive and mode outrank stale canonical metadata while owner settings survive", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), word, fc.boolean(), fc.boolean(),
    fc.constantFrom("default" as const, "auto" as const, "full-access" as const), async (id, name, archived, seen, mode) => {
      const base = { backend: "acp:removed" as const, name, archived, hidden: false, seen, mode };
      await checkMembership(id, [{ ...base, operation: "save" }, { ...base, backend: "acp:other", operation: "save" },
        { ...base, operation: "overlay" }], true);
    }), { numRuns: 25 });
});

it("keeps durable ACP archive observations authoritative for members while deletion always retires membership", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    await fc.assert(fc.asyncProperty(fc.nat(100), fc.boolean(),
      fc.array(fc.constantFrom("observe", "archive", "restore", "delete", "save", "hidden"), { minLength: 1, maxLength: 10 }),
      async (start, nativeArchived, commands) => {
        const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-acp-archive-")));
        mkdirSync(path.join(root, "headless"), { mode: 0o700 });
        const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
        const sessions = new AcpSessionStore(db);
        const overlay = new SqliteOverlayStore(db);
        const ref = { backend: "acp:removed" as const, threadId: "member" };
        const native = { backendId: ref.backend, sessionId: ref.threadId, title: "Native member", titleSource: "derived" as const,
          createdAt: 0, updatedAt: 1, status: "idle" as const, executionMode: "auto" as const,
          ...(nativeArchived ? { archivedAt: 7 } : {}) };
        sessions.upsertSession(native);
        const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
        try {
          const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
          const runtime = { workspace: root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; } };
          let present = true;
          let archived = nativeArchived;
          let archiveStamp = native.archivedAt;
          let retainedAt: number | undefined;
          let tombstoneAt: number | undefined;
          let restoredAt: number | undefined;
          for (const [index, command] of commands.entries()) {
            const at = start + index;
            if (command === "observe") { await overlay.observeArchivedThreads([ref], at); retainedAt ??= at; }
            if (command === "archive") { await overlay.setThreadArchiveTombstone({ ...ref, archivedAt: at }); tombstoneAt = at; }
            if (command === "restore") {
              await overlay.setThreadArchiveTombstone({ ...ref, restoredAt: at });
              restoredAt = at; retainedAt = undefined; tombstoneAt = undefined;
            }
            if (retainedAt !== undefined || tombstoneAt !== undefined || restoredAt !== undefined) {
              const latestArchive = Math.max(retainedAt ?? -Infinity, tombstoneAt ?? -Infinity);
              archived = latestArchive > (restoredAt ?? -Infinity);
              archiveStamp = archived ? latestArchive : undefined;
            }
            if (command === "delete") { sessions.deleteSession(ref.backend, ref.threadId); present = false; }
            if (command === "save" || command === "hidden") {
              sessions.upsertSession({ ...native, hidden: command === "hidden" }); present = command === "save";
            }
            const before = await overlay.getThreadMetadata(ref);
            const { writes } = await measureSqliteWrites(async () => {
              for (let round = 0; round < 3; round++) {
                const owner = new HeadlessBackend(runtime, () => {});
                const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
                expect(detail.identity).toBe(!present ? "unresolved" : archived ? "archived" : "present");
                expect(detail.thread?.archivedAt).toBe(present && archived ? archiveStamp : undefined);
                expect((await owner.handle("resolveThread", ref)).thread !== undefined).toBe(present);
                expect((await owner.handle("listThreads", { backend: ref.backend })).threads).toHaveLength(present && !archived ? 1 : 0);
                expect((await owner.handle("lookupArchivedThreads", { backend: ref.backend, threadIds: [ref.threadId] })).threads)
                  .toHaveLength(present && archived ? 1 : 0);
              }
            });
            expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
            expect(await overlay.getThreadMetadata(ref)).toEqual(before);
          }
        } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
      }), { numRuns: 25, examples: [[0, false, ["observe"]], [0, true, ["restore"]], [0, false, ["observe", "observe"]],
        [0, false, ["observe", "delete", "save", "restore", "hidden"]]] });
  } finally { vi.unstubAllEnvs(); }
});
