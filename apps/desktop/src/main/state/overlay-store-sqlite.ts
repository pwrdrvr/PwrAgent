import type {
  AppServerBackendScope,
  AppServerThreadSummary,
  DirectoryLaunchpadOverlayState,
  DirectoryOverlayState,
  LinkedDirectorySummary,
  MarkThreadSeenResponse,
  MessagingThreadBindingSummary,
  NavigationDirectoryGitStatus,
  NavigationLaunchpadDefaults,
  NavigationSnapshot,
  PrSummary,
  ThreadExecutionMode,
  ThreadMessagingBindingTransition,
  ThreadOverlayState,
  ThreadPermissionTransition,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import {
  MAX_MESSAGING_BINDING_TRANSITION_LOG_ENTRIES,
  MAX_PERMISSION_TRANSITION_LOG_ENTRIES,
  buildThreadIdentityKey,
} from "@pwragent/shared";
import {
  buildNavigationSnapshot,
  buildNavigationSnapshotHash,
} from "@pwragent/agent-core";
import type { StateDb } from "./state-db.js";

export type DirectoryGitStatusCacheEntry = {
  directoryKey: string;
  directoryPath?: string;
  directoryUpdatedAt?: number;
  fetchedAt: number;
  gitStatus?: NavigationDirectoryGitStatus;
};

function parseDirectoryGitStatusCachePayload(
  payload: string | null,
): NavigationDirectoryGitStatus | undefined {
  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(payload) as NavigationDirectoryGitStatus;
  } catch {
    return undefined;
  }
}

export class SqliteOverlayStore {
  constructor(private readonly stateDb: StateDb) {}

  async reconcileNavigationSnapshot(params: {
    backend: AppServerBackendScope;
    fetchedAt: number;
    gitStatusByDirectoryKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
    /**
     * Active messaging bindings per thread, keyed by thread identity key.
     * Sourced from the desktop messaging sqlite store. Optional so tests
     * (and any future callers without messaging) can keep working.
     */
    messagingBindingsByThreadKey?: Record<
      string,
      MessagingThreadBindingSummary[] | undefined
    >;
    /**
     * In-memory permission-mode queue map keyed by `threadId`. The queue
     * lives on the registry (not in sqlite) but must be merged onto the
     * snapshot so renderers connecting after the queued bus event still
     * see the queued state. Also feeds the snapshot hash so changes
     * invalidate the cache.
     */
    queuedExecutionModesByThreadId?: Record<
      string,
      { mode: ThreadExecutionMode; queuedAt: number } | undefined
    >;
    threads: AppServerThreadSummary[];
    workspaceRoots?: string[];
  }): Promise<NavigationSnapshot> {
    const backendState = this.getBackend(params.backend);
    const firstSnapshot = !backendState?.lastSnapshotHash;

    if (firstSnapshot) {
      for (const thread of params.threads) {
        const threadKey = buildThreadIdentityKey(thread.source, thread.id);
        const current = this.getThread(threadKey);
        this.putThread(threadKey, {
          ...(current ?? {}),
          backend: thread.source,
          threadId: thread.id,
          executionMode: current?.executionMode ?? thread.executionMode ?? "default",
          model: current?.model ?? thread.model,
          reasoningEffort: current?.reasoningEffort ?? thread.reasoningEffort,
          serviceTier: current?.serviceTier ?? thread.serviceTier,
          fastMode: current?.fastMode ?? thread.fastMode,
          gitBranch: current?.gitBranch,
          observedGitBranch: current?.observedGitBranch,
          codexEnvironmentRuntime:
            current?.codexEnvironmentRuntime ?? thread.codexEnvironmentRuntime,
          retainedBranchDriftPairs: current?.retainedBranchDriftPairs,
          lastSeenAt: params.fetchedAt,
          lastSeenUpdatedAt: thread.updatedAt,
          extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
          worktreeSnapshots: current?.worktreeSnapshots ?? [],
          pinnedRank: current?.pinnedRank,
          permissionTransitionLog: current?.permissionTransitionLog,
          messagingBindingTransitionLog:
            current?.messagingBindingTransitionLog,
        });
      }
    }

    const overlayByThreadKey = Object.fromEntries(
      params.threads.map((thread) => {
        const threadKey = buildThreadIdentityKey(thread.source, thread.id);
        const overlay = this.getThread(threadKey);
        const queue = params.queuedExecutionModesByThreadId?.[thread.id];
        if (queue) {
          // Merge the in-memory queue onto the persisted overlay so
          // mid-restart / mid-connect renderers see the queued state
          // without needing a follow-up bus event.
          const merged: ThreadOverlayState = overlay
            ? {
                ...overlay,
                queuedExecutionMode: queue.mode,
                queuedExecutionModeAt: queue.queuedAt,
              }
            : {
                backend: thread.source,
                threadId: thread.id,
                executionMode: thread.executionMode ?? "default",
                extraLinkedDirectories: [],
                queuedExecutionMode: queue.mode,
                queuedExecutionModeAt: queue.queuedAt,
              };
          return [threadKey, merged];
        }
        return [threadKey, overlay];
      }),
    );

    const launchpadDefaults = this.readLaunchpadDefaults();
    const launchpadsByKey = this.readAllDirectoryLaunchpads();
    // Unit D (plan 2026-05-09-002): pull the directory pin overlay
    // map and pass it through so `buildDirectorySummaries` attaches
    // `pinnedRank` to each summary. Mirrors how `launchpadsByKey`
    // is loaded.
    const directoryOverlayByKey = this.readAllDirectoryOverlaysSync();

    const snapshot = buildNavigationSnapshot({
      backend: params.backend,
      fetchedAt: params.fetchedAt,
      firstSnapshot,
      gitStatusByDirectoryKey: params.gitStatusByDirectoryKey,
      launchpadDefaults,
      launchpadsByKey,
      directoryOverlayByKey,
      messagingBindingsByThreadKey: params.messagingBindingsByThreadKey,
      overlayByThreadKey,
      previousKnownThreadKeys: backendState?.knownThreadKeys ?? [],
      threads: params.threads,
      unchanged: false,
      workspaceRoots: params.workspaceRoots,
    });

    const nextHash = buildNavigationSnapshotHash({
      backend: params.backend,
      directories: snapshot.directories,
      launchpadDefaults: snapshot.launchpadDefaults,
      threads: snapshot.threads,
    });
    const unchanged = backendState?.lastSnapshotHash === nextHash;

    this.putBackend(params.backend, {
      knownThreadKeys: params.threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
      lastSnapshotHash: nextHash,
    });

    return { ...snapshot, unchanged };
  }

