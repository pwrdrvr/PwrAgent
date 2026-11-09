import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
const threadId = (index = 0) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
afterEach(() => vi.unstubAllEnvs());

function native(source: AppServerBackendKind, id = threadId()): AppServerThreadSummary {
  return { id, source, title: `${source} ${id}`, titleSource: "explicit", createdAt: 10, updatedAt: 20,
    threadStatus: "idle", linkedDirectories: [], executionMode: "default" };
}

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "outpost-provider-review-")));
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  const store = new JobStore(directory, { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
  const runtime = { workspace: root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; } };
  const claudeRoot = path.join(root, "claude");
  return { root, claudeRoot, claude: new ClaudeSessionStore(claudeRoot),
    desktop: new SqliteOverlayStore(db), inventory: new ProviderThreadSnapshotStore(db), sessions: new AcpSessionStore(db),
    reopen: () => new HeadlessBackend(runtime, () => {}),
    close() { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("provider-scoped lens pages and counts match an independent identity inventory through pagination", async () => {
  const f = await fixture();
  try {
    await fc.assert(fc.asyncProperty(fc.tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 1, max: 4 })), async sizes => {
      rmSync(f.claudeRoot, { recursive: true, force: true });
      for (const session of f.sessions.listAllSessions()) f.sessions.deleteSession(session.backendId, session.sessionId);
      const expected = backends.flatMap((backend, index) => {
        const threads = Array.from({ length: sizes[index]! }, (_, id) => native(backend, threadId(id)));
        f.inventory.replace({ backend, observedAt: 1, threads });
        return threads.map(thread => ({ backend, threadId: thread.id }));
      });
      await Promise.all(expected.filter(ref => ref.backend === "claude")
        .map(ref => f.claude.save({ cwd: f.root, thread: native("claude", ref.threadId) })));
      for (const ref of expected) if (ref.backend === "acp:removed") {
        f.sessions.upsertSession({ backendId: ref.backend, sessionId: ref.threadId, title: `${ref.backend} ${ref.threadId}`,
          titleSource: "explicit", createdAt: 10, updatedAt: 20, executionMode: "default", status: "idle" });
      }
      const owner = f.reopen();
      for (const backend of [...backends, "all", undefined]) {
        const selected = expected.filter(ref => backend === undefined || backend === "all" || ref.backend === backend);
        const actual: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await owner.handle("getNavigationQueryPage", { protocol: 2, backend,
            query: { kind: "lens", lens: "recents" }, pageSize: 2, ...(cursor ? { cursor } : {}) });
          expect(page.counts.total).toBe(selected.length);
          actual.push(...page.entries.map((entry: { row: { source: string; id: string } }) => `${entry.row.source}/${entry.row.id}`));
          cursor = page.nextCursor;
        } while (cursor);
        expect(actual.sort()).toEqual(selected.map(ref => `${ref.backend}/${ref.threadId}`).sort());
      }
    }), { numRuns: 20, examples: [[[1, 1, 1]]] });
  } finally { f.close(); }
});

