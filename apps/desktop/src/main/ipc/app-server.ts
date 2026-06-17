import { BrowserWindow, dialog, ipcMain } from "electron";
import os from "node:os";
import path from "node:path";
import type {
  DirectoryGitStatusCacheEntry,
  OverlayStoreLike,
  PrLookupCacheEntry,
  PrStatusCacheEntry,
  SqliteOverlayStore,
  WorktreeGitWorkingStateCacheEntry,
} from "../state/overlay-store-sqlite";
import {
  sanitizeRendererPayload,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerBackendScope,
  type AppServerThreadSummary,
  type ArchiveWorktreeRequest,
  type ArchiveWorktreeResponse,
  type ArchiveThreadRequest,
  type ArchiveThreadResponse,
  type AppServerListSkillsRequest,
  type AppServerListSkillsResponse,
  type AppServerListThreadsRequest,
  type AppServerListThreadsResponse,
  type ThreadSearchRequest,
  type ThreadSearchResponse,
  type PersistThreadUsageActivityRequest,
  type PersistThreadUsageActivityResponse,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type GetThreadFileDiffRequest,
  type GetThreadFileDiffResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  type FocusedDiffAnalysisRequest,
  type FocusedDiffAnalysisResponse,
  type GetNavigationSnapshotRequest,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type GetGhStatusRequest,
  type GhStatus,
  type PickDirectoryFromDiskResponse,
  type RefreshDirectoryGitStatusesRequest,
  type RefreshDirectoryGitStatusesResponse,
  type RefreshThreadPullRequestsRequest,
  type RefreshThreadPullRequestsResponse,
  type RegisterDirectoryFromDiskRequest,
  type RegisterDirectoryFromDiskResponse,
  type MarkThreadSeenRequest,
  type MarkThreadSeenResponse,
  type NavigationDirectoryGitStatus,
  type NavigationDirectoryGitStatusUpdatedNotification,
  type NavigationThreadGitWorkingStateUpdatedNotification,
  type NavigationSnapshot,
  type AutomationThreadSummary,
  type PrSummary,
  type ReorderDirectoryPinsRequest,
  type ReorderDirectoryPinsResponse,
  type ReorderThreadPinsRequest,
  type ReorderThreadPinsResponse,
  type SetSubthreadsCollapsedRequest,
  type SetSubthreadsCollapsedResponse,
  type SetDirectoryPinRequest,
  type SetDirectoryPinResponse,
  type SetThreadParentRequest,
  type SetThreadParentResponse,
  type SetThreadAgentRequest,
  type SetThreadAgentResponse,
  type SetThreadPinRequest,
  type SetThreadPinResponse,
  type SetThreadReactionRequest,
  type SetThreadReactionResponse,
  type SetNavigationBrowseModeRequest,
  type SetNavigationBrowseModeResponse,
  type ListThreadMigrationSourceThreadsRequest,
  type ListThreadMigrationSourceThreadsResponse,
  type ListThreadMigrationSourcesResponse,
  type RetryThreadMigrationRequest,
  type StartThreadMigrationRequest,
  type StartThreadMigrationResponse,
  type ResetDirectoryLaunchpadRequest,
  type ResetDirectoryLaunchpadResponse,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type RestoreWorktreeRequest,
  type RestoreWorktreeResponse,
  type ResolveEditCommitStatesRequest,
  type ResolveEditCommitStatesResponse,
  type ListWorktreeOtherChangesRequest,
  type ListWorktreeOtherChangesResponse,
  type GetWorktreeOtherChangeDiffRequest,
  type GetWorktreeOtherChangeDiffResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type ThreadGitWorkingState,
  type ThreadOverlayState,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type UpdateSubthreadOrderRequest,
  type UpdateSubthreadOrderResponse,
} from "@pwragent/shared";
import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  normalizePullRequestProvider as normalizeSharedPullRequestProvider,
} from "@pwragent/shared";
import { registerDirectoryFromDisk } from "../app-server/directory-registration-service";
import {
  disposeDesktopBackendRegistry,
  getDesktopBackendRegistry,
} from "../app-server/backend-registry";
import { materializeTranscriptImageUrlsForRenderer } from "../transcript-image-protocol";
import { hydrateLaunchpadCodexEnvironmentOptions } from "../app-server/codex-environment-config";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { getAppStateDb } from "../state/app-state";
import {
  APP_SERVER_LIST_SKILLS_CHANNEL,
  APP_SERVER_LIST_THREADS_CHANNEL,
  THREAD_SEARCH_CHANNEL,
  APP_SERVER_ARCHIVE_THREAD_CHANNEL,
  APP_SERVER_ARCHIVE_WORKTREE_CHANNEL,
  APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL,
  APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL,
  APP_SERVER_RESTORE_THREAD_CHANNEL,
  APP_SERVER_RESTORE_WORKTREE_CHANNEL,
  APP_SERVER_RENAME_THREAD_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL,
  APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL,
  THREAD_MIGRATION_LIST_SOURCES_CHANNEL,
  THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL,
  THREAD_MIGRATION_RETRY_CHANNEL,
  THREAD_MIGRATION_START_CHANNEL,
  FOCUSED_DIFF_ANALYZE_CHANNEL,
  NAVIGATION_GET_GH_STATUS_CHANNEL,
  NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
  NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL,
  NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL,
  NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL,
  NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
  NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL,
  NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL,
  NAVIGATION_SET_DIRECTORY_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_PARENT_CHANNEL,
  NAVIGATION_SET_THREAD_AGENT_CHANNEL,
  NAVIGATION_SET_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_REACTION_CHANNEL,
  NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_SET_BROWSE_MODE_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL,
  NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
} from "../../shared/ipc";
import { FocusedDiffService } from "../diff-focus/focused-diff-service";
import { getMainLogger } from "../log";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { getDesktopAutomationService } from "../automations/desktop-automation-service";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { detectPullRequestsForThread } from "../pr-status/pr-detection";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { resolveScratchProjectsRoots } from "../app-server/scratch-projects";
import { ThreadMigrationService } from "../app-server/thread-migration-service";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { ThreadSearchStore } from "../thread-search/thread-search-store";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import { getLiveThreadFileDiff } from "../app-server/live-diff-activity";
import {
  getThreadReplayFileDiff,
  shapeReadThreadFileDiffsForRenderer,
} from "../app-server/thread-file-diff-cache";

const isDevelopment = process.env.NODE_ENV !== "production";
const THREAD_PR_REFRESH_MIN_INTERVAL_MS = 60_000;
const USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS = 10_000;
const TERMINAL_USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS = 60_000;
const PR_STATUS_TOKEN_BUCKET_CAPACITY = 20;
const PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE = 20;
const STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT = 4;
const DIRECTORY_GIT_STATUS_CACHE_MAX_AGE_MS = 5 * 60_000;
// Collapse rapid forced directory-git-status re-enqueues for the same key
// (e.g. flipping between two threads in the same repo) that land within a
// few seconds of the previous probe completing. Concurrent same-key
// requests already coalesce via `pendingDirectoryGitStatusKeys`; this
// closes the sequential post-completion gap so "747, 732, 747, 747, 732,
// 747" collapses to "747, 732".
const DIRECTORY_GIT_STATUS_FORCE_COALESCE_WINDOW_MS = 3_000;
const STARTUP_WORKTREE_WORKING_STATE_REFRESH_LIMIT = 8;
// Per-worktree working state changes as the agent edits/commits, but each
// such turn pushes a fresh probe, so the background freshness window only
// needs to catch out-of-band changes (terminal/IDE edits) on the next
// snapshot. Shorter than the per-repo directory status TTL.
const WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS = 30_000;

type AppServerOverlayStoreLike = OverlayStoreLike &
  Pick<
    SqliteOverlayStore,
    | "readDirectoryGitStatusCache"
    | "writeDirectoryGitStatusCacheEntry"
    | "readThreadGitWorkingStateCache"
    | "writeThreadGitWorkingStateCacheEntry"
  >;
const appServerLog = getMainLogger("pwragent:app-server");

/**
 * Reject pin requests that target the synthetic catch-all bucket
 * (`unlinked`). Directory pinning is a user-curated order for
 * named entries the user actually browses — both real directories
 * (`directory:*`) and workspaces (`workspace:*`) qualify, since the
 * user picks them by name in the sidebar. The `unlinked` bucket is
 * a roll-up of threads with no linked directory and doesn't model
 * a single entry, so pinning it is meaningless. The snapshot
 * builder (`buildDirectorySummaries`) also defends against this on
 * the read side, but rejecting here keeps the overlay store free
 * of stale rows that would otherwise accumulate without any
 * read-side effect. See plan 2026-05-09-002, Unit G.
 */
function rejectNonDirectoryPinKey(directoryKey: string): void {
  if (
    !directoryKey.startsWith("directory:") &&
    !directoryKey.startsWith("workspace:")
  ) {
    throw new Error(
      `Cannot pin synthetic directory entry: ${directoryKey} (only directory:* and workspace:* keys are pinnable)`,
    );
  }
}

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  appServerLog.info(event, payload);
}

async function hydrateRetainedThreadOverlayData(
  overlayStore: OverlayStoreLike,
  threads: AppServerThreadSummary[],
): Promise<AppServerThreadSummary[]> {
  if (threads.length === 0) {
    return threads;
  }

  const threadIdsByBackend = new Map<AppServerBackendKind, Set<string>>();
  for (const thread of threads) {
    const threadIds = threadIdsByBackend.get(thread.source) ?? new Set<string>();
    threadIds.add(thread.id);
    threadIdsByBackend.set(thread.source, threadIds);
  }

  const overlayEntries: Array<
    readonly [AppServerBackendKind, Record<string, ThreadOverlayState | undefined>]
  > = await Promise.all(
    [...threadIdsByBackend.entries()].map(
      async ([backend, threadIds]): Promise<
        readonly [
          AppServerBackendKind,
          Record<string, ThreadOverlayState | undefined>,
        ]
      > => [
        backend,
        await overlayStore.getThreadOverlayStates({
          backend,
          threadIds: [...threadIds],
        }),
      ],
    ),
  );
  const overlaysByBackend = new Map(overlayEntries);

  return threads.map((thread) => {
    const overlay = overlaysByBackend.get(thread.source)?.[thread.id];
    if (!overlay?.worktreeSnapshots?.length) {
      return thread;
    }
    return {
      ...thread,
      worktreeSnapshots: overlay.worktreeSnapshots,
    };
  });
}

