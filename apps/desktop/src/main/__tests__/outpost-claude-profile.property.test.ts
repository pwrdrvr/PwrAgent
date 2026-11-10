import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { ClaudeSessionMetadataStore } from "@pwragent/sqlite-storage/claude-session-metadata-store";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/);

type DiscoveryCommand = { name: string; archived: boolean; seen: boolean; executionMode: "default" | "auto" | "full-access" };

async function checkDiscovery(id: string, commands: DiscoveryCommand[]): Promise<void> {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-claude-profile-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const overlay = new SqliteOverlayStore(db);
  const sessions = new ClaudeSessionStore(path.join(root, "claude"));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const owner = new HeadlessBackend({ workspace: root, store, projects: { list: () => [] },
      onFailure(error: unknown) { throw error; } }, () => {});
    const ref = { backend: "claude" as const, threadId: id };
    for (const [index, command] of commands.entries()) {
      const updatedAt = 100 + index;
      await sessions.save({ cwd: root, sdkSessionId: "private-sdk-id", sdkSessionDir: "/private/provider-project",
        thread: { id, source: "claude", title: command.name, titleSource: "derived", createdAt: 1, updatedAt,
          linkedDirectories: [], model: command.name, executionMode: command.executionMode,
          ...(command.archived ? { archivedAt: updatedAt + 1 } : {}) } });
      await overlay.updateThreadMetadata(ref, { pinnedRank: `${index}`, parent: { backend: "codex", threadId: "parent" },
        seenAt: 10000, seenUpdatedAt: command.seen ? updatedAt : updatedAt - 1,
        title: { text: "Stale canonical title", source: "explicit" }, createdAt: -1, updatedAt: -1, cwd: "/stale",
        ...(command.archived ? { archivedAt: 1 } : { restoredAt: 2 }) });
      const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
      expect(detail.identity).toBe(command.archived ? "archived" : "present");
      expect(detail.thread).toMatchObject({ id, source: "claude", title: command.name, titleSource: "derived", model: command.name,
        executionMode: command.executionMode, pinnedRank: `${index}`, parentThreadId: "parent", parentThreadBackend: "codex",
        createdAt: 1, updatedAt, projectKey: root, inbox: { inInbox: !command.seen } });
      expect(detail.thread.archivedAt).toBe(command.archived ? updatedAt + 1 : undefined);
      expect(JSON.stringify(detail)).not.toContain("private-sdk-id");
      expect((await owner.handle("resolveThread", ref)).thread).toEqual(detail.thread);
      expect((await owner.handle("listThreads", { backend: "claude" })).threads.map((row: { id: string }) => row.id))
        .toEqual(command.archived ? [] : [id]);
      expect((await owner.handle("lookupArchivedThreads", { backend: "claude", threadIds: [id] })).threads.map((row: { id: string }) => row.id))
        .toEqual(command.archived ? [id] : []);
      const page = await owner.handle("getNavigationQueryPage", { protocol: 2, consumer: "remote-window", backend: "claude",
        query: { kind: "exact", identities: [ref] } });
      expect(page.entries).toHaveLength(command.archived ? 0 : 1);
      await expect(owner.handle("readThread", ref)).rejects.toThrow("executes Codex only");
    }
    await sessions.delete(id);
    expect((await owner.handle("resolveThread", ref)).thread).toBeUndefined();
    expect((await owner.handle("listThreads", { backend: "claude" })).threads).toEqual([]);
    rmSync(path.join(root, "claude"), { recursive: true, force: true });
    const reopened = new HeadlessBackend({ workspace: root, store, projects: { list: () => [] },
      onFailure(error: unknown) { throw error; } }, () => {});
    expect((await reopened.handle("resolveThread", ref)).thread).toBeUndefined();
  } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}

it("discovers actual Claude metadata without inventory and follows desktop title, archive and settings changes", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.array(fc.record({ name: word, archived: fc.boolean(), seen: fc.boolean(),
    executionMode: fc.constantFrom("default" as const, "auto" as const, "full-access" as const),
  }), { minLength: 1, maxLength: 8 }), checkDiscovery), { numRuns: 25 });
});

it("resolves one uncached Claude sidecar instead of an overlay's Untitled thread fallback", async () => {
  await checkDiscovery("00000000-0000-1000-8000-000000000000", [{ name: "A", archived: false, seen: false, executionMode: "auto" }]);
});

it("shares the actual desktop metadata reader while ignoring histories, account files, torn sidecars and in-memory helpers", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-claude-reader-")));
  try {
    const desktop = new ClaudeSessionStore(root);
    const portable = new ClaudeSessionMetadataStore(root);
    await fc.assert(fc.asyncProperty(fc.uuid(), word, async (id, title) => {
      const session = { cwd: root, sdkSessionId: "sdk-session", thread: { id, source: "claude" as const, title,
        titleSource: "explicit" as const, linkedDirectories: [] } };
      await desktop.save(session);
      writeFileSync(path.join(root, `${id}.jsonl`), "not readable as metadata");
      writeFileSync(path.join(root, "rate-limits.json"), "not session metadata");
      writeFileSync(path.join(root, "ffffffff-ffff-ffff-ffff-ffffffffffff.json"), "torn");
      expect(await portable.read(id)).toEqual(await desktop.read(id));
      expect(await portable.list()).toEqual(await desktop.list());
      await expect(portable.list({ requireComplete: true })).rejects.toThrow();
      expect(await portable.changeToken()).toBe(await desktop.changeToken());
      desktop.holdEphemeral({ ...session, ephemeral: true });
      desktop.forgetEphemeral(id);
      await desktop.delete(id);
    }), { numRuns: 25 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("concurrent Claude reads share one complete discovery and a failed discovery cannot replace its published facts", async () => {
  const { OutpostThreadRegistry } = await load("owner-thread-registry.js");
  await fc.assert(fc.asyncProperty(fc.uuid(), word, fc.integer({ min: 1, max: 12 }), async (id, title, readers) => {
    const native = { id, source: "claude", title, titleSource: "explicit", updatedAt: 2, linkedDirectories: [] };
    let finish!: (threads: typeof native[]) => void;
    const held = new Promise<typeof native[]>(resolve => { finish = resolve; });
    let calls = 0;
    let discovery = () => { calls++; return held; };
    const owner = new OutpostThreadRegistry({ getThreadMetadata: () => undefined, listThreadMetadata: () => [] }, undefined, undefined,
      { listThreads: () => discovery() });
    const pending = Array.from({ length: readers }, () => owner.refreshClaudeThreads());
    expect(calls).toBe(1);
    expect(owner.get(id, "claude")).toBeUndefined();
    finish([native]);
    await Promise.all(pending);
    expect(owner.get(id, "claude").title).toBe(title);
    discovery = async () => { throw new Error("Metadata directory read failed"); };
    await expect(owner.refreshClaudeThreads()).rejects.toThrow("Metadata directory read failed");
    expect(owner.get(id, "claude").title).toBe(title);
    discovery = async () => [{ ...native, title: `Next ${title}` }];
    await owner.refreshClaudeThreads();
    expect(owner.get(id, "claude").title).toBe(`Next ${title}`);
  }), { numRuns: 25 });
});