  async markThreadSeen(params: {
    backend: ThreadOverlayState["backend"];
    seenAt?: number;
    seenUpdatedAt?: number;
    threadId: string;
  }): Promise<MarkThreadSeenResponse> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey);
    const seenAt = params.seenAt ?? Date.now();

    this.putThread(threadKey, {
      ...(current ?? {}),
      backend: params.backend,
      threadId: params.threadId,
      executionMode: current?.executionMode ?? "default",
      lastSeenAt: seenAt,
      lastSeenUpdatedAt: params.seenUpdatedAt ?? current?.lastSeenUpdatedAt,
      extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      seenAt,
      seenUpdatedAt: params.seenUpdatedAt,
    };
  }

  async addLinkedDirectory(params: {
    backend: ThreadOverlayState["backend"];
    directory: LinkedDirectorySummary;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      extraLinkedDirectories: [
        ...current.extraLinkedDirectories.filter(
          (d) => d.id !== params.directory.id,
        ),
        params.directory,
      ],
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async replaceWorkspaceLinkedDirectory(params: {
    backend: ThreadOverlayState["backend"];
    directory: LinkedDirectorySummary;
    gitBranch?: string;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextDirectories = [
      ...current.extraLinkedDirectories.filter((directory) => {
        if (directory.id === params.directory.id) return false;
        if (isHandoffDirectory(directory)) return false;
        return directory.path !== params.directory.path;
      }),
      params.directory,
    ];
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: params.gitBranch ?? current.gitBranch,
      observedGitBranch: params.gitBranch ?? current.observedGitBranch,
      extraLinkedDirectories: nextDirectories,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async getThreadExecutionMode(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<ThreadExecutionMode> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    return this.getThread(threadKey)?.executionMode ?? "default";
  }

  async getThreadOverlayState(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<ThreadOverlayState | undefined> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    return this.getThread(threadKey);
  }

  async setThreadReaction(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    emoji: string;
    present: boolean;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const existing = current.reactions ?? [];
    const filtered = existing.filter((emoji) => emoji !== params.emoji);
    const nextReactions = params.present ? [...filtered, params.emoji] : filtered;
    const nextState: ThreadOverlayState = {
      ...current,
      reactions: nextReactions,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadPin(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    pinnedRank?: string | null;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const pinnedRank = params.pinnedRank?.trim();
    const nextState: ThreadOverlayState = {
      ...current,
      pinnedRank: pinnedRank || undefined,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async reorderThreadPins(params: {
    backend: ThreadOverlayState["backend"];
    threadIds: string[];
  }): Promise<Record<string, string>> {
    const pinnedRanks: Record<string, string> = {};
    const write = this.stateDb.raw.transaction(() => {
      params.threadIds.forEach((threadId, index) => {
        const threadKey = buildThreadIdentityKey(params.backend, threadId);
        const current = this.getThread(threadKey) ?? {
          backend: params.backend,
          threadId,
          executionMode: "default" as const,
          extraLinkedDirectories: [],
        };
        const pinnedRank = String((index + 1) * 1024);
        pinnedRanks[threadId] = pinnedRank;
        this.putThread(threadKey, {
          ...current,
          pinnedRank,
        });
      });
    });
    write();
    return pinnedRanks;
  }

  /**
   * Directory pin mutators — mirror of `setThreadPin` /
   * `reorderThreadPins` with the `backend` dimension dropped.
   * Directory keys are globally unique so pin order is global. The
   * IPC handler (`navigation:set-directory-pin`) is responsible for
   * rejecting non-directory keys (workspace / unlinked
   * pseudo-directories) before reaching this method — the store
   * itself is generic and will happily persist any string key.
   * See plan: 2026-05-09-002-feat-directory-pinning-plan.md Unit C.
   */
  async setDirectoryPin(params: {
    directoryKey: string;
    pinnedRank?: string | null;
  }): Promise<DirectoryOverlayState> {
    const pinnedRank = params.pinnedRank?.trim();
    const nextState: DirectoryOverlayState = {
      directoryKey: params.directoryKey,
      pinnedRank: pinnedRank || undefined,
    };
    this.putDirectoryOverlay(params.directoryKey, nextState);
    return nextState;
  }

  async reorderDirectoryPins(params: {
    directoryKeys: string[];
  }): Promise<Record<string, string>> {
    const pinnedRanks: Record<string, string> = {};
    const write = this.stateDb.raw.transaction(() => {
      params.directoryKeys.forEach((directoryKey, index) => {
        const pinnedRank = String((index + 1) * 1024);
        pinnedRanks[directoryKey] = pinnedRank;
        this.putDirectoryOverlay(directoryKey, {
          directoryKey,
          pinnedRank,
        });
      });
    });
    write();
    return pinnedRanks;
  }

  async getDirectoryOverlayState(params: {
    directoryKey: string;
  }): Promise<DirectoryOverlayState | undefined> {
    return this.getDirectoryOverlay(params.directoryKey);
  }

  async readAllDirectoryOverlays(): Promise<Record<string, DirectoryOverlayState>> {
    return this.readAllDirectoryOverlaysSync();
  }

  async setThreadPullRequests(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prs: PrSummary[];
    fetchedAt?: number;
    refreshKey?: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      prs: params.prs,
      prsFetchedAt: params.fetchedAt ?? Date.now(),
      prsRefreshKey: params.refreshKey,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async getThreadOverlayStates(params: {
    backend: ThreadOverlayState["backend"];
    threadIds: string[];
  }): Promise<Record<string, ThreadOverlayState | undefined>> {
    return Object.fromEntries(
      params.threadIds.map((threadId) => {
        const threadKey = buildThreadIdentityKey(params.backend, threadId);
        return [threadId, this.getThread(threadKey)];
      }),
    );
  }

  async upsertWorktreeSnapshot(params: {
    backend: ThreadOverlayState["backend"];
    snapshot: WorktreeSnapshotSummary;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextSnapshots = [
      ...(current.worktreeSnapshots ?? []).filter(
        (s) => s.id !== params.snapshot.id,
      ),
      params.snapshot,
    ].sort((a, b) => a.worktreePath.localeCompare(b.worktreePath));
    const nextState: ThreadOverlayState = {
      ...current,
      worktreeSnapshots: nextSnapshots,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadExecutionMode(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    executionMode: ThreadExecutionMode;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      executionMode: params.executionMode,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async appendPermissionTransition(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    transition: ThreadPermissionTransition;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextLog = [
      ...(current.permissionTransitionLog ?? []),
      params.transition,
    ];
    const trimmed =
      nextLog.length > MAX_PERMISSION_TRANSITION_LOG_ENTRIES
        ? nextLog.slice(nextLog.length - MAX_PERMISSION_TRANSITION_LOG_ENTRIES)
        : nextLog;
    const nextState: ThreadOverlayState = {
      ...current,
      permissionTransitionLog: trimmed,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async appendMessagingBindingTransition(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    transition: ThreadMessagingBindingTransition;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextLog = [
      ...(current.messagingBindingTransitionLog ?? []),
      params.transition,
    ];
    const trimmed =
      nextLog.length > MAX_MESSAGING_BINDING_TRANSITION_LOG_ENTRIES
        ? nextLog.slice(
            nextLog.length - MAX_MESSAGING_BINDING_TRANSITION_LOG_ENTRIES,
          )
        : nextLog;
    const nextState: ThreadOverlayState = {
      ...current,
      messagingBindingTransitionLog: trimmed,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadModelSettings(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    fastMode?: boolean;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      serviceTier: params.serviceTier,
      fastMode: params.fastMode,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadCodexEnvironmentRuntime(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    codexEnvironmentRuntime?: ThreadOverlayState["codexEnvironmentRuntime"];
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      codexEnvironmentRuntime: params.codexEnvironmentRuntime,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadExpectedBranch(params: {
    backend: ThreadOverlayState["backend"];
    branch: string;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: params.branch,
      observedGitBranch: params.branch,
      retainedBranchDriftPairs: (current.retainedBranchDriftPairs ?? []).filter(
        (pair) =>
          pair.expectedBranch !== params.branch &&
          pair.observedBranch !== params.branch,
      ),
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadObservedBranch(params: {
    backend: ThreadOverlayState["backend"];
    branch?: string;
    expectedBranch?: string;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const previousObservedBranch = current.observedGitBranch?.trim();
    const nextObservedBranch = params.branch?.trim();
    const fallbackExpectedBranch =
      !current.gitBranch?.trim() &&
      previousObservedBranch &&
      nextObservedBranch &&
      previousObservedBranch !== nextObservedBranch
        ? previousObservedBranch
        : undefined;
    const requestedExpectedBranch =
      params.expectedBranch?.trim() &&
      params.expectedBranch.trim() !== nextObservedBranch
        ? params.expectedBranch.trim()
        : undefined;
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: current.gitBranch?.trim()
        ? current.gitBranch
        : requestedExpectedBranch ?? fallbackExpectedBranch,
      observedGitBranch: params.branch,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async retainThreadBranchDrift(params: {
    backend: ThreadOverlayState["backend"];
    expectedBranch: string;
    observedBranch: string;
    retainedAt?: number;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const retainedBranchDriftPairs = [
      ...(current.retainedBranchDriftPairs ?? []).filter(
        (pair) =>
          pair.expectedBranch !== params.expectedBranch ||
          pair.observedBranch !== params.observedBranch,
      ),
      {
        expectedBranch: params.expectedBranch,
        observedBranch: params.observedBranch,
        retainedAt: params.retainedAt ?? Date.now(),
      },
    ];
    const nextState: ThreadOverlayState = { ...current, retainedBranchDriftPairs };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async getLaunchpadDefaults(): Promise<NavigationLaunchpadDefaults> {
    return this.readLaunchpadDefaults();
  }

  async setLaunchpadDefaults(
    patch: Partial<NavigationLaunchpadDefaults>,
  ): Promise<NavigationLaunchpadDefaults> {
    const current = this.readLaunchpadDefaults();
    const next = { ...current, ...patch };
    this.writeLaunchpadDefaults(next);
    return next;
  }

  async getDirectoryLaunchpad(params: {
    directoryKey: string;
  }): Promise<DirectoryLaunchpadOverlayState | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM directory_launchpads WHERE directory_path = ?")
      .get(params.directoryKey) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  async listDirectoryLaunchpads(): Promise<DirectoryLaunchpadOverlayState[]> {
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM directory_launchpads")
      .all() as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload));
  }

  async upsertDirectoryLaunchpad(
    launchpad: DirectoryLaunchpadOverlayState,
  ): Promise<DirectoryLaunchpadOverlayState> {
    const current = await this.getDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
    });
    const next: DirectoryLaunchpadOverlayState = {
      ...current,
      ...launchpad,
      createdAt: current?.createdAt ?? launchpad.createdAt,
    };
    const now = Date.now();
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO directory_launchpads(directory_path, payload, created_at, updated_at, settings_touched_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        next.directoryKey,
        JSON.stringify(next),
        next.createdAt ?? now,
        next.updatedAt ?? now,
        next.settingsTouchedAt ?? null,
      );
    return next;
  }

  async resetDirectoryLaunchpad(params: { directoryKey: string }): Promise<void> {
    this.stateDb.raw
      .prepare("DELETE FROM directory_launchpads WHERE directory_path = ?")
      .run(params.directoryKey);
  }

  async readDirectoryGitStatusCache(): Promise<
    Record<string, DirectoryGitStatusCacheEntry>
  > {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT directory_key, directory_path, directory_updated_at, fetched_at, payload
         FROM directory_git_status`,
      )
      .all() as Array<{
        directory_key: string;
        directory_path: string | null;
        directory_updated_at: number | null;
        fetched_at: number;
        payload: string | null;
      }>;

    return Object.fromEntries(
      rows.map((row) => {
        const gitStatus = parseDirectoryGitStatusCachePayload(row.payload);
        const entry: DirectoryGitStatusCacheEntry = {
          directoryKey: row.directory_key,
          ...(row.directory_path ? { directoryPath: row.directory_path } : {}),
          ...(row.directory_updated_at !== null
            ? { directoryUpdatedAt: row.directory_updated_at }
            : {}),
          fetchedAt: row.fetched_at,
          ...(gitStatus ? { gitStatus } : {}),
        };
        return [entry.directoryKey, entry];
      }),
    );
  }

  async writeDirectoryGitStatusCacheEntry(
    entry: DirectoryGitStatusCacheEntry,
  ): Promise<void> {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO directory_git_status(
           directory_key,
           directory_path,
           directory_updated_at,
           fetched_at,
           payload
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.directoryKey,
        entry.directoryPath ?? null,
        entry.directoryUpdatedAt ?? null,
        entry.fetchedAt,
        entry.gitStatus ? JSON.stringify(entry.gitStatus) : null,
      );
  }

  private getThread(threadKey: string): ThreadOverlayState | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM threads WHERE thread_id = ?")
      .get(threadKey) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  /**
   * Returns every thread overlay whose JSON payload mentions
   * `codexEnvironmentRuntime`. The substring filter is done in SQL so a
   * large `threads` table with mostly non-Codex rows doesn't pay the
   * JSON.parse cost. Used by the startup cleanup pass that normalises
   * prior-session env-action state.
   */
  async listThreadOverlaysWithCodexEnvironmentRuntime(): Promise<
    ThreadOverlayState[]
  > {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT payload FROM threads WHERE payload LIKE '%"codexEnvironmentRuntime"%'`,
      )
      .all() as Array<{ payload: string }>;
    const results: ThreadOverlayState[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as ThreadOverlayState;
        if (parsed.codexEnvironmentRuntime) {
          results.push(parsed);
        }
      } catch {
        // Defensive: skip malformed rows rather than abort the whole scan.
      }
    }
    return results;
  }

  private putThread(threadKey: string, state: ThreadOverlayState): void {
    // Queue-only fields are registry-memory state; never persist them.
    // They reset to undefined on app restart by design.
    const {
      queuedExecutionMode: _queuedExecutionMode,
      queuedExecutionModeAt: _queuedExecutionModeAt,
      ...persistable
    } = state;
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadKey,
        (persistable as Record<string, unknown>).directoryPath as string ?? null,
        persistable.lastSeenAt ?? null,
        persistable.dismissedAt ?? null,
        persistable.snoozedUntil ?? null,
        JSON.stringify(persistable),
      );
  }

  private getBackend(
    scope: string,
  ): { knownThreadKeys: string[]; lastSnapshotHash?: string } | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM backends WHERE scope = ?")
      .get(scope) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  private putBackend(
    scope: string,
    state: { knownThreadKeys: string[]; lastSnapshotHash?: string },
  ): void {
    this.stateDb.raw
      .prepare("INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)")
      .run(scope, JSON.stringify(state));
  }

  private readLaunchpadDefaults(): NavigationLaunchpadDefaults {
    const defaults: Record<string, unknown> = {};
    const rows = this.stateDb.raw
      .prepare("SELECT key, value FROM launchpad_defaults")
      .all() as { key: string; value: string }[];
    for (const row of rows) {
      defaults[row.key] = JSON.parse(row.value);
    }
    return (
      Object.keys(defaults).length > 0
        ? defaults
        : { backend: "codex", executionMode: "default" }
    ) as NavigationLaunchpadDefaults;
  }

  private writeLaunchpadDefaults(defaults: NavigationLaunchpadDefaults): void {
    const stmt = this.stateDb.raw.prepare(
      "INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)",
    );
    const write = this.stateDb.raw.transaction(() => {
      for (const [key, value] of Object.entries(defaults)) {
        if (value !== undefined) {
          stmt.run(key, JSON.stringify(value));
        }
      }
    });
    write();
  }

  private readAllDirectoryLaunchpads(): Record<string, DirectoryLaunchpadOverlayState> {
    const rows = this.stateDb.raw
      .prepare("SELECT directory_path, payload FROM directory_launchpads")
      .all() as { directory_path: string; payload: string }[];
    return Object.fromEntries(
      rows.map((r) => [r.directory_path, JSON.parse(r.payload)]),
    );
  }

  /**
   * Directory pin persistence helpers (Unit B). Mirror `getThread` /
   * `putThread` / `readAllDirectoryLaunchpads`: a single JSON
   * `payload` column keyed by `directory_key`, INSERT OR REPLACE on
   * write. The `directoryKey` is duplicated inside the payload so
   * `readAllDirectoryOverlays` can return a self-contained
   * `DirectoryOverlayState` without re-deriving the key.
   */
  private getDirectoryOverlay(directoryKey: string): DirectoryOverlayState | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM directory_overlay WHERE directory_key = ?")
      .get(directoryKey) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as DirectoryOverlayState) : undefined;
  }

  private putDirectoryOverlay(
    directoryKey: string,
    state: DirectoryOverlayState,
  ): void {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO directory_overlay(directory_key, payload)
         VALUES (?, ?)`,
      )
      .run(directoryKey, JSON.stringify(state));
  }

  private readAllDirectoryOverlaysSync(): Record<string, DirectoryOverlayState> {
    const rows = this.stateDb.raw
      .prepare("SELECT directory_key, payload FROM directory_overlay")
      .all() as { directory_key: string; payload: string }[];
    return Object.fromEntries(
      rows.map((r) => [r.directory_key, JSON.parse(r.payload) as DirectoryOverlayState]),
    );
  }
}

/** Check whether a linked directory was created by the handoff service. */
function isHandoffDirectory(directory: LinkedDirectorySummary): boolean {
  return (
    directory.id.startsWith("pwragent-handoff:") ||
    directory.id.startsWith("pwragnt-handoff:")  // legacy prefix from pre-rebrand data
  );
}

export type OverlayStoreLike = Pick<
  SqliteOverlayStore,
  | "reconcileNavigationSnapshot"
  | "markThreadSeen"
  | "addLinkedDirectory"
  | "replaceWorkspaceLinkedDirectory"
  | "getThreadExecutionMode"
  | "getThreadOverlayState"
  | "getThreadOverlayStates"
  | "setThreadReaction"
  | "setThreadPin"
  | "reorderThreadPins"
  | "setDirectoryPin"
  | "reorderDirectoryPins"
  | "getDirectoryOverlayState"
  | "readAllDirectoryOverlays"
  | "setThreadPullRequests"
  | "upsertWorktreeSnapshot"
  | "setThreadExecutionMode"
  | "setThreadModelSettings"
  | "setThreadExpectedBranch"
  | "setThreadObservedBranch"
  | "retainThreadBranchDrift"
  | "appendPermissionTransition"
  | "appendMessagingBindingTransition"
  | "getLaunchpadDefaults"
  | "setLaunchpadDefaults"
  | "getDirectoryLaunchpad"
  | "listDirectoryLaunchpads"
  | "upsertDirectoryLaunchpad"
  | "resetDirectoryLaunchpad"
> & {
  setThreadCodexEnvironmentRuntime?: SqliteOverlayStore["setThreadCodexEnvironmentRuntime"];
  listThreadOverlaysWithCodexEnvironmentRuntime?: SqliteOverlayStore["listThreadOverlaysWithCodexEnvironmentRuntime"];
};
