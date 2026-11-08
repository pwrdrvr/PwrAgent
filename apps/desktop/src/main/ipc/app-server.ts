import type { OwnerNavigationRequest } from "../../shared/owner-request";
import { LocalOwnerNavigationTransport } from "../federation/local-owner-navigation-transport";
import { type ForgeReadArgs, type ForgeReadOperation } from "../pr-status/forge-tool-contract";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { createOwnerRoutedForgeReadHandler } from "../federation/federated-forge-read-service";
import { THREAD_PR_WATCHES_CHANNEL, type ThreadPrWatchesRequest, type ThreadPrWatchesResponse } from "@pwragent/shared";
import { THREAD_DEPENDENCIES_CHANNEL, type ManageThreadDependenciesRequest } from "@pwragent/shared";
import { THREAD_PENDING_WAKES_CHANNEL, type ThreadPendingWakesRequest, type ThreadPendingWakesResponse } from "@pwragent/shared";
import {
  stopRemoteThreadPendingWake,
} from "../app-server/thread-pending-wakes";
import { USAGE_ACTIVITY_ANALYZE_CHANNEL } from "../../shared/ipc";
import { USAGE_ACTIVITY_READ_CHANNEL } from "../../shared/ipc";
import { THREAD_FAMILY_PRICING_READ_CHANNEL } from "../../shared/ipc";
import { USAGE_ACTIVITY_OPEN_THREAD_CHANNEL, USAGE_ACTIVITY_OPEN_WINDOW_CHANNEL } from "../../shared/ipc";
import type { WindowShowThreadRequest } from "../../shared/window-show-thread";
import { showUsageActivityWindow } from "../usage-activity-window";
import { primaryMainWindowWebContents } from "../primary-main-window";
import { requestShowThread } from "../window-show-thread";
import type { ReadUsageActivityRequest, ReadUsageActivityResponse, AnalyzeUsageActivityRequest, AnalyzeUsageActivityResponse, OpenUsageActivityRequest } from "@pwragent/shared";
import { parseUsageLimitProvider } from "@pwragent/shared";
import type { ReadThreadFamilyPricingRequest, ReadThreadFamilyPricingResponse } from "@pwragent/shared";
import { navigationDiagnosticCause, navigationDiagnosticTrigger } from "../../shared/navigation-diagnostic-cause";
import { listingDiagnostics, listingRequestFields } from "../diagnostics/listing-diagnostics";
import { setBundledGitLfsAdvisory } from "../bundled-git-lfs-advisory";
import { expectedNavigationReadFailure, type NavigationReadFailure } from "../../shared/navigation-ipc-result";
import { NavigationAttentionViewLeases } from "../app-server/navigation-attention-view-leases";
import type { NavigationAttentionViewReleaseRequest } from "@pwragent/shared";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared";
import type { MarkNavigationDirectorySeenRequest } from "@pwragent/shared";
import type { RemoveNavigationDirectoryRequest } from "@pwragent/shared";
import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  type AgentEvent,
  type ArchiveWorktreeRequest,
  type ArchiveWorktreeResponse,
  type ArchiveThreadRequest,
  type ArchiveThreadResponse,
  type AppServerListSkillsRequest,
  type AppServerListSkillsResponse,
  type AppServerListThreadsRequest,
  type AppServerListThreadsResponse,
  type AttachDirectoryToThreadRequest,
  type AttachDirectoryToThreadResponse,
  type DetachDirectoryFromThreadRequest,
  type DetachDirectoryFromThreadResponse,
  type SetEligibleThreadsPrAutoDispatchRequest,
  type SetEligibleThreadsPrAutoDispatchResponse,
  type ThreadSearchRequest,
  type PersistThreadUsageActivityRequest,
  type PersistThreadUsageActivityResponse,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type InspectTokenMiserOutputRequest,
  type InspectTokenMiserOutputResponse,
  type AnalyzeThreadToolHistoryRequest,
  type AnalyzeThreadToolHistoryResponse,
  type GetThreadFileDiffRequest,
  type GetThreadFileDiffResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  type FocusedDiffAnalysisRequest,
  type FocusedDiffAnalysisResponse,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type MoveThreadToMainCheckoutRequest,
  type MoveThreadToMainCheckoutResponse,
  type RecreateThreadWorktreeRequest,
  type RecreateThreadWorktreeResponse,
  type GetGhStatusRequest,
  type GetGlabStatusRequest,
  type GlabStatus,
  type GhStatus,
  type ListModelSettingsRecentsRequest,
  type ListModelSettingsRecentsResponse,
  type ListRecentFileReferencesRequest,
  type ListRecentFileReferencesResponse,
  type RecordModelSettingsRecentRequest,
  type PickDirectoryFromDiskResponse,
  type PickFileFromDiskResponse,
  type PickReferenceFromDiskResponse,
  type InspectPdfReferencePathsRequest,
  type InspectPdfReferencePathsResponse,
  type RenderComposerPdfPreviewRequest,
  type RenderComposerPdfPreviewResponse,
  type RecordRecentFileReferencesRequest,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type RefreshDirectoryGitStatusesRequest,
  type RefreshDirectoryGitStatusesResponse,
  type RefreshThreadGitWorkingStateRequest,
  type RefreshThreadGitWorkingStateResponse,
  type RefreshThreadPullRequestsRequest,
  type SetPullRequestPollingFocusRequest,
  type SetTranscriptPullRequestsRequest,
  type TranscriptPullRequestStatuses,
  type RefreshThreadPullRequestsResponse,
  type RegisterDirectoryFromDiskRequest,
  type RegisterDirectoryFromDiskResponse,
  type MarkThreadSeenRequest,
  type MarkThreadSeenResponse,
  type PrAutoDispatchBudgetStatus,
  type CodexAppServerRestartResult,
  type CodexAppServerRestartStatus,
  type DesktopThreadArchiveSweepStatus,
  type DesktopAutomaticArchiveRetiredNotice,
  type AddRemoteThreadPinRequest,
  type AddRemoteThreadPinResponse,
  type FederationJumpSearchRequest,
  type FederationJumpSearchResponse,
  type RemoveRemoteThreadPinRequest,
  type HasRemoteThreadPinRequest,
  type RemoveRemoteThreadPinResponse,
  type SetRemoteThreadLocalPinRequest,
  type SetRemoteThreadLocalPinResponse,
  type ReorderDirectoryPinsRequest,
  type ReorderDirectoryPinsResponse,
  type ReorderThreadPinsRequest,
  type ReorderThreadPinsResponse,
  type SetSubthreadsCollapsedRequest,
  type SetSubthreadsCollapsedResponse,
  type SetDirectoryPinRequest,
  type SetDirectoryPinResponse,
  type SetDirectoryThreadsCollapsedRequest,
  type SetDirectoryThreadsCollapsedResponse,
  type SetProjectForgeAutomationRequest,
  type SetProjectForgeAutomationResponse,
  type ListProjectHeldWakeupsRequest,
  type ListProjectHeldWakeupsResponse,
  type ResolveProjectHeldWakeupsRequest,
  type ResolveProjectHeldWakeupsResponse,
  type SetThreadParentRequest,
  type SetThreadParentResponse,
  type SetThreadAgentRequest,
  type SetThreadTokenMiserRequest,
  type SetThreadMonitorJobSuggestionsRequest,
  type SetThreadMonitorJobSuggestionsResponse,
  type SetThreadTokenMiserResponse,
  type SetThreadAgentResponse,
  type SetThreadPinRequest,
  type SetThreadPinResponse,
  type SetThreadReactionRequest,
  type SetThreadReactionResponse,
  type SetThreadLockRequest,
  type SetThreadCheckoutHibernationRequest,
  type SetThreadCheckoutHibernationResponse,
  type SetThreadLockResponse,
  type SetThreadToolIncidentNoticeRequest,
  type SetThreadToolIncidentNoticeResponse,
  type ContinueThreadEnvironmentStartupRequest,
  type ContinueThreadEnvironmentStartupResponse,
  type AcknowledgeThreadEnvironmentFailureRequest,
  type AcknowledgeThreadEnvironmentFailureResponse,
  type ListPendingThreadSpendAlertsRequest,
  type AcknowledgeThreadSpendAlertRequest,
  type AcknowledgeThreadSpendAlertResponse,
  type SetNavigationBrowseModeRequest,
  type NavigationResumeState,
  type SetNavigationBrowseModeResponse,
  type SetPinnedGroupCollapsedRequest,
  type SetPinnedGroupCollapsedResponse,
  type RecentThreadLockNotesResponse,
  type ThreadLockNoteRequest,
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
  type ListWorktreeUnpublishedCommitsRequest,
  type ListWorktreeUnpublishedCommitsResponse,
  type GetWorktreeUnpublishedCommitDiffRequest,
  type GetWorktreeUnpublishedCommitDiffResponse,
  type ReadWorktreeImageRequest,
  type ReadWorktreeImageResponse,
  type ResolveMissingCodexThreadsRequest,
  type ResolveMissingCodexThreadsResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type UpdateSubthreadOrderRequest,
  type UpdateSubthreadOrderResponse,
} from "@pwragent/shared";
import {
  forgeRuleProjectLabel,
  isRemoteFederationTarget,
  type FederationTarget,
} from "@pwragent/shared";
import {
  getExistingDesktopBackendRegistry,
  getDesktopBackendRegistry,
} from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import {
  APP_SERVER_LIST_SKILLS_CHANNEL,
  APP_SERVER_GET_PR_ACTIVITY_CHANNEL,
  APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
  APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL,
  APP_SERVER_GET_CODEX_RESTART_STATUS_CHANNEL,
  APP_SERVER_RESTART_CODEX_CHANNEL,
  CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL,
  APP_SERVER_GET_THREAD_ARCHIVE_SWEEP_STATUS_CHANNEL,
  APP_SERVER_RUN_THREAD_ARCHIVE_SWEEP_CHANNEL,
  APP_SERVER_GET_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL,
  APP_SERVER_DISMISS_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL,
  THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL,
  BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL,
  BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL,
  GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL,
  GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
  APP_SERVER_LIST_THREADS_CHANNEL,
  THREAD_SEARCH_CHANNEL,
  THREAD_SEARCH_PROGRESS_CHANNEL,
  THREAD_SEARCH_CANCEL_CHANNEL,
  APP_SERVER_ARCHIVE_THREAD_CHANNEL,
  APP_SERVER_ARCHIVE_WORKTREE_CHANNEL,
  APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL,
  APP_SERVER_MOVE_THREAD_TO_MAIN_CHECKOUT_CHANNEL,
  APP_SERVER_RECREATE_THREAD_WORKTREE_CHANNEL,
  APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL,
  APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL,
  APP_SERVER_RESTORE_THREAD_CHANNEL,
  APP_SERVER_RESTORE_WORKTREE_CHANNEL,
  APP_SERVER_RENAME_THREAD_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL,
  APP_SERVER_INSPECT_TOKEN_MISER_OUTPUT_CHANNEL,
  APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL,
  APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL,
  THREAD_MIGRATION_LIST_SOURCES_CHANNEL,
  THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL,
  THREAD_MIGRATION_RETRY_CHANNEL,
  THREAD_MIGRATION_START_CHANNEL,
  FOCUSED_DIFF_ANALYZE_CHANNEL,
  NAVIGATION_GET_GH_STATUS_CHANNEL,
  NAVIGATION_GET_GLAB_STATUS_CHANNEL,
  NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
  NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL,
  NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL,
  NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL,
  NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL,
  NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL,
  NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL,
  NAVIGATION_READ_WORKTREE_IMAGE_CHANNEL,
  FEDERATION_JUMP_SEARCH_CHANNEL,
  FEDERATION_JUMP_SEARCH_PROGRESS_CHANNEL,
  NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL,
  NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL,
  NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL,
  NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL,
  NAVIGATION_HAS_REMOTE_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL,
  NAVIGATION_DETACH_THREAD_PR_CHANNEL,
  NAVIGATION_PROBE_PR_POLLING_AFTER_RECONNECT_CHANNEL,
  NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
  NAVIGATION_SET_PR_POLLING_FOCUS_CHANNEL,
  TRANSCRIPT_SET_PULL_REQUESTS_CHANNEL,
  TRANSCRIPT_PULL_REQUEST_STATUSES_CHANNEL,
  NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL,
  NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL,
  NAVIGATION_SET_DIRECTORY_PIN_CHANNEL,
  NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL,
  NAVIGATION_SET_PROJECT_FORGE_AUTOMATION_CHANNEL,
  NAVIGATION_LIST_PROJECT_HELD_WAKEUPS_CHANNEL,
  NAVIGATION_RESOLVE_PROJECT_HELD_WAKEUPS_CHANNEL,
  NAVIGATION_SET_THREAD_PARENT_CHANNEL,
  NAVIGATION_SET_THREAD_AGENT_CHANNEL,
  NAVIGATION_SET_THREAD_TOKEN_MISER_CHANNEL,
  NAVIGATION_SET_THREAD_MONITOR_JOB_SUGGESTIONS_CHANNEL,
  NAVIGATION_SET_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_REACTION_CHANNEL,
  NAVIGATION_SET_THREAD_LOCK_CHANNEL,
  NAVIGATION_SET_THREAD_CHECKOUT_HIBERNATION_CHANNEL,
  NAVIGATION_RECENT_THREAD_LOCK_NOTES_CHANNEL,
  NAVIGATION_REMEMBER_THREAD_LOCK_NOTE_CHANNEL,
  NAVIGATION_FORGET_THREAD_LOCK_NOTE_CHANNEL,
  NAVIGATION_SET_THREAD_TOOL_INCIDENT_NOTICE_CHANNEL,
  NAVIGATION_PENDING_THREAD_SPEND_ALERTS_CHANNEL,
  NAVIGATION_ACKNOWLEDGE_THREAD_SPEND_ALERT_CHANNEL,
  NAVIGATION_CONTINUE_THREAD_ENVIRONMENT_STARTUP_CHANNEL,
  NAVIGATION_ACKNOWLEDGE_THREAD_ENVIRONMENT_FAILURE_CHANNEL,
  NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL,
  NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_LIST_MODEL_SETTINGS_RECENTS_CHANNEL,
  NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL,
  NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL,
  NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL,
  NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL,
  NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL,
  NAVIGATION_RECORD_MODEL_SETTINGS_RECENT_CHANNEL,
  NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL,
  NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_SET_BROWSE_MODE_CHANNEL,
  NAVIGATION_SET_RESUME_STATE_CHANNEL,
  NAVIGATION_SET_PINNED_GROUP_COLLAPSED_CHANNEL,
  OWNER_REQUEST_CHANNEL,
  NAVIGATION_QUERY_RELEASE_CHANNEL,
  NAVIGATION_ATTENTION_VIEW_RELEASE_CHANNEL,
  NAVIGATION_REMOVE_DIRECTORY_CHANNEL,
  NAVIGATION_MARK_DIRECTORY_SEEN_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL,
  NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
} from "../../shared/ipc";
import { subscribersForChannel } from "../window-channels";
import { registerThreadMaintenanceIpc, unregisterThreadMaintenanceIpc } from "./thread-maintenance-ipc";
import { disposeThreadMaintenanceService, getThreadMaintenanceService } from "../thread-maintenance-runtime";
import { requestOpenThreadMaintenance } from "../window-open-thread-maintenance";
import {
  federationWindowTargetForWebContents,
  isFederationWindowWebContents,
} from "../window";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import {
  manageRemoteThreadPrWatches,
  readFederationThreadPrWatchesRequest,
  readThreadPrWatchesRemoteTarget,
} from "../pr-status/thread-pr-watches-federation";
import { getDesktopNavigationQueryStore } from "../app-server/navigation-query-store";
import { getDesktopNavigationQueryPool } from "../app-server/navigation-query-pool";
import { readLocalNavigationDirectoryIndex } from "../app-server/navigation-directory-index";
import { setNavigationDetailPendingWakesProjector } from "../app-server/navigation-detail-service";

