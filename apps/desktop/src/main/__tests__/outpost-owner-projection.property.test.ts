import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { seedRetainedOutpostUnreadThread } from "../../../e2e/fixtures/outpost-owner-data-seeding";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "outpost-owner-projection-")));
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"));
  return { root, directory, db, desktop: new SqliteOverlayStore(db), inventory: new ProviderThreadSnapshotStore(db),
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function open(f: ReturnType<typeof fixture>) {
  const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.root });
  const store = new JobStore(f.directory, { version: 1, workspace: f.root, codexHome: path.join(f.root, "codex") }, profile);
  const runtime = { workspace: f.root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; } };
  const reopen = () => new HeadlessBackend(runtime, () => {});
  return { backend: reopen(), reopen, close: () => profile.close() };
}

const identity = { backend: "codex" as const, threadId: "thread" };
const provider = (updatedAt: number): AppServerThreadSummary => ({ id: identity.threadId, source: "codex",
  title: "Retained desktop thread", titleSource: "explicit", createdAt: 0, updatedAt, linkedDirectories: [] });

it("seeds the retained unread fixture independently of whether startup discovery completes before takeover", async () => {
  await fc.assert(fc.asyncProperty(fc.nat(10000), fc.boolean(), async (updatedAt, refreshBeforeQuit) => {
    const f = fixture();
    let owner: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const thread = provider(updatedAt);
      seedRetainedOutpostUnreadThread(f.db, thread);
      // A visible navigation row does not imply the independent startup
      // refresh has committed its durable provider inventory before quit.
      if (refreshBeforeQuit) f.inventory.replace({ backend: "codex", observedAt: 1, threads: [thread] });
      owner = await open(f);
      expect(owner.backend.summary(owner.backend.owned(thread.id))).toMatchObject({
        id: thread.id, title: thread.title, updatedAt, inbox: { inInbox: false },
      });
      expect((await f.desktop.getThreadMetadata(identity))?.seenUpdatedAt).toBeUndefined();
    } finally { owner?.close(); f.close(); }
  }), { numRuns: 20, examples: [[0, false]] });
});

it("keeps metadata-only rows filterable without replacing provider or canonical titles", async () => {
  const f = fixture();
  f.inventory.replace({ backend: "codex", observedAt: 1, threads: [provider(1)] });
  // Imported ownership is independent of a native row; an arbitrary overlay is not.
  writeFileSync(path.join(f.directory, "identity.json"), JSON.stringify({ version: 1, workspace: f.root, codexHome: path.join(f.root, "codex") }));
  writeFileSync(path.join(f.directory, "threads.json"), JSON.stringify({ version: 1, threads: ["mode-only", "seen-only", "named"].map(id => ({ id })) }));
  const owner = await open(f);
  try {
    await fc.assert(fc.asyncProperty(fc.constantFrom("default" as const, "auto" as const), fc.nat(10000),
      fc.string({ minLength: 1, maxLength: 40 }), async (executionMode, seenAt, title) => {
        await f.desktop.setThreadExecutionMode({ backend: "codex", threadId: "mode-only", executionMode });
        await f.desktop.updateThreadMetadata({ backend: "codex", threadId: "seen-only" }, { seenAt });
        await f.desktop.updateThreadMetadata({ backend: "codex", threadId: "named" }, { title: { text: title, source: "explicit" } });
        await f.desktop.updateThreadMetadata({ backend: "codex", threadId: "unimported" }, { executionMode });
        expect(() => owner.backend.owned("unimported")).toThrow("Thread is not owned");
        for (const id of ["mode-only", "seen-only"]) expect(owner.backend.owned(id)).toMatchObject({ title: "Untitled thread", titleSource: "fallback" });
        expect(owner.backend.owned("named")).toMatchObject({ title, titleSource: "explicit" });
        expect(owner.backend.owned("thread")).toMatchObject({ title: "Retained desktop thread", titleSource: "explicit" });
        const filtered = await owner.backend.handle("getNavigationQueryPage", {
          protocol: 2, query: { kind: "lens", lens: "recents", filter: "untitled" },
        });
        expect(filtered.entries.map((entry: { row: { id: string } }) => entry.row.id).sort()).toEqual(["mode-only", "seen-only"]);
        expect((await f.desktop.getThreadMetadata({ backend: "codex", threadId: "mode-only" }))?.title).toBeUndefined();
      }), { numRuns: 20, examples: [["default", 0, " "]] });
  } finally { owner.close(); f.close(); }
});

