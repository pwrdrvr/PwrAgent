import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerBackendKind, AppServerThreadSummary } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { ClaudeSessionStore } from "../claude/claude-session-store";

const backends = ["codex", "claude", "acp:removed"] as const;
const threadId = "00000000-0000-4000-8000-000000000001";
const metadataOnlyId = "00000000-0000-4000-8000-000000000002";
const absentId = "00000000-0000-4000-8000-000000000003";
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
afterEach(() => vi.unstubAllEnvs());

function native(backend: AppServerBackendKind, updatedAt: number): AppServerThreadSummary {
  return { id: threadId, source: backend, title: `${backend} native`, titleSource: "explicit",
    createdAt: 0, updatedAt, linkedDirectories: [], executionMode: "default" };
}

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-provider-owner-compat-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const claude = new ClaudeSessionStore(path.join(root, "claude"));
  return { root, db, claude, desktop: new SqliteOverlayStore(db), inventory: new ProviderThreadSnapshotStore(db), sessions: new AcpSessionStore(db),
    async saveClaude(updatedAt: number, archivedAt?: number) {
      await claude.save({ cwd: root, thread: { ...native("claude", updatedAt), source: "claude",
        ...(archivedAt !== undefined ? { archivedAt } : {}) } });
    },
    async seed(backend: AppServerBackendKind, updatedAt: number, observedAt: number) {
      this.inventory.replace({ backend, observedAt, threads: [native(backend, updatedAt)] });
      if (backend === "claude") await this.saveClaude(updatedAt);
      if (backend === "acp:removed") this.sessions.upsertSession({ backendId: backend, sessionId: threadId,
        title: `${backend} native`, titleSource: "explicit", createdAt: 0, updatedAt, executionMode: "default", status: "idle" });
    },
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function open(f: ReturnType<typeof fixture>) {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.root });
  const store = new JobStore(path.join(f.root, "headless"), { version: 1, workspace: f.root, codexHome: path.join(f.root, "codex") }, profile);
  const runtime = { workspace: f.root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; } };
  return { reopen: () => new HeadlessBackend(runtime, () => {}), close: () => profile.close() };
}