import {
  getDesktopSettingsService,
} from "../settings/desktop-settings-singleton";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import { getLiveThreadFileDiff } from "../app-server/live-diff-activity";
import {
  getThreadReplayFileDiff,
} from "../app-server/thread-file-diff-cache";

import { appServerService, inspectPdfReferencePaths, renderExplicitComposerPdfPreview } from "../app-server/desktop-app-server-service";
export { appServerService, prSummariesEqual, resetAppServerServiceForTests, startAppServerOwnerNavigation } from "../app-server/desktop-app-server-service";

/**
 * A remote window's Forge Automation requests always go to the peer it
 * fronts, whatever target the renderer stamped: the window's target was
 * fixed when main created it.
 */
function withProjectForgeWindowOwner<
  Request extends { federationTarget?: FederationTarget },
>(
  event: { sender?: IpcMainInvokeEvent["sender"] } | undefined,
  request: Request,
): Request {
  const windowTarget = federationWindowTargetForWebContents(event?.sender);
  return windowTarget ? { ...request, federationTarget: windowTarget } : request;
}

/**
 * The owner of a draft a request edits. A remote window's drafts belong to
 * its peer unless the request names another peer, as for a draft moved to
 * another machine with the Machine chip. It never edits this machine's own
 * drafts. The main window names the peer itself for a pinned peer's draft.
 */
