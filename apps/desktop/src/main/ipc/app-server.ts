import { BrowserWindow, dialog, ipcMain } from "electron";
import type {
  DirectoryGitStatusCacheEntry,
  OverlayStoreLike,
  SqliteOverlayStore,
} from "../state/overlay-store-sqlite";
import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerBackendScope,
  ArchiveWorktreeRequest,
  ArchiveWorktreeResponse,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  FocusedDiffAnalysisRequest,
  FocusedDiffAnalysisResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  GetGhStatusRequest,
  GhStatus,
  PickDirectoryFromDiskResponse,
  RefreshDirectoryGitStatusesRequest,
  RefreshDirectoryGitStatusesResponse,
  RefreshThreadPullRequestsRequest,
  RefreshThreadPullRequestsResponse,
  RegisterDirectoryFromDiskRequest,
  RegisterDirectoryFromDiskResponse,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
  NavigationDirectoryGitStatus,
  NavigationDirectoryGitStatusUpdatedNotification,
  NavigationSnapshot,
  ReorderThreadPinsRequest,
  ReorderThreadPinsResponse,
  SetThreadPinRequest,
  SetThreadPinResponse,
  SetThreadReactionRequest,
  SetThreadReactionResponse,
  ResetDirectoryLaunchpadRequest,
  ResetDirectoryLaunchpadResponse,
  RenameThreadRequest,
  RenameThreadResponse,
  RestoreWorktreeRequest,
  RestoreWorktreeResponse,
  RestoreThreadRequest,
  RestoreThreadResponse,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
} from "@pwragent/shared";
import { registerDirectoryFromDisk } from "../app-server/directory-registration-service";
import {
  disposeDesktopBackendRegistry,
  getDesktopBackendRegistry,
} from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import {
  APP_SERVER_LIST_SKILLS_CHANNEL,
  APP_SERVER_LIST_THREADS_CHANNEL,
  APP_SERVER_ARCHIVE_THREAD_CHANNEL,
  APP_SERVER_ARCHIVE_WORKTREE_CHANNEL,
  APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL,
  APP_SERVER_RESTORE_THREAD_CHANNEL,
  APP_SERVER_RESTORE_WORKTREE_CHANNEL,
  APP_SERVER_RENAME_THREAD_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL,
  FOCUSED_DIFF_ANALYZE_CHANNEL,
  NAVIGATION_GET_GH_STATUS_CHANNEL,
  NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
  NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
  NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SET_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_REACTION_CHANNEL,
  NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
} from "../../shared/ipc";
import { FocusedDiffService } from "../diff-focus/focused-diff-service";
import { getMainLogger } from "../log";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { detectPullRequestsForThread } from "../pr-status/pr-detection";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";

const isDevelopment = process.env.NODE_ENV !== "production";
const THREAD_PR_REFRESH_MIN_INTERVAL_MS = 60_000;
const STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT = 4;
const DIRECTORY_GIT_STATUS_CACHE_MAX_AGE_MS = 5 * 60_000;

type AppServerOverlayStoreLike = OverlayStoreLike &
  Pick<
    SqliteOverlayStore,
    "readDirectoryGitStatusCache" | "writeDirectoryGitStatusCacheEntry"
  >;
const appServerLog = getMainLogger("pwragent:app-server");

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  appServerLog.info(event, payload);
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
    return JSON.stringify(leftStatus ?? null) === JSON.stringify(rightStatus ?? null);
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

function getNavigationSnapshotRequestKey(
  request: GetNavigationSnapshotRequest,
): string {
  return JSON.stringify({
    backend: request.backend ?? "all",
    filter: request.filter ?? "",
  });
}

