import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AppServerThreadSummary, ThreadOverlayState } from "@pwragent/shared";
import { ARCHIVE_CLEANUP_PAUSE_MS } from "../app-server/archive-cleanup-queue";
import { ArchiveWorktreeReferences } from "../app-server/archive-worktree-references";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import * as gitHeadBranch from "../app-server/git-head-branch";
import { deleteThreadAssets } from "../app-server/thread-assets";
import { CountingBackendClient, codexThread, publishNotification } from "./fixtures/thread-read-harness";
import budgets from "./fixtures/archive-cleanup-budgets.json";
import { ArchiveCleanupCheckpointStore, type ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const registryLog = vi.hoisted(() => ({ debug() {}, info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => registryLog }));
vi.mock("../app-server/worktree-container-service", () => ({ WorktreeContainerService: class {
  // Every path in this harness is outside the managed root. Keep container
  // discovery free of host I/O just like the contrived Git/stat operations.
  async containerPath(_worktreePath: string): Promise<undefined> { return undefined; }
  comparisonPaths(containerPath: string): string[] { return [containerPath]; }
  worktreeComparisonPaths(worktreePath: string): string[] { return [worktreePath]; }
} }));
vi.mock("../app-server/thread-assets", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app-server/thread-assets")>(),
  // The registry delivers `thread/deleted` only after removing the thread's
  // owned asset directories, and a test publishes it from inside an inventory
  // read. These threads own no assets, and advancing fake timers cannot
  // complete the host `rm` calls the real cleanup makes.
  deleteThreadAssets: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // The worktree service is contrived, so its post-removal sentinel must be
    // contrived too. Advancing fake timers cannot complete host filesystem I/O.
    stat: vi.fn(async (filePath: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
      if (typeof filePath === "string" && filePath.startsWith("/contrived/")) {
        throw Object.assign(new Error("Contrived worktree was removed."), { code: "ENOENT" });
      }
      return await actual.stat(filePath, options);
    }),
  };
});

/**
 * Runs archive cleanup to completion under fake timers. The clock advances only
 * while cleanup is parked on its checkpoint pause, the one timer it owns.
 * Between checkpoints it awaits provider, DB, and filesystem work that no clock
 * advance completes. Slicing the clock on a budget instead ran out on a loaded
 * runner while the real thread-asset `rm` was in flight; 500 slices cover well
 * under 50 ms of wall time. The stub above removes that I/O; this pacer keeps
 * the next host call on the path from needing one.
 */
async function drivePacer<T>(registry: DesktopBackendRegistry, promise: Promise<T>): Promise<T> {
  let settled = false;
  const settlement = promise.then(() => { settled = true; }, () => { settled = true; });
  for (;;) {
    await Promise.race([settlement, registry.whenArchiveCleanupCheckpointPendingForTests()]);
    if (settled) return await promise;
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
  }
}

const registries: DesktopBackendRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  vi.mocked(stat).mockReset();
  vi.mocked(deleteThreadAssets).mockClear();
  registryLog.error.mockClear();
  registryLog.info.mockClear();
  registryLog.warn.mockClear();
  vi.useRealTimers();
});

function build(active: AppServerThreadSummary[], target = codexThread({ id: "target" }), checkpoint?: Pick<ArchiveCleanupCheckpointStore, "save" | "recover">) {
  const overlays = new Map<string, ThreadOverlayState>();
  let archived: AppServerThreadSummary[] = [];
  const counts = { aggregateLists: 0, archiveMutations: 0, providerPages: 0, largestProviderPage: 0, overlayReads: 0, largestOverlaySlice: 0 };
  const client = Object.assign(new CountingBackendClient([...active, target]), {
    archiveThread: vi.fn(async ({ threadId }: { threadId: string }) => {
      counts.archiveMutations += 1;
      archived = [target];
      return { threadId };
    }),
    listThreads: vi.fn(async (): Promise<AppServerThreadSummary[]> => { counts.aggregateLists += 1; throw new Error("Broad discovery is outside the archive budget."); }),
    listArchiveCleanupThreadsPage: vi.fn(async (params: { archived: boolean; cursor?: string; limit: number }) => {
      counts.providerPages += 1;
      counts.largestProviderPage = Math.max(counts.largestProviderPage, params.limit);
      const rows = params.archived ? archived : active;
      const offset = Number(params.cursor ?? 0);
      const threads = rows.slice(offset, offset + params.limit);
      return { threads, nextCursor: offset + threads.length < rows.length ? String(offset + threads.length) : undefined };
    }),
  });
  const readOverlays = vi.fn(async ({ threadIds }: { threadIds: string[] }) => {
    counts.overlayReads += 1;
    counts.largestOverlaySlice = Math.max(counts.largestOverlaySlice, threadIds.length);
    return Object.fromEntries(threadIds.map((id) => [id, overlays.get(id)]));
  });
  const store = new Proxy({
    getArchiveCleanupOverlayStates: readOverlays,
    getThreadListingOverlayStates: readOverlays,
    getThreadOverlayStates: readOverlays,
    getThreadOverlayState: vi.fn(async ({ threadId }: { threadId: string }) => overlays.get(threadId)),
    setThreadParent: vi.fn(async (_request: { threadId: string }) => {}),
    setThreadArchiveTombstone: vi.fn(async (_request: { threadId: string; archivedAt: number }) => {}),
  }, { get(object, key) {
    if (key === "then") return undefined;
    if (key in object) return object[key as keyof typeof object];
    return vi.fn(async () => String(key).startsWith("list") ? [] : undefined);
  } });
  const archiveWorktree = vi.fn(async (params: { backend: string; threadId: string; worktreePath: string; beforeRemove?: () => Promise<() => void> }) => {
    const assertRemoval = await params.beforeRemove?.();
    assertRemoval?.();
    return { id: "snapshot", backend: params.backend, threadId: params.threadId, worktreePath: params.worktreePath,
      repositoryPath: "/contrived/repo", snapshotRef: "refs/codex/snapshots/test", snapshotCommit: "abc",
      createdAt: 1, archivedAt: 2, state: "archived", ignoredFilesExcluded: true };
  });
  // Inventory scans include Claude even when the archived thread is Codex.
  // Keep this fake-timer harness independent of filesystem session discovery.
  const claudeStore = new ClaudeSessionStore("/contrived/claude");
  vi.spyOn(claudeStore, "list").mockResolvedValue([]);
  // Reads and writes below are contrived, so no filesystem admission is needed.
  // Real-store concurrency tests exercise the shared-profile mutation lock.
  vi.spyOn(claudeStore, "withMutation").mockImplementation(async (_id, work) => await work());
  const registry = new DesktopBackendRegistry({ codexClient: client as never, overlayStore: store as never,
    claudeBackendOptions: { store: claudeStore },
    archiveCleanupCheckpointStore: checkpoint, runtimeInstanceId: "cleanup-fixture", resolveLiveProfileRuntimeInstanceIds: () => ["cleanup-fixture"],
    worktreeArchiveService: { archive: archiveWorktree } as never, threadTitleGenerationService: null });
  registries.push(registry);
  const events: AgentEvent[] = [];
  const completion = new Promise<AgentEvent>((resolve) => {
    registry.onEvent((event) => {
      events.push(event);
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    });
  });
  return { registry, client, counts, events, overlays, store, claudeStore, archiveWorktree, completion };
}

function buildArchiveBurst(active: AppServerThreadSummary[], targets: AppServerThreadSummary[], history: AppServerThreadSummary[] = [], checkpoint?: Pick<ArchiveCleanupCheckpointStore, "save" | "recover">) {
  const fixture = build(active, undefined, checkpoint);
  const archived = [...history];
  fixture.client.archiveThread.mockImplementation(async ({ threadId }) => {
    fixture.counts.archiveMutations += 1;
    archived.push(targets.find((thread) => thread.id === threadId)!);
    return { threadId };
  });
  fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
    fixture.counts.providerPages += 1;
    const rows = params.archived ? archived : active;
    const offset = Number(params.cursor ?? 0);
    const threads = rows.slice(offset, offset + params.limit);
    return { threads, nextCursor: offset + threads.length < rows.length ? String(offset + threads.length) : undefined };
  });
  const completions: AgentEvent[] = [];
  const finished = new Promise<void>((resolve) => {
    fixture.registry.onEvent((event) => {
      if (event.notification.method !== "thread/archiveCleanup/completed") return;
      completions.push(event);
      if (completions.length === targets.length) resolve();
    });
  });
  return { ...fixture, completions, finished };
}

function buildRepair() {
  const fixture = build([]);
  const active: AppServerThreadSummary[] = [];
  const archived = ["first", "second"].map((id) => codexThread({ id, linkedDirectories: [{
    id, kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: `/contrived/${id}`,
  }] }));
  const removed = new Set<string>();
  vi.mocked(stat).mockImplementation(async (filePath) => {
    if (removed.has(String(filePath))) throw Object.assign(new Error("Removed"), { code: "ENOENT" });
    return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
  });
  fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived: isArchived }) => ({
    threads: isArchived ? archived : active, nextCursor: undefined,
  }));
  const archive = fixture.archiveWorktree.getMockImplementation()!;
  fixture.archiveWorktree.mockImplementation(async (params) => {
    const snapshot = await archive(params);
    removed.add(params.worktreePath);
    return snapshot;
  });
  return { ...fixture, active, archived, removed };
}

