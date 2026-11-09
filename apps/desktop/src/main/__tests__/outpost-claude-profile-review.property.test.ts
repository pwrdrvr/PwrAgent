import fc from "fast-check";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { ClaudeSessionStore } from "../claude/claude-session-store";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const modes = ["default", "auto", "full-access"] as const;
const zeroWrites = { commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function thread(index: number): AppServerThreadSummary {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, source: "claude",
    title: `Claude ${index}`, titleSource: "explicit", createdAt: 0, updatedAt: index + 1, linkedDirectories: [] };
}

async function fixture() {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-claude-review-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const overlay = new SqliteOverlayStore(db);
  const claudeRoot = path.join(root, "claude");
  const claude = new ClaudeSessionStore(claudeRoot);
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
  const codex = { listThreads: vi.fn(async () => []) };
  const owner = new HeadlessBackend({ workspace: root, store, codex, projects: { list: () => [] }, onFailure(error: unknown) { throw error; } }, () => {});
  return { root, claudeRoot, overlay, codex, owner,
    save: (native: AppServerThreadSummary) => claude.save({ cwd: root, thread: native }),
    close() { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("publishes Claude membership only after every existing sidecar is readable, retaining facts until recovery", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = await fixture();
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.nat(10), fc.constantFrom("{", "null", "{}"),
      async (count, selected, invalid) => {
        rmSync(f.claudeRoot, { recursive: true, force: true });
        const records = Array.from({ length: count }, (_, index) => ({ ...thread(index), ...(index % 2 ? { archivedAt: index + 2 } : {}) }));
        await Promise.all(records.map(f.save));
        await f.owner.threads.refreshClaudeThreads();
        const before = structuredClone([...f.owner.threads.values("claude")]);
        const bad = path.join(f.claudeRoot, `${records[selected % count]!.id}.json`);
        const original = readFileSync(bad);
        writeFileSync(bad, invalid);
        const { writes } = await measureSqliteWrites(async () => {
          await expect(f.owner.threads.refreshClaudeThreads()).rejects.toThrow();
          expect([...f.owner.threads.values("claude")]).toEqual(before);
          expect([...f.owner.threads.claudeThreadIds].sort()).toEqual(records.map(record => record.id).sort());
        });
        expect(writes).toMatchObject(zeroWrites);
        writeFileSync(bad, original);
        const deleted = records[(selected + 1) % count]!;
        unlinkSync(path.join(f.claudeRoot, `${deleted.id}.json`));
        const recovery = await measureSqliteWrites(async () => {
          await f.owner.threads.refreshClaudeThreads();
          expect(f.owner.threads.get(deleted.id, "claude")).toBeUndefined();
          expect([...f.owner.threads.claudeThreadIds].sort()).toEqual(records.filter(record => record.id !== deleted.id).map(record => record.id).sort());
        });
        expect(recovery.writes).toMatchObject(zeroWrites);
      }), { numRuns: 20, examples: [[2, 0, "{"]] });
  } finally { f.close(); }
});

it("serves every retained cursor page without rediscovery even when Claude metadata and Codex become unavailable", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 7 }), fc.nat(5), fc.constantFrom("claude", "all"),
    async (count, width, backend) => {
      const f = await fixture();
      try {
        const records = Array.from({ length: count }, (_, index) => thread(index));
        await Promise.all(records.map(f.save));
        await f.owner.initialize();
        const discover = vi.spyOn(f.owner.threads.claudeSessions, "listThreads");
        const request = { protocol: 2, backend, query: { kind: "lens", lens: "recents" }, pageSize: width % (count - 1) + 1 };
        const envelope = { sourceInstanceId: "fixture-viewer" };
        let page = await f.owner.handle("getNavigationQueryPage", request, envelope);
        const firstCursor = page.nextCursor;
        expect(firstCursor).toBeTruthy();
        expect(discover).toHaveBeenCalledTimes(1);
        f.codex.listThreads.mockClear();
        f.codex.listThreads.mockRejectedValue(new Error("Provider unavailable after initial page"));
        renameSync(f.claudeRoot, `${f.claudeRoot}-retained`);
        writeFileSync(f.claudeRoot, "not a directory");
        const ids = page.entries.map((entry: { row: { ref: { threadId: string } } }) => entry.row.ref.threadId);
        const { writes } = await measureSqliteWrites(async () => {
          while (page.nextCursor) {
            page = await f.owner.handle("getNavigationQueryPage", { ...request, cursor: page.nextCursor }, envelope);
            ids.push(...page.entries.map((entry: { row: { ref: { threadId: string } } }) => entry.row.ref.threadId));
          }
        });
        expect(ids.sort()).toEqual(records.map(record => record.id).sort());
        expect(discover).toHaveBeenCalledTimes(1);
        expect(f.codex.listThreads).not.toHaveBeenCalled();
        expect(writes).toMatchObject(zeroWrites);
        await expect(f.owner.handle("getNavigationQueryPage", request, envelope)).rejects.toThrow();
        expect(discover).toHaveBeenCalledTimes(2);
        await f.owner.handle("getNavigationQueryPage", { ...request, cursor: firstCursor }, envelope);
        expect(discover).toHaveBeenCalledTimes(2);
      } finally { f.close(); }
    }), { numRuns: 12, examples: [[3, 0, "all"], [2, 0, "claude"]] });
});

it("matches desktop's mode oracle for optional native and canonical Claude execution settings", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = await fixture();
  try {
    await fc.assert(fc.asyncProperty(fc.option(fc.constantFrom(...modes), { nil: undefined }),
      fc.option(fc.constantFrom(...modes), { nil: undefined }), async (nativeMode, overlayMode) => {
        const native = { ...thread(0), ...(nativeMode !== undefined ? { executionMode: nativeMode } : {}) };
        await f.save(native);
        const ref = { backend: "claude" as const, threadId: native.id };
        await f.overlay.updateThreadMetadata(ref, { executionMode: overlayMode ?? null });
        const desktop = f.overlay.readNavigationQueryIndex({ backend: "claude", threads: [native] }).threads[0]!;
        expect(desktop.executionMode).toBe(nativeMode ?? overlayMode ?? "default");
        const { writes } = await measureSqliteWrites(async () => {
          expect((await f.owner.handle("resolveThread", ref)).thread.executionMode).toBe(desktop.executionMode);
          expect((await f.owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).thread.executionMode).toBe(desktop.executionMode);
          const page = await f.owner.handle("getNavigationQueryPage", { protocol: 2, backend: "claude", query: { kind: "exact", identities: [ref] } });
          expect(page.entries[0].row.executionMode).toBe(desktop.executionMode);
          await expect(f.owner.handle("startTurn", { ...ref, input: [{ type: "text", text: "unsupported" }] })).rejects.toThrow("executes Codex only");
        });
        expect(writes).toMatchObject(zeroWrites);
      }), { numRuns: 30, examples: [[undefined, "auto"], [undefined, "full-access"], ["default", "auto"]] });
  } finally { f.close(); }
});
