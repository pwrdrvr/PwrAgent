import { clipboard, contextBridge, ipcRenderer } from "electron";
import type {
  AgentEvent,
  ArchiveWorktreeRequest,
  ArchiveWorktreeResponse,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  ListDesktopPwrAgentProfilesResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  QueueThreadExecutionModeRequest,
  QueueThreadExecutionModeResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  FocusedDiffAnalysisRequest,
  FocusedDiffAnalysisResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  CheckThreadBranchDriftRequest,
  CheckThreadBranchDriftResponse,
  CodexEnvironmentSetupProgressEvent,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
  ReorderThreadPinsRequest,
  ReorderThreadPinsResponse,
  SetThreadPinRequest,
  SetThreadPinResponse,
  SetThreadReactionRequest,
  SetThreadReactionResponse,
  GetGhStatusRequest,
  GhStatus,
  ApproveMessagingPairingRequest,
  ApproveMessagingPairingResponse,
  GenerateMessagingPairingTokenRequest,
  GenerateMessagingPairingTokenResponse,
  ListMessagingActivityRequest,
  ListMessagingActivityResponse,
  ListMessagingPairingRequestsRequest,
  ListMessagingPairingRequestsResponse,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  MessagingPairingEntry,
  RejectMessagingPairingRequest,
  RejectMessagingPairingResponse,
  SetMessagingEnabledRequest,
  SetMessagingEnabledResponse,
  PickDirectoryFromDiskResponse,
  PickGhCommandResponse,
  RegisterDirectoryFromDiskRequest,
  RegisterDirectoryFromDiskResponse,
  UnbindMessagingThreadRequest,
  UnbindMessagingThreadResponse,
  RefreshThreadPullRequestsRequest,
  RefreshThreadPullRequestsResponse,
  RefreshDirectoryGitStatusesRequest,
  RefreshDirectoryGitStatusesResponse,
  NavigationSnapshot,
  ResetDirectoryLaunchpadRequest,
  ResetDirectoryLaunchpadResponse,
  RetainThreadBranchDriftRequest,
  RetainThreadBranchDriftResponse,
  RenameThreadRequest,
  RenameThreadResponse,
  RunCodexEnvironmentActionRequest,
  RunCodexEnvironmentActionResponse,
  SetCodexThreadEnvironmentRequest,
  SetCodexThreadEnvironmentResponse,
  RestoreWorktreeRequest,
  RestoreWorktreeResponse,
  RestoreThreadRequest,
  RestoreThreadResponse,
  StartReviewRequest,
  StartReviewResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  CheckDesktopCodexAuthProfileStatusRequest,
  CheckDesktopCodexAuthProfileStatusResponse,
  ClearDesktopSettingsSecretRequest,
  ClearComposerDraftRequest,
  ClearComposerDraftResponse,
  ListComposerDraftLatestResponse,
  ListComposerDraftRecoveryCandidatesRequest,
  ListComposerDraftRecoveryCandidatesResponse,
  CreateDesktopPwrAgentProfileRequest,
  CreateDesktopPwrAgentProfileResponse,
  CreateDesktopCodexAuthProfileRequest,
  CreateDesktopCodexAuthProfileResponse,
  DeleteDesktopPwrAgentProfileRequest,
  DeleteDesktopPwrAgentProfileResponse,
  DesktopMessagingContactLookupRequest,
  DesktopMessagingContactLookupResponse,
  DesktopSettingsWriteResponse,
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  OpenDesktopPwrAgentProfileRequest,
  OpenDesktopPwrAgentProfileResponse,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
  RefreshDesktopCodexDiscoveryRequest,
  ReplaceDesktopSettingsSecretRequest,
  RecordComposerDraftHistoryRequest,
  RecordComposerDraftHistoryResponse,
  SaveComposerDraftRequest,
  SaveComposerDraftResponse,
  SettingsCredentialTestKind,
  SettingsCredentialTestRequest,
  SettingsCredentialTestResult,
  SetDesktopPwrAgentProfileCodexProfileRequest,
  SetDesktopPwrAgentProfileCodexProfileResponse,
  SetDefaultDesktopPwrAgentProfileRequest,
  SetDefaultDesktopPwrAgentProfileResponse,
  StartDesktopCodexAuthProfileLoginRequest,
  StartDesktopCodexAuthProfileLoginResponse,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
  UpdateThreadExpectedBranchRequest,
  UpdateThreadExpectedBranchResponse,
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import type { RendererErrorReport } from "../shared/renderer-error";
import type { RendererDiagnosticLogRequest } from "../shared/renderer-diagnostic";
import type {
  ImageUploadFallbackRequest,
  ImageUploadFallbackResponse,
  ImageUploadNormalizationLogRequest,
} from "../shared/image-normalization";
import {
  AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_INTERRUPT_TURN_CHANNEL,
  AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
  AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL,
  AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL,
  AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
  AGENT_START_THREAD_CHANNEL,
  AGENT_START_REVIEW_CHANNEL,
  AGENT_START_TURN_CHANNEL,
  AGENT_STEER_TURN_CHANNEL,
  AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
  AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL,
  APP_CHANGELOG_DOCUMENT_READ_CHANNEL,
  APP_CHANGELOG_WINDOW_OPEN_CHANNEL,
  APP_LOG_ENTRY_EVENT_CHANNEL,
  APP_LOG_SNAPSHOT_READ_CHANNEL,
  APP_LOG_WINDOW_OPEN_CHANNEL,
  APP_LICENSE_DOCUMENT_READ_CHANNEL,
  APP_METADATA_READ_CHANNEL,
  APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL,
  APP_UPDATE_CHECK_CHANNEL,
  APP_UPDATE_INSTALL_CHANNEL,
  APP_UPDATE_STATUS_EVENT_CHANNEL,
  APP_UPDATE_STATUS_READ_CHANNEL,
  APP_SERVER_LIST_SKILLS_CHANNEL,
  APP_SERVER_LIST_THREADS_CHANNEL,
  APP_SERVER_ARCHIVE_THREAD_CHANNEL,
  APP_SERVER_ARCHIVE_WORKTREE_CHANNEL,
  APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL,
  APP_SERVER_RESTORE_THREAD_CHANNEL,
  APP_SERVER_RESTORE_WORKTREE_CHANNEL,
  APP_SERVER_RENAME_THREAD_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL,
  APPLICATION_OPEN_CHANNEL,
  BACKEND_LIST_CHANNEL,
  CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL,
  COMPOSER_DRAFT_CLEAR_CHANNEL,
  COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL,
  COMPOSER_DRAFT_LIST_LATEST_CHANNEL,
  COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL,
  COMPOSER_DRAFT_SAVE_CHANNEL,
  NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
  FOCUSED_DIFF_ANALYZE_CHANNEL,
  IMAGE_UPLOAD_FALLBACK_CHANNEL,
  IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL,
  MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
  MESSAGING_APPROVE_PAIRING_CHANNEL,
  MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL,
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_LIST_ACTIVITY_CHANNEL,
  MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL,
  MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL,
  MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  MESSAGING_REJECT_PAIRING_CHANNEL,
  MESSAGING_SET_ENABLED_CHANNEL,
  MESSAGING_UNBIND_THREAD_CHANNEL,
  NAVIGATION_GET_GH_STATUS_CHANNEL,
  NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
  NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
  NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
  NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SET_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_REACTION_CHANNEL,
  NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
  PRELOAD_LOG_CHANNEL,
  PROFILES_CREATE_CHANNEL,
  PROFILES_DELETE_CHANNEL,
  PROFILES_LIST_CHANNEL,
  PROFILES_OPEN_CHANNEL,
  PROFILES_SET_CODEX_PROFILE_CHANNEL,
  PROFILES_SET_DEFAULT_CHANNEL,
  RENDERER_ERROR_REPORT_CHANNEL,
  RUNTIME_IDENTITY_CHANNEL,
  SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL,
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL,
  SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
  SETTINGS_PICK_GH_COMMAND_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
  SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
  SETTINGS_TEST_CREDENTIALS_CHANNEL,
  SETTINGS_WRITE_CONFIG_CHANNEL,
  WINDOW_FOCUS_SYNC_CHANNEL,
  WINDOW_POINTER_SNAPSHOT_CHANNEL,
} from "../shared/ipc";
import type { RuntimeIdentity } from "../shared/runtime-identity";
import type { WindowPointerSnapshot } from "../shared/window-pointer";
import type {
  AppChangelogDocument,
  AppLogEntry,
  AppLogSnapshot,
  AppLicenseDocument,
  AppLicenseDocumentKind,
  AppMetadata,
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  AppUpdateStatus,
} from "../shared/app-metadata";

function recordPreloadLog(
  level: "info" | "warn",
  message: string,
  details?: unknown,
): void {
  ipcRenderer.send(PRELOAD_LOG_CHANNEL, {
    details,
    level,
    message,
  });
}

recordPreloadLog("info", "start", {
  contextIsolated: process.contextIsolated,
  platform: process.platform,
  electron: process.versions.electron
});

const isDevelopment = process.env.NODE_ENV !== "production";

const desktopApi = Object.freeze({
  ping: () => "pong",
  copyText: async (text: string): Promise<void> => {
    clipboard.writeText(text);
  },
  readAppMetadata: async (): Promise<AppMetadata> =>
    await ipcRenderer.invoke(APP_METADATA_READ_CHANNEL),
  readLicenseDocument: async (
    kind: AppLicenseDocumentKind,
  ): Promise<AppLicenseDocument> =>
    await ipcRenderer.invoke(APP_LICENSE_DOCUMENT_READ_CHANNEL, kind),
  readChangelogDocument: async (): Promise<AppChangelogDocument> =>
    await ipcRenderer.invoke(APP_CHANGELOG_DOCUMENT_READ_CHANNEL),
  openChangelogWindow: async (): Promise<void> => {
    await ipcRenderer.invoke(APP_CHANGELOG_WINDOW_OPEN_CHANNEL);
  },
  openThirdPartyNoticesWindow: async (): Promise<void> => {
    await ipcRenderer.invoke(APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL);
  },
  readAppLogSnapshot: async (): Promise<AppLogSnapshot> =>
    await ipcRenderer.invoke(APP_LOG_SNAPSHOT_READ_CHANNEL),
  openAppLogWindow: async (): Promise<void> => {
    await ipcRenderer.invoke(APP_LOG_WINDOW_OPEN_CHANNEL);
  },
  onAppLogEntry: (callback: (entry: AppLogEntry) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppLogEntry) =>
      callback(payload);
    ipcRenderer.on(APP_LOG_ENTRY_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(APP_LOG_ENTRY_EVENT_CHANNEL, listener);
    };
  },
  checkForAppUpdates: async (): Promise<AppUpdateCheckResult> =>
    await ipcRenderer.invoke(APP_UPDATE_CHECK_CHANNEL),
  readAppUpdateStatus: async (): Promise<AppUpdateStatus> =>
    await ipcRenderer.invoke(APP_UPDATE_STATUS_READ_CHANNEL),
  onAppUpdateStatus: (
    callback: (status: AppUpdateStatus) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: AppUpdateStatus,
    ) => callback(payload);
    ipcRenderer.on(APP_UPDATE_STATUS_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(APP_UPDATE_STATUS_EVENT_CHANNEL, listener);
    };
  },
  installAppUpdate: async (): Promise<AppUpdateInstallResult> =>
    await ipcRenderer.invoke(APP_UPDATE_INSTALL_CHANNEL),
  listPwrAgentProfiles: async (): Promise<ListDesktopPwrAgentProfilesResponse> =>
    await ipcRenderer.invoke(PROFILES_LIST_CHANNEL),
  openPwrAgentProfile: async (
    request: OpenDesktopPwrAgentProfileRequest,
  ): Promise<OpenDesktopPwrAgentProfileResponse> =>
    await ipcRenderer.invoke(PROFILES_OPEN_CHANNEL, request),
  createPwrAgentProfile: async (
    request: CreateDesktopPwrAgentProfileRequest,
  ): Promise<CreateDesktopPwrAgentProfileResponse> =>
    await ipcRenderer.invoke(PROFILES_CREATE_CHANNEL, request),
  setDefaultPwrAgentProfile: async (
    request: SetDefaultDesktopPwrAgentProfileRequest,
  ): Promise<SetDefaultDesktopPwrAgentProfileResponse> =>
    await ipcRenderer.invoke(PROFILES_SET_DEFAULT_CHANNEL, request),
  deletePwrAgentProfile: async (
    request: DeleteDesktopPwrAgentProfileRequest,
  ): Promise<DeleteDesktopPwrAgentProfileResponse> =>
    await ipcRenderer.invoke(PROFILES_DELETE_CHANNEL, request),
  setPwrAgentProfileCodexProfile: async (
    request: SetDesktopPwrAgentProfileCodexProfileRequest,
  ): Promise<SetDesktopPwrAgentProfileCodexProfileResponse> =>
    await ipcRenderer.invoke(PROFILES_SET_CODEX_PROFILE_CHANNEL, request),
  ...(isDevelopment
    ? {
        getRuntimeIdentity: async (): Promise<RuntimeIdentity> =>
          await ipcRenderer.invoke(RUNTIME_IDENTITY_CHANNEL),
      }
    : {}),
  listThreads: async (
    request?: AppServerListThreadsRequest
  ): Promise<AppServerListThreadsResponse> =>
    await ipcRenderer.invoke(APP_SERVER_LIST_THREADS_CHANNEL, request),
  listSkills: async (
    request?: AppServerListSkillsRequest
  ): Promise<AppServerListSkillsResponse> =>
    await ipcRenderer.invoke(APP_SERVER_LIST_SKILLS_CHANNEL, request),
  listBackends: async (
    request?: ListBackendsRequest
  ): Promise<ListBackendsResponse> =>
    await ipcRenderer.invoke(BACKEND_LIST_CHANNEL, request),
  readSettings: async (
    request?: ReadDesktopSettingsRequest,
  ): Promise<ReadDesktopSettingsResponse> =>
    await ipcRenderer.invoke(SETTINGS_READ_CHANNEL, request),
  writeSettingsConfig: async (
    request: WriteDesktopSettingsConfigRequest,
  ): Promise<DesktopSettingsWriteResponse> =>
    await ipcRenderer.invoke(SETTINGS_WRITE_CONFIG_CHANNEL, request),
  replaceSettingsSecret: async (
    request: ReplaceDesktopSettingsSecretRequest,
  ): Promise<DesktopSettingsWriteResponse> =>
    await ipcRenderer.invoke(SETTINGS_REPLACE_SECRET_CHANNEL, request),
  clearSettingsSecret: async (
    request: ClearDesktopSettingsSecretRequest,
  ): Promise<DesktopSettingsWriteResponse> =>
    await ipcRenderer.invoke(SETTINGS_CLEAR_SECRET_CHANNEL, request),
  refreshCodexDiscovery: async (
    request?: RefreshDesktopCodexDiscoveryRequest,
  ): Promise<ReadDesktopSettingsResponse> =>
    await ipcRenderer.invoke(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL, request),
  createCodexAuthProfile: async (
    request: CreateDesktopCodexAuthProfileRequest,
  ): Promise<CreateDesktopCodexAuthProfileResponse> =>
    await ipcRenderer.invoke(SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL, request),
  startCodexAuthProfileLogin: async (
    request: StartDesktopCodexAuthProfileLoginRequest,
  ): Promise<StartDesktopCodexAuthProfileLoginResponse> =>
    await ipcRenderer.invoke(
      SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
      request,
    ),
  checkCodexAuthProfileStatus: async (
    request: CheckDesktopCodexAuthProfileStatusRequest,
  ): Promise<CheckDesktopCodexAuthProfileStatusResponse> =>
    await ipcRenderer.invoke(
      SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL,
      request,
    ),
  pickGhCommand: async (): Promise<PickGhCommandResponse> =>
    await ipcRenderer.invoke(SETTINGS_PICK_GH_COMMAND_CHANNEL),
  testSettingsCredentials: async (
    request: SettingsCredentialTestRequest,
  ): Promise<SettingsCredentialTestResult> =>
    await ipcRenderer.invoke(SETTINGS_TEST_CREDENTIALS_CHANNEL, request),
  readLastSettingsCredentialTest: async (
    request: { kind: SettingsCredentialTestKind },
  ): Promise<SettingsCredentialTestResult | undefined> =>
    await ipcRenderer.invoke(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL, request),
  resolveMessagingContact: async (
    request: DesktopMessagingContactLookupRequest,
  ): Promise<DesktopMessagingContactLookupResponse> =>
    await ipcRenderer.invoke(
      SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
      request,
    ),
  openApplication: async (
    request: OpenDesktopApplicationRequest,
  ): Promise<OpenDesktopApplicationResponse> =>
    await ipcRenderer.invoke(APPLICATION_OPEN_CHANNEL, request),
  readThread: async (
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> =>
    await ipcRenderer.invoke(APP_SERVER_READ_THREAD_CHANNEL, request),
  archiveThread: async (
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> =>
    await ipcRenderer.invoke(APP_SERVER_ARCHIVE_THREAD_CHANNEL, request),
  restoreThread: async (
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> =>
    await ipcRenderer.invoke(APP_SERVER_RESTORE_THREAD_CHANNEL, request),
  archiveWorktree: async (
    request: ArchiveWorktreeRequest,
  ): Promise<ArchiveWorktreeResponse> =>
    await ipcRenderer.invoke(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL, request),
  restoreWorktree: async (
    request: RestoreWorktreeRequest,
  ): Promise<RestoreWorktreeResponse> =>
    await ipcRenderer.invoke(APP_SERVER_RESTORE_WORKTREE_CHANNEL, request),
  handoffThreadWorkspace: async (
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> =>
    await ipcRenderer.invoke(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL, request),
  renameThread: async (
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> =>
    await ipcRenderer.invoke(APP_SERVER_RENAME_THREAD_CHANNEL, request),
  analyzeFocusedDiff: async (
    request: FocusedDiffAnalysisRequest
  ): Promise<FocusedDiffAnalysisResponse> =>
    await ipcRenderer.invoke(FOCUSED_DIFF_ANALYZE_CHANNEL, request),
  startThread: async (
    request: StartThreadRequest
  ): Promise<StartThreadResponse> =>
    await ipcRenderer.invoke(AGENT_START_THREAD_CHANNEL, request),
  startReview: async (
    request: StartReviewRequest
  ): Promise<StartReviewResponse> =>
    await ipcRenderer.invoke(AGENT_START_REVIEW_CHANNEL, request),
  startTurn: async (
    request: StartTurnRequest
  ): Promise<StartTurnResponse> =>
    await ipcRenderer.invoke(AGENT_START_TURN_CHANNEL, request),
  interruptTurn: async (
    request: InterruptTurnRequest
  ): Promise<InterruptTurnResponse> =>
    await ipcRenderer.invoke(AGENT_INTERRUPT_TURN_CHANNEL, request),
  steerTurn: async (
    request: SteerTurnRequest
  ): Promise<SteerTurnResponse> =>
    await ipcRenderer.invoke(AGENT_STEER_TURN_CHANNEL, request),
  setThreadExecutionMode: async (
    request: SetThreadExecutionModeRequest
  ): Promise<SetThreadExecutionModeResponse> =>
    await ipcRenderer.invoke(AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL, request),
  queueThreadExecutionMode: async (
    request: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse> =>
    await ipcRenderer.invoke(
      AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL,
      request,
    ),
  cancelThreadExecutionModeQueue: async (
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> =>
    await ipcRenderer.invoke(
      AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL,
      request,
    ),
  setThreadModelSettings: async (
    request: SetThreadModelSettingsRequest
  ): Promise<SetThreadModelSettingsResponse> =>
    await ipcRenderer.invoke(AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL, request),
  checkThreadBranchDrift: async (
    request: CheckThreadBranchDriftRequest
  ): Promise<CheckThreadBranchDriftResponse> =>
    await ipcRenderer.invoke(AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL, request),
  updateThreadExpectedBranch: async (
    request: UpdateThreadExpectedBranchRequest
  ): Promise<UpdateThreadExpectedBranchResponse> =>
    await ipcRenderer.invoke(AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL, request),
  retainThreadBranchDrift: async (
    request: RetainThreadBranchDriftRequest
  ): Promise<RetainThreadBranchDriftResponse> =>
    await ipcRenderer.invoke(AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL, request),
  materializeDirectoryLaunchpad: async (
    request: MaterializeDirectoryLaunchpadRequest
  ): Promise<MaterializeDirectoryLaunchpadResponse> =>
    await ipcRenderer.invoke(AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL, request),
  runCodexEnvironmentAction: async (
    request: RunCodexEnvironmentActionRequest,
  ): Promise<RunCodexEnvironmentActionResponse> =>
    await ipcRenderer.invoke(
      AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL,
      request,
    ),
  setCodexThreadEnvironment: async (
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse> =>
    await ipcRenderer.invoke(
      AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL,
      request,
    ),
  submitServerRequest: async (
    request: SubmitServerRequestRequest
  ): Promise<SubmitServerRequestResponse> =>
    await ipcRenderer.invoke(AGENT_SUBMIT_SERVER_REQUEST_CHANNEL, request),
  getNavigationSnapshot: async (
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot> =>
    await ipcRenderer.invoke(NAVIGATION_SNAPSHOT_CHANNEL, request),
  markThreadSeen: async (
    request: MarkThreadSeenRequest,
  ): Promise<MarkThreadSeenResponse> =>
    await ipcRenderer.invoke(NAVIGATION_MARK_THREAD_SEEN_CHANNEL, request),
  setThreadReaction: async (
    request: SetThreadReactionRequest,
  ): Promise<SetThreadReactionResponse> =>
    await ipcRenderer.invoke(NAVIGATION_SET_THREAD_REACTION_CHANNEL, request),
  setThreadPin: async (
    request: SetThreadPinRequest,
  ): Promise<SetThreadPinResponse> =>
    await ipcRenderer.invoke(NAVIGATION_SET_THREAD_PIN_CHANNEL, request),
  reorderThreadPins: async (
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse> =>
    await ipcRenderer.invoke(NAVIGATION_REORDER_THREAD_PINS_CHANNEL, request),
  refreshThreadPullRequests: async (
    request: RefreshThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> =>
    await ipcRenderer.invoke(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL, request),
  refreshDirectoryGitStatuses: async (
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse> =>
    await ipcRenderer.invoke(
      NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
      request,
    ),
  getGhStatus: async (request?: GetGhStatusRequest): Promise<GhStatus> =>
    await ipcRenderer.invoke(NAVIGATION_GET_GH_STATUS_CHANNEL, request),
  ensureDirectoryLaunchpad: async (
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> =>
    await ipcRenderer.invoke(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL, request),
  updateDirectoryLaunchpad: async (
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> =>
    await ipcRenderer.invoke(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL, request),
  resetDirectoryLaunchpad: async (
    request: ResetDirectoryLaunchpadRequest,
  ): Promise<ResetDirectoryLaunchpadResponse> =>
    await ipcRenderer.invoke(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL, request),
  saveComposerDraft: async (
    request: SaveComposerDraftRequest,
  ): Promise<SaveComposerDraftResponse> =>
    await ipcRenderer.invoke(COMPOSER_DRAFT_SAVE_CHANNEL, request),
  recordComposerDraftHistory: async (
    request: RecordComposerDraftHistoryRequest,
  ): Promise<RecordComposerDraftHistoryResponse> =>
    await ipcRenderer.invoke(COMPOSER_DRAFT_RECORD_HISTORY_CHANNEL, request),
  clearComposerDraft: async (
    request: ClearComposerDraftRequest,
  ): Promise<ClearComposerDraftResponse> =>
    await ipcRenderer.invoke(COMPOSER_DRAFT_CLEAR_CHANNEL, request),
  listComposerDraftRecoveryCandidates: async (
    request: ListComposerDraftRecoveryCandidatesRequest,
  ): Promise<ListComposerDraftRecoveryCandidatesResponse> =>
    await ipcRenderer.invoke(COMPOSER_DRAFT_LIST_CANDIDATES_CHANNEL, request),
  listComposerDraftLatest: async (): Promise<ListComposerDraftLatestResponse> =>
    await ipcRenderer.invoke(COMPOSER_DRAFT_LIST_LATEST_CHANNEL),
  pickDirectoryFromDisk: async (): Promise<PickDirectoryFromDiskResponse> =>
    await ipcRenderer.invoke(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL),
  registerDirectoryFromDisk: async (
    request: RegisterDirectoryFromDiskRequest,
  ): Promise<RegisterDirectoryFromDiskResponse> =>
    await ipcRenderer.invoke(
      NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
      request,
    ),
  reportRendererError: async (report: RendererErrorReport): Promise<void> => {
    await ipcRenderer.invoke(RENDERER_ERROR_REPORT_CHANNEL, report);
  },
  normalizeImageForUpload: async (
    request: ImageUploadFallbackRequest,
  ): Promise<ImageUploadFallbackResponse> =>
    await ipcRenderer.invoke(IMAGE_UPLOAD_FALLBACK_CHANNEL, request),
  recordImageUploadNormalization: async (
    request: ImageUploadNormalizationLogRequest,
  ): Promise<void> => {
    await ipcRenderer.invoke(IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL, request);
  },
  logRendererDiagnostic: async (
    request: RendererDiagnosticLogRequest,
  ): Promise<void> => {
    recordPreloadLog(request.level, request.message, request.details);
  },
  onWindowFocus: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on(WINDOW_FOCUS_SYNC_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_FOCUS_SYNC_CHANNEL, listener);
    };
  },
  getWindowPointerSnapshot: async (): Promise<WindowPointerSnapshot> =>
    await ipcRenderer.invoke(WINDOW_POINTER_SNAPSHOT_CHANNEL),
  onAgentEvent: (callback: (event: AgentEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) =>
      callback(payload);
    ipcRenderer.on(AGENT_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(AGENT_EVENT_CHANNEL, listener);
    };
  },
  onCodexEnvironmentSetupProgress: (
    callback: (event: CodexEnvironmentSetupProgressEvent) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: CodexEnvironmentSetupProgressEvent,
    ) => callback(payload);
    ipcRenderer.on(CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL, listener);
    return () => {
      ipcRenderer.off(CODEX_ENVIRONMENT_SETUP_PROGRESS_CHANNEL, listener);
    };
  },
  getMessagingPlatformStatuses: async (): Promise<MessagingPlatformStatus[]> =>
    await ipcRenderer.invoke(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL),
  setMessagingEnabled: async (
    request: SetMessagingEnabledRequest,
  ): Promise<SetMessagingEnabledResponse> =>
    await ipcRenderer.invoke(MESSAGING_SET_ENABLED_CHANNEL, request),
  unbindMessagingThread: async (
    request: UnbindMessagingThreadRequest,
  ): Promise<UnbindMessagingThreadResponse> =>
    await ipcRenderer.invoke(MESSAGING_UNBIND_THREAD_CHANNEL, request),
  listMessagingActivity: async (
    request?: ListMessagingActivityRequest,
  ): Promise<ListMessagingActivityResponse> =>
    await ipcRenderer.invoke(MESSAGING_LIST_ACTIVITY_CHANNEL, request),
  generateMessagingPairingToken: async (
    request: GenerateMessagingPairingTokenRequest,
  ): Promise<GenerateMessagingPairingTokenResponse> =>
    await ipcRenderer.invoke(MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL, request),
  listMessagingPairingRequests: async (
    request?: ListMessagingPairingRequestsRequest,
  ): Promise<ListMessagingPairingRequestsResponse> =>
    await ipcRenderer.invoke(MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL, request),
  approveMessagingPairing: async (
    request: ApproveMessagingPairingRequest,
  ): Promise<ApproveMessagingPairingResponse> =>
    await ipcRenderer.invoke(MESSAGING_APPROVE_PAIRING_CHANNEL, request),
  rejectMessagingPairing: async (
    request: RejectMessagingPairingRequest,
  ): Promise<RejectMessagingPairingResponse> =>
    await ipcRenderer.invoke(MESSAGING_REJECT_PAIRING_CHANNEL, request),
  openMessagingActivityWindow: async (): Promise<void> => {
    await ipcRenderer.invoke(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL);
  },
  onMessagingPlatformStatusEvent: (
    callback: (event: MessagingPlatformStatusEvent) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: MessagingPlatformStatusEvent,
    ) => callback(payload);
    ipcRenderer.on(MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL, listener);
    };
  },
  onMessagingBindingsChanged: (
    callback: (event: { at: number }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { at: number },
    ) => callback(payload);
    ipcRenderer.on(MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL, listener);
    };
  },
  onMessagingPairingChanged: (
    callback: (event: { at: number; entry: MessagingPairingEntry }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { at: number; entry: MessagingPairingEntry },
    ) => callback(payload);
    ipcRenderer.on(MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL, listener);
    };
  },
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  }
});

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("pwragent", desktopApi);
  recordPreloadLog("info", "exposed context bridge", {
    keys: Object.keys(desktopApi)
  });
} else {
  recordPreloadLog("warn", "context isolation disabled; bridge not exposed");
}
