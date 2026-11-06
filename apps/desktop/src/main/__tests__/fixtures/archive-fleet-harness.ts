import { vi } from "vitest";
import { realpath } from "node:fs/promises";
import type { AppServerThreadSummary, LinkedDirectorySummary, ThreadOverlayState, WorktreeSnapshotSummary } from "@pwragent/shared";
import { ARCHIVE_CLEANUP_PAUSE_MS } from "../../app-server/archive-cleanup-queue";
import { ClaudeSessionStore } from "../../claude/claude-session-store";
import { DesktopBackendRegistry } from "../../app-server/backend-registry";
import { MissingArchiveWorktreeError } from "../../app-server/worktree-archive-service";
import type { ArchiveCleanupCheckpointStore } from "../../state/archive-cleanup-checkpoint";

/**
 * A registry wired to contrived providers that count every boundary archive
 * cleanup crosses: paged `thread/list` and `thread/read`, Git directory
 * enrichment, overlay queries, `realpath`, snapshot/removal, overlay writes,
 * and checkpoint saves with the bytes they serialize and write.
 *
 * The test file must mock `node:fs/promises` so that `realpath` and `stat`
 * consult its `ArchiveFleetFs` for paths under `/contrived` (see
 * archive-cleanup-scaling.test.ts).
 */
export type ArchiveFleetFs = {
  removed: Set<string>;
  aliases: Map<string, string>;
  realpathCalls: number;
};

/** The POSIX model form of a path the registry resolved natively; on Windows
 * it arrives as a drive path in lower case. */
export function toModelPath(value: string): string {
  return process.platform === "win32" ? value.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/").toLowerCase() : value;
}

export function resolveFleetAlias(fs: ArchiveFleetFs, value: string): string {
  for (const [alias, target] of fs.aliases) {
    if (value === alias || value.startsWith(alias + "/")) return target + value.slice(alias.length);
  }
  return value;
}

export type Counts = {
  providerPages: number;
  providerRows: number;
  threadReads: number;
  enrichedRows: number;
  gitDiscoveries: number;
  overlayQueries: number;
  overlayRows: number;
  claudeLists: number;
  realpathCalls: number;
  checkpointSaves: number;
  /** JSON the registry handed to each save. */
  checkpointSerializedBytes: number;
  /** Values actually written to SQLite. */
  checkpointBytes: number;
  overlayWrites: number;
  snapshots: number;
  removals: number;
};

export type Fleet = {
  /** Live rows by id; `archived` flips on the provider mutation. */
  rows: Map<string, { thread: AppServerThreadSummary; archived: boolean; updatedAt: number }>;
  overlays: Map<string, ThreadOverlayState>;
  targets: string[];
  /** Checkout canonical path -> expected removal. */
  checkouts: Set<string>;
  holders?: string[];
};

export const REPO = "/contrived/repo";

export function worktree(id: string, worktreePath: string): LinkedDirectorySummary {
  return { id, kind: "worktree", label: "repo", path: REPO, worktreePath };
}

/** A provider row as `thread/list` returns it before Git enrichment. */
export function raw(id: string, cwd: string | undefined, updatedAt = 1_000): AppServerThreadSummary {
  return { id, source: "codex", title: id, titleSource: "fallback", updatedAt, projectKey: cwd, linkedDirectories: [] } as AppServerThreadSummary;
}

export async function drivePacer<T>(registry: DesktopBackendRegistry, promise: Promise<T>): Promise<T> {
  let settled = false;
  const settlement = promise.then(() => { settled = true; }, () => { settled = true; });
  for (;;) {
    await Promise.race([settlement, registry.whenArchiveCleanupCheckpointPendingForTests()]);
    if (settled) return await promise;
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
  }
}

export type FleetRegistryOptions = {
  instanceId?: string;
  /** Runs at the instant of `git worktree remove`, after every assertion. */
  onRemove?: (canonical: string, params: { threadId: string }) => void;
  /** The real service awaits Git and terminal teardown between admission and
   * removal, then asserts again. A model parks here to interleave changes. */
  parkBeforeRemove?: () => Promise<void>;
  /** After the snapshot commit and before removal admission. */
  beforeAdmission?: (params: { threadId: string; worktreePath: string }) => Promise<void>;
  /** Fail this many snapshot persistence writes, after the removal. */
  failSnapshotWrites?: { remaining: number };
  /** The overlay store's foreign-writer token; constant by default. */
  overlayToken?: () => string | undefined;
  onSnapshot?: (threadId: string, snapshot: WorktreeSnapshotSummary) => void;
  /** Called with the database the checkpoint writes, to count its bytes. */
  checkpointDb?: { prepare: (sql: string) => unknown };
};