function withLaunchpadWindowOwner<
  Request extends { federationTarget?: FederationTarget },
>(
  event: { sender?: IpcMainInvokeEvent["sender"] } | undefined,
  request: Request,
): Request {
  const windowTarget = federationWindowTargetForWebContents(event?.sender);
  return windowTarget && request.federationTarget?.scope !== "remote"
    ? { ...request, federationTarget: windowTarget }
    : request;
}

const threadSearchControllers = new Map<number, AbortController>();

const navigationQueryPool = getDesktopNavigationQueryPool();
const navigationQueryConsumersBySender = new Map<number, Set<string>>();
let nextTransientNavigationConsumer = 0;
async function withNavigationConsumer<T>(event: IpcMainInvokeEvent, consumerId: string | undefined,
  read: (token: string) => Promise<T>): Promise<T | NavigationReadFailure> {
  if (consumerId !== undefined
    && (typeof consumerId !== "string" || consumerId.length < 1 || consumerId.length > 128)) {
    throw new Error("Navigation consumer identity must contain 1 to 128 characters.");
  }
  const senderId = event.sender.id;
  let consumers = navigationQueryConsumersBySender.get(senderId);
  if (!consumers) {
    consumers = new Set();
    navigationQueryConsumersBySender.set(senderId, consumers);
    event.sender.once("destroyed", () => {
      for (const token of navigationQueryConsumersBySender.get(senderId) ?? []) navigationQueryPool.release(token);
      navigationQueryConsumersBySender.delete(senderId);
      void navigationAttentionViewLeases.releaseSender(senderId);
    });
  }
  const token = JSON.stringify([senderId, consumerId ?? ++nextTransientNavigationConsumer]);
  if (!consumers.has(token) && consumers.size >= 256) throw new Error("Navigation consumer budget is occupied.");
  consumers.add(token);
  try { return await read(token); }
  catch (error) {
    const offline = expectedNavigationReadFailure(error);
    if (offline) return offline;
    throw error;
  }
  finally {
    if (consumerId === undefined) {
      consumers.delete(token);
      navigationQueryPool.release(token);
    }
  }
}
const ownerNavigationTransport = new LocalOwnerNavigationTransport({
  getNavigationQueryPage: (request, options) => appServerService.getNavigationQueryPage(request, options?.localConsumerId),
  getNavigationSelectedDetail: (request, options) => appServerService.getNavigationSelectedDetail(request, options?.localConsumerId),
  getNavigationQueueProjection: (request, options) => appServerService.getNavigationQueueProjection(request, options?.localConsumerId),
  getNavigationLaunchpadConfig: (request, options) => appServerService.getNavigationLaunchpadConfig(request, options?.localConsumerId),
});
const navigationAttentionViewLeases = new NavigationAttentionViewLeases((request) => appServerService.releaseNavigationAttentionView(request));

/** Sender ids that already have a destroyed-listener reaping their PR focus. */
const prPollingFocusCleanupSenderIds = new Set<number>();
const transcriptPrCleanupSenderIds = new Set<number>();

let unsubscribeWorkingStateEvents: (() => void) | undefined;
let unsubscribeCodexRestartStatus: (() => void) | undefined;
let unsubscribeThreadArchiveSweepStatus: (() => void) | undefined;
let unsubscribeNavigationRemoteEvents: (() => void) | undefined;

function invalidateNavigationEvent(event: AgentEvent): void {
  appServerService.invalidateThreadPendingWakes(event);
  getDesktopNavigationQueryStore().observeAttentionEvent(event);
  if (!navigationQueryEventRequiresRefresh(event.notification.method)) return;
  const params = event.notification.params as { threadId?: string; parentThreadId?: string; thread?: { id?: string } } | undefined;
  const threadId = params?.threadId ?? params?.parentThreadId ?? params?.thread?.id;
  navigationQueryPool.invalidateQueryOwner(event.federationTarget, navigationDiagnosticCause(event), navigationDiagnosticTrigger(event));
  navigationQueryPool.invalidateExactOwner(event.federationTarget,
    typeof threadId === "string" ? { backend: event.backend, threadId } : undefined);
}

