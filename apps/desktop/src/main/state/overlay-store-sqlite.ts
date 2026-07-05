import path from "node:path";
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
  ThreadGitWorkingState,
  ThreadMessagingBindingTransition,
  ThreadOverlayState,
  ThreadPermissionTransition,
  ThreadPricingSummary,
  ThreadSubAgentSummary,
  ThreadTurnFailure,
  ThreadUsageLineRecord,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import {
  DEFAULT_PULL_REQUEST_PROVIDER,
  AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
  MAX_MESSAGING_BINDING_TRANSITION_LOG_ENTRIES,
  MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES,
  MAX_PERMISSION_TRANSITION_LOG_ENTRIES,
  MAX_TURN_FAILURE_LOG_ENTRIES,
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  applyNavigationLaunchpadProviderSettingsPatch,
  estimateOpenAiTokenUsageCost,
  parseThreadIdentityKey,
  projectNavigationLaunchpadProviderSettings,
  resolveOpenAiPricingServiceTier,
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

export type WorktreeGitWorkingStateCacheEntry = {
  worktreePath: string;
  fetchedAt: number;
  gitWorkingState?: ThreadGitWorkingState;
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
    commitShas: normalizeCommitShas(pr.commitShas),
  };
}

function normalizeDetachedPrKeys(keys: string[] | undefined): string[] {
  return [
    ...new Set(
      (keys ?? [])
        .map((key) => key.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function filterDetachedPrs(prs: PrSummary[], detachedPrKeys: string[]): PrSummary[] {
  if (detachedPrKeys.length === 0) {
    return prs;
  }
  const detached = new Set(detachedPrKeys);
  return prs.filter((pr) => !detached.has(buildPullRequestStatusKey(pr)));
}

function collectDetachedPrs(
  prs: PrSummary[],
  detachedPrKeys: string[],
): PrSummary[] {
  if (detachedPrKeys.length === 0) {
    return [];
  }
  const detached = new Set(detachedPrKeys);
  return prs.filter((pr) => detached.has(buildPullRequestStatusKey(pr)));
}

function mergePrSummariesByStatusKey(
  existingPrs: PrSummary[] | undefined,
  nextPrs: PrSummary[],
): PrSummary[] | undefined {
  const byKey = new Map<string, PrSummary>();
  for (const pr of existingPrs ?? []) {
    const normalized = normalizePrSummary(pr);
    byKey.set(buildPullRequestStatusKey(normalized), normalized);
  }
  for (const pr of nextPrs) {
    const normalized = normalizePrSummary(pr);
    byKey.set(buildPullRequestStatusKey(normalized), normalized);
  }
  const merged = [...byKey.values()].sort((left, right) =>
    buildPullRequestStatusKey(left).localeCompare(buildPullRequestStatusKey(right)),
  );
  return merged.length > 0 ? merged : undefined;
}

function normalizeCommitShas(commitShas: string[] | undefined): string[] | undefined {
  const normalized = [
    ...new Set(
      (commitShas ?? [])
        .map((sha) => sha.trim().toLowerCase())
        .filter((sha) => /^[0-9a-f]{40}$/.test(sha)),
    ),
  ].sort();
  return normalized.length > 0 ? normalized : undefined;
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

function parseThreadGitWorkingStatePayload(
  payload: string | null,
): ThreadGitWorkingState | undefined {
  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(payload) as ThreadGitWorkingState;
  } catch {
    return undefined;
  }
}

function normalizeLaunchpadDefaults(
  defaults: NavigationLaunchpadDefaults,
): NavigationLaunchpadDefaults {
  const next: NavigationLaunchpadDefaults =
    projectNavigationLaunchpadProviderSettings(defaults);
  const providerSettings = next.providerSettings
    ? { ...next.providerSettings }
    : undefined;
  const codexProviderSettings = providerSettings?.codex
    ? { ...providerSettings.codex }
    : undefined;

  if (codexProviderSettings) {
    if (
      codexProviderSettings.serviceTier === "fast" ||
      codexProviderSettings.serviceTier === "priority"
    ) {
      delete codexProviderSettings.serviceTier;
    }
    if (codexProviderSettings.fastMode === false) {
      delete codexProviderSettings.fastMode;
    }
    if (Object.keys(codexProviderSettings).length > 0) {
      providerSettings!.codex = codexProviderSettings;
    } else {
      delete providerSettings!.codex;
    }
  }

  if (providerSettings && Object.keys(providerSettings).length > 0) {
    next.providerSettings = providerSettings;
  } else {
    delete next.providerSettings;
  }

  if (
    next.backend === "codex" &&
    (next.serviceTier === "fast" || next.serviceTier === "priority")
  ) {
    delete next.serviceTier;
  }
  if (next.backend === "codex" && next.fastMode === false) {
    delete next.fastMode;
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
          handoffOrigin: current?.handoffOrigin,
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
          (directory) => !linkedDirectoriesEquivalent(directory, params.directory),
        ),
        params.directory,
      ],
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async removeLinkedDirectory(params: {
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
      extraLinkedDirectories: current.extraLinkedDirectories.filter(
        (directory) => !linkedDirectoriesEquivalent(directory, params.directory),
      ),
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

  async upsertThreadUsageLine(params: {
    line: ThreadUsageLineRecord;
  }): Promise<{ line: ThreadUsageLineRecord; summary: ThreadPricingSummary }> {
    const now = Date.now();
    let line = repriceOpenAiUsageLine(normalizeThreadUsageLine(params.line, now));
    const upsert = this.stateDb.raw.transaction(() => {
      const existing = this.readThreadUsageLineSync(line.usageLineId);
      if (existing) {
        line = mergeThreadUsageLineForUpsert(line, existing);
      }
      if (
        (line.source === "hydration" || line.source === "backfill") &&
        line.turnId
      ) {
        this.stateDb.raw
          .prepare(
            `UPDATE thread_usage_lines
             SET status = 'superseded', updated_at = ?
             WHERE provider = ?
               AND backend = ?
               AND thread_id = ?
               AND turn_id = ?
               AND source = 'live'
               AND usage_line_id != ?`,
          )
          .run(
            now,
            line.provider,
            line.backend,
            line.threadId,
            line.turnId,
            line.usageLineId,
          );
      }
      this.stateDb.raw
        .prepare(
          `INSERT INTO thread_usage_turns (
            usage_turn_id,
            provider,
            backend,
            thread_id,
            parent_thread_id,
            turn_id,
            model,
            reasoning_effort,
            service_tier,
            fast_mode,
            settings_source,
            settings_confidence,
            started_at,
            completed_at,
            observed_at,
            observed_cold_replay_count,
            observed_cold_replay_uncached_tokens,
            observed_hot_replay_cached_tokens,
            observed_hot_replay_count,
            updated_at
          ) VALUES (
            @usageTurnId,
            @provider,
            @backend,
            @threadId,
            @parentThreadId,
            @turnId,
            @model,
            @reasoningEffort,
            @serviceTier,
            @fastMode,
            @settingsSource,
            @settingsConfidence,
            @startedAt,
            @completedAt,
            @createdAt,
            @observedColdReplayCount,
            @observedColdReplayUncachedTokens,
            @observedHotReplayCachedTokens,
            @observedHotReplayCount,
            @updatedAt
          )
          ON CONFLICT(usage_turn_id) DO UPDATE SET
            provider = excluded.provider,
            backend = excluded.backend,
            thread_id = excluded.thread_id,
            parent_thread_id = excluded.parent_thread_id,
            turn_id = excluded.turn_id,
            model = COALESCE(excluded.model, thread_usage_turns.model),
            reasoning_effort = COALESCE(excluded.reasoning_effort, thread_usage_turns.reasoning_effort),
            service_tier = COALESCE(excluded.service_tier, thread_usage_turns.service_tier),
            fast_mode = COALESCE(excluded.fast_mode, thread_usage_turns.fast_mode),
            settings_source = CASE
              WHEN excluded.settings_source IS NULL OR excluded.settings_source = 'unknown'
                THEN thread_usage_turns.settings_source
              ELSE excluded.settings_source
            END,
            settings_confidence = CASE
              WHEN excluded.settings_confidence IS NULL OR excluded.settings_confidence = 'unknown'
                THEN thread_usage_turns.settings_confidence
              ELSE excluded.settings_confidence
            END,
            started_at = COALESCE(thread_usage_turns.started_at, excluded.started_at),
            completed_at = excluded.completed_at,
            observed_at = MIN(thread_usage_turns.observed_at, excluded.observed_at),
            -- Observation-derived tallies are absent on transcript-hydration
            -- lines (the Codex transcript can't reproduce them). COALESCE keeps a
            -- previously-observed tally when a hydration line (NULL params) later
            -- refreshes the turn metadata, so the count survives thread re-read.
            observed_cold_replay_count = COALESCE(excluded.observed_cold_replay_count, thread_usage_turns.observed_cold_replay_count),
            observed_cold_replay_uncached_tokens = COALESCE(excluded.observed_cold_replay_uncached_tokens, thread_usage_turns.observed_cold_replay_uncached_tokens),
            observed_hot_replay_cached_tokens = COALESCE(excluded.observed_hot_replay_cached_tokens, thread_usage_turns.observed_hot_replay_cached_tokens),
            observed_hot_replay_count = COALESCE(excluded.observed_hot_replay_count, thread_usage_turns.observed_hot_replay_count),
            updated_at = excluded.updated_at`,
        )
        .run(toThreadUsageLineRowParams(line));

      this.stateDb.raw
        .prepare(
          `INSERT INTO thread_usage_lines (
            usage_line_id,
            usage_turn_id,
            provider,
            backend,
            thread_id,
            parent_thread_id,
            turn_id,
            source,
            source_item_id,
            scope,
            status,
            created_at,
            completed_at,
            model,
            reasoning_effort,
            service_tier,
            fast_mode,
            settings_source,
            settings_confidence,
            input_tokens,
            cached_input_tokens,
            uncached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            total_tokens,
            cumulative_input_tokens,
            cumulative_cached_input_tokens,
            cumulative_uncached_input_tokens,
            cumulative_output_tokens,
            cumulative_reasoning_output_tokens,
            cumulative_total_tokens,
            price_status,
            price_unavailable_reason,
            currency,
            pricing_catalog_id,
            pricing_catalog_version,
            pricing_rate_id,
            uncached_input_cost_micros,
            cached_input_cost_micros,
            output_cost_micros,
            total_cost_micros,
            cumulative_total_cost_micros,
            observed_cold_replay_count,
            observed_cold_replay_uncached_tokens,
            observed_hot_replay_cached_tokens,
            observed_hot_replay_count,
            updated_at
          ) VALUES (
            @usageLineId,
            @usageTurnId,
            @provider,
            @backend,
            @threadId,
            @parentThreadId,
            @turnId,
            @source,
            @sourceItemId,
            @scope,
            @status,
            @createdAt,
            @completedAt,
            @model,
            @reasoningEffort,
            @serviceTier,
            @fastMode,
            @settingsSource,
            @settingsConfidence,
            @inputTokens,
            @cachedInputTokens,
            @uncachedInputTokens,
            @outputTokens,
            @reasoningOutputTokens,
            @totalTokens,
            @cumulativeInputTokens,
            @cumulativeCachedInputTokens,
            @cumulativeUncachedInputTokens,
            @cumulativeOutputTokens,
            @cumulativeReasoningOutputTokens,
            @cumulativeTotalTokens,
            @priceStatus,
            @priceUnavailableReason,
            @currency,
            @pricingCatalogId,
            @pricingCatalogVersion,
            @pricingRateId,
            @uncachedInputCostMicros,
            @cachedInputCostMicros,
            @outputCostMicros,
            @totalCostMicros,
            @cumulativeTotalCostMicros,
            @observedColdReplayCount,
            @observedColdReplayUncachedTokens,
            @observedHotReplayCachedTokens,
            @observedHotReplayCount,
            @updatedAt
          )
          ON CONFLICT(usage_line_id) DO UPDATE SET
            usage_turn_id = excluded.usage_turn_id,
            provider = excluded.provider,
            backend = excluded.backend,
            thread_id = excluded.thread_id,
            parent_thread_id = excluded.parent_thread_id,
            turn_id = excluded.turn_id,
            source = excluded.source,
            source_item_id = excluded.source_item_id,
            scope = excluded.scope,
            status = excluded.status,
            created_at = MIN(thread_usage_lines.created_at, excluded.created_at),
            completed_at = excluded.completed_at,
            model = excluded.model,
            reasoning_effort = excluded.reasoning_effort,
            service_tier = excluded.service_tier,
            fast_mode = excluded.fast_mode,
            settings_source = excluded.settings_source,
            settings_confidence = excluded.settings_confidence,
            input_tokens = excluded.input_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            uncached_input_tokens = excluded.uncached_input_tokens,
            output_tokens = excluded.output_tokens,
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens,
            cumulative_input_tokens = excluded.cumulative_input_tokens,
            cumulative_cached_input_tokens = excluded.cumulative_cached_input_tokens,
            cumulative_uncached_input_tokens = excluded.cumulative_uncached_input_tokens,
            cumulative_output_tokens = excluded.cumulative_output_tokens,
            cumulative_reasoning_output_tokens = excluded.cumulative_reasoning_output_tokens,
            cumulative_total_tokens = excluded.cumulative_total_tokens,
            price_status = excluded.price_status,
            price_unavailable_reason = excluded.price_unavailable_reason,
            currency = excluded.currency,
            pricing_catalog_id = excluded.pricing_catalog_id,
            pricing_catalog_version = excluded.pricing_catalog_version,
            pricing_rate_id = excluded.pricing_rate_id,
            uncached_input_cost_micros = excluded.uncached_input_cost_micros,
            cached_input_cost_micros = excluded.cached_input_cost_micros,
            output_cost_micros = excluded.output_cost_micros,
            total_cost_micros = excluded.total_cost_micros,
            cumulative_total_cost_micros = excluded.cumulative_total_cost_micros,
            -- DEPRECATED (see issue #947): dual-written for older builds; the new
            -- build reads the tally from thread_usage_turns. COALESCE mirrors the
            -- turn-record preserve so a tally-less re-upsert of the same line
            -- (e.g. accumulator reset) does not wipe the persisted values.
            observed_cold_replay_count = COALESCE(excluded.observed_cold_replay_count, thread_usage_lines.observed_cold_replay_count),
            observed_cold_replay_uncached_tokens = COALESCE(excluded.observed_cold_replay_uncached_tokens, thread_usage_lines.observed_cold_replay_uncached_tokens),
            observed_hot_replay_cached_tokens = COALESCE(excluded.observed_hot_replay_cached_tokens, thread_usage_lines.observed_hot_replay_cached_tokens),
            observed_hot_replay_count = COALESCE(excluded.observed_hot_replay_count, thread_usage_lines.observed_hot_replay_count),
            updated_at = excluded.updated_at`,
        )
        .run(toThreadUsageLineRowParams(line));

      if (existing) {
        const existingRollupThreadId = existing.parentThreadId ?? existing.threadId;
        const nextRollupThreadId = line.parentThreadId ?? line.threadId;
        if (
          existing.backend !== line.backend ||
          existing.provider !== line.provider ||
          existingRollupThreadId !== nextRollupThreadId ||
          existing.currency !== line.currency
        ) {
          this.recomputeThreadPricingSummarySync({
            backend: existing.backend,
            currency: existing.currency,
            provider: existing.provider,
            threadId: existingRollupThreadId,
            updatedAt: now,
          });
        }
      }

      return this.recomputeThreadPricingSummarySync({
        backend: line.backend,
        currency: line.currency,
        provider: line.provider,
        threadId: line.parentThreadId ?? line.threadId,
        updatedAt: now,
      });
    });

    return { line, summary: upsert() };
  }

  async readThreadPricing(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<{ lines: ThreadUsageLineRecord[]; summaries: ThreadPricingSummary[] }> {
    const lineRows = this.stateDb.raw
      .prepare(
        `SELECT *
         FROM (
           SELECT *
           FROM thread_usage_lines
           WHERE backend = ?
             AND status != 'superseded'
             AND thread_id = ?
           UNION ALL
           SELECT *
           FROM thread_usage_lines
           WHERE backend = ?
             AND status != 'superseded'
             AND parent_thread_id = ?
             AND thread_id != ?
         )
         ORDER BY created_at DESC, usage_line_id DESC`,
      )
      .all(
        params.backend,
        params.threadId,
        params.backend,
        params.threadId,
        params.threadId,
      ) as ThreadUsageLineRow[];
    const summaryRows = this.stateDb.raw
      .prepare(
        `SELECT * FROM thread_pricing_summaries
         WHERE backend = ? AND thread_id = ?
         ORDER BY provider ASC, currency ASC`,
      )
      .all(params.backend, params.threadId) as ThreadPricingSummaryRow[];

    const lines = lineRows.map(threadUsageLineFromRow);
    this.attachObservedReplayTalliesSync(params.backend, params.threadId, lines);

    return {
      lines,
      summaries: summaryRows.map(threadPricingSummaryFromRow),
    };
  }

  // The observed context-replay tally lives on the per-turn record
  // (thread_usage_turns), not on the usage line — the turn record is refreshed
  // via COALESCE and is immune to the line supersession lifecycle, so a
  // transcript-hydration line can supersede the live line without dropping the
  // tally. Attach it back onto the displayed line at read time so the renderer
  // keeps reading the observed fields off ThreadUsageLineRecord. Deliberately
  // NOT summed into pricing summaries.
  private attachObservedReplayTalliesSync(
    backend: string,
    threadId: string,
    lines: ThreadUsageLineRecord[],
  ): void {
    if (lines.length === 0) {
      return;
    }
    const turnRows = this.stateDb.raw
      .prepare(
        `SELECT usage_turn_id,
                observed_cold_replay_count,
                observed_cold_replay_uncached_tokens,
                observed_hot_replay_cached_tokens,
                observed_hot_replay_count
           FROM thread_usage_turns
          WHERE backend = ?
            AND thread_id = ?
          UNION ALL
         SELECT usage_turn_id,
                observed_cold_replay_count,
                observed_cold_replay_uncached_tokens,
                observed_hot_replay_cached_tokens,
                observed_hot_replay_count
           FROM thread_usage_turns
          WHERE backend = ?
            AND parent_thread_id = ?
            AND thread_id != ?`,
      )
      .all(backend, threadId, backend, threadId, threadId) as Array<{
      usage_turn_id: string;
      observed_cold_replay_count: number | null;
      observed_cold_replay_uncached_tokens: number | null;
      observed_hot_replay_cached_tokens: number | null;
      observed_hot_replay_count: number | null;
    }>;
    if (turnRows.length === 0) {
      return;
    }
    const byTurnId = new Map(turnRows.map((row) => [row.usage_turn_id, row]));
    for (const line of lines) {
      if (!line.usageTurnId) {
        continue;
      }
      const turn = byTurnId.get(line.usageTurnId);
      if (!turn) {
        continue;
      }
      if (turn.observed_cold_replay_count !== null) {
        line.observedColdReplayCount = turn.observed_cold_replay_count;
      }
      if (turn.observed_cold_replay_uncached_tokens !== null) {
        line.observedColdReplayUncachedTokens =
          turn.observed_cold_replay_uncached_tokens;
      }
      if (turn.observed_hot_replay_cached_tokens !== null) {
        line.observedHotReplayCachedTokens =
          turn.observed_hot_replay_cached_tokens;
      }
      if (turn.observed_hot_replay_count !== null) {
        line.observedHotReplayCount = turn.observed_hot_replay_count;
      }
    }
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

  async setThreadHandoffOrigin(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    handoffOrigin: ThreadOverlayState["handoffOrigin"] | null;
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
      handoffOrigin: params.handoffOrigin ?? undefined,
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
    const detachedPrKeys = normalizeDetachedPrKeys(current.detachedPrKeys);
    const detachedPrs = mergePrSummariesByStatusKey(
      current.detachedPrs,
      collectDetachedPrs(params.prs, detachedPrKeys),
    );
    const nextState: ThreadOverlayState = {
      ...current,
      detachedPrKeys,
      detachedPrs,
      prs: filterDetachedPrs(params.prs, detachedPrKeys).map(normalizePrSummary),
      prsFetchedAt: params.fetchedAt ?? Date.now(),
      prsRefreshKey: params.refreshKey,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async detachThreadPullRequest(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    pr: Pick<PrSummary, "provider" | "org" | "repo" | "number">;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const nextDetachedKeys = [
      ...new Set([
        ...normalizeDetachedPrKeys(current.detachedPrKeys),
        buildPullRequestStatusKey(params.pr),
      ]),
    ].sort((left, right) => left.localeCompare(right));
    const currentPrs = (current.prs ?? []).map(normalizePrSummary);
    const detachedPrs = mergePrSummariesByStatusKey(
      current.detachedPrs,
      collectDetachedPrs(currentPrs, nextDetachedKeys),
    );
    const nextState: ThreadOverlayState = {
      ...current,
      detachedPrKeys: nextDetachedKeys,
      detachedPrs,
      prs: filterDetachedPrs(currentPrs, nextDetachedKeys),
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async addThreadPullRequestReference(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    pr: PrSummary;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const normalizedPr = normalizePrSummary(params.pr);
    const prKey = buildPullRequestStatusKey(normalizedPr);
    const detachedPrKeys = normalizeDetachedPrKeys(current.detachedPrKeys).filter(
      (key) => key !== prKey,
    );
    const detachedPrs = mergePrSummariesByStatusKey(
      undefined,
      (current.detachedPrs ?? []).filter(
        (pr) => buildPullRequestStatusKey(pr) !== prKey,
      ),
    );
    const prs = mergePrSummariesByStatusKey(current.prs, [normalizedPr]) ?? [];
    const nextState: ThreadOverlayState = {
      ...current,
      detachedPrKeys,
      detachedPrs,
      prs,
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
    const requestedExpectedBranch = params.expectedBranch?.trim() || undefined;
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: requestedExpectedBranch
        ?? (current.gitBranch?.trim() ? current.gitBranch : fallbackExpectedBranch),
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

  async readThreadGitWorkingStateCache(): Promise<
    Record<string, WorktreeGitWorkingStateCacheEntry>
  > {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT worktree_path, fetched_at, payload
         FROM thread_git_working_state`,
      )
      .all() as Array<{
        worktree_path: string;
        fetched_at: number;
        payload: string | null;
      }>;

    return Object.fromEntries(
      rows.map((row) => {
        const gitWorkingState = parseThreadGitWorkingStatePayload(row.payload);
        const entry: WorktreeGitWorkingStateCacheEntry = {
          worktreePath: row.worktree_path,
          fetchedAt: row.fetched_at,
          ...(gitWorkingState ? { gitWorkingState } : {}),
        };
        return [entry.worktreePath, entry];
      }),
    );
  }

  async writeThreadGitWorkingStateCacheEntry(
    entry: WorktreeGitWorkingStateCacheEntry,
  ): Promise<void> {
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO thread_git_working_state(
           worktree_path,
           fetched_at,
           payload
         ) VALUES (?, ?, ?)`,
      )
      .run(
        entry.worktreePath,
        entry.fetchedAt,
        entry.gitWorkingState ? JSON.stringify(entry.gitWorkingState) : null,
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
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
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

  private readThreadUsageLineSync(
    usageLineId: string,
  ): ThreadUsageLineRecord | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT * FROM thread_usage_lines WHERE usage_line_id = ?")
      .get(usageLineId) as ThreadUsageLineRow | undefined;
    return row ? threadUsageLineFromRow(row) : undefined;
  }

  private recomputeThreadPricingSummarySync(params: {
    backend: string;
    currency: string;
    provider: string;
    threadId: string;
    updatedAt: number;
  }): ThreadPricingSummary {
    const row = this.stateDb.raw
      .prepare(
        `SELECT
           COUNT(*) AS usage_line_count,
           SUM(CASE WHEN price_status = 'priced' THEN 1 ELSE 0 END) AS priced_usage_line_count,
           SUM(CASE WHEN price_status != 'priced' THEN 1 ELSE 0 END) AS unpriced_usage_line_count,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
           COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(CASE WHEN price_status = 'priced' THEN total_cost_micros ELSE 0 END), 0)
             AS total_cost_micros
         FROM (
           SELECT *
           FROM thread_usage_lines
           WHERE provider = ?
             AND backend = ?
             AND currency = ?
             AND status != 'superseded'
             AND thread_id = ?
           UNION ALL
           SELECT *
           FROM thread_usage_lines
           WHERE provider = ?
             AND backend = ?
             AND currency = ?
             AND status != 'superseded'
             AND parent_thread_id = ?
             AND thread_id != ?
         )`,
      )
      .get(
        params.provider,
        params.backend,
        params.currency,
        params.threadId,
        params.provider,
        params.backend,
        params.currency,
        params.threadId,
        params.threadId,
      ) as ThreadPricingAggregateRow;

    const summary: ThreadPricingSummary = {
      backend: params.backend,
      cachedInputTokens: row.cached_input_tokens ?? 0,
      currency: params.currency,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      pricedUsageLineCount: row.priced_usage_line_count ?? 0,
      provider: params.provider,
      reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
      threadId: params.threadId,
      totalCostMicros: row.total_cost_micros ?? 0,
      totalTokens: row.total_tokens ?? 0,
      uncachedInputTokens: row.uncached_input_tokens ?? 0,
      unpricedUsageLineCount: row.unpriced_usage_line_count ?? 0,
      updatedAt: params.updatedAt,
      usageLineCount: row.usage_line_count ?? 0,
    };

    if (summary.usageLineCount === 0) {
      this.stateDb.raw
        .prepare(
          `DELETE FROM thread_pricing_summaries
           WHERE provider = ? AND backend = ? AND thread_id = ? AND currency = ?`,
        )
        .run(params.provider, params.backend, params.threadId, params.currency);
      return summary;
    }

    this.stateDb.raw
      .prepare(
        `INSERT INTO thread_pricing_summaries (
          provider,
          backend,
          thread_id,
          currency,
          usage_line_count,
          priced_usage_line_count,
          unpriced_usage_line_count,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          total_cost_micros,
          updated_at
        ) VALUES (
          @provider,
          @backend,
          @threadId,
          @currency,
          @usageLineCount,
          @pricedUsageLineCount,
          @unpricedUsageLineCount,
          @inputTokens,
          @cachedInputTokens,
          @uncachedInputTokens,
          @outputTokens,
          @reasoningOutputTokens,
          @totalTokens,
          @totalCostMicros,
          @updatedAt
        )
        ON CONFLICT(provider, backend, thread_id, currency) DO UPDATE SET
          usage_line_count = excluded.usage_line_count,
          priced_usage_line_count = excluded.priced_usage_line_count,
          unpriced_usage_line_count = excluded.unpriced_usage_line_count,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          uncached_input_tokens = excluded.uncached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          total_tokens = excluded.total_tokens,
          total_cost_micros = excluded.total_cost_micros,
          updated_at = excluded.updated_at`,
      )
      .run(summary);

    return summary;
  }
}

/** Check whether a linked directory was created by the handoff service. */
function isHandoffDirectory(directory: LinkedDirectorySummary): boolean {
  return (
    directory.id.startsWith("pwragent-handoff:") ||
    directory.id.startsWith("pwragnt-handoff:")  // legacy prefix from pre-rebrand data
  );
}

function linkedDirectoriesEquivalent(
  left: LinkedDirectorySummary,
  right: LinkedDirectorySummary,
): boolean {
  if (left.id === right.id) {
    return true;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (normalizeLinkedDirectoryPath(left.path) !== normalizeLinkedDirectoryPath(right.path)) {
    return false;
  }
  return (
    normalizeLinkedDirectoryPath(left.worktreePath) ===
    normalizeLinkedDirectoryPath(right.worktreePath)
  );
}

function normalizeLinkedDirectoryPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? path.resolve(normalized) : undefined;
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

type ThreadUsageLineRow = {
  usage_line_id: string;
  usage_turn_id: string | null;
  provider: string;
  backend: string;
  thread_id: string;
  parent_thread_id: string | null;
  turn_id: string | null;
  source: ThreadUsageLineRecord["source"];
  source_item_id: string | null;
  scope: ThreadUsageLineRecord["scope"];
  status: ThreadUsageLineRecord["status"];
  created_at: number;
  completed_at: number | null;
  model: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  fast_mode: number | null;
  settings_source: ThreadUsageLineRecord["settingsSource"] | null;
  settings_confidence: ThreadUsageLineRecord["settingsConfidence"] | null;
  input_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  cumulative_input_tokens: number | null;
  cumulative_cached_input_tokens: number | null;
  cumulative_uncached_input_tokens: number | null;
  cumulative_output_tokens: number | null;
  cumulative_reasoning_output_tokens: number | null;
  cumulative_total_tokens: number | null;
  price_status: ThreadUsageLineRecord["priceStatus"];
  price_unavailable_reason: ThreadUsageLineRecord["priceUnavailableReason"] | null;
  currency: string;
  pricing_catalog_id: string | null;
  pricing_catalog_version: string | null;
  pricing_rate_id: string | null;
  uncached_input_cost_micros: number;
  cached_input_cost_micros: number;
  output_cost_micros: number;
  total_cost_micros: number;
  cumulative_total_cost_micros: number | null;
  updated_at: number;
};

type ThreadPricingSummaryRow = {
  provider: string;
  backend: string;
  thread_id: string;
  currency: string;
  usage_line_count: number;
  priced_usage_line_count: number;
  unpriced_usage_line_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  total_cost_micros: number;
  updated_at: number;
};

type ThreadPricingAggregateRow = Omit<
  ThreadPricingSummaryRow,
  "backend" | "thread_id" | "currency" | "updated_at"
>;

function normalizeThreadUsageLine(
  line: ThreadUsageLineRecord,
  updatedAt: number,
): ThreadUsageLineRecord {
  const inputTokens = clampTokenCount(line.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, clampTokenCount(line.cachedInputTokens));
  const uncachedInputTokens = Math.max(
    0,
    line.uncachedInputTokens ?? inputTokens - cachedInputTokens,
  );
  const outputTokens = clampTokenCount(line.outputTokens);
  const reasoningOutputTokens = clampTokenCount(line.reasoningOutputTokens);
  const totalTokens =
    line.totalTokens > 0
      ? clampTokenCount(line.totalTokens)
      : inputTokens + outputTokens + reasoningOutputTokens;
  return {
    ...line,
    cachedInputTokens,
    completedAt: line.completedAt,
    createdAt: line.createdAt || updatedAt,
    currency: line.currency || "USD",
    ...(line.cumulativeCachedInputTokens !== undefined
      ? { cumulativeCachedInputTokens: clampTokenCount(line.cumulativeCachedInputTokens) }
      : {}),
    ...(line.cumulativeInputTokens !== undefined
      ? { cumulativeInputTokens: clampTokenCount(line.cumulativeInputTokens) }
      : {}),
    ...(line.cumulativeOutputTokens !== undefined
      ? { cumulativeOutputTokens: clampTokenCount(line.cumulativeOutputTokens) }
      : {}),
    ...(line.cumulativeReasoningOutputTokens !== undefined
      ? {
          cumulativeReasoningOutputTokens: clampTokenCount(
            line.cumulativeReasoningOutputTokens,
          ),
        }
      : {}),
    ...(line.cumulativeTotalCostMicros !== undefined
      ? {
          cumulativeTotalCostMicros: clampTokenCount(
            line.cumulativeTotalCostMicros,
          ),
        }
      : {}),
    ...(line.cumulativeTotalTokens !== undefined
      ? { cumulativeTotalTokens: clampTokenCount(line.cumulativeTotalTokens) }
      : {}),
    ...(line.cumulativeUncachedInputTokens !== undefined
      ? {
          cumulativeUncachedInputTokens: clampTokenCount(
            line.cumulativeUncachedInputTokens,
          ),
        }
      : {}),
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    ...(line.startedAt !== undefined ? { startedAt: line.startedAt } : {}),
    totalTokens,
    uncachedInputTokens,
    provider: line.provider || "openai",
    usageTurnId:
      line.usageTurnId ||
      [
        line.provider || "openai",
        line.backend,
        line.threadId,
        line.turnId ?? line.usageLineId,
      ].join(":"),
  };
}

function mergeThreadUsageLineForUpsert(
  line: ThreadUsageLineRecord,
  existing: ThreadUsageLineRecord,
): ThreadUsageLineRecord {
  const merged: ThreadUsageLineRecord = {
    ...line,
    createdAt: Math.min(existing.createdAt, line.createdAt),
    ...(line.fastMode !== undefined
      ? { fastMode: line.fastMode }
      : existing.fastMode !== undefined
        ? { fastMode: existing.fastMode }
        : {}),
    ...(line.model ? { model: line.model } : existing.model ? { model: existing.model } : {}),
    ...(line.reasoningEffort
      ? { reasoningEffort: line.reasoningEffort }
      : existing.reasoningEffort
        ? { reasoningEffort: existing.reasoningEffort }
        : {}),
    ...(line.serviceTier
      ? { serviceTier: line.serviceTier }
      : existing.serviceTier
        ? { serviceTier: existing.serviceTier }
        : {}),
    ...(line.startedAt !== undefined || existing.startedAt !== undefined
      ? {
          startedAt: Math.min(
            existing.startedAt ?? line.startedAt ?? line.createdAt,
            line.startedAt ?? existing.startedAt ?? existing.createdAt,
          ),
        }
      : {}),
    settingsConfidence: mergeUsageSettingValue(
      line.settingsConfidence,
      existing.settingsConfidence,
    ),
    settingsSource: mergeUsageSettingValue(
      line.settingsSource,
      existing.settingsSource,
    ),
  };

  return repriceOpenAiUsageLine(merged);
}

function mergeUsageSettingValue<T extends string>(
  next: T | undefined,
  existing: T | undefined,
): T | undefined {
  if (!next || next === "unknown") {
    return existing;
  }
  return next;
}

function repriceOpenAiUsageLine(line: ThreadUsageLineRecord): ThreadUsageLineRecord {
  if (line.provider !== "openai") {
    return line;
  }

  const cost = estimateOpenAiTokenUsageCost({
    at: line.createdAt,
    cachedInputTokens: line.cachedInputTokens,
    fastMode: line.fastMode,
    model: line.model,
    outputTokens: line.outputTokens,
    reasoningOutputTokens: line.reasoningOutputTokens,
    serviceTier: line.serviceTier,
    uncachedInputTokens: line.uncachedInputTokens,
  });
  const pricingServiceTier = resolveOpenAiPricingServiceTier({
    fastMode: line.fastMode,
    serviceTier: line.serviceTier,
  });
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost
      ? undefined
      : !line.model
        ? "missing-model"
        : pricingServiceTier === undefined
          ? "unsupported-service-tier"
          : "missing-rate";
  const {
    priceUnavailableReason: _discardedPriceUnavailableReason,
    pricingCatalogId: _discardedPricingCatalogId,
    pricingCatalogVersion: _discardedPricingCatalogVersion,
    pricingRateId: _discardedPricingRateId,
    ...baseLine
  } = line;

  return {
    ...baseLine,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    currency: cost?.currency ?? line.currency,
    outputCostMicros: cost?.outputCostMicros ?? 0,
    priceStatus: cost ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    ...(cost?.serviceTier && !line.serviceTier ? { serviceTier: cost.serviceTier } : {}),
    totalCostMicros: cost?.totalCostMicros ?? 0,
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
  };
}

function clampTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function toThreadUsageLineRowParams(line: ThreadUsageLineRecord): Record<string, unknown> {
  return {
    backend: line.backend,
    cachedInputCostMicros: line.cachedInputCostMicros,
    cachedInputTokens: line.cachedInputTokens,
    completedAt: line.completedAt ?? null,
    createdAt: line.createdAt,
    cumulativeCachedInputTokens: line.cumulativeCachedInputTokens ?? null,
    cumulativeInputTokens: line.cumulativeInputTokens ?? null,
    cumulativeOutputTokens: line.cumulativeOutputTokens ?? null,
    cumulativeReasoningOutputTokens: line.cumulativeReasoningOutputTokens ?? null,
    cumulativeTotalCostMicros: line.cumulativeTotalCostMicros ?? null,
    cumulativeTotalTokens: line.cumulativeTotalTokens ?? null,
    cumulativeUncachedInputTokens: line.cumulativeUncachedInputTokens ?? null,
    currency: line.currency,
    fastMode: typeof line.fastMode === "boolean" ? (line.fastMode ? 1 : 0) : null,
    inputTokens: line.inputTokens,
    model: line.model ?? null,
    observedColdReplayCount: line.observedColdReplayCount ?? null,
    observedColdReplayUncachedTokens: line.observedColdReplayUncachedTokens ?? null,
    observedHotReplayCachedTokens: line.observedHotReplayCachedTokens ?? null,
    observedHotReplayCount: line.observedHotReplayCount ?? null,
    outputCostMicros: line.outputCostMicros,
    outputTokens: line.outputTokens,
    parentThreadId: line.parentThreadId ?? null,
    priceStatus: line.priceStatus,
    priceUnavailableReason: line.priceUnavailableReason ?? null,
    provider: line.provider,
    pricingCatalogId: line.pricingCatalogId ?? null,
    pricingCatalogVersion: line.pricingCatalogVersion ?? null,
    pricingRateId: line.pricingRateId ?? null,
    reasoningEffort: line.reasoningEffort ?? null,
    reasoningOutputTokens: line.reasoningOutputTokens,
    scope: line.scope,
    serviceTier: line.serviceTier ?? null,
    settingsConfidence: line.settingsConfidence ?? null,
    settingsSource: line.settingsSource ?? null,
    source: line.source,
    sourceItemId: line.sourceItemId ?? null,
    startedAt: line.startedAt ?? line.createdAt,
    status: line.status,
    threadId: line.threadId,
    totalCostMicros: line.totalCostMicros,
    totalTokens: line.totalTokens,
    turnId: line.turnId ?? null,
    uncachedInputCostMicros: line.uncachedInputCostMicros,
    uncachedInputTokens: line.uncachedInputTokens,
    updatedAt: Date.now(),
    usageLineId: line.usageLineId,
    usageTurnId: line.usageTurnId ?? null,
  };
}

function threadUsageLineFromRow(row: ThreadUsageLineRow): ThreadUsageLineRecord {
  return {
    backend: row.backend,
    cachedInputCostMicros: row.cached_input_cost_micros,
    cachedInputTokens: row.cached_input_tokens,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
    ...(row.cumulative_cached_input_tokens !== null
      ? { cumulativeCachedInputTokens: row.cumulative_cached_input_tokens }
      : {}),
    ...(row.cumulative_input_tokens !== null
      ? { cumulativeInputTokens: row.cumulative_input_tokens }
      : {}),
    ...(row.cumulative_output_tokens !== null
      ? { cumulativeOutputTokens: row.cumulative_output_tokens }
      : {}),
    ...(row.cumulative_reasoning_output_tokens !== null
      ? {
          cumulativeReasoningOutputTokens:
            row.cumulative_reasoning_output_tokens,
        }
      : {}),
    ...(row.cumulative_total_cost_micros !== null
      ? { cumulativeTotalCostMicros: row.cumulative_total_cost_micros }
      : {}),
    ...(row.cumulative_total_tokens !== null
      ? { cumulativeTotalTokens: row.cumulative_total_tokens }
      : {}),
    ...(row.cumulative_uncached_input_tokens !== null
      ? { cumulativeUncachedInputTokens: row.cumulative_uncached_input_tokens }
      : {}),
    currency: row.currency,
    ...(row.fast_mode !== null ? { fastMode: Boolean(row.fast_mode) } : {}),
    inputTokens: row.input_tokens,
    ...(row.model ? { model: row.model } : {}),
    outputCostMicros: row.output_cost_micros,
    outputTokens: row.output_tokens,
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    priceStatus: row.price_status,
    ...(row.price_unavailable_reason
      ? { priceUnavailableReason: row.price_unavailable_reason }
      : {}),
    provider: row.provider || "openai",
    ...(row.pricing_catalog_id ? { pricingCatalogId: row.pricing_catalog_id } : {}),
    ...(row.pricing_catalog_version
      ? { pricingCatalogVersion: row.pricing_catalog_version }
      : {}),
    ...(row.pricing_rate_id ? { pricingRateId: row.pricing_rate_id } : {}),
    ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
    reasoningOutputTokens: row.reasoning_output_tokens,
    scope: row.scope,
    ...(row.service_tier ? { serviceTier: row.service_tier } : {}),
    ...(row.settings_confidence
      ? { settingsConfidence: row.settings_confidence }
      : {}),
    ...(row.settings_source ? { settingsSource: row.settings_source } : {}),
    source: row.source,
    ...(row.source_item_id ? { sourceItemId: row.source_item_id } : {}),
    status: row.status,
    threadId: row.thread_id,
    totalCostMicros: row.total_cost_micros,
    totalTokens: row.total_tokens,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    uncachedInputCostMicros: row.uncached_input_cost_micros,
    uncachedInputTokens: row.uncached_input_tokens,
    usageLineId: row.usage_line_id,
    ...(row.usage_turn_id ? { usageTurnId: row.usage_turn_id } : {}),
  };
}

function threadPricingSummaryFromRow(row: ThreadPricingSummaryRow): ThreadPricingSummary {
  return {
    backend: row.backend,
    cachedInputTokens: row.cached_input_tokens,
    currency: row.currency,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    pricedUsageLineCount: row.priced_usage_line_count,
    provider: row.provider || "openai",
    reasoningOutputTokens: row.reasoning_output_tokens,
    threadId: row.thread_id,
    totalCostMicros: row.total_cost_micros,
    totalTokens: row.total_tokens,
    uncachedInputTokens: row.uncached_input_tokens,
    unpricedUsageLineCount: row.unpriced_usage_line_count,
    updatedAt: row.updated_at,
    usageLineCount: row.usage_line_count,
  };
}

export type OverlayStoreLike = Pick<
  SqliteOverlayStore,
  | "reconcileNavigationSnapshot"
  | "markThreadSeen"
  | "addLinkedDirectory"
  | "removeLinkedDirectory"
  | "replaceWorkspaceLinkedDirectory"
  | "getThreadExecutionMode"
  | "getThreadOverlayState"
  | "getThreadOverlayStates"
  | "setAcpWorktreeDirectory"
  | "persistThreadUsageActivity"
  | "upsertThreadUsageLine"
  | "readThreadPricing"
  | "upsertThreadSubAgent"
  | "setThreadReaction"
  | "setThreadPin"
  | "setThreadParent"
  | "setThreadAgent"
  | "setThreadHandoffOrigin"
  | "reorderThreadPins"
  | "updateSubthreadOrder"
  | "setSubthreadsCollapsed"
  | "setDirectoryPin"
  | "reorderDirectoryPins"
  | "getDirectoryOverlayState"
  | "readAllDirectoryOverlays"
  | "setThreadPullRequests"
  | "detachThreadPullRequest"
  | "addThreadPullRequestReference"
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