it("keeps durable provider-archive observations out of ownership through arbitrary archive and restore transitions", async () => {
  const f = fixture();
  f.inventory.replace({ backend: "codex", observedAt: 1, threads: [provider(1)] });
  const owner = await open(f);
  try {
    await fc.assert(fc.asyncProperty(fc.nat(10000), fc.array(fc.constantFrom("observe", "archive", "restore"), { maxLength: 12 }), async (start, commands) => {
      await f.desktop.updateThreadMetadata(identity, { archived: false, archivedAt: null, restoredAt: null, archiveRetentionStartedAt: null });
      for (const [index, command] of ["observe", ...commands].entries()) {
        const now = start + index;
        if (command === "observe") await f.desktop.observeArchivedThreads([identity], now);
        else await f.desktop.setThreadArchiveTombstone({ ...identity, ...(command === "archive" ? { archivedAt: now } : { restoredAt: now }) });
        const archived = command !== "restore";
        expect(owner.backend.runtime.ownsThread(identity.threadId)).toBe(!archived);
        expect(owner.backend.runtime.listOwnedThreads().length).toBe(archived ? 0 : 1);
        if (archived) expect(() => owner.backend.owned(identity.threadId)).toThrow("Thread is not owned");
        else expect(owner.backend.owned(identity.threadId).title).toBe("Retained desktop thread");
        expect((await owner.backend.handle("listThreads")).threads.length).toBe(archived ? 0 : 1);
      }
    }), { numRuns: 25 });
  } finally { owner.close(); f.close(); }
});

it("matches desktop's baseline-backed unread oracle without persisting derived facts, including omitted and zero acknowledgements", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = fixture();
  // One immutable baseline spans the generated identity/watermark domain.
  // The live owner then observes external metadata commits for those identities.
  const template = f.desktop.readNavigationQueryIndex({ backend: "codex", threads: [provider(0)] }).threads[0]!;
  const initial = Array.from({ length: 10001 }, (_, value) => ({ ...template, id: `thread-${value}`, updatedAt: value }));
  f.desktop.initializeNavigationUnreadBaseline(initial);
  const owner = await open(f);
  try {
    await fc.assert(fc.asyncProperty(fc.nat(10000), fc.nat(10000), fc.option(fc.nat(10000), { nil: undefined }),
      fc.option(fc.nat(10000), { nil: undefined }), async (baseline, updatedAt, explicitWatermark, seenAt) => {
        const ref = { backend: "codex" as const, threadId: `thread-${baseline}` };
        const native = { ...provider(updatedAt), id: ref.threadId };
        f.inventory.replace({ backend: "codex", observedAt: 1, threads: [native] });
        await f.desktop.updateThreadMetadata(ref, { seenAt: seenAt ?? null, seenUpdatedAt: explicitWatermark ?? null, updatedAt: null });
        const before = await f.desktop.getThreadMetadata(ref);
        const desktopUnread = () => f.desktop.readNavigationQueryIndex({ backend: "codex", threads: [native] }).threads[0]!.inbox.inInbox;
        const expected = updatedAt > (explicitWatermark ?? baseline);
        expect(desktopUnread()).toBe(expected);
        const { result: backend, writes } = await measureSqliteWrites(() => {
          const backend = owner.reopen();
          for (let i = 0; i < 20; i++) expect(backend.summary(backend.owned(ref.threadId)).inbox.inInbox).toBe(expected);
          return backend;
        });
        expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
        expect(await f.desktop.getThreadMetadata(ref)).toEqual(before);
        await backend.handle("markThreadSeen", { threadId: ref.threadId, seenAt: 200000 });
        expect(backend.summary(backend.owned(ref.threadId)).inbox.inInbox).toBe(expected);
        expect(desktopUnread()).toBe(expected);
        await backend.handle("markThreadSeen", { threadId: ref.threadId, seenUpdatedAt: 0 });
        expect(backend.summary(backend.owned(ref.threadId)).inbox.inInbox).toBe(updatedAt > 0);
        expect(desktopUnread()).toBe(updatedAt > 0);
        const reopened = owner.reopen();
        expect(reopened.summary(reopened.owned(ref.threadId)).inbox.inInbox).toBe(updatedAt > 0);
      }), { numRuns: 25, examples: [[1, 1, undefined, undefined]] });
  } finally { owner.close(); f.close(); }
});

it("keeps an archive observation authoritative until a newer complete provider observation", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = fixture();
  const owner = await open(f);
  try {
    await fc.assert(fc.asyncProperty(fc.nat(10000), fc.nat(10000), async (archiveAt, observedAt) => {
      await f.desktop.updateThreadMetadata(identity, { archived: false, archivedAt: null, restoredAt: null, archiveRetentionStartedAt: null });
      await f.desktop.observeArchivedThreads([identity], archiveAt);
      // Native discovery and the desktop's durable archive observation are
      // independent authorities; only a strictly newer provider view wins.
      owner.backend.threads.replaceInventory([provider(1)], observedAt);
      const { result: owned, writes } = await measureSqliteWrites(() => owner.backend.runtime.ownsThread(identity.threadId));
      expect(owned).toBe(observedAt > archiveAt);
      expect(owner.backend.runtime.listOwnedThreads().length).toBe(owned ? 1 : 0);
      expect((await owner.backend.handle("listThreads")).threads.length).toBe(owned ? 1 : 0);
      expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
    }), { numRuns: 25, examples: [[0, 0], [1, 0], [0, 1]] });
  } finally { owner.close(); f.close(); }
});
