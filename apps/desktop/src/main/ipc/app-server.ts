import { BrowserWindow, dialog, ipcMain } from "electron";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
import type {
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
  RefreshThreadPullRequestsRequest,
  RefreshThreadPullRequestsResponse,
  RegisterDirectoryFromDiskRequest,
  RegisterDirectoryFromDiskResponse,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
  NavigationSnapshot,
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
  NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
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
    const backend: AppServerBackendScope = request.backend ?? "all";
    const threads = await getDesktopBackendRegistry().listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: "navigation-snapshot",
      filter: request.filter,
    });
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey(threads);
    const queuedExecutionModesByThreadId = getDesktopBackendRegistry()
      .getQueuedExecutionModesSnapshot();
    const snapshot = await this.getOverlayStore().reconcileNavigationSnapshot({
      backend,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      queuedExecutionModesByThreadId,
      threads,
    });
    const directoryStatuses =
      await getDesktopBackendRegistry().readDirectoryStatuses(snapshot.directories);
    const directories = snapshot.directories.map((directory) => ({
      ...directory,
      gitStatus: directoryStatuses[directory.key],
    }));
    const previousDirectories = this.previousDirectoriesByBackend.get(backend);
    const directoriesUnchanged = previousDirectories
      ? directoryStatusesEqual(previousDirectories, directories)
      : false;
    this.previousDirectoriesByBackend.set(backend, directories);

    logDebug("getNavigationSnapshot", {
      backend,
      count: snapshot.threads.length,
      inboxCount: snapshot.inboxThreadKeys.length,
      unchanged: snapshot.unchanged && directoriesUnchanged,
    });

    return {
      ...snapshot,
      directories,
      unchanged: snapshot.unchanged && directoriesUnchanged,
    };
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
    // Terminal-state short-circuit: once a PR is merged or closed, we
    // never re-query gh for that thread. The chip is frozen at its
    // terminal color and we just hand back what's persisted.
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
    if (hasTerminalPr) {
      return {
        backend,
        threadId: request.threadId,
        prs: existingPrs,
        ghAvailable: true,
        shortCircuited: true,
      };
    }

    const branch = request.branch.trim();
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

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    return await getDesktopBackendRegistry().ensureDirectoryLaunchpad(request);
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
    await disposeDesktopBackendRegistry();
  }

  private getPrFetcher(): GithubPrFetcher {
    if (!this.prFetcher) {
      this.prFetcher = new GithubPrFetcher();
    }
    return this.prFetcher;
  }

  private getOverlayStore(): OverlayStoreLike {
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
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  await appServerService.close();
}

export { APP_SERVER_LIST_THREADS_CHANNEL };
