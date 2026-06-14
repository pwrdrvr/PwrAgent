import { clipboard, contextBridge, ipcRenderer } from "electron";
import type {
  AgentEvent,
  AutomationIdRequest,
  AutomationMutationResponse,
  ArchiveWorktreeRequest,
  ArchiveWorktreeResponse,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  ForkThreadRequest,
  ForkThreadResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListAutomationCardsRequest,
  ListAutomationCardsResponse,
  ListAutomationRunsRequest,
  ListAutomationRunsResponse,
  ListAutomationsRequest,
  ListAutomationsResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  ListDesktopPwrAgentProfilesResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  QueueThreadExecutionModeRequest,
  QueueThreadExecutionModeResponse,
  LatestCodexConfigWarningResponse,
  SetAcpSessionRuntimeOptionRequest,
  SetAcpSessionRuntimeOptionResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadAgentRequest,
  SetThreadAgentResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  FocusedDiffAnalysisRequest,
  FocusedDiffAnalysisResponse,
  GetAutomationRunArtifactRequest,
  GetAutomationRunArtifactResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  ThreadSearchRequest,
  ThreadSearchResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  PersistThreadUsageActivityRequest,
  PersistThreadUsageActivityResponse,
  CheckThreadBranchDriftRequest,
  CheckThreadBranchDriftResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  CodexEnvironmentSetupProgressEvent,
  CreateAutomationRequest,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  ListAcpAgentSettingsRequest,
  ListAcpAgentSettingsResponse,
  NavigationBrowseMode,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
  ReorderDirectoryPinsRequest,
  ReorderDirectoryPinsResponse,
  ReorderThreadPinsRequest,
  ReorderThreadPinsResponse,
  SetSubthreadsCollapsedRequest,
  SetSubthreadsCollapsedResponse,
  SetDirectoryPinRequest,
  SetDirectoryPinResponse,
  SetThreadParentRequest,
  SetThreadParentResponse,
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
  GetMessagingActivitySummaryResponse,
  ListMessagingActivityRequest,
  ListMessagingActivityResponse,
  ListMessagingPairingRequestsRequest,
  ListMessagingPairingRequestsResponse,
  ListThreadMigrationSourceThreadsRequest,
  ListThreadMigrationSourceThreadsResponse,
  ListThreadMigrationSourcesResponse,
  RetryThreadMigrationRequest,
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
  ResolveEditCommitStatesRequest,
  ResolveEditCommitStatesResponse,
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
  RunAutomationNowResponse,
  StartReviewRequest,
  StartReviewResponse,
  StartThreadMigrationRequest,
  StartThreadMigrationResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  TrustCodexProjectRequest,
  TrustCodexProjectResponse,
  CheckDesktopCodexAuthProfileStatusRequest,
  CheckDesktopCodexAuthProfileStatusResponse,
  UpdateAutomationRequest,
  ClearDesktopSettingsSecretRequest,
  CompleteOnboardingCodexBootstrapRequest,
  CompleteOnboardingCodexBootstrapResponse,
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
  DesktopBootInfo,
  GraduateDesktopBootstrapConfigToProfileRequest,
  GraduateDesktopBootstrapConfigToProfileResponse,
  SetDesktopPwrAgentProfileCodexProfileRequest,
  SetDesktopPwrAgentProfileCodexProfileResponse,
  WaitForDesktopProfileAliveRequest,
  WaitForDesktopProfileAliveResponse,
  WriteDesktopSecretsToProfileRequest,
  WriteDesktopSecretsToProfileResponse,
  SetDefaultDesktopPwrAgentProfileRequest,
  SetDefaultDesktopPwrAgentProfileResponse,
  SetNavigationBrowseModeRequest,
  SetNavigationBrowseModeResponse,
  StartDesktopCodexAuthProfileLoginRequest,
  StartDesktopCodexAuthProfileLoginResponse,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
  UpdateSubthreadOrderRequest,
  UpdateSubthreadOrderResponse,
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
import type { HotCpuProfileCapturedEvent } from "../shared/hot-cpu-profile";
import {
  AGENT_CANCEL_THREAD_EXECUTION_MODE_QUEUE_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_FORK_THREAD_CHANNEL,
  AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL,
  APPEARANCE_CHANGED_EVENT_CHANNEL,
  AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_COMPACT_THREAD_CHANNEL,
  AGENT_INTERRUPT_TURN_CHANNEL,
  AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
  AGENT_QUEUE_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_RUN_CODEX_ENVIRONMENT_ACTION_CHANNEL,
  AGENT_SET_CODEX_THREAD_ENVIRONMENT_CHANNEL,
  AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL,
  AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
  AGENT_START_THREAD_CHANNEL,
  AGENT_START_REVIEW_CHANNEL,
  AGENT_START_TURN_CHANNEL,
  AGENT_STEER_TURN_CHANNEL,
  AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
  AGENT_TRUST_CODEX_PROJECT_CHANNEL,
  AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL,
  ACP_AGENTS_LIST_CHANNEL,
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL,
  AUTOMATIONS_LIST_CARDS_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_LIST_RUNS_CHANNEL,
  AUTOMATIONS_PAUSE_CHANNEL,
  AUTOMATIONS_RESUME_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
  APP_CHANGELOG_DOCUMENT_READ_CHANNEL,
  APP_CHANGELOG_WINDOW_OPEN_CHANNEL,
  APP_LOG_DEBUG_COLLECTION_SET_CHANNEL,
  APP_LOG_ENTRY_EVENT_CHANNEL,
  APP_LOG_SNAPSHOT_READ_CHANNEL,
  APP_LOG_WINDOW_OPEN_CHANNEL,
  APP_LICENSE_DOCUMENT_READ_CHANNEL,
  APP_METADATA_READ_CHANNEL,
  APP_THIRD_PARTY_NOTICES_WINDOW_OPEN_CHANNEL,
  APP_UPDATE_CHECK_CHANNEL,
  APP_UPDATE_INSTALL_CHANNEL,
  APP_UPDATE_RELEASES_READ_CHANNEL,
  APP_UPDATE_STATUS_EVENT_CHANNEL,
  APP_UPDATE_STATUS_READ_CHANNEL,
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
  HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL,
  IMAGE_UPLOAD_FALLBACK_CHANNEL,
  IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL,
  MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
  MESSAGING_APPROVE_PAIRING_CHANNEL,
  MESSAGING_GENERATE_PAIRING_TOKEN_CHANNEL,
  MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL,
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_LIST_ACTIVITY_CHANNEL,
  MESSAGING_LIST_PAIRING_REQUESTS_CHANNEL,
  MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL,
  MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  MESSAGING_REJECT_PAIRING_CHANNEL,
  MESSAGING_SET_ENABLED_CHANNEL,
  MESSAGING_SHUTDOWN_RUNTIME_CHANNEL,
  MESSAGING_UNBIND_THREAD_CHANNEL,
  NAVIGATION_GET_GH_STATUS_CHANNEL,
  NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
  NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
  NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL,
  NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL,
  NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
  NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SET_BROWSE_MODE_CHANNEL,
  NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL,
  NAVIGATION_SET_DIRECTORY_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_PARENT_CHANNEL,
  NAVIGATION_SET_THREAD_AGENT_CHANNEL,
  NAVIGATION_SET_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_REACTION_CHANNEL,
  NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL,
  NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
  ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL,
  PRELOAD_LOG_CHANNEL,
  STARTUP_PROFILE_EVENT_CHANNEL,
  PROFILES_CREATE_CHANNEL,
  APP_GET_BOOT_INFO_CHANNEL,
  APP_QUIT_CHANNEL,
  APP_WAIT_FOR_PROFILE_ALIVE_CHANNEL,
  PROFILES_DELETE_CHANNEL,
  PROFILES_GRADUATE_BOOTSTRAP_CONFIG_CHANNEL,
  PROFILES_LIST_CHANNEL,
  PROFILES_OPEN_CHANNEL,
  PROFILES_SET_CODEX_PROFILE_CHANNEL,
  PROFILES_SET_DEFAULT_CHANNEL,
  PROFILES_WRITE_SECRETS_CHANNEL,
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
  THREAD_MIGRATION_LIST_SOURCES_CHANNEL,
  THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL,
  THREAD_MIGRATION_RETRY_CHANNEL,
  THREAD_MIGRATION_START_CHANNEL,
  WINDOW_FOCUS_SYNC_CHANNEL,
  WINDOW_FULLSCREEN_SYNC_CHANNEL,
  WINDOW_OPEN_NEW_THREAD_CHANNEL,
  WINDOW_OPEN_SETTINGS_CHANNEL,
  WINDOW_POINTER_SNAPSHOT_CHANNEL,
  WINDOW_REPLAY_ONBOARDING_CHANNEL,
  WINDOW_SHOW_THREAD_CHANNEL,
  APP_MENU_MODEL_CHANNEL,
  APP_MENU_POPUP_CHANNEL,
} from "../shared/ipc";
import type { AppMenuTopLevel, AppMenuPopupRequest } from "../shared/app-menu";
import type { RuntimeIdentity } from "../shared/runtime-identity";
import type { WindowPointerSnapshot } from "../shared/window-pointer";
import type { WindowShowThreadRequest } from "../shared/window-show-thread";
import type {
  AppChangelogDocument,
  AppLogEntry,
  AppLogSnapshot,
  AppLicenseDocument,
  AppLicenseDocumentKind,
  AppMetadata,
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  AppUpdateReleaseVersions,
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

function isEnvEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

const startupProfileEnabled =
  isEnvEnabled(process.env.PWRAGENT_STARTUP_PROFILE) ||
  isEnvEnabled(process.env.PWRAGENT_STARTUP_CPU_PROFILING);
const preloadStartedAt = performance.now();

function recordStartupProfileRendererEvent(
  type: string,
  detail?: Record<string, unknown>,
): void {
  if (!startupProfileEnabled) {
    return;
  }

  ipcRenderer.send(STARTUP_PROFILE_EVENT_CHANNEL, {
    source: "renderer",
    type,
    detail: {
      preloadElapsedMs: Number((performance.now() - preloadStartedAt).toFixed(3)),
      ...(detail ?? {}),
    },
  });
}

async function invokeWithStartupProfileTiming<T>(
  label: string,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  if (!startupProfileEnabled) {
    return await ipcRenderer.invoke(channel, ...args);
  }

  const startedAt = performance.now();
  recordStartupProfileRendererEvent("ipc-renderer:start", {
    channel,
    label,
  });

  try {
    const result = await ipcRenderer.invoke(channel, ...args);
    recordStartupProfileRendererEvent("ipc-renderer:end", {
      channel,
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      label,
      ok: true,
    });
    return result as T;
  } catch (error) {
    recordStartupProfileRendererEvent("ipc-renderer:end", {
      channel,
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      error: error instanceof Error ? error.message : String(error),
      label,
      ok: false,
    });
    throw error;
  }
}

recordPreloadLog("info", "start", {
  contextIsolated: process.contextIsolated,
  platform: process.platform,
  electron: process.versions.electron
});
recordStartupProfileRendererEvent("preload-start", {
  contextIsolated: process.contextIsolated,
  platform: process.platform,
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
  setAppLogDebugCollectionEnabled: async (
    enabled: boolean,
  ): Promise<AppLogSnapshot> =>
    await ipcRenderer.invoke(APP_LOG_DEBUG_COLLECTION_SET_CHANNEL, enabled),
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
  readAppUpdateReleaseVersions: async (): Promise<AppUpdateReleaseVersions> =>
    await ipcRenderer.invoke(APP_UPDATE_RELEASES_READ_CHANNEL),
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
  onHotCpuProfileCaptured: (
    callback: (event: HotCpuProfileCapturedEvent) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: HotCpuProfileCapturedEvent,
    ) => callback(payload);
    ipcRenderer.on(HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL, listener);
    };
  },
  installAppUpdate: async (): Promise<AppUpdateInstallResult> =>
    await ipcRenderer.invoke(APP_UPDATE_INSTALL_CHANNEL),
  listAutomations: async (
    request?: ListAutomationsRequest,
  ): Promise<ListAutomationsResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_LIST_CHANNEL, request),
  createAutomation: async (
    request: CreateAutomationRequest,
  ): Promise<AutomationMutationResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_CREATE_CHANNEL, request),
  updateAutomation: async (
    request: UpdateAutomationRequest,
  ): Promise<AutomationMutationResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_UPDATE_CHANNEL, request),
  deleteAutomation: async (
    request: AutomationIdRequest,
  ): Promise<AutomationMutationResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_DELETE_CHANNEL, request),
  pauseAutomation: async (
    request: AutomationIdRequest,
  ): Promise<AutomationMutationResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_PAUSE_CHANNEL, request),
  resumeAutomation: async (
    request: AutomationIdRequest,
  ): Promise<AutomationMutationResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_RESUME_CHANNEL, request),
  runAutomationNow: async (
    request: AutomationIdRequest,
  ): Promise<RunAutomationNowResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_RUN_NOW_CHANNEL, request),
  listAutomationRuns: async (
    request: ListAutomationRunsRequest,
  ): Promise<ListAutomationRunsResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_LIST_RUNS_CHANNEL, request),
  listAutomationCards: async (
    request: ListAutomationCardsRequest,
  ): Promise<ListAutomationCardsResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_LIST_CARDS_CHANNEL, request),
  getAutomationRunArtifact: async (
    request: GetAutomationRunArtifactRequest,
  ): Promise<GetAutomationRunArtifactResponse> =>
    await ipcRenderer.invoke(AUTOMATIONS_GET_RUN_ARTIFACT_CHANNEL, request),
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
  graduateBootstrapConfigToProfile: async (
    request: GraduateDesktopBootstrapConfigToProfileRequest,
  ): Promise<GraduateDesktopBootstrapConfigToProfileResponse> =>
    await ipcRenderer.invoke(PROFILES_GRADUATE_BOOTSTRAP_CONFIG_CHANNEL, request),
  writeSecretsToProfile: async (
    request: WriteDesktopSecretsToProfileRequest,
  ): Promise<WriteDesktopSecretsToProfileResponse> =>
    await ipcRenderer.invoke(PROFILES_WRITE_SECRETS_CHANNEL, request),
  getBootInfo: async (): Promise<DesktopBootInfo> =>
    await invokeWithStartupProfileTiming(
      "getBootInfo",
      APP_GET_BOOT_INFO_CHANNEL,
    ),
  quitApp: async (): Promise<void> => await ipcRenderer.invoke(APP_QUIT_CHANNEL),
  waitForProfileAlive: async (
    request: WaitForDesktopProfileAliveRequest,
  ): Promise<WaitForDesktopProfileAliveResponse> =>
    await ipcRenderer.invoke(APP_WAIT_FOR_PROFILE_ALIVE_CHANNEL, request),
  ...(isDevelopment
    ? {
        getRuntimeIdentity: async (): Promise<RuntimeIdentity> =>
          await ipcRenderer.invoke(RUNTIME_IDENTITY_CHANNEL),
      }
    : {}),
  listThreads: async (
    request?: AppServerListThreadsRequest
  ): Promise<AppServerListThreadsResponse> =>
    await invokeWithStartupProfileTiming(
      "listThreads",
      APP_SERVER_LIST_THREADS_CHANNEL,
      request,
    ),
  searchThreads: async (
    request?: ThreadSearchRequest,
  ): Promise<ThreadSearchResponse> =>
    await ipcRenderer.invoke(THREAD_SEARCH_CHANNEL, request),
  listSkills: async (
    request?: AppServerListSkillsRequest
  ): Promise<AppServerListSkillsResponse> =>
    await ipcRenderer.invoke(APP_SERVER_LIST_SKILLS_CHANNEL, request),
  listBackends: async (
    request?: ListBackendsRequest
  ): Promise<ListBackendsResponse> =>
    await invokeWithStartupProfileTiming(
      "listBackends",
      BACKEND_LIST_CHANNEL,
      request,
    ),
  listAcpAgents: async (
    request?: ListAcpAgentSettingsRequest,
  ): Promise<ListAcpAgentSettingsResponse> =>
    await ipcRenderer.invoke(ACP_AGENTS_LIST_CHANNEL, request),
  readSettings: async (
    request?: ReadDesktopSettingsRequest,
  ): Promise<ReadDesktopSettingsResponse> =>
    await invokeWithStartupProfileTiming(
      "readSettings",
      SETTINGS_READ_CHANNEL,
      request,
    ),
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
  completeOnboardingCodexBootstrap: async (
    request?: CompleteOnboardingCodexBootstrapRequest,
  ): Promise<CompleteOnboardingCodexBootstrapResponse> =>
    await ipcRenderer.invoke(
      ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL,
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
    await invokeWithStartupProfileTiming(
      "readThread",
      APP_SERVER_READ_THREAD_CHANNEL,
      request,
    ),
  persistThreadUsageActivity: async (
    request: PersistThreadUsageActivityRequest,
  ): Promise<PersistThreadUsageActivityResponse> =>
    await ipcRenderer.invoke(
      APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL,
      request,
    ),
  archiveThread: async (
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> =>
    await ipcRenderer.invoke(APP_SERVER_ARCHIVE_THREAD_CHANNEL, request),
  restoreThread: async (
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> =>
    await ipcRenderer.invoke(APP_SERVER_RESTORE_THREAD_CHANNEL, request),
  listThreadMigrationSources: async (): Promise<ListThreadMigrationSourcesResponse> =>
    await ipcRenderer.invoke(THREAD_MIGRATION_LIST_SOURCES_CHANNEL),
  listThreadMigrationSourceThreads: async (
    request: ListThreadMigrationSourceThreadsRequest,
  ): Promise<ListThreadMigrationSourceThreadsResponse> =>
    await ipcRenderer.invoke(THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL, request),
  startThreadMigration: async (
    request: StartThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> =>
    await ipcRenderer.invoke(THREAD_MIGRATION_START_CHANNEL, request),
  retryThreadMigration: async (
    request: RetryThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> =>
    await ipcRenderer.invoke(THREAD_MIGRATION_RETRY_CHANNEL, request),
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
  forkThread: async (
    request: ForkThreadRequest,
  ): Promise<ForkThreadResponse> =>
    await ipcRenderer.invoke(AGENT_FORK_THREAD_CHANNEL, request),
  startReview: async (
    request: StartReviewRequest
  ): Promise<StartReviewResponse> =>
    await ipcRenderer.invoke(AGENT_START_REVIEW_CHANNEL, request),
  compactThread: async (
    request: CompactThreadRequest
  ): Promise<CompactThreadResponse> =>
    await ipcRenderer.invoke(AGENT_COMPACT_THREAD_CHANNEL, request),
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
  setAcpSessionRuntimeOption: async (
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> =>
    await ipcRenderer.invoke(
      AGENT_SET_ACP_SESSION_RUNTIME_OPTION_CHANNEL,
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
  trustCodexProject: async (
    request: TrustCodexProjectRequest,
  ): Promise<TrustCodexProjectResponse> =>
    await ipcRenderer.invoke(AGENT_TRUST_CODEX_PROJECT_CHANNEL, request),
  getLatestCodexConfigWarning: async (): Promise<LatestCodexConfigWarningResponse> =>
    await ipcRenderer.invoke(AGENT_LATEST_CODEX_CONFIG_WARNING_CHANNEL),
  getNavigationSnapshot: async (
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot> =>
    await invokeWithStartupProfileTiming(
      "getNavigationSnapshot",
      NAVIGATION_SNAPSHOT_CHANNEL,
      request,
    ),
  setNavigationBrowseMode: async (
    request: SetNavigationBrowseModeRequest,
  ): Promise<SetNavigationBrowseModeResponse> =>
    await ipcRenderer.invoke(NAVIGATION_SET_BROWSE_MODE_CHANNEL, request),
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
  setThreadAgent: async (
    request: SetThreadAgentRequest,
  ): Promise<SetThreadAgentResponse> =>
    await ipcRenderer.invoke(NAVIGATION_SET_THREAD_AGENT_CHANNEL, request),
  reorderThreadPins: async (
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse> =>
    await ipcRenderer.invoke(NAVIGATION_REORDER_THREAD_PINS_CHANNEL, request),
  setThreadParent: async (
    request: SetThreadParentRequest,
  ): Promise<SetThreadParentResponse> =>
    await ipcRenderer.invoke(NAVIGATION_SET_THREAD_PARENT_CHANNEL, request),
  updateSubthreadOrder: async (
    request: UpdateSubthreadOrderRequest,
  ): Promise<UpdateSubthreadOrderResponse> =>
    await ipcRenderer.invoke(NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL, request),
  setSubthreadsCollapsed: async (
    request: SetSubthreadsCollapsedRequest,
  ): Promise<SetSubthreadsCollapsedResponse> =>
    await ipcRenderer.invoke(NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL, request),
  setDirectoryPin: async (
    request: SetDirectoryPinRequest,
  ): Promise<SetDirectoryPinResponse> =>
    await ipcRenderer.invoke(NAVIGATION_SET_DIRECTORY_PIN_CHANNEL, request),
  reorderDirectoryPins: async (
    request: ReorderDirectoryPinsRequest,
  ): Promise<ReorderDirectoryPinsResponse> =>
    await ipcRenderer.invoke(
      NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL,
      request,
    ),
  refreshThreadPullRequests: async (
    request: RefreshThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> =>
    await invokeWithStartupProfileTiming(
      "refreshThreadPullRequests",
      NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
      request,
    ),
  refreshDirectoryGitStatuses: async (
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse> =>
    await invokeWithStartupProfileTiming(
      "refreshDirectoryGitStatuses",
      NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
      request,
    ),
  resolveEditCommitStates: async (
    request: ResolveEditCommitStatesRequest,
  ): Promise<ResolveEditCommitStatesResponse> =>
    await ipcRenderer.invoke(
      NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL,
      request,
    ),
  getGhStatus: async (request?: GetGhStatusRequest): Promise<GhStatus> =>
    await invokeWithStartupProfileTiming(
      "getGhStatus",
      NAVIGATION_GET_GH_STATUS_CHANNEL,
      request,
    ),
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
  recordStartupProfileEvent: (
    type: string,
    detail?: Record<string, unknown>,
  ): void => {
    recordStartupProfileRendererEvent(type, detail);
  },
  onWindowFocus: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on(WINDOW_FOCUS_SYNC_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_FOCUS_SYNC_CHANNEL, listener);
    };
  },
  onWindowFullscreen: (
    callback: (isFullScreen: boolean) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload?: { isFullScreen?: unknown },
    ) => callback(Boolean(payload?.isFullScreen));
    ipcRenderer.on(WINDOW_FULLSCREEN_SYNC_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_FULLSCREEN_SYNC_CHANNEL, listener);
    };
  },
  onOpenSettingsRequested: (
    callback: (section?: string) => void,
  ): (() => void) => {
    // Main → renderer push from the PwrAgent → Settings… menu item.
    // App.tsx subscribes and switches `mainView` to "settings".
    const listener = (_event: Electron.IpcRendererEvent, section?: unknown) =>
      callback(typeof section === "string" ? section : undefined);
    ipcRenderer.on(WINDOW_OPEN_SETTINGS_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_OPEN_SETTINGS_CHANNEL, listener);
    };
  },
  onOpenNewThreadRequested: (callback: () => void): (() => void) => {
    // Main → renderer push from File → New Thread / CmdOrCtrl+N.
    const listener = () => callback();
    ipcRenderer.on(WINDOW_OPEN_NEW_THREAD_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_OPEN_NEW_THREAD_CHANNEL, listener);
    };
  },
  onShowThreadRequested: (
    callback: (request: WindowShowThreadRequest) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: WindowShowThreadRequest,
    ) => callback(request);
    ipcRenderer.on(WINDOW_SHOW_THREAD_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_SHOW_THREAD_CHANNEL, listener);
    };
  },
  onReplayOnboardingRequested: (callback: () => void): (() => void) => {
    // Main → renderer push from Help → Replay Onboarding…
    const listener = () => callback();
    ipcRenderer.on(WINDOW_REPLAY_ONBOARDING_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_REPLAY_ONBOARDING_CHANNEL, listener);
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
  onAppearanceChanged: (
    callback: (appearance: {
      theme: DesktopAppearanceTheme;
      density: DesktopAppearanceDensity;
    }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: {
        theme: DesktopAppearanceTheme;
        density: DesktopAppearanceDensity;
      },
    ) => callback(payload);
    ipcRenderer.on(APPEARANCE_CHANGED_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(APPEARANCE_CHANGED_EVENT_CHANNEL, listener);
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
    await invokeWithStartupProfileTiming(
      "getMessagingPlatformStatuses",
      MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
    ),
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
  getMessagingActivitySummary:
    async (): Promise<GetMessagingActivitySummaryResponse> =>
      await ipcRenderer.invoke(MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL),
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
  shutdownMessagingRuntime: async (): Promise<void> => {
    await ipcRenderer.invoke(MESSAGING_SHUTDOWN_RUNTIME_CHANNEL);
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
  // Windows custom title-bar menu bar (see shared/app-menu.ts). The renderer
  // reads the top-level model once on mount and pops the live native submenu on
  // click / Alt-mnemonic. No-op surface on macOS/Linux (the bar isn't mounted).
  getAppMenuModel: async (): Promise<AppMenuTopLevel[]> =>
    await invokeWithStartupProfileTiming(
      "getAppMenuModel",
      APP_MENU_MODEL_CHANNEL,
    ),
  popupAppMenu: (request: AppMenuPopupRequest): void => {
    ipcRenderer.send(APP_MENU_POPUP_CHANNEL, request);
  },
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  }
});

// Decode the appearance hint passed from main via
// `webPreferences.additionalArguments`. The inline bootstrap script in
// index.html reads `window.__pwragentAppearance` synchronously, before
// any React code runs, to set data-theme / data-density on `<html>` —
// this is what prevents flash-of-wrong-theme on launch. The TOML
// (read by `readBootstrapAppearance` in main) is source of truth; the
// renderer's writeSettingsConfig IPC keeps it in sync.
const APPEARANCE_ARG_PREFIX = "--pwragent-appearance=";
function readBootstrapAppearance(): {
  theme: "system" | "dark" | "light";
  density: "mission-control" | "compact";
} {
  for (const arg of process.argv) {
    if (!arg.startsWith(APPEARANCE_ARG_PREFIX)) continue;
    try {
      const raw = JSON.parse(arg.slice(APPEARANCE_ARG_PREFIX.length));
      const theme =
        raw && (raw.theme === "system" || raw.theme === "dark" || raw.theme === "light")
          ? raw.theme
          : "system";
      const density =
        raw && (raw.density === "mission-control" || raw.density === "compact")
          ? raw.density
          : "mission-control";
      return { theme, density };
    } catch {
      break;
    }
  }
  return { theme: "system", density: "mission-control" };
}
const bootstrapAppearance = readBootstrapAppearance();

// Decode the navigation preference hint passed from main via
// `webPreferences.additionalArguments`. React reads this during the
// initial useState call so the thread lens is correct before first paint.
const NAVIGATION_ARG_PREFIX = "--pwragent-navigation-preferences=";
function readBootstrapNavigationPreferences(): {
  browseMode: NavigationBrowseMode;
} {
  for (const arg of process.argv) {
    if (!arg.startsWith(NAVIGATION_ARG_PREFIX)) continue;
    try {
      const raw = JSON.parse(arg.slice(NAVIGATION_ARG_PREFIX.length));
      const browseMode =
        raw &&
        (raw.browseMode === "inbox" ||
          raw.browseMode === "recents" ||
          raw.browseMode === "directories")
          ? raw.browseMode
          : "inbox";
      return { browseMode };
    } catch {
      break;
    }
  }
  return { browseMode: "inbox" };
}
const bootstrapNavigationPreferences = readBootstrapNavigationPreferences();

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("pwragent", desktopApi);
  contextBridge.exposeInMainWorld("__pwragentAppearance", bootstrapAppearance);
  // Surface the OS platform synchronously so the index.html bootstrap can set
  // `<html data-platform>` before first paint. This drives platform-specific
  // window chrome in app.css (e.g. zeroing the macOS stoplight reservation on
  // Windows, where the caption buttons live in the Window Controls Overlay).
  contextBridge.exposeInMainWorld("__pwragentPlatform", process.platform);
  contextBridge.exposeInMainWorld(
    "__pwragentNavigationPreferences",
    bootstrapNavigationPreferences,
  );
  recordPreloadLog("info", "exposed context bridge", {
    keys: Object.keys(desktopApi)
  });
} else {
  recordPreloadLog("warn", "context isolation disabled; bridge not exposed");
}
