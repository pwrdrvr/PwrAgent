import type {
  AppServerBackendScope,
  AppServerThreadSummary,
  AutomationThreadSummary,
  DirectoryLaunchpadOverlayState,
  DirectoryOverlayState,
  LinkedDirectorySummary,
  MarkThreadSeenResponse,
  MessagingThreadBindingSummary,
  NavigationBrowseMode,
  NavigationDirectoryGitStatus,
  NavigationLaunchpadDefaults,
  NavigationSnapshot,
  PrSummary,
  ThreadExecutionMode,
  ThreadMessagingBindingTransition,
  ThreadOverlayState,
  ThreadPermissionTransition,
  ThreadSubAgentSummary,
  ThreadTurnFailure,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import {
  DEFAULT_PULL_REQUEST_PROVIDER,
  AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
  MAX_MESSAGING_BINDING_TRANSITION_LOG_ENTRIES,
  MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES,
  MAX_PERMISSION_TRANSITION_LOG_ENTRIES,
  MAX_TURN_FAILURE_LOG_ENTRIES,
  buildThreadIdentityKey,
  applyNavigationLaunchpadProviderSettingsPatch,
  parseThreadIdentityKey,
  projectNavigationLaunchpadProviderSettings,
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

export type PrStatusCacheEntry = {
  prKey: string;
  provider: string;
  fetchedAt: number;
  pr: PrSummary;
};

export type PrLookupCacheEntry = {
  lookupKey: string;
  provider: string;
  branch: string;
  directoryPaths: string[];
  fetchedAt: number;
  prs: PrSummary[];
};

function normalizePullRequestProvider(provider: string | undefined): string {
  return (provider ?? DEFAULT_PULL_REQUEST_PROVIDER).trim().toLowerCase()
    || DEFAULT_PULL_REQUEST_PROVIDER;
}

function normalizePrSummary(pr: PrSummary): PrSummary {
  const checkState = normalizePrCheckState(pr.checkState ?? pr.state);
  return {
    ...pr,
    provider: normalizePullRequestProvider(pr.provider),
    state: checkState,
    checkState,
    lifecycleState: pr.lifecycleState ?? legacyPrLifecycleState(pr.state),
    reviewState: pr.reviewState ?? legacyPrReviewState(pr.state),
    mergeState: pr.mergeState ?? "unknown",
  };
}

function normalizePrCheckState(
  state: string | undefined,
): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

function legacyPrLifecycleState(state: string | undefined): PrSummary["lifecycleState"] {
  if (state === "merged" || state === "closed") {
    return state;
  }
  return "open";
}

function legacyPrReviewState(state: string | undefined): PrSummary["reviewState"] {
  return state === "draft" ? "draft" : "ready_for_review";
}

function getPrStatusCacheKey(pr: PrSummary): string {
  return `${normalizePullRequestProvider(pr.provider)}/${pr.org.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;
}

function getPrLookupCacheKey(entry: {
  provider: string;
  branch: string;
  directoryPaths: string[];
}): string {
  return JSON.stringify({
    lookupVersion: 2,
    provider: normalizePullRequestProvider(entry.provider),
    branch: entry.branch.trim(),
    directoryPaths: [...new Set(entry.directoryPaths.map((path) => path.trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right)),
  });
}

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

function normalizeLaunchpadDefaults(
  defaults: NavigationLaunchpadDefaults,
): NavigationLaunchpadDefaults {
  const next: NavigationLaunchpadDefaults =
    projectNavigationLaunchpadProviderSettings(defaults);
  if (
    next.backend === "codex" &&
    (next.serviceTier === "fast" || next.serviceTier === "priority")
  ) {
    delete next.serviceTier;
  }
  return next;
}

const NAVIGATION_BROWSE_MODE_META_KEY = "navigation_browse_mode";
const DEFAULT_NAVIGATION_BROWSE_MODE: NavigationBrowseMode = "inbox";

export function normalizeNavigationBrowseMode(
  value: unknown,
): NavigationBrowseMode {
  return value === "inbox" || value === "recents" || value === "directories"
    ? value
    : DEFAULT_NAVIGATION_BROWSE_MODE;
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
    automationsByThreadKey?: Record<string, AutomationThreadSummary | undefined>;
    /**
     * In-memory permission-mode queue map keyed by thread identity. The queue
     * lives on the registry (not in sqlite) but must be merged onto the
     * snapshot so renderers connecting after the queued bus event still
     * see the queued state. Also feeds the snapshot hash so changes
     * invalidate the cache.
     */
    queuedExecutionModesByThreadKey?: Record<
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
          agent: current?.agent,
          gitBranch: current?.gitBranch,
          observedGitBranch: current?.observedGitBranch,
          codexEnvironmentRuntime:
            current?.codexEnvironmentRuntime ?? thread.codexEnvironmentRuntime,
          retainedBranchDriftPairs: current?.retainedBranchDriftPairs,
          immutableUsageActivities: current?.immutableUsageActivities,
          subAgents: current?.subAgents,
          lastSeenAt: params.fetchedAt,
          lastSeenUpdatedAt: thread.updatedAt,
          extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
          worktreeSnapshots: current?.worktreeSnapshots ?? [],
          pinnedRank: current?.pinnedRank,
          parentThreadId: current?.parentThreadId,
          subthreadOrder: current?.subthreadOrder,
          subthreadsCollapsed: current?.subthreadsCollapsed,
          permissionTransitionLog: current?.permissionTransitionLog,
          messagingBindingTransitionLog:
            current?.messagingBindingTransitionLog,
          turnFailureLog: current?.turnFailureLog,
        });
      }
    }

    const overlayByThreadKey = Object.fromEntries(
      params.threads.map((thread) => {
        const threadKey = buildThreadIdentityKey(thread.source, thread.id);
        const overlay = this.getThread(threadKey);
        const queue = params.queuedExecutionModesByThreadKey?.[threadKey];
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
      automationsByThreadKey: params.automationsByThreadKey,
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

  /**
   * Persist the immutable repository resolution for an ACP worktree thread.
   * The mapping from a tool-managed worktree cwd to its parent repository is
   * derived once (by following the worktree's `.git` link — no git process)
   * and stored here so later thread-list reads reuse it instead of re-touching
   * the filesystem. `cwd` is retained so a session rebind to a different
   * workspace invalidates the cache. See `acpWorktreeDirectory` on
   * `ThreadOverlayState`.
   */
  async setAcpWorktreeDirectory(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    cwd: string;
    directory: LinkedDirectorySummary;
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
      acpWorktreeDirectory: { cwd: params.cwd, directory: params.directory },
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async persistThreadUsageActivity(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    activity: NonNullable<ThreadOverlayState["immutableUsageActivities"]>[number];
  }): Promise<{ overlay: ThreadOverlayState; persisted: boolean }> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    if (
      !params.activity.id.startsWith("live-turn-usage-") &&
      !params.activity.summary.startsWith("Turn usage:") &&
      !params.activity.summary.startsWith("Monitor usage:")
    ) {
      return { overlay: current, persisted: false };
    }

    const existingActivities = current.immutableUsageActivities ?? [];
    if (existingActivities.some((activity) => activity.id === params.activity.id)) {
      return { overlay: current, persisted: false };
    }

    const nextState: ThreadOverlayState = {
      ...current,
      immutableUsageActivities: [
        ...existingActivities,
        params.activity,
      ].slice(-MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES),
    };
    this.putThread(threadKey, nextState);
    return { overlay: nextState, persisted: true };
  }

  async upsertThreadSubAgent(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    subAgent: ThreadSubAgentSummary;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextSubAgents = [
      params.subAgent,
      ...(current.subAgents ?? []).filter(
        (subAgent) => subAgent.monitorId !== params.subAgent.monitorId,
      ),
    ].sort((left, right) => right.createdAt - left.createdAt);
    const nextState: ThreadOverlayState = {
      ...current,
      subAgents: nextSubAgents,
    };
    this.putThread(threadKey, nextState);
    return nextState;
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

  async setThreadAgent(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    agent: { name: string; instructions?: string } | null;
    now?: number;
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
      agent: params.agent ? normalizeThreadAgent(params.agent, params.now) : undefined,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  /**
   * Reorder pinned threads globally across backends. `threadKeys` is the
   * complete pinned order (thread identity keys); ranks are assigned by global
   * index so Codex and ACP pins interleave in any order. Unparseable keys are
   * skipped without consuming a rank.
   */
  async reorderThreadPins(params: {
    threadKeys: string[];
  }): Promise<Record<string, string>> {
    const pinnedRanks: Record<string, string> = {};
    const write = this.stateDb.raw.transaction(() => {
      let rankIndex = 0;
      for (const threadKey of params.threadKeys) {
        const parts = parseThreadIdentityKey(threadKey);
        if (!parts) {
          continue;
        }
        const current = this.getThread(threadKey) ?? {
          backend: parts.backend,
          threadId: parts.threadId,
          executionMode: "default" as const,
          extraLinkedDirectories: [],
        };
        rankIndex += 1;
        const pinnedRank = String(rankIndex * 1024);
        pinnedRanks[threadKey] = pinnedRank;
        this.putThread(threadKey, {
          ...current,
          pinnedRank,
        });
      }
    });
    write();
    return pinnedRanks;
  }

  async setThreadParent(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    parentThreadId?: string | null;
  }): Promise<ThreadOverlayState> {
    if (params.parentThreadId === params.threadId) {
      throw new Error("A thread cannot be its own parent.");
    }
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const parentThreadId = params.parentThreadId?.trim();
    const nextState: ThreadOverlayState = {
      ...current,
      parentThreadId: parentThreadId || undefined,
      pinnedRank: parentThreadId ? undefined : current.pinnedRank,
    };
    this.putThread(threadKey, nextState);
    if (parentThreadId) {
      const parentKey = buildThreadIdentityKey(params.backend, parentThreadId);
      const parent = this.getThread(parentKey) ?? {
        backend: params.backend,
        threadId: parentThreadId,
        executionMode: "default" as const,
        extraLinkedDirectories: [],
      };
      this.putThread(parentKey, {
        ...parent,
        subthreadOrder: [
          ...(parent.subthreadOrder ?? []).filter((id) => id !== params.threadId),
          params.threadId,
        ],
      });
    }
    return nextState;
  }

  async updateSubthreadOrder(params: {
    backend: ThreadOverlayState["backend"];
    parentThreadId: string;
    threadIds: string[];
  }): Promise<string[]> {
    const parentKey = buildThreadIdentityKey(params.backend, params.parentThreadId);
    const parent = this.getThread(parentKey) ?? {
      backend: params.backend,
      threadId: params.parentThreadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const seen = new Set<string>();
    const threadIds = params.threadIds.filter((threadId) => {
      if (seen.has(threadId)) return false;
      seen.add(threadId);
      return threadId !== params.parentThreadId;
    });
    this.putThread(parentKey, {
      ...parent,
      subthreadOrder: threadIds,
    });
    return threadIds;
  }

  async setSubthreadsCollapsed(params: {
    backend: ThreadOverlayState["backend"];
    parentThreadId: string;
    collapsed: boolean;
  }): Promise<ThreadOverlayState> {
    const parentKey = buildThreadIdentityKey(params.backend, params.parentThreadId);
    const parent = this.getThread(parentKey) ?? {
      backend: params.backend,
      threadId: params.parentThreadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextState: ThreadOverlayState = {
      ...parent,
      subthreadsCollapsed: params.collapsed,
    };
    this.putThread(parentKey, nextState);
    return nextState;
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
      prs: params.prs.map(normalizePrSummary),
      prsFetchedAt: params.fetchedAt ?? Date.now(),
      prsRefreshKey: params.refreshKey,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async readPrStatusCache(): Promise<Record<string, PrStatusCacheEntry>> {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT pr_key, provider, fetched_at, payload
         FROM pr_status_cache`,
      )
      .all() as Array<{
        pr_key: string;
        provider: string | null;
        fetched_at: number;
        payload: string;
      }>;

    const entries: Record<string, PrStatusCacheEntry> = {};
    for (const row of rows) {
      try {
        const provider = normalizePullRequestProvider(row.provider ?? undefined);
        const pr = normalizePrSummary({
          ...(JSON.parse(row.payload) as PrSummary),
          provider,
        });
        const prKey = getPrStatusCacheKey(pr);
        entries[prKey] = {
          prKey,
          provider,
          fetchedAt: row.fetched_at,
          pr,
        };
      } catch {
        // Ignore malformed cache rows. A future refresh rewrites the row.
      }
    }
    return entries;
  }

  async writePrStatusCacheEntries(entries: PrStatusCacheEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const insert = this.stateDb.raw.prepare(
      `INSERT OR REPLACE INTO pr_status_cache(
         pr_key,
         provider,
         org,
         repo,
         number,
         fetched_at,
         payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = this.stateDb.raw.transaction(() => {
      for (const entry of entries) {
        insert.run(
          entry.prKey,
          normalizePullRequestProvider(entry.provider),
          entry.pr.org,
          entry.pr.repo,
          entry.pr.number,
          entry.fetchedAt,
          JSON.stringify(normalizePrSummary(entry.pr)),
        );
      }
    });
    write();
  }

  async readPrLookupCache(): Promise<Record<string, PrLookupCacheEntry>> {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT lookup_key, provider, branch, directory_paths, fetched_at, payload
         FROM pr_lookup_cache`,
      )
      .all() as Array<{
        lookup_key: string;
        provider: string | null;
        branch: string;
        directory_paths: string;
        fetched_at: number;
        payload: string;
      }>;

    const entries: Record<string, PrLookupCacheEntry> = {};
    for (const row of rows) {
      try {
        const provider = normalizePullRequestProvider(row.provider ?? undefined);
        const directoryPaths = JSON.parse(row.directory_paths) as string[];
        const lookupKey = getPrLookupCacheKey({
          provider,
          branch: row.branch,
          directoryPaths,
        });
        entries[lookupKey] = {
          lookupKey,
          provider,
          branch: row.branch,
          directoryPaths,
          fetchedAt: row.fetched_at,
          prs: (JSON.parse(row.payload) as PrSummary[]).map((pr) =>
            normalizePrSummary({ ...pr, provider: pr.provider ?? provider }),
          ),
        };
      } catch {
        // Ignore malformed cache rows. A future refresh rewrites the row.
      }
    }
    return entries;
  }

  async writePrLookupCacheEntry(entry: PrLookupCacheEntry): Promise<void> {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO pr_lookup_cache(
           lookup_key,
           provider,
           branch,
           directory_paths,
           fetched_at,
           payload
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.lookupKey,
        normalizePullRequestProvider(entry.provider),
        entry.branch,
        JSON.stringify(entry.directoryPaths),
        entry.fetchedAt,
        JSON.stringify(entry.prs.map(normalizePrSummary)),
      );
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

  async appendTurnFailure(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    failure: ThreadTurnFailure;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    // Dedupe by turnId: a turn fails once, but `turn/failed` can be
    // re-observed (reconnect / replay). Keep the first-seen entry so the
    // transcript marker's timestamp stays anchored to where it happened.
    if (
      (current.turnFailureLog ?? []).some(
        (entry) => entry.turnId === params.failure.turnId,
      )
    ) {
      return current;
    }
    const nextLog = [...(current.turnFailureLog ?? []), params.failure];
    const trimmed =
      nextLog.length > MAX_TURN_FAILURE_LOG_ENTRIES
        ? nextLog.slice(nextLog.length - MAX_TURN_FAILURE_LOG_ENTRIES)
        : nextLog;
    const nextState: ThreadOverlayState = {
      ...current,
      turnFailureLog: trimmed,
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
    const next = normalizeLaunchpadDefaults(
      applyNavigationLaunchpadProviderSettingsPatch(current, patch),
    );
    this.writeLaunchpadDefaults(next);
    return next;
  }

  getNavigationBrowseModeSync(): NavigationBrowseMode {
    return normalizeNavigationBrowseMode(
      this.stateDb.getMeta(NAVIGATION_BROWSE_MODE_META_KEY),
    );
  }

  async getNavigationBrowseMode(): Promise<NavigationBrowseMode> {
    return this.getNavigationBrowseModeSync();
  }

  async setNavigationBrowseMode(
    browseMode: NavigationBrowseMode,
  ): Promise<NavigationBrowseMode> {
    const normalized = normalizeNavigationBrowseMode(browseMode);
    this.stateDb.setMeta(NAVIGATION_BROWSE_MODE_META_KEY, normalized);
    return normalized;
  }

  async getDirectoryLaunchpad(params: {
    directoryKey: string;
  }): Promise<DirectoryLaunchpadOverlayState | undefined> {
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM directory_launchpads WHERE directory_path = ?")
      .get(params.directoryKey) as { payload: string } | undefined;
    return row
      ? projectNavigationLaunchpadProviderSettings(
          JSON.parse(row.payload) as DirectoryLaunchpadOverlayState,
        )
      : undefined;
  }

  async listDirectoryLaunchpads(): Promise<DirectoryLaunchpadOverlayState[]> {
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM directory_launchpads")
      .all() as { payload: string }[];
    return rows.map((r) =>
      projectNavigationLaunchpadProviderSettings(
        JSON.parse(r.payload) as DirectoryLaunchpadOverlayState,
      ),
    );
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
    const parsed = (
      Object.keys(defaults).length > 0
        ? defaults
        : { backend: "codex", executionMode: "default" }
    ) as NavigationLaunchpadDefaults;
    const normalized = normalizeLaunchpadDefaults(parsed);
    if (
      parsed.backend === "codex" &&
      (parsed.serviceTier === "fast" || parsed.serviceTier === "priority")
    ) {
      this.writeLaunchpadDefaults(normalized);
    }
    return normalized;
  }

  private writeLaunchpadDefaults(defaults: NavigationLaunchpadDefaults): void {
    const normalizedDefaults = normalizeLaunchpadDefaults(defaults);
    const deleteStmt = this.stateDb.raw.prepare("DELETE FROM launchpad_defaults");
    const insertStmt = this.stateDb.raw.prepare(
      "INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)",
    );
    const write = this.stateDb.raw.transaction(() => {
      deleteStmt.run();
      for (const [key, value] of Object.entries(normalizedDefaults)) {
        if (value !== undefined) {
          insertStmt.run(key, JSON.stringify(value));
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
      rows.map((r) => [
        r.directory_path,
        projectNavigationLaunchpadProviderSettings(
          JSON.parse(r.payload) as DirectoryLaunchpadOverlayState,
        ),
      ]),
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

function normalizeThreadAgent(
  input: { name: string; instructions?: string },
  now = Date.now(),
): NonNullable<ThreadOverlayState["agent"]> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Agent thread name is required.");
  }
  const instructions = input.instructions?.trim();
  const instructionLineCount = instructions ? instructions.split(/\r?\n/).length : 0;
  return {
    name,
    instructions: instructions || undefined,
    instructionLineCount,
    instructionsTooLong:
      instructionLineCount > AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
    updatedAt: now,
  };
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
  | "setAcpWorktreeDirectory"
  | "persistThreadUsageActivity"
  | "upsertThreadSubAgent"
  | "setThreadReaction"
  | "setThreadPin"
  | "setThreadParent"
  | "setThreadAgent"
  | "reorderThreadPins"
  | "updateSubthreadOrder"
  | "setSubthreadsCollapsed"
  | "setDirectoryPin"
  | "reorderDirectoryPins"
  | "getDirectoryOverlayState"
  | "readAllDirectoryOverlays"
  | "setThreadPullRequests"
  | "readPrStatusCache"
  | "writePrStatusCacheEntries"
  | "readPrLookupCache"
  | "writePrLookupCacheEntry"
  | "upsertWorktreeSnapshot"
  | "setThreadExecutionMode"
  | "setThreadModelSettings"
  | "setThreadExpectedBranch"
  | "setThreadObservedBranch"
  | "retainThreadBranchDrift"
  | "appendPermissionTransition"
  | "appendMessagingBindingTransition"
  | "appendTurnFailure"
  | "getLaunchpadDefaults"
  | "setLaunchpadDefaults"
  | "getNavigationBrowseMode"
  | "setNavigationBrowseMode"
  | "getDirectoryLaunchpad"
  | "listDirectoryLaunchpads"
  | "upsertDirectoryLaunchpad"
  | "resetDirectoryLaunchpad"
> & {
  setThreadCodexEnvironmentRuntime?: SqliteOverlayStore["setThreadCodexEnvironmentRuntime"];
  listThreadOverlaysWithCodexEnvironmentRuntime?: SqliteOverlayStore["listThreadOverlaysWithCodexEnvironmentRuntime"];
};