export function registerAppServerIpcHandlers(): void {
  setBundledGitLfsAdvisory((repositoryPath) => {
    appServerService.publishBundledGitLfsAdvisory(repositoryPath);
  });
  ipcMain.removeHandler(BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL);
  ipcMain.handle(BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL, (event) => {
    if (subscribersForChannel(BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL).includes(event.sender)) {
      appServerService.acknowledgeBundledGitLfsAdvisory();
    }
  });
  ipcMain.removeHandler(GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL);
  ipcMain.handle(GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL, (event) => {
    if (subscribersForChannel(GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL).includes(event.sender)) {
      appServerService.acknowledgeGithubPrAuthenticationNotice();
    }
  });
  // Refresh a thread's working-state chips when the agent finishes a turn
  // or a git-mutating command in its worktree. Re-registering tears the
  // previous subscription down first so repeated calls don't stack listeners.
  unsubscribeWorkingStateEvents?.();
  unsubscribeNavigationRemoteEvents?.();
  unsubscribeNavigationRemoteEvents = getDesktopFederationRuntime().onRemoteBackendEvent(invalidateNavigationEvent);
  unsubscribeWorkingStateEvents = getDesktopBackendRegistry().onEvent((event) => {
    invalidateNavigationEvent(event);
    appServerService.handleAgentEventForWorkingState(event);
    appServerService.handleAgentEventForPrAttachments(event);
    appServerService.handleAgentEventForDependencies(event);
    appServerService.handleAgentEventForPrWatches(event);
  });
  const localForgeRead = (operation: ForgeReadOperation, args: ForgeReadArgs, context: AgentToolCallContext) => appServerService.readForgeForTool(operation, args, context);
  getDesktopBackendRegistry().setForgeReadHandlers(localForgeRead, createOwnerRoutedForgeReadHandler({
    local: localForgeRead,
    runtime: getDesktopFederationRuntime,
    targetStore: getDesktopOverlayStore(),
  }));
  getDesktopBackendRegistry().setForgePrToolHandler(
    async (operation, args, context) => await appServerService.runForgePrToolForAgent(operation, args, context),
    async (operation, args, context) => await appServerService.prepareForgePrToolForAgent(operation, args, context),
  );
  getDesktopBackendRegistry().setForgeToolPolicyResolver(
    () => getDesktopSettingsService().resolveForgeAgentToolPolicy(),
  );
  getDesktopBackendRegistry().setForgeToolRuleWriter(
    async (update) => await getDesktopSettingsService().upsertForgeAgentToolRule(update),
  );
  getDesktopBackendRegistry().setForgeProjectLabelResolver(
    async (repository) => forgeRuleProjectLabel(await readLocalNavigationDirectoryIndex(), repository),
  );
  getDesktopBackendRegistry().setThreadPullRequestStatusToolHandler(
    async (args, context) =>
      await appServerService.checkThreadPullRequestStatusForTool(args, context),
  );
  getDesktopBackendRegistry().setThreadPullRequestCanonicalizer(
    async (prs) =>
      await appServerService.canonicalizeStoredPullRequests(prs),
  );
  getDesktopBackendRegistry().setPullRequestReferenceResolver(
    async (params) => await appServerService.resolvePullRequestReference(params),
  );
  getDesktopBackendRegistry().setThreadPrimaryGitRepositoryReader((backend, threadId) =>
    appServerService.readPrimaryGitRepository(backend, threadId)
  );
  getDesktopBackendRegistry().setThreadProjectRepositoryResolver(async (backend, threadId) =>
    await appServerService.resolvePrimaryGitRepository(backend, threadId)
  );
  getDesktopBackendRegistry().setLocalPullRequestAuthorityResolver((prKey) =>
    appServerService.isPullRequestLocallyMonitored(prKey)
  );
  getDesktopBackendRegistry().setThreadMaintenanceToolHandler({
    scan: async (request) => await getThreadMaintenanceService().scan(request),
    getScan: (scanId) => getThreadMaintenanceService().getScan(scanId),
    getRun: () => getThreadMaintenanceService().getRun(),
    start: (request) => getThreadMaintenanceService().start(request),
    open: (request) => requestOpenThreadMaintenance(request),
  });
  getDesktopBackendRegistry().setThreadDependencyToolHandler(async (request, provenance, actor) => {
    try {
      const threadDependencies = await appServerService.manageThreadDependencies(request, provenance, actor);
      const projectNotice = appServerService.dependencyProjectNotice(request);
      return { ok: true, data: { threadDependencies, ...(projectNotice ? { projectNotice } : {}) } };
    } catch (error) {
      return { ok: false, error: { code: "invalid_arguments", message: error instanceof Error ? error.message : String(error) } };
    }
  });
  ipcMain.removeHandler(THREAD_DEPENDENCIES_CHANNEL);
  ipcMain.handle(THREAD_DEPENDENCIES_CHANNEL, async (event, request: ManageThreadDependenciesRequest) => {
    // A federation window manages its instance's threads on that instance.
    const federationTarget = federationWindowTargetForWebContents(event.sender);
    const routed = !request?.federationTarget && federationTarget ? { ...request, federationTarget } : request;
    if (routed?.action === "active" && !routed.federationTarget) return await appServerService.listActiveThreadDependencies();
    return await appServerService.manageThreadDependencies(routed);
  });
  getDesktopBackendRegistry().setThreadDependenciesPeerHandler(async (request, requesterInstanceId) =>
    await appServerService.manageThreadDependenciesForPeer(request, requesterInstanceId));
  ipcMain.removeHandler(THREAD_PR_WATCHES_CHANNEL);
  ipcMain.handle(THREAD_PR_WATCHES_CHANNEL, async (event, request: ThreadPrWatchesRequest): Promise<ThreadPrWatchesResponse> => {
    // A peer's thread is managed on its owner, from any window.
    const remoteTarget = readThreadPrWatchesRemoteTarget(request);
    if (remoteTarget && request.action !== "active") {
      return await manageRemoteThreadPrWatches(request, remoteTarget, getDesktopFederationRuntime());
    }
    if (isFederationWindowWebContents(event.sender)) {
      return {
        ok: false,
        error: {
          code: "federation_unsupported",
          message: "PR watches are listed and stopped in a local window of the instance that owns the thread.",
        },
      };
    }
    return await appServerService.manageThreadPrWatches(request);
  });
  setNavigationDetailPendingWakesProjector(async (thread, activePrWatches) =>
    await appServerService.listThreadPendingWakes(thread, 0, activePrWatches));
  ipcMain.removeHandler(THREAD_PENDING_WAKES_CHANNEL);
  ipcMain.handle(THREAD_PENDING_WAKES_CHANNEL, async (event, request: ThreadPendingWakesRequest): Promise<ThreadPendingWakesResponse> => {
    const target = request?.federationTarget;
    if (target && isRemoteFederationTarget(target)) {
      // A peer's list arrives with its selected detail; only Stop comes here.
      if (request.action !== "stop" || typeof request.key !== "string") {
        return {
          ok: false,
          error: { code: "federation_unsupported", message: "A peer's pending wakes come with its thread detail." },
        };
      }
      const runtime = getDesktopFederationRuntime();
      const owner = { backend: request.backend, threadId: request.threadId };
      return await stopRemoteThreadPendingWake({
        cancelPrWatch: async (watchId) => {
          const response = await manageRemoteThreadPrWatches({ action: "cancel", ...owner, watchId }, target, runtime);
          return response.ok ? { ok: true }
            : { ok: false, code: response.error.code === "federation_unsupported" ? "federation_unsupported" : "failed", message: response.error.message };
        },
        cancelScheduledAction: async (actionId) => {
          await runtime.remoteBackend(target).cancelScheduledThreadAction({ id: actionId });
        },
        stopMonitor: async (monitorId) => {
          await runtime.remoteBackend(target).stopSubAgent({ ...owner, monitorId });
        },
        stopBackendTask: async (processId) => {
          const { terminated } = await runtime.remoteBackend(target).terminateBackgroundTerminal({ ...owner, processId });
          if (!terminated) throw new Error("The task has already ended.");
        },
        discardHeldMessage: async (entryId) => {
          const { cancelled } = await runtime.remoteBackend(target).cancelQueuedTurn({ queueEntryId: entryId });
          if (!cancelled) throw new Error("That message is no longer held.");
        },
      }, request.key);
    }
    if (isFederationWindowWebContents(event.sender)) {
      return {
        ok: false,
        error: { code: "federation_unsupported", message: "Pending wakes are managed on the instance that owns the thread." },
      };
    }
    return await appServerService.manageThreadPendingWakes(request);
  });
  getDesktopBackendRegistry().setThreadPrWatchesPeerHandler(async (request) => {
    // Envelope params are the viewer's; only the named fields reach the store.
    const owned = readFederationThreadPrWatchesRequest(request);
    if (!owned) {
      return {
        ok: false,
        error: { code: "invalid_arguments", message: "backend, threadId and the action's argument are required." },
      };
    }
    return await appServerService.manageThreadPrWatches(owned);
  });
  getDesktopBackendRegistry().setThreadPullRequestWatchToolHandler(
    async (args) => await appServerService.watchThreadPullRequestForTool(args),
  );
  getDesktopBackendRegistry().setDirectoryGitStatusWriter(
    async (params) => await appServerService.writeDirectoryGitStatusEntry(params),
  );
  getDesktopBackendRegistry().setThreadPullRequestDetachHandler(
    async (request) => await appServerService.detachThreadPullRequest(request),
  );
  getDesktopBackendRegistry().setThreadPullRequestRefreshHandler(
    async (request) =>
      await appServerService.refreshOwnedThreadPullRequests(request),
  );
  // A peer's requests name no target, so the service answers them here.
  getDesktopBackendRegistry().setProjectForgeAutomationHandler({
    set: async (request) => await appServerService.setProjectForgeAutomation({
      directoryKey: request.directoryKey,
      automation: request.automation,
    }),
    listHeldWakeups: async (request) => await appServerService.listProjectHeldWakeups({
      directoryKey: request.directoryKey,
    }),
    resolveHeldWakeups: async (request) => await appServerService.resolveProjectHeldWakeups({
      directoryKey: request.directoryKey,
      resolutions: request.resolutions,
    }),
  });
  getDesktopBackendRegistry().setThreadGitWorkingStateRefreshHandler(
    async (request) =>
      await appServerService.refreshThreadGitWorkingState(request),
  );
  getDesktopBackendRegistry().setThreadPrAutoDispatchHandler({
    preferenceChanged: async (request) =>
      await appServerService.handleThreadPrAutoDispatchPreference(request),
    preferencesChanged: async (requests) =>
      await appServerService.handleThreadPrAutoDispatchPreferences(requests),
    cancelPending: async (request) =>
      await appServerService.cancelThreadPrAutoDispatch(request),
    lockChanged: async (request) =>
      await appServerService.handleThreadLockChanged(request),
    sendPendingNow: async (request) =>
      await appServerService.sendThreadPrAutoDispatchNow(request),
    inspect: async (request, context) =>
      await appServerService.getThreadPullRequestAutomationStatus(
        request,
        context,
      ),
  });

  ipcMain.removeHandler(APP_SERVER_GET_PR_ACTIVITY_CHANNEL);
  ipcMain.handle(APP_SERVER_GET_PR_ACTIVITY_CHANNEL, () => appServerService.getPrActivity());
  ipcMain.removeHandler(APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
    async (): Promise<PrAutoDispatchBudgetStatus> =>
      await appServerService.getPrAutoDispatchBudgetStatus(),
  );
  ipcMain.removeHandler(APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL,
    async (): Promise<PrAutoDispatchBudgetStatus> =>
      await appServerService.resumePrAutoDispatchBudget(),
  );

  // Only local windows see or restart this machine's Codex process.
  unsubscribeCodexRestartStatus?.();
  unsubscribeCodexRestartStatus =
    getDesktopBackendRegistry().onCodexAppServerRestartStatusChanged((status) => {
      for (const webContents of subscribersForChannel(
        CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL,
      )) {
        if (!webContents.isDestroyed()) {
          webContents.send(CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL, status);
        }
      }
    });
  ipcMain.removeHandler(APP_SERVER_GET_CODEX_RESTART_STATUS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_GET_CODEX_RESTART_STATUS_CHANNEL,
    (event): CodexAppServerRestartStatus =>
      isFederationWindowWebContents(event?.sender)
        ? { stopped: false }
        : getDesktopBackendRegistry().getCodexAppServerRestartStatus(),
  );
  // The sweeper archives and deletes this machine's threads only.
  unsubscribeThreadArchiveSweepStatus?.();
  unsubscribeThreadArchiveSweepStatus =
    getDesktopBackendRegistry().onThreadArchiveSweepStatusChanged((status) => {
      for (const webContents of subscribersForChannel(
        THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL,
      )) {
        if (!webContents.isDestroyed()) {
          webContents.send(THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL, status);
        }
      }
    });
  registerThreadMaintenanceIpc();
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_ARCHIVE_SWEEP_STATUS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_GET_THREAD_ARCHIVE_SWEEP_STATUS_CHANNEL,
    (event): DesktopThreadArchiveSweepStatus => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error("A remote window cannot read this machine's hourly sweep.");
      }
      return getDesktopBackendRegistry().getThreadArchiveSweepStatus();
    },
  );
  ipcMain.removeHandler(APP_SERVER_RUN_THREAD_ARCHIVE_SWEEP_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RUN_THREAD_ARCHIVE_SWEEP_CHANNEL,
    async (event): Promise<DesktopThreadArchiveSweepStatus> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error("A remote window cannot run this machine's hourly sweep.");
      }
      const registry = getDesktopBackendRegistry();
      await registry.sweepInactiveThreads();
      return registry.getThreadArchiveSweepStatus();
    },
  );
  ipcMain.removeHandler(APP_SERVER_GET_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_GET_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL,
    (event): DesktopAutomaticArchiveRetiredNotice => {
      // A remote window fronts another machine, whose sweep this notice is not about.
      if (isFederationWindowWebContents(event?.sender)) return { show: false, hibernationOn: false };
      return appServerService.readAutomaticArchiveRetiredNotice();
    },
  );
  ipcMain.removeHandler(APP_SERVER_DISMISS_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_DISMISS_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL,
    async (event): Promise<void> => {
      if (isFederationWindowWebContents(event?.sender)) return;
      await appServerService.dismissAutomaticArchiveRetiredNotice();
    },
  );
  ipcMain.removeHandler(APP_SERVER_RESTART_CODEX_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESTART_CODEX_CHANNEL,
    async (event): Promise<CodexAppServerRestartResult> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error("A remote window cannot restart this machine's Codex.");
      }
      return await getDesktopBackendRegistry().restartCodexAppServer();
    },
  );

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
  ipcMain.removeHandler(THREAD_SEARCH_CANCEL_CHANNEL);
  ipcMain.handle(THREAD_SEARCH_CANCEL_CHANNEL, (event) => {
    threadSearchControllers.get(event.sender.id)?.abort(new Error("Search cancelled."));
  });
  ipcMain.removeHandler(THREAD_SEARCH_CHANNEL);
  ipcMain.handle(THREAD_SEARCH_CHANNEL, async (event, request: ThreadSearchRequest = {}, searchId?: number) => {
    const sender = event.sender;
    const senderId = sender.id;
    threadSearchControllers.get(senderId)?.abort(new Error("Search replaced."));
    const controller = new AbortController();
    threadSearchControllers.set(senderId, controller);
    const abort = (): void => controller.abort(new Error("Search window closed."));
    sender.once("destroyed", abort);
    try {
      return await appServerService.searchThreads(request, (response) => {
        if (!controller.signal.aborted && !sender.isDestroyed()) {
          sender.send(THREAD_SEARCH_PROGRESS_CHANNEL, { searchId, response });
        }
      }, controller.signal);
    } finally {
      sender.removeListener("destroyed", abort);
      if (threadSearchControllers.get(senderId) === controller) threadSearchControllers.delete(senderId);
    }
  });
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
  ipcMain.removeHandler(USAGE_ACTIVITY_READ_CHANNEL);
  ipcMain.handle(USAGE_ACTIVITY_READ_CHANNEL, async (_event, request: ReadUsageActivityRequest): Promise<ReadUsageActivityResponse> =>
    await appServerService.readUsageActivity(request));
  ipcMain.removeHandler(THREAD_FAMILY_PRICING_READ_CHANNEL);
  ipcMain.handle(THREAD_FAMILY_PRICING_READ_CHANNEL, async (_event, request: ReadThreadFamilyPricingRequest): Promise<ReadThreadFamilyPricingResponse> => {
    if (typeof request?.backend !== "string" || typeof request?.threadId !== "string") {
      throw new Error("Thread family pricing needs a backend and thread id.");
    }
    return await appServerService.readThreadFamilyPricing({
      backend: request.backend, threadId: request.threadId, federationTarget: request.federationTarget,
    });
  });
  ipcMain.removeHandler(USAGE_ACTIVITY_ANALYZE_CHANNEL);
  ipcMain.handle(USAGE_ACTIVITY_ANALYZE_CHANNEL, async (_event, request: AnalyzeUsageActivityRequest): Promise<AnalyzeUsageActivityResponse> =>
    await appServerService.analyzeUsageActivity(request));
  ipcMain.removeHandler(USAGE_ACTIVITY_OPEN_WINDOW_CHANNEL);
  ipcMain.handle(USAGE_ACTIVITY_OPEN_WINDOW_CHANNEL, (event, request?: OpenUsageActivityRequest) => {
    showUsageActivityWindow({ sourceWindow: BrowserWindow.fromWebContents(event.sender) ?? undefined },
      { provider: parseUsageLimitProvider(request?.provider) });
  });
  ipcMain.removeHandler(USAGE_ACTIVITY_OPEN_THREAD_CHANNEL);
  ipcMain.handle(USAGE_ACTIVITY_OPEN_THREAD_CHANNEL, (_event, request: WindowShowThreadRequest) => {
    if (typeof request?.backend !== "string" || typeof request?.threadId !== "string") return;
    const target = primaryMainWindowWebContents();
    if (target) requestShowThread(request, { preferWebContents: target });
  });
  ipcMain.removeHandler(APP_SERVER_INSPECT_TOKEN_MISER_OUTPUT_CHANNEL);
  ipcMain.handle(APP_SERVER_INSPECT_TOKEN_MISER_OUTPUT_CHANNEL,
    async (_event, request: InspectTokenMiserOutputRequest): Promise<InspectTokenMiserOutputResponse> =>
      await appServerService.inspectTokenMiserOutput(request),
  );
  ipcMain.removeHandler(APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL);
  ipcMain.handle(
    APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL,
    async (
      _event,
      request: AnalyzeThreadToolHistoryRequest,
    ): Promise<AnalyzeThreadToolHistoryResponse> =>
      await appServerService.analyzeThreadToolHistory(request),
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
  ipcMain.removeHandler(APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL,
    async (
      _event,
      request: ResolveMissingCodexThreadsRequest,
    ): Promise<ResolveMissingCodexThreadsResponse> => {
      return await appServerService.resolveMissingCodexThreads(request);
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
  ipcMain.removeHandler(APP_SERVER_RECREATE_THREAD_WORKTREE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RECREATE_THREAD_WORKTREE_CHANNEL,
    async (
      _event,
      request: RecreateThreadWorktreeRequest,
    ): Promise<RecreateThreadWorktreeResponse> => {
      return await appServerService.recreateThreadWorktree(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_MOVE_THREAD_TO_MAIN_CHECKOUT_CHANNEL);
  ipcMain.handle(
    APP_SERVER_MOVE_THREAD_TO_MAIN_CHECKOUT_CHANNEL,
    async (
      _event,
      request: MoveThreadToMainCheckoutRequest,
    ): Promise<MoveThreadToMainCheckoutResponse> => {
      return await appServerService.moveThreadToMainCheckout(request);
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
  ipcMain.handle(NAVIGATION_SNAPSHOT_CHANNEL, async () => {
    throw new Error("Full navigation snapshots are retired. Upgrade this window and its owning instance to navigation query protocol 2.");
  });
  ipcMain.removeHandler(OWNER_REQUEST_CHANNEL);
  ipcMain.handle(OWNER_REQUEST_CHANNEL, async (event, request: OwnerNavigationRequest, consumerId?: string) => {
    const query = request.method === "backend.getNavigationQueryPage" ? request.params : undefined;
    const dispatch = () => withNavigationConsumer(event, consumerId, (token) => {
      const qualified = request.method === "backend.getNavigationQueryPage"
        ? { ...request, params: navigationAttentionViewLeases.qualify(event.sender.id, request.params) }
        : request;
      return ownerNavigationTransport.request(qualified, token);
    });
    return query
      ? listingDiagnostics.trace("ipc", { ...listingRequestFields(query), sender: event.sender.id }, dispatch)
      : dispatch();
  });
  ipcMain.removeHandler(NAVIGATION_ATTENTION_VIEW_RELEASE_CHANNEL);
  ipcMain.handle(NAVIGATION_ATTENTION_VIEW_RELEASE_CHANNEL, async (event, request: NavigationAttentionViewReleaseRequest) =>
    navigationAttentionViewLeases.release(event.sender.id, request));
  ipcMain.removeHandler(NAVIGATION_QUERY_RELEASE_CHANNEL);
  ipcMain.handle(NAVIGATION_QUERY_RELEASE_CHANNEL, async (event, consumerId: string) => {
    const token = JSON.stringify([event.sender.id, consumerId]);
    navigationQueryConsumersBySender.get(event.sender.id)?.delete(token);
    navigationQueryPool.release(token);
  });
  ipcMain.removeHandler(NAVIGATION_REMOVE_DIRECTORY_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_MARK_DIRECTORY_SEEN_CHANNEL);
  ipcMain.handle(NAVIGATION_MARK_DIRECTORY_SEEN_CHANNEL, async (_event, request: MarkNavigationDirectorySeenRequest) =>
    appServerService.markNavigationDirectorySeen(request));
  ipcMain.handle(NAVIGATION_REMOVE_DIRECTORY_CHANNEL, async (_event, request: RemoveNavigationDirectoryRequest) =>
    appServerService.removeNavigationDirectory(request));
  ipcMain.removeHandler(NAVIGATION_SET_RESUME_STATE_CHANNEL);
  ipcMain.handle(NAVIGATION_SET_RESUME_STATE_CHANNEL, (event, state: NavigationResumeState) => {
    if (!federationWindowTargetForWebContents(event.sender)) appServerService.setNavigationResumeState(state);
  });
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
  ipcMain.removeHandler(NAVIGATION_SET_PINNED_GROUP_COLLAPSED_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_PINNED_GROUP_COLLAPSED_CHANNEL,
    async (
      _event,
      request: SetPinnedGroupCollapsedRequest,
    ): Promise<SetPinnedGroupCollapsedResponse> => {
      return await appServerService.setPinnedGroupCollapsed(request);
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
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_LOCK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_LOCK_CHANNEL,
    async (
      _event,
      request: SetThreadLockRequest,
    ): Promise<SetThreadLockResponse> => {
      return await appServerService.setThreadLock(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_CHECKOUT_HIBERNATION_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_CHECKOUT_HIBERNATION_CHANNEL,
    async (
      _event,
      request: SetThreadCheckoutHibernationRequest,
    ): Promise<SetThreadCheckoutHibernationResponse> => {
      return await appServerService.setThreadCheckoutHibernation(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RECENT_THREAD_LOCK_NOTES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RECENT_THREAD_LOCK_NOTES_CHANNEL,
    async (): Promise<RecentThreadLockNotesResponse> => {
      return await appServerService.listRecentThreadLockNotes();
    },
  );
  ipcMain.removeHandler(NAVIGATION_REMEMBER_THREAD_LOCK_NOTE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REMEMBER_THREAD_LOCK_NOTE_CHANNEL,
    async (
      _event,
      request: ThreadLockNoteRequest,
    ): Promise<RecentThreadLockNotesResponse> => {
      return await appServerService.rememberThreadLockNote(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_FORGET_THREAD_LOCK_NOTE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_FORGET_THREAD_LOCK_NOTE_CHANNEL,
    async (
      _event,
      request: ThreadLockNoteRequest,
    ): Promise<RecentThreadLockNotesResponse> => {
      return await appServerService.forgetThreadLockNote(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_TOOL_INCIDENT_NOTICE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_TOOL_INCIDENT_NOTICE_CHANNEL,
    async (
      _event,
      request: SetThreadToolIncidentNoticeRequest,
    ): Promise<SetThreadToolIncidentNoticeResponse> => {
      return await appServerService.setThreadToolIncidentNotice(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_PENDING_THREAD_SPEND_ALERTS_CHANNEL);
  ipcMain.handle(NAVIGATION_PENDING_THREAD_SPEND_ALERTS_CHANNEL, async (_event, request: ListPendingThreadSpendAlertsRequest) =>
    appServerService.listPendingThreadSpendAlerts(request));
  ipcMain.removeHandler(NAVIGATION_ACKNOWLEDGE_THREAD_SPEND_ALERT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ACKNOWLEDGE_THREAD_SPEND_ALERT_CHANNEL,
    async (
      _event,
      request: AcknowledgeThreadSpendAlertRequest,
    ): Promise<AcknowledgeThreadSpendAlertResponse> => {
      return await appServerService.acknowledgeThreadSpendAlert(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_CONTINUE_THREAD_ENVIRONMENT_STARTUP_CHANNEL);
  ipcMain.handle(
    NAVIGATION_CONTINUE_THREAD_ENVIRONMENT_STARTUP_CHANNEL,
    async (_event, request: ContinueThreadEnvironmentStartupRequest): Promise<ContinueThreadEnvironmentStartupResponse> =>
      await appServerService.continueThreadEnvironmentStartup(request),
  );
  ipcMain.removeHandler(NAVIGATION_ACKNOWLEDGE_THREAD_ENVIRONMENT_FAILURE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ACKNOWLEDGE_THREAD_ENVIRONMENT_FAILURE_CHANNEL,
    async (
      _event,
      request: AcknowledgeThreadEnvironmentFailureRequest,
    ): Promise<AcknowledgeThreadEnvironmentFailureResponse> => {
      return await appServerService.acknowledgeThreadEnvironmentFailure(request);
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
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_TOKEN_MISER_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_TOKEN_MISER_CHANNEL,
    async (
      _event,
      request: SetThreadTokenMiserRequest,
    ): Promise<SetThreadTokenMiserResponse> => {
      return await appServerService.setThreadTokenMiser(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_MONITOR_JOB_SUGGESTIONS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_MONITOR_JOB_SUGGESTIONS_CHANNEL,
    async (
      _event,
      request: SetThreadMonitorJobSuggestionsRequest,
    ): Promise<SetThreadMonitorJobSuggestionsResponse> => {
      return await appServerService.setThreadMonitorJobSuggestions(request);
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
  ipcMain.removeHandler(NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_HAS_REMOTE_THREAD_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_HAS_REMOTE_THREAD_PIN_CHANNEL,
    async (_event, request: HasRemoteThreadPinRequest): Promise<boolean> =>
      await appServerService.hasRemoteThreadPin(request),
  );
  ipcMain.handle(
    NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL,
    async (
      _event,
      request: AddRemoteThreadPinRequest,
    ): Promise<AddRemoteThreadPinResponse> => {
      return await appServerService.addRemoteThreadPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL,
    async (
      _event,
      request: RemoveRemoteThreadPinRequest,
    ): Promise<RemoveRemoteThreadPinResponse> => {
      return await appServerService.removeRemoteThreadPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL,
    async (
      _event,
      request: SetRemoteThreadLocalPinRequest,
    ): Promise<SetRemoteThreadLocalPinResponse> => {
      return await appServerService.setRemoteThreadLocalPin(request);
    },
  );
  ipcMain.removeHandler(FEDERATION_JUMP_SEARCH_CHANNEL);
  ipcMain.handle(
    FEDERATION_JUMP_SEARCH_CHANNEL,
    async (
      event,
      requestId: number,
      request: FederationJumpSearchRequest,
    ): Promise<FederationJumpSearchResponse> => {
      return await appServerService.jumpSearchRemoteThreads(
        request,
        (progress) => {
          // Search progress belongs to this invoke, not the global window
          // event bus. The request id disambiguates overlapping searches in
          // the same renderer; event.sender keeps it out of every other one.
          if (!event.sender?.isDestroyed?.()) {
            event.sender?.send?.(FEDERATION_JUMP_SEARCH_PROGRESS_CHANNEL, {
              requestId,
              progress,
            });
          }
        },
      );
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
  ipcMain.removeHandler(NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL,
    async (
      _event,
      request: SetDirectoryThreadsCollapsedRequest,
    ): Promise<SetDirectoryThreadsCollapsedResponse> => {
      return await appServerService.setDirectoryThreadsCollapsed(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_PROJECT_FORGE_AUTOMATION_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_PROJECT_FORGE_AUTOMATION_CHANNEL,
    async (
      event,
      request: SetProjectForgeAutomationRequest,
    ): Promise<SetProjectForgeAutomationResponse> => {
      return await appServerService.setProjectForgeAutomation(
        withProjectForgeWindowOwner(event, request),
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_PROJECT_HELD_WAKEUPS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_PROJECT_HELD_WAKEUPS_CHANNEL,
    async (
      event,
      request: ListProjectHeldWakeupsRequest,
    ): Promise<ListProjectHeldWakeupsResponse> => {
      return await appServerService.listProjectHeldWakeups(
        withProjectForgeWindowOwner(event, request),
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_RESOLVE_PROJECT_HELD_WAKEUPS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RESOLVE_PROJECT_HELD_WAKEUPS_CHANNEL,
    async (
      event,
      request: ResolveProjectHeldWakeupsRequest,
    ): Promise<ResolveProjectHeldWakeupsResponse> => {
      return await appServerService.resolveProjectHeldWakeups(
        withProjectForgeWindowOwner(event, request),
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
    async (
      event,
      request: RefreshThreadPullRequestsRequest,
    ): Promise<RefreshThreadPullRequestsResponse> => {
      // Defense in depth behind renderer target stamping: a remote window's
      // lookup must be routed to the owning instance. Running an untargeted
      // lookup here would use this machine's checkout and GitHub credentials.
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "PR lookups for remote threads must target the owning instance.",
        );
      }
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
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL,
    async (
      event,
      request: RefreshThreadGitWorkingStateRequest,
    ): Promise<RefreshThreadGitWorkingStateResponse> => {
      // A remote window's refresh must name the owner. Running it untargeted
      // here would probe a path on this machine instead of the owner's.
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Git working-state refreshes for remote threads run on the owning instance.",
        );
      }
      return await appServerService.refreshThreadGitWorkingState(request);
    },
  );
  ipcMain.removeHandler(TRANSCRIPT_SET_PULL_REQUESTS_CHANNEL);
  ipcMain.handle(
    TRANSCRIPT_SET_PULL_REQUESTS_CHANNEL,
    (event, request: SetTranscriptPullRequestsRequest): TranscriptPullRequestStatuses => {
      const sender = event.sender;
      if (
        !Array.isArray(request?.updates)
        || !Array.isArray(request.removedUrls)
        || request.updates.some((item) => typeof item?.url !== "string" || typeof item?.visible !== "boolean")
        || request.removedUrls.some((url) => typeof url !== "string")
      ) throw new Error("Invalid transcript PR subscriptions");
      if (!transcriptPrCleanupSenderIds.has(sender.id)) {
        transcriptPrCleanupSenderIds.add(sender.id);
        const clear = (): void => appServerService.clearTranscriptPullRequestsForSender(sender.id);
        sender.on("render-process-gone", clear);
        sender.on("did-start-loading", clear);
        sender.once("destroyed", () => {
          transcriptPrCleanupSenderIds.delete(sender.id);
          clear();
        });
      }
      return appServerService.setTranscriptPullRequests(request, sender.id, (statuses) => {
        if (!sender.isDestroyed()) sender.send(TRANSCRIPT_PULL_REQUEST_STATUSES_CHANNEL, statuses);
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_PR_POLLING_FOCUS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_PR_POLLING_FOCUS_CHANNEL,
    async (event, request: SetPullRequestPollingFocusRequest): Promise<void> => {
      // A federation window's selection is a remote thread key — it would
      // never match a local poll target, so don't track it at all.
      if (isFederationWindowWebContents(event?.sender)) {
        return;
      }
      const sender = event?.sender;
      if (!sender) {
        appServerService.setPullRequestPollingFocus(request);
        return;
      }
      appServerService.setPullRequestPollingFocus(request, sender.id);
      // Focus entries are per-window; reap this window's entry when it
      // closes so its threads fall back out of the fast tier.
      if (!prPollingFocusCleanupSenderIds.has(sender.id)) {
        prPollingFocusCleanupSenderIds.add(sender.id);
        sender.once("destroyed", () => {
          prPollingFocusCleanupSenderIds.delete(sender.id);
          appServerService.clearPullRequestPollingFocusForSender(sender.id);
        });
      }
    },
  );
  ipcMain.removeHandler(NAVIGATION_PROBE_PR_POLLING_AFTER_RECONNECT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PROBE_PR_POLLING_AFTER_RECONNECT_CHANNEL,
    async (): Promise<void> => {
      await appServerService.probePullRequestPollingAfterReconnect();
    },
  );
  ipcMain.removeHandler(NAVIGATION_DETACH_THREAD_PR_CHANNEL);
  ipcMain.handle(
    NAVIGATION_DETACH_THREAD_PR_CHANNEL,
    async (
      event,
      request: DetachThreadPullRequestRequest,
    ): Promise<DetachThreadPullRequestResponse> => {
      // Defense in depth behind renderer stamping: a federation window's
      // detach must carry a remote target so it routes to the owning
      // instance instead of polluting this machine's overlay store.
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Detaching a pull request for a remote thread must target the owning instance.",
        );
      }
      return await appServerService.detachThreadPullRequest(request);
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
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL,
    async (
      event,
      request: ListWorktreeUnpublishedCommitsRequest,
    ): Promise<ListWorktreeUnpublishedCommitsResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Unpublished commit reads for a remote thread must target the owning instance.",
        );
      }
      return await appServerService.listWorktreeUnpublishedCommits(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL,
    async (
      event,
      request: GetWorktreeUnpublishedCommitDiffRequest,
    ): Promise<GetWorktreeUnpublishedCommitDiffResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Unpublished commit reads for a remote thread must target the owning instance.",
        );
      }
      return await appServerService.getWorktreeUnpublishedCommitDiff(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_READ_WORKTREE_IMAGE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_READ_WORKTREE_IMAGE_CHANNEL,
    async (
      event,
      request: ReadWorktreeImageRequest,
    ): Promise<ReadWorktreeImageResponse> => {
      // Image bytes are read from this machine's disk only. A remote thread's
      // worktree path names a directory on its owner, never on the viewer.
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error("Worktree image reads are not available for remote threads.");
      }
      return await appServerService.readWorktreeImage(request);
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
  ipcMain.removeHandler(NAVIGATION_GET_GLAB_STATUS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_GLAB_STATUS_CHANNEL,
    async (_event, request: GetGlabStatusRequest | undefined): Promise<GlabStatus> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:getGlabStatus",
        operation: async () => await appServerService.getGlabStatus(request ?? {}),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      event,
      request: EnsureDirectoryLaunchpadRequest,
    ): Promise<EnsureDirectoryLaunchpadResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote launchpads must load filesystem metadata from the owning instance.",
        );
      }
      return await appServerService.ensureDirectoryLaunchpad(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      event,
      request: UpdateDirectoryLaunchpadRequest,
    ): Promise<UpdateDirectoryLaunchpadResponse> => {
      return await appServerService.updateDirectoryLaunchpad(
        withLaunchpadWindowOwner(event, request),
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL,
    async (
      _event,
      request: SetEligibleThreadsPrAutoDispatchRequest,
    ): Promise<SetEligibleThreadsPrAutoDispatchResponse> => {
      return await appServerService.setEligibleThreadsPrAutoDispatch(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      event,
      request: ResetDirectoryLaunchpadRequest,
    ): Promise<ResetDirectoryLaunchpadResponse> => {
      return await appServerService.resetDirectoryLaunchpad(
        withLaunchpadWindowOwner(event, request),
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
    async (event): Promise<PickDirectoryFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        return { canceled: true };
      }
      // Find the window that dispatched the IPC so the system "Choose
      // folder" dialog anchors to it as a sheet on macOS. Falls back to
      // the focused window inside `pickDirectoryFromDisk`.
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return await appServerService.pickDirectoryFromDisk(
        senderWindow ?? undefined,
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL,
    async (event): Promise<PickFileFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        return { canceled: true };
      }
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return await appServerService.pickFileFromDisk(
        senderWindow ?? undefined,
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL,
    async (event): Promise<PickReferenceFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        return { canceled: true };
      }
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return await appServerService.pickReferenceFromDisk(
        senderWindow ?? undefined,
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL,
    async (
      event,
      request: InspectPdfReferencePathsRequest,
    ): Promise<InspectPdfReferencePathsResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "Remote file references cannot be inspected on the viewing instance.",
        );
      }
      return inspectPdfReferencePaths(request.paths ?? []);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL,
    async (
      event,
      request: RenderComposerPdfPreviewRequest,
    ): Promise<RenderComposerPdfPreviewResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "Remote file previews cannot be rendered on the viewing instance.",
        );
      }
      return await renderExplicitComposerPdfPreview(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL,
    async (
      event,
      request: ListRecentFileReferencesRequest = {},
    ): Promise<ListRecentFileReferencesResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote recent files must be loaded from the owning instance.",
        );
      }
      return await appServerService.listRecentFileReferences(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL,
    async (
      event,
      request: RecordRecentFileReferencesRequest,
    ): Promise<void> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote recent files must be recorded on the owning instance.",
        );
      }
      await appServerService.recordRecentFileReferences(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_MODEL_SETTINGS_RECENTS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_MODEL_SETTINGS_RECENTS_CHANNEL,
    async (
      event,
      request: ListModelSettingsRecentsRequest,
    ): Promise<ListModelSettingsRecentsResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote model settings recents must be loaded from the owning instance.",
        );
      }
      return await appServerService.listModelSettingsRecents(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RECORD_MODEL_SETTINGS_RECENT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RECORD_MODEL_SETTINGS_RECENT_CHANNEL,
    async (
      event,
      request: RecordModelSettingsRecentRequest,
    ): Promise<void> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote model settings recents must be recorded on the owning instance.",
        );
      }
      await appServerService.recordModelSettingsRecent(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
    async (
      event,
      request: RegisterDirectoryFromDiskRequest,
    ): Promise<RegisterDirectoryFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "Remote windows cannot register directories from the viewing instance.",
        );
      }
      return await appServerService.registerDirectoryFromDisk(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL,
    async (
      event,
      request: AttachDirectoryToThreadRequest,
    ): Promise<AttachDirectoryToThreadResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote directory attachments must target the owning instance.",
        );
      }
      return await appServerService.attachDirectoryToThread(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL,
    async (
      event,
      request: DetachDirectoryFromThreadRequest,
    ): Promise<DetachDirectoryFromThreadResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(request.federationTarget && isRemoteFederationTarget(request.federationTarget))
      ) {
        throw new Error("Remote directory detachments must target the owning instance.");
      }
      return await appServerService.detachDirectoryFromThread(request);
    },
  );
}

export async function disposeAppServerIpcHandlers(): Promise<void> {
  ipcMain.removeHandler(NAVIGATION_HAS_REMOTE_THREAD_PIN_CHANNEL);
  ipcMain.removeHandler(THREAD_DEPENDENCIES_CHANNEL);
  ipcMain.removeHandler(THREAD_PR_WATCHES_CHANNEL);
  ipcMain.removeHandler(THREAD_PENDING_WAKES_CHANNEL);
  setNavigationDetailPendingWakesProjector(undefined);
  ipcMain.removeHandler(NAVIGATION_ATTENTION_VIEW_RELEASE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_MARK_DIRECTORY_SEEN_CHANNEL);
  await navigationAttentionViewLeases.dispose();
  ipcMain.removeHandler(NAVIGATION_QUERY_RELEASE_CHANNEL);
  for (const consumers of navigationQueryConsumersBySender.values()) {
    for (const token of consumers) navigationQueryPool.release(token);
  }
  navigationQueryConsumersBySender.clear();
  ipcMain.removeHandler(GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL);
  setBundledGitLfsAdvisory(undefined);
  ipcMain.removeHandler(BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_LIST_SKILLS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_LIST_THREADS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_INSPECT_TOKEN_MISER_OUTPUT_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_THREAD_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCES_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_START_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_RETRY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RECREATE_THREAD_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_MOVE_THREAD_TO_MAIN_CHECKOUT_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RENAME_THREAD_CHANNEL);
  ipcMain.removeHandler(THREAD_SEARCH_CHANNEL);
  ipcMain.removeHandler(THREAD_SEARCH_CANCEL_CHANNEL);
  for (const controller of threadSearchControllers.values()) controller.abort(new Error("Search service stopped."));
  threadSearchControllers.clear();
  ipcMain.removeHandler(FOCUSED_DIFF_ANALYZE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.removeHandler(OWNER_REQUEST_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REMOVE_DIRECTORY_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_BROWSE_MODE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_RESUME_STATE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_PINNED_GROUP_COLLAPSED_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_REACTION_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_CHECKOUT_HIBERNATION_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_LOCK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RECENT_THREAD_LOCK_NOTES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REMEMBER_THREAD_LOCK_NOTE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_FORGET_THREAD_LOCK_NOTE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_AGENT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL);
  ipcMain.removeHandler(TRANSCRIPT_SET_PULL_REQUESTS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_PROBE_PR_POLLING_AFTER_RECONNECT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_DETACH_THREAD_PR_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_READ_WORKTREE_IMAGE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_GLAB_STATUS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL);
  unsubscribeWorkingStateEvents?.();
  unsubscribeWorkingStateEvents = undefined;
  unsubscribeNavigationRemoteEvents?.();
  unsubscribeNavigationRemoteEvents = undefined;
  unsubscribeCodexRestartStatus?.();
  unsubscribeCodexRestartStatus = undefined;
  unsubscribeThreadArchiveSweepStatus?.();
  unsubscribeThreadArchiveSweepStatus = undefined;
  unregisterThreadMaintenanceIpc();
  disposeThreadMaintenanceService();
  ipcMain.removeHandler(APP_SERVER_GET_CODEX_RESTART_STATUS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTART_CODEX_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_ARCHIVE_SWEEP_STATUS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RUN_THREAD_ARCHIVE_SWEEP_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_GET_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_DISMISS_AUTOMATIC_ARCHIVE_RETIRED_NOTICE_CHANNEL);
  const registry = getExistingDesktopBackendRegistry();
  registry?.setThreadDependencyToolHandler(undefined);
  registry?.setThreadDependenciesPeerHandler(undefined);
  registry?.setThreadMaintenanceToolHandler(undefined);
  registry?.setThreadPullRequestStatusToolHandler(undefined);
  registry?.setThreadPullRequestCanonicalizer(undefined);
  registry?.setPullRequestReferenceResolver(undefined);
  registry?.setThreadPrimaryGitRepositoryReader(undefined);
  registry?.setLocalPullRequestAuthorityResolver(undefined);
  registry?.setThreadPullRequestWatchToolHandler(undefined);
  registry?.setDirectoryGitStatusWriter(undefined);
  registry?.setThreadPrAutoDispatchHandler(undefined);
  registry?.setThreadPullRequestDetachHandler(undefined);
  registry?.setThreadPrWatchesPeerHandler(undefined);
  registry?.setThreadPullRequestRefreshHandler(undefined);
  registry?.setProjectForgeAutomationHandler(undefined);
  await appServerService.close();
}

export { APP_SERVER_LIST_THREADS_CHANNEL };