function getThreadPullRequestsRequestKey(
  backend: AppServerBackendKind,
  request: RefreshThreadPullRequestsRequest,
): string {
  return JSON.stringify({
    lookupVersion: 2,
    backend,
    threadId: request.threadId,
    branch: request.branch.trim(),
    directoryPaths: request.directoryPaths,
  });
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

    logDebug("listThreads", {
      backend: backend ?? "all",
      count: threads.length,
      threadIds: threads.slice(0, 5).map((thread) => thread.id),
    });

    return {
      backend: backend ?? "all",
      fetchedAt: Date.now(),
      threads,
    };
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<AppServerListSkillsResponse> {
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().listSkills({
      backend,
      cwd: request.cwd,
      cwds: request.cwds,
    });

    logDebug("listSkills", {
      backend,
      cwd: request.cwd ?? null,
      cwds: request.cwds ?? [],
      entries: response.data.length,
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

    return response;
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
      logDebug("getNavigationSnapshot:coalesced", {
        backend: request.backend ?? "all",
        filter: request.filter ?? null,
      });
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

  private async readNavigationSnapshot(
    request: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot> {
    const startedAt = Date.now();
    const backend: AppServerBackendScope = request.backend ?? "all";
    const listStartedAt = Date.now();
    const threads = await getDesktopBackendRegistry().listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: "navigation-snapshot",
      filter: request.filter,
    });
    const listDurationMs = Date.now() - listStartedAt;
    const bindingsStartedAt = Date.now();
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey(threads);
    const bindingsDurationMs = Date.now() - bindingsStartedAt;
    const queuedExecutionModesByThreadId = getDesktopBackendRegistry()
      .getQueuedExecutionModesSnapshot();
    const overlayStartedAt = Date.now();
    const snapshot = await this.getOverlayStore().reconcileNavigationSnapshot({
      backend,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      queuedExecutionModesByThreadId,
      threads,
    });
    const overlayDurationMs = Date.now() - overlayStartedAt;
    const directoryStartedAt = Date.now();
    await this.loadDirectoryGitStatusCache();
    for (const directory of snapshot.directories) {
      this.lastDirectoriesByKey.set(directory.key, directory);
    }
    const directories = snapshot.directories.map((directory) => {
      const cached = this.directoryGitStatusByKey.get(directory.key);
      if (!cached) {
        return directory;
      }
      return applyDirectoryGitStatus(directory, cached.gitStatus);
    });
    const directoryDurationMs = Date.now() - directoryStartedAt;
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

    logDebug("getNavigationSnapshot", {
      backend,
      count: snapshot.threads.length,
      inboxCount: snapshot.inboxThreadKeys.length,
      unchanged: snapshot.unchanged && directoriesUnchanged,
      durationMs: Date.now() - startedAt,
      listDurationMs,
      bindingsDurationMs,
      overlayDurationMs,
      directoryDurationMs,
      directoryStatusMode: "background",
    });

    return {
      ...snapshot,
      directories,
      unchanged: snapshot.unchanged && directoriesUnchanged,
    };
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
      if (params.force) {
        return true;
      }
      const cached = this.directoryGitStatusByKey.get(directory.key);
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
    const fetcher = this.getPrFetcher();
    const ghAvailable = await fetcher.isGhAvailable();
    if (!ghAvailable) {
      return {
        backend,
        threadId: request.threadId,
        prs: [],
        ghAvailable: false,
      };
    }

    const overlay = this.getOverlayStore();
    const existing = await overlay.getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    const existingPrs = existing?.prs ?? [];
    const branch = request.branch.trim();
    // Terminal-state short-circuit: once a PR is merged or closed, we
    // do not need to re-query gh for the same branch/directory lookup.
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
    const hasTerminalPr = existingPrs.some(
      (pr) => pr.state === "merged" || pr.state === "closed",
    );
    if (hasTerminalPr && branch !== "HEAD" && existing?.prsRefreshKey === requestKey) {
      return {
        backend,
        threadId: request.threadId,
        prs: existingPrs,
        ghAvailable: true,
        shortCircuited: true,
      };
    }

    if (!branch || request.directoryPaths.length === 0) {
      return {
        backend,
        threadId: request.threadId,
        prs: existingPrs,
        ghAvailable: true,
      };
    }

    const lastFetchedAt = existing?.prsFetchedAt;
    if (
      typeof lastFetchedAt === "number" &&
      Date.now() - lastFetchedAt < THREAD_PR_REFRESH_MIN_INTERVAL_MS &&
      existing?.prsRefreshKey === requestKey
    ) {
      return {
        backend,
        threadId: request.threadId,
        prs: existingPrs,
        ghAvailable: true,
      };
    }

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch,
      directoryPaths: request.directoryPaths,
    });

    // Persist even an empty result so we don't refetch unchanged state on
    // every renderer trigger. The fetchedAt timestamp lets a future TTL
    // policy (if we add one) reason about staleness without any extra
    // bookkeeping.
    await overlay.setThreadPullRequests({
      backend,
      threadId: request.threadId,
      prs,
      refreshKey: requestKey,
    });

    logDebug("refreshThreadPullRequests", {
      backend,
      threadId: request.threadId,
      branch,
      directoryCount: request.directoryPaths.length,
      prCount: prs.length,
    });

    return { backend, threadId: request.threadId, prs, ghAvailable: true };
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

  async reorderThreadPins(
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse> {
    const backend = request.backend ?? "codex";

    const pinnedRanks = await this.getOverlayStore().reorderThreadPins({
      backend,
      threadIds: request.threadIds,
    });

    logDebug("reorderThreadPins", {
      backend,
      pinCount: request.threadIds.length,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/pin/reordered",
        params: {
          pinnedRanks,
        },
      },
    });

    return { backend, pinnedRanks };
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
    // Anchor the dialog to whichever window dispatched the IPC so it
    // appears as a sheet on macOS (the renderer's expectation) instead
    // of floating free. `dialog.showOpenDialog` accepts an optional
    // `BrowserWindow` first arg for exactly this; if the caller didn't
    // pass one we fall back to the focused window.
    const window =
      parentWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: "Add directory",
          buttonLabel: "Add directory",
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "Add directory",
          buttonLabel: "Add directory",
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, path: result.filePaths[0] };
  }

  async registerDirectoryFromDisk(
    request: RegisterDirectoryFromDiskRequest,
  ): Promise<RegisterDirectoryFromDiskResponse> {
    const registry = getDesktopBackendRegistry();
    return await registerDirectoryFromDisk(request, {
      ensureDirectoryLaunchpad: (req) => registry.ensureDirectoryLaunchpad(req),
    });
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
    this.pendingDirectoryGitStatusRefreshes.clear();
    this.pendingDirectoryGitStatusKeys.clear();
    this.previousDirectoriesByBackend.clear();
    this.directoryGitStatusByKey.clear();
    this.directoryGitStatusCacheLoaded = false;
    this.automaticDirectoryGitStatusRefreshesStarted = 0;
    this.lastDirectoriesByKey.clear();
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

const appServerService = new DesktopAppServerService();

export function registerAppServerIpcHandlers(): void {
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
      return await appServerService.listThreads(request);
    }
  );
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_READ_THREAD_CHANNEL,
    async (
      _event,
      request: AppServerReadThreadRequest
    ): Promise<AppServerReadThreadResponse> => {
      return await appServerService.readThread(request);
    }
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
      return await appServerService.getNavigationSnapshot(request);
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
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
    async (
      _event,
      request: RefreshThreadPullRequestsRequest,
    ): Promise<RefreshThreadPullRequestsResponse> => {
      return await appServerService.refreshThreadPullRequests(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
    async (
      _event,
      request: RefreshDirectoryGitStatusesRequest,
    ): Promise<RefreshDirectoryGitStatusesResponse> => {
      return await appServerService.refreshDirectoryGitStatusesForKeys(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_GH_STATUS_CHANNEL,
    async (_event, request: GetGhStatusRequest | undefined): Promise<GhStatus> => {
      return await appServerService.getGhStatus(request ?? {});
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
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RENAME_THREAD_CHANNEL);
  ipcMain.removeHandler(FOCUSED_DIFF_ANALYZE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_REACTION_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  await appServerService.close();
}

export { APP_SERVER_LIST_THREADS_CHANNEL };
