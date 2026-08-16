import path from "node:path";
import type {
  AppServerBackendScope,
  AppServerThreadMessageOrigin,
  AppServerThreadSummary,
  AutomationThreadSummary,
  DirectoryLaunchpadOverlayState,
  DirectoryOverlayState,
  FederatedThreadRef,
  LinkedDirectorySummary,
  MarkThreadSeenResponse,
  MessagingThreadBindingSummary,
  NavigationBrowseMode,
  ThreadQueuedTurnSummary,
  NavigationDirectoryGitStatus,
  NavigationLaunchpadDefaults,
  NavigationSnapshot,
  NavigationThreadSummary,
  PrSummary,
  PrAutoDispatchBudgetConfig,
  PrAutoDispatchBudgetStatus,
  ThreadExecutionMode,
  ThreadGitWorkingState,
  ThreadMessagingBindingTransition,
  ThreadOverlayState,
  ThreadToolAccounting,
  ThreadToolAnalysisCoverage,
  ThreadToolInvocationAlert,
  ThreadToolInvocationRecord,
  ThreadToolInvocationStatus,
  ThreadToolInvocationSummary,
  ThreadPermissionTransition,
  ThreadPricingSummary,
  ThreadPrAutoDispatchEventKind,
  ThreadPrAutoDispatchPending,
  ThreadPullRequestWatchSummary,
  RemoteThreadPin,
  StarMapArrangementEntry,
  ThreadQuestionnaireActivity,
  ThreadSubAgentSummary,
  ThreadTurnFailure,
  ThreadUsageLineRecord,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import {
  isStarMapArrangementEntry,
  mergeStarMapArrangementEntries,
  starMapArrangementEntryKey,
  DEFAULT_PULL_REQUEST_PROVIDER,
  AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
  MAX_MESSAGING_BINDING_TRANSITION_LOG_ENTRIES,
  MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES,
  MAX_MANAGED_REVIEW_ENTRIES,
  MAX_PERMISSION_TRANSITION_LOG_ENTRIES,
  MAX_QUESTIONNAIRE_ACTIVITY_LOG_ENTRIES,
  MAX_TURN_FAILURE_LOG_ENTRIES,
  buildPullRequestStatusKey,
  buildFederatedThreadRef,
  buildThreadIdentityKey,
  encodeLegacyThreadIdentityKey,
  buildNavigationSnapshot,
  buildNavigationSnapshotHash,
  applyNavigationLaunchpadProviderSettingsPatch,
  estimateTokenUsageCost,
  isAcpBackendId,
  isRemoteFederationTarget,
  normalizeNavigationBrowseMode,
  normalizeThreadIdentityKey,
  parseThreadIdentityKey,
  projectNavigationLaunchpadProviderSettings,
  resolveOpenAiPricingServiceTier,
} from "@pwragent/shared";
import type { StateDb } from "./state-db.js";
import type {
  RemoteThreadTarget,
  RemoteThreadTargetStore,
} from "./remote-thread-target-store.js";

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

export type PrAutoDispatchPendingRecord = {
  dispatchLease?: {
    expiresAt: number;
    ownerId: string;
  };
  pending: ThreadPrAutoDispatchPending;
  prompt: string;
};

export type PrAutoDispatchRecoveryResult = {
  nextLeaseExpiresAt?: number;
  recoveredCount: number;
};

export type PrAutoDispatchScheduleResult = {
  status: "scheduled" | "disabled" | "duplicate" | "attempt-limit" | "pending";
  pending?: ThreadPrAutoDispatchPending;
};

export type PrAutoDispatchBudgetReservationResult =
  | {
      budget: PrAutoDispatchBudgetStatus;
      status: "reserved";
    }
  | {
      budget: PrAutoDispatchBudgetStatus;
      status: "empty" | "paused" | "stale";
    };

type RemoteThreadTargetRow = {
  instance_id: string;
  instance_label: string;
  backend: RemoteThreadTarget["backend"];
  thread_id: string;
  first_seen_at: number;
  last_seen_at: number;
};

function remoteThreadTargetFromRow(
  row: RemoteThreadTargetRow,
): RemoteThreadTarget {
  return {
    instanceId: row.instance_id,
    instanceLabel: row.instance_label,
    backend: row.backend,
    threadId: row.thread_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export type PrAutoDispatchBudgetCompletionResult = {
  budget: PrAutoDispatchBudgetStatus;
  pausedNow: boolean;
};

export type PrAutoDispatchCandidate = {
  backend: ThreadOverlayState["backend"];
  eligibleSince: number;
  prKey: string;
  threadId: string;
};

export type PrStatusWatchClaim = {
  attemptCount: number;
  watch: ThreadPullRequestWatchSummary;
};

export type PrStatusWatchRegistrationResult = {
  status: "watching" | "duplicate";
  watch: ThreadPullRequestWatchSummary;
};

type PrAutoDispatchClaimRow = {
  payload: string;
  pr_key: string;
  status: string;
};

type PrAutoDispatchIncidentRow = {
  active_kinds: string;
  attempt_count: number;
};

type PrAutoDispatchBudgetRow = {
  paused_at: number | null;
  tokens: number;
  updated_at: number;
};

type PrAutoDispatchBudgetReservationRow = {
  reserved_at: number;
};

type PrAutoDispatchBudgetState = {
  pausedAt?: number;
  tokens: number;
};

type PrStatusWatchRow = {
  attempt_count: number;
  payload: string;
};

function parsePrStatusWatchSummary(
  payload: string,
): ThreadPullRequestWatchSummary | undefined {
  try {
    const parsed = JSON.parse(payload) as ThreadPullRequestWatchSummary;
    return parsed?.watchId && parsed.prKey && parsed.headSha
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parsePrAutoDispatchPendingRecord(
  payload: string,
): PrAutoDispatchPendingRecord | undefined {
  try {
    const parsed = JSON.parse(payload) as PrAutoDispatchPendingRecord;
    return parsed?.pending?.fingerprint && typeof parsed.prompt === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parsePrAutoDispatchKinds(value: string): ThreadPrAutoDispatchEventKind[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (kind): kind is ThreadPrAutoDispatchEventKind =>
            kind === "ci-failure" || kind === "merge-conflict",
        )
      : [];
  } catch {
    return [];
  }
}

function clearPrAutoDispatchLease(
  record: PrAutoDispatchPendingRecord,
): PrAutoDispatchPendingRecord {
  const { dispatchLease: _dispatchLease, ...pendingRecord } = record;
  return pendingRecord;
}

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
  const headSha = normalizeCommitShas(
    pr.headSha ? [pr.headSha] : undefined,
  )?.[0];
  const normalized: PrSummary = {
    ...pr,
    provider: normalizePullRequestProvider(pr.provider),
    state: checkState,
    checkState,
    lifecycleState: pr.lifecycleState ?? legacyPrLifecycleState(pr.state),
    reviewState: pr.reviewState ?? legacyPrReviewState(pr.state),
    mergeState: pr.mergeState ?? "unknown",
    commitShas: normalizeCommitShas(pr.commitShas),
  };
  if (headSha) {
    normalized.headSha = headSha;
  } else {
    delete normalized.headSha;
  }
  const baseRefName = pr.baseRefName?.trim();
  if (baseRefName) {
    normalized.baseRefName = baseRefName;
  } else {
    delete normalized.baseRefName;
  }
  const headRefName = pr.headRefName?.trim();
  if (headRefName) {
    normalized.headRefName = headRefName;
  } else {
    delete normalized.headRefName;
  }
  return normalized;
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
  // Map replacement retains the existing key's position, while a genuinely
  // new attachment is appended. The renderer uses this persisted order for
  // its left-to-right PR chips, so the most recently attached PR stays at the
  // right edge instead of being reordered by its canonical string key.
  const merged = [...byKey.values()];
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
const LEGACY_HANDOFF_AGENT_INSTRUCTIONS =
  "Work only on the delegated task from the parent PwrAgent thread. Keep progress and results in this thread.";

/**
 * Re-exported from `@pwragent/shared` so the persisted-lens allowlist has one
 * definition across main, preload, and the renderer. Existing importers keep
 * pointing here.
 */
export { normalizeNavigationBrowseMode };

function shouldApplyAcpExecutionModeSnapshot(
  current: ThreadOverlayState | undefined,
  thread: AppServerThreadSummary,
): boolean {
  return (
    isAcpBackendId(thread.source)
    && thread.executionMode !== undefined
    && (
      current?.executionModeUpdatedAt === undefined
      || (
        thread.updatedAt !== undefined
        && thread.updatedAt > current.executionModeUpdatedAt
      )
    )
  );
}

function remotePinInstanceId(ref: FederatedThreadRef): string {
  if (!isRemoteFederationTarget(ref.target)) {
    throw new Error("Remote thread pins require a remote federation target.");
  }
  return ref.target.instanceId;
}

/**
 * Cached pin summaries persist unstamped: the `federation` stamp (label,
 * peer status, capabilities) is live state re-applied at snapshot-merge
 * time, and persisting a stale copy would let an old peerStatus leak into
 * rendered rows.
 */
function stripFederationStamp(
  summary: NavigationThreadSummary,
): NavigationThreadSummary {
  const { federation: _federation, ...rest } = summary;
  return rest;
}

export class SqliteOverlayStore implements RemoteThreadTargetStore {
  constructor(private readonly stateDb: StateDb) {}

  /**
   * Finalize sub-agents whose creating PwrAgent runtime no longer exists.
   *
   * Every repair is committed in one transaction. New summaries identify
   * their owner exactly. Legacy ownerless summaries are repaired only when
   * this is the profile's sole live runtime, so opening a second PwrAgent
   * window can never fail work still owned by the first one.
   */
  async reconcileOrphanedThreadSubAgents(params: {
    currentRuntimeInstanceId: string;
    currentRegistrySessionId: string;
    liveRuntimeInstanceIds: string[];
    sessionStartedAt: number;
  }): Promise<{
    repairedSubAgents: number;
    repairedThreads: number;
    skippedLiveOwners: number;
    skippedOwnerlessWithOtherRuntimes: number;
  }> {
    const liveRuntimeInstanceIds = new Set(params.liveRuntimeInstanceIds);
    liveRuntimeInstanceIds.add(params.currentRuntimeInstanceId);
    const hasOtherLiveRuntime = Array.from(liveRuntimeInstanceIds).some(
      (instanceId) => instanceId !== params.currentRuntimeInstanceId,
    );
    const result = {
      repairedSubAgents: 0,
      repairedThreads: 0,
      skippedLiveOwners: 0,
      skippedOwnerlessWithOtherRuntimes: 0,
    };

    const reconcile = this.stateDb.raw.transaction(() => {
      const rows = this.stateDb.raw
        .prepare(
          `SELECT payload
           FROM threads
           WHERE payload LIKE '%"subAgents"%'`,
        )
        .all() as Array<{ payload: string }>;

      for (const row of rows) {
        let overlay: ThreadOverlayState;
        try {
          overlay = normalizeThreadOverlayState(
            JSON.parse(row.payload) as ThreadOverlayState,
          );
        } catch {
          continue;
        }
        if (!overlay.subAgents?.length) {
          continue;
        }

        let changed = false;
        const subAgents = overlay.subAgents.map((subAgent) => {
          if (subAgent.completedAt !== undefined) {
            return subAgent;
          }

          const completedAt = reliableSubAgentCompletionBoundary(subAgent);
          if (subAgentHasTerminalEvidence(subAgent)) {
            changed = true;
            result.repairedSubAgents += 1;
            return {
              ...subAgent,
              completedAt,
              updatedAt: completedAt,
              ...(subAgent.status === "failed"
                ? { status: "failure" as const, outcome: "failure" as const }
                : {}),
            };
          }

          const ownerRuntimeInstanceId = subAgent.ownerRuntimeInstanceId?.trim();
          const ownerRegistrySessionId = subAgent.ownerRegistrySessionId?.trim();
          const belongsToReplacedCurrentRegistry =
            ownerRuntimeInstanceId === params.currentRuntimeInstanceId
            && Boolean(ownerRegistrySessionId)
            && ownerRegistrySessionId !== params.currentRegistrySessionId;
          if (
            ownerRuntimeInstanceId
            && liveRuntimeInstanceIds.has(ownerRuntimeInstanceId)
            && !belongsToReplacedCurrentRegistry
          ) {
            result.skippedLiveOwners += 1;
            return subAgent;
          }
          if (!ownerRuntimeInstanceId && hasOtherLiveRuntime) {
            result.skippedOwnerlessWithOtherRuntimes += 1;
            return subAgent;
          }
          if (
            !ownerRuntimeInstanceId
            && subAgent.createdAt >= params.sessionStartedAt
          ) {
            return subAgent;
          }

          changed = true;
          result.repairedSubAgents += 1;
          return {
            ...subAgent,
            status: "failure" as const,
            outcome: "failure" as const,
            completedAt,
            updatedAt: completedAt,
            lastMessage: belongsToReplacedCurrentRegistry
              ? "Interrupted when its owning PwrAgent backend registry was replaced before reporting completion."
              : "Interrupted when its owning PwrAgent runtime stopped before reporting completion.",
            completionSource: {
              type: "pwragent_fallback" as const,
              reason: belongsToReplacedCurrentRegistry
                ? "owner_registry_replaced"
                : "owner_runtime_stopped",
              recoveryAttempted: false,
              terminalStatus: "failed" as const,
            },
          };
        });
        if (!changed) {
          continue;
        }

        result.repairedThreads += 1;
        this.putThread(buildThreadIdentityKey(overlay.backend, overlay.threadId), {
          ...overlay,
          subAgents,
        });
      }
    });
    reconcile();
    return result;
  }

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
    /**
     * Read projection of the registry's in-memory turn FIFO. Attached to
     * outgoing thread summaries (and hashed) so every window and viewer
     * sees queued messages, mirroring queuedExecutionModesByThreadKey.
     */
    queuedTurnsByThreadKey?: Record<string, ThreadQueuedTurnSummary[]>;
    threads: AppServerThreadSummary[];
    workspaceRoots?: string[];
  }): Promise<NavigationSnapshot> {
    const backendState = this.getBackend(params.backend);
    const firstSnapshot = !backendState?.lastSnapshotHash;

    if (firstSnapshot) {
      for (const thread of params.threads) {
        const threadKey = buildThreadIdentityKey(thread.source, thread.id);
        const current = this.getThread(threadKey);
        const applyAcpExecutionModeSnapshot =
          shouldApplyAcpExecutionModeSnapshot(current, thread);
        this.putThread(threadKey, {
          ...(current ?? {}),
          backend: thread.source,
          threadId: thread.id,
          executionMode: isAcpBackendId(thread.source)
            ? applyAcpExecutionModeSnapshot
              ? thread.executionMode ?? current?.executionMode ?? "default"
              : current?.executionMode ?? thread.executionMode ?? "default"
            : current?.executionMode ?? thread.executionMode ?? "default",
          executionModeUpdatedAt: isAcpBackendId(thread.source)
            ? applyAcpExecutionModeSnapshot && thread.executionMode
              ? thread.updatedAt
              : current?.executionModeUpdatedAt
            : current?.executionModeUpdatedAt,
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
          managedReviewEntries: current?.managedReviewEntries,
          pendingManagedReviewContextEntryIds:
            current?.pendingManagedReviewContextEntryIds,
          subAgents: current?.subAgents,
          handoffOrigin: current?.handoffOrigin,
          lastSeenAt: params.fetchedAt,
          lastSeenUpdatedAt: thread.updatedAt,
          extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
          worktreeSnapshots: current?.worktreeSnapshots ?? [],
          pinnedRank: current?.pinnedRank,
          parentThreadId: current?.parentThreadId,
          parentThreadBackend: current?.parentThreadBackend,
          subthreadOrder: current?.subthreadOrder,
          subthreadsCollapsed: current?.subthreadsCollapsed,
          permissionTransitionLog: current?.permissionTransitionLog,
          messagingBindingTransitionLog:
            current?.messagingBindingTransitionLog,
          turnFailureLog: current?.turnFailureLog,
          questionnaireActivityLog: current?.questionnaireActivityLog,
        });
      }
    }

    for (const thread of params.threads) {
      if (!isAcpBackendId(thread.source) || !thread.executionMode) {
        continue;
      }
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const current = this.getThread(threadKey);
      if (
        current
        && shouldApplyAcpExecutionModeSnapshot(current, thread)
        && (
          current.executionMode !== thread.executionMode
          || current.executionModeUpdatedAt !== thread.updatedAt
        )
      ) {
        this.putThread(threadKey, {
          ...current,
          executionMode: thread.executionMode,
          executionModeUpdatedAt: thread.updatedAt,
        });
      }
    }

    // Agent names originate from the thread title when a thread is promoted
    // or created as an Agent. Keep that invariant across older builds that
    // renamed only the provider thread and left the overlay name stale.
    for (const thread of params.threads) {
      const threadTitle = thread.title.trim();
      if (!threadTitle) {
        continue;
      }
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const current = this.getThread(threadKey);
      if (current?.agent && current.agent.name !== threadTitle) {
        this.putThread(threadKey, {
          ...current,
          agent: {
            ...current.agent,
            name: threadTitle,
            updatedAt: params.fetchedAt,
          },
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

    if (params.queuedTurnsByThreadKey) {
      // Attach BEFORE hashing so queue changes invalidate the
      // unchanged-snapshot cache like any other thread-state change.
      snapshot.threads = snapshot.threads.map((thread) => {
        const queuedTurns = params.queuedTurnsByThreadKey?.[
          buildThreadIdentityKey(thread.source, thread.id)
        ];
        return queuedTurns?.length ? { ...thread, queuedTurns } : thread;
      });
    }

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

  async upsertManagedReviewEntry(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    entry: NonNullable<ThreadOverlayState["managedReviewEntries"]>[number];
    pendingContext?: boolean;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const existingEntries = current.managedReviewEntries ?? [];
    const existingIndex = existingEntries.findIndex(
      (entry) => entry.id === params.entry.id,
    );
    const nextEntries = [...existingEntries];
    if (existingIndex === -1) {
      nextEntries.push(params.entry);
    } else {
      nextEntries[existingIndex] = params.entry;
    }
    const nextState: ThreadOverlayState = {
      ...current,
      managedReviewEntries: nextEntries.slice(-MAX_MANAGED_REVIEW_ENTRIES),
    };
    const retainedEntryIds = new Set(
      nextState.managedReviewEntries?.map((entry) => entry.id) ?? [],
    );
    const pendingContextEntryIds = [
      ...(current.pendingManagedReviewContextEntryIds ?? []),
      ...(params.pendingContext ? [params.entry.id] : []),
    ].filter(
      (id, index, ids) =>
        retainedEntryIds.has(id) && ids.indexOf(id) === index,
    );
    nextState.pendingManagedReviewContextEntryIds =
      pendingContextEntryIds.length > 0
        ? pendingContextEntryIds
        : undefined;
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async consumeManagedReviewContexts(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    entryIds: string[];
  }): Promise<ThreadOverlayState | undefined> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey);
    if (!current || params.entryIds.length === 0) {
      return current;
    }
    const consumed = new Set(params.entryIds);
    const remaining = (current.pendingManagedReviewContextEntryIds ?? [])
      .filter((id) => !consumed.has(id));
    const nextState: ThreadOverlayState = {
      ...current,
      pendingManagedReviewContextEntryIds:
        remaining.length > 0 ? remaining : undefined,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async upsertThreadUsageLine(params: {
    line: ThreadUsageLineRecord;
  }): Promise<{ line: ThreadUsageLineRecord; summary: ThreadPricingSummary }> {
    const { lines, summaries } = await this.upsertThreadUsageLines({
      lines: [params.line],
    });
    const line = lines[0];
    if (!line) {
      throw new Error("Thread usage line batch did not persist its input");
    }
    const summary = summaries.find(
      (candidate) =>
        candidate.backend === line.backend
        && candidate.currency === line.currency
        && candidate.provider === line.provider
        && candidate.threadId === (line.parentThreadId ?? line.threadId),
    );
    if (!summary) {
      throw new Error(
        `Thread usage line ${line.usageLineId} did not produce a pricing summary`,
      );
    }
    return { line, summary };
  }

  /**
   * Persist the latest value for every distinct usage line under one sqlite
   * transaction. Callers may pass repeated ids; later entries win before any
   * statement runs, and affected pricing summaries are recomputed once each.
   */
  async upsertThreadUsageLines(params: {
    lines: ThreadUsageLineRecord[];
  }): Promise<{
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  }> {
    const latestLinesById = new Map<string, ThreadUsageLineRecord>();
    for (const line of params.lines) {
      latestLinesById.set(line.usageLineId, line);
    }
    if (latestLinesById.size === 0) {
      return { lines: [], summaries: [] };
    }

    const now = Date.now();
    const lines = [...latestLinesById.values()].map((line) =>
      repriceTokenUsageLine(normalizeThreadUsageLine(line, now)),
    );
    const summaryTargets = new Map<
      string,
      {
        backend: string;
        currency: string;
        provider: string;
        threadId: string;
        updatedAt: number;
      }
    >();
    const queueSummary = (target: {
      backend: string;
      currency: string;
      provider: string;
      threadId: string;
      updatedAt: number;
    }): void => {
      summaryTargets.set(
        JSON.stringify([
          target.provider,
          target.backend,
          target.threadId,
          target.currency,
        ]),
        target,
      );
    };
    const upsertLine = (
      inputLine: ThreadUsageLineRecord,
    ): ThreadUsageLineRecord => {
      let line = inputLine;
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
            started_at = CASE
              WHEN thread_usage_turns.started_at IS NULL THEN excluded.started_at
              WHEN excluded.started_at IS NULL THEN thread_usage_turns.started_at
              ELSE MIN(thread_usage_turns.started_at, excluded.started_at)
            END,
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
            turn_usage_attributed,
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
            @turnUsageAttributed,
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
            turn_usage_attributed = excluded.turn_usage_attributed,
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
          queueSummary({
            backend: existing.backend,
            currency: existing.currency,
            provider: existing.provider,
            threadId: existingRollupThreadId,
            updatedAt: now,
          });
        }
      }

      queueSummary({
        backend: line.backend,
        currency: line.currency,
        provider: line.provider,
        threadId: line.parentThreadId ?? line.threadId,
        updatedAt: now,
      });
      return line;
    };

    const upsert = this.stateDb.raw.transaction(() => {
      for (let index = 0; index < lines.length; index += 1) {
        lines[index] = upsertLine(lines[index]!);
      }

      return [...summaryTargets.values()].map((target) =>
        this.recomputeThreadPricingSummarySync(target),
      );
    });

    return { lines, summaries: upsert() };
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
    this.attachUsageTurnMetadataSync(params.backend, params.threadId, lines);

    return {
      lines,
      summaries: summaryRows.map(threadPricingSummaryFromRow),
    };
  }

  async upsertThreadToolInvocation(params: {
    invocation: ThreadToolInvocationRecord;
  }): Promise<ThreadToolInvocationRecord> {
    return this.upsertThreadToolInvocationSync(params);
  }

  private upsertThreadToolInvocationSync(params: {
    invocation: ThreadToolInvocationRecord;
  }): ThreadToolInvocationRecord {
    const invocation = normalizeThreadToolInvocation(params.invocation);
    const existing = this.readThreadToolInvocationSync(invocation.invocationId);
    const merged = existing
      ? mergeThreadToolInvocationForUpsert(invocation, existing)
      : invocation;

    this.stateDb.raw
      .prepare(
        `INSERT INTO thread_tool_invocations (
          invocation_id,
          finding_id,
          backend,
          thread_id,
          turn_id,
          item_id,
          tool_name,
          normalized_command,
          category,
          status,
          started_at,
          completed_at,
          observed_at,
          updated_at,
          session_id,
          process_id,
          exit_code,
          output_chars,
          output_lines,
          estimated_output_tokens,
          warning_lines,
          error_lines,
          info_lines,
          debug_lines,
          output_truncated,
          output_state,
          source,
          noisy,
          noisy_reason,
          suggested_prompt
        ) VALUES (
          @invocationId,
          @findingId,
          @backend,
          @threadId,
          @turnId,
          @itemId,
          @toolName,
          @normalizedCommand,
          @category,
          @status,
          @startedAt,
          @completedAt,
          @observedAt,
          @updatedAt,
          @sessionId,
          @processId,
          @exitCode,
          @outputChars,
          @outputLines,
          @estimatedOutputTokens,
          @warningLines,
          @errorLines,
          @infoLines,
          @debugLines,
          @outputTruncated,
          @outputState,
          @source,
          @noisy,
          @noisyReason,
          @suggestedPrompt
        )
        ON CONFLICT(invocation_id) DO UPDATE SET
          backend = excluded.backend,
          finding_id = excluded.finding_id,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          item_id = excluded.item_id,
          tool_name = excluded.tool_name,
          normalized_command = excluded.normalized_command,
          category = excluded.category,
          status = excluded.status,
          started_at = CASE
            WHEN thread_tool_invocations.started_at IS NULL THEN excluded.started_at
            WHEN excluded.started_at IS NULL THEN thread_tool_invocations.started_at
            ELSE MIN(thread_tool_invocations.started_at, excluded.started_at)
          END,
          completed_at = excluded.completed_at,
          observed_at = MAX(thread_tool_invocations.observed_at, excluded.observed_at),
          updated_at = excluded.updated_at,
          session_id = COALESCE(excluded.session_id, thread_tool_invocations.session_id),
          process_id = COALESCE(excluded.process_id, thread_tool_invocations.process_id),
          exit_code = COALESCE(excluded.exit_code, thread_tool_invocations.exit_code),
          output_chars = excluded.output_chars,
          output_lines = excluded.output_lines,
          estimated_output_tokens = excluded.estimated_output_tokens,
          warning_lines = excluded.warning_lines,
          error_lines = excluded.error_lines,
          info_lines = excluded.info_lines,
          debug_lines = excluded.debug_lines,
          output_truncated = excluded.output_truncated,
          output_state = excluded.output_state,
          source = excluded.source,
          noisy = excluded.noisy,
          noisy_reason = excluded.noisy_reason,
          suggested_prompt = excluded.suggested_prompt`,
      )
      .run(toThreadToolInvocationRowParams(merged));

    return merged;
  }

  async markThreadToolInvocationNoisy(params: {
    invocationId: string;
    reason: string;
  }): Promise<void> {
    this.stateDb.raw
      .prepare(
        `UPDATE thread_tool_invocations
         SET noisy = 1, noisy_reason = ?, updated_at = ?
         WHERE invocation_id = ?`,
      )
      .run(params.reason, Date.now(), params.invocationId);
  }

  async markThreadToolInvocationsNoisy(params: {
    invocationIds: string[];
    reason: string;
  }): Promise<void> {
    if (params.invocationIds.length === 0) {
      return;
    }
    this.stateDb.raw.transaction(() => {
      this.markThreadToolInvocationsNoisySync(params);
    })();
  }

  private markThreadToolInvocationsNoisySync(params: {
    invocationIds: string[];
    reason: string;
  }): void {
    const update = this.stateDb.raw.prepare(
      `UPDATE thread_tool_invocations
       SET noisy = 1, noisy_reason = ?, updated_at = ?
       WHERE invocation_id = ?`,
    );
    const updatedAt = Date.now();
    for (const invocationId of new Set(params.invocationIds)) {
      update.run(params.reason, updatedAt, invocationId);
    }
  }

  async upsertThreadToolInvocationAlert(params: {
    alert: ThreadToolInvocationAlert;
  }): Promise<ThreadToolInvocationAlert> {
    return this.upsertThreadToolInvocationAlertSync(params);
  }

  private upsertThreadToolInvocationAlertSync(params: {
    alert: ThreadToolInvocationAlert;
  }): ThreadToolInvocationAlert {
    const alert = normalizeThreadToolInvocationAlert(params.alert);
    this.stateDb.raw
      .prepare(
        `INSERT INTO thread_tool_invocation_alerts (
          alert_id,
          backend,
          thread_id,
          turn_id,
          kind,
          severity,
          tool_name,
          session_id,
          process_id,
          first_observed_at,
          last_observed_at,
          invocation_count,
          invocation_ids,
          total_output_chars,
          estimated_output_tokens,
          worst_invocation_id,
          worst_output_chars,
          average_interval_ms,
          message,
          suggested_prompt,
          created_at,
          updated_at
        ) VALUES (
          @alertId,
          @backend,
          @threadId,
          @turnId,
          @kind,
          @severity,
          @toolName,
          @sessionId,
          @processId,
          @firstObservedAt,
          @lastObservedAt,
          @invocationCount,
          @invocationIds,
          @totalOutputChars,
          @estimatedOutputTokens,
          @worstInvocationId,
          @worstOutputChars,
          @averageIntervalMs,
          @message,
          @suggestedPrompt,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(alert_id) DO UPDATE SET
          backend = excluded.backend,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          kind = excluded.kind,
          severity = excluded.severity,
          tool_name = excluded.tool_name,
          session_id = COALESCE(excluded.session_id, thread_tool_invocation_alerts.session_id),
          process_id = COALESCE(excluded.process_id, thread_tool_invocation_alerts.process_id),
          first_observed_at = MIN(thread_tool_invocation_alerts.first_observed_at, excluded.first_observed_at),
          last_observed_at = MAX(thread_tool_invocation_alerts.last_observed_at, excluded.last_observed_at),
          invocation_count = excluded.invocation_count,
          invocation_ids = excluded.invocation_ids,
          total_output_chars = excluded.total_output_chars,
          estimated_output_tokens = excluded.estimated_output_tokens,
          worst_invocation_id = excluded.worst_invocation_id,
          worst_output_chars = excluded.worst_output_chars,
          average_interval_ms = excluded.average_interval_ms,
          message = excluded.message,
          suggested_prompt = excluded.suggested_prompt,
          updated_at = excluded.updated_at`,
      )
      .run(toThreadToolInvocationAlertRowParams(alert));
    return alert;
  }

  async persistThreadToolInvocationBoundary(params: {
    alerts: ThreadToolInvocationAlert[];
    invocation: ThreadToolInvocationRecord;
    noisyInvocationIds?: string[];
    noisyReason?: string;
  }): Promise<ThreadToolInvocationRecord> {
    let stored: ThreadToolInvocationRecord | undefined;
    this.stateDb.raw.transaction(() => {
      stored = this.upsertThreadToolInvocationSync({
        invocation: params.invocation,
      });
      if (
        params.noisyInvocationIds?.length
        && params.noisyReason
      ) {
        this.markThreadToolInvocationsNoisySync({
          invocationIds: params.noisyInvocationIds,
          reason: params.noisyReason,
        });
      }
      for (const alert of params.alerts) {
        this.upsertThreadToolInvocationAlertSync({ alert });
      }
    })();
    if (!stored) {
      throw new Error("Tool invocation boundary transaction did not run");
    }
    return stored;
  }

  async readThreadToolAccounting(params: {
    backend: ThreadOverlayState["backend"];
    includeAllInvocations?: boolean;
    threadId: string;
  }): Promise<ThreadToolAccounting> {
    const invocationLimit = params.includeAllInvocations ? -1 : 200;
    const invocationRows = this.stateDb.raw
      .prepare(
        `SELECT *
         FROM thread_tool_invocations
         WHERE backend = ?
           AND thread_id = ?
         ORDER BY observed_at DESC, invocation_id DESC
         LIMIT ?`,
      )
      .all(
        params.backend,
        params.threadId,
        invocationLimit,
      ) as ThreadToolInvocationRow[];
    const summaryRows = this.stateDb.raw
      .prepare(
        `SELECT
           category,
           tool_name,
           COUNT(*) AS invocation_count,
           COALESCE(SUM(output_chars), 0) AS output_chars,
           COALESCE(SUM(output_lines), 0) AS output_lines,
           COALESCE(SUM(estimated_output_tokens), 0) AS estimated_output_tokens,
           COALESCE(SUM(warning_lines), 0) AS warning_lines,
           COALESCE(SUM(error_lines), 0) AS error_lines,
           COALESCE(SUM(info_lines), 0) AS info_lines,
           COALESCE(SUM(debug_lines), 0) AS debug_lines,
           COALESCE(SUM(CASE WHEN noisy = 1 THEN 1 ELSE 0 END), 0) AS noisy_invocation_count,
           MAX(observed_at) AS last_observed_at
         FROM thread_tool_invocations
         WHERE backend = ?
           AND thread_id = ?
         GROUP BY category, tool_name
         ORDER BY estimated_output_tokens DESC, output_chars DESC
         LIMIT 50`,
      )
      .all(params.backend, params.threadId) as ThreadToolInvocationSummaryRow[];
    const alertRows = this.stateDb.raw
      .prepare(
        `SELECT *
         FROM thread_tool_invocation_alerts
         WHERE backend = ?
           AND thread_id = ?
         ORDER BY updated_at DESC, alert_id DESC
         LIMIT 20`,
      )
      .all(params.backend, params.threadId) as ThreadToolInvocationAlertRow[];
    const analysisRow = this.stateDb.raw
      .prepare(
        `SELECT * FROM thread_tool_analysis
         WHERE backend = ? AND thread_id = ?`,
      )
      .get(params.backend, params.threadId) as ThreadToolAnalysisRow | undefined;

    return {
      ...(analysisRow ? { analysis: threadToolAnalysisFromRow(analysisRow) } : {}),
      alerts: alertRows.map(threadToolInvocationAlertFromRow),
      invocations: invocationRows.map(threadToolInvocationFromRow),
      summaries: summaryRows.map(threadToolInvocationSummaryFromRow),
    };
  }

  async persistThreadToolHistoryAnalysis(params: {
    backend: ThreadOverlayState["backend"];
    coverage: ThreadToolAnalysisCoverage;
    invocations: ThreadToolInvocationRecord[];
    threadId: string;
  }): Promise<void> {
    this.stateDb.raw.transaction(() => {
      this.stateDb.raw
        .prepare(
          `DELETE FROM thread_tool_invocations
           WHERE backend = ? AND thread_id = ? AND source = 'history'`,
        )
        .run(params.backend, params.threadId);
      for (const invocation of params.invocations) {
        this.upsertThreadToolInvocationSync({ invocation });
      }
      this.stateDb.raw
        .prepare(
          `INSERT INTO thread_tool_analysis (
            backend, thread_id, analyzer_version, analyzed_at, completeness,
            entry_count, invocation_count, missing_output_count, page_count,
            scanned_through, explanation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(backend, thread_id) DO UPDATE SET
            analyzer_version = excluded.analyzer_version,
            analyzed_at = excluded.analyzed_at,
            completeness = excluded.completeness,
            entry_count = excluded.entry_count,
            invocation_count = excluded.invocation_count,
            missing_output_count = excluded.missing_output_count,
            page_count = excluded.page_count,
            scanned_through = excluded.scanned_through,
            explanation = excluded.explanation`,
        )
        .run(
          params.backend,
          params.threadId,
          params.coverage.analyzerVersion,
          params.coverage.analyzedAt,
          params.coverage.completeness,
          params.coverage.entryCount,
          params.coverage.invocationCount,
          params.coverage.missingOutputCount,
          params.coverage.pageCount,
          params.coverage.scannedThrough ?? null,
          params.coverage.explanation ?? null,
        );
    })();
  }

  readRecentThreadToolInvocations(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    toolName: string;
    since: number;
    sessionId?: string;
    processId?: string;
    limit?: number;
  }): ThreadToolInvocationRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT *
         FROM thread_tool_invocations
         WHERE backend = @backend
           AND thread_id = @threadId
           AND tool_name = @toolName
           AND observed_at >= @since
           AND (@sessionId IS NULL OR session_id = @sessionId)
           AND (@processId IS NULL OR process_id = @processId)
         ORDER BY observed_at DESC, invocation_id DESC
         LIMIT @limit`,
      )
      .all({
        backend: params.backend,
        limit: params.limit ?? 12,
        processId: params.processId ?? null,
        sessionId: params.sessionId ?? null,
        since: params.since,
        threadId: params.threadId,
        toolName: params.toolName,
      }) as ThreadToolInvocationRow[];
    return rows.map(threadToolInvocationFromRow);
  }

  async upsertThreadMessageOrigin(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    messageId: string;
    origin: AppServerThreadMessageOrigin;
    createdAt?: number;
  }): Promise<void> {
    this.stateDb.raw
      .prepare(
        `INSERT INTO thread_message_origins(
           backend,
           thread_id,
           message_id,
           created_at,
           payload
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(backend, thread_id, message_id) DO UPDATE SET
           created_at = excluded.created_at,
           payload = excluded.payload`,
      )
      .run(
        params.backend,
        params.threadId,
        params.messageId,
        params.createdAt ?? Date.now(),
        JSON.stringify(params.origin),
      );
  }

  async readThreadMessageOrigins(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    messageIds: string[];
  }): Promise<Record<string, AppServerThreadMessageOrigin>> {
    const messageIds = [
      ...new Set(
        params.messageIds.map((messageId) => messageId.trim()).filter(Boolean),
      ),
    ];
    if (messageIds.length === 0) {
      return {};
    }
    const rows = this.stateDb.raw
      .prepare(
        `SELECT message_id, payload
         FROM thread_message_origins
         WHERE backend = ?
           AND thread_id = ?
           AND message_id IN (SELECT value FROM json_each(?))`,
      )
      .all(params.backend, params.threadId, JSON.stringify(messageIds)) as Array<{
        message_id: string;
        payload: string;
      }>;
    return Object.fromEntries(
      rows.map((row) => [
        row.message_id,
        JSON.parse(row.payload) as AppServerThreadMessageOrigin,
      ]),
    );
  }

  // Per-turn metadata lives on thread_usage_turns. The turn record is refreshed
  // via COALESCE and is immune to the line supersession lifecycle, so a
  // transcript-hydration line can supersede the live line without dropping
  // start timing or observed replay tallies. Attach it back onto displayed
  // lines at read time so the renderer can compute finished durations and keep
  // reading observed fields off ThreadUsageLineRecord. Deliberately NOT summed
  // into pricing summaries.
  private attachUsageTurnMetadataSync(
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
                started_at,
                completed_at,
                observed_cold_replay_count,
                observed_cold_replay_uncached_tokens,
                observed_hot_replay_cached_tokens,
                observed_hot_replay_count
           FROM thread_usage_turns
          WHERE backend = ?
            AND thread_id = ?
          UNION ALL
         SELECT usage_turn_id,
                started_at,
                completed_at,
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
      completed_at: number | null;
      started_at: number;
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
      line.startedAt = turn.started_at;
      if (line.completedAt === undefined && turn.completed_at !== null) {
        line.completedAt = turn.completed_at;
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

  /**
   * Records the operator's disposition of this thread's tool-output incident.
   * `firstWarningAt` is written once and never moved forward, so the cost
   * window the notice reports stays anchored to the first warning even after
   * a restart drops the older accounting rows out of the live snapshot.
   */
  async setThreadToolIncidentNotice(params: {
    backend: ThreadOverlayState["backend"];
    dismissedAt?: number;
    dismissedSeverity?: "critical" | "warning";
    firstWarningAt?: number;
    mutedAt?: number;
    mutedSeverity?: "critical" | "warning";
    reset?: boolean;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const existing = current.toolIncidentNotice;
    const firstWarningAt = existing?.firstWarningAt
      ?? params.firstWarningAt;
    const nextNotice = params.reset
      ? (firstWarningAt !== undefined ? { firstWarningAt } : undefined)
      : {
          ...existing,
          ...(firstWarningAt !== undefined ? { firstWarningAt } : {}),
          ...(params.dismissedSeverity
            ? {
                dismissedSeverity: params.dismissedSeverity,
                dismissedAt: params.dismissedAt ?? Date.now(),
              }
            : {}),
          ...(params.mutedSeverity
            ? {
                mutedSeverity: params.mutedSeverity,
                mutedAt: params.mutedAt ?? Date.now(),
              }
            : {}),
        };
    const nextState: ThreadOverlayState = {
      ...current,
      ...(nextNotice ? { toolIncidentNotice: nextNotice } : {}),
    };
    if (!nextNotice) delete nextState.toolIncidentNotice;
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadArchiveTombstone(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    archivedAt?: number;
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
      archiveTombstonedAt: params.archivedAt,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadScheduledStart(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    scheduledStart?: ThreadOverlayState["scheduledStart"];
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
      scheduledStart: params.scheduledStart,
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

  async addRemoteThreadPin(params: {
    ref: FederatedThreadRef;
    summary?: NavigationThreadSummary;
    instanceLabel: string;
    addedAt?: number;
    pinnedVia?: RemoteThreadPin["pinnedVia"];
  }): Promise<RemoteThreadPin> {
    const instanceId = remotePinInstanceId(params.ref);
    const addedAt = params.addedAt ?? Date.now();
    const payload = JSON.stringify({
      instanceLabel: params.instanceLabel,
      summary: params.summary ? stripFederationStamp(params.summary) : undefined,
      pinnedVia: params.pinnedVia,
    });
    this.stateDb.raw
      .prepare(
        `INSERT INTO remote_thread_pins(
           instance_id,
           backend,
           thread_id,
           added_at,
           payload
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(instance_id, backend, thread_id) DO UPDATE SET
           payload = excluded.payload,
           -- Pinning is unambiguous intent that this row should be live.
           -- Leaving a tombstone in place would swallow the click: the pin
           -- succeeds in the db and never appears in the list. Restoring on
           -- reconnect is best-effort, so the invariant has to hold here too
           -- rather than depend on that hook having run.
           revoked_at = NULL`,
      )
      .run(instanceId, params.ref.backend, params.ref.threadId, addedAt, payload);
    await this.rememberRemoteThreadTarget({
      instanceId,
      instanceLabel: params.instanceLabel,
      backend: params.ref.backend,
      threadId: params.ref.threadId,
      observedAt: addedAt,
    });
    const row = this.stateDb.raw
      .prepare(
        `SELECT added_at FROM remote_thread_pins
         WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
      )
      .get(instanceId, params.ref.backend, params.ref.threadId) as
        | { added_at: number }
        | undefined;
    return {
      ref: params.ref,
      addedAt: row?.added_at ?? addedAt,
      instanceLabel: params.instanceLabel,
      ...(params.summary ? { summary: stripFederationStamp(params.summary) } : {}),
      ...(params.pinnedVia ? { pinnedVia: params.pinnedVia } : {}),
    };
  }

  async rememberRemoteThreadTarget(params: {
    instanceId: RemoteThreadTarget["instanceId"];
    instanceLabel: string;
    backend: RemoteThreadTarget["backend"];
    threadId: string;
    observedAt?: number;
  }): Promise<RemoteThreadTarget> {
    const instanceId = params.instanceId.trim();
    const instanceLabel = params.instanceLabel.trim() || instanceId;
    const threadId = params.threadId.trim();
    if (!instanceId || !threadId) {
      throw new Error("Remote thread targets require instance and thread ids.");
    }
    const observedAt = params.observedAt ?? Date.now();
    this.stateDb.raw
      .prepare(
        `INSERT INTO remote_thread_targets(
           instance_id,
           backend,
           thread_id,
           instance_label,
           first_seen_at,
           last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id, backend, thread_id) DO UPDATE SET
           instance_label = excluded.instance_label,
           last_seen_at = MAX(remote_thread_targets.last_seen_at, excluded.last_seen_at)`,
      )
      .run(
        instanceId,
        params.backend,
        threadId,
        instanceLabel,
        observedAt,
        observedAt,
      );
    const row = this.stateDb.raw
      .prepare(
        `SELECT instance_id, backend, thread_id, instance_label,
                first_seen_at, last_seen_at
         FROM remote_thread_targets
         WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
      )
      .get(instanceId, params.backend, threadId) as RemoteThreadTargetRow;
    return remoteThreadTargetFromRow(row);
  }

  async listRemoteThreadTargets(params: {
    backend: RemoteThreadTarget["backend"];
    threadId: string;
  }): Promise<RemoteThreadTarget[]> {
    const threadId = params.threadId.trim();
    if (!threadId) {
      return [];
    }
    const rows = this.stateDb.raw
      .prepare(
        `SELECT instance_id, backend, thread_id, instance_label,
                first_seen_at, last_seen_at
         FROM remote_thread_targets
         WHERE backend = ? AND thread_id = ?
         ORDER BY last_seen_at DESC, instance_id ASC`,
      )
      .all(params.backend, threadId) as RemoteThreadTargetRow[];
    return rows.map(remoteThreadTargetFromRow);
  }

  /**
   * Set or clear the VIEWER-owned rank for a pinned remote thread. Patches
   * the payload in place so the cached summary, label, and pinnedVia are
   * untouched; a missing pin row is a no-op (returns undefined rank).
   */
  async setRemoteThreadLocalPin(params: {
    ref: FederatedThreadRef;
    pinnedRank?: string | null;
  }): Promise<{ pinnedRank?: string }> {
    const instanceId = remotePinInstanceId(params.ref);
    const row = this.stateDb.raw
      .prepare(
        `SELECT payload FROM remote_thread_pins
         WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
      )
      .get(instanceId, params.ref.backend, params.ref.threadId) as
        | { payload: string }
        | undefined;
    if (!row) {
      return {};
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const pinnedRank = params.pinnedRank?.trim() || undefined;
    if (pinnedRank === undefined) {
      delete parsed.localPinnedRank;
    } else {
      parsed.localPinnedRank = pinnedRank;
    }
    this.stateDb.raw
      .prepare(
        `UPDATE remote_thread_pins
         SET payload = ?
         WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
      )
      .run(
        JSON.stringify(parsed),
        instanceId,
        params.ref.backend,
        params.ref.threadId,
      );
    return pinnedRank === undefined ? {} : { pinnedRank };
  }

  /**
   * Local threads' pin ranks (with sub-thread linkage), scanned from the
   * overlay payloads. Cheap one-shot read for pin-visibility decisions that
   * must not pay for a full navigation snapshot build.
   */
  async listPinnedThreadOverlayRanks(): Promise<
    Array<{ pinnedRank: string; parentThreadId?: string }>
  > {
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM threads")
      .all() as Array<{ payload: string }>;
    const ranks: Array<{ pinnedRank: string; parentThreadId?: string }> = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as {
          pinnedRank?: unknown;
          parentThreadId?: unknown;
        };
        if (typeof parsed.pinnedRank === "string" && parsed.pinnedRank) {
          ranks.push({
            pinnedRank: parsed.pinnedRank,
            ...(typeof parsed.parentThreadId === "string" && parsed.parentThreadId
              ? { parentThreadId: parsed.parentThreadId }
              : {}),
          });
        }
      } catch {
        // Malformed payloads never block a best-effort visibility check.
      }
    }
    return ranks;
  }

  /**
   * Whether a LIVE pin exists. A tombstoned row must answer false: callers
   * ask this to decide whether they still need to pin something, and a
   * hidden row cannot satisfy that. Counting one would, for instance, let
   * companion-parent pinning skip a parent that never renders, leaving its
   * child as a bare top-level row.
   */
  async hasRemoteThreadPin(params: { ref: FederatedThreadRef }): Promise<boolean> {
    const row = this.stateDb.raw
      .prepare(
        `SELECT 1 FROM remote_thread_pins
         WHERE instance_id = ? AND backend = ? AND thread_id = ?
           AND revoked_at IS NULL`,
      )
      .get(
        remotePinInstanceId(params.ref),
        params.ref.backend,
        params.ref.threadId,
      );
    return row !== undefined;
  }

  async removeRemoteThreadPin(params: { ref: FederatedThreadRef }): Promise<boolean> {
    const result = this.stateDb.raw
      .prepare(
        `DELETE FROM remote_thread_pins
         WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
      )
      .run(
        remotePinInstanceId(params.ref),
        params.ref.backend,
        params.ref.threadId,
      );
    return result.changes > 0;
  }

  /**
   * Live pins, newest first. Tombstoned rows (owning instance revoked or
   * its gateway pairing forgotten) are excluded by default: we know they
   * are unreachable FOR CAUSE, so unlike a peer that is merely offline
   * they must not sit in the list dimming. Pass `includeRevoked` for
   * impact counts and restore bookkeeping.
   */
  async listRemoteThreadPins(options?: {
    includeRevoked?: boolean;
  }): Promise<RemoteThreadPin[]> {
    // Two fully-written statements rather than one with an interpolated
    // WHERE: the SQL guard rejects assembled query text outright, and a
    // literal pair is what the rest of this file does.
    const rows = this.stateDb.raw
      .prepare(
        options?.includeRevoked
          ? `SELECT instance_id, backend, thread_id, added_at, payload, revoked_at
             FROM remote_thread_pins
             ORDER BY added_at DESC`
          : `SELECT instance_id, backend, thread_id, added_at, payload, revoked_at
             FROM remote_thread_pins
             WHERE revoked_at IS NULL
             ORDER BY added_at DESC`,
      )
      .all() as Array<{
        instance_id: string;
        backend: string;
        thread_id: string;
        added_at: number;
        payload: string;
        revoked_at: number | null;
      }>;
    const pins: RemoteThreadPin[] = [];
    for (const row of rows) {
      let parsed: {
        instanceLabel?: unknown;
        summary?: unknown;
        pinnedVia?: unknown;
        localPinnedRank?: unknown;
      };
      try {
        parsed = JSON.parse(row.payload) as typeof parsed;
      } catch {
        // A malformed payload must not break the whole list; the row still
        // identifies a pinned thread and can be re-hydrated on the next fetch.
        parsed = {};
      }
      pins.push({
        ref: buildFederatedThreadRef({
          backend: row.backend as FederatedThreadRef["backend"],
          instanceId: row.instance_id,
          threadId: row.thread_id,
        }),
        addedAt: row.added_at,
        instanceLabel:
          typeof parsed.instanceLabel === "string" && parsed.instanceLabel
            ? parsed.instanceLabel
            : row.instance_id,
        ...(parsed.summary && typeof parsed.summary === "object"
          ? { summary: parsed.summary as NavigationThreadSummary }
          : {}),
        ...(parsed.pinnedVia === "child"
          || parsed.pinnedVia === "companion"
          || parsed.pinnedVia === "explicit"
          ? { pinnedVia: parsed.pinnedVia }
          : {}),
        ...(typeof parsed.localPinnedRank === "string" && parsed.localPinnedRank
          ? { localPinnedRank: parsed.localPinnedRank }
          : {}),
        ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
      });
    }
    return pins;
  }

  async updateRemoteThreadPinSnapshots(
    entries: Array<{
      ref: FederatedThreadRef;
      summary: NavigationThreadSummary;
      instanceLabel: string;
    }>,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const select = this.stateDb.raw.prepare(
      `SELECT payload FROM remote_thread_pins
       WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
    );
    const update = this.stateDb.raw.prepare(
      `UPDATE remote_thread_pins
       SET payload = ?
       WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
    );
    this.stateDb.raw.transaction(() => {
      for (const entry of entries) {
        const instanceId = remotePinInstanceId(entry.ref);
        // Patch, never replace: the payload also carries viewer-owned state
        // (localPinnedRank, pinnedVia) that a snapshot refresh must not wipe.
        const row = select.get(instanceId, entry.ref.backend, entry.ref.threadId) as
          | { payload: string }
          | undefined;
        let parsed: Record<string, unknown> = {};
        if (row) {
          try {
            parsed = JSON.parse(row.payload) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
        }
        const nextPayload = JSON.stringify({
          ...parsed,
          instanceLabel: entry.instanceLabel,
          summary: stripFederationStamp(entry.summary),
        });
        // The merge re-serves cached rows on every navigation refresh;
        // skip the write when nothing actually changed.
        if (row && row.payload === nextPayload) {
          continue;
        }
        update.run(
          nextPayload,
          instanceId,
          entry.ref.backend,
          entry.ref.threadId,
        );
      }
    })();
  }

  /**
   * Permanently drop every pin owned by one instance. This is the operator
   * explicitly choosing "forget these threads" at revoke time — the
   * default path tombstones instead, because revoke-then-re-enroll to
   * repair a peer is common and losing the curated list would be hostile.
   * Returns the number of pins removed.
   */
  async removeRemoteThreadPinsForInstance(params: {
    instanceId: string;
  }): Promise<number> {
    const result = this.stateDb.raw
      .prepare("DELETE FROM remote_thread_pins WHERE instance_id = ?")
      .run(params.instanceId);
    return result.changes;
  }

  /**
   * Hide one instance's pins without discarding them. Already-tombstoned
   * rows keep their original timestamp so a second revoke does not restate
   * when the list was actually put away.
   */
  async tombstoneRemoteThreadPinsForInstance(params: {
    instanceId: string;
    revokedAt?: number;
  }): Promise<number> {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE remote_thread_pins
         SET revoked_at = ?
         WHERE instance_id = ? AND revoked_at IS NULL`,
      )
      .run(params.revokedAt ?? Date.now(), params.instanceId);
    return result.changes;
  }

  /** Bring one instance's tombstoned pins back after a re-enrollment. */
  async restoreRemoteThreadPinsForInstance(params: {
    instanceId: string;
  }): Promise<number> {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE remote_thread_pins
         SET revoked_at = NULL
         WHERE instance_id = ? AND revoked_at IS NOT NULL`,
      )
      .run(params.instanceId);
    return result.changes;
  }

  /**
   * Live vs tombstoned pin counts, keyed by instance. Drives the
   * keep-or-forget prompt, which must stay hidden when the operator has
   * nothing pinned from the affected instances — there would be nothing to
   * decide. One grouped read rather than a query per instance: the caller
   * needs several at once and an absent instance is simply a missing key.
   */
  async countRemoteThreadPinsByInstance(): Promise<
    Map<string, { live: number; revoked: number }>
  > {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT
           instance_id,
           SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS live,
           SUM(CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END) AS revoked
         FROM remote_thread_pins
         GROUP BY instance_id`,
      )
      .all() as Array<{
        instance_id: string;
        live: number | null;
        revoked: number | null;
      }>;
    return new Map(
      rows.map((row) => [
        row.instance_id,
        { live: row.live ?? 0, revoked: row.revoked ?? 0 },
      ]),
    );
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
   * Record that this thread was created by forking `forkSourceThreadId`, and/or
   * flip the one-time `forkBaselineCaptured` guard once the fork-point
   * inherited-usage line has been persisted. Pricing reads `forkSourceThreadId`
   * as the authoritative "this thread inherited a copied-in history" signal so
   * the fork-point context is never re-billed on the fork. See
   * `ThreadOverlayState.forkSourceThreadId`.
   */
  async setThreadForkOrigin(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    forkSourceThreadId?: string;
    forkBaselineCaptured?: boolean;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const forkSourceThreadId =
      params.forkSourceThreadId?.trim() || current.forkSourceThreadId;
    const nextState: ThreadOverlayState = {
      ...current,
      ...(forkSourceThreadId ? { forkSourceThreadId } : {}),
      ...(params.forkBaselineCaptured !== undefined
        ? { forkBaselineCaptured: params.forkBaselineCaptured }
        : {}),
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
    /**
     * Keys owned by remote thread pins: their rank writes patch the
     * remote_thread_pins payload (viewer-owned) instead of the local thread
     * overlay, inside the same transaction so a mixed reorder is atomic.
     */
    remoteRefsByKey?: Record<string, FederatedThreadRef>;
  }): Promise<Record<string, string>> {
    const pinnedRanks: Record<string, string> = {};
    const selectRemote = this.stateDb.raw.prepare(
      `SELECT payload FROM remote_thread_pins
       WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
    );
    const updateRemote = this.stateDb.raw.prepare(
      `UPDATE remote_thread_pins
       SET payload = ?
       WHERE instance_id = ? AND backend = ? AND thread_id = ?`,
    );
    const write = this.stateDb.raw.transaction(() => {
      let rankIndex = 0;
      for (const threadKey of params.threadKeys) {
        const remoteRef = params.remoteRefsByKey?.[threadKey];
        if (remoteRef) {
          const instanceId = remotePinInstanceId(remoteRef);
          const row = selectRemote.get(
            instanceId,
            remoteRef.backend,
            remoteRef.threadId,
          ) as { payload: string } | undefined;
          if (!row) {
            continue;
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.payload) as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          rankIndex += 1;
          const pinnedRank = String(rankIndex * 1024);
          pinnedRanks[threadKey] = pinnedRank;
          parsed.localPinnedRank = pinnedRank;
          updateRemote.run(
            JSON.stringify(parsed),
            instanceId,
            remoteRef.backend,
            remoteRef.threadId,
          );
          continue;
        }
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
    parentThreadBackend?: ThreadOverlayState["backend"] | null;
    parentThreadInstanceId?: string | null;
  }): Promise<ThreadOverlayState> {
    if (
      params.parentThreadId === params.threadId
      && (!params.parentThreadBackend || params.parentThreadBackend === params.backend)
    ) {
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
    const parentThreadBackend = parentThreadId
      ? params.parentThreadBackend ?? params.backend
      : undefined;
    const parentThreadInstanceId = parentThreadId
      ? params.parentThreadInstanceId?.trim() || undefined
      : undefined;
    const nextState: ThreadOverlayState = {
      ...current,
      parentThreadId: parentThreadId || undefined,
      parentThreadBackend,
      parentThreadInstanceId,
      pinnedRank: parentThreadId ? undefined : current.pinnedRank,
    };
    this.putThread(threadKey, nextState);
    if (parentThreadId && !parentThreadInstanceId) {
      const parentKey = buildThreadIdentityKey(parentThreadBackend!, parentThreadId);
      const parent = this.getThread(parentKey) ?? {
        backend: parentThreadBackend!,
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
      ...this.getDirectoryOverlay(params.directoryKey),
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
          ...this.getDirectoryOverlay(directoryKey),
          directoryKey,
          pinnedRank,
        });
      });
    });
    write();
    return pinnedRanks;
  }

  async setDirectoryThreadsCollapsed(params: {
    directoryKey: string;
    collapsed: boolean;
  }): Promise<DirectoryOverlayState> {
    const nextState: DirectoryOverlayState = {
      ...this.getDirectoryOverlay(params.directoryKey),
      directoryKey: params.directoryKey,
      directoryThreadsCollapsed: params.collapsed,
    };
    this.putDirectoryOverlay(params.directoryKey, nextState);
    return nextState;
  }

  /**
   * Persist a remote window's disclosure locally without changing either the
   * owning instance's overlay or this viewer's same-path local directory.
   */
  async setRemoteDirectoryThreadsCollapsed(params: {
    instanceId: string;
    directoryKey: string;
    collapsed: boolean;
  }): Promise<DirectoryOverlayState> {
    const current = this.stateDb.raw
      .prepare(
        `SELECT payload FROM remote_directory_overlay
         WHERE instance_id = ? AND directory_key = ?`,
      )
      .get(params.instanceId, params.directoryKey) as
        | { payload: string }
        | undefined;
    const nextState: DirectoryOverlayState = {
      ...(current
        ? JSON.parse(current.payload) as DirectoryOverlayState
        : {}),
      directoryKey: params.directoryKey,
      directoryThreadsCollapsed: params.collapsed,
    };
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO remote_directory_overlay(
           instance_id,
           directory_key,
           payload
         ) VALUES (?, ?, ?)`,
      )
      .run(params.instanceId, params.directoryKey, JSON.stringify(nextState));
    return nextState;
  }

  async readRemoteDirectoryOverlays(params: {
    instanceId: string;
  }): Promise<Record<string, DirectoryOverlayState>> {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT directory_key, payload FROM remote_directory_overlay
         WHERE instance_id = ?`,
      )
      .all(params.instanceId) as Array<{
        directory_key: string;
        payload: string;
      }>;
    return Object.fromEntries(
      rows.map((row) => [
        row.directory_key,
        JSON.parse(row.payload) as DirectoryOverlayState,
      ]),
    );
  }

  async getDirectoryOverlayState(params: {
    directoryKey: string;
  }): Promise<DirectoryOverlayState | undefined> {
    return this.getDirectoryOverlay(params.directoryKey);
  }

  async readAllDirectoryOverlays(): Promise<Record<string, DirectoryOverlayState>> {
    return this.readAllDirectoryOverlaysSync();
  }

  async readStarMapArrangement(): Promise<StarMapArrangementEntry[]> {
    const rows = this.stateDb.raw
      .prepare("SELECT payload FROM star_map_arrangement")
      .all() as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as unknown)
      .filter(isStarMapArrangementEntry)
      .map(normalizeStarMapArrangementEntry);
  }

  /**
   * LWW-merge arrangement entries into the table. Returns the accepted
   * (newer-than-stored) entries so the federation layer re-broadcasts
   * deltas only; an empty accepted list means the merge was a no-op.
   */
  async mergeStarMapArrangement(
    incoming: StarMapArrangementEntry[],
  ): Promise<{ accepted: StarMapArrangementEntry[] }> {
    const accepted: StarMapArrangementEntry[] = [];
    const write = this.stateDb.raw.transaction(() => {
      const select = this.stateDb.raw.prepare(
        "SELECT payload FROM star_map_arrangement WHERE entry_key = ?",
      );
      const upsert = this.stateDb.raw.prepare(
        `INSERT OR REPLACE INTO star_map_arrangement(entry_key, payload)
         VALUES (?, ?)`,
      );
      for (const rawEntry of incoming) {
        const entry = normalizeStarMapArrangementEntry(rawEntry);
        if (!isStarMapArrangementEntry(entry)) continue;
        const storageEntry = encodeStarMapArrangementEntryForStorage(entry);
        const key = starMapArrangementEntryKey(storageEntry);
        const row = select.get(key) as { payload: string } | undefined;
        const existing = row
          ? normalizeStarMapArrangementEntry(
              JSON.parse(row.payload) as StarMapArrangementEntry,
            )
          : undefined;
        const merged = mergeStarMapArrangementEntries(
          existing ? [existing] : [],
          [entry],
        );
        if (!merged.changed) continue;
        upsert.run(key, JSON.stringify(storageEntry));
        accepted.push(entry);
      }
    });
    write();
    return { accepted };
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
    const fetchedAt = params.fetchedAt ?? Date.now();
    if (
      current.prsFetchedAt !== undefined
      && current.prsFetchedAt > fetchedAt
    ) {
      return current;
    }
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
      prsFetchedAt: fetchedAt,
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
      `INSERT INTO pr_status_cache(
         pr_key,
         provider,
         org,
         repo,
         number,
         fetched_at,
         payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr_key) DO UPDATE SET
         provider = excluded.provider,
         org = excluded.org,
         repo = excluded.repo,
         number = excluded.number,
         fetched_at = excluded.fetched_at,
         payload = excluded.payload
       WHERE excluded.fetched_at >= pr_status_cache.fetched_at`,
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
        `INSERT INTO pr_lookup_cache(
           lookup_key,
           provider,
           branch,
           directory_paths,
           fetched_at,
           payload
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lookup_key) DO UPDATE SET
           provider = excluded.provider,
           branch = excluded.branch,
           directory_paths = excluded.directory_paths,
           fetched_at = excluded.fetched_at,
           payload = excluded.payload
         WHERE excluded.fetched_at >= pr_lookup_cache.fetched_at`,
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
    updatedAt?: number;
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
      executionModeUpdatedAt: params.updatedAt ?? Date.now(),
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

  async setTurnFailureCodexInvalidIdRecovery(params: {
    threadId: string;
    turnId: string;
    recovery: NonNullable<ThreadTurnFailure["codexInvalidIdRecovery"]>;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey("codex", params.threadId);
    const current = this.getThread(threadKey);
    const failureIndex = current?.turnFailureLog?.findIndex(
      (entry) => entry.turnId === params.turnId,
    ) ?? -1;
    if (!current || failureIndex === -1) {
      throw new Error(
        `Cannot record Codex invalid-ID recovery without failed turn ${params.turnId}`,
      );
    }
    const nextLog = [...current.turnFailureLog!];
    nextLog[failureIndex] = {
      ...nextLog[failureIndex]!,
      codexInvalidIdRecovery: params.recovery,
    };
    const nextState: ThreadOverlayState = {
      ...current,
      codexInvalidIdRecoveryLastAttemptedAt: params.recovery.attemptedAt,
      turnFailureLog: nextLog,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async appendQuestionnaireActivity(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    activity: ThreadQuestionnaireActivity;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const existing = current.questionnaireActivityLog ?? [];
    if (existing.some((entry) => entry.requestId === params.activity.requestId)) {
      return current;
    }
    const nextLog = [
      ...existing,
      params.activity,
    ].sort((left, right) => left.createdAt - right.createdAt);
    const trimmed =
      nextLog.length > MAX_QUESTIONNAIRE_ACTIVITY_LOG_ENTRIES
        ? nextLog.slice(nextLog.length - MAX_QUESTIONNAIRE_ACTIVITY_LOG_ENTRIES)
        : nextLog;
    const nextState: ThreadOverlayState = {
      ...current,
      questionnaireActivityLog: trimmed,
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
    modelMigrationRevision?: string;
    modelSettingsManuallyUpdatedAt?: number;
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const reasoningEffortsByModel = {
      ...(current.reasoningEffortsByModel ?? {}),
    };
    if (params.model && params.reasoningEffort) {
      reasoningEffortsByModel[params.model] = params.reasoningEffort;
    }
    const nextState: ThreadOverlayState = {
      ...current,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      reasoningEffortsByModel:
        Object.keys(reasoningEffortsByModel).length > 0
          ? reasoningEffortsByModel
          : undefined,
      modelMigrationRevision:
        params.modelMigrationRevision ?? current.modelMigrationRevision,
      modelSettingsManuallyUpdatedAt:
        params.modelSettingsManuallyUpdatedAt
        ?? current.modelSettingsManuallyUpdatedAt,
      serviceTier: params.serviceTier,
      fastMode: params.fastMode,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadPrAutoDispatchEnabled(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    enabled: boolean;
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
      prAutoDispatchEnabled: params.enabled,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async syncThreadPrAutoDispatchCandidates(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prKeys: string[];
    now: number;
  }): Promise<void> {
    const sync = this.stateDb.raw.transaction(() => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      const enabled = this.getThread(threadKey)?.prAutoDispatchEnabled === true;
      const prKeys = enabled ? [...new Set(params.prKeys)] : [];
      if (prKeys.length === 0) {
        this.stateDb.raw
          .prepare(
            `DELETE FROM pr_auto_dispatch_candidates
             WHERE backend = ? AND thread_id = ?`,
          )
          .run(params.backend, params.threadId);
        return;
      }

      const retainedPrKeys = new Set(prKeys);
      const existingCandidates = this.stateDb.raw
        .prepare(
          `SELECT pr_key
           FROM pr_auto_dispatch_candidates
           WHERE backend = ? AND thread_id = ?`,
        )
        .all(params.backend, params.threadId) as Array<{ pr_key: string }>;
      const removeCandidate = this.stateDb.raw.prepare(
        `DELETE FROM pr_auto_dispatch_candidates
         WHERE pr_key = ? AND backend = ? AND thread_id = ?`,
      );
      for (const candidate of existingCandidates) {
        if (!retainedPrKeys.has(candidate.pr_key)) {
          removeCandidate.run(candidate.pr_key, params.backend, params.threadId);
        }
      }
      const insert = this.stateDb.raw.prepare(
        `INSERT INTO pr_auto_dispatch_candidates(
           pr_key, backend, thread_id, eligible_since, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pr_key, backend, thread_id) DO UPDATE SET
           updated_at = excluded.updated_at`,
      );
      for (const prKey of prKeys) {
        insert.run(
          prKey,
          params.backend,
          params.threadId,
          params.now,
          params.now,
        );
      }
    });
    sync();
  }

  async getPrAutoDispatchCandidateWinner(params: {
    prKey: string;
  }): Promise<PrAutoDispatchCandidate | undefined> {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT pr_key, backend, thread_id, eligible_since
         FROM pr_auto_dispatch_candidates
         WHERE pr_key = ?
         ORDER BY eligible_since ASC, backend ASC, thread_id ASC`,
      )
      .all(params.prKey) as Array<{
        backend: ThreadOverlayState["backend"];
        eligible_since: number;
        pr_key: string;
        thread_id: string;
      }>;
    for (const row of rows) {
      const threadKey = buildThreadIdentityKey(row.backend, row.thread_id);
      if (this.getThread(threadKey)?.prAutoDispatchEnabled === true) {
        return {
          backend: row.backend,
          eligibleSince: row.eligible_since,
          prKey: row.pr_key,
          threadId: row.thread_id,
        };
      }
    }
    return undefined;
  }

  async resetThreadPrAutoDispatchForOperator(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<boolean> {
    const reset = this.stateDb.raw.transaction(() => {
      // A toggle off -> on is an explicit operator request to retry. Keep a
      // genuinely in-flight claim so another turn cannot launch alongside it,
      // but clear completed/failed/cancelled claims and the finite incident
      // budget so the current provider condition can be scheduled again.
      const claims = this.stateDb.raw
        .prepare(
          `DELETE FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ? AND status != 'dispatching'`,
        )
        .run(params.backend, params.threadId);
      const incidents = this.stateDb.raw
        .prepare(
          `DELETE FROM pr_auto_dispatch_incidents
           WHERE backend = ? AND thread_id = ?`,
        )
        .run(params.backend, params.threadId);
      return claims.changes > 0 || incidents.changes > 0;
    });
    return reset();
  }

  async scheduleThreadPrAutoDispatch(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    pending: ThreadPrAutoDispatchPending;
    prompt: string;
    maxAttempts: number;
    allowCancelledRearm?: boolean;
  }): Promise<PrAutoDispatchScheduleResult> {
    const schedule = this.stateDb.raw.transaction((): PrAutoDispatchScheduleResult => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      const current = this.getThread(threadKey);
      if (current?.prAutoDispatchEnabled !== true) {
        return { status: "disabled" };
      }

      const duplicate = this.stateDb.raw
        .prepare(
          `SELECT backend, thread_id, pr_key, status, payload
           FROM pr_auto_dispatch_claims
           WHERE pr_key = ? AND fingerprint = ?`,
        )
        .get(
          params.pending.prKey,
          params.pending.fingerprint,
        ) as (PrAutoDispatchClaimRow & {
          backend: ThreadOverlayState["backend"];
          thread_id: string;
        }) | undefined;
      if (duplicate) {
        if (
          duplicate.status === "deferred"
          || (
            params.allowCancelledRearm
            && ["cancelled", "resolved", "superseded"].includes(duplicate.status)
          )
        ) {
          this.stateDb.raw
            .prepare(
              `DELETE FROM pr_auto_dispatch_claims
               WHERE pr_key = ? AND fingerprint = ?`,
            )
            .run(
              params.pending.prKey,
              params.pending.fingerprint,
            );
        } else {
          const record = parsePrAutoDispatchPendingRecord(duplicate.payload);
          const sameThread =
            duplicate.backend === params.backend
            && duplicate.thread_id === params.threadId;
          return {
            status:
              sameThread && duplicate.status === "pending"
                ? "pending"
                : "duplicate",
            ...(sameThread && record ? { pending: record.pending } : {}),
          };
        }
      }

      const incident = this.readPrAutoDispatchIncident({
        backend: params.backend,
        threadId: params.threadId,
        prKey: params.pending.prKey,
      });
      if ((incident?.attempt_count ?? 0) >= params.maxAttempts) {
        return { status: "attempt-limit" };
      }

      const activeClaim = this.stateDb.raw
        .prepare(
          `SELECT pr_key, status, payload
           FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ?
             AND status IN ('pending', 'dispatching')
           LIMIT 1`,
        )
        .get(params.backend, params.threadId) as PrAutoDispatchClaimRow | undefined;
      if (activeClaim) {
        const activeRecord = parsePrAutoDispatchPendingRecord(activeClaim.payload);
        if (activeClaim.pr_key !== params.pending.prKey) {
          return {
            status: "pending",
            ...(activeRecord ? { pending: activeRecord.pending } : {}),
          };
        }
        if (activeClaim.status === "dispatching") {
          return { status: "pending" };
        }
        this.stateDb.raw
          .prepare(
            `UPDATE pr_auto_dispatch_claims
             SET status = 'superseded', updated_at = ?
             WHERE backend = ? AND thread_id = ? AND status = 'pending'`,
          )
          .run(
            params.pending.createdAt,
            params.backend,
            params.threadId,
          );
      }

      const payload = JSON.stringify({
        pending: params.pending,
        prompt: params.prompt,
      } satisfies PrAutoDispatchPendingRecord);
      const inserted = this.stateDb.raw
        .prepare(
          `INSERT OR IGNORE INTO pr_auto_dispatch_claims(
             backend, thread_id, pr_key, fingerprint, status,
             scheduled_at, created_at, updated_at, payload
           ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          params.backend,
          params.threadId,
          params.pending.prKey,
          params.pending.fingerprint,
          params.pending.scheduledAt,
          params.pending.createdAt,
          params.pending.createdAt,
          payload,
        );
      if (inserted.changes === 0) {
        return { status: "duplicate" };
      }

      const activeKinds = [
        ...new Set([
          ...parsePrAutoDispatchKinds(incident?.active_kinds ?? "[]"),
          ...params.pending.eventKinds,
        ]),
      ];
      this.stateDb.raw
        .prepare(
          `INSERT INTO pr_auto_dispatch_incidents(
             backend, thread_id, pr_key, attempt_count, active_kinds, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(backend, thread_id, pr_key) DO UPDATE SET
             active_kinds = excluded.active_kinds,
             updated_at = excluded.updated_at`,
        )
        .run(
          params.backend,
          params.threadId,
          params.pending.prKey,
          incident?.attempt_count ?? 0,
          JSON.stringify(activeKinds),
          params.pending.createdAt,
        );
      return { status: "scheduled", pending: params.pending };
    });
    return schedule.immediate();
  }

  async beginThreadPrAutoDispatch(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    fingerprint: string;
    leaseExpiresAt: number;
    maxAttempts: number;
    now: number;
    ownerId: string;
  }): Promise<
    | { status: "ready"; attemptCount: number; record: PrAutoDispatchPendingRecord }
    | { status: "disabled" | "stale" | "attempt-limit" }
  > {
    const begin = this.stateDb.raw.transaction(() => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      if (this.getThread(threadKey)?.prAutoDispatchEnabled !== true) {
        return { status: "disabled" as const };
      }
      const claim = this.stateDb.raw
        .prepare(
          `SELECT pr_key, status, payload
           FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .get(
          params.backend,
          params.threadId,
          params.fingerprint,
        ) as PrAutoDispatchClaimRow | undefined;
      const record = claim
        ? parsePrAutoDispatchPendingRecord(claim.payload)
        : undefined;
      if (!claim || claim.status !== "pending" || !record) {
        return { status: "stale" as const };
      }
      const incident = this.readPrAutoDispatchIncident({
        backend: params.backend,
        threadId: params.threadId,
        prKey: claim.pr_key,
      });
      if ((incident?.attempt_count ?? 0) >= params.maxAttempts) {
        this.updatePrAutoDispatchClaimStatus({
          ...params,
          status: "attempt-limit",
        });
        return { status: "attempt-limit" as const };
      }
      const updated = this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_claims
           SET status = 'dispatching', updated_at = ?, payload = ?
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?
             AND status = 'pending'`,
        )
        .run(
          params.now,
          JSON.stringify({
            ...record,
            dispatchLease: {
              expiresAt: params.leaseExpiresAt,
              ownerId: params.ownerId,
            },
          } satisfies PrAutoDispatchPendingRecord),
          params.backend,
          params.threadId,
          params.fingerprint,
        );
      if (updated.changes === 0) {
        return { status: "stale" as const };
      }
      const attemptCount = (incident?.attempt_count ?? 0) + 1;
      this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_incidents
           SET attempt_count = ?, updated_at = ?
           WHERE backend = ? AND thread_id = ? AND pr_key = ?`,
        )
        .run(
          attemptCount,
          params.now,
          params.backend,
          params.threadId,
          claim.pr_key,
        );
      return { status: "ready" as const, attemptCount, record };
    });
    return begin.immediate();
  }

  async getPrAutoDispatchBudgetStatus(params: {
    config: PrAutoDispatchBudgetConfig;
    now: number;
  }): Promise<PrAutoDispatchBudgetStatus> {
    const read = this.stateDb.raw.transaction(() => {
      const budget = this.readPrAutoDispatchBudget({
        config: params.config,
        now: params.now,
      });
      this.writePrAutoDispatchBudget({ budget, now: params.now });
      return this.toPrAutoDispatchBudgetStatus({
        budget,
        config: params.config,
      });
    });
    return read.immediate();
  }

  async resumePrAutoDispatchBudget(params: {
    config: PrAutoDispatchBudgetConfig;
    now: number;
  }): Promise<PrAutoDispatchBudgetStatus> {
    const resume = this.stateDb.raw.transaction(() => {
      const budget = this.readPrAutoDispatchBudget({
        config: params.config,
        now: params.now,
      });
      budget.pausedAt = undefined;
      this.writePrAutoDispatchBudget({ budget, now: params.now });
      return this.toPrAutoDispatchBudgetStatus({
        budget,
        config: params.config,
      });
    });
    return resume.immediate();
  }

  async reserveThreadPrAutoDispatchBudget(params: {
    backend: ThreadOverlayState["backend"];
    config: PrAutoDispatchBudgetConfig;
    fingerprint: string;
    now: number;
    ownerId: string;
    threadId: string;
  }): Promise<PrAutoDispatchBudgetReservationResult> {
    const reserve = this.stateDb.raw.transaction((): PrAutoDispatchBudgetReservationResult => {
      const claim = this.stateDb.raw
        .prepare(
          `SELECT status, payload
           FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .get(
          params.backend,
          params.threadId,
          params.fingerprint,
        ) as Pick<PrAutoDispatchClaimRow, "status" | "payload"> | undefined;
      const record = claim
        ? parsePrAutoDispatchPendingRecord(claim.payload)
        : undefined;
      const budget = this.readPrAutoDispatchBudget({
        config: params.config,
        now: params.now,
      });
      const status = this.toPrAutoDispatchBudgetStatus({
        budget,
        config: params.config,
      });
      if (
        !claim
        || claim.status !== "dispatching"
        || !record
        || record.dispatchLease?.ownerId !== params.ownerId
      ) {
        return { budget: status, status: "stale" };
      }
      if (budget.pausedAt !== undefined) {
        this.writePrAutoDispatchBudget({ budget, now: params.now });
        return {
          budget: this.toPrAutoDispatchBudgetStatus({
            budget,
            config: params.config,
          }),
          status: "paused",
        };
      }
      const existingReservation = this.stateDb.raw
        .prepare(
          `SELECT reserved_at
           FROM pr_auto_dispatch_budget_reservations
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .get(
          params.backend,
          params.threadId,
          params.fingerprint,
        ) as PrAutoDispatchBudgetReservationRow | undefined;
      if (existingReservation) {
        this.writePrAutoDispatchBudget({ budget, now: params.now });
        return {
          budget: this.toPrAutoDispatchBudgetStatus({
            budget,
            config: params.config,
          }),
          status: "stale",
        };
      }
      if (budget.tokens < 1) {
        const activeReservations = this.stateDb.raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM pr_auto_dispatch_budget_reservations`,
          )
          .get() as { count: number };
        if (
          params.config.pauseWhenEmpty
          && activeReservations.count === 0
          && budget.pausedAt === undefined
        ) {
          budget.pausedAt = params.now;
        }
        this.writePrAutoDispatchBudget({ budget, now: params.now });
        return {
          budget: this.toPrAutoDispatchBudgetStatus({
            budget,
            config: params.config,
          }),
          status: budget.pausedAt !== undefined ? "paused" : "empty",
        };
      }
      budget.tokens -= 1;
      this.writePrAutoDispatchBudget({ budget, now: params.now });
      this.stateDb.raw
        .prepare(
          `INSERT INTO pr_auto_dispatch_budget_reservations(
             backend, thread_id, fingerprint, reserved_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          params.backend,
          params.threadId,
          params.fingerprint,
          params.now,
        );
      return {
        budget: this.toPrAutoDispatchBudgetStatus({
          budget,
          config: params.config,
        }),
        status: "reserved",
      };
    });
    return reserve.immediate();
  }

  async rejectThreadPrAutoDispatchForBudget(params: {
    backend: ThreadOverlayState["backend"];
    fingerprint: string;
    now: number;
    ownerId: string;
    threadId: string;
  }): Promise<boolean> {
    const reject = this.stateDb.raw.transaction(() => {
      const claim = this.stateDb.raw
        .prepare(
          `SELECT pr_key, status, payload
           FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .get(
          params.backend,
          params.threadId,
          params.fingerprint,
        ) as PrAutoDispatchClaimRow | undefined;
      const record = claim
        ? parsePrAutoDispatchPendingRecord(claim.payload)
        : undefined;
      if (
        !claim
        || claim.status !== "dispatching"
        || !record
        || record.dispatchLease?.ownerId !== params.ownerId
      ) {
        return false;
      }
      const updated = this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_claims
           SET status = 'budget-exhausted', updated_at = ?, payload = ?
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?
             AND status = 'dispatching'`,
        )
        .run(
          params.now,
          JSON.stringify(clearPrAutoDispatchLease(record)),
          params.backend,
          params.threadId,
          params.fingerprint,
        );
      if (updated.changes === 0) {
        return false;
      }
      this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_incidents
           SET attempt_count = MAX(0, attempt_count - 1), updated_at = ?
           WHERE backend = ? AND thread_id = ? AND pr_key = ?`,
        )
        .run(
          params.now,
          params.backend,
          params.threadId,
          claim.pr_key,
        );
      return true;
    });
    return reject.immediate();
  }

  async restoreThreadPrAutoDispatchAfterBusy(params: {
    backend: ThreadOverlayState["backend"];
    budgetConfig: PrAutoDispatchBudgetConfig;
    threadId: string;
    fingerprint: string;
    ownerId: string;
    scheduledAt: number;
    now: number;
  }): Promise<ThreadPrAutoDispatchPending | undefined> {
    const restore = this.stateDb.raw.transaction(() => {
      const claim = this.stateDb.raw
        .prepare(
          `SELECT pr_key, status, payload
           FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .get(
          params.backend,
          params.threadId,
          params.fingerprint,
        ) as PrAutoDispatchClaimRow | undefined;
      const record = claim
        ? parsePrAutoDispatchPendingRecord(claim.payload)
        : undefined;
      if (!claim || claim.status !== "dispatching" || !record) {
        return undefined;
      }
      if (record.dispatchLease?.ownerId !== params.ownerId) {
        return undefined;
      }
      const pending = { ...record.pending, scheduledAt: params.scheduledAt };
      const pendingRecord = clearPrAutoDispatchLease({ ...record, pending });
      this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_claims
           SET status = 'pending', scheduled_at = ?, updated_at = ?, payload = ?
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?
             AND status = 'dispatching'`,
        )
        .run(
          params.scheduledAt,
          params.now,
          JSON.stringify(pendingRecord),
          params.backend,
          params.threadId,
          params.fingerprint,
        );
      this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_incidents
           SET attempt_count = MAX(0, attempt_count - 1), updated_at = ?
           WHERE backend = ? AND thread_id = ? AND pr_key = ?`,
        )
        .run(
          params.now,
          params.backend,
          params.threadId,
          claim.pr_key,
        );
      this.refundPrAutoDispatchBudgetReservation({
        backend: params.backend,
        config: params.budgetConfig,
        fingerprint: params.fingerprint,
        now: params.now,
        threadId: params.threadId,
      });
      return pending;
    });
    return restore.immediate();
  }

  async renewThreadPrAutoDispatchLease(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    fingerprint: string;
    leaseExpiresAt: number;
    now: number;
    ownerId: string;
  }): Promise<boolean> {
    const renew = this.stateDb.raw.transaction(() => {
      const claim = this.stateDb.raw
        .prepare(
          `SELECT pr_key, status, payload
           FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .get(
          params.backend,
          params.threadId,
          params.fingerprint,
        ) as PrAutoDispatchClaimRow | undefined;
      const record = claim
        ? parsePrAutoDispatchPendingRecord(claim.payload)
        : undefined;
      if (
        !claim
        || claim.status !== "dispatching"
        || !record
        || record.dispatchLease?.ownerId !== params.ownerId
      ) {
        return false;
      }
      const result = this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_claims
           SET updated_at = ?, payload = ?
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?
             AND status = 'dispatching'`,
        )
        .run(
          params.now,
          JSON.stringify({
            ...record,
            dispatchLease: {
              expiresAt: params.leaseExpiresAt,
              ownerId: params.ownerId,
            },
          } satisfies PrAutoDispatchPendingRecord),
          params.backend,
          params.threadId,
          params.fingerprint,
        );
      return result.changes > 0;
    });
    return renew();
  }

  async finishThreadPrAutoDispatch(params: {
    backend: ThreadOverlayState["backend"];
    budgetConfig: PrAutoDispatchBudgetConfig;
    threadId: string;
    fingerprint: string;
    ownerId: string;
    refundBudgetReservation?: boolean;
    status: "dispatched" | "failed";
    now: number;
  }): Promise<PrAutoDispatchBudgetCompletionResult | undefined> {
    const finish = this.stateDb.raw.transaction((): PrAutoDispatchBudgetCompletionResult | undefined => {
      const claim = this.stateDb.raw
        .prepare(
          `SELECT pr_key, status, payload
           FROM pr_auto_dispatch_claims
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .get(
          params.backend,
          params.threadId,
          params.fingerprint,
        ) as PrAutoDispatchClaimRow | undefined;
      const record = claim
        ? parsePrAutoDispatchPendingRecord(claim.payload)
        : undefined;
      if (
        !claim
        || claim.status !== "dispatching"
        || !record
        || record.dispatchLease?.ownerId !== params.ownerId
      ) {
        return undefined;
      }
      const budget = params.refundBudgetReservation
        ? this.refundPrAutoDispatchBudgetReservation({
            backend: params.backend,
            config: params.budgetConfig,
            fingerprint: params.fingerprint,
            now: params.now,
            threadId: params.threadId,
          })
        : this.readPrAutoDispatchBudget({
            config: params.budgetConfig,
            now: params.now,
          });
      if (!params.refundBudgetReservation) {
        this.stateDb.raw
          .prepare(
            `DELETE FROM pr_auto_dispatch_budget_reservations
             WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
          )
          .run(
            params.backend,
            params.threadId,
            params.fingerprint,
          );
      }
      const pausedNow =
        params.status === "dispatched"
        && params.budgetConfig.pauseWhenEmpty
        && budget.tokens < 1
        && budget.pausedAt === undefined;
      if (pausedNow) {
        budget.pausedAt = params.now;
      }
      this.writePrAutoDispatchBudget({ budget, now: params.now });
      this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_claims
           SET status = ?, updated_at = ?, payload = ?
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?
             AND status = 'dispatching'`,
        )
        .run(
          params.status,
          params.now,
          JSON.stringify(clearPrAutoDispatchLease(record)),
          params.backend,
          params.threadId,
          params.fingerprint,
        );
      return {
        budget: this.toPrAutoDispatchBudgetStatus({
          budget,
          config: params.budgetConfig,
        }),
        pausedNow,
      };
    });
    return finish.immediate();
  }

  async cancelThreadPrAutoDispatch(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    fingerprint: string;
    now?: number;
    status?: "cancelled" | "deferred" | "resolved" | "superseded";
  }): Promise<boolean> {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE pr_auto_dispatch_claims
         SET status = ?, updated_at = ?
         WHERE backend = ? AND thread_id = ? AND fingerprint = ?
           AND status = 'pending'`,
      )
      .run(
        params.status ?? "cancelled",
        params.now ?? Date.now(),
        params.backend,
        params.threadId,
        params.fingerprint,
      );
    return result.changes > 0;
  }

  async cancelPendingThreadPrAutoDispatchForPr(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prKey: string;
    now: number;
  }): Promise<boolean> {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE pr_auto_dispatch_claims
         SET status = 'superseded', updated_at = ?
         WHERE backend = ? AND thread_id = ? AND pr_key = ?
           AND status = 'pending'`,
      )
      .run(params.now, params.backend, params.threadId, params.prKey);
    return result.changes > 0;
  }

  async resolveThreadPrAutoDispatchIncident(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prKey: string;
    resolvedKinds: ThreadPrAutoDispatchEventKind[];
    now: number;
  }): Promise<void> {
    if (params.resolvedKinds.length === 0) return;
    const resolve = this.stateDb.raw.transaction(() => {
      const incident = this.readPrAutoDispatchIncident(params);
      if (!incident) return;
      const resolved = new Set(params.resolvedKinds);
      const activeKinds = parsePrAutoDispatchKinds(incident.active_kinds)
        .filter((kind) => !resolved.has(kind));
      if (activeKinds.length === 0) {
        this.stateDb.raw
          .prepare(
            `DELETE FROM pr_auto_dispatch_incidents
             WHERE backend = ? AND thread_id = ? AND pr_key = ?`,
          )
          .run(params.backend, params.threadId, params.prKey);
        return;
      }
      this.stateDb.raw
        .prepare(
          `UPDATE pr_auto_dispatch_incidents
           SET active_kinds = ?, updated_at = ?
           WHERE backend = ? AND thread_id = ? AND pr_key = ?`,
        )
        .run(
          JSON.stringify(activeKinds),
          params.now,
          params.backend,
          params.threadId,
          params.prKey,
        );
    });
    resolve();
  }

  async getThreadPrAutoDispatchPending(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<PrAutoDispatchPendingRecord | undefined> {
    return this.readThreadPrAutoDispatchPending(params);
  }

  async listPendingThreadPrAutoDispatches(): Promise<Array<
    PrAutoDispatchPendingRecord & {
      backend: ThreadOverlayState["backend"];
      threadId: string;
    }
  >> {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT backend, thread_id, payload
         FROM pr_auto_dispatch_claims
         WHERE status = 'pending'
         ORDER BY scheduled_at ASC`,
      )
      .all() as Array<{ backend: ThreadOverlayState["backend"]; thread_id: string; payload: string }>;
    return rows.flatMap((row) => {
      const record = parsePrAutoDispatchPendingRecord(row.payload);
      return record
        ? [{ ...record, backend: row.backend, threadId: row.thread_id }]
        : [];
    });
  }

  async recoverOrphanedThreadPrAutoDispatches(params: {
    budgetConfig: PrAutoDispatchBudgetConfig;
    now: number;
    scheduledAt: number;
  }): Promise<PrAutoDispatchRecoveryResult> {
    const recover = this.stateDb.raw.transaction((): PrAutoDispatchRecoveryResult => {
      const rows = this.stateDb.raw
        .prepare(
          `SELECT backend, thread_id, pr_key, fingerprint, payload
           FROM pr_auto_dispatch_claims
           WHERE status = 'dispatching'`,
        )
        .all() as Array<{
          backend: ThreadOverlayState["backend"];
          fingerprint: string;
          payload: string;
          pr_key: string;
          thread_id: string;
        }>;
      let nextLeaseExpiresAt: number | undefined;
      let recoveredCount = 0;
      for (const row of rows) {
        const record = parsePrAutoDispatchPendingRecord(row.payload);
        const leaseExpiresAt = record?.dispatchLease?.expiresAt;
        if (leaseExpiresAt !== undefined && leaseExpiresAt > params.now) {
          nextLeaseExpiresAt = nextLeaseExpiresAt === undefined
            ? leaseExpiresAt
            : Math.min(nextLeaseExpiresAt, leaseExpiresAt);
          continue;
        }
        if (!record) {
          continue;
        }
        const pending = { ...record.pending, scheduledAt: params.scheduledAt };
        const updated = this.stateDb.raw
          .prepare(
            `UPDATE pr_auto_dispatch_claims
             SET status = 'pending', scheduled_at = ?, updated_at = ?, payload = ?
             WHERE backend = ? AND thread_id = ? AND fingerprint = ?
               AND status = 'dispatching'`,
          )
          .run(
            params.scheduledAt,
            params.now,
            JSON.stringify(clearPrAutoDispatchLease({ ...record, pending })),
            row.backend,
            row.thread_id,
            row.fingerprint,
          );
        if (updated.changes === 0) {
          continue;
        }
        this.refundPrAutoDispatchBudgetReservation({
          backend: row.backend,
          config: params.budgetConfig,
          fingerprint: row.fingerprint,
          now: params.now,
          threadId: row.thread_id,
        });
        recoveredCount += 1;
        this.stateDb.raw
          .prepare(
            `UPDATE pr_auto_dispatch_incidents
             SET attempt_count = MAX(0, attempt_count - 1), updated_at = ?
             WHERE backend = ? AND thread_id = ? AND pr_key = ?`,
          )
          .run(params.now, row.backend, row.thread_id, row.pr_key);
      }
      return {
        ...(nextLeaseExpiresAt !== undefined ? { nextLeaseExpiresAt } : {}),
        recoveredCount,
      };
    });
    return recover.immediate();
  }

  async getThreadPrAutoDispatchAttemptCount(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prKey: string;
  }): Promise<number> {
    return this.readPrAutoDispatchIncident(params)?.attempt_count ?? 0;
  }

  async registerThreadPrStatusWatch(params: {
    watch: ThreadPullRequestWatchSummary;
    now: number;
  }): Promise<PrStatusWatchRegistrationResult> {
    const register = this.stateDb.raw.transaction(() => {
      const inserted = this.stateDb.raw
        .prepare(
          `INSERT OR IGNORE INTO pr_status_watches(
             watch_id, backend, thread_id, pr_key, head_sha,
             notify_on_success, notify_on_failure, status, attempt_count,
             lease_owner, lease_expires_at, created_at, updated_at, payload
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'watching', 0, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          params.watch.watchId,
          params.watch.backend,
          params.watch.threadId,
          params.watch.prKey,
          params.watch.headSha,
          params.watch.notifyOn.includes("success") ? 1 : 0,
          params.watch.notifyOn.includes("failure") ? 1 : 0,
          params.watch.createdAt,
          params.now,
          JSON.stringify(params.watch),
        );
      if (inserted.changes > 0) {
        return { status: "watching", watch: params.watch } as const;
      }
      const duplicate = this.stateDb.raw
        .prepare(
          `SELECT payload
           FROM pr_status_watches
           WHERE backend = ? AND thread_id = ? AND pr_key = ? AND head_sha = ?
             AND status IN ('watching', 'dispatching')
           LIMIT 1`,
        )
        .get(
          params.watch.backend,
          params.watch.threadId,
          params.watch.prKey,
          params.watch.headSha,
        ) as { payload: string } | undefined;
      const existing = duplicate
        ? parsePrStatusWatchSummary(duplicate.payload)
        : undefined;
      if (existing) {
        const notifyOn = [
          ...new Set([...existing.notifyOn, ...params.watch.notifyOn]),
        ];
        const merged: ThreadPullRequestWatchSummary = {
          ...existing,
          notifyOn,
          failureHandledByAutoFix:
            existing.failureHandledByAutoFix
            && params.watch.failureHandledByAutoFix,
        };
        this.stateDb.raw
          .prepare(
            `UPDATE pr_status_watches
             SET notify_on_success = ?, notify_on_failure = ?,
                 updated_at = ?, payload = ?
             WHERE watch_id = ? AND status IN ('watching', 'dispatching')`,
          )
          .run(
            notifyOn.includes("success") ? 1 : 0,
            notifyOn.includes("failure") ? 1 : 0,
            params.now,
            JSON.stringify(merged),
            existing.watchId,
          );
        return { status: "duplicate", watch: merged } as const;
      }
      return {
        status: "duplicate",
        watch: params.watch,
      } as const;
    });
    return register();
  }

  async claimThreadPrStatusWatches(params: {
    prKey: string;
    headSha: string;
    outcome: "success" | "failure";
    now: number;
    ownerId: string;
    leaseExpiresAt: number;
    maxAttempts: number;
  }): Promise<PrStatusWatchClaim[]> {
    const claim = this.stateDb.raw.transaction(() => {
      const activeDispatch = this.stateDb.raw
        .prepare(
          `SELECT 1
           FROM pr_status_watches
           WHERE pr_key = ? AND head_sha = ?
             AND status = 'dispatching'
             AND COALESCE(lease_expires_at, 0) > ?
           LIMIT 1`,
        )
        .get(params.prKey, params.headSha, params.now);
      if (activeDispatch) return [];

      const rows = this.stateDb.raw
        .prepare(
          `SELECT watch_id, attempt_count, payload
           FROM pr_status_watches
           WHERE pr_key = ? AND head_sha = ?
             AND (
               (? = 'success' AND notify_on_success = 1)
               OR (? = 'failure' AND notify_on_failure = 1)
             )
             AND attempt_count < ?
             AND (
               status = 'watching'
               OR (
                 status = 'dispatching'
                 AND COALESCE(lease_expires_at, 0) <= ?
               )
             )
           ORDER BY created_at ASC, watch_id ASC
           LIMIT 1`,
        )
        .all(
          params.prKey,
          params.headSha,
          params.outcome,
          params.outcome,
          params.maxAttempts,
          params.now,
        ) as Array<PrStatusWatchRow & { watch_id: string }>;
      const claimed: PrStatusWatchClaim[] = [];
      for (const row of rows) {
        const updated = this.stateDb.raw
          .prepare(
            `UPDATE pr_status_watches
             SET status = 'dispatching',
                 attempt_count = attempt_count + 1,
                 lease_owner = ?, lease_expires_at = ?, updated_at = ?
             WHERE watch_id = ?
               AND (
                 status = 'watching'
                 OR (
                   status = 'dispatching'
                   AND COALESCE(lease_expires_at, 0) <= ?
                 )
               )`,
          )
          .run(
            params.ownerId,
            params.leaseExpiresAt,
            params.now,
            row.watch_id,
            params.now,
          );
        const watch = parsePrStatusWatchSummary(row.payload);
        if (updated.changes > 0 && watch) {
          claimed.push({
            attemptCount: row.attempt_count + 1,
            watch,
          });
        }
      }
      return claimed;
    });
    return claim();
  }

  async releaseThreadPrStatusWatch(params: {
    watchId: string;
    ownerId: string;
    now: number;
    spendAttempt: boolean;
    maxAttempts: number;
  }): Promise<void> {
    const release = this.stateDb.raw.transaction(() => {
      const row = this.stateDb.raw
        .prepare(
          `SELECT attempt_count
           FROM pr_status_watches
           WHERE watch_id = ? AND status = 'dispatching' AND lease_owner = ?`,
        )
        .get(params.watchId, params.ownerId) as
        | { attempt_count: number }
        | undefined;
      if (!row) return;
      const attemptCount = params.spendAttempt
        ? row.attempt_count
        : Math.max(0, row.attempt_count - 1);
      const status = attemptCount >= params.maxAttempts ? "failed" : "watching";
      this.stateDb.raw
        .prepare(
          `UPDATE pr_status_watches
           SET status = ?, attempt_count = ?, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE watch_id = ? AND status = 'dispatching' AND lease_owner = ?`,
        )
        .run(
          status,
          attemptCount,
          params.now,
          params.watchId,
          params.ownerId,
        );
    });
    release();
  }

  async renewThreadPrStatusWatchLease(params: {
    watchId: string;
    ownerId: string;
    now: number;
    leaseExpiresAt: number;
  }): Promise<boolean> {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE pr_status_watches
         SET lease_expires_at = ?, updated_at = ?
         WHERE watch_id = ? AND status = 'dispatching' AND lease_owner = ?`,
      )
      .run(
        params.leaseExpiresAt,
        params.now,
        params.watchId,
        params.ownerId,
      );
    return result.changes > 0;
  }

  async finishThreadPrStatusWatch(params: {
    watchId: string;
    ownerId: string;
    prKey: string;
    headSha: string;
    outcome: "success" | "failure";
    now: number;
  }): Promise<void> {
    const finish = this.stateDb.raw.transaction(() => {
      const claimed = this.stateDb.raw
        .prepare(
          `SELECT 1
           FROM pr_status_watches
           WHERE watch_id = ? AND status = 'dispatching' AND lease_owner = ?`,
        )
        .get(params.watchId, params.ownerId);
      if (!claimed) return;
      this.stateDb.raw
        .prepare(
          `UPDATE pr_status_watches
           SET status = 'dispatched', lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE pr_key = ? AND head_sha = ?
             AND (
               (? = 'success' AND notify_on_success = 1)
               OR (? = 'failure' AND notify_on_failure = 1)
             )
             AND (
               status = 'watching'
               OR (watch_id = ? AND status = 'dispatching' AND lease_owner = ?)
             )`,
        )
        .run(
          params.now,
          params.prKey,
          params.headSha,
          params.outcome,
          params.outcome,
          params.watchId,
          params.ownerId,
        );
    });
    finish();
  }

  async supersedeThreadPrStatusWatches(params: {
    prKey: string;
    headSha: string;
    now: number;
  }): Promise<number> {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE pr_status_watches
         SET status = 'superseded', lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE pr_key = ? AND head_sha <> ?
           AND (
             status = 'watching'
             OR (
               status = 'dispatching'
               AND COALESCE(lease_expires_at, 0) <= ?
             )
           )`,
      )
      .run(params.now, params.prKey, params.headSha, params.now);
    return result.changes;
  }

  async listActiveThreadPrStatusWatches(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<ThreadPullRequestWatchSummary[]> {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT payload
         FROM pr_status_watches
         WHERE backend = ? AND thread_id = ?
           AND status IN ('watching', 'dispatching')
         ORDER BY created_at ASC`,
      )
      .all(params.backend, params.threadId) as Array<{ payload: string }>;
    return rows.flatMap((row) => {
      const watch = parsePrStatusWatchSummary(row.payload);
      return watch ? [watch] : [];
    });
  }

  async cancelThreadPrStatusWatchesForPr(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prKey: string;
    now: number;
  }): Promise<number> {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE pr_status_watches
         SET status = 'cancelled', lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE backend = ? AND thread_id = ? AND pr_key = ?
           AND (
             status = 'watching'
             OR (
               status = 'dispatching'
               AND COALESCE(lease_expires_at, 0) <= ?
             )
           )`,
      )
      .run(
        params.now,
        params.backend,
        params.threadId,
        params.prKey,
        params.now,
      );
    return result.changes;
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

  async setThreadMessagingPdfToolCatalogVersion(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    version: number;
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
      messagingPdfToolCatalogVersion: params.version,
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async setThreadMcpConnectionIds(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    connectionIds: string[];
  }): Promise<ThreadOverlayState> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.getThread(threadKey) ?? {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
    };
    const connectionIds = [
      ...new Set(params.connectionIds.map((id) => id.trim()).filter(Boolean)),
    ];
    const nextState: ThreadOverlayState = {
      ...current,
      ...(connectionIds.length > 0
        ? { mcpConnectionIds: connectionIds }
        : { mcpConnectionIds: undefined }),
    };
    this.putThread(threadKey, nextState);
    return nextState;
  }

  async turnOffCodexFastEverywhere(): Promise<{
    launchpadCount: number;
    threadCount: number;
    updatedThreadIds: string[];
  }> {
    const rows = this.stateDb.raw
      .prepare("SELECT thread_id, payload FROM threads")
      .all() as Array<{ thread_id: string; payload: string }>;
    let threadCount = 0;
    const updatedThreadIds: string[] = [];
    for (const row of rows) {
      try {
        const thread = JSON.parse(row.payload) as ThreadOverlayState;
        if (thread.backend !== "codex" || thread.fastMode !== true) {
          continue;
        }
        this.putThread(row.thread_id, {
          ...thread,
          fastMode: false,
        });
        updatedThreadIds.push(thread.threadId);
        threadCount += 1;
      } catch {
        // Ignore malformed cache rows. A later reconciliation can repair them.
      }
    }

    const launchpads = await this.listDirectoryLaunchpads();
    let launchpadCount = 0;
    for (const launchpad of launchpads) {
      if (launchpad.backend !== "codex" || launchpad.fastMode !== true) {
        continue;
      }
      await this.upsertDirectoryLaunchpad({
        ...launchpad,
        fastMode: false,
        updatedAt: Date.now(),
      });
      launchpadCount += 1;
    }

    const defaults = await this.getLaunchpadDefaults();
    await this.setLaunchpadDefaults({
      providerSettings: {
        ...(defaults.providerSettings ?? {}),
        codex: {
          ...(defaults.providerSettings?.codex ?? {}),
          fastMode: false,
          serviceTier: undefined,
        },
      },
      ...(defaults.backend === "codex"
        ? {
            fastMode: false,
            serviceTier: undefined,
          }
        : {}),
    });

    return { launchpadCount, threadCount, updatedThreadIds };
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
    const currentExpectedBranch = current.gitBranch?.trim() || undefined;
    const shouldApplyRequestedExpectedBranch = Boolean(
      requestedExpectedBranch &&
      (
        !currentExpectedBranch
        || requestedExpectedBranch === nextObservedBranch
      ),
    );
    const nextState: ThreadOverlayState = {
      ...current,
      gitBranch: shouldApplyRequestedExpectedBranch
        ? requestedExpectedBranch
        : currentExpectedBranch ?? fallbackExpectedBranch,
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

  private readPrAutoDispatchIncident(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    prKey: string;
  }): PrAutoDispatchIncidentRow | undefined {
    return this.stateDb.raw
      .prepare(
        `SELECT attempt_count, active_kinds
         FROM pr_auto_dispatch_incidents
         WHERE backend = ? AND thread_id = ? AND pr_key = ?`,
      )
      .get(params.backend, params.threadId, params.prKey) as
        | PrAutoDispatchIncidentRow
      | undefined;
  }

  private readPrAutoDispatchBudget(params: {
    config: PrAutoDispatchBudgetConfig;
    now: number;
  }): PrAutoDispatchBudgetState {
    const row = this.stateDb.raw
      .prepare(
        `SELECT tokens, updated_at, paused_at
         FROM pr_auto_dispatch_budget
         WHERE scope = 'profile'`,
      )
      .get() as PrAutoDispatchBudgetRow | undefined;
    const { capacity, refillPerMinute } = this.getPrAutoDispatchBudgetLimits(
      params.config,
    );
    const previousTokens = Math.max(0, row?.tokens ?? capacity);
    const elapsedMs = Math.max(0, params.now - (row?.updated_at ?? params.now));
    return {
      ...(row?.paused_at !== null && row?.paused_at !== undefined
        ? { pausedAt: row.paused_at }
        : {}),
      tokens: Math.min(
        capacity,
        previousTokens + (elapsedMs * refillPerMinute) / 60_000,
      ),
    };
  }

  private writePrAutoDispatchBudget(params: {
    budget: PrAutoDispatchBudgetState;
    now: number;
  }): void {
    this.stateDb.raw
      .prepare(
        `INSERT INTO pr_auto_dispatch_budget(scope, tokens, updated_at, paused_at)
         VALUES ('profile', ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           tokens = excluded.tokens,
           updated_at = excluded.updated_at,
           paused_at = excluded.paused_at`,
      )
      .run(
        params.budget.tokens,
        params.now,
        params.budget.pausedAt ?? null,
      );
  }

  private refundPrAutoDispatchBudgetReservation(params: {
    backend: ThreadOverlayState["backend"];
    config: PrAutoDispatchBudgetConfig;
    fingerprint: string;
    now: number;
    threadId: string;
  }): PrAutoDispatchBudgetState {
    const budget = this.readPrAutoDispatchBudget({
      config: params.config,
      now: params.now,
    });
    const reservation = this.stateDb.raw
      .prepare(
        `SELECT reserved_at
         FROM pr_auto_dispatch_budget_reservations
         WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
      )
      .get(
        params.backend,
        params.threadId,
        params.fingerprint,
      ) as PrAutoDispatchBudgetReservationRow | undefined;
    if (reservation) {
      this.stateDb.raw
        .prepare(
          `DELETE FROM pr_auto_dispatch_budget_reservations
           WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
        )
        .run(
          params.backend,
          params.threadId,
          params.fingerprint,
        );
      budget.tokens = Math.min(
        this.getPrAutoDispatchBudgetLimits(params.config).capacity,
        budget.tokens + 1,
      );
    }
    this.writePrAutoDispatchBudget({ budget, now: params.now });
    return budget;
  }

  private toPrAutoDispatchBudgetStatus(params: {
    budget: PrAutoDispatchBudgetState;
    config: PrAutoDispatchBudgetConfig;
  }): PrAutoDispatchBudgetStatus {
    const { capacity, refillPerMinute } = this.getPrAutoDispatchBudgetLimits(
      params.config,
    );
    return {
      availableTokens: Math.max(0, Math.floor(params.budget.tokens)),
      capacity,
      refillPerMinute,
      paused: params.budget.pausedAt !== undefined,
      ...(params.budget.pausedAt !== undefined
        ? { pausedAt: params.budget.pausedAt }
        : {}),
    };
  }

  private getPrAutoDispatchBudgetLimits(
    config: PrAutoDispatchBudgetConfig,
  ): Pick<PrAutoDispatchBudgetConfig, "capacity" | "refillPerMinute"> {
    return {
      capacity:
        Number.isFinite(config.capacity) && config.capacity > 0
          ? Math.floor(config.capacity)
          : 1,
      refillPerMinute:
        Number.isFinite(config.refillPerMinute) && config.refillPerMinute >= 0
          ? config.refillPerMinute
          : 0,
    };
  }

  private readThreadPrAutoDispatchPending(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): PrAutoDispatchPendingRecord | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT payload
         FROM pr_auto_dispatch_claims
         WHERE backend = ? AND thread_id = ? AND status = 'pending'
         LIMIT 1`,
      )
      .get(params.backend, params.threadId) as { payload: string } | undefined;
    return row ? parsePrAutoDispatchPendingRecord(row.payload) : undefined;
  }

  private updatePrAutoDispatchClaimStatus(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    fingerprint: string;
    status: "attempt-limit" | "dispatched" | "failed";
    now: number;
  }): void {
    this.stateDb.raw
      .prepare(
        `UPDATE pr_auto_dispatch_claims
         SET status = ?, updated_at = ?
         WHERE backend = ? AND thread_id = ? AND fingerprint = ?`,
      )
      .run(
        params.status,
        params.now,
        params.backend,
        params.threadId,
        params.fingerprint,
      );
  }

  private getThread(threadKey: string): ThreadOverlayState | undefined {
    const storageKey = encodeThreadIdentityKeyForStorage(threadKey);
    const row = this.stateDb.raw
      .prepare("SELECT payload FROM threads WHERE thread_id = ?")
      .get(storageKey) as { payload: string } | undefined;
    if (!row) return undefined;
    const overlay = normalizeThreadOverlayState(JSON.parse(row.payload));
    const pending = this.readThreadPrAutoDispatchPending({
      backend: overlay.backend,
      threadId: overlay.threadId,
    });
    return pending
      ? { ...overlay, prAutoDispatchPending: pending.pending }
      : overlay;
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
    // Execution-mode queue fields are registry-memory state. PR auto-dispatch
    // pending state is durable too, but its transactional claim table is the
    // source of truth; never duplicate either category in overlay JSON.
    const {
      queuedExecutionMode: _queuedExecutionMode,
      queuedExecutionModeAt: _queuedExecutionModeAt,
      prAutoDispatchPending: _prAutoDispatchPending,
      ...persistable
    } = state;
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        encodeThreadIdentityKeyForStorage(threadKey),
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
    if (!row) return undefined;
    const state = JSON.parse(row.payload) as {
      knownThreadKeys: string[];
      lastSnapshotHash?: string;
    };
    return {
      ...state,
      knownThreadKeys: state.knownThreadKeys.map((threadKey) =>
        normalizeThreadIdentityKey(threadKey) ?? threadKey
      ),
    };
  }

  private putBackend(
    scope: string,
    state: { knownThreadKeys: string[]; lastSnapshotHash?: string },
  ): void {
    this.stateDb.raw
      .prepare("INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)")
      .run(scope, JSON.stringify({
        ...state,
        knownThreadKeys: state.knownThreadKeys.map(
          encodeThreadIdentityKeyForStorage,
        ),
      }));
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

  private readThreadToolInvocationSync(
    invocationId: string,
  ): ThreadToolInvocationRecord | undefined {
    const row = this.stateDb.raw
      .prepare("SELECT * FROM thread_tool_invocations WHERE invocation_id = ?")
      .get(invocationId) as ThreadToolInvocationRow | undefined;
    return row ? threadToolInvocationFromRow(row) : undefined;
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

function normalizeThreadOverlayState(
  state: ThreadOverlayState,
): ThreadOverlayState {
  if (
    state.agent?.instructions === LEGACY_HANDOFF_AGENT_INSTRUCTIONS &&
    state.handoffOrigin &&
    (
      !state.handoffOrigin.taskTitle ||
      state.agent.name === state.handoffOrigin.taskTitle
    )
  ) {
    const { agent: _legacyHandoffAgent, ...withoutAgent } = state;
    return withoutAgent;
  }
  return state;
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
  turn_usage_attributed: number | null;
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

type ThreadToolInvocationRow = {
  invocation_id: string;
  finding_id: string | null;
  backend: ThreadToolInvocationRecord["backend"];
  thread_id: string;
  turn_id: string | null;
  item_id: string;
  tool_name: string;
  normalized_command: string | null;
  category: ThreadToolInvocationRecord["category"];
  status: ThreadToolInvocationStatus;
  started_at: number | null;
  completed_at: number | null;
  observed_at: number;
  updated_at: number;
  session_id: string | null;
  process_id: string | null;
  exit_code: number | null;
  output_chars: number;
  output_lines: number;
  estimated_output_tokens: number;
  warning_lines: number;
  error_lines: number;
  info_lines: number;
  debug_lines: number;
  output_truncated: number;
  output_state: ThreadToolInvocationRecord["outputState"] | null;
  source: NonNullable<ThreadToolInvocationRecord["source"]>;
  noisy: number;
  noisy_reason: string | null;
  suggested_prompt: string | null;
};

type ThreadToolInvocationSummaryRow = {
  category: ThreadToolInvocationSummary["category"];
  tool_name: string;
  invocation_count: number;
  output_chars: number;
  output_lines: number;
  estimated_output_tokens: number;
  warning_lines: number;
  error_lines: number;
  info_lines: number;
  debug_lines: number;
  noisy_invocation_count: number;
  last_observed_at: number;
};

type ThreadToolInvocationAlertRow = {
  alert_id: string;
  backend: ThreadToolInvocationAlert["backend"];
  thread_id: string;
  turn_id: string | null;
  kind: ThreadToolInvocationAlert["kind"];
  severity: ThreadToolInvocationAlert["severity"];
  tool_name: string;
  session_id: string | null;
  process_id: string | null;
  first_observed_at: number;
  last_observed_at: number;
  invocation_count: number;
  invocation_ids: string | null;
  total_output_chars: number;
  estimated_output_tokens: number;
  worst_invocation_id: string | null;
  worst_output_chars: number | null;
  average_interval_ms: number | null;
  message: string;
  suggested_prompt: string;
  created_at: number;
  updated_at: number;
};

type ThreadToolAnalysisRow = {
  analyzer_version: string;
  analyzed_at: number;
  completeness: ThreadToolAnalysisCoverage["completeness"];
  entry_count: number;
  invocation_count: number;
  missing_output_count: number;
  page_count: number;
  scanned_through: string | null;
  explanation: string | null;
};

function normalizeThreadToolInvocation(
  invocation: ThreadToolInvocationRecord,
): ThreadToolInvocationRecord {
  const outputChars = clampTokenCount(invocation.outputChars);
  const estimatedOutputTokens =
    invocation.estimatedOutputTokens > 0
      ? clampTokenCount(invocation.estimatedOutputTokens)
      : Math.ceil(outputChars / 4);
  return {
    ...invocation,
    estimatedOutputTokens,
    itemId: invocation.itemId.trim() || invocation.invocationId,
    outputChars,
    outputLines: clampTokenCount(invocation.outputLines),
    warningLines: clampTokenCount(invocation.warningLines),
    errorLines: clampTokenCount(invocation.errorLines),
    infoLines: clampTokenCount(invocation.infoLines),
    debugLines: clampTokenCount(invocation.debugLines),
    toolName: invocation.toolName.trim() || "unknown",
  };
}

function mergeThreadToolInvocationForUpsert(
  incoming: ThreadToolInvocationRecord,
  existing: ThreadToolInvocationRecord,
): ThreadToolInvocationRecord {
  const shouldAccumulateOutput =
    existing.status === "in_progress" &&
    incoming.status === "in_progress" &&
    incoming.outputChars > 0;
  const outputChars = shouldAccumulateOutput
    ? existing.outputChars + incoming.outputChars
    : Math.max(existing.outputChars, incoming.outputChars);
  return {
    ...incoming,
    ...(incoming.completedAt !== undefined
      ? { completedAt: incoming.completedAt }
      : existing.completedAt !== undefined
        ? { completedAt: existing.completedAt }
        : {}),
    ...(incoming.exitCode !== undefined
      ? { exitCode: incoming.exitCode }
      : existing.exitCode !== undefined
        ? { exitCode: existing.exitCode }
        : {}),
    ...(incoming.normalizedCommand
      ? { normalizedCommand: incoming.normalizedCommand }
      : existing.normalizedCommand
        ? { normalizedCommand: existing.normalizedCommand }
        : {}),
    ...(incoming.processId
      ? { processId: incoming.processId }
      : existing.processId
        ? { processId: existing.processId }
        : {}),
    ...(incoming.sessionId
      ? { sessionId: incoming.sessionId }
      : existing.sessionId
        ? { sessionId: existing.sessionId }
        : {}),
    ...(incoming.startedAt !== undefined || existing.startedAt !== undefined
      ? {
          startedAt: Math.min(
            incoming.startedAt ?? incoming.observedAt,
            existing.startedAt ?? existing.observedAt,
          ),
        }
      : {}),
    debugLines: shouldAccumulateOutput
      ? existing.debugLines + incoming.debugLines
      : Math.max(existing.debugLines, incoming.debugLines),
    estimatedOutputTokens: Math.ceil(outputChars / 4),
    errorLines: shouldAccumulateOutput
      ? existing.errorLines + incoming.errorLines
      : Math.max(existing.errorLines, incoming.errorLines),
    infoLines: shouldAccumulateOutput
      ? existing.infoLines + incoming.infoLines
      : Math.max(existing.infoLines, incoming.infoLines),
    noisy: existing.noisy || incoming.noisy,
    ...(incoming.noisyReason
      ? { noisyReason: incoming.noisyReason }
      : existing.noisyReason
        ? { noisyReason: existing.noisyReason }
        : {}),
    observedAt: Math.max(existing.observedAt, incoming.observedAt),
    outputChars,
    outputLines: shouldAccumulateOutput
      ? existing.outputLines + incoming.outputLines
      : Math.max(existing.outputLines, incoming.outputLines),
    outputTruncated: existing.outputTruncated || incoming.outputTruncated,
    status: terminalToolInvocationStatus(existing.status)
      ? existing.status
      : incoming.status,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
    warningLines: shouldAccumulateOutput
      ? existing.warningLines + incoming.warningLines
      : Math.max(existing.warningLines, incoming.warningLines),
  };
}

function terminalToolInvocationStatus(status: ThreadToolInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function normalizeThreadToolInvocationAlert(
  alert: ThreadToolInvocationAlert,
): ThreadToolInvocationAlert {
  const totalOutputChars = clampTokenCount(alert.totalOutputChars);
  return {
    ...alert,
    estimatedOutputTokens:
      alert.estimatedOutputTokens > 0
        ? clampTokenCount(alert.estimatedOutputTokens)
        : Math.ceil(totalOutputChars / 4),
    invocationCount: clampTokenCount(alert.invocationCount),
    totalOutputChars,
  };
}

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
    ...(existing.model ? { model: existing.model } : line.model ? { model: line.model } : {}),
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

  return repriceTokenUsageLine(merged);
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

function repriceTokenUsageLine(line: ThreadUsageLineRecord): ThreadUsageLineRecord {
  if (
    line.provider !== "openai"
    && line.provider !== "qwen"
    && line.provider !== "xai"
  ) {
    return line;
  }
  // Fork-baseline lines carry inherited context that was billed on the parent
  // thread. Their cost is $0 to this thread by definition — never re-price them
  // from their (large) inherited token counts. Strip catalog/rate/reason fields
  // (as the normal repricing path does) so a $0 "priced" line never carries a
  // stale rate id or priceUnavailableReason.
  if (line.scope === "fork-baseline") {
    const {
      priceUnavailableReason: _forkPriceUnavailableReason,
      pricingCatalogId: _forkPricingCatalogId,
      pricingCatalogVersion: _forkPricingCatalogVersion,
      pricingRateId: _forkPricingRateId,
      ...forkBaseLine
    } = line;
    return {
      ...forkBaseLine,
      cachedInputCostMicros: 0,
      outputCostMicros: 0,
      priceStatus: "priced",
      totalCostMicros: 0,
      uncachedInputCostMicros: 0,
    };
  }

  const cost = estimateTokenUsageCost({
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
    provider: cost?.provider ?? line.provider,
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
    turnUsageAttributed:
      typeof line.turnUsageAttributed === "boolean"
        ? line.turnUsageAttributed
          ? 1
          : 0
        : null,
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

function toThreadToolInvocationRowParams(
  invocation: ThreadToolInvocationRecord,
): Record<string, unknown> {
  return {
    backend: invocation.backend,
    category: invocation.category,
    completedAt: invocation.completedAt ?? null,
    debugLines: invocation.debugLines,
    errorLines: invocation.errorLines,
    estimatedOutputTokens: invocation.estimatedOutputTokens,
    exitCode: invocation.exitCode ?? null,
    infoLines: invocation.infoLines,
    invocationId: invocation.invocationId,
    findingId: invocation.findingId ?? null,
    itemId: invocation.itemId,
    noisy: invocation.noisy ? 1 : 0,
    noisyReason: invocation.noisyReason ?? null,
    normalizedCommand: invocation.normalizedCommand ?? null,
    observedAt: invocation.observedAt,
    outputChars: invocation.outputChars,
    outputLines: invocation.outputLines,
    outputTruncated: invocation.outputTruncated ? 1 : 0,
    outputState: invocation.outputState ?? null,
    processId: invocation.processId ?? null,
    sessionId: invocation.sessionId ?? null,
    source: invocation.source ?? "live",
    startedAt: invocation.startedAt ?? null,
    status: invocation.status,
    threadId: invocation.threadId,
    toolName: invocation.toolName,
    turnId: invocation.turnId ?? null,
    updatedAt: invocation.updatedAt,
    suggestedPrompt: invocation.suggestedPrompt ?? null,
    warningLines: invocation.warningLines,
  };
}

function toThreadToolInvocationAlertRowParams(
  alert: ThreadToolInvocationAlert,
): Record<string, unknown> {
  return {
    alertId: alert.alertId,
    averageIntervalMs: alert.averageIntervalMs ?? null,
    backend: alert.backend,
    createdAt: alert.createdAt,
    estimatedOutputTokens: alert.estimatedOutputTokens,
    firstObservedAt: alert.firstObservedAt,
    invocationCount: alert.invocationCount,
    invocationIds: alert.invocationIds
      ? JSON.stringify(alert.invocationIds)
      : null,
    kind: alert.kind,
    lastObservedAt: alert.lastObservedAt,
    message: alert.message,
    processId: alert.processId ?? null,
    sessionId: alert.sessionId ?? null,
    severity: alert.severity,
    suggestedPrompt: alert.suggestedPrompt,
    threadId: alert.threadId,
    turnId: alert.turnId ?? null,
    toolName: alert.toolName,
    totalOutputChars: alert.totalOutputChars,
    updatedAt: alert.updatedAt,
    worstInvocationId: alert.worstInvocationId ?? null,
    worstOutputChars: alert.worstOutputChars ?? null,
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
    ...(row.turn_usage_attributed !== null
      ? { turnUsageAttributed: Boolean(row.turn_usage_attributed) }
      : {}),
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

function normalizeStarMapArrangementEntry(
  entry: StarMapArrangementEntry,
): StarMapArrangementEntry {
  const threadKey = normalizeThreadIdentityKey(entry.threadKey);
  return threadKey && threadKey !== entry.threadKey
    ? { ...entry, threadKey }
    : entry;
}

function encodeThreadIdentityKeyForStorage(threadKey: string): string {
  return encodeLegacyThreadIdentityKey(threadKey) ?? threadKey;
}

function encodeStarMapArrangementEntryForStorage(
  entry: StarMapArrangementEntry,
): StarMapArrangementEntry {
  const threadKey = encodeThreadIdentityKeyForStorage(entry.threadKey);
  return threadKey !== entry.threadKey
    ? { ...entry, threadKey }
    : entry;
}

function threadToolInvocationFromRow(
  row: ThreadToolInvocationRow,
): ThreadToolInvocationRecord {
  return {
    backend: row.backend,
    category: row.category,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    debugLines: row.debug_lines,
    errorLines: row.error_lines,
    estimatedOutputTokens: row.estimated_output_tokens,
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    infoLines: row.info_lines,
    invocationId: row.invocation_id,
    ...(row.finding_id ? { findingId: row.finding_id } : {}),
    itemId: row.item_id,
    noisy: Boolean(row.noisy),
    ...(row.noisy_reason ? { noisyReason: row.noisy_reason } : {}),
    ...(row.normalized_command ? { normalizedCommand: row.normalized_command } : {}),
    observedAt: row.observed_at,
    outputChars: row.output_chars,
    outputLines: row.output_lines,
    outputTruncated: Boolean(row.output_truncated),
    ...(row.output_state ? { outputState: row.output_state } : {}),
    ...(row.process_id ? { processId: row.process_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    source: row.source,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    status: row.status,
    threadId: row.thread_id,
    toolName: row.tool_name,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    updatedAt: row.updated_at,
    ...(row.suggested_prompt ? { suggestedPrompt: row.suggested_prompt } : {}),
    warningLines: row.warning_lines,
  };
}

function threadToolInvocationSummaryFromRow(
  row: ThreadToolInvocationSummaryRow,
): ThreadToolInvocationSummary {
  return {
    category: row.category,
    debugLines: row.debug_lines,
    errorLines: row.error_lines,
    estimatedOutputTokens: row.estimated_output_tokens,
    infoLines: row.info_lines,
    invocationCount: row.invocation_count,
    lastObservedAt: row.last_observed_at,
    noisyInvocationCount: row.noisy_invocation_count,
    outputChars: row.output_chars,
    outputLines: row.output_lines,
    toolName: row.tool_name,
    warningLines: row.warning_lines,
  };
}

function threadToolInvocationAlertFromRow(
  row: ThreadToolInvocationAlertRow,
): ThreadToolInvocationAlert {
  return {
    alertId: row.alert_id,
    ...(row.average_interval_ms !== null
      ? { averageIntervalMs: row.average_interval_ms }
      : {}),
    backend: row.backend,
    createdAt: row.created_at,
    estimatedOutputTokens: row.estimated_output_tokens,
    firstObservedAt: row.first_observed_at,
    invocationCount: row.invocation_count,
    ...(row.invocation_ids
      ? { invocationIds: readStringArrayJson(row.invocation_ids) }
      : {}),
    kind: row.kind,
    lastObservedAt: row.last_observed_at,
    message: row.message,
    ...(row.process_id ? { processId: row.process_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    severity: row.severity,
    suggestedPrompt: row.suggested_prompt,
    threadId: row.thread_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    toolName: row.tool_name,
    totalOutputChars: row.total_output_chars,
    updatedAt: row.updated_at,
    ...(row.worst_invocation_id
      ? { worstInvocationId: row.worst_invocation_id }
      : {}),
    ...(row.worst_output_chars !== null
      ? { worstOutputChars: row.worst_output_chars }
      : {}),
  };
}

function threadToolAnalysisFromRow(
  row: ThreadToolAnalysisRow,
): ThreadToolAnalysisCoverage {
  return {
    analyzedAt: row.analyzed_at,
    analyzerVersion: row.analyzer_version,
    completeness: row.completeness,
    entryCount: row.entry_count,
    invocationCount: row.invocation_count,
    missingOutputCount: row.missing_output_count,
    pageCount: row.page_count,
    ...(row.scanned_through ? { scannedThrough: row.scanned_through } : {}),
    ...(row.explanation ? { explanation: row.explanation } : {}),
  };
}

function readStringArrayJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
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
  | "upsertManagedReviewEntry"
  | "consumeManagedReviewContexts"
  | "upsertThreadUsageLine"
  | "readThreadPricing"
  | "upsertThreadToolInvocation"
  | "markThreadToolInvocationNoisy"
  | "upsertThreadToolInvocationAlert"
  | "readThreadToolAccounting"
  | "persistThreadToolHistoryAnalysis"
  | "readRecentThreadToolInvocations"
  | "upsertThreadSubAgent"
  | "setThreadReaction"
  | "setThreadArchiveTombstone"
  | "setThreadScheduledStart"
  | "setThreadPin"
  | "setThreadParent"
  | "setThreadAgent"
  | "setThreadHandoffOrigin"
  | "setThreadForkOrigin"
  | "reorderThreadPins"
  | "updateSubthreadOrder"
  | "setSubthreadsCollapsed"
  | "setDirectoryPin"
  | "reorderDirectoryPins"
  | "setDirectoryThreadsCollapsed"
  | "setRemoteDirectoryThreadsCollapsed"
  | "readRemoteDirectoryOverlays"
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
  | "setThreadMessagingPdfToolCatalogVersion"
  | "setThreadMcpConnectionIds"
  | "setThreadPrAutoDispatchEnabled"
  | "syncThreadPrAutoDispatchCandidates"
  | "getPrAutoDispatchCandidateWinner"
  | "resetThreadPrAutoDispatchForOperator"
  | "scheduleThreadPrAutoDispatch"
  | "beginThreadPrAutoDispatch"
  | "getPrAutoDispatchBudgetStatus"
  | "resumePrAutoDispatchBudget"
  | "reserveThreadPrAutoDispatchBudget"
  | "rejectThreadPrAutoDispatchForBudget"
  | "restoreThreadPrAutoDispatchAfterBusy"
  | "renewThreadPrAutoDispatchLease"
  | "finishThreadPrAutoDispatch"
  | "cancelThreadPrAutoDispatch"
  | "cancelPendingThreadPrAutoDispatchForPr"
  | "resolveThreadPrAutoDispatchIncident"
  | "getThreadPrAutoDispatchPending"
  | "listPendingThreadPrAutoDispatches"
  | "recoverOrphanedThreadPrAutoDispatches"
  | "getThreadPrAutoDispatchAttemptCount"
  | "registerThreadPrStatusWatch"
  | "claimThreadPrStatusWatches"
  | "releaseThreadPrStatusWatch"
  | "renewThreadPrStatusWatchLease"
  | "finishThreadPrStatusWatch"
  | "supersedeThreadPrStatusWatches"
  | "listActiveThreadPrStatusWatches"
  | "cancelThreadPrStatusWatchesForPr"
  | "turnOffCodexFastEverywhere"
  | "setThreadExpectedBranch"
  | "setThreadObservedBranch"
  | "retainThreadBranchDrift"
  | "appendPermissionTransition"
  | "appendMessagingBindingTransition"
  | "appendTurnFailure"
  | "setTurnFailureCodexInvalidIdRecovery"
  | "appendQuestionnaireActivity"
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
  upsertThreadMessageOrigin?: SqliteOverlayStore["upsertThreadMessageOrigin"];
  readThreadMessageOrigins?: SqliteOverlayStore["readThreadMessageOrigins"];
};

function reliableSubAgentCompletionBoundary(
  subAgent: ThreadSubAgentSummary,
): number {
  return Number.isFinite(subAgent.updatedAt)
    && subAgent.updatedAt >= subAgent.createdAt
    ? subAgent.updatedAt
    : subAgent.createdAt;
}

function subAgentHasTerminalEvidence(subAgent: ThreadSubAgentSummary): boolean {
  return (
    subAgent.status === "success"
    || subAgent.status === "failure"
    || subAgent.status === "cancelled"
    || subAgent.status === "failed"
    || subAgent.outcome !== undefined
    || subAgent.completionSource !== undefined
  );
}