it("keeps same-ID unread baselines backend-qualified against the actual desktop oracle without materializing them", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.tuple(fc.nat(3), fc.nat(3), fc.nat(3)), fc.nat(3),
    fc.option(fc.nat(3), { nil: undefined }), async (baselines, updatedAt, explicit) => {
      const f = fixture();
      const initial = backends.flatMap((backend, index) => f.desktop.readNavigationQueryIndex({
        backend, threads: [native(backend, baselines[index]!)],
      }).threads);
      f.desktop.initializeNavigationUnreadBaseline(initial);
      for (const backend of backends) {
        await f.seed(backend, updatedAt, 10000);
        await f.desktop.updateThreadMetadata({ backend, threadId }, { seenAt: 1000, seenUpdatedAt: explicit ?? null });
        await f.desktop.updateThreadMetadata({ backend, threadId: metadataOnlyId }, { executionMode: "default" });
        await f.desktop.updateThreadMetadata({ backend, threadId: absentId }, { executionMode: "default" });
        if (backend === "acp:removed") {
          f.sessions.upsertSession({ backendId: backend, sessionId: metadataOnlyId, title: "Untitled thread", titleSource: "fallback",
            createdAt: 0, updatedAt: 0, executionMode: "default", status: "idle" });
          await f.desktop.updateThreadMetadata({ backend, threadId: absentId }, { executionMode: "default" });
        }
        if (backend === "claude") {
          await f.claude.save({ cwd: f.root, thread: { id: metadataOnlyId, source: "claude", title: "Untitled thread", titleSource: "fallback",
            linkedDirectories: [], executionMode: "default" } });
          await f.desktop.updateThreadMetadata({ backend, threadId: absentId }, { executionMode: "default" });
        }
      }
      // The Codex fallback row is a real pending import. Other providers use
      // their actual native stores; unimported overlays remain absent for all.
      writeFileSync(path.join(f.root, "headless/identity.json"), JSON.stringify({ version: 1, workspace: f.root, codexHome: path.join(f.root, "codex") }));
      writeFileSync(path.join(f.root, "headless/threads.json"), JSON.stringify({ version: 1, threads: [{ id: metadataOnlyId }] }));
      const owner = await open(f);
      try {
        const before = await f.desktop.listThreadMetadata();
        const { writes } = await measureSqliteWrites(async () => {
          for (let round = 0; round < 5; round++) {
            const backend = owner.reopen();
            for (const [index, source] of backends.entries()) {
              const ref = { backend: source, threadId };
              const expected = updatedAt > (explicit ?? baselines[index]!);
              const desktop = f.desktop.readNavigationQueryIndex({ backend: source, threads: [native(source, updatedAt)] }).threads[0]!;
              expect(desktop.inbox.inInbox).toBe(expected);
              const resolved = (await backend.handle("resolveThread", ref)).thread;
              expect(resolved.inbox.inInbox).toBe(desktop.inbox.inInbox);
              const detail = await backend.handle("getNavigationSelectedDetail", { protocol: 2, ref });
              expect(detail.thread.inbox.inInbox).toBe(desktop.inbox.inInbox);
              expect((await backend.handle("resolveThread", { backend: source, threadId: metadataOnlyId })).thread)
                .toMatchObject({ title: "Untitled thread", titleSource: "fallback" });
              expect((await backend.handle("resolveThread", { backend: source, threadId: absentId })).thread).toBeUndefined();
            }
          }
        });
        expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
        expect(await f.desktop.listThreadMetadata()).toEqual(before);
      } finally { owner.close(); f.close(); }
    }), { numRuns: 25, examples: [[[0, 0, 0], 0, undefined], [[0, 0, 1], 1, undefined], [[0, 1, 2], 1, undefined], [[2, 3, 1], 2, 0]] });
});

it.each(backends)("keeps durable archive/restore authority over passive %s records without inventing fresh observations", async source => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.nat(10000), fc.nat(10000), async (archiveAt, retainedAt) => {
    const f = fixture();
    await f.seed(source, 1, retainedAt);
    const ref = { backend: source, threadId };
    await f.desktop.observeArchivedThreads([ref], archiveAt);
    const owner = await open(f);
    try {
      for (const [phase, archived] of [["observe", true], ["restore", false], ["rearchive", true]] as const) {
        if (phase === "restore") await f.desktop.setThreadArchiveTombstone({ ...ref, restoredAt: archiveAt });
        if (phase === "rearchive") await f.desktop.observeArchivedThreads([ref], archiveAt + 1);
        // Claude's actual metadata owns membership; keep its desktop archive
        // mutation while leaving the retained provider snapshot unchanged.
        const archiveObservation = phase === "rearchive" ? archiveAt + 1 : archiveAt;
        if (source === "claude") await f.saveClaude(Math.max(1, archiveObservation), archived ? archiveObservation : undefined);
        const before = await f.desktop.getThreadMetadata(ref);
        const { writes } = await measureSqliteWrites(async () => {
          for (let round = 0; round < 5; round++) {
            const backend = owner.reopen();
            expect((await backend.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe(archived ? "archived" : "present");
            expect((await backend.handle("listThreads", { backend: source })).threads.length).toBe(archived ? 0 : 1);
            expect((await backend.handle("lookupArchivedThreads", { backend: source, threadIds: [ref.threadId] })).threads.length).toBe(archived ? 1 : 0);
          }
        });
        expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
        expect(await f.desktop.getThreadMetadata(ref)).toEqual(before);
      }
    } finally { owner.close(); f.close(); }
  }), { numRuns: 25, examples: [[0, 0], [0, 1], [1, 1], [1, 0]] });
});