it("restored provider summaries omit historical archive stamps and remain in active model navigation", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = await fixture();
  try {
    await fc.assert(fc.asyncProperty(fc.nat(10000), fc.integer({ min: 1, max: 10000 }), async (archivedAt, elapsed) => {
      for (const source of ["claude", "acp:removed"] as const) {
        const ref = { backend: source, threadId: threadId() };
        f.inventory.replace({ backend: source, observedAt: 1, threads: [{ ...native(source), archivedAt }] });
        if (source === "claude") await f.claude.save({ cwd: f.root, thread: { ...native(source), archivedAt } });
        if (source === "acp:removed") f.sessions.upsertSession({ backendId: source, sessionId: ref.threadId,
          title: "ACP archive", titleSource: "explicit", createdAt: 10, updatedAt: 20, status: "idle", executionMode: "default", archivedAt });
        await f.desktop.updateThreadMetadata(ref, { archivedAt, restoredAt: null, archiveRetentionStartedAt: null });
        expect((await f.reopen().handle("getNavigationSelectedDetail", { protocol: 2, ref })).thread.archivedAt).toBe(archivedAt);
        await f.desktop.setThreadArchiveTombstone({ ...ref, restoredAt: archivedAt + elapsed });
        if (source === "claude") await f.claude.save({ cwd: f.root, thread: native(source) });
        const before = await f.desktop.getThreadMetadata(ref);
        const { writes } = await measureSqliteWrites(async () => {
          const owner = f.reopen();
          const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
          expect(detail.identity).toBe("present");
          expect(detail.thread.archivedAt).toBeUndefined();
          expect((await owner.handle("resolveThread", ref)).thread.archivedAt).toBeUndefined();
          expect((await owner.handle("listThreads", { backend: source })).threads[0].archivedAt).toBeUndefined();
          const models = await owner.handle("getNavigationQueryPage", { protocol: 2, backend: source, query: { kind: "model-inventory" } });
          expect(models.counts.total).toBe(1);
        });
        expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
        expect(await f.desktop.getThreadMetadata(ref)).toEqual(before);
        await f.desktop.setThreadArchiveTombstone({ ...ref, archivedAt: archivedAt + elapsed + 1 });
        if (source === "claude") await f.claude.save({ cwd: f.root,
          thread: { ...native(source), archivedAt: archivedAt + elapsed + 1 } });
        expect((await f.reopen().handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe("archived");
        expect((await f.reopen().handle("lookupArchivedThreads", { backend: source, threadIds: [ref.threadId] })).threads[0].archivedAt)
          .toBe(archivedAt + elapsed + 1);
      }
    }), { numRuns: 20, examples: [[0, 1]] });
  } finally { f.close(); }
});

it("retained provider status controls seen Attention membership while Codex keeps job authority", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = await fixture();
  try {
    await fc.assert(fc.asyncProperty(fc.constantFrom("active" as const, "unknown" as const, "idle" as const, "failed" as const), async status => {
      const projected = status === "active" ? "active" : status === "unknown" ? "unknown" : "idle";
      f.inventory.replace({ backend: "codex", observedAt: 1, threads: [{ ...native("codex"), threadStatus: "active" }] });
      f.inventory.replace({ backend: "claude", observedAt: 1, threads: [{ ...native("claude"), threadStatus: projected }] });
      await f.claude.save({ cwd: f.root, thread: { ...native("claude"), threadStatus: projected } });
      f.sessions.upsertSession({ backendId: "acp:removed", sessionId: threadId(), title: "ACP status", titleSource: "explicit",
        createdAt: 10, updatedAt: 20, executionMode: "default", status });
      await f.desktop.updateThreadMetadata({ backend: "claude", threadId: threadId(9) }, { executionMode: "default" });
      for (const backend of backends) await f.desktop.updateThreadMetadata({ backend, threadId: threadId() }, { seenUpdatedAt: 20 });
      const { writes } = await measureSqliteWrites(async () => {
        const owner = f.reopen();
        // Retained status is available before a fresh native discovery. A
        // handed-over Claude sidecar does not carry a live turn into this host.
        const retained = owner.threads.get(threadId(), "claude");
        expect(owner.summary(retained).threadStatus).toBe(projected);
        expect(owner.summary({ ...retained, threadStatus: undefined }).threadStatus).toBe("idle");
        expect((await owner.handle("resolveThread", { backend: "claude", threadId: threadId(9) })).thread).toBeUndefined();
        expect((await owner.handle("resolveThread", { backend: "codex", threadId: threadId() })).thread.threadStatus).toBe("idle");
        for (const backend of ["claude", "acp:removed"] as const) {
          const ref = { backend, threadId: threadId() };
          const expectedStatus = backend === "claude" ? "idle" : projected;
          expect((await owner.handle("resolveThread", ref)).thread).toMatchObject({ threadStatus: expectedStatus, inbox: { inInbox: false } });
          expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).thread.threadStatus).toBe(expectedStatus);
          const attention = await owner.handle("getNavigationQueryPage", { protocol: 2, backend, query: { kind: "lens", lens: "attention" } });
          expect(attention.counts.total).toBe(1);
          expect(attention.counts.active).toBe(expectedStatus === "active" ? 1 : 0);
          expect(attention.entries.length).toBe(expectedStatus === "active" ? 1 : 0);
        }
      });
      expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
    }), { numRuns: 20, examples: [["active"], ["unknown"], ["idle"], ["failed"]] });
  } finally { f.close(); }
});