export function buildFleetRegistry(fs: ArchiveFleetFs, fleet: Fleet, checkpoint: ArchiveCleanupCheckpointStore, options: FleetRegistryOptions = {}) {
  const counts: Counts = {
    providerPages: 0, providerRows: 0, threadReads: 0, enrichedRows: 0, gitDiscoveries: 0, overlayQueries: 0,
    overlayRows: 0, claudeLists: 0, realpathCalls: 0, checkpointSaves: 0, checkpointSerializedBytes: 0, checkpointBytes: 0,
    overlayWrites: 0, snapshots: 0, removals: 0,
  };
  let clock = 1_000_000;
  // Simulated `enrichRawThreadDirectories`: a Git discovery per related cwd.
  const enrich = async (rows: AppServerThreadSummary[], params: {
    directoryFilter?: (cwd: string | undefined) => Promise<boolean>;
    directoryObservations?: Map<string, Promise<unknown>>;
  }) => await Promise.all(rows.map(async (row) => {
    counts.enrichedRows += 1;
    const cwd = row.projectKey;
    if (!cwd || (params.directoryFilter && !await params.directoryFilter(cwd))) {
      return { ...row, linkedDirectories: cwd ? [{ id: cwd, kind: "local" as const, label: "repo", path: cwd }] : [] };
    }
    if (!params.directoryObservations?.has(cwd)) {
      counts.gitDiscoveries += 1;
      params.directoryObservations?.set(cwd, Promise.resolve());
    }
    // Git reports the checkout containing the cwd; anything outside the
    // managed worktree roots is an ordinary local directory.
    const toplevel = /^\/contrived\/(?:worktrees|aliases)\/[^/]+/.exec(cwd)?.[0];
    return { ...row, linkedDirectories: [toplevel ? worktree(cwd, toplevel) : { id: cwd, kind: "local" as const, label: "repo", path: cwd }] };
  }));
  const listPage = async (params: {
    archived: boolean; cursor?: string; limit: number; checkpoint: () => Promise<void>;
    directoryObservations?: Map<string, Promise<unknown>>;
    directoryFilter?: (cwd: string | undefined) => Promise<boolean>;
    sortKey?: "created_at" | "updated_at";
  }) => {
    counts.providerPages += 1;
    const all = [...fleet.rows.values()].filter((row) => row.archived === params.archived);
    if (params.sortKey === "updated_at") all.sort((left, right) => right.updatedAt - left.updatedAt);
    const offset = Number(params.cursor ?? 0);
    const page = all.slice(offset, offset + params.limit);
    counts.providerRows += page.length;
    const threads = await enrich(page.map((row) => ({ ...row.thread, updatedAt: row.updatedAt })), params);
    return { threads, nextCursor: offset + page.length < all.length ? String(offset + page.length) : undefined };
  };
  const client = {
    archiveThread: vi.fn(async ({ threadId }: { threadId: string }) => {
      const row = fleet.rows.get(threadId)!;
      row.archived = true;
      row.updatedAt = (clock += 1);
      return { threadId };
    }),
    listThreads: vi.fn(async () => { throw new Error("Aggregate discovery is outside the archive budget."); }),
    listArchiveCleanupThreadsPage: vi.fn(listPage),
    archiveCleanupRecencyReads: true,
    readArchiveCleanupThreadSummary: vi.fn(async (threadId: string) => {
      counts.threadReads += 1;
      const row = fleet.rows.get(threadId);
      if (!row) throw new Error(`Thread metadata was not found: ${threadId}`);
      const [thread] = await enrich([{ ...row.thread, updatedAt: row.updatedAt }], {});
      return thread!;
    }),
    enrichArchiveCleanupThreads: vi.fn(async (threads: AppServerThreadSummary[], params: {
      directoryFilter?: (cwd: string | undefined) => Promise<boolean>;
      directoryObservations?: Map<string, Promise<unknown>>;
    }) => await enrich(threads, params)),
    onNotification: () => () => {},
    onPendingRequest: () => () => {},
    close: async () => {},
    getInitializeResult: async () => ({ methods: ["thread/list"] }),
  };
  const readOverlays = vi.fn(async ({ threadIds }: { threadIds: string[] }) => {
    counts.overlayQueries += 1;
    counts.overlayRows += threadIds.length;
    return Object.fromEntries(threadIds.map((id) => [id, fleet.overlays.get(id)]));
  });
  const write = (name: string) => vi.fn(async (...args: unknown[]) => {
    counts.overlayWrites += 1;
    void name; void args;
  });
  const store = new Proxy({
    // No other process writes this fixture's overlay store.
    readArchiveCleanupChangeToken: () => options.overlayToken ? options.overlayToken() : "single-writer",
    getArchiveCleanupOverlayStates: readOverlays,
    getThreadListingOverlayStates: readOverlays,
    getThreadOverlayStates: readOverlays,
    getThreadOverlayState: vi.fn(async ({ threadId }: { threadId: string }) => {
      counts.overlayQueries += 1;
      counts.overlayRows += 1;
      return fleet.overlays.get(threadId);
    }),
    upsertWorktreeSnapshot: vi.fn(async (params: { threadId: string; snapshot: WorktreeSnapshotSummary }) => {
      if (options.failSnapshotWrites && options.failSnapshotWrites.remaining > 0) {
        options.failSnapshotWrites.remaining -= 1;
        throw new Error("Snapshot persistence failed.");
      }
      counts.overlayWrites += 1;
      options.onSnapshot?.(params.threadId, { ...params.snapshot, worktreePath: toModelPath(params.snapshot.worktreePath) });
    }),
    observeArchivedThreads: write("observeArchivedThreads"),
    setThreadParent: write("setThreadParent"),
  }, { get(object, key) {
    if (key === "then") return undefined;
    if (key in object) return object[key as keyof typeof object];
    return vi.fn(async () => String(key).startsWith("list") ? [] : undefined);
  } });
  const archive = vi.fn(async (params: { backend: string; threadId: string; worktreePath: string; beforeRemove?: () => Promise<() => void> }) => {
    const resolved = await realpath(params.worktreePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new MissingArchiveWorktreeError(params.worktreePath);
      throw error;
    });
    // Report checkouts in the model's POSIX form; hand the registry its own.
    const canonical = toModelPath(resolved);
    counts.snapshots += 1;
    await options.beforeAdmission?.(params);
    const assertRemoval = await params.beforeRemove?.();
    assertRemoval?.();
    if (options.parkBeforeRemove) {
      await options.parkBeforeRemove();
      assertRemoval?.();
    }
    options.onRemove?.(canonical, params);
    counts.removals += 1;
    fs.removed.add(canonical);
    return { id: `snapshot:${canonical}`, backend: params.backend, threadId: params.threadId, worktreePath: resolved,
      repositoryPath: REPO, snapshotRef: "refs/pwragent/snapshots/test", snapshotCommit: "abc",
      createdAt: 1, archivedAt: 2, state: "archived", ignoredFilesExcluded: true };
  });
  const save = checkpoint.save.bind(checkpoint);
  checkpoint.save = (instanceId, intents) => {
    counts.checkpointSaves += 1;
    counts.checkpointSerializedBytes += intents.length ? JSON.stringify(intents).length : 0;
    save(instanceId, intents);
  };
  const db = options.checkpointDb;
  if (db && !(db as { countedForFleet?: boolean }).countedForFleet) {
    const prepare = db.prepare.bind(db);
    Object.assign(db, { countedForFleet: true, prepare: (sql: string) => {
      const statement = prepare(sql) as { run: (...args: unknown[]) => unknown };
      if (!sql.startsWith("INSERT INTO meta")) return statement;
      return { ...statement, run: (key: string, value: string) => {
        counts.checkpointBytes += value.length;
        return statement.run(key, value);
      } };
    } });
  }
  const claudeStore = new ClaudeSessionStore("/contrived/claude");
  vi.spyOn(claudeStore, "list").mockImplementation(async () => { counts.claudeLists += 1; return []; });
  const registry = new DesktopBackendRegistry({ codexClient: client as never, overlayStore: store as never,
    claudeBackendOptions: { store: claudeStore }, archiveCleanupCheckpointStore: checkpoint,
    runtimeInstanceId: options.instanceId ?? "scaling-fixture", resolveLiveProfileRuntimeInstanceIds: () => [options.instanceId ?? "scaling-fixture"],
    worktreeArchiveService: { archive } as never, threadTitleGenerationService: null });
  return { registry, counts, client, archive, claudeStore };
}