function buildAutomationSummariesByThreadKey():
  | Record<string, AutomationThreadSummary | undefined>
  | undefined {
  try {
    return getDesktopAutomationService().buildThreadSummaries();
  } catch (error) {
    appServerLog.warn("automation store unavailable for navigation snapshot", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function directoryStatusesEqual(
  left: NavigationSnapshot["directories"],
  right: NavigationSnapshot["directories"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((directory, index) => {
    const candidate = right[index];
    if (!candidate || directory.key !== candidate.key) {
      return false;
    }

    const leftStatus = directory.gitStatus;
    const rightStatus = candidate.gitStatus;
    const leftCodexEnvironmentOptions =
      directory.launchpad?.codexEnvironmentOptions ?? null;
    const rightCodexEnvironmentOptions =
      candidate.launchpad?.codexEnvironmentOptions ?? null;
    return (
      JSON.stringify(leftStatus ?? null) === JSON.stringify(rightStatus ?? null) &&
      JSON.stringify(leftCodexEnvironmentOptions) ===
        JSON.stringify(rightCodexEnvironmentOptions)
    );
  });
}

function applyDirectoryGitStatus(
  directory: NavigationSnapshot["directories"][number],
  gitStatus: NavigationDirectoryGitStatus | undefined,
): NavigationSnapshot["directories"][number] {
  const next = { ...directory };
  if (gitStatus) {
    next.gitStatus = gitStatus;
  } else {
    delete next.gitStatus;
  }
  return next;
}

async function hydrateDirectoryLaunchpads(
  directories: NavigationSnapshot["directories"],
): Promise<NavigationSnapshot["directories"]> {
  return await Promise.all(
    directories.map(async (directory) => {
      if (!directory.launchpad) {
        return directory;
      }

      try {
        return {
          ...directory,
          launchpad: await hydrateLaunchpadCodexEnvironmentOptions(
            directory.launchpad,
          ),
        };
      } catch (error) {
        logDebug("getNavigationSnapshot:launchpad-environments-failed", {
          directoryKey: directory.key,
          error: error instanceof Error ? error.message : String(error),
        });
        return directory;
      }
    }),
  );
}

function getNavigationSnapshotRequestKey(
  request: GetNavigationSnapshotRequest,
): string {
  return JSON.stringify({
    backend: request.backend ?? "all",
    filter: request.filter ?? "",
    forceRefresh: request.forceRefresh === true,
  });
}

function getThreadPullRequestsRequestKey(
  backend: AppServerBackendKind,
  request: RefreshThreadPullRequestsRequest,
): string {
  return JSON.stringify({
    lookupVersion: 3,
    backend,
    threadId: request.threadId,
    provider: normalizePullRequestProvider(request.provider),
    branch: request.branch.trim(),
    directoryPaths: request.directoryPaths,
  });
}

function normalizePrLookupDirectoryPaths(directoryPaths: string[]): string[] {
  return [...new Set(directoryPaths.map((path) => path.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function getPullRequestLookupKey(
  request: Pick<
    RefreshThreadPullRequestsRequest,
    "provider" | "branch" | "directoryPaths"
  >,
): string {
  return JSON.stringify({
    lookupVersion: 2,
    provider: normalizePullRequestProvider(request.provider),
    branch: request.branch.trim(),
    directoryPaths: normalizePrLookupDirectoryPaths(request.directoryPaths),
  });
}

function normalizePullRequestProvider(provider: string | undefined): string {
  return normalizeSharedPullRequestProvider(provider);
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

function dedupePrsByStatusKey(prs: PrSummary[]): PrSummary[] {
  const seen = new Set<string>();
  const out: PrSummary[] = [];
  for (const pr of prs.map(normalizePrSummary)) {
    const key = getPrStatusKey(pr);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(pr);
  }
  return out;
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

function getPrStatusKey(
  pr: Pick<PrSummary, "provider" | "org" | "repo" | "number">,
): string {
  return buildPullRequestStatusKey(pr);
}

function prSummariesEqual(left: PrSummary[], right: PrSummary[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((pr, index) => {
    const candidate = right[index];
    return (
      candidate?.number === pr.number &&
      normalizePullRequestProvider(candidate.provider)
        === normalizePullRequestProvider(pr.provider) &&
      candidate.org === pr.org &&
      candidate.repo === pr.repo &&
      candidate.title === pr.title &&
      candidate.state === pr.state &&
      candidate.checkState === pr.checkState &&
      candidate.lifecycleState === pr.lifecycleState &&
      candidate.reviewState === pr.reviewState &&
      candidate.mergeState === pr.mergeState &&
      JSON.stringify(candidate.commitShas ?? []) === JSON.stringify(pr.commitShas ?? []) &&
      candidate.url === pr.url
    );
  });
}

type PrStatusRegistryEntry = {
  pr: PrSummary;
  fetchedAt: number;
  lastScheduledRefreshRequestedAt?: number;
  lastUserRefreshRequestedAt?: number;
};

type PrLookupRegistryEntry = {
  prs: PrSummary[];
  fetchedAt: number;
  provider: string;
  branch: string;
  directoryPaths: string[];
  lastScheduledRefreshRequestedAt?: number;
  lastUserRefreshRequestedAt?: number;
};

type PrLookupSubscriber = {
  backend: AppServerBackendKind;
  threadId: string;
  requestKey: string;
  previousPrs: PrSummary[];
};

type PrLookupRefreshClaim =
  | {
      refreshKey: string;
      skippedReason?: undefined;
    }
  | {
      refreshKey?: undefined;
      skippedReason: "cooldown" | "scheduled-token-bucket";
      ageMs?: number;
      minIntervalMs?: number;
      nextAllowedInMs?: number;
    };

class PrStatusTokenBucket {
  private tokens = PR_STATUS_TOKEN_BUCKET_CAPACITY;
  private updatedAt = Date.now();

  tryTake(now = Date.now()): boolean {
    const elapsedMs = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(
      PR_STATUS_TOKEN_BUCKET_CAPACITY,
      this.tokens +
        (elapsedMs * PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE) / 60_000,
    );
    this.updatedAt = now;

    if (this.tokens < 1) {
      return false;
    }

    this.tokens -= 1;
    return true;
  }
}

function prLogIds(prs: PrSummary[]): string[] {
  return prs.map((pr) => getPrStatusKey(pr));
}

function userPrRefreshLogPayload(params: {
  backend: AppServerBackendKind;
  branch: string;
  directoryPathCount: number;
  existingLookupMatches?: boolean;
  ghAvailable?: boolean;
  lookupCacheHit?: boolean;
  lookupKey?: string;
  previousPrs?: PrSummary[];
  provider: string;
  reason?: string;
  requestKey?: string;
  threadId: string;
  trigger: NonNullable<RefreshThreadPullRequestsRequest["trigger"]>;
}): Record<string, unknown> {
  return {
    backend: params.backend,
    branch: params.branch,
    directoryPathCount: params.directoryPathCount,
    existingLookupMatches: params.existingLookupMatches,
    ghAvailable: params.ghAvailable,
    lookupCacheHit: params.lookupCacheHit,
    lookupKey: params.lookupKey,
    previousPrIds: prLogIds(params.previousPrs ?? []),
    provider: params.provider,
    reason: params.reason,
    requestKey: params.requestKey,
    threadId: params.threadId,
    trigger: params.trigger,
  };
}

class DesktopAppServerService {
  private focusedDiffService: FocusedDiffService | null = null;
  private focusedDiffServiceApiKey: string | undefined;
  private focusedDiffServiceModel: string | undefined;
  private prFetcher: GithubPrFetcher | undefined;
  private readonly pendingNavigationSnapshots = new Map<
    string,
    Promise<NavigationSnapshot>
  >();
  private readonly pendingThreadPullRequestRefreshes = new Map<
    string,
    Promise<RefreshThreadPullRequestsResponse>
  >();
  private readonly pendingEditCommitResolves = new Map<
    string,
    Promise<ResolveEditCommitStatesResponse>
  >();
  private readonly prStatusRegistry = new Map<string, PrStatusRegistryEntry>();
  private readonly prLookupRegistry = new Map<string, PrLookupRegistryEntry>();
  private readonly pendingPrLookupRefreshes = new Map<string, Promise<void>>();
  private readonly prLookupSubscribers = new Map<
    string,
    Map<string, PrLookupSubscriber>
  >();
  private readonly prStatusTokenBucket = new PrStatusTokenBucket();
  private prStatusRegistryLoaded = false;
  private prLookupRegistryLoaded = false;
  private readonly previousDirectoriesByBackend = new Map<
    AppServerBackendScope,
    NavigationSnapshot["directories"]
  >();
  private readonly directoryGitStatusByKey = new Map<
    string,
    DirectoryGitStatusCacheEntry
  >();
  private directoryGitStatusCacheLoaded = false;
  private automaticDirectoryGitStatusRefreshesStarted = 0;
  private readonly lastDirectoriesByKey = new Map<
    string,
    NavigationSnapshot["directories"][number]
  >();
  private readonly pendingDirectoryGitStatusRefreshes = new Map<string, Promise<void>>();
  private readonly pendingDirectoryGitStatusKeys = new Set<string>();
  private readonly workingStateByWorktree = new Map<
    string,
    WorktreeGitWorkingStateCacheEntry
  >();
  private workingStateCacheLoaded = false;
  private automaticWorktreeWorkingStateRefreshesStarted = 0;
  private readonly pendingWorktreeWorkingStateRefreshes = new Map<
    string,
    Promise<void>
  >();
  private readonly pendingWorktreeWorkingStateKeys = new Set<string>();
  // Maps a thread identity (`backend:threadId`) to its working directory so
  // a turn/command-completion event can refresh the right worktree's chips
  // without re-reading the navigation snapshot. Populated on every snapshot.
  private readonly worktreePathByThreadKey = new Map<string, string>();
  private readonly prRefreshContextByThreadKey = new Map<
    string,
    {
      backend: AppServerBackendKind;
      threadId: string;
      branch: string;
      directoryPaths: string[];
    }
  >();
  // Merged PR commits are accepted as "pushed" even when the PR head branch
  // has been deleted and no remote ref still contains those SHAs locally.
  private readonly mergedPrCommitShasByThread = new Map<
    string,
    { worktreePath: string; commitShas: Set<string> }
  >();
  private threadSearchService: ThreadSearchService | null = null;
  private threadMigrationService: ThreadMigrationService | null = null;
  // Parent of the most recently picked directory, used as the "Add directory"
  // dialog's defaultPath so it reopens where you last browsed instead of the
  // OS default (Documents on a fresh Windows profile). Falls back to the home
  // folder. In-memory: resets to home on app restart.
  private lastPickedDirectoryParent: string | undefined;

  private getThreadMigrationService(): ThreadMigrationService {
    if (!this.threadMigrationService) {
      this.threadMigrationService = new ThreadMigrationService({
        destination: getDesktopBackendRegistry(),
      });
    }
    return this.threadMigrationService;
  }

  private getThreadSearchService(): ThreadSearchService {
    if (!this.threadSearchService) {
      this.threadSearchService = new ThreadSearchService(
        new ThreadSearchStore(getAppStateDb()),
        async ({ backend, archived }) => {
          const threads = await getDesktopBackendRegistry().listThreads({
            backend,
            archived,
            callerReason: "thread-search",
            enrichDirectories: true,
          });
          return await hydrateRetainedThreadOverlayData(this.getOverlayStore(), threads);
        },
        new ProviderTranscriptThreadSearchAdapter(
          async ({ backend, threadId, limit }) =>
            await getDesktopBackendRegistry().readThread({
              backend,
              threadId,
              limit,
            }),
        ),
      );
    }
    return this.threadSearchService;
  }

  async listThreads(
    request: AppServerListThreadsRequest = {}
  ): Promise<AppServerListThreadsResponse> {
    const backend = request.backend;
    const threads = await getDesktopBackendRegistry().listThreads({
      backend,
      archived: request.archived,
      callerReason: "ipc-list-threads",
      filter: request.filter,
    });
    const hydratedThreads = await hydrateRetainedThreadOverlayData(
      this.getOverlayStore(),
      threads,
    );

    logDebug("listThreads", {
      backend: backend ?? "all",
      count: hydratedThreads.length,
      threadIds: hydratedThreads.slice(0, 5).map((thread) => thread.id),
    });

    return {
      backend: backend ?? "all",
      fetchedAt: Date.now(),
      threads: hydratedThreads,
      workspaceRoots: resolveScratchProjectsRoots(),
    };
  }

  async searchThreads(
    request: ThreadSearchRequest = {},
  ): Promise<ThreadSearchResponse> {
    return await this.getThreadSearchService().search(request);
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<AppServerListSkillsResponse> {
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().listSkills({
      backend,
      cwd: request.cwd,
      cwds: request.cwds,
      threadId: request.threadId,
    });

    logDebug("listSkills", {
      backend,
      cwd: request.cwd ?? null,
      cwds: request.cwds ?? [],
      entries: response.data.length,
      commands: response.data.reduce(
        (count, entry) => count + (entry.commands?.length ?? 0),
        0,
      ),
      skills: response.data.reduce((count, entry) => count + entry.skills.length, 0),
    });

    return {
      backend,
      fetchedAt: Date.now(),
      data: response.data,
    };
  }

  async readThread(
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> {
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().readThread({
      backend,
      threadId: request.threadId,
      includeTurns: request.includeTurns,
      before: request.before,
      limit: request.limit,
    });

    logDebug("readThread", {
      backend,
      threadId: request.threadId,
      messageCount: response.replay.messages.length,
      hasLastUserMessage: Boolean(response.replay.lastUserMessage),
      hasLastAssistantMessage: Boolean(response.replay.lastAssistantMessage),
      hasPreviousPage: response.replay.pagination.hasPreviousPage,
      threadStatus: response.threadStatus ?? response.replay.threadStatus,
    });

    const materialized = await materializeTranscriptImageUrlsForRenderer(response);
    return sanitizeRendererPayload(
      shapeReadThreadFileDiffsForRenderer(materialized),
    );
  }

  async persistThreadUsageActivity(
    request: PersistThreadUsageActivityRequest,
  ): Promise<PersistThreadUsageActivityResponse> {
    const response = await this.getOverlayStore().persistThreadUsageActivity({
      backend: request.backend,
      threadId: request.threadId,
      activity: request.activity,
    });
    return {
      backend: request.backend,
      threadId: request.threadId,
      activityId: request.activity.id,
      persisted: response.persisted,
    };
  }

  async archiveThread(
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> {
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().archiveThread({
      ...request,
      backend,
    });

    logDebug("archiveThread", {
      backend,
      threadId: request.threadId,
      cleanupCount: response.cleanup.length,
    });

    return response;
  }

  async restoreThread(
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> {
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().restoreThread({
      ...request,
      backend,
    });

    logDebug("restoreThread", {
      backend,
      threadId: request.threadId,
    });

    return response;
  }

  async listThreadMigrationSources(): Promise<ListThreadMigrationSourcesResponse> {
    return await this.getThreadMigrationService().listSources();
  }

  async listThreadMigrationSourceThreads(
    request: ListThreadMigrationSourceThreadsRequest,
  ): Promise<ListThreadMigrationSourceThreadsResponse> {
    return await this.getThreadMigrationService().listSourceThreads(request);
  }

  async startThreadMigration(
    request: StartThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> {
    return await this.getThreadMigrationService().startMigration(request);
  }

  async retryThreadMigration(
    request: RetryThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> {
    return await this.getThreadMigrationService().retryMigration(request);
  }

  async archiveWorktree(
    request: ArchiveWorktreeRequest,
  ): Promise<ArchiveWorktreeResponse> {
    const response = await getDesktopBackendRegistry().archiveWorktree(request);

    logDebug("archiveWorktree", {
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      snapshotRef: response.snapshot.snapshotRef,
    });

    return response;
  }

  async restoreWorktree(
    request: RestoreWorktreeRequest,
  ): Promise<RestoreWorktreeResponse> {
    const response = await getDesktopBackendRegistry().restoreWorktree(request);

    logDebug("restoreWorktree", {
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      snapshotRef: response.snapshot.snapshotRef,
    });

    return response;
  }

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const response = await getDesktopBackendRegistry().handoffThreadWorkspace(request);

    logDebug("handoffThreadWorkspace", {
      backend: request.backend,
      threadId: request.threadId,
      direction: request.direction,
      workMode: response.workMode,
      targetPath: response.targetPath,
    });

    return response;
  }

  async renameThread(
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> {
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().renameThread({
      ...request,
      backend,
    });

    logDebug("renameThread", {
      backend,
      threadId: request.threadId,
    });

    return response;
  }

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    const requestKey = getNavigationSnapshotRequestKey(request);
    const pending = this.pendingNavigationSnapshots.get(requestKey);
    if (pending) {
      return await pending;
    }

    const promise = this.readNavigationSnapshot(request).finally(() => {
      if (this.pendingNavigationSnapshots.get(requestKey) === promise) {
        this.pendingNavigationSnapshots.delete(requestKey);
      }
    });
    this.pendingNavigationSnapshots.set(requestKey, promise);

    return await promise;
  }

  async setNavigationBrowseMode(
    request: SetNavigationBrowseModeRequest,
  ): Promise<SetNavigationBrowseModeResponse> {
    const browseMode = await this.getOverlayStore().setNavigationBrowseMode(
      request.browseMode,
    );

    logDebug("setNavigationBrowseMode", { browseMode });

    return { browseMode };
  }

  private async readNavigationSnapshot(
    request: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot> {
    const backend: AppServerBackendScope = request.backend ?? "all";
    const threads = await getDesktopBackendRegistry().listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: "navigation-snapshot",
      filter: request.filter,
      forceRefresh: request.forceRefresh,
    });
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey(threads);
    const automationsByThreadKey = buildAutomationSummariesByThreadKey();
    const queuedExecutionModesByThreadKey = getDesktopBackendRegistry()
      .getQueuedExecutionModesSnapshot();
    const snapshot = await this.getOverlayStore().reconcileNavigationSnapshot({
      backend,
      automationsByThreadKey,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      queuedExecutionModesByThreadKey,
      threads,
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    await this.loadPrStatusRegistry();
    await this.loadPrLookupRegistry();
    this.seedPrStatusRegistryFromThreads(snapshot.threads);
    const canonicalSnapshot = this.applyCanonicalPrStatuses(snapshot.threads);
    await this.loadDirectoryGitStatusCache();
    for (const directory of snapshot.directories) {
      this.lastDirectoriesByKey.set(directory.key, directory);
    }
    const directories = await hydrateDirectoryLaunchpads(
      snapshot.directories.map((directory) => {
        const cached = this.directoryGitStatusByKey.get(directory.key);
        if (!cached) {
          return directory;
        }
        return applyDirectoryGitStatus(directory, cached.gitStatus);
      }),
    );
    const previousDirectories = this.previousDirectoriesByBackend.get(backend);
    const directoriesUnchanged = previousDirectories
      ? directoryStatusesEqual(previousDirectories, directories)
      : false;
    this.previousDirectoriesByBackend.set(backend, directories);
    this.startDirectoryGitStatusRefresh({
      automatic: true,
      directories: snapshot.directories,
      requestKey: getNavigationSnapshotRequestKey(request),
    });

    await this.loadThreadGitWorkingStateCache();
    this.rememberThreadWorktreePaths(canonicalSnapshot.threads);
    this.rememberThreadPrRefreshContexts(canonicalSnapshot.threads);
    this.rememberMergedPrCommitShas(canonicalSnapshot.threads);
    const threadsWithWorkingState = canonicalSnapshot.threads.map((thread) =>
      this.applyCachedWorktreeWorkingState(thread),
    );
    this.startWorktreeWorkingStateRefresh({
      automatic: true,
      worktreePaths: this.collectThreadWorktreePaths(canonicalSnapshot.threads),
    });

    return {
      ...snapshot,
      threads: threadsWithWorkingState,
      directories,
      unchanged:
        snapshot.unchanged && directoriesUnchanged && !canonicalSnapshot.changed,
    };
  }

  async resolveEditCommitStates(
    request: ResolveEditCommitStatesRequest,
  ): Promise<ResolveEditCommitStatesResponse> {
    const acceptedPushedCommitShas = this.getMergedPrCommitShasForWorktree(
      request.worktreePath,
    );
    // Coalesce identical in-flight requests (same worktree + groups) so an
    // overlapping renderer re-resolve doesn't spawn a second git burst — they
    // share one result.
    const requestKey = JSON.stringify({
      worktreePath: request.worktreePath,
      groups: request.groups,
      acceptedPushedCommitShas,
    });
    const pending = this.pendingEditCommitResolves.get(requestKey);
    if (pending) {
      return await pending;
    }

    const promise = getDesktopBackendRegistry()
      .resolveEditCommitStates(request.worktreePath, request.groups, {
        acceptedPushedCommitShas,
      })
      .then((states) => ({ states }));
    this.pendingEditCommitResolves.set(requestKey, promise);
    try {
      return await promise;
    } finally {
      this.pendingEditCommitResolves.delete(requestKey);
    }
  }

  async listWorktreeOtherChanges(
    request: ListWorktreeOtherChangesRequest,
  ): Promise<ListWorktreeOtherChangesResponse> {
    return await getDesktopBackendRegistry().listWorktreeOtherChanges(
      request.worktreePath,
      {
        excludePaths: request.excludePaths,
        maxFiles: request.maxFiles,
      },
    );
  }

  async getWorktreeOtherChangeDiff(
    request: GetWorktreeOtherChangeDiffRequest,
  ): Promise<GetWorktreeOtherChangeDiffResponse> {
    return await getDesktopBackendRegistry().getWorktreeOtherChangeDiff(
      request.worktreePath,
      request.path,
      { maxBytes: request.maxBytes },
    );
  }

  private collectThreadWorktreePaths(
    threads: NavigationSnapshot["threads"],
  ): string[] {
    const paths = new Set<string>();
    for (const thread of threads) {
      const worktreePath = thread.projectKey?.trim();
      if (worktreePath) {
        paths.add(worktreePath);
      }
    }
    return [...paths];
  }

  private rememberThreadWorktreePaths(
    threads: NavigationSnapshot["threads"],
  ): void {
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const worktreePath = thread.projectKey?.trim();
      if (worktreePath) {
        this.worktreePathByThreadKey.set(threadKey, worktreePath);
      } else {
        this.worktreePathByThreadKey.delete(threadKey);
      }
    }
  }

  private rememberThreadPrRefreshContexts(
    threads: NavigationSnapshot["threads"],
  ): void {
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const branch =
        thread.observedGitBranch?.trim() || thread.gitBranch?.trim() || "";
      const directoryPaths = resolveThreadPullRequestDirectoryPaths(thread);
      if (!branch || directoryPaths.length === 0) {
        this.prRefreshContextByThreadKey.delete(threadKey);
        continue;
      }
      this.prRefreshContextByThreadKey.set(threadKey, {
        backend: thread.source,
        threadId: thread.id,
        branch,
        directoryPaths,
      });
    }
  }

  private rememberMergedPrCommitShas(
    threads: NavigationSnapshot["threads"],
  ): void {
    for (const thread of threads) {
      this.rememberMergedPrCommitShasForThread({
        backend: thread.source,
        threadId: thread.id,
        worktreePath: thread.projectKey,
        prs: thread.prs ?? [],
      });
    }
  }

  private rememberMergedPrCommitShasForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
    prs: PrSummary[];
  }): string | undefined {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const worktreePath = params.worktreePath?.trim()
      || this.worktreePathByThreadKey.get(threadKey);
    if (!worktreePath) {
      this.mergedPrCommitShasByThread.delete(threadKey);
      return undefined;
    }
    const commitShas = this.extractMergedPrCommitShas(params.prs);
    if (commitShas.length === 0) {
      this.mergedPrCommitShasByThread.delete(threadKey);
      return worktreePath;
    }
    this.mergedPrCommitShasByThread.set(threadKey, {
      worktreePath,
      commitShas: new Set(commitShas),
    });
    return worktreePath;
  }

  private extractMergedPrCommitShas(
    prs: PrSummary[] | undefined,
  ): string[] {
    return (prs ?? [])
      .filter((pr) => pr.lifecycleState === "merged" || pr.state === "merged")
      .flatMap((pr) => normalizeCommitShas(pr.commitShas) ?? []);
  }

  private getMergedPrCommitShasForWorktree(worktreePath: string): string[] {
    const accepted = new Set<string>();
    const normalizedWorktreePath = worktreePath.trim();
    for (const entry of this.mergedPrCommitShasByThread.values()) {
      if (entry.worktreePath !== normalizedWorktreePath) {
        continue;
      }
      for (const sha of entry.commitShas) {
        accepted.add(sha);
      }
    }
    return [...accepted];
  }

  private applyCachedWorktreeWorkingState(
    thread: NavigationSnapshot["threads"][number],
  ): NavigationSnapshot["threads"][number] {
    const worktreePath = thread.projectKey?.trim();
    const cached = worktreePath
      ? this.workingStateByWorktree.get(worktreePath)
      : undefined;
    // Threads arrive without working state (the enricher no longer computes
    // it), so hydration only ever adds the cached value. A worktree the cache
    // doesn't know about yet shows no chips until the background probe lands.
    if (cached?.gitWorkingState && thread.gitWorkingState !== cached.gitWorkingState) {
      return { ...thread, gitWorkingState: cached.gitWorkingState };
    }
    return thread;
  }

  async refreshDirectoryGitStatusesForKeys(
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse> {
    await this.loadDirectoryGitStatusCache();
    const directoryKeys = [
      ...new Set(request.directoryKeys.map((key) => key.trim()).filter(Boolean)),
    ];
    const directories = directoryKeys
      .map((key) => this.lastDirectoriesByKey.get(key))
      .filter((directory): directory is NavigationSnapshot["directories"][number] =>
        Boolean(directory?.path?.trim()),
      );
    const scheduledCount = this.startDirectoryGitStatusRefresh({
      automatic: false,
      directories,
      force: request.force ?? true,
      requestKey: "explicit",
    });

    return { scheduledCount };
  }

  private async loadDirectoryGitStatusCache(): Promise<void> {
    if (this.directoryGitStatusCacheLoaded) {
      return;
    }
    this.directoryGitStatusCacheLoaded = true;

    const entries = await this.getOverlayStore().readDirectoryGitStatusCache();
    for (const entry of Object.values(entries)) {
      this.directoryGitStatusByKey.set(entry.directoryKey, entry);
    }
  }

  private startDirectoryGitStatusRefresh(params: {
    automatic: boolean;
    directories: NavigationSnapshot["directories"];
    force?: boolean;
    requestKey: string;
  }): number {
    const directories = this.selectDirectoryGitStatusRefreshCandidates(params).filter(
      (directory) => !this.pendingDirectoryGitStatusKeys.has(directory.key),
    );
    if (directories.length === 0) {
      return 0;
    }

    const refreshKey = JSON.stringify({
      request: params.requestKey,
      directoryKeys: directories.map((directory) => directory.key),
      force: params.force === true,
    });
    if (this.pendingDirectoryGitStatusRefreshes.has(refreshKey)) {
      return 0;
    }

    if (params.automatic) {
      this.automaticDirectoryGitStatusRefreshesStarted += directories.length;
    }
    for (const directory of directories) {
      this.pendingDirectoryGitStatusKeys.add(directory.key);
    }

    logDebug("directoryGitStatusRefresh:scheduled", {
      mode: params.automatic ? "automatic" : "explicit",
      count: directories.length,
      automaticStarted: this.automaticDirectoryGitStatusRefreshesStarted,
      automaticLimit: STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT,
    });

    const promise = this.refreshDirectoryGitStatuses(directories)
      .catch((error) => {
        logDebug("directoryGitStatusRefresh:failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        for (const directory of directories) {
          this.pendingDirectoryGitStatusKeys.delete(directory.key);
        }
        if (this.pendingDirectoryGitStatusRefreshes.get(refreshKey) === promise) {
          this.pendingDirectoryGitStatusRefreshes.delete(refreshKey);
        }
      });
    this.pendingDirectoryGitStatusRefreshes.set(refreshKey, promise);
    return directories.length;
  }

  private selectDirectoryGitStatusRefreshCandidates(params: {
    automatic: boolean;
    directories: NavigationSnapshot["directories"];
    force?: boolean;
  }): NavigationSnapshot["directories"] {
    const candidates = params.directories.filter((directory) => {
      if (!directory.path?.trim()) {
        return false;
      }
      const cached = this.directoryGitStatusByKey.get(directory.key);
      if (params.force) {
        // Forced refreshes bypass the normal freshness gate, but still
        // collapse a burst of same-key re-enqueues that land within a few
        // seconds of the previous probe completing (e.g. rapidly flipping
        // between two threads in the same repo). In-flight requests already
        // coalesce via `pendingDirectoryGitStatusKeys`; this closes the
        // sequential post-completion gap.
        return (
          !cached ||
          Date.now() - cached.fetchedAt >=
            DIRECTORY_GIT_STATUS_FORCE_COALESCE_WINDOW_MS
        );
      }
      if (!cached) {
        return true;
      }
      if (!isFreshDirectoryGitStatusCacheEntry(cached)) {
        return true;
      }
      return (directory.latestUpdatedAt ?? 0) > (cached.directoryUpdatedAt ?? 0);
    });

    if (!params.automatic) {
      return candidates;
    }

    const remaining =
      STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT -
      this.automaticDirectoryGitStatusRefreshesStarted;
    if (remaining <= 0) {
      return [];
    }

    return [...candidates]
      .sort((left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0))
      .slice(0, remaining);
  }

  private async refreshLaunchpadDirectoryGitStatus(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadRequest> {
    const directoryPath = request.directoryPath?.trim();
    if (!directoryPath) {
      return request;
    }

    const cachedDirectory = this.lastDirectoriesByKey.get(request.directoryKey);
    const directory: NavigationSnapshot["directories"][number] = {
      key: request.directoryKey,
      kind: request.directoryKind,
      label: request.directoryLabel,
      path: directoryPath,
      threadKeys: [],
      needsAttentionCount: 0,
      ...(cachedDirectory?.latestUpdatedAt !== undefined
        ? { latestUpdatedAt: cachedDirectory.latestUpdatedAt }
        : {}),
    };

    try {
      const registry = getDesktopBackendRegistry();
      for await (const entry of registry.readDirectoryStatusEntries([directory])) {
        const fetchedAt = Date.now();
        await this.writeDirectoryGitStatusEntry({
          directory,
          directoryKey: entry.directoryKey,
          fetchedAt,
          gitStatus: entry.gitStatus,
        });
        if (!entry.gitStatus?.currentBranch) {
          return request;
        }
        return {
          ...request,
          currentBranch: entry.gitStatus.currentBranch,
        };
      }
    } catch (error) {
      logDebug("directoryGitStatusRefresh:launchpadRefreshFailed", {
        directoryKey: request.directoryKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return request;
  }

  private async refreshDirectoryGitStatuses(
    directories: NavigationSnapshot["directories"],
  ): Promise<void> {
    const refreshableDirectories = directories.filter((directory) => directory.path?.trim());
    if (refreshableDirectories.length === 0) {
      return;
    }

    const registry = getDesktopBackendRegistry();
    const directoryByKey = new Map(
      refreshableDirectories.map((directory) => [directory.key, directory]),
    );
    for await (const entry of registry.readDirectoryStatusEntries(refreshableDirectories)) {
      const directory = directoryByKey.get(entry.directoryKey);
      const fetchedAt = Date.now();
      await this.writeDirectoryGitStatusEntry({
        directory,
        directoryKey: entry.directoryKey,
        fetchedAt,
        gitStatus: entry.gitStatus,
      });
    }
  }

  private async writeDirectoryGitStatusEntry(params: {
    directory?: NavigationSnapshot["directories"][number];
    directoryKey: string;
    fetchedAt: number;
    gitStatus?: NavigationDirectoryGitStatus;
  }): Promise<void> {
    const current = this.directoryGitStatusByKey.get(params.directoryKey);
    const directoryPath = params.directory?.path ?? current?.directoryPath;
    const directoryUpdatedAt =
      params.directory?.latestUpdatedAt ?? current?.directoryUpdatedAt;
    const cacheEntry: DirectoryGitStatusCacheEntry = {
      directoryKey: params.directoryKey,
      ...(directoryPath ? { directoryPath } : {}),
      ...(directoryUpdatedAt !== undefined ? { directoryUpdatedAt } : {}),
      fetchedAt: params.fetchedAt,
      ...(params.gitStatus ? { gitStatus: params.gitStatus } : {}),
    };
    this.directoryGitStatusByKey.set(params.directoryKey, cacheEntry);
    await this.getOverlayStore().writeDirectoryGitStatusCacheEntry(cacheEntry);
    const notification: NavigationDirectoryGitStatusUpdatedNotification = {
      method: "navigation/directoryGitStatus/updated",
      params: {
        directoryKey: params.directoryKey,
        gitStatus: params.gitStatus ?? null,
        fetchedAt: params.fetchedAt,
      },
    };
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification,
    } as unknown as AgentEvent);
  }

  private async loadThreadGitWorkingStateCache(): Promise<void> {
    if (this.workingStateCacheLoaded) {
      return;
    }
    this.workingStateCacheLoaded = true;

    const entries = await this.getOverlayStore().readThreadGitWorkingStateCache();
    for (const entry of Object.values(entries)) {
      this.workingStateByWorktree.set(entry.worktreePath, entry);
    }
  }

  /**
   * Schedule a background per-worktree working-state probe. Mirrors
   * `startDirectoryGitStatusRefresh`: concurrent same-key requests coalesce
   * through `pendingWorktreeWorkingStateKeys`, automatic refreshes obey a
   * startup budget + cache freshness, and `force` (event-driven invalidation)
   * bypasses freshness. Returns the number of worktrees scheduled.
   */
  private startWorktreeWorkingStateRefresh(params: {
    automatic: boolean;
    worktreePaths: string[];
    force?: boolean;
  }): number {
    const worktreePaths = this.selectWorktreeWorkingStateRefreshCandidates(
      params,
    ).filter((worktreePath) => !this.pendingWorktreeWorkingStateKeys.has(worktreePath));
    if (worktreePaths.length === 0) {
      return 0;
    }

    const refreshKey = JSON.stringify({
      worktreePaths,
      force: params.force === true,
    });
    if (this.pendingWorktreeWorkingStateRefreshes.has(refreshKey)) {
      return 0;
    }

    if (params.automatic) {
      this.automaticWorktreeWorkingStateRefreshesStarted += worktreePaths.length;
    }
    for (const worktreePath of worktreePaths) {
      this.pendingWorktreeWorkingStateKeys.add(worktreePath);
    }

    const promise = this.refreshWorktreeWorkingStates(worktreePaths)
      .catch((error) => {
        logDebug("worktreeWorkingStateRefresh:failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        for (const worktreePath of worktreePaths) {
          this.pendingWorktreeWorkingStateKeys.delete(worktreePath);
        }
        if (this.pendingWorktreeWorkingStateRefreshes.get(refreshKey) === promise) {
          this.pendingWorktreeWorkingStateRefreshes.delete(refreshKey);
        }
      });
    this.pendingWorktreeWorkingStateRefreshes.set(refreshKey, promise);
    return worktreePaths.length;
  }

  private selectWorktreeWorkingStateRefreshCandidates(params: {
    automatic: boolean;
    worktreePaths: string[];
    force?: boolean;
  }): string[] {
    const candidates = [
      ...new Set(params.worktreePaths.map((p) => p.trim()).filter(Boolean)),
    ].filter((worktreePath) => {
      if (params.force) {
        return true;
      }
      const cached = this.workingStateByWorktree.get(worktreePath);
      if (!cached) {
        return true;
      }
      return !isFreshWorktreeWorkingStateCacheEntry(cached);
    });

    if (!params.automatic) {
      return candidates;
    }

    const remaining =
      STARTUP_WORKTREE_WORKING_STATE_REFRESH_LIMIT -
      this.automaticWorktreeWorkingStateRefreshesStarted;
    if (remaining <= 0) {
      return [];
    }
    return candidates.slice(0, remaining);
  }

  private async refreshWorktreeWorkingStates(
    worktreePaths: string[],
  ): Promise<void> {
    const refreshable = worktreePaths.map((p) => p.trim()).filter(Boolean);
    if (refreshable.length === 0) {
      return;
    }

    for await (const entry of getDesktopBackendRegistry().readWorktreeWorkingStateEntries(
      refreshable,
      {
        acceptedPushedCommitShasByWorktreePath: Object.fromEntries(
          refreshable.map((worktreePath) => [
            worktreePath,
            this.getMergedPrCommitShasForWorktree(worktreePath),
          ]),
        ),
      },
    )) {
      await this.writeWorktreeWorkingStateEntry({
        worktreePath: entry.worktreePath,
        fetchedAt: Date.now(),
        gitWorkingState: entry.gitWorkingState,
      });
    }
  }

  private async writeWorktreeWorkingStateEntry(params: {
    worktreePath: string;
    fetchedAt: number;
    gitWorkingState?: ThreadGitWorkingState;
  }): Promise<void> {
    const previous = this.workingStateByWorktree.get(params.worktreePath);
    const cacheEntry: WorktreeGitWorkingStateCacheEntry = {
      worktreePath: params.worktreePath,
      fetchedAt: params.fetchedAt,
      ...(params.gitWorkingState ? { gitWorkingState: params.gitWorkingState } : {}),
    };
    this.workingStateByWorktree.set(params.worktreePath, cacheEntry);
    await this.getOverlayStore().writeThreadGitWorkingStateCacheEntry(cacheEntry);

    // Skip the push when the probed value is identical to what clients
    // already hold — avoids a snapshot patch + re-render on every idle
    // background refresh that found nothing changed.
    if (
      JSON.stringify(previous?.gitWorkingState ?? null) ===
      JSON.stringify(params.gitWorkingState ?? null)
    ) {
      return;
    }

    const notification: NavigationThreadGitWorkingStateUpdatedNotification = {
      method: "navigation/threadGitWorkingState/updated",
      params: {
        worktreePath: params.worktreePath,
        gitWorkingState: params.gitWorkingState ?? null,
        fetchedAt: params.fetchedAt,
      },
    };
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification,
    } as unknown as AgentEvent);
  }

  /**
   * React to turn/command-completion events by refreshing the affected
   * thread's working-state chips, so a commit/edit made by the agent updates
   * the dirty/unpushed chips without waiting for the next snapshot re-fetch.
   * Filters out our own published notifications (and the directory-status
   * sibling) to avoid a publish→listen loop.
   */
  handleAgentEventForWorkingState(event: AgentEvent): void {
    const method = event.notification.method as string;
    if (
      method !== "turn/completed" &&
      method !== "turn/failed" &&
      method !== "turn/cancelled" &&
      method !== "item/completed" &&
      method !== "thread/branch/updated"
    ) {
      return;
    }

    const params = event.notification.params as {
      branch?: string;
      threadId?: string;
      item?: { command?: string };
    };
    const threadId = params.threadId?.trim();
    if (!threadId) {
      return;
    }

    // A command item only matters here when it mutated git state; a turn
    // ending or expected-branch adoption always warrants a re-probe.
    if (method === "item/completed") {
      const command = params.item?.command;
      if (!command || !commandLooksLikeGitMutation(command)) {
        return;
      }
    }

    const threadKey = buildThreadIdentityKey(event.backend, threadId);
    if (method === "thread/branch/updated") {
      const branch = params.branch?.trim();
      const existingContext = this.prRefreshContextByThreadKey.get(threadKey);
      if (branch && existingContext) {
        this.prRefreshContextByThreadKey.set(threadKey, {
          ...existingContext,
          branch,
        });
      }
    }

    const worktreePath = this.worktreePathByThreadKey.get(threadKey);
    if (worktreePath) {
      getDesktopBackendRegistry().invalidateWorktreeWorkingState(worktreePath);
      void this.loadThreadGitWorkingStateCache().then(() => {
        this.startWorktreeWorkingStateRefresh({
          automatic: false,
          worktreePaths: [worktreePath],
          force: true,
        });
      });
    }

    if (method === "turn/completed") {
      const prContext = this.prRefreshContextByThreadKey.get(threadKey);
      if (prContext) {
        void this.refreshThreadPullRequests({
          ...prContext,
          provider: "github.com",
          trigger: "post-turn",
        }).catch((error) => {
          appServerLog.warn("post-turn PR refresh failed", {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  async markThreadSeen(
    request: MarkThreadSeenRequest,
  ): Promise<MarkThreadSeenResponse> {
    const backend = request.backend ?? "codex";

    const response = await this.getOverlayStore().markThreadSeen({
      backend,
      seenAt: request.seenAt,
      seenUpdatedAt: request.seenUpdatedAt,
      threadId: request.threadId,
    });

    logDebug("markThreadSeen", {
      backend,
      threadId: request.threadId,
      seenUpdatedAt: request.seenUpdatedAt ?? null,
    });

    return response;
  }

  async refreshThreadPullRequests(
    request: RefreshThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> {
    const backend = request.backend ?? "codex";
    const requestKey = getThreadPullRequestsRequestKey(backend, request);
    const pending = this.pendingThreadPullRequestRefreshes.get(requestKey);
    if (pending) {
      if (request.trigger === "user") {
        logDebug("threadPullRequestsRefresh:coalesced-request", {
          backend,
          branch: request.branch.trim(),
          directoryPathCount: request.directoryPaths.length,
          requestKey,
          threadId: request.threadId,
          trigger: request.trigger,
        });
      }
      return await pending;
    }

    const refreshPromise = this.refreshThreadPullRequestsUncached(
      backend,
      request,
      requestKey,
    );
    this.pendingThreadPullRequestRefreshes.set(requestKey, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.pendingThreadPullRequestRefreshes.delete(requestKey);
    }
  }

  private async refreshThreadPullRequestsUncached(
    backend: AppServerBackendKind,
    request: RefreshThreadPullRequestsRequest,
    requestKey: string,
  ): Promise<RefreshThreadPullRequestsResponse> {
    const provider = normalizePullRequestProvider(request.provider);
    const trigger = request.trigger ?? "scheduled";
    const fetcher = this.getPrFetcher();
    const ghAvailable = await fetcher.isGhAvailable();
    if (!ghAvailable) {
      if (trigger === "user") {
        logDebug("threadPullRequestsRefresh:skipped", userPrRefreshLogPayload({
          backend,
          branch: request.branch.trim(),
          directoryPathCount: request.directoryPaths.length,
          ghAvailable,
          provider,
          reason: "gh-unavailable",
          requestKey,
          threadId: request.threadId,
          trigger,
        }));
      }
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: [],
        ghAvailable: false,
      };
    }

    const overlay = this.getOverlayStore();
    const existing = await overlay.getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    await this.loadPrStatusRegistry();
    await this.loadPrLookupRegistry();
    const persistedPrs = existing?.prs ?? [];
    this.rememberPrStatuses(persistedPrs, existing?.prsFetchedAt ?? 0);
    const existingPrs = this.canonicalizePrs(persistedPrs);
    const branch = request.branch.trim();
    const lookupKey = getPullRequestLookupKey(request);
    const lookupDirectoryPaths = normalizePrLookupDirectoryPaths(
      request.directoryPaths,
    );
    const existingLookupMatches = existing?.prsRefreshKey === requestKey;
    if (existingLookupMatches) {
      this.rememberPrLookup({
        lookupKey,
        provider,
        branch,
        directoryPaths: lookupDirectoryPaths,
        prs: existingPrs,
        fetchedAt: existing?.prsFetchedAt ?? 0,
      });
    }
    const lookupEntry = this.prLookupRegistry.get(lookupKey);
    const currentLookupPrs = lookupEntry
      ? this.canonicalizePrs(lookupEntry.prs)
      : existingLookupMatches
        ? existingPrs
        : [];
    const knownPrs = this.mergePrHistory(existingPrs, currentLookupPrs);
    if (trigger === "user") {
      logDebug("threadPullRequestsRefresh:requested", userPrRefreshLogPayload({
        backend,
        branch,
        directoryPathCount: request.directoryPaths.length,
        existingLookupMatches,
        ghAvailable,
        lookupCacheHit: Boolean(lookupEntry),
        lookupKey,
        previousPrs: knownPrs,
        provider,
        requestKey,
        threadId: request.threadId,
        trigger,
      }));
    }
    if (lookupEntry && lookupEntry.fetchedAt > 0) {
      await this.persistPullRequestLookupHit({
        backend,
        request,
        requestKey,
        persistedPrs,
        persistedRefreshKey: existing?.prsRefreshKey,
        prs: currentLookupPrs,
        fetchedAt: lookupEntry.fetchedAt,
      });
    }
    // Terminal-state short-circuit: once every cached PR for a lookup is
    // merged or closed, we do not need to re-query gh for the same
    // branch/directory lookup.
    // A different lookup can mean the thread moved to a new branch after
    // merging an older PR, so stale terminal chips must not block it.
    //
    // No log here on purpose — this path runs on every navigation
    // refresh tick (once a minute per renderer) for every thread with
    // a terminal PR, so logging would produce one line per thread per
    // minute of pure noise. The interesting path is the cache-miss
    // fetch below, and callers that need to observe the no-op
    // programmatically can read `shortCircuited: true` off the
    // response.
    const allExistingPrsTerminal =
      currentLookupPrs.length > 0
      && currentLookupPrs.every(
        (pr) => pr.lifecycleState === "merged" || pr.lifecycleState === "closed",
      );
    if (
      allExistingPrsTerminal
      && branch !== "HEAD"
      && request.trigger !== "user"
      && request.trigger !== "post-turn"
    ) {
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: knownPrs,
        ghAvailable: true,
        shortCircuited: true,
      };
    }

    if (!branch || request.directoryPaths.length === 0) {
      if (trigger === "user") {
        logDebug("threadPullRequestsRefresh:skipped", userPrRefreshLogPayload({
          backend,
          branch,
          directoryPathCount: request.directoryPaths.length,
          ghAvailable: true,
          previousPrs: knownPrs,
          provider,
          reason: !branch ? "missing-branch" : "missing-directory-paths",
          requestKey,
          threadId: request.threadId,
          trigger,
        }));
      }
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: knownPrs,
        ghAvailable: true,
      };
    }

    this.startPullRequestLookupRefresh({
      backend,
      request,
      requestKey,
      lookupKey,
      lookupDirectoryPaths,
      previousPrs: knownPrs,
    });

    return {
      backend,
      threadId: request.threadId,
      provider,
      prs: knownPrs,
      ghAvailable: true,
    };
  }

  private async fetchPullRequestLookup(params: {
    backend: AppServerBackendKind;
    request: RefreshThreadPullRequestsRequest;
    lookupKey: string;
    lookupDirectoryPaths: string[];
    previousPrs: PrSummary[];
  }): Promise<{ prs: PrSummary[]; fetchedAt: number }> {
    const prs = (await detectPullRequestsForThread({
      fetcher: this.getPrFetcher(),
      branch: params.request.branch.trim(),
      directoryPaths: params.request.directoryPaths,
    })).map(normalizePrSummary);
    const fetchedAt = Date.now();
    const retainedPrs = await this.fetchRetainedNonTerminalPullRequests({
      prs: this.getPullRequestLookupSubscriberPreviousPrs({
        lookupKey: params.lookupKey,
        fallbackPrs: params.previousPrs,
      }),
      discoveredPrs: prs,
      cwd: params.lookupDirectoryPaths[0] ?? params.request.directoryPaths[0],
    });
    const statusPrs = dedupePrsByStatusKey([...prs, ...retainedPrs]);
    const changedStatusPrs = this.rememberPrStatuses(statusPrs, fetchedAt);
    await this.writePrStatusesToCache(statusPrs, fetchedAt);
    await this.publishPullRequestStatusUpdates({
      backend: params.backend,
      prs: changedStatusPrs,
    });
    this.rememberPrLookup({
      lookupKey: params.lookupKey,
      provider: normalizePullRequestProvider(params.request.provider),
      branch: params.request.branch.trim(),
      directoryPaths: params.lookupDirectoryPaths,
      prs,
      fetchedAt,
    });
    await this.writePrLookupToCache({
      lookupKey: params.lookupKey,
      provider: normalizePullRequestProvider(params.request.provider),
      branch: params.request.branch.trim(),
      directoryPaths: params.lookupDirectoryPaths,
      prs,
      fetchedAt,
    });

    return { prs, fetchedAt };
  }

  private getPullRequestLookupSubscriberPreviousPrs(params: {
    lookupKey: string;
    fallbackPrs: PrSummary[];
  }): PrSummary[] {
    const subscribers = this.prLookupSubscribers.get(params.lookupKey);
    if (!subscribers?.size) {
      return params.fallbackPrs;
    }
    return [...subscribers.values()].flatMap((subscriber) => subscriber.previousPrs);
  }

  private async fetchRetainedNonTerminalPullRequests(params: {
    prs: PrSummary[];
    discoveredPrs: PrSummary[];
    cwd?: string;
  }): Promise<PrSummary[]> {
    const cwd = params.cwd;
    if (!cwd) {
      return [];
    }

    const discoveredKeys = new Set(
      params.discoveredPrs.map((pr) => getPrStatusKey(pr)),
    );
    const seenRetainedKeys = new Set<string>();
    const retainedPrs = params.prs
      .map(normalizePrSummary)
      .filter((pr) => {
        const key = getPrStatusKey(pr);
        if (discoveredKeys.has(key)) return false;
        if (seenRetainedKeys.has(key)) return false;
        if (pr.lifecycleState === "merged" || pr.lifecycleState === "closed") {
          return false;
        }
        seenRetainedKeys.add(key);
        return true;
      });

    if (retainedPrs.length === 0) {
      return [];
    }

    const fetcher = this.getPrFetcher();
    const refreshed = await Promise.all(
      retainedPrs.map((pr) =>
        fetcher.fetchPullRequestByUrl({ cwd, url: pr.url }),
      ),
    );
    return refreshed.filter((pr): pr is PrSummary => Boolean(pr))
      .map(normalizePrSummary);
  }

  private startPullRequestLookupRefresh(params: {
    backend: AppServerBackendKind;
    request: RefreshThreadPullRequestsRequest;
    requestKey: string;
    lookupKey: string;
    lookupDirectoryPaths: string[];
    previousPrs: PrSummary[];
  }): void {
    const trigger = params.request.trigger ?? "scheduled";
    const provider = normalizePullRequestProvider(params.request.provider);
    const pending = this.pendingPrLookupRefreshes.get(params.lookupKey);
    if (pending) {
      this.addPullRequestLookupSubscriber(params.lookupKey, params);
      if (trigger === "user") {
        logDebug("threadPullRequestsRefresh:coalesced-background", userPrRefreshLogPayload({
          backend: params.backend,
          branch: params.request.branch.trim(),
          directoryPathCount: params.request.directoryPaths.length,
          lookupKey: params.lookupKey,
          previousPrs: params.previousPrs,
          provider,
          requestKey: params.requestKey,
          threadId: params.request.threadId,
          trigger,
        }));
      }
      return;
    }

    const claim = this.claimPullRequestLookupRefreshKey(
      params.lookupKey,
      trigger,
      provider,
      params.previousPrs.length > 0
        && params.previousPrs.every(
          (pr) => pr.lifecycleState === "merged" || pr.lifecycleState === "closed",
        ),
    );
    if (claim.skippedReason) {
      if (trigger === "user") {
        logDebug("threadPullRequestsRefresh:skipped", {
          ...userPrRefreshLogPayload({
            backend: params.backend,
            branch: params.request.branch.trim(),
            directoryPathCount: params.request.directoryPaths.length,
            lookupKey: params.lookupKey,
            previousPrs: params.previousPrs,
            provider,
            reason: claim.skippedReason,
            requestKey: params.requestKey,
            threadId: params.request.threadId,
            trigger,
          }),
          ageMs: claim.ageMs,
          minIntervalMs: claim.minIntervalMs,
          nextAllowedInMs: claim.nextAllowedInMs,
        });
      }
      return;
    }
    const refreshKey = claim.refreshKey;

    this.addPullRequestLookupSubscriber(params.lookupKey, params);
    if (trigger === "user") {
      logDebug("threadPullRequestsRefresh:background-start", userPrRefreshLogPayload({
        backend: params.backend,
        branch: params.request.branch.trim(),
        directoryPathCount: params.request.directoryPaths.length,
        lookupKey: params.lookupKey,
        previousPrs: params.previousPrs,
        provider,
        requestKey: params.requestKey,
        threadId: params.request.threadId,
        trigger,
      }));
    }
    const promise = this.fetchPullRequestLookup(params)
      .then(async ({ prs, fetchedAt }) => {
        const publishResult = await this.persistPullRequestLookupSubscribers({
          lookupKey: params.lookupKey,
          prs,
          fetchedAt,
        });
        if (trigger === "user") {
          logDebug("threadPullRequestsRefresh:background-complete", {
            ...userPrRefreshLogPayload({
              backend: params.backend,
              branch: params.request.branch.trim(),
              directoryPathCount: params.request.directoryPaths.length,
              lookupKey: params.lookupKey,
              previousPrs: params.previousPrs,
              provider,
              requestKey: params.requestKey,
              threadId: params.request.threadId,
              trigger,
            }),
            changedThreadCount: publishResult.changedThreadCount,
            fetchedAt,
            fetchedPrIds: prLogIds(prs),
            subscriberCount: publishResult.subscriberCount,
          });
        }
      })
      .catch((error) => {
        appServerLog.warn("background PR lookup refresh failed", {
          threadId: params.request.threadId,
          branch: params.request.branch.trim(),
          previousPrIds: prLogIds(params.previousPrs),
          provider,
          refreshKey,
          requestKey: params.requestKey,
          trigger,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.pendingPrLookupRefreshes.get(params.lookupKey) === promise) {
          this.pendingPrLookupRefreshes.delete(params.lookupKey);
          this.prLookupSubscribers.delete(params.lookupKey);
        }
      });
    this.pendingPrLookupRefreshes.set(params.lookupKey, promise);
  }

  private addPullRequestLookupSubscriber(
    lookupKey: string,
    params: {
      backend: AppServerBackendKind;
      request: RefreshThreadPullRequestsRequest;
      requestKey: string;
      previousPrs: PrSummary[];
    },
  ): void {
    const subscribers =
      this.prLookupSubscribers.get(lookupKey) ?? new Map<string, PrLookupSubscriber>();
    const threadKey = buildThreadIdentityKey(
      params.backend,
      params.request.threadId,
    );
    subscribers.set(threadKey, {
      backend: params.backend,
      threadId: params.request.threadId,
      requestKey: params.requestKey,
      previousPrs: params.previousPrs,
    });
    this.prLookupSubscribers.set(lookupKey, subscribers);
  }

  private async persistPullRequestLookupSubscribers(params: {
    lookupKey: string;
    prs: PrSummary[];
    fetchedAt: number;
  }): Promise<{ changedThreadCount: number; subscriberCount: number }> {
    const subscribers = this.prLookupSubscribers.get(params.lookupKey);
    if (!subscribers?.size) {
      return { changedThreadCount: 0, subscriberCount: 0 };
    }

    let changedThreadCount = 0;
    await Promise.all(
      [...subscribers.values()].map(async (subscriber) => {
        const nextPrs = this.mergePrHistory(subscriber.previousPrs, params.prs);
        await this.getOverlayStore().setThreadPullRequests({
          backend: subscriber.backend,
          threadId: subscriber.threadId,
          prs: nextPrs,
          fetchedAt: params.fetchedAt,
          refreshKey: subscriber.requestKey,
        });

        if (!prSummariesEqual(subscriber.previousPrs, nextPrs)) {
          changedThreadCount += 1;
          await this.publishThreadPullRequestsUpdated({
            backend: subscriber.backend,
            threadId: subscriber.threadId,
            prs: nextPrs,
          });
        }
      }),
    );
    return { changedThreadCount, subscriberCount: subscribers.size };
  }

  private async persistPullRequestLookupHit(params: {
    backend: AppServerBackendKind;
    request: RefreshThreadPullRequestsRequest;
    requestKey: string;
    persistedPrs: PrSummary[];
    persistedRefreshKey?: string;
    prs: PrSummary[];
    fetchedAt: number;
  }): Promise<void> {
    const nextPrs = this.mergePrHistory(params.persistedPrs, params.prs);
    if (
      params.persistedRefreshKey === params.requestKey
      && prSummariesEqual(params.persistedPrs, nextPrs)
    ) {
      return;
    }

    await this.getOverlayStore().setThreadPullRequests({
      backend: params.backend,
      threadId: params.request.threadId,
      prs: nextPrs,
      fetchedAt: params.fetchedAt,
      refreshKey: params.requestKey,
    });

    if (!prSummariesEqual(params.persistedPrs, nextPrs)) {
      await this.publishThreadPullRequestsUpdated({
        backend: params.backend,
        threadId: params.request.threadId,
        prs: nextPrs,
      });
    }
  }

  private claimPullRequestLookupRefreshKey(
    lookupKey: string,
    trigger: NonNullable<RefreshThreadPullRequestsRequest["trigger"]>,
    provider: string,
    terminalOnly: boolean,
  ): PrLookupRefreshClaim {
    const now = Date.now();
    const minInterval =
      trigger === "post-turn"
        ? 0
        : trigger === "user"
        ? terminalOnly
          ? TERMINAL_USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS
          : USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS
        : THREAD_PR_REFRESH_MIN_INTERVAL_MS;
    const timestampField =
      trigger === "user"
        ? "lastUserRefreshRequestedAt"
        : "lastScheduledRefreshRequestedAt";
    const entry = this.prLookupRegistry.get(lookupKey);
    const lastRequestedAt = Math.max(
      entry?.[timestampField] ?? 0,
      entry?.fetchedAt ?? 0,
    );
    const ageMs = now - lastRequestedAt;
    const due = ageMs >= minInterval;
    if (!due) {
      return {
        skippedReason: "cooldown",
        ageMs,
        minIntervalMs: minInterval,
        nextAllowedInMs: minInterval - ageMs,
      };
    }
    if (trigger === "scheduled" && !this.prStatusTokenBucket.tryTake(now)) {
      return { skippedReason: "scheduled-token-bucket" };
    }

    if (entry) {
      entry[timestampField] = now;
    } else {
      this.prLookupRegistry.set(lookupKey, {
        prs: [],
        fetchedAt: 0,
        provider: normalizePullRequestProvider(provider),
        branch: "",
        directoryPaths: [],
        [timestampField]: now,
      });
    }

    return { refreshKey: lookupKey };
  }

  private rememberPrStatuses(prs: PrSummary[], fetchedAt: number): PrSummary[] {
    const changedPrs: PrSummary[] = [];
    for (const pr of prs.map(normalizePrSummary)) {
      const key = getPrStatusKey(pr);
      const current = this.prStatusRegistry.get(key);
      if (current && current.fetchedAt > fetchedAt) {
        continue;
      }
      if (!current || !prSummariesEqual([current.pr], [pr])) {
        changedPrs.push(pr);
      }
      this.prStatusRegistry.set(key, {
        ...current,
        pr,
        fetchedAt,
      });
    }
    return changedPrs;
  }

  private rememberPrLookup(entry: {
    lookupKey: string;
    provider: string;
    branch: string;
    directoryPaths: string[];
    prs: PrSummary[];
    fetchedAt: number;
  }): void {
    const current = this.prLookupRegistry.get(entry.lookupKey);
    if (current && current.fetchedAt > entry.fetchedAt) {
      return;
    }
    this.prLookupRegistry.set(entry.lookupKey, {
      ...current,
      provider: normalizePullRequestProvider(entry.provider),
      branch: entry.branch,
      directoryPaths: entry.directoryPaths,
      prs: entry.prs.map(normalizePrSummary),
      fetchedAt: entry.fetchedAt,
    });
  }

  private async loadPrStatusRegistry(): Promise<void> {
    if (this.prStatusRegistryLoaded) {
      return;
    }
    this.prStatusRegistryLoaded = true;
    const entries = await this.getOverlayStore().readPrStatusCache();
    for (const entry of Object.values(entries)) {
      this.rememberPrStatuses([entry.pr], entry.fetchedAt);
    }
  }

  private async loadPrLookupRegistry(): Promise<void> {
    if (this.prLookupRegistryLoaded) {
      return;
    }
    this.prLookupRegistryLoaded = true;
    const entries = await this.getOverlayStore().readPrLookupCache();
    for (const entry of Object.values(entries)) {
      this.rememberPrLookup(entry);
      this.rememberPrStatuses(entry.prs, entry.fetchedAt);
    }
  }

  private async writePrStatusesToCache(
    prs: PrSummary[],
    fetchedAt: number,
  ): Promise<void> {
    const entries: PrStatusCacheEntry[] = prs.map(normalizePrSummary).map((pr) => ({
      provider: normalizePullRequestProvider(pr.provider),
      prKey: getPrStatusKey(pr),
      fetchedAt,
      pr,
    }));
    await this.getOverlayStore().writePrStatusCacheEntries(entries);
  }

  private async writePrLookupToCache(entry: PrLookupCacheEntry): Promise<void> {
    await this.getOverlayStore().writePrLookupCacheEntry(entry);
  }

  private canonicalizePrs(prs: PrSummary[]): PrSummary[] {
    return prs.map((pr) => {
      const normalized = normalizePrSummary(pr);
      return this.prStatusRegistry.get(getPrStatusKey(normalized))?.pr ?? normalized;
    });
  }

  private mergePrHistory(
    existingPrs: PrSummary[],
    discoveredPrs: PrSummary[],
  ): PrSummary[] {
    const merged = this.canonicalizePrs(existingPrs);
    const indexes = new Map<string, number>();
    merged.forEach((pr, index) => {
      indexes.set(getPrStatusKey(pr), index);
    });

    for (const pr of this.canonicalizePrs(discoveredPrs)) {
      const key = getPrStatusKey(pr);
      const existingIndex = indexes.get(key);
      if (existingIndex === undefined) {
        indexes.set(key, merged.length);
        merged.push(pr);
      } else {
        merged[existingIndex] = pr;
      }
    }

    return merged;
  }

  private seedPrStatusRegistryFromThreads(
    threads: NavigationSnapshot["threads"],
  ): void {
    for (const thread of threads) {
      if (!thread.prs?.length) {
        continue;
      }
      this.rememberPrStatuses(thread.prs, 0);
    }
  }

  private applyCanonicalPrStatuses(
    threads: NavigationSnapshot["threads"],
  ): { threads: NavigationSnapshot["threads"]; changed: boolean } {
    let changed = false;
    const canonicalThreads = threads.map((thread) => {
      if (!thread.prs?.length) {
        return thread;
      }
      const prs = this.canonicalizePrs(thread.prs);
      if (prSummariesEqual(thread.prs, prs)) {
        return thread;
      }
      changed = true;
      return { ...thread, prs };
    });

    return { threads: canonicalThreads, changed };
  }

  private async publishThreadPullRequestsUpdated(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prs: PrSummary[];
  }): Promise<void> {
    const worktreePath = this.rememberMergedPrCommitShasForThread(params);
    if (worktreePath) {
      getDesktopBackendRegistry().invalidateWorktreeWorkingState(worktreePath);
      void this.loadThreadGitWorkingStateCache().then(() => {
        this.startWorktreeWorkingStateRefresh({
          automatic: false,
          worktreePaths: [worktreePath],
          force: true,
        });
      });
    }
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: params.backend,
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: params.threadId,
          prs: params.prs,
        },
      },
    });
  }

  private async publishPullRequestStatusUpdates(params: {
    backend: AppServerBackendKind;
    prs: PrSummary[];
  }): Promise<void> {
    await Promise.all(
      params.prs.map(async (pr) => {
        await getDesktopBackendRegistry().publishLocalEvent({
          backend: params.backend,
          notification: {
            method: "pullRequest/status/updated",
            params: {
              prKey: getPrStatusKey(pr),
              pr,
            },
          },
        });
      }),
    );
  }

  async getGhStatus(request: GetGhStatusRequest): Promise<GhStatus> {
    const fetcher = this.getPrFetcher();
    if (request.recheck) {
      fetcher.invalidateGhCaches();
    }
    // The fetcher logs once per fresh probe (cache + in-flight dedup
    // keep StrictMode mount duplicates silent). The IPC layer just
    // returns the parsed status.
    return await fetcher.getAuthStatus();
  }

  async setThreadReaction(
    request: SetThreadReactionRequest,
  ): Promise<SetThreadReactionResponse> {
    const backend = request.backend ?? "codex";

    const overlay = await this.getOverlayStore().setThreadReaction({
      backend,
      threadId: request.threadId,
      emoji: request.emoji,
      present: request.present,
    });

    logDebug("setThreadReaction", {
      backend,
      threadId: request.threadId,
      emoji: request.emoji,
      present: request.present,
      reactionCount: overlay.reactions?.length ?? 0,
    });

    return {
      backend,
      threadId: request.threadId,
      reactions: overlay.reactions ?? [],
    };
  }

  async setThreadPin(
    request: SetThreadPinRequest,
  ): Promise<SetThreadPinResponse> {
    const backend = request.backend ?? "codex";

    const overlay = await this.getOverlayStore().setThreadPin({
      backend,
      threadId: request.threadId,
      pinnedRank: request.pinnedRank,
    });

    logDebug("setThreadPin", {
      backend,
      threadId: request.threadId,
      pinnedRank: overlay.pinnedRank ?? null,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: overlay.pinnedRank
        ? {
            method: "thread/pin/added",
            params: {
              threadId: request.threadId,
              pinnedRank: overlay.pinnedRank,
            },
          }
        : {
            method: "thread/pin/removed",
            params: {
              threadId: request.threadId,
            },
          },
    });

    return {
      backend,
      threadId: request.threadId,
      pinnedRank: overlay.pinnedRank,
    };
  }

  async setThreadAgent(
    request: SetThreadAgentRequest,
  ): Promise<SetThreadAgentResponse> {
    const backend = request.backend ?? "codex";

    const overlay = await this.getOverlayStore().setThreadAgent({
      backend,
      threadId: request.threadId,
      agent: request.agent,
    });

    logDebug("setThreadAgent", {
      backend,
      threadId: request.threadId,
      agentName: overlay.agent?.name ?? null,
      instructionLineCount: overlay.agent?.instructionLineCount ?? 0,
      instructionsTooLong: overlay.agent?.instructionsTooLong ?? false,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/agent/updated",
        params: {
          threadId: request.threadId,
        },
      },
    });

    return {
      backend,
      threadId: request.threadId,
      agent: overlay.agent,
    };
  }

  async reorderThreadPins(
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse> {
    const pinnedRanks = await this.getOverlayStore().reorderThreadPins({
      threadKeys: request.threadKeys,
    });

    logDebug("reorderThreadPins", {
      pinCount: request.threadKeys.length,
    });

    // Pin order is global across backends, so this is a global notification.
    // `backend` is required by publishLocalEvent but irrelevant here — use a
    // fixed value (matches the directory/pin/reordered handler).
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/pin/reordered",
        params: {
          pinnedRanks,
        },
      },
    });

    return { pinnedRanks };
  }

  async setThreadParent(
    request: SetThreadParentRequest,
  ): Promise<SetThreadParentResponse> {
    const backend = request.backend ?? "codex";
    const overlay = await this.getOverlayStore().setThreadParent({
      backend,
      threadId: request.threadId,
      parentThreadId: request.parentThreadId,
    });

    logDebug("setThreadParent", {
      backend,
      threadId: request.threadId,
      parentThreadId: overlay.parentThreadId ?? null,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: overlay.parentThreadId
        ? {
            method: "thread/parent/set",
            params: {
              threadId: request.threadId,
              parentThreadId: overlay.parentThreadId,
            },
          }
        : {
            method: "thread/parent/cleared",
            params: {
              threadId: request.threadId,
            },
          },
    });

    return {
      backend,
      threadId: request.threadId,
      parentThreadId: overlay.parentThreadId,
    };
  }

  async updateSubthreadOrder(
    request: UpdateSubthreadOrderRequest,
  ): Promise<UpdateSubthreadOrderResponse> {
    const backend = request.backend ?? "codex";
    const threadIds = await this.getOverlayStore().updateSubthreadOrder({
      backend,
      parentThreadId: request.parentThreadId,
      threadIds: request.threadIds,
    });

    logDebug("updateSubthreadOrder", {
      backend,
      parentThreadId: request.parentThreadId,
      childCount: threadIds.length,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/subthreadOrder/updated",
        params: {
          parentThreadId: request.parentThreadId,
          threadIds,
        },
      },
    });

    return { backend, parentThreadId: request.parentThreadId, threadIds };
  }

  async setSubthreadsCollapsed(
    request: SetSubthreadsCollapsedRequest,
  ): Promise<SetSubthreadsCollapsedResponse> {
    const backend = request.backend ?? "codex";
    const overlay = await this.getOverlayStore().setSubthreadsCollapsed({
      backend,
      parentThreadId: request.parentThreadId,
      collapsed: request.collapsed,
    });

    logDebug("setSubthreadsCollapsed", {
      backend,
      parentThreadId: request.parentThreadId,
      collapsed: overlay.subthreadsCollapsed === true,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/subthreadsCollapsed/updated",
        params: {
          parentThreadId: request.parentThreadId,
          collapsed: overlay.subthreadsCollapsed === true,
        },
      },
    });

    return {
      backend,
      parentThreadId: request.parentThreadId,
      collapsed: overlay.subthreadsCollapsed === true,
    };
  }

  /**
   * Directory pin handlers (plan 2026-05-09-002, Unit G). Mirror of
   * `setThreadPin` / `reorderThreadPins` with the `backend` dim
   * dropped. The handlers reject pseudo-directory keys (workspace /
   * unlinked) — these are synthesized aggregator entries that don't
   * represent a user-picked folder, so pinning them is meaningless.
   * The check is on the key prefix rather than a snapshot lookup
   * because the overlay store doesn't have visibility into the
   * snapshot at write time, and we want the rejection to be
   * deterministic.
   *
   * `publishLocalEvent` reuses the existing local-bus infrastructure
   * (no per-directory bus scope — these are global events on the
   * default backend `codex` for routing purposes; the renderer
   * listens for the `method` regardless of `backend`).
   */
  async setDirectoryPin(
    request: SetDirectoryPinRequest,
  ): Promise<SetDirectoryPinResponse> {
    rejectNonDirectoryPinKey(request.directoryKey);

    const overlay = await this.getOverlayStore().setDirectoryPin({
      directoryKey: request.directoryKey,
      pinnedRank: request.pinnedRank,
    });

    logDebug("setDirectoryPin", {
      directoryKey: request.directoryKey,
      pinnedRank: overlay.pinnedRank ?? null,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: overlay.pinnedRank
        ? {
            method: "directory/pin/added",
            params: {
              directoryKey: request.directoryKey,
              pinnedRank: overlay.pinnedRank,
            },
          }
        : {
            method: "directory/pin/removed",
            params: {
              directoryKey: request.directoryKey,
            },
          },
    });

    return {
      directoryKey: request.directoryKey,
      pinnedRank: overlay.pinnedRank,
    };
  }

  async reorderDirectoryPins(
    request: ReorderDirectoryPinsRequest,
  ): Promise<ReorderDirectoryPinsResponse> {
    for (const directoryKey of request.directoryKeys) {
      rejectNonDirectoryPinKey(directoryKey);
    }

    const pinnedRanks = await this.getOverlayStore().reorderDirectoryPins({
      directoryKeys: request.directoryKeys,
    });

    logDebug("reorderDirectoryPins", {
      pinCount: request.directoryKeys.length,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: {
        method: "directory/pin/reordered",
        params: {
          pinnedRanks,
        },
      },
    });

    return { pinnedRanks };
  }

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    const refreshedRequest = await this.refreshLaunchpadDirectoryGitStatus(request);
    return await getDesktopBackendRegistry().ensureDirectoryLaunchpad(refreshedRequest);
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    return await getDesktopBackendRegistry().updateDirectoryLaunchpad(request);
  }

  async resetDirectoryLaunchpad(
    request: ResetDirectoryLaunchpadRequest,
  ): Promise<ResetDirectoryLaunchpadResponse> {
    return await getDesktopBackendRegistry().resetDirectoryLaunchpad(request);
  }

  async pickDirectoryFromDisk(
    parentWindow?: BrowserWindow,
  ): Promise<PickDirectoryFromDiskResponse> {
    const e2ePickPath = process.env.PWRAGENT_REPLAY_FIXTURE_PATH
      ? process.env.PWRAGENT_E2E_PICK_DIRECTORY_PATH?.trim()
      : undefined;
    if (e2ePickPath) {
      return { canceled: false, path: e2ePickPath };
    }

    // Anchor the dialog to whichever window dispatched the IPC so it
    // appears as a sheet on macOS (the renderer's expectation) instead
    // of floating free. `dialog.showOpenDialog` accepts an optional
    // `BrowserWindow` first arg for exactly this; if the caller didn't
    // pass one we fall back to the focused window.
    const window =
      parentWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
    // Open where the user last browsed (the parent of their last pick), else the
    // home folder — much friendlier than the OS default, which is Documents on a
    // fresh Windows profile and looks like you can't escape it.
    const defaultPath = this.lastPickedDirectoryParent ?? os.homedir();
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: "Add directory",
          buttonLabel: "Add directory",
          defaultPath,
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "Add directory",
          buttonLabel: "Add directory",
          defaultPath,
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    this.lastPickedDirectoryParent = path.dirname(result.filePaths[0]);
    return { canceled: false, path: result.filePaths[0] };
  }

  async registerDirectoryFromDisk(
    request: RegisterDirectoryFromDiskRequest,
  ): Promise<RegisterDirectoryFromDiskResponse> {
    const response = await registerDirectoryFromDisk(request, {
      ensureDirectoryLaunchpad: (req) => this.ensureDirectoryLaunchpad(req),
    });
    if (response.ok) {
      this.lastDirectoriesByKey.set(response.directoryKey, {
        key: response.directoryKey,
        kind: "directory",
        label: response.directoryLabel,
        path: response.directoryPath,
        threadKeys: [],
        needsAttentionCount: 0,
      });
    }
    return response;
  }

  async analyzeFocusedDiff(
    request: FocusedDiffAnalysisRequest
  ): Promise<FocusedDiffAnalysisResponse> {
    // Diff condensation is gated by an experimental setting. When the
    // user has it disabled, never call the focused-diff service — return
    // the synthetic "full" response that the renderer treats as
    // "render every hunk, hide nothing". This is the diff-eliding gate
    // that keeps us from sending unsolicited xAI requests.
    //
    // PWRAGENT_FOCUSED_DIFF_TEST_RESPONSE bypasses the gate so E2Es that
    // exercise the focused-diff path keep working with the default-off
    // setting; without that bypass the override (consumed inside
    // FocusedDiffService.analyze) never gets a chance to run.
    const settings = await getDesktopSettingsService().readSettings();
    const condensation = settings.experimental.diffCondensation;
    const testOverridePresent = Boolean(
      process.env.PWRAGENT_FOCUSED_DIFF_TEST_RESPONSE,
    );
    if (!condensation.enabled.value && !testOverridePresent) {
      logDebug("analyzeFocusedDiff", {
        filePath: request.filePath ?? null,
        hunkCount: request.hunks.length,
        mode: "full",
        source: "condensation-disabled",
        hiddenHunkCount: 0,
      });
      return {
        mode: "full",
        source: "condensation-disabled",
        hiddenHunkIndices: [],
        hiddenHunkCount: 0,
        decisions: request.hunks.map((hunk) => ({
          index: hunk.index,
          disposition: "show" as const,
          reasonCode: "keep" as const,
          reason: "diff condensation disabled in settings",
          confidence: 1,
        })),
      };
    }

    const response = await this.getFocusedDiffService(
      condensation.model.value === "auto" ? undefined : condensation.model.value,
    ).analyze(request);

    logDebug("analyzeFocusedDiff", {
      filePath: request.filePath ?? null,
      hunkCount: request.hunks.length,
      mode: response.mode,
      source: response.source,
      hiddenHunkCount: response.hiddenHunkCount,
      condensationModel: condensation.model.value,
    });

    return response;
  }

  async close(): Promise<void> {
    this.focusedDiffService = null;
    this.focusedDiffServiceApiKey = undefined;
    this.focusedDiffServiceModel = undefined;
    this.prFetcher = undefined;
    this.pendingNavigationSnapshots.clear();
    this.pendingThreadPullRequestRefreshes.clear();
    this.pendingEditCommitResolves.clear();
    this.prStatusRegistry.clear();
    this.prLookupRegistry.clear();
    this.pendingPrLookupRefreshes.clear();
    this.prLookupSubscribers.clear();
    this.prStatusRegistryLoaded = false;
    this.prLookupRegistryLoaded = false;
    this.pendingDirectoryGitStatusRefreshes.clear();
    this.pendingDirectoryGitStatusKeys.clear();
    this.previousDirectoriesByBackend.clear();
    this.directoryGitStatusByKey.clear();
    this.directoryGitStatusCacheLoaded = false;
    this.automaticDirectoryGitStatusRefreshesStarted = 0;
    this.lastDirectoriesByKey.clear();
    this.pendingWorktreeWorkingStateRefreshes.clear();
    this.pendingWorktreeWorkingStateKeys.clear();
    this.workingStateByWorktree.clear();
    this.workingStateCacheLoaded = false;
    this.automaticWorktreeWorkingStateRefreshesStarted = 0;
    this.worktreePathByThreadKey.clear();
    this.prRefreshContextByThreadKey.clear();
    await this.threadMigrationService?.dispose();
    this.threadMigrationService = null;
    await disposeDesktopBackendRegistry();
  }

  private getPrFetcher(): GithubPrFetcher {
    if (!this.prFetcher) {
      this.prFetcher = new GithubPrFetcher();
    }
    return this.prFetcher;
  }

  private getOverlayStore(): AppServerOverlayStoreLike {
    return getDesktopOverlayStore();
  }

  private getFocusedDiffService(modelOverride?: string): FocusedDiffService {
    const apiKey = getDesktopSettingsService().resolveGrokApiKeySync();
    if (
      this.focusedDiffService
      && this.focusedDiffServiceApiKey === apiKey
      && this.focusedDiffServiceModel === modelOverride
    ) {
      return this.focusedDiffService;
    }

    this.focusedDiffService = new FocusedDiffService({
      apiKey,
      ...(modelOverride ? { model: modelOverride } : {}),
    });
    this.focusedDiffServiceApiKey = apiKey;
    this.focusedDiffServiceModel = modelOverride;
    return this.focusedDiffService;
  }
}

function isFreshDirectoryGitStatusCacheEntry(
  entry: DirectoryGitStatusCacheEntry,
): boolean {
  return Date.now() - entry.fetchedAt < DIRECTORY_GIT_STATUS_CACHE_MAX_AGE_MS;
}

function isFreshWorktreeWorkingStateCacheEntry(
  entry: WorktreeGitWorkingStateCacheEntry,
): boolean {
  return Date.now() - entry.fetchedAt < WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS;
}

function resolveThreadPullRequestDirectoryPaths(
  thread: NavigationSnapshot["threads"][number],
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const directory of thread.linkedDirectories ?? []) {
    const candidate =
      directory.kind === "worktree"
        ? directory.worktreePath ?? directory.path
        : directory.path;
    const normalized = candidate?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

/**
 * True when a command string runs a git subcommand that can change the
 * working tree, the index, or local commits (and therefore the
 * dirty/unpushed chips). Mirrors the option-skipping shape of the
 * edited-file-groups commit matcher so `git -C <path> commit` still
 * matches, while a command that merely mentions "commit" later does not.
 */
function commandLooksLikeGitMutation(command: string): boolean {
  return GIT_MUTATION_COMMAND.test(command);
}

const GIT_MUTATION_COMMAND =
  /(?:^|[;&|]\s*)git\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*(?:commit|merge|rebase|reset|revert|stash|checkout|switch|restore|cherry-pick|pull|push|am|apply|clean)\b/;

const appServerService = new DesktopAppServerService();

let unsubscribeWorkingStateEvents: (() => void) | undefined;

export function registerAppServerIpcHandlers(): void {
  // Refresh a thread's working-state chips when the agent finishes a turn
  // or a git-mutating command in its worktree. Re-registering tears the
  // previous subscription down first so repeated calls don't stack listeners.
  unsubscribeWorkingStateEvents?.();
  unsubscribeWorkingStateEvents = getDesktopBackendRegistry().onEvent((event) => {
    appServerService.handleAgentEventForWorkingState(event);
  });

  ipcMain.removeHandler(APP_SERVER_LIST_SKILLS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_LIST_SKILLS_CHANNEL,
    async (
      _event,
      request?: AppServerListSkillsRequest,
    ): Promise<AppServerListSkillsResponse> => {
      return await appServerService.listSkills(request);
    }
  );
  ipcMain.removeHandler(APP_SERVER_LIST_THREADS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_LIST_THREADS_CHANNEL,
    async (
      _event,
      request?: AppServerListThreadsRequest
    ): Promise<AppServerListThreadsResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:listThreads",
        detail: {
          archived: Boolean(request?.archived),
          backend: request?.backend ?? null,
        },
        operation: async () => await appServerService.listThreads(request),
      });
    }
  );
  ipcMain.removeHandler(THREAD_SEARCH_CHANNEL);
  ipcMain.handle(
    THREAD_SEARCH_CHANNEL,
    async (
      _event,
      request?: ThreadSearchRequest,
    ): Promise<ThreadSearchResponse> => {
      return await appServerService.searchThreads(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_READ_THREAD_CHANNEL,
    async (
      _event,
      request: AppServerReadThreadRequest
    ): Promise<AppServerReadThreadResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:readThread",
        detail: {
          backend: request.backend,
          threadId: request.threadId,
        },
        operation: async () => await appServerService.readThread(request),
      });
    }
  );
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL);
  ipcMain.handle(
    APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL,
    async (
      _event,
      request: GetThreadFileDiffRequest,
    ): Promise<GetThreadFileDiffResponse> => {
      const diff =
        getLiveThreadFileDiff(request.ref) ??
        getThreadReplayFileDiff(request.ref);
      return diff === undefined
        ? { omittedReason: "Diff is no longer available for this thread entry." }
        : { diff };
    },
  );
  ipcMain.removeHandler(APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL);
  ipcMain.handle(
    APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL,
    async (
      _event,
      request: PersistThreadUsageActivityRequest,
    ): Promise<PersistThreadUsageActivityResponse> => {
      return await appServerService.persistThreadUsageActivity(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_ARCHIVE_THREAD_CHANNEL,
    async (
      _event,
      request: ArchiveThreadRequest,
    ): Promise<ArchiveThreadResponse> => {
      return await appServerService.archiveThread(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_RESTORE_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESTORE_THREAD_CHANNEL,
    async (
      _event,
      request: RestoreThreadRequest,
    ): Promise<RestoreThreadResponse> => {
      return await appServerService.restoreThread(request);
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCES_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_LIST_SOURCES_CHANNEL,
    async (): Promise<ListThreadMigrationSourcesResponse> => {
      return await appServerService.listThreadMigrationSources();
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL,
    async (
      _event,
      request: ListThreadMigrationSourceThreadsRequest,
    ): Promise<ListThreadMigrationSourceThreadsResponse> => {
      return await appServerService.listThreadMigrationSourceThreads(request);
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_START_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_START_CHANNEL,
    async (
      _event,
      request: StartThreadMigrationRequest,
    ): Promise<StartThreadMigrationResponse> => {
      return await appServerService.startThreadMigration(request);
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_RETRY_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_RETRY_CHANNEL,
    async (
      _event,
      request: RetryThreadMigrationRequest,
    ): Promise<StartThreadMigrationResponse> => {
      return await appServerService.retryThreadMigration(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_ARCHIVE_WORKTREE_CHANNEL,
    async (
      _event,
      request: ArchiveWorktreeRequest,
    ): Promise<ArchiveWorktreeResponse> => {
      return await appServerService.archiveWorktree(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_RESTORE_WORKTREE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESTORE_WORKTREE_CHANNEL,
    async (
      _event,
      request: RestoreWorktreeRequest,
    ): Promise<RestoreWorktreeResponse> => {
      return await appServerService.restoreWorktree(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL,
    async (
      _event,
      request: HandoffThreadWorkspaceRequest,
    ): Promise<HandoffThreadWorkspaceResponse> => {
      return await appServerService.handoffThreadWorkspace(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_RENAME_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RENAME_THREAD_CHANNEL,
    async (
      _event,
      request: RenameThreadRequest,
    ): Promise<RenameThreadResponse> => {
      return await appServerService.renameThread(request);
    },
  );
  ipcMain.removeHandler(FOCUSED_DIFF_ANALYZE_CHANNEL);
  ipcMain.handle(
    FOCUSED_DIFF_ANALYZE_CHANNEL,
    async (
      _event,
      request: FocusedDiffAnalysisRequest
    ): Promise<FocusedDiffAnalysisResponse> => {
      return await appServerService.analyzeFocusedDiff(request);
    }
  );
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SNAPSHOT_CHANNEL,
    async (
      _event,
      request?: GetNavigationSnapshotRequest,
    ): Promise<NavigationSnapshot> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:getNavigationSnapshot",
        detail: {
          forceRefresh: Boolean(request?.forceRefresh),
        },
        operation: async () => await appServerService.getNavigationSnapshot(request),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_BROWSE_MODE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_BROWSE_MODE_CHANNEL,
    async (
      _event,
      request: SetNavigationBrowseModeRequest,
    ): Promise<SetNavigationBrowseModeResponse> => {
      return await appServerService.setNavigationBrowseMode(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
    async (
      _event,
      request: MarkThreadSeenRequest,
    ): Promise<MarkThreadSeenResponse> => {
      return await appServerService.markThreadSeen(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_REACTION_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_REACTION_CHANNEL,
    async (
      _event,
      request: SetThreadReactionRequest,
    ): Promise<SetThreadReactionResponse> => {
      return await appServerService.setThreadReaction(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_PIN_CHANNEL,
    async (
      _event,
      request: SetThreadPinRequest,
    ): Promise<SetThreadPinResponse> => {
      return await appServerService.setThreadPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_AGENT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_AGENT_CHANNEL,
    async (
      _event,
      request: SetThreadAgentRequest,
    ): Promise<SetThreadAgentResponse> => {
      return await appServerService.setThreadAgent(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REORDER_THREAD_PINS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
    async (
      _event,
      request: ReorderThreadPinsRequest,
    ): Promise<ReorderThreadPinsResponse> => {
      return await appServerService.reorderThreadPins(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_PARENT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_PARENT_CHANNEL,
    async (
      _event,
      request: SetThreadParentRequest,
    ): Promise<SetThreadParentResponse> => {
      return await appServerService.setThreadParent(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL);
  ipcMain.handle(
    NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL,
    async (
      _event,
      request: UpdateSubthreadOrderRequest,
    ): Promise<UpdateSubthreadOrderResponse> => {
      return await appServerService.updateSubthreadOrder(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL,
    async (
      _event,
      request: SetSubthreadsCollapsedRequest,
    ): Promise<SetSubthreadsCollapsedResponse> => {
      return await appServerService.setSubthreadsCollapsed(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_DIRECTORY_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_DIRECTORY_PIN_CHANNEL,
    async (
      _event,
      request: SetDirectoryPinRequest,
    ): Promise<SetDirectoryPinResponse> => {
      return await appServerService.setDirectoryPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL,
    async (
      _event,
      request: ReorderDirectoryPinsRequest,
    ): Promise<ReorderDirectoryPinsResponse> => {
      return await appServerService.reorderDirectoryPins(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
    async (
      _event,
      request: RefreshThreadPullRequestsRequest,
    ): Promise<RefreshThreadPullRequestsResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:refreshThreadPullRequests",
        detail: {
          backend: request.backend ?? null,
          directoryPathCount: request.directoryPaths.length,
          threadId: request.threadId,
          trigger: request.trigger ?? null,
        },
        operation: async () =>
          await appServerService.refreshThreadPullRequests(request),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
    async (
      _event,
      request: RefreshDirectoryGitStatusesRequest,
    ): Promise<RefreshDirectoryGitStatusesResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:refreshDirectoryGitStatuses",
        detail: {
          force: Boolean(request.force),
          keyCount: request.directoryKeys.length,
        },
        operation: async () =>
          await appServerService.refreshDirectoryGitStatusesForKeys(request),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL,
    async (
      _event,
      request: ResolveEditCommitStatesRequest,
    ): Promise<ResolveEditCommitStatesResponse> => {
      return await appServerService.resolveEditCommitStates(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL,
    async (
      _event,
      request: ListWorktreeOtherChangesRequest,
    ): Promise<ListWorktreeOtherChangesResponse> => {
      return await appServerService.listWorktreeOtherChanges(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL,
    async (
      _event,
      request: GetWorktreeOtherChangeDiffRequest,
    ): Promise<GetWorktreeOtherChangeDiffResponse> => {
      return await appServerService.getWorktreeOtherChangeDiff(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_GH_STATUS_CHANNEL,
    async (_event, request: GetGhStatusRequest | undefined): Promise<GhStatus> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:getGhStatus",
        operation: async () => await appServerService.getGhStatus(request ?? {}),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      _event,
      request: EnsureDirectoryLaunchpadRequest,
    ): Promise<EnsureDirectoryLaunchpadResponse> => {
      return await appServerService.ensureDirectoryLaunchpad(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      _event,
      request: UpdateDirectoryLaunchpadRequest,
    ): Promise<UpdateDirectoryLaunchpadResponse> => {
      return await appServerService.updateDirectoryLaunchpad(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      _event,
      request: ResetDirectoryLaunchpadRequest,
    ): Promise<ResetDirectoryLaunchpadResponse> => {
      return await appServerService.resetDirectoryLaunchpad(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
    async (event): Promise<PickDirectoryFromDiskResponse> => {
      // Find the window that dispatched the IPC so the system "Choose
      // folder" dialog anchors to it as a sheet on macOS. Falls back to
      // the focused window inside `pickDirectoryFromDisk`.
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return await appServerService.pickDirectoryFromDisk(
        senderWindow ?? undefined,
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
    async (
      _event,
      request: RegisterDirectoryFromDiskRequest,
    ): Promise<RegisterDirectoryFromDiskResponse> => {
      return await appServerService.registerDirectoryFromDisk(request);
    },
  );
}

export async function disposeAppServerIpcHandlers(): Promise<void> {
  ipcMain.removeHandler(APP_SERVER_LIST_SKILLS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_LIST_THREADS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_THREAD_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCES_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_START_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_RETRY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RENAME_THREAD_CHANNEL);
  ipcMain.removeHandler(THREAD_SEARCH_CHANNEL);
  ipcMain.removeHandler(FOCUSED_DIFF_ANALYZE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_BROWSE_MODE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_REACTION_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_AGENT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  unsubscribeWorkingStateEvents?.();
  unsubscribeWorkingStateEvents = undefined;
  await appServerService.close();
}

export { APP_SERVER_LIST_THREADS_CHANNEL };
