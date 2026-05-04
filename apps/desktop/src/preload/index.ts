import { clipboard, contextBridge, ipcRenderer } from "electron";
import type {
  AgentEvent,
  ArchiveWorktreeRequest,
  ArchiveWorktreeResponse,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
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
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
  NavigationSnapshot,
  ResetDirectoryLaunchpadRequest,
  ResetDirectoryLaunchpadResponse,
  RetainThreadBranchDriftRequest,
  RetainThreadBranchDriftResponse,
  RenameThreadRequest,
  RenameThreadResponse,
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
  ClearDesktopSettingsSecretRequest,
  DesktopSettingsWriteResponse,
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
  RefreshDesktopCodexDiscoveryRequest,
  ReplaceDesktopSettingsSecretRequest,
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
  AGENT_EVENT_CHANNEL,
  AGENT_CHECK_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_INTERRUPT_TURN_CHANNEL,
  AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
  AGENT_RETAIN_THREAD_BRANCH_DRIFT_CHANNEL,
  AGENT_SET_THREAD_EXECUTION_MODE_CHANNEL,
  AGENT_SET_THREAD_MODEL_SETTINGS_CHANNEL,
  AGENT_START_THREAD_CHANNEL,
  AGENT_START_REVIEW_CHANNEL,
  AGENT_START_TURN_CHANNEL,
  AGENT_STEER_TURN_CHANNEL,
  AGENT_SUBMIT_SERVER_REQUEST_CHANNEL,
  AGENT_UPDATE_THREAD_EXPECTED_BRANCH_CHANNEL,
  APP_METADATA_READ_CHANNEL,
  APP_UPDATE_CHECK_CHANNEL,
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
  NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
  FOCUSED_DIFF_ANALYZE_CHANNEL,
  IMAGE_UPLOAD_FALLBACK_CHANNEL,
  IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
  PRELOAD_LOG_CHANNEL,
  RENDERER_ERROR_REPORT_CHANNEL,
  RUNTIME_IDENTITY_CHANNEL,
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_WRITE_CONFIG_CHANNEL,
  WINDOW_FOCUS_SYNC_CHANNEL,
} from "../shared/ipc";
import type { RuntimeIdentity } from "../shared/runtime-identity";
import type { AppMetadata, AppUpdateCheckResult } from "../shared/app-metadata";

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
  checkForAppUpdates: async (): Promise<AppUpdateCheckResult> =>
    await ipcRenderer.invoke(APP_UPDATE_CHECK_CHANNEL),
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
  onAgentEvent: (callback: (event: AgentEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) =>
      callback(payload);
    ipcRenderer.on(AGENT_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.off(AGENT_EVENT_CHANNEL, listener);
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
