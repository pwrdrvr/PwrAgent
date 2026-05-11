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
  ListDesktopPwrAgentProfilesResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  MarkThreadSeenRequest,
  ReorderThreadPinsRequest,
  ReorderThreadPinsResponse,
  SetThreadReactionRequest,
  SetThreadReactionResponse,
  SetThreadPinRequest,
  SetThreadPinResponse,
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
  MessagingPairingEntry,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  RejectMessagingPairingRequest,
  RejectMessagingPairingResponse,
  SetMessagingEnabledRequest,
  SetMessagingEnabledResponse,
  PickDirectoryFromDiskResponse,
  RegisterDirectoryFromDiskRequest,
  RegisterDirectoryFromDiskResponse,
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
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  QueueThreadExecutionModeRequest,
  QueueThreadExecutionModeResponse,
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
  DesktopMessagingContactLookupRequest,
  DesktopMessagingContactLookupResponse,
  DesktopSettingsWriteResponse,
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  OpenDesktopPwrAgentProfileRequest,
  OpenDesktopPwrAgentProfileResponse,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
  PickGhCommandResponse,
  RefreshDesktopCodexDiscoveryRequest,
  ReplaceDesktopSettingsSecretRequest,
  SettingsCredentialTestKind,
  SettingsCredentialTestRequest,
  SettingsCredentialTestResult,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
  UpdateThreadExpectedBranchRequest,
  UpdateThreadExpectedBranchResponse,
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import type { RuntimeIdentity } from "../../../shared/runtime-identity";
import type {
  AppLicenseDocument,
  AppLicenseDocumentKind,
  AppMetadata,
  AppUpdateCheckResult,
} from "../../../shared/app-metadata";

export type DesktopApi = {
  copyText?: (text: string) => Promise<void>;
  getRuntimeIdentity?: () => Promise<RuntimeIdentity>;
  readAppMetadata?: () => Promise<AppMetadata>;
  readLicenseDocument?: (
    kind: AppLicenseDocumentKind,
  ) => Promise<AppLicenseDocument>;
  checkForAppUpdates?: () => Promise<AppUpdateCheckResult>;
  listPwrAgentProfiles?: () => Promise<ListDesktopPwrAgentProfilesResponse>;
  openPwrAgentProfile?: (
    request: OpenDesktopPwrAgentProfileRequest,
  ) => Promise<OpenDesktopPwrAgentProfileResponse>;
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
  queueThreadExecutionMode?: (
    request: QueueThreadExecutionModeRequest,
  ) => Promise<QueueThreadExecutionModeResponse>;
  cancelThreadExecutionModeQueue?: (
    request: CancelThreadExecutionModeQueueRequest,
  ) => Promise<CancelThreadExecutionModeQueueResponse>;
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
  pickGhCommand?: () => Promise<PickGhCommandResponse>;
  /** Run the per-credential connection-test probe for a settings panel.
   *  Result contains parsed identity (bot username, model IDs, codex
   *  version) — never the secret itself. */
  testSettingsCredentials?: (
    request: SettingsCredentialTestRequest,
  ) => Promise<SettingsCredentialTestResult>;
  /** Read the last-known credential-test result without firing a new
   *  probe. Used by the test-block primitive to render the previous
   *  status on settings-pane mount. */
  readLastSettingsCredentialTest?: (
    request: { kind: SettingsCredentialTestKind },
  ) => Promise<SettingsCredentialTestResult | undefined>;
  resolveMessagingContact?: (
    request: DesktopMessagingContactLookupRequest,
  ) => Promise<DesktopMessagingContactLookupResponse>;
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
  setThreadPin?: (
    request: SetThreadPinRequest
  ) => Promise<SetThreadPinResponse>;
  reorderThreadPins?: (
    request: ReorderThreadPinsRequest
  ) => Promise<ReorderThreadPinsResponse>;
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
  /**
   * Project-directory picker (issue #223): two-step flow so the renderer
   * can show inline validation errors. `pickDirectoryFromDisk` opens the
   * OS dialog and returns the chosen path (or `canceled: true` if the
   * user dismissed). The renderer then calls `registerDirectoryFromDisk`
   * with the path so the main process can validate it's a git repo and
   * seed a launchpad in one round-trip.
   */
  pickDirectoryFromDisk?: () => Promise<PickDirectoryFromDiskResponse>;
  registerDirectoryFromDisk?: (
    request: RegisterDirectoryFromDiskRequest,
  ) => Promise<RegisterDirectoryFromDiskResponse>;
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
  setMessagingEnabled?: (
    request: SetMessagingEnabledRequest,
  ) => Promise<SetMessagingEnabledResponse>;
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
  generateMessagingPairingToken?: (
    request: GenerateMessagingPairingTokenRequest,
  ) => Promise<GenerateMessagingPairingTokenResponse>;
  listMessagingPairingRequests?: (
    request?: ListMessagingPairingRequestsRequest,
  ) => Promise<ListMessagingPairingRequestsResponse>;
  approveMessagingPairing?: (
    request: ApproveMessagingPairingRequest,
  ) => Promise<ApproveMessagingPairingResponse>;
  rejectMessagingPairing?: (
    request: RejectMessagingPairingRequest,
  ) => Promise<RejectMessagingPairingResponse>;
  onMessagingPairingChanged?: (
    callback: (event: { at: number; entry: MessagingPairingEntry }) => void,
  ) => () => void;
  /** Spawns or focuses the dedicated Messaging Activity window. */
  openMessagingActivityWindow?: () => Promise<void>;
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
