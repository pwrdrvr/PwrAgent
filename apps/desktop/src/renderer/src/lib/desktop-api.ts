import { useEffect, useState } from "react";
import type { RendererErrorReport } from "../../../shared/renderer-error";
import type { RendererDiagnosticLogRequest } from "../../../shared/renderer-diagnostic";
import type {
  ImageUploadFallbackRequest,
  ImageUploadFallbackResponse,
  ImageUploadNormalizationLogRequest,
} from "../../../shared/image-normalization";
import type {
  AgentEvent,
  ArchiveWorktreeRequest,
  ArchiveWorktreeResponse,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  CheckThreadBranchDriftRequest,
  CheckThreadBranchDriftResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  FocusedDiffAnalysisRequest,
  FocusedDiffAnalysisResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  MarkThreadSeenRequest,
  SetThreadReactionRequest,
  SetThreadReactionResponse,
  GetGhStatusRequest,
  GhStatus,
  ListMessagingActivityRequest,
  ListMessagingActivityResponse,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  UnbindMessagingThreadRequest,
  UnbindMessagingThreadResponse,
  RefreshThreadPullRequestsRequest,
  RefreshThreadPullRequestsResponse,
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
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartReviewRequest,
  StartReviewResponse,
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
import type { RuntimeIdentity } from "../../../shared/runtime-identity";
import type {
  AppMetadata,
  AppUpdateCheckResult,
} from "../../../shared/app-metadata";

export type DesktopApi = {
  copyText?: (text: string) => Promise<void>;
  getRuntimeIdentity?: () => Promise<RuntimeIdentity>;
  readAppMetadata?: () => Promise<AppMetadata>;
  checkForAppUpdates?: () => Promise<AppUpdateCheckResult>;
  ping?: () => string;
  listSkills?: (
    request?: AppServerListSkillsRequest
  ) => Promise<AppServerListSkillsResponse>;
  analyzeFocusedDiff?: (
    request: FocusedDiffAnalysisRequest
  ) => Promise<FocusedDiffAnalysisResponse>;
  readThread?: (
    request: AppServerReadThreadRequest
  ) => Promise<AppServerReadThreadResponse>;
  archiveThread?: (
    request: ArchiveThreadRequest
  ) => Promise<ArchiveThreadResponse>;
  restoreThread?: (
    request: RestoreThreadRequest
  ) => Promise<RestoreThreadResponse>;
  archiveWorktree?: (
    request: ArchiveWorktreeRequest
  ) => Promise<ArchiveWorktreeResponse>;
  restoreWorktree?: (
    request: RestoreWorktreeRequest
  ) => Promise<RestoreWorktreeResponse>;
  handoffThreadWorkspace?: (
    request: HandoffThreadWorkspaceRequest
  ) => Promise<HandoffThreadWorkspaceResponse>;
  renameThread?: (
    request: RenameThreadRequest
  ) => Promise<RenameThreadResponse>;
  startThread?: (request: StartThreadRequest) => Promise<StartThreadResponse>;
  startReview?: (request: StartReviewRequest) => Promise<StartReviewResponse>;
  startTurn?: (request: StartTurnRequest) => Promise<StartTurnResponse>;
  interruptTurn?: (
    request: InterruptTurnRequest
  ) => Promise<InterruptTurnResponse>;
  steerTurn?: (request: SteerTurnRequest) => Promise<SteerTurnResponse>;
  setThreadExecutionMode?: (
    request: SetThreadExecutionModeRequest
  ) => Promise<SetThreadExecutionModeResponse>;
  setThreadModelSettings?: (
    request: SetThreadModelSettingsRequest
  ) => Promise<SetThreadModelSettingsResponse>;
  checkThreadBranchDrift?: (
    request: CheckThreadBranchDriftRequest
  ) => Promise<CheckThreadBranchDriftResponse>;
  updateThreadExpectedBranch?: (
    request: UpdateThreadExpectedBranchRequest
  ) => Promise<UpdateThreadExpectedBranchResponse>;
  retainThreadBranchDrift?: (
    request: RetainThreadBranchDriftRequest
  ) => Promise<RetainThreadBranchDriftResponse>;
  materializeDirectoryLaunchpad?: (
    request: MaterializeDirectoryLaunchpadRequest
  ) => Promise<MaterializeDirectoryLaunchpadResponse>;
  submitServerRequest?: (
    request: SubmitServerRequestRequest
  ) => Promise<SubmitServerRequestResponse>;
  getNavigationSnapshot?: (
    request?: GetNavigationSnapshotRequest
  ) => Promise<NavigationSnapshot>;
  listBackends?: (
    request?: ListBackendsRequest
  ) => Promise<ListBackendsResponse>;
  readSettings?: (
    request?: ReadDesktopSettingsRequest
  ) => Promise<ReadDesktopSettingsResponse>;
  writeSettingsConfig?: (
    request: WriteDesktopSettingsConfigRequest
  ) => Promise<DesktopSettingsWriteResponse>;
  replaceSettingsSecret?: (
    request: ReplaceDesktopSettingsSecretRequest
  ) => Promise<DesktopSettingsWriteResponse>;
  clearSettingsSecret?: (
    request: ClearDesktopSettingsSecretRequest
  ) => Promise<DesktopSettingsWriteResponse>;
  refreshCodexDiscovery?: (
    request?: RefreshDesktopCodexDiscoveryRequest
  ) => Promise<ReadDesktopSettingsResponse>;
  openApplication?: (
    request: OpenDesktopApplicationRequest
  ) => Promise<OpenDesktopApplicationResponse>;
  listThreads?: (
    request?: AppServerListThreadsRequest
  ) => Promise<AppServerListThreadsResponse>;
  markThreadSeen?: (request: MarkThreadSeenRequest) => Promise<unknown>;
  setThreadReaction?: (
    request: SetThreadReactionRequest
  ) => Promise<SetThreadReactionResponse>;
  refreshThreadPullRequests?: (
    request: RefreshThreadPullRequestsRequest
  ) => Promise<RefreshThreadPullRequestsResponse>;
  getGhStatus?: (request?: GetGhStatusRequest) => Promise<GhStatus>;
  ensureDirectoryLaunchpad?: (
    request: EnsureDirectoryLaunchpadRequest
  ) => Promise<EnsureDirectoryLaunchpadResponse>;
  updateDirectoryLaunchpad?: (
    request: UpdateDirectoryLaunchpadRequest
  ) => Promise<UpdateDirectoryLaunchpadResponse>;
  resetDirectoryLaunchpad?: (
    request: ResetDirectoryLaunchpadRequest
  ) => Promise<ResetDirectoryLaunchpadResponse>;
  normalizeImageForUpload?: (
    request: ImageUploadFallbackRequest
  ) => Promise<ImageUploadFallbackResponse>;
  recordImageUploadNormalization?: (
    request: ImageUploadNormalizationLogRequest
  ) => Promise<void>;
  logRendererDiagnostic?: (request: RendererDiagnosticLogRequest) => Promise<void>;
  reportRendererError?: (report: RendererErrorReport) => Promise<void>;
  onAgentEvent?: (callback: (event: AgentEvent) => void) => () => void;
  getMessagingPlatformStatuses?: () => Promise<MessagingPlatformStatus[]>;
  onMessagingPlatformStatusEvent?: (
    callback: (event: MessagingPlatformStatusEvent) => void,
  ) => () => void;
  /**
   * Marker event fired whenever the main process mutates a messaging
   * binding (create / refresh metadata / sync title / detach / revoke).
   * Listeners should refetch the navigation snapshot rather than
   * trying to apply per-binding diffs from the payload — that's where
   * binding chips live, and the snapshot endpoint is cheap and
   * idempotent. See `MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL`.
   */
  onMessagingBindingsChanged?: (
    callback: (event: { at: number }) => void,
  ) => () => void;
  unbindMessagingThread?: (
    request: UnbindMessagingThreadRequest,
  ) => Promise<UnbindMessagingThreadResponse>;
  listMessagingActivity?: (
    request?: ListMessagingActivityRequest,
  ) => Promise<ListMessagingActivityResponse>;
  onWindowFocus?: (callback: () => void) => () => void;
  platform?: string;
  versions?: {
    chrome?: string;
    electron?: string;
    node?: string;
  };
};

export function getDesktopApi(): DesktopApi | undefined {
  return (window as Window & { pwragent?: DesktopApi }).pwragent;
}

export function useDesktopApi(): DesktopApi | undefined {
  const [desktopApi, setDesktopApi] = useState<DesktopApi | undefined>(() =>
    getDesktopApi()
  );

  useEffect(() => {
    if (desktopApi) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const refresh = (): void => {
      const nextDesktopApi = getDesktopApi();
      if (nextDesktopApi) {
        setDesktopApi(nextDesktopApi);
        return;
      }

      if (!cancelled) {
        timeoutId = setTimeout(refresh, 16);
      }
    };

    refresh();

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [desktopApi]);

  return desktopApi;
}