describe("archive cleanup pipeline", () => {
  it("bounds durable reference-wait writes for a 100-thread batch and two releases", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const temp = createTempStateDb("pwragent-reference-wait-budget-");
    const db = StateDb.open(temp.dbPath);
    const checkpoint = new ArchiveCleanupCheckpointStore(db.raw);
    const directory = { id: "shared", kind: "worktree" as const, label: "shared", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const targets = Array.from({ length: 100 }, (_, index) => codexThread({ id: `waiting-${index}`, linkedDirectories: [directory] }));
    const fixture = buildArchiveBurst(["one", "two"].map((id) => codexThread({ id, projectKey: `/contrived/other-${id}`, linkedDirectories: [] })), targets, [], checkpoint);
    for (const id of ["one", "two"]) fixture.overlays.set(id, { backend: "codex", threadId: id, extraLinkedDirectories: [directory] });
    try {
      const { writes } = await measureSqliteWrites(async () => {
        await drivePacer(fixture.registry, Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id }))));
        for (const id of ["one", "two"]) {
          fixture.overlays.set(id, { backend: "codex", threadId: id, extraLinkedDirectories: [] });
          const completed = id === "two" ? new Promise<AgentEvent>((resolve) => fixture.registry.onEvent((event) => {
            if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
          })) : undefined;
          await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: [id] } });
          if (completed) await drivePacer(fixture.registry, completed);
          else expect(fixture.archiveWorktree).not.toHaveBeenCalled();
        }
      });
      expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
      for (const event of fixture.events) {
        if (event.notification.method === "thread/archiveCleanup/completed") expect(event.notification.params).toHaveProperty("reporting", "background");
      }
      expectSqliteWriteBudget({ scenario: "archive-worktree-100-reference-wait-release",
        note: "100 archived owners of one checkout: one queue-drain checkpoint writing one row per intent, a non-final release that only shrinks the backlog and writes nothing, and one final drain deletion; 2 commits, zero idle writes. At 10 batches/day and about 128 KB WAL per batch, about 1.3 MB/day.", writes });
    } finally {
      await fixture.registry.close();
      db.close();
      removeTempStateDbDir(temp.tempDir);
      vi.unstubAllEnvs();
    }
  });

  it.each(["shared", "unrelated"] as const)("honors the removal reservation for a late controlled %s attachment", async (attachment) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{ id: "worktree", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" }] });
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], target);
    let writeRan = false;
    let refused = false;
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      const guard = await params.beforeRemove!();
      const directory = { id: "extra", kind: "local" as const, label: "extra", path: `/contrived/${attachment === "shared" ? "worktree" : "unrelated"}` };
      try {
        await fixture.registry.withThreadWorkspaceMutation({ backend: "codex", threadId: "owner" }, async () => {
          await fixture.registry.withArchiveWorkspaceWrite([directory.path], async () => {
            writeRan = true;
            fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [directory] });
          });
          await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] } });
        }, [directory.path]);
      } catch (error) { refused = String(error).includes("removal is reserved"); }
      return guard;
    } }));
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(writeRan).toBe(attachment === "unrelated");
    expect(refused).toBe(attachment === "shared");
    expect(result.cleanup[0]?.removedWorktree).toBe(true);
  });

  it("does not mask a raw provider ownership change inside a controlled writer", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{ id: "worktree", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" }] });
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], target);
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      const guard = await params.beforeRemove!();
      await fixture.registry.withThreadWorkspaceMutation({ backend: "codex", threadId: "owner" }, async () => {
        fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: target.linkedDirectories });
        await fixture.client.emitNotification({ method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] } });
      }, ["/contrived/other"]);
      return guard;
    } }));
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("keeps an initially unknown owner protected", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{ id: "worktree", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" }] });
    const fixture = build([codexThread({ id: "unknown", linkedDirectories: [] })], target);
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("reclaims each managed checkout only after its final secondary reference is released", async () => {
    vi.useFakeTimers();
    const directories = ["first", "second"].map((id) => ({
      id, kind: "worktree" as const, label: id, path: `/contrived/repo-${id}`, worktreePath: `/contrived/${id}`,
    }));
    const target = codexThread({ id: "target", linkedDirectories: directories });
    const fixture = build(["one", "two"].map((id) => codexThread({ id, projectKey: `/contrived/other-${id}`, linkedDirectories: [] })), target);
    fixture.overlays.set("one", { backend: "codex", threadId: "one", extraLinkedDirectories: directories });
    fixture.overlays.set("two", { backend: "codex", threadId: "two", extraLinkedDirectories: [directories[0]!] });
    await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    const pages = fixture.counts.providerPages;
    await publishNotification(fixture.registry, { method: "turn/started", params: { threadId: "unrelated", turn: { id: "unrelated-turn" } } });
    expect(fixture.counts.providerPages).toBe(pages);
    await publishNotification(fixture.registry, { method: "turn/completed", params: { threadId: "unrelated", turnId: "unrelated-turn", turn: { id: "unrelated-turn", status: "completed", output: [] } } });

    for (const [id, expectedPath] of [["one", "/contrived/second"], ["two", "/contrived/first"]]) {
      fixture.overlays.set(id!, { backend: "codex", threadId: id!, extraLinkedDirectories: [] });
      const completed = new Promise<AgentEvent>((resolve) => fixture.registry.onEvent((event) => {
        if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
      }));
      await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: [id!] } });
      expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(1);
      await drivePacer(fixture.registry, completed);
      expect(fixture.archiveWorktree.mock.calls.at(-1)?.[0].worktreePath).toBe(expectedPath);
    }
    expect(fixture.archiveWorktree.mock.calls.map(([request]) => request.worktreePath)).toEqual(["/contrived/second", "/contrived/first"]);
    expect(fixture.client.archiveThread).toHaveBeenCalledOnce();
  });

  it.each(["thread/archived", "thread/deleted"] as const)("reconsiders a pending checkout when its final owner emits %s", async (method) => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "shared", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const active = [codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })];
    const fixture = build(active, codexThread({ id: "target", linkedDirectories: [directory] }));
    fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [directory] });
    await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    active.splice(0);
    const completed = new Promise<AgentEvent>((resolve) => fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    }));
    await publishNotification(fixture.registry, method === "thread/archived" ? { method: "thread/archived", params: { threadId: "owner" } } : { method: "thread/deleted", params: { threadId: "owner" } });
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(1);
    await drivePacer(fixture.registry, completed);
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(fixture.client.archiveThread).toHaveBeenCalledOnce();
  });

  it("checkpoints reference-blocked cleanup for restart without counting it as active quit work", async () => {
    vi.useFakeTimers();
    const saved: ArchiveCleanupIntent[][] = [];
    const checkpoint = { save: vi.fn((_id: string, intents: ArchiveCleanupIntent[]) => { saved.push(structuredClone(intents)); }), recover: vi.fn(() => []) };
    const directory = { id: "shared", kind: "worktree" as const, label: "shared", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/worktree", linkedDirectories: [directory] })],
      codexThread({ id: "target", linkedDirectories: [directory] }), checkpoint);
    await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(0);
    fixture.registry.checkpointArchiveCleanupsForQuit();
    expect(saved.at(-1)).toEqual([expect.objectContaining({ threadId: "target", deferredWorktrees: [expect.objectContaining({ worktreePath: "/contrived/worktree" })] })]);
  });

  it("recovers a shared request, waits for its final reference, and never rearchives the provider", async () => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "shared", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const owner = codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] });
    let saved: ArchiveCleanupIntent[] = [];
    const checkpoint = { save: vi.fn((_id: string, intents: ArchiveCleanupIntent[]) => { saved = structuredClone(intents); }), recover: vi.fn(() => saved) };
    const first = build([owner], target, checkpoint);
    first.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [directory] });
    await drivePacer(first.registry, first.registry.archiveThread({ backend: "codex", threadId: "target" }));
    await first.registry.close();
    expect(saved).toHaveLength(1);
    const resumed = build([owner], target, checkpoint);
    resumed.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [directory] });
    resumed.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived }) => ({ threads: archived ? [target] : [owner], nextCursor: undefined }));
    const recoveredPublication = new Promise<AgentEvent>((resolve) => resumed.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    }));
    await drivePacer(resumed.registry, Promise.all([resumed.registry.resumeArchiveCleanupsAtStartup(), recoveredPublication]));
    expect(resumed.archiveWorktree).not.toHaveBeenCalled();
    expect(resumed.registry.getArchiveCleanupCountForQuit()).toBe(0);
    resumed.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [] });
    const completed = new Promise<AgentEvent>((resolve) => resumed.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    }));
    await publishNotification(resumed.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] } });
    expect(resumed.registry.getArchiveCleanupCountForQuit()).toBe(1);
    await drivePacer(resumed.registry, completed);
    expect(resumed.archiveWorktree).toHaveBeenCalledOnce();
    expect(resumed.client.archiveThread).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it.each([false, true])("finishes snapshot persistence after a failed write and restart without removing the checkout twice (deferred=%s)", async (deferred) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{ id: "worktree", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" }] });
    let saved: ArchiveCleanupIntent[] = [];
    const checkpoint = { save: vi.fn((_id: string, intents: ArchiveCleanupIntent[]) => { saved = structuredClone(intents); }), recover: vi.fn(() => saved) };
    const owner = codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] });
    const first = build(deferred ? [owner] : [], target, checkpoint);
    if (deferred) {
      first.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: target.linkedDirectories });
      await drivePacer(first.registry, first.registry.archiveThread({ backend: "codex", threadId: "target" }));
      expect(first.archiveWorktree).not.toHaveBeenCalled();
      expect(saved[0]?.deferredWorktrees?.[0]?.snapshot).toBeUndefined();
    }
    Object.assign(first.store, { upsertWorktreeSnapshot: vi.fn(async () => { throw new Error("Snapshot store unavailable"); }) });
    if (deferred) {
      const completed = new Promise<void>((resolve) => first.registry.onEvent((event) => {
        if (event.notification.method === "thread/archiveCleanup/completed") resolve();
      }));
      first.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [] });
      await publishNotification(first.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] } });
      await drivePacer(first.registry, completed);
    } else {
      const result = await drivePacer(first.registry, first.registry.archiveThread({ backend: "codex", threadId: "target" }));
      expect(result.cleanup[0]?.error).toContain("Snapshot store unavailable");
    }
    expect(first.archiveWorktree).toHaveBeenCalledOnce();
    expect(saved[0]?.deferredWorktrees?.[0]?.snapshot?.snapshotCommit).toBe("abc");
    await first.registry.close();
    const resumed = build([], target, checkpoint);
    const persist = vi.fn(async () => {});
    Object.assign(resumed.store, { upsertWorktreeSnapshot: persist });
    resumed.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived }) => ({ threads: archived ? [target] : [], nextCursor: undefined }));
    const completed = new Promise<AgentEvent>((resolve) => resumed.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    }));
    await drivePacer(resumed.registry, Promise.all([resumed.registry.resumeArchiveCleanupsAtStartup(), completed]));
    expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ snapshot: expect.objectContaining({ snapshotCommit: "abc" }) }));
    expect(resumed.archiveWorktree).not.toHaveBeenCalled();
    expect(resumed.client.archiveThread).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("drains 300 released checkouts through bounded queue capacity without stranding overflow", async () => {
    vi.useFakeTimers();
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })]);
    const refs = new ArchiveWorktreeReferences();
    for (let index = 0; index < 300; index += 1) {
      await refs.retain({ backend: "codex", threadId: `waiting-${index}`, archivedAt: 1, codexRolloutMissing: false, messagingCleanup: {} },
        { worktreePath: `/contrived/worktree-${index}`, blockers: ["codex:owner"] });
    }
    // Exercise the real release dispatcher and bounded queue, keeping the
    // already-covered provider/removal admission outside this scheduling test.
    const complete = vi.fn(async (intent: ArchiveCleanupIntent) => {
      for (const row of intent.deferredWorktrees ?? []) await refs.fulfilled(row.worktreePath);
      return { backend: intent.backend, threadId: intent.threadId, archivedAt: intent.archivedAt,
        cleanup: (intent.deferredWorktrees ?? []).map((row) => ({ worktreePath: row.worktreePath, removedWorktree: true, deletedBranch: false })) };
    });
    Object.assign(fixture.registry, { archiveWorktreeReferences: refs, completeArchivedThreadCleanup: complete });
    let publications = 0;
    const completed = new Promise<void>((resolve) => fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed" && ++publications === 300) resolve();
    }));
    await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] } });
    await drivePacer(fixture.registry, completed);
    expect(complete).toHaveBeenCalledTimes(300);
    expect(refs.intents()).toEqual([]);
    expect(fixture.events.filter((event) => event.notification.method === "thread/archiveCleanup/completed"
      && event.notification.params.error)).toEqual([]);
    expect(fixture.client.archiveThread).not.toHaveBeenCalled();
  });

  it("does not lose a final-reference release received before stale inventory records its waiter", async () => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "shared", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], codexThread({ id: "target", linkedDirectories: [directory] }));
    fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [directory] });
    const read = fixture.store.getArchiveCleanupOverlayStates.getMockImplementation()!;
    let released = false;
    fixture.store.getArchiveCleanupOverlayStates.mockImplementation(async (params) => {
      const states = await read(params);
      if (!released && params.threadIds.includes("owner")) {
        released = true;
        fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [] });
        await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] } });
      }
      return states;
    });
    let removed!: () => void;
    const completed = new Promise<void>((resolve) => {
      removed = resolve;
      fixture.registry.onEvent((event) => {
        if (event.notification.method !== "thread/archiveCleanup/completed") return;
        const cleanup = event.notification.params.cleanup;
        if (Array.isArray(cleanup) && cleanup.some((item: { removedWorktree?: boolean }) => item.removedWorktree)) resolve();
      });
    });
    const request = fixture.registry.archiveThread({ backend: "codex", threadId: "target" }).then((response) => {
      if (response.cleanup.some((item) => item.removedWorktree)) removed();
      return response;
    });
    await drivePacer(fixture.registry, Promise.all([request, completed]));
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(fixture.client.archiveThread).toHaveBeenCalledOnce();
  });

  it.each(["provider", "overlay"] as const)("retains pending ownership when the final-release %s read fails", async (read) => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "shared", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], codexThread({ id: "target", linkedDirectories: [directory] }));
    fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [directory] });
    await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: [] });
    if (read === "provider") fixture.client.listArchiveCleanupThreadsPage.mockRejectedValueOnce(new Error("Provider unavailable"));
    else fixture.store.getArchiveCleanupOverlayStates.mockRejectedValueOnce(new Error("Overlay unavailable"));
    const notify = () => publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["owner"] } });
    await notify();
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(0);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    const completed = new Promise<AgentEvent>((resolve) => fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    }));
    await notify();
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(1);
    await drivePacer(fixture.registry, completed);
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
  });

  it("reclaims a released checkout when its final referring thread moves to another workspace", async () => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "shared", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const owner = codexThread({ id: "owner", projectKey: "/contrived/worktree", linkedDirectories: [] });
    const fixture = build([owner], codexThread({ id: "target", linkedDirectories: [directory] }));
    await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    const completed = new Promise<AgentEvent>((resolve) => fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") resolve(event);
    }));
    await fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "owner", sourcePath: "/contrived/worktree", targetPath: "/contrived/new" }, async () => {
      owner.projectKey = "/contrived/new";
    });
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(1);
    await drivePacer(fixture.registry, completed);
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
  });

  it("Run now re-audits existing archived worktrees", async () => {
    const fixture = build([]);
    const repair = vi.spyOn(fixture.registry, "repairArchivedThreadWorktrees").mockResolvedValue({
      archivedThreads: 1477, discoveredWorktrees: 501, missingWorktrees: 0, protectedWorktrees: 3,
      protectedWorktreeDetails: [], candidates: [], cleanup: [], emptyContainerCandidates: [], containerCleanup: [],
    });
    await fixture.registry.sweepInactiveThreads();
    expect(repair).toHaveBeenCalledOnce();
  });

  it.each(["provider", "overlay"] as const)("snapshots and removes Claude worktrees from %s metadata, excluding an additional local directory", async (source) => {
    vi.useFakeTimers();
    const fixture = build([]);
    const worktree = { id: "repo", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktrees/example/repo" };
    const local = { id: "local", kind: "local" as const, label: "local", path: "/contrived/local" };
    const session = { cwd: worktree.worktreePath, thread: {
      ...codexThread({ id: "claude-target" }), source: "claude" as const,
      linkedDirectories: source === "provider" ? [worktree] : [],
    } };
    vi.spyOn(fixture.claudeStore, "read").mockResolvedValue(session);
    vi.spyOn(fixture.claudeStore, "save").mockResolvedValue(undefined);
    vi.mocked(fixture.claudeStore.list).mockResolvedValue([session]);
    fixture.overlays.set(session.thread.id, { backend: "claude", threadId: session.thread.id,
      extraLinkedDirectories: [worktree, local] });

    const response = await fixture.registry.archiveThread({ backend: "claude", threadId: session.thread.id, backgroundCleanup: true });
    expect(response).toMatchObject({ cleanup: [], cleanupPending: true });
    const event = await drivePacer(fixture.registry, fixture.completion);
    expect(event.notification.params).not.toHaveProperty("reporting");
    expect(event.notification.params).toMatchObject({ cleanup: [{
      worktreePath: worktree.worktreePath, removedWorktree: true, deletedBranch: false,
    }] });
    expect(registryLog.info).toHaveBeenCalledWith("archive cleanup worktree outcome", expect.objectContaining({
      backend: "claude", worktreePath: worktree.worktreePath, removedWorktree: true,
    }));
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(fixture.archiveWorktree).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude", threadId: session.thread.id, worktreePath: worktree.worktreePath,
      repositoryPath: worktree.path, beforeRemove: expect.any(Function),
    }));
  });

  it.each(["shared", "external", "snapshot failure"] as const)("keeps Claude worktrees on %s and publishes the cleanup outcome", async (reason) => {
    vi.useFakeTimers();
    const directory = { id: "repo", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build(reason === "shared" ? [codexThread({ id: "active-owner", linkedDirectories: [directory] })] : []);
    const session = { cwd: directory.worktreePath, thread: {
      ...codexThread({ id: "claude-target", linkedDirectories: [directory] }), source: "claude" as const,
    } };
    vi.spyOn(fixture.claudeStore, "read").mockResolvedValue(session);
    vi.spyOn(fixture.claudeStore, "save").mockResolvedValue(undefined);
    vi.mocked(fixture.claudeStore.list).mockResolvedValue([session]);
    if (reason === "external") fixture.overlays.set(session.thread.id, { backend: "claude", threadId: session.thread.id,
      extraLinkedDirectories: [{ ...directory, worktreeOwnership: "external" }] });
    if (reason === "snapshot failure") fixture.archiveWorktree.mockRejectedValue(new Error("Snapshot preparation failed"));
    await fixture.registry.archiveThread({ backend: "claude", threadId: session.thread.id, backgroundCleanup: true });
    const event = await drivePacer(fixture.registry, fixture.completion);
    expect(event.notification.params).toMatchObject({ cleanup: [expect.objectContaining({
      removedWorktree: false,
      ...(reason === "snapshot failure" ? { error: "Snapshot preparation failed" }
        : { skippedReason: expect.stringContaining(reason === "shared" ? "active-owner" : "Externally managed") }),
    })] });
    if (reason !== "snapshot failure") expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("reports Claude archive metadata failure instead of an empty successful cleanup", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const session = { cwd: "/contrived/local", thread: { ...codexThread({ id: "claude-target" }), source: "claude" as const } };
    vi.spyOn(fixture.claudeStore, "read").mockResolvedValue(session);
    vi.spyOn(fixture.claudeStore, "save").mockResolvedValue(undefined);
    vi.mocked(fixture.claudeStore.list).mockRejectedValue(new Error("Session metadata unavailable"));

    await fixture.registry.archiveThread({ backend: "claude", threadId: session.thread.id, backgroundCleanup: true });
    const event = await drivePacer(fixture.registry, fixture.completion);
    expect(event.notification.params).toMatchObject({ cleanup: [{
      removedWorktree: false, deletedBranch: false,
      skippedReason: expect.stringContaining("Session metadata unavailable"),
    }] });
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("keeps Claude local-only archive receipts empty", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const session = { cwd: "/contrived/local", thread: {
      ...codexThread({ id: "claude-target", linkedDirectories: [{ id: "local", kind: "local", label: "local", path: "/contrived/local" }] }),
      source: "claude" as const,
    } };
    vi.spyOn(fixture.claudeStore, "read").mockResolvedValue(session);
    vi.spyOn(fixture.claudeStore, "save").mockResolvedValue(undefined);
    vi.mocked(fixture.claudeStore.list).mockResolvedValue([session]);

    const result = fixture.registry.archiveThread({ backend: "claude", threadId: session.thread.id });
    expect((await drivePacer(fixture.registry, result)).cleanup).toEqual([]);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("does not reread 30 archived targets already present in the current batch inventory", async () => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/shared" };
    const targets = Array.from({ length: 30 }, (_, id) => codexThread({ id: `target-${id}`, linkedDirectories: [directory] }));
    const fixture = buildArchiveBurst([codexThread({ id: "shared-user", linkedDirectories: [directory] })], targets);
    const readSummary = vi.fn(async (threadId: string) => targets.find((thread) => thread.id === threadId)!);
    Object.assign(fixture.client, { readArchiveCleanupThreadSummary: readSummary });

    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);

    expect(readSummary).toHaveBeenCalledTimes(1);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.completions).toHaveLength(30);
    // One identity read of 100-row pages builds the batch's fleet index; the
    // other 29 jobs reuse it.
    expect(fixture.counts.providerPages).toBe(2);
    expect(registryLog.info.mock.calls.filter(([message]) => message === "archive cleanup fleet index built")).toHaveLength(1);
  });

  it("logs request, queue wait, stages, shared-worktree outcome and publication after a 30-minute backlog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T17:32:23.599Z"));
    const directory = { id: "shared", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/shared" };
    const targets = ["first", "blocking-2", "blocking-3", "blocking-4", "second"].map((id) => codexThread({ id, linkedDirectories: [directory] }));
    const fixture = buildArchiveBurst([codexThread({ id: "shared-user", linkedDirectories: [directory] })], targets);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const read = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      await blocked;
      return await read(params);
    });
    const requestedAt = Date.now();
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    const fields = { backend: "codex", threadId: "second", runtimeInstanceId: "cleanup-fixture" };
    expect(registryLog.info).toHaveBeenCalledWith("thread archive requested", expect.objectContaining({ ...fields, requestedAt }));
    expect(registryLog.info).toHaveBeenCalledWith("archive cleanup queued", expect.objectContaining({ ...fields, queuedAt: requestedAt, queueDepth: 5 }));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(registryLog.info).toHaveBeenCalledWith("archive cleanup stage started", expect.objectContaining({ threadId: "first", stage: "metadata" }));
    release();
    await drivePacer(fixture.registry, fixture.finished);

    const started = registryLog.info.mock.calls.find(([message, details]) => message === "archive cleanup started" && details.threadId === "second")?.[1];
    expect(started).toMatchObject({ ...fields, archivedAt: requestedAt });
    expect(started?.queueWaitMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(registryLog.info).toHaveBeenCalledWith("archive cleanup worktree outcome", expect.objectContaining({
      ...fields, worktreePath: directory.worktreePath, removedWorktree: false,
      skippedReason: "Worktree is still used by another active thread: shared-user.",
    }));
    expect(registryLog.info).toHaveBeenCalledWith("archive cleanup completed", expect.objectContaining({ ...fields, queueWaitMs: started?.queueWaitMs, cleanupDurationMs: expect.any(Number) }));
    expect(registryLog.info).toHaveBeenCalledWith("archive cleanup completion published", expect.objectContaining({ ...fields, archivedAt: requestedAt, publishedAt: expect.any(Number) }));
    expect(registryLog.info.mock.calls.filter(([message, details]) => message === "archive cleanup stage completed" && details.threadId === "second").map(([, details]) => details.stage))
      .toEqual(["metadata", "ungroup", "worktrees"]);
  });

  it.each([
    { failedCalls: [1], code: "SQLITE_FULL" },
    { failedCalls: [2], code: "SQLITE_BUSY" },
    { failedCalls: [1, 2], code: "SQLITE_FULL" },
  ])("finishes shutdown when checkpoint calls $failedCalls fail with $code", async ({ failedCalls, code }) => {
    vi.useFakeTimers();
    let attempts = 0;
    const checkpoint = { save: vi.fn<ArchiveCleanupCheckpointStore["save"]>(() => {
      attempts += 1;
      if (failedCalls.includes(attempts)) throw Object.assign(new Error(code), { code });
    }), recover: vi.fn(() => []) };
    const fixture = build([], undefined, checkpoint);
    const closeClient = vi.spyOn(fixture.client, "close");
    await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(1);
    const cleanup = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const closing = fixture.registry.close();
    expect(fixture.registry.close()).toBe(closing);
    await expect(closing).resolves.toBeUndefined();
    await fixture.registry.close();
    expect(closeClient).toHaveBeenCalledOnce();
    expect(checkpoint.save).toHaveBeenCalledTimes(2);
    expect(fixture.counts.providerPages).toBe(0);
    await expect(cleanup).resolves.toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("cancelled") })] });
    for (const call of failedCalls) {
      expect(registryLog.error).toHaveBeenCalledWith("archive cleanup quit checkpoint failed", {
        phase: call === 1 ? "before-drain" : "after-drain", error: code,
      });
    }
  });

  it("counts queued cleanup at quit and checkpoints it after cancellation", async () => {
    vi.useFakeTimers();
    const checkpoint = { save: vi.fn(), recover: vi.fn(() => []) };
    const fixture = build([], undefined, checkpoint);
    await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(1);
    await fixture.registry.close();
    expect(fixture.counts.providerPages).toBe(0);
    expect(checkpoint.save).toHaveBeenCalledWith("cleanup-fixture", [expect.objectContaining({ backend: "codex", threadId: "target" })]);
    expect(registryLog.info).toHaveBeenCalledWith("archive cleanup stopped", expect.objectContaining({
      threadId: "target", cancelled: true, cleanupDurationMs: 0,
    }));
    expect(registryLog.info.mock.calls.some(([message]) => message === "archive cleanup completion published")).toBe(false);
  });

  it("resumes a checkpoint in one batch without repeating the provider archive", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const targets = Array.from({ length: 130 }, (_, index) => codexThread({ id: `resumed-${index}`, linkedDirectories: [directory] }));
    const intents: ArchiveCleanupIntent[] = targets.map((thread) => ({ backend: "codex", threadId: thread.id, archivedAt: 1,
      codexRolloutMissing: false, messagingCleanup: {} }));
    const checkpoint = { save: vi.fn(), recover: vi.fn(() => intents) };
    const fixture = build([codexThread({ id: "shared-user", linkedDirectories: [directory] })], undefined, checkpoint);
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      fixture.counts.providerPages += 1;
      if (!params.archived) return { threads: [codexThread({ id: "shared-user", linkedDirectories: [directory] })], nextCursor: undefined };
      const offset = Number(params.cursor ?? 0);
      const threads = targets.slice(offset, offset + params.limit);
      return { threads, nextCursor: offset + threads.length < targets.length ? String(offset + threads.length) : undefined };
    });
    // Queue drain and asynchronous event publication have separate owners.
    // Wait for the publication boundary before counting renderer-bound results.
    const published = new Promise<void>((resolve) => {
      let received = 0;
      fixture.registry.onEvent((event) => {
        if (event.notification.method === "thread/archiveCleanup/completed" && ++received === targets.length) resolve();
      });
    });
    const resumption = fixture.registry.resumeArchiveCleanupsAtStartup();
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(130);
    await drivePacer(fixture.registry, resumption);
    await published;
    expect(fixture.client.archiveThread).not.toHaveBeenCalled();
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    // One identity read of 100-row pages for the whole resumed batch.
    expect(fixture.counts.providerPages).toBe(3);
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(0);
    const completions = fixture.events.map((event) => event.notification).filter((notification) => notification.method === "thread/archiveCleanup/completed");
    expect(completions).toHaveLength(130);
    for (const notification of completions) expect(notification.params).toHaveProperty("reporting", "background");
    expect(fixture.events.filter((event) => event.notification.method === "archiveCleanup/progress")).toEqual([]);
    await fixture.registry.resumeArchiveCleanupsAtStartup();
    expect(checkpoint.recover).toHaveBeenCalledOnce();
    await fixture.registry.close();
    expect(checkpoint.save).toHaveBeenLastCalledWith("cleanup-fixture", expect.arrayContaining([
      expect.objectContaining({ threadId: "resumed-0", deferredWorktrees: [expect.objectContaining({ blockers: ["codex:shared-user"] })] }),
    ]));
  });

  it("keeps dry-run audit progress and results out of archive activity for every ownership mix", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (shared) => {
      vi.useFakeTimers();
      const fixture = buildRepair();
      if (shared) fixture.active.push(codexThread({ id: "active-owner", linkedDirectories: fixture.archived[0]!.linkedDirectories }));
      try {
        await drivePacer(fixture.registry, fixture.registry.repairArchivedThreadWorktrees({ dryRun: true }));
        expect(fixture.client.archiveThread).not.toHaveBeenCalled();
        expect(fixture.archiveWorktree).not.toHaveBeenCalled();
        expect(fixture.store.setThreadArchiveTombstone).not.toHaveBeenCalled();
        expect(fixture.events.filter((event) => event.notification.method === "thread/archiveCleanup/completed")).toEqual([]);
        const progress = fixture.events.map((event) => event.notification).filter((notification) => notification.method === "archiveCleanup/progress");
        expect(progress).toEqual([]);
      } finally {
        await fixture.registry.close();
        vi.useRealTimers();
      }
    }), { numRuns: 10 });
  });

  it.each([false, true])("does not resume removal for a restored active thread (previously missing: %s)", async (codexRolloutMissing) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{ id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" }] });
    const checkpoint = { save: vi.fn(), recover: vi.fn(() => [{ backend: "codex" as const, threadId: "target", archivedAt: 1,
      codexRolloutMissing, messagingCleanup: {} }]) };
    const fixture = build([target], target, checkpoint);
    await drivePacer(fixture.registry, fixture.registry.resumeArchiveCleanupsAtStartup());
    expect(fixture.client.archiveThread).not.toHaveBeenCalled();
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.store.setThreadArchiveTombstone).not.toHaveBeenCalled();
    expect(fixture.events.find((event) => event.notification.method === "thread/archiveCleanup/completed")?.notification.params)
      .toMatchObject({ cleanup: [expect.objectContaining({ removedWorktree: false, skippedReason: expect.stringContaining("active again") })] });
  });

  it("resumes an archived worktree with fresh removal admission", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{ id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" }] });
    const checkpoint = { save: vi.fn(), recover: vi.fn(() => [{ backend: "codex" as const, threadId: "target", archivedAt: 1,
      codexRolloutMissing: false, messagingCleanup: {} }]) };
    const fixture = build([], target, checkpoint);
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      fixture.counts.providerPages += 1;
      return { threads: params.archived ? [target] : [], nextCursor: undefined };
    });
    await drivePacer(fixture.registry, fixture.registry.resumeArchiveCleanupsAtStartup());
    expect(fixture.client.archiveThread).not.toHaveBeenCalled();
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(fixture.counts.providerPages).toBe(4);
    await drivePacer(fixture.registry, fixture.completion);
    expect(fixture.events.find((event) => event.notification.method === "thread/archiveCleanup/completed")?.notification.params)
      .toMatchObject({ cleanup: [expect.objectContaining({ removedWorktree: true })] });
  });

  it("retains replay jobs beyond queue capacity when quit interrupts recovery", async () => {
    vi.useFakeTimers();
    const intents: ArchiveCleanupIntent[] = Array.from({ length: 300 }, (_, index) => ({ backend: "codex", threadId: `saved-${index}`, archivedAt: 1,
      codexRolloutMissing: false, messagingCleanup: {} }));
    const checkpoint = { save: vi.fn(), recover: vi.fn(() => intents) };
    const fixture = build([], undefined, checkpoint);
    const resumption = fixture.registry.resumeArchiveCleanupsAtStartup();
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(300);
    await fixture.registry.close();
    await resumption;
    expect(checkpoint.save).toHaveBeenCalledWith("cleanup-fixture", intents);
    expect(fixture.counts.providerPages).toBe(0);
  });

  it("shares ownership discovery across a 130-thread archive burst", async () => {
    vi.useFakeTimers();
    const directory = { id: "shared", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/shared" };
    const active = Array.from({ length: 1000 }, (_, id) => codexThread({ id: `active-${id}` }));
    active[0] = codexThread({ id: "shared-user", linkedDirectories: [directory] });
    const targets = Array.from({ length: 130 }, (_, id) => codexThread({ id: `target-${id}`, linkedDirectories: [directory] }));
    const fixture = buildArchiveBurst(active, targets,
      Array.from({ length: 500 }, (_, id) => codexThread({ id: `historical-${id}` })),
    );
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.completions).toHaveLength(130);
    for (const event of fixture.completions) {
      expect(event.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("shared-user") })] });
    }
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    // One inventory of 100-row pages: 10 active and 7 archived, rather than
    // rebuilding them for each of the 130 queued threads.
    expect(fixture.counts.providerPages).toBe(17);
  });

  it.each(["during discovery", "before the next batch"])("refreshes batch discovery after a workspace change %s", async (timing) => {
    vi.useFakeTimers();
    const firstDirectory = { id: "first", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/first" };
    const secondDirectory = { ...firstDirectory, id: "second", worktreePath: "/contrived/second" };
    const active = [codexThread({ id: "first-user", linkedDirectories: [firstDirectory] })];
    const targets = [codexThread({ id: "first", linkedDirectories: [firstDirectory] }), codexThread({ id: "second", linkedDirectories: [secondDirectory] })];
    const fixture = buildArchiveBurst(active, targets);
    const readSummary = vi.fn(async (threadId: string) => targets.find((thread) => thread.id === threadId)!);
    Object.assign(fixture.client, { readArchiveCleanupThreadSummary: readSummary });
    const changeWorkspace = async () => {
      active.push(codexThread({ id: "new-user", linkedDirectories: [secondDirectory] }));
      await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated",
        params: { reason: "selected-thread", threadIds: ["new-user"] } });
    };
    if (timing === "during discovery") {
      const read = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
      let changed = false;
      fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
        if (params.archived && !changed) { changed = true; await changeWorkspace(); }
        return await read(params);
      });
    } else {
      const first = new Promise<void>((resolve) => fixture.registry.onEvent((event) => {
        if (event.notification.method === "thread/archiveCleanup/completed" && event.notification.params.threadId === "first") resolve();
      }));
      await fixture.registry.archiveThread({ backend: "codex", threadId: "first", backgroundCleanup: true });
      await drivePacer(fixture.registry, first);
      await changeWorkspace();
    }
    await Promise.all((timing === "during discovery" ? targets : targets.slice(1)).map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.completions[1]?.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("new-user") })] });
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    // The batch reads the fleet once; the workspace change rereads only the
    // identity it names.
    expect(fixture.counts.providerPages).toBe(timing === "during discovery" ? 2 : 4);
    expect(readSummary).toHaveBeenCalledTimes(2);
  });

  it("rechecks live ownership before removal even when preliminary discovery was reused", async () => {
    vi.useFakeTimers();
    const directory = { id: "second", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/second" };
    const active: AppServerThreadSummary[] = [];
    const targets = [codexThread({ id: "first" }), codexThread({ id: "second", linkedDirectories: [directory] })];
    const fixture = buildArchiveBurst(active, targets);
    fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed" && event.notification.params.threadId === "first") {
        // Model a provider change whose notification has not arrived yet.
        active.push(codexThread({ id: "new-user", linkedDirectories: [directory] }));
      }
    });
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.completions[1]?.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ removedWorktree: false, error: expect.stringContaining("still used") })] });
    expect(fixture.counts.providerPages).toBe(4);
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
  });

  it("selects each parent's own children from the shared inventory", async () => {
    vi.useFakeTimers();
    const targets = [codexThread({ id: "first" }), codexThread({ id: "second" })];
    const fixture = buildArchiveBurst([codexThread({ id: "child-first" }), codexThread({ id: "child-second" })], targets);
    for (const thread of targets) fixture.overlays.set(`child-${thread.id}`, {
      backend: "codex", threadId: `child-${thread.id}`, extraLinkedDirectories: [],
      parentThreadId: thread.id, parentThreadBackend: "codex",
    });
    await Promise.all(targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id, backgroundCleanup: true })));
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.store.setThreadParent.mock.calls.map(([request]) => request.threadId)).toEqual(["child-first", "child-second"]);
    expect(fixture.counts.providerPages).toBe(2);
  });

  it("refreshes children when a thread is regrouped before the next batch", async () => {
    vi.useFakeTimers();
    const targets = [codexThread({ id: "first" }), codexThread({ id: "second" })];
    const fixture = buildArchiveBurst([codexThread({ id: "child" })], targets);
    fixture.overlays.set("child", { backend: "codex", threadId: "child", extraLinkedDirectories: [], parentThreadId: "first", parentThreadBackend: "codex" });
    const first = new Promise<void>((resolve) => fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed" && event.notification.params.threadId === "first") resolve();
    }));
    await fixture.registry.archiveThread({ backend: "codex", threadId: "first", backgroundCleanup: true });
    await drivePacer(fixture.registry, first);
    fixture.overlays.set("child", { backend: "codex", threadId: "child", extraLinkedDirectories: [], parentThreadId: "second", parentThreadBackend: "codex" });
    await publishNotification(fixture.registry, { method: "thread/parent/set",
      params: { threadId: "child", parentThreadId: "second", parentThreadBackend: "codex" } });
    await fixture.registry.archiveThread({ backend: "codex", threadId: "second", backgroundCleanup: true });
    await drivePacer(fixture.registry, fixture.finished);
    expect(fixture.store.setThreadParent).toHaveBeenCalledTimes(2);
    // A fully drained batch obtains fresh membership and child overlays.
    expect(fixture.counts.providerPages).toBe(4);
  });

  it.each([false, true])("retains supplied historical repair paths when canonical keys differ (%s)", async (differentKeys) => {
    vi.useFakeTimers();
    const fixture = build([]);
    const canonical = differentKeys ? vi.spyOn(await import("../app-server/archive-worktree-references"), "canonicalWorktreePaths")
      .mockImplementation(() => async (value) => path.resolve(value).toLowerCase()) : undefined;
    const rows = ["denied", "valid"].map((id) => codexThread({ id, linkedDirectories: [{
      id, kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: `/contrived/Mixed-${id}`,
    }] }));
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => ({ threads: params.archived ? rows : [], nextCursor: undefined }));
    vi.mocked(stat).mockImplementation(async (filePath) => {
      if (filePath === path.normalize("/contrived/Mixed-denied")) throw Object.assign(new Error("Access denied"), { code: "EACCES" });
      return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
    });
    try {
      const result = await drivePacer(fixture.registry, fixture.registry.repairArchivedThreadWorktrees({ dryRun: true }));
      expect(result.cleanup).toEqual([expect.objectContaining({ worktreePath: path.normalize("/contrived/Mixed-denied"), removedWorktree: false, error: "Access denied" })]);
      expect(result.candidates).toEqual([{ backend: "codex", threadId: "valid", worktreePath: path.normalize("/contrived/Mixed-valid") }]);
    } finally { canonical?.mockRestore(); }
  });

  it("keeps empty-container repair paths separate from canonical comparison keys", async () => {
    vi.useFakeTimers();
    const fixture = buildRepair();
    const canonical = vi.spyOn(await import("../app-server/archive-worktree-references"), "canonicalWorktreePaths")
      .mockImplementation(() => async (value) => `${path.resolve(value)}.canonical`);
    const paths = fixture.archived.map((row) => {
      row.linkedDirectories[0]!.worktreePath += "/repo";
      row.projectKey = row.linkedDirectories[0]!.worktreePath;
      return path.normalize(row.projectKey!);
    });
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error("Missing checkout"), { code: "ENOENT" }));
    const prune = vi.fn(async (worktreePath: string, check: () => void) => {
      check();
      return { worktreePath, containerPath: path.dirname(worktreePath), removed: true };
    });
    Object.assign(fixture.registry, { worktreeContainerService: {
      containerPath: async (worktreePath: string) => paths.includes(worktreePath) ? path.dirname(worktreePath) : undefined,
      comparisonPaths: (value: string) => [value], worktreeComparisonPaths: (value: string) => [value],
      inspect: async (worktreePath: string) => ({ worktreePath, containerPath: path.dirname(worktreePath), identity: { dev: "1", ino: "2" } }),
      prune,
    } });
    try {
      const result = await drivePacer(fixture.registry, fixture.registry.repairArchivedThreadWorktrees());
      expect(result.emptyContainerCandidates.map((candidate) => candidate.worktreePath)).toEqual(paths);
      expect(prune.mock.calls.map(([worktreePath]) => worktreePath)).toEqual(paths);
      expect(result.containerCleanup.every((item) => item.removed)).toBe(true);
    } finally { canonical.mockRestore(); }
  });

  it("bounds fresh removal admission pages for Harold's 399 active and 1477 archived threads", async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 1477 }, (_, index) => codexThread({ id: `archived-${index}`,
      linkedDirectories: index < 4 ? [{ id: String(index), kind: "worktree", label: "repo",
        path: "/contrived/repo", worktreePath: `/contrived/worktree-${index}` }] : [],
    }));
    const active = Array.from({ length: 399 }, (_, index) => codexThread({ id: `active-${index}`, projectKey: `/contrived/active-${index}` }));
    const fixture = build(active);
    const limits: number[] = [];
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      const source = params.archived ? rows : active;
      const offset = Number(params.cursor ?? 0);
      const threads = source.slice(offset, offset + params.limit);
      limits.push(params.limit);
      return { threads, nextCursor: offset + threads.length < source.length ? String(offset + threads.length) : undefined };
    });
    const removed = new Set<string>();
    vi.mocked(stat).mockImplementation(async (filePath) => {
      if (removed.has(String(filePath))) throw Object.assign(new Error("Removed"), { code: "ENOENT" });
      return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
    });
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const snapshot = await archive(params);
      removed.add(params.worktreePath);
      return snapshot;
    });
    const repair = fixture.registry.repairArchivedThreadWorktrees();
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await drivePacer(fixture.registry, repair);
    expect(result.cleanup.filter((item) => item.removedWorktree)).toHaveLength(4);
    // Discovery: ceil(399/25) + ceil(1477/25) = 76 pages.
    // Each independent authoritative admission: 4 + 15 = 19 pages.
    expect(limits).toHaveLength(76 + 4 * 19);
    expect(limits.filter((limit) => limit === 100)).toHaveLength(76);
    expect(fixture.counts.largestOverlaySlice).toBeLessThanOrEqual(25);
  });

  it.each(["new owner", "restore", "workspace move", "external overlay", "cross-provider owner", "cross-provider external", "provider failure", "overlay failure", "repeated cursor"] as const)(
    "rechecks %s without a notification between independent repair removals", async (change) => {
      vi.useFakeTimers();
      const fixture = buildRepair();
      const second = fixture.archived[1]!;
      const repair = fixture.registry.repairArchivedThreadWorktrees({ onProgress: (completed) => {
        if (completed !== 1) return;
        if (change === "new owner") fixture.active.push(codexThread({ id: "new-owner", linkedDirectories: second.linkedDirectories }));
        if (change === "restore") fixture.active.push(second);
        if (change === "workspace move") fixture.archived[1] = { ...second, linkedDirectories: [] };
        if (change === "external overlay") {
          fixture.overlays.set("first", { backend: "codex", threadId: "first", extraLinkedDirectories: [
            { ...second.linkedDirectories[0]!, worktreeOwnership: "external" },
          ] });
        }
        if (change === "cross-provider owner" || change === "cross-provider external") {
          const archived = change === "cross-provider external";
          vi.mocked(fixture.claudeStore.list).mockResolvedValue([{ thread: codexThread({
            id: "claude-owner", source: "claude", linkedDirectories: second.linkedDirectories,
            projectKey: "/contrived/second", ...(archived ? { archivedAt: 1 } : {}),
          }), cwd: "/contrived/second" }]);
          Object.assign(fixture.registry, { acpWorktreeRepositoryResolver: async () => second.linkedDirectories[0] });
          if (archived) fixture.overlays.set("claude-owner", { backend: "claude", threadId: "claude-owner",
            extraLinkedDirectories: [{ ...second.linkedDirectories[0]!, worktreeOwnership: "external" }] });
        }
        if (change === "provider failure") fixture.client.listArchiveCleanupThreadsPage.mockRejectedValue(new Error("Inventory unavailable"));
        if (change === "overlay failure") fixture.store.getArchiveCleanupOverlayStates.mockRejectedValue(new Error("Overlay unavailable"));
        if (change === "repeated cursor") fixture.client.listArchiveCleanupThreadsPage.mockResolvedValue({ threads: [], nextCursor: "repeat" });
      } });
      await vi.advanceTimersByTimeAsync(100_000);
      const result = await drivePacer(fixture.registry, repair);
      expect(result.cleanup[0]?.removedWorktree).toBe(true);
      expect(result.cleanup[1]?.removedWorktree).toBe(false);
      expect(fixture.removed.has("/contrived/second")).toBe(false);
    },
  );

  it.each(["active", "external", "lifecycle", "unrelated"] as const)("uses fresh bounded admission for empty containers with a new %s owner", async (change) => {
    vi.useFakeTimers();
    const fixture = buildRepair();
    if (change === "unrelated") fixture.active.push(codexThread({ id: "other", projectKey: "/contrived/unrelated" }));
    for (const row of fixture.archived) {
      row.linkedDirectories[0]!.worktreePath += "/repo";
      row.projectKey = row.linkedDirectories[0]!.worktreePath;
    }
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error("Missing checkout"), { code: "ENOENT" }));
    const prune = vi.fn(async (worktreePath: string, check: () => void) => {
      if (change === "lifecycle") {
        await fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "moving-owner" }, async () => {});
      }
      if (change === "unrelated") {
        await publishNotification(fixture.registry, { method: "thread/status/changed", params: { threadId: "other", status: { type: "active" } } });
      }
      check();
      // No notification: the next container needs independent authority.
      if (worktreePath.includes("first")) {
        const owner = codexThread({ id: "container-owner", projectKey: "/contrived/second/elsewhere" });
        if (change === "active") fixture.active.push(owner);
        if (change === "external") {
          fixture.archived.push(owner);
          fixture.overlays.set(owner.id, { backend: "codex", threadId: owner.id, extraLinkedDirectories: [{
            id: "external", kind: "worktree", label: "external", path: "/contrived/repo",
            worktreePath: "/contrived/second/elsewhere", worktreeOwnership: "external",
          }] });
        }
      }
      return { worktreePath, containerPath: path.dirname(worktreePath), removed: true };
    });
    Object.assign(fixture.registry, { worktreeContainerService: {
      containerPath: async (worktreePath: string) => path.dirname(worktreePath),
      comparisonPaths: (value: string) => [value],
      worktreeComparisonPaths: (value: string) => [value],
      inspect: async (worktreePath: string) => ({ worktreePath, containerPath: path.dirname(worktreePath), identity: { dev: "1", ino: "2" } }),
      prune,
    } });
    const read = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    const limits: number[] = [];
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      limits.push(params.limit);
      return await read(params);
    });
    const repair = fixture.registry.repairArchivedThreadWorktrees();
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await drivePacer(fixture.registry, repair);
    expect(result.emptyContainerCandidates).toHaveLength(2);
    expect(limits).toEqual([25, 25, 100, 100, 100, 100]);
    if (change === "lifecycle") {
      expect(result.containerCleanup.every((item) => item.error?.includes("workspace state changed"))).toBe(true);
    } else if (change === "unrelated") {
      expect(prune).toHaveBeenCalledTimes(2);
      expect(result.containerCleanup.every((item) => item.removed)).toBe(true);
    } else {
      expect(prune).toHaveBeenCalledOnce();
      expect(result.containerCleanup[1]?.skippedReason).toContain("active or external owner");
    }
  });

  it("rejects admission when a pre-existing lifecycle mutation settles after its provider row was read", async () => {
    vi.useFakeTimers();
    const fixture = buildRepair();
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let mutation: Promise<void> | undefined;
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementationOnce(async (params) => {
      mutation = fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "moving-owner" }, async () => {
        started();
        await gate;
      });
      await entered;
      return await archive(params);
    });
    const read = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      const page = await read(params);
      if (mutation && params.archived) { finish(); await mutation; mutation = undefined; }
      return page;
    });
    const repair = fixture.registry.repairArchivedThreadWorktrees();
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await drivePacer(fixture.registry, repair);
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(fixture.removed.has("/contrived/first")).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("discovers more than 500 archived worktrees while excluding live Codex, Claude, and overlay checkout users", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const archived = Array.from({ length: 501 }, (_, index) => codexThread({ id: `archived-${index}`, linkedDirectories: [{
      id: String(index), kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: `/contrived/worktree-${index}`,
    }] }));
    const pages: number[] = [];
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      const rows = params.archived ? archived : [
        codexThread({ id: "live-codex", linkedDirectories: archived[0]!.linkedDirectories }),
        codexThread({ id: "live-overlay" }),
      ];
      const offset = Number(params.cursor ?? 0);
      const threads = rows.slice(offset, offset + params.limit);
      pages.push(threads.length);
      return { threads, nextCursor: offset + threads.length < rows.length ? String(offset + threads.length) : undefined };
    });
    fixture.overlays.set("live-overlay", { backend: "codex", threadId: "live-overlay",
      extraLinkedDirectories: archived[1]!.linkedDirectories });
    vi.mocked(fixture.claudeStore.list).mockResolvedValue([{
      thread: codexThread({ id: "live-claude", source: "claude", linkedDirectories: archived[2]!.linkedDirectories,
        projectKey: "/contrived/worktree-2" }), cwd: "/contrived/worktree-2",
    }]);
    // The resolver is otherwise a real Git subprocess that fake time cannot
    // finish. Give the fixture its canonical directory without host I/O.
    Object.assign(fixture.registry, { acpWorktreeRepositoryResolver: async (cwd: string) =>
      archived.find((thread) => thread.linkedDirectories[0]?.worktreePath === cwd)?.linkedDirectories[0] });
    vi.mocked(stat).mockImplementation(async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof stat>>);
    const scan = fixture.registry.repairArchivedThreadWorktrees({ dryRun: true });
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await drivePacer(fixture.registry, scan);
    expect(result.archivedThreads).toBe(501);
    expect(result.candidates).toHaveLength(498);
    expect(result.protectedWorktrees).toBe(3);
    for (let index = 0; index < 3; index++) {
      expect(result.candidates.map((item) => item.worktreePath)).not.toContain(path.normalize(`/contrived/worktree-${index}`));
    }
    expect(pages).toHaveLength(7);
    expect(Math.max(...pages)).toBe(100);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.client.archiveThread).not.toHaveBeenCalled();
  });

  it("acknowledges before discovery and bounds each provider/overlay slice for 1000 active threads", async () => {
    vi.useFakeTimers();
    const fixture = build(Array.from({ length: 1000 }, (_, id) => codexThread({ id: `active-${id}` })));
    const request = fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.counts.archiveMutations).toBe(1);
    expect(await request).toMatchObject({ cleanupPending: true, cleanup: [] });
    expect(fixture.counts.providerPages).toBe(0);
    await fixture.registry.whenArchiveCleanupCheckpointPendingForTests();
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    // Admission itself yields, then the provider page gets its own slice.
    expect(fixture.counts.providerPages).toBe(0);
    await fixture.registry.whenArchiveCleanupCheckpointPendingForTests();
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    expect(fixture.counts.providerPages).toBe(1);
    expect(fixture.counts.overlayReads).toBe(0);
    await drivePacer(fixture.registry, fixture.completion);
    expect(fixture.counts).toEqual(budgets["1000-active-threads"]);
    expect(fixture.events.find((event) => event.notification.method === "thread/archiveCleanup/completed")?.notification.params)
      .toMatchObject({ threadId: "target", cleanup: [] });
  });

  it("coalesces duplicate archive requests by backend identity", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const first = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const second = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, first);
    expect(await first).toEqual(await second);
    expect(fixture.client.archiveThread).toHaveBeenCalledOnce();
    expect(fixture.counts.providerPages).toBe(2);
  });

  it.each([false, true])("removes a newly started thread's worktree before navigation acknowledges its workspace (background: %s)", async (backgroundCleanup) => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: target.id })) });
    await fixture.registry.startThread({
      backend: "codex", cwd: "/contrived/worktree", linkedDirectories: target.linkedDirectories,
      mcpConnectionIds: [],
    });
    vi.useFakeTimers();

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: target.id, backgroundCleanup }));
    let cleanup: unknown = result.cleanup;
    if (backgroundCleanup) {
      const notification = (await drivePacer(fixture.registry, fixture.completion)).notification;
      if (notification.method !== "thread/archiveCleanup/completed") throw new Error("Expected archive cleanup completion.");
      cleanup = notification.params.cleanup;
    }

    expect(cleanup).toEqual([expect.objectContaining({
      removedWorktree: true, worktreePath: "/contrived/worktree",
    })]);
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(stat).toHaveBeenCalledWith("/contrived/worktree");
    expect(fixture.counts.providerPages).toBe(4);
    expect(fixture.counts.aggregateLists).toBe(0);
  });

  it("retains the provisional active thread when the provider rejects archive", async () => {
    const fixture = build([]);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: "target" })) });
    await fixture.registry.startThread({ backend: "codex", cwd: "/contrived/worktree", mcpConnectionIds: [] });
    fixture.client.archiveThread.mockRejectedValue(new Error("Archive rejected."));

    await expect(fixture.registry.archiveThread({ backend: "codex", threadId: "target" })).rejects.toThrow("Archive rejected.");

    fixture.client.listThreads.mockResolvedValue([]);
    expect(await fixture.registry.listThreads({ backend: "codex" })).toEqual([
      expect.objectContaining({ id: "target", projectKey: "/contrived/worktree" }),
    ]);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it.each([
    { method: "thread/archived", params: { threadId: "target" } },
    { method: "thread/deleted", params: { threadId: "target" } },
  ] as const)("retires provisional active metadata on $method", async (notification) => {
    const fixture = build([]);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: "target" })) });
    await fixture.registry.startThread({ backend: "codex", cwd: "/contrived/worktree", mcpConnectionIds: [] });

    await publishNotification(fixture.registry, notification);

    fixture.client.listThreads.mockResolvedValue([]);
    expect(await fixture.registry.listThreads({ backend: "codex" })).toEqual([]);
  });

  it("keeps a worktree used by another newly started thread absent from provider listings", async () => {
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([], codexThread({ id: "target", linkedDirectories: [directory] }));
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: "shared-user" })) });
    await fixture.registry.startThread({
      backend: "codex", cwd: "/contrived/worktree", linkedDirectories: [directory], mcpConnectionIds: [],
    });
    vi.useFakeTimers();

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: shared-user");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("recovers retained active metadata after a confirmed missing rollout, including removal admission", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const fixture = build([target], target);
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    // Observe rejection while driving the pacer so the failing regression is
    // not reported as an unhandled rejection by the test runner.
    const observed = result.then((response) => ({ response }), (error: Error) => ({ error }));
    expect(await drivePacer(fixture.registry, observed)).toMatchObject({ response: { cleanup: [expect.objectContaining({ removedWorktree: true })] } });
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "target" }));
    expect(fixture.counts.providerPages).toBe(4);
    expect(fixture.counts.aggregateLists).toBe(0);
  });

  it("recovers a missing rollout using only the newly started thread's retained workspace", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    Object.assign(fixture.client, { startThread: vi.fn(async () => ({ threadId: target.id })) });
    await fixture.registry.startThread({
      backend: "codex", cwd: "/contrived/worktree", linkedDirectories: target.linkedDirectories, mcpConnectionIds: [],
    });
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    vi.useFakeTimers();

    const result = fixture.registry.archiveThread({ backend: "codex", threadId: target.id });
    const observed = result.then((response) => ({ response }), (error: Error) => ({ error }));
    expect(await drivePacer(fixture.registry, observed)).toMatchObject({ response: { cleanup: [expect.objectContaining({ removedWorktree: true })] } });
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledOnce();

    fixture.client.listThreads.mockResolvedValue([]);
    expect(await fixture.registry.listThreads({ backend: "codex" })).toEqual([]);
  });

  it("removes independent worktrees for concurrent synchronous archives after both provider mutations settle", async () => {
    vi.useFakeTimers();
    const targets = ["target", "second"].map((id) => codexThread({ id, linkedDirectories: [{
      id: `directory-${id}`, kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: `/contrived/${id}`,
    }] }));
    const fixture = build([], targets[0]);
    const archived: AppServerThreadSummary[] = [];
    fixture.client.archiveThread.mockImplementation(async ({ threadId }) => {
      archived.push(targets.find((target) => target.id === threadId)!);
      return { threadId };
    });
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived: isArchived }) => ({ threads: isArchived ? archived : [], nextCursor: undefined }));
    const results = await drivePacer(fixture.registry, Promise.all(targets.map((target) =>
      fixture.registry.archiveThread({ backend: "codex", threadId: target.id }),
    )));
    expect(fixture.client.archiveThread).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.cleanup[0])).toEqual([
      expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/target" }),
      expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/second" }),
    ]);
    expect(stat).toHaveBeenCalledWith("/contrived/target");
    expect(stat).toHaveBeenCalledWith("/contrived/second");
  });

  it("waits for the removal sentinel before admitting the next queued cleanup", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    let release!: () => void;
    const sentinelGate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const sentinelStarted = new Promise<void>((resolve) => { entered = resolve; });
    const defaultStat = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementation(async (filePath, options) => {
      if (filePath !== "/contrived/worktree") return await defaultStat(filePath, options);
      entered();
      await sentinelGate;
      throw Object.assign(new Error("Contrived worktree was removed."), { code: "ENOENT" });
    });
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived }) => {
      fixture.counts.providerPages += 1;
      return { threads: archived ? [target, codexThread({ id: "second" })] : [], nextCursor: undefined };
    });
    const first = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const second = fixture.registry.archiveThread({ backend: "codex", threadId: "second" });
    let settled = false;
    const results = Promise.all([first, second]).then((responses) => { settled = true; return responses; });
    try {
      await drivePacer(fixture.registry, sentinelStarted);
      expect(stat).toHaveBeenCalledWith("/contrived/worktree");
      expect(settled).toBe(false);
      // Only the first job's initial and final admission inventories ran.
      expect(fixture.counts.providerPages).toBe(4);
    } finally { release(); }
    const responses = await drivePacer(fixture.registry, results);
    expect(responses[0].cleanup[0]?.removedWorktree).toBe(true);
    // The second job reuses the batch's fleet index and removes nothing.
    expect(fixture.counts.providerPages).toBe(4);
  });

  it("keeps rejecting active target metadata without confirmed missing-rollout recovery", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target" });
    const fixture = build([target], target);
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.skippedReason).toContain("thread is active again");
    expect(fixture.store.setThreadArchiveTombstone).not.toHaveBeenCalled();
  });

  it.each(["active", "archived"] as const)("does not treat the target's delayed archive notification as a new workspace mutation during the final %s inventory", async (phase) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === (phase === "active" ? 3 : 4)) {
        await publishNotification(fixture.registry, { method: "thread/archived", params: { threadId: "target" } });
      }
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it.each([
    { active: false, archived: true, removes: true },
    { active: true, archived: true, removes: false },
    { active: true, archived: false, removes: false },
    { active: false, archived: false, removes: false },
  ])("requires unambiguous archived membership (active: $active, archived: $archived)", async (inventory) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    Object.assign(fixture.client, { readArchiveCleanupThreadSummary: vi.fn(async () => target) });
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async ({ archived }) => ({
      threads: (archived ? inventory.archived : inventory.active) ? [target] : [], nextCursor: undefined,
    }));

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(inventory.removes);
    if (!inventory.removes) {
      expect(result.cleanup[0]?.skippedReason).toContain("metadata was not found or the thread is active again");
      expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    }
  });

  it.each([1, 2, 3, 4].flatMap((boundary) => [
    { boundary, notification: { method: "thread/unarchived" as const, params: { threadId: "target" } } },
    { boundary, notification: { method: "thread/deleted" as const, params: { threadId: "target" } } },
  ]))("cancels removal on $notification.method at inventory boundary $boundary", async ({ boundary, notification }) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === boundary) await publishNotification(fixture.registry, notification);
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.skippedReason ?? result.cleanup[0]?.error).toContain("cancelled");
    // Only permanent deletion releases the thread's assets; unarchive keeps them.
    expect(vi.mocked(deleteThreadAssets).mock.calls).toEqual(notification.method === "thread/deleted"
      ? [[{ backend: "codex", threadId: "target" }]]
      : []);
  });

  it.each(["codex", "claude"] as const)("removes a worktree while 30 unrelated %s threads start turns during and after admission", async (backend) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const others = Array.from({ length: 30 }, (_, index) => codexThread({
      id: `other-${index}`, projectKey: `/contrived/other-${index}`,
    }));
    const fixture = build(backend === "codex" ? others : [], target);
    if (backend === "claude") {
      vi.mocked(fixture.claudeStore.list).mockResolvedValue(others.map((thread) => ({ cwd: thread.projectKey!, thread: { ...thread, source: "claude" } })));
      Object.assign(fixture.registry, { acpWorktreeRepositoryResolver: async (cwd: string) => ({ id: cwd, kind: "local", label: "other", path: cwd }) });
    }
    const activity = async () => {
      for (const thread of others) {
        await publishNotification(fixture.registry, { method: "turn/started", params: { threadId: thread.id, turn: { id: `turn-${thread.id}` } } }, backend);
        await publishNotification(fixture.registry, { method: "thread/status/changed", params: { threadId: thread.id, status: { type: "active" } } }, backend);
      }
    };
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === (backend === "codex" ? 4 : 3)) await activity();
      return await listPage(params);
    });
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      const assertRemoval = await params.beforeRemove!();
      await activity();
      return assertRemoval;
    } }));

    try {
      const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
      expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
      // Activity on unrelated threads rereads those identities, not the fleet.
      expect(fixture.counts.providerPages).toBe(4);
      expect(fixture.counts.archiveMutations).toBe(1);
    } finally {
      // These workspaces are contrived. Terminal branch adoption must use
      // fixture evidence too: a missing host directory makes the real probe
      // fall back to owned Git (one PowerShell launch per Claude turn on
      // Windows), unrelated to the archive admission this test drives.
      const branchProbe = vi.spyOn(gitHeadBranch, "probeCurrentGitBranch")
        .mockResolvedValue(gitHeadBranch.NOT_A_GIT_REPOSITORY);
      try {
        for (const thread of others) {
          await publishNotification(fixture.registry, { method: "turn/completed", params: { threadId: thread.id, turnId: `turn-${thread.id}`, turn: { id: `turn-${thread.id}`, status: "completed", output: [] } } }, backend);
          await publishNotification(fixture.registry, { method: "thread/status/changed", params: { threadId: thread.id, status: { type: "idle" } } }, backend);
        }
      } finally {
        branchProbe.mockRestore();
      }
    }
  });

  it.each([undefined, "/contrived/new-other", "/contrived/worktree"])("checks an unrelated lifecycle mutation's destination %s while it is in flight", async (targetPath) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([codexThread({ id: "other", projectKey: "/contrived/other" })], target);
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    let mutation: Promise<void> | undefined;
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      mutation = fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "other", targetPath }, async () => { started(); await held; });
      await entered;
      return await params.beforeRemove!();
    } }));
    try {
      const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
      expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: targetPath !== "/contrived/worktree" })]);
    } finally {
      finish();
      await mutation;
    }
  });

  it.each(["unrelated", "shared", "overlay", "unknown"] as const)("checks a newly started %s thread after the final inventory", async (workspace) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    if (workspace === "overlay") fixture.overlays.set("new-thread", { backend: "codex", threadId: "new-thread", extraLinkedDirectories: target.linkedDirectories });
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      const assertRemoval = await params.beforeRemove!();
      await publishNotification(fixture.registry, { method: "thread/started", params: { thread: codexThread({
        id: "new-thread", projectKey: workspace === "unknown" ? undefined : `/contrived/${workspace === "shared" ? "worktree" : "new-other"}`,
      }) } });
      await publishNotification(fixture.registry, { method: "thread/status/changed", params: { threadId: "new-thread", status: { type: "active" } } });
      return assertRemoval;
    } }));
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: workspace === "unrelated" })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it.each(["codex", "claude"] as const)("still rejects a different %s thread's archive notification during removal admission", async (backend) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === 3) await publishNotification(fixture.registry, { method: "thread/archived", params: { threadId: "other" } }, backend);
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it.each([
    { method: "thread/name/updated", params: { threadId: "other", threadName: "Updated title" } },
    { method: "thread/status/changed", params: { threadId: "other", status: { type: "idle" } } },
    { method: "thread/status/changed", params: { threadId: "other", status: { type: "notLoaded" } } },
    { method: "thread/parent/cleared", params: { threadId: "other" } },
  ] as const)("removes the worktree when $method refreshes unrelated display metadata during admission", async (notification) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === 3) await publishNotification(fixture.registry, notification);
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/worktree" })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it("removes the worktree when navigation refreshes the now-archived thread during admission", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([target]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    fixture.client.listThreads.mockResolvedValue([]);
    vi.useFakeTimers();
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    let reads = 0;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (++reads === 3) await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: "/contrived/worktree" })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it.each(["active", "systemError"])("keeps the worktree if an excluded checkout user becomes %s after the final inventory", async (type) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      await publishNotification(fixture.registry, {
        method: "thread/status/changed", params: { threadId: "guardian-review", status: { type } },
      });
      assertRemoval?.();
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("keeps the worktree if navigation discovers a new active identity after the final inventory", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    vi.useFakeTimers();
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "new-user", linkedDirectories: target.linkedDirectories })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it.each([false, true])("keeps the worktree when navigation observes a checkout owner after the final inventory (previously listed: %s)", async (previouslyListed) => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    if (previouslyListed) {
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    }
    vi.useFakeTimers();
    let removalAdmitted = false;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", projectKey: "/contrived/worktree", linkedDirectories: [] })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      removalAdmitted = true;
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(removalAdmitted).toBe(false);
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("keeps the worktree when navigation confirms an older owner observation missing from the final inventory", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const owner = codexThread({ id: "owner", projectKey: "/contrived/worktree", linkedDirectories: [] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([owner]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    vi.useFakeTimers();
    let removalAdmitted = false;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      fixture.client.listThreads.mockResolvedValue([]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      removalAdmitted = true;
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(removalAdmitted).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it("keeps the worktree when an existing thread gains a linked checkout after the final inventory", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", linkedDirectories: [] })]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false });
    vi.useFakeTimers();
    let removalAdmitted = false;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const assertRemoval = await params.beforeRemove?.();
      fixture.client.listThreads.mockResolvedValue([codexThread({ id: "owner", linkedDirectories: target.linkedDirectories })]);
      await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
      assertRemoval?.();
      removalAdmitted = true;
      throw new Error("Removal should have been denied.");
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(removalAdmitted).toBe(false);
    expect(result.cleanup[0]?.error).toContain("workspace state changed");
  });

  it.each(["shared", "unrelated", "multiple", "failed-read", "failed-provider"] as const)("refreshes overlay-only %s attachments notified after beforeRemove", async (scenario) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const owners = ["first", "second"].map((id) => codexThread({ id, projectKey: `/contrived/${id}`, linkedDirectories: [] }));
    const fixture = build(owners, target);
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      const assertRemoval = await params.beforeRemove!();
      const changedIds = scenario === "multiple" ? ["first", "second"] : ["first"];
      for (const id of changedIds) fixture.overlays.set(id, { backend: "codex", threadId: id, extraLinkedDirectories:
        scenario === "unrelated" || (scenario === "multiple" && id === "first")
          ? [{ id: "extra", kind: "local", label: "extra", path: "/contrived/unrelated" }]
          : target.linkedDirectories });
      if (scenario === "failed-read") fixture.store.getArchiveCleanupOverlayStates.mockRejectedValueOnce(new Error("Overlay unavailable"));
      if (scenario === "failed-provider") fixture.client.listArchiveCleanupThreadsPage.mockRejectedValueOnce(new Error("Provider unavailable"));
      await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: {
        reason: "selected-thread", threadIds: changedIds,
      } });
      return assertRemoval;
    } }));

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.removedWorktree).toBe(scenario === "unrelated");
    if (scenario !== "unrelated") expect(result.cleanup[0]?.error).toContain("workspace state changed");
    expect(fixture.client.listThreads).not.toHaveBeenCalled();
  });

  it("fences removal synchronously while a directory notification's overlay read is held", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], target);
    let fencedWhileHeld = false;
    let overlayReadHeld = false;
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      const assertRemoval = await params.beforeRemove!();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const reading = new Promise<void>((resolve) => { started = resolve; });
      fixture.store.getArchiveCleanupOverlayStates.mockImplementationOnce(async () => {
        started();
        await held;
        return { owner: { backend: "codex", threadId: "owner", extraLinkedDirectories: target.linkedDirectories } };
      });
      const notification = publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: {
        reason: "selected-thread", threadIds: ["owner"],
      } });
      try {
        try { assertRemoval(); } catch { fencedWhileHeld = true; }
        overlayReadHeld = await Promise.race([reading.then(() => true), notification.then(() => false)]);
      } finally {
        release();
        await notification;
      }
      return assertRemoval;
    } }));
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(fencedWhileHeld).toBe(true);
    expect(overlayReadHeld).toBe(true);
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
  });

  it.each(["before-admission", "after-admission"] as const)("fences an attachment begun %s before its first await", async (timing) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], target);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const attach = () => fixture.registry.withThreadWorkspaceMutation({ backend: "codex", threadId: "owner" }, async () => {
      await held;
      fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: target.linkedDirectories });
      await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: {
        reason: "selected-thread", threadIds: ["owner"],
      } });
    });
    let mutation = timing === "before-admission" ? attach() : undefined;
    let fencedBeforeWrite = false;
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      let assertRemoval: () => void;
      try {
        assertRemoval = await params.beforeRemove!();
      } catch (error) {
        fencedBeforeWrite = timing === "before-admission";
        release();
        await mutation;
        throw error;
      }
      mutation ??= attach();
      try { assertRemoval(); } catch { fencedBeforeWrite = true; }
      release();
      await mutation;
      return assertRemoval;
    } }));
    try {
      const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
      expect(fencedBeforeWrite).toBe(true);
      expect(result.cleanup[0]?.removedWorktree).toBe(false);
    } finally {
      release();
      await mutation;
    }
  });

  it("persists the snapshot when a directory change arrives after irreversible removal", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], target);
    const persist = vi.fn(async () => {});
    Object.assign(fixture.store, { upsertWorktreeSnapshot: persist });
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const snapshot = await archive(params);
      await fixture.registry.withThreadWorkspaceMutation({ backend: "codex", threadId: "owner" }, async () => {
        fixture.overlays.set("owner", { backend: "codex", threadId: "owner", extraLinkedDirectories: target.linkedDirectories });
        await publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: {
          reason: "selected-thread", threadIds: ["owner"],
        } });
      });
      return snapshot;
    });
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.removedWorktree).toBe(true);
    expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ snapshot: expect.objectContaining({ snapshotCommit: "abc" }) }));
  });

  it("does not admit removal when an older directory event completes ahead of a newer held read", async () => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [] })], target);
    let fencedAfterOldRead = false;
    const archive = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
      const assertRemoval = await params.beforeRemove!();
      const gates = [0, 1].map(() => {
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const reading = new Promise<void>((resolve) => { started = resolve; });
        return { held, reading, release, started };
      });
      for (const [index, gate] of gates.entries()) fixture.store.getArchiveCleanupOverlayStates.mockImplementationOnce(async () => {
        gate.started();
        await gate.held;
        return { owner: { backend: "codex", threadId: "owner", extraLinkedDirectories: index === 0 ? [] : target.linkedDirectories } };
      });
      const notify = () => publishNotification(fixture.registry, { method: "navigation/threadDirectories/updated", params: {
        reason: "selected-thread", threadIds: ["owner"],
      } });
      const first = notify();
      await Promise.race([gates[0]!.reading, first]);
      const second = notify();
      try {
        await Promise.race([gates[1]!.reading, second]);
        gates[0]!.release();
        await first;
        try { assertRemoval(); } catch { fencedAfterOldRead = true; }
      } finally {
        for (const gate of gates) gate.release();
        await Promise.all([first, second]);
      }
      return assertRemoval;
    } }));
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(fencedAfterOldRead).toBe(true);
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
  });

  it("removes the worktree when an unenriched refresh preserves an existing owner's workspace", async () => {
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const owner = codexThread({ id: "owner", projectKey: "/contrived/other", linkedDirectories: [{
      id: "other-directory", kind: "worktree", label: "other", path: "/contrived/other-repo", worktreePath: "/contrived/other",
    }] });
    const fixture = build([owner], target);
    fixture.client.listThreads.mockResolvedValue([owner]);
    await fixture.registry.listThreads({ backend: "codex", enrichDirectories: true });
    vi.useFakeTimers();
    const archiveWorktree = fixture.archiveWorktree.getMockImplementation()!;
    fixture.archiveWorktree.mockImplementation(async (params) => {
      const beforeRemove = params.beforeRemove;
      return await archiveWorktree({ ...params, beforeRemove: async () => {
        const assertRemoval = await beforeRemove!();
        fixture.client.listThreads.mockResolvedValue([{ ...owner, title: "Updated title", linkedDirectories: [] }]);
        await fixture.registry.listThreads({ backend: "codex", enrichDirectories: false, forceRefresh: true });
        return assertRemoval;
      } });
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.removedWorktree).toBe(true);
  });

  it.each([false, true])("keeps the worktree when provider discovery fails during archived: %s", async (failedArchived) => {
    vi.useFakeTimers();
    const target = codexThread({ id: "target", linkedDirectories: [{
      id: "directory", kind: "worktree", label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree",
    }] });
    const fixture = build([], target);
    const listPage = fixture.client.listArchiveCleanupThreadsPage.getMockImplementation()!;
    fixture.client.listArchiveCleanupThreadsPage.mockImplementation(async (params) => {
      if (params.archived === failedArchived) throw new Error("Inventory unavailable.");
      return await listPage(params);
    });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.skippedReason).toContain("Inventory unavailable");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("rejects a non-advancing provider cursor instead of using a partial safety inventory", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    fixture.client.listArchiveCleanupThreadsPage.mockResolvedValue({ threads: [], nextCursor: "repeat" });

    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));

    expect(result.cleanup[0]?.skippedReason).toContain("repeated cursor");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.client.listArchiveCleanupThreadsPage).toHaveBeenCalledTimes(2);
  });

  it("preserves shared-checkout protection during missing-rollout recovery", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const fixture = build([target, codexThread({ id: "shared-user", linkedDirectories: [directory] })], target);
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    const result = await drivePacer(fixture.registry, fixture.registry.archiveThread({ backend: "codex", threadId: "target" }));
    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: shared-user");
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledOnce();
  });

  it("removes a shared worktree after the preceding missing-rollout owner is tombstoned", async () => {
    vi.useFakeTimers();
    await fc.assert(fc.asyncProperty(fc.boolean(), async (secondCompletesFirst) => {
      const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
      const targets = ["first", "second"].map((id) => codexThread({ id, linkedDirectories: [directory] }));
      const earlyIndex = Number(secondCompletesFirst);
      const lateIndex = 1 - earlyIndex;
      const earlyId = targets[earlyIndex]!.id;
      const lateId = targets[lateIndex]!.id;
      const fixture = build(targets, targets[0]!);
      let releaseProvider!: () => void;
      const providerReply = new Promise<void>((resolve) => { releaseProvider = resolve; });
      fixture.client.archiveThread.mockImplementation(async ({ threadId }) => {
        if (threadId === lateId) await providerReply;
        throw new Error(`json-rpc error (-32600): no rollout found for thread id ${threadId}`);
      });
      fixture.store.setThreadArchiveTombstone.mockImplementation(async ({ threadId, archivedAt }) => {
        fixture.overlays.set(threadId, { backend: "codex", threadId, extraLinkedDirectories: [], archiveTombstonedAt: archivedAt });
      });
      // Both requests start together. Provider replies can settle in either
      // order; the four cleanup workers do not promise request-order results.
      const requests = targets.map((thread) => fixture.registry.archiveThread({ backend: "codex", threadId: thread.id }));
      const results = Promise.all(requests);
      try {
        const early = await drivePacer(fixture.registry, requests[earlyIndex]!);
        expect(early.cleanup[0]?.skippedReason).toContain(`another active thread: ${lateId}`);
        expect(fixture.archiveWorktree).not.toHaveBeenCalled();
        expect(fixture.overlays.get(earlyId)?.archiveTombstonedAt).toBeDefined();
        expect(fixture.overlays.get(lateId)?.archiveTombstonedAt).toBeUndefined();
        expect(fixture.counts.providerPages).toBe(2);
        releaseProvider();
        const completed = await drivePacer(fixture.registry, results);
        expect(completed[lateIndex]?.cleanup[0]).toMatchObject({ removedWorktree: true });
        expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
        expect(fixture.archiveWorktree).toHaveBeenCalledWith(expect.objectContaining({ threadId: lateId }));
        expect(fixture.store.setThreadArchiveTombstone).toHaveBeenCalledTimes(2);
        // The controlled replies make two batches, each reading both provider
        // pages. Removal admission reads both afresh because this provider
        // cannot order by updated_at. Tombstones reread only their own overlay.
        expect(fixture.counts.providerPages).toBe(6);
      } finally {
        releaseProvider();
        await drivePacer(fixture.registry, results).catch(() => {});
        await fixture.registry.close();
        registries.splice(registries.indexOf(fixture.registry), 1);
      }
    }), { numRuns: 25, examples: [[false], [true]] });
  });

  it("cancels missing-rollout recovery on genuine restore intent before removal", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const target = codexThread({ id: "target", linkedDirectories: [directory] });
    const fixture = build([target], target);
    fixture.client.archiveThread.mockRejectedValue(new Error("json-rpc error (-32600): no rollout found for thread id target"));
    fixture.archiveWorktree.mockImplementation(async (params) => {
      await publishNotification(fixture.registry, { method: "thread/unarchived", params: { threadId: "target" } });
      await params.beforeRemove?.();
      throw new Error("Removal should have been cancelled.");
    });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const observed = result.then(() => undefined, (error: Error) => error.message);
    const error = await drivePacer(fixture.registry, observed);
    expect(error).toContain("cleanup did not complete");
    expect(error).toContain("cancelled");
    expect(fixture.archiveWorktree).toHaveBeenCalledOnce();
    expect(fixture.store.setThreadArchiveTombstone).not.toHaveBeenCalled();
  });

  it("still refuses removal while another provider archive mutation is in flight", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([], codexThread({ id: "target", linkedDirectories: [directory] }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const archive = fixture.client.archiveThread.getMockImplementation()!;
    fixture.client.archiveThread.mockImplementation(async (params) => {
      if (params.threadId === "second") await gate;
      return await archive(params);
    });
    const first = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    const second = fixture.registry.archiveThread({ backend: "codex", threadId: "second" });
    try {
      const result = await drivePacer(fixture.registry, first);
      expect(result.cleanup[0]?.error).toContain("lifecycle mutation is still in flight");
    } finally {
      release();
      await drivePacer(fixture.registry, second);
    }
  });

  it("uses a targeted authoritative row and skips the archived inventory when no worktree can be removed", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    const read = vi.fn(async () => codexThread({ id: "target" }));
    Object.assign(fixture.client, { readArchiveCleanupThreadSummary: read });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, result);
    expect((await result).cleanup).toEqual([]);
    expect(read).toHaveBeenCalledOnce();
    // The batch's fleet index reads active and archived identities once, and
    // every later job in the batch reuses it instead of rereading either list.
    expect(fixture.client.listArchiveCleanupThreadsPage.mock.calls.map(([params]) => params.archived)).toEqual([false, true]);
  });

  it("exposes delayed metadata failure on the background completion event", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    fixture.client.listArchiveCleanupThreadsPage.mockRejectedValue(new Error("provider unavailable"));
    expect(await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true }))
      .toMatchObject({ cleanupPending: true });
    const event = await drivePacer(fixture.registry, fixture.completion);
    expect(event.notification.params).toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("provider unavailable") })] });
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
  });

  it("serializes an inverse intent behind provider mutation and cancels its new cleanup", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    const archive = fixture.client.archiveThread.getMockImplementation()!;
    fixture.client.archiveThread.mockImplementation(async (params) => { await providerGate; return await archive(params); });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await vi.advanceTimersByTimeAsync(0);
    let inverseRan = false;
    const inverse = fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "target" }, async () => { inverseRan = true; });
    expect(inverseRan).toBe(false);
    release();
    await drivePacer(fixture.registry, inverse);
    expect(inverseRan).toBe(true);
    expect((await result).cleanup[0]?.skippedReason).toContain("cancelled");
    expect(fixture.counts.providerPages).toBe(0);
  });

  it("keeps a worktree when a new active shared user appears during snapshot preparation", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const active: AppServerThreadSummary[] = [];
    const fixture = build(active, codexThread({ id: "target", linkedDirectories: [directory] }));
    fixture.archiveWorktree.mockImplementation(async (params) => {
      active.push(codexThread({ id: "new-user", linkedDirectories: [directory] }));
      const admission = await params.beforeRemove?.();
      admission?.();
      throw new Error("Removal should have been denied.");
    });
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, result);
    expect((await result).cleanup).toEqual([expect.objectContaining({ removedWorktree: false, error: expect.stringContaining("still used") })]);
    expect(fixture.counts.providerPages).toBe(4);
  });

  it("refuses removal while an older lifecycle mutation remains in flight", async () => {
    vi.useFakeTimers();
    const directory = { id: "directory", kind: "worktree" as const, label: "repo", path: "/contrived/repo", worktreePath: "/contrived/worktree" };
    const fixture = build([], codexThread({ id: "target", linkedDirectories: [directory] }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const other = fixture.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "moving-thread" }, async () => { await gate; });
    await vi.advanceTimersByTimeAsync(0);
    try {
      const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
      await drivePacer(fixture.registry, result);
      expect((await result).cleanup[0]?.error).toContain("lifecycle mutation is still in flight");
    } finally { release(); await other; }
  });

  it("cancels a queued cleanup on unarchive and reports completion without removal", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    await publishNotification(fixture.registry, { method: "thread/unarchived", params: { threadId: "target" } });
    await drivePacer(fixture.registry, fixture.completion);
    expect(fixture.counts.providerPages).toBe(0);
    expect(fixture.archiveWorktree).not.toHaveBeenCalled();
    expect(fixture.events.find((event) => event.notification.method === "thread/archiveCleanup/completed")?.notification.params)
      .toMatchObject({ cleanup: [expect.objectContaining({ skippedReason: expect.stringContaining("cancelled") })] });
  });

  it("treats archive after an intervening unarchive as a new provider mutation", async () => {
    vi.useFakeTimers();
    const fixture = build([]);
    await fixture.registry.archiveThread({ backend: "codex", threadId: "target", backgroundCleanup: true });
    await publishNotification(fixture.registry, { method: "thread/unarchived", params: { threadId: "target" } });
    const retry = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, retry);
    expect((await retry).cleanup).toEqual([]);
    expect(fixture.client.archiveThread).toHaveBeenCalledTimes(2);
    expect(fixture.counts.providerPages).toBe(2);
  });

  it("revalidates child grouping and excludes remote-parent identities", async () => {
    vi.useFakeTimers();
    const fixture = build([codexThread({ id: "child" }), codexThread({ id: "remote-child" })]);
    fixture.overlays.set("child", { backend: "codex", threadId: "child", extraLinkedDirectories: [], parentThreadId: "target", parentThreadBackend: "codex" });
    fixture.overlays.set("remote-child", { backend: "codex", threadId: "remote-child", extraLinkedDirectories: [], parentThreadId: "target", parentThreadBackend: "codex", parentThreadInstanceId: "other-owner" });
    fixture.store.getThreadOverlayState.mockImplementation(async ({ threadId }) => ({
      ...fixture.overlays.get(threadId)!, parentThreadId: "new-parent",
    }));
    const result = fixture.registry.archiveThread({ backend: "codex", threadId: "target" });
    await drivePacer(fixture.registry, result);
    await result;
    expect(fixture.store.setThreadParent).not.toHaveBeenCalled();
  });
});
