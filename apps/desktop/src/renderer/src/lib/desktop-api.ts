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
  AutomationIdRequest,
  AutomationMutationResponse,
  ArchiveWorktreeRequest,
  ArchiveWorktreeResponse,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  CheckThreadBranchDriftRequest,
  CheckThreadBranchDriftResponse,
  CreateAutomationRequest,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  FocusedDiffAnalysisRequest,
  FocusedDiffAnalysisResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  GetAutomationRunArtifactRequest,
  GetAutomationRunArtifactResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  LatestCodexConfigWarningResponse,
  ListAutomationCardsRequest,
  ListAutomationCardsResponse,
  ListAutomationRunsRequest,
  ListAutomationRunsResponse,
  ListAutomationsRequest,
  ListAutomationsResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  ListAcpAgentSettingsRequest,
  ListAcpAgentSettingsResponse,
  ListDesktopPwrAgentProfilesResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  MarkThreadSeenRequest,
  ReorderDirectoryPinsRequest,
  ReorderDirectoryPinsResponse,
  ReorderThreadPinsRequest,
  ReorderThreadPinsResponse,
  SetDirectoryPinRequest,
  SetDirectoryPinResponse,
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
  GetMessagingActivitySummaryResponse,
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
  RunAutomationNowResponse,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  QueueThreadExecutionModeRequest,
  QueueThreadExecutionModeResponse,
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
  StartThreadRequest,
  StartThreadResponse,
  StartReviewRequest,
  StartReviewResponse,
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
  CodexEnvironmentSetupProgressEvent,
  CreateDesktopCodexAuthProfileRequest,
  CreateDesktopCodexAuthProfileResponse,
  CreateDesktopPwrAgentProfileRequest,
  CreateDesktopPwrAgentProfileResponse,
  DeleteDesktopPwrAgentProfileRequest,
  DeleteDesktopPwrAgentProfileResponse,
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
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
  StartDesktopCodexAuthProfileLoginRequest,
  StartDesktopCodexAuthProfileLoginResponse,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
  UpdateThreadExpectedBranchRequest,
  UpdateThreadExpectedBranchResponse,
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import type { RuntimeIdentity } from "../../../shared/runtime-identity";
import type { WindowPointerSnapshot } from "../../../shared/window-pointer";
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
} from "../../../shared/app-metadata";

export type DesktopApi = {
  copyText?: (text: string) => Promise<void>;
  getRuntimeIdentity?: () => Promise<RuntimeIdentity>;
  readAppMetadata?: () => Promise<AppMetadata>;
  readLicenseDocument?: (
    kind: AppLicenseDocumentKind,
  ) => Promise<AppLicenseDocument>;
  readChangelogDocument?: () => Promise<AppChangelogDocument>;
  openChangelogWindow?: () => Promise<void>;
  openThirdPartyNoticesWindow?: () => Promise<void>;
  readAppLogSnapshot?: () => Promise<AppLogSnapshot>;
  openAppLogWindow?: () => Promise<void>;
  onAppLogEntry?: (callback: (entry: AppLogEntry) => void) => () => void;
  checkForAppUpdates?: () => Promise<AppUpdateCheckResult>;
  readAppUpdateStatus?: () => Promise<AppUpdateStatus>;
  readAppUpdateReleaseVersions?: () => Promise<AppUpdateReleaseVersions>;
  onAppUpdateStatus?: (callback: (status: AppUpdateStatus) => void) => () => void;
  installAppUpdate?: () => Promise<AppUpdateInstallResult>;
  listAutomations?: (
    request?: ListAutomationsRequest,
  ) => Promise<ListAutomationsResponse>;
  createAutomation?: (
    request: CreateAutomationRequest,
  ) => Promise<AutomationMutationResponse>;
  updateAutomation?: (
    request: UpdateAutomationRequest,
  ) => Promise<AutomationMutationResponse>;
  deleteAutomation?: (
    request: AutomationIdRequest,
  ) => Promise<AutomationMutationResponse>;
  pauseAutomation?: (
    request: AutomationIdRequest,
  ) => Promise<AutomationMutationResponse>;
  resumeAutomation?: (
    request: AutomationIdRequest,
  ) => Promise<AutomationMutationResponse>;
  runAutomationNow?: (
    request: AutomationIdRequest,
  ) => Promise<RunAutomationNowResponse>;
  listAutomationRuns?: (
    request: ListAutomationRunsRequest,
  ) => Promise<ListAutomationRunsResponse>;
  listAutomationCards?: (
    request: ListAutomationCardsRequest,
  ) => Promise<ListAutomationCardsResponse>;
  getAutomationRunArtifact?: (
    request: GetAutomationRunArtifactRequest,
  ) => Promise<GetAutomationRunArtifactResponse>;
  listPwrAgentProfiles?: () => Promise<ListDesktopPwrAgentProfilesResponse>;
  openPwrAgentProfile?: (
    request: OpenDesktopPwrAgentProfileRequest,
  ) => Promise<OpenDesktopPwrAgentProfileResponse>;
  createPwrAgentProfile?: (
    request: CreateDesktopPwrAgentProfileRequest,
  ) => Promise<CreateDesktopPwrAgentProfileResponse>;
  setDefaultPwrAgentProfile?: (
    request: SetDefaultDesktopPwrAgentProfileRequest,
  ) => Promise<SetDefaultDesktopPwrAgentProfileResponse>;
  deletePwrAgentProfile?: (
    request: DeleteDesktopPwrAgentProfileRequest,
  ) => Promise<DeleteDesktopPwrAgentProfileResponse>;
  setPwrAgentProfileCodexProfile?: (
    request: SetDesktopPwrAgentProfileCodexProfileRequest,
  ) => Promise<SetDesktopPwrAgentProfileCodexProfileResponse>;
  /** Graduate ONLY the bootstrap profile's `config.toml` to the
   *  target real profile (theme, density, messaging acknowledgment,
   *  etc). Does NOT graduate secrets — call `writeSecretsToProfile`
   *  separately for those. The wizard's Finish path calls
   *  `writeSecretsToProfile` THEN this IPC; reversing the order
   *  strands secrets in `.bootstrap/`. No-op when the main process
   *  isn't in bootstrap mode (safe to call unconditionally). */
  graduateBootstrapConfigToProfile?: (
    request: GraduateDesktopBootstrapConfigToProfileRequest,
  ) => Promise<GraduateDesktopBootstrapConfigToProfileResponse>;
  /** Write secrets directly to a specific profile's keychain. The
   *  wizard uses this on Finish to graduate in-memory secret values
   *  (xAI API key, messaging tokens) to the operator's chosen
   *  profile — avoids stranding them in `.bootstrap/state.db` and
   *  enables per-profile xAI keys in Multiple mode. */
  writeSecretsToProfile?: (
    request: WriteDesktopSecretsToProfileRequest,
  ) => Promise<WriteDesktopSecretsToProfileResponse>;
  /** Returns the boot decision + state mode so the wizard can pick
   *  the right entry point (full first-run vs. slim "set up `foo`?"
   *  confirmation for a CLI/env-named missing profile). */
  getBootInfo?: () => Promise<DesktopBootInfo>;
  /** Quit the application. Used by the wizard's bootstrap-named
   *  confirmation step when the operator declines to set up the
   *  requested profile. */
  quitApp?: () => Promise<void>;
  /** Wait for another PwrAgent process to be alive on a target
   *  profile. The wizard's graduation path uses this to delay its
   *  own quit until the new profile's window has fully loaded —
   *  critical in dev mode where the Vite dev server dies with the
   *  bootstrap process. */
  waitForProfileAlive?: (
    request: WaitForDesktopProfileAliveRequest,
  ) => Promise<WaitForDesktopProfileAliveResponse>;
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
  setAcpSessionRuntimeOption?: (
    request: SetAcpSessionRuntimeOptionRequest,
  ) => Promise<SetAcpSessionRuntimeOptionResponse>;
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
  runCodexEnvironmentAction?: (
    request: RunCodexEnvironmentActionRequest,
  ) => Promise<RunCodexEnvironmentActionResponse>;
  setCodexThreadEnvironment?: (
    request: SetCodexThreadEnvironmentRequest,
  ) => Promise<SetCodexThreadEnvironmentResponse>;
  submitServerRequest?: (
    request: SubmitServerRequestRequest
  ) => Promise<SubmitServerRequestResponse>;
  trustCodexProject?: (
    request: TrustCodexProjectRequest,
  ) => Promise<TrustCodexProjectResponse>;
  getLatestCodexConfigWarning?: () => Promise<LatestCodexConfigWarningResponse>;
  getNavigationSnapshot?: (
    request?: GetNavigationSnapshotRequest
  ) => Promise<NavigationSnapshot>;
  listBackends?: (
    request?: ListBackendsRequest
  ) => Promise<ListBackendsResponse>;
  listAcpAgents?: (
    request?: ListAcpAgentSettingsRequest
  ) => Promise<ListAcpAgentSettingsResponse>;
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
  createCodexAuthProfile?: (
    request: CreateDesktopCodexAuthProfileRequest,
  ) => Promise<CreateDesktopCodexAuthProfileResponse>;
  startCodexAuthProfileLogin?: (
    request: StartDesktopCodexAuthProfileLoginRequest,
  ) => Promise<StartDesktopCodexAuthProfileLoginResponse>;
  checkCodexAuthProfileStatus?: (
    request: CheckDesktopCodexAuthProfileStatusRequest,
  ) => Promise<CheckDesktopCodexAuthProfileStatusResponse>;
  /**
   * Wizard-issued signal that the operator picked a Codex profile model
   * and the deferred Codex `listThreads` probe may now run. Persists
   * `onboarding.completed = true` (idempotent) and kicks off the same
   * startup thread-list prefetch. Returns the fresh settings snapshot.
   */
  completeOnboardingCodexBootstrap?: (
    request?: CompleteOnboardingCodexBootstrapRequest,
  ) => Promise<CompleteOnboardingCodexBootstrapResponse>;
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
  setThreadAgent?: (
    request: SetThreadAgentRequest
  ) => Promise<SetThreadAgentResponse>;
  reorderThreadPins?: (
    request: ReorderThreadPinsRequest
  ) => Promise<ReorderThreadPinsResponse>;
  /**
   * Directory pin IPC (plan 2026-05-09-002, Unit H). Mirror of
   * setThreadPin / reorderThreadPins minus the per-backend
   * dimension. The main-process handler validates the directoryKey
   * starts with "directory:" (rejecting workspace/unlinked).
   */
  setDirectoryPin?: (
    request: SetDirectoryPinRequest
  ) => Promise<SetDirectoryPinResponse>;
  reorderDirectoryPins?: (
    request: ReorderDirectoryPinsRequest
  ) => Promise<ReorderDirectoryPinsResponse>;
  refreshThreadPullRequests?: (
    request: RefreshThreadPullRequestsRequest
  ) => Promise<RefreshThreadPullRequestsResponse>;
  refreshDirectoryGitStatuses?: (
    request: RefreshDirectoryGitStatusesRequest
  ) => Promise<RefreshDirectoryGitStatusesResponse>;
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
  saveComposerDraft?: (
    request: SaveComposerDraftRequest,
  ) => Promise<SaveComposerDraftResponse>;
  recordComposerDraftHistory?: (
    request: RecordComposerDraftHistoryRequest,
  ) => Promise<RecordComposerDraftHistoryResponse>;
  clearComposerDraft?: (
    request: ClearComposerDraftRequest,
  ) => Promise<ClearComposerDraftResponse>;
  listComposerDraftRecoveryCandidates?: (
    request: ListComposerDraftRecoveryCandidatesRequest,
  ) => Promise<ListComposerDraftRecoveryCandidatesResponse>;
  listComposerDraftLatest?: () => Promise<ListComposerDraftLatestResponse>;
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
  /**
   * Subscription for main → renderer appearance broadcasts. Fired
   * whenever the user changes theme or density in Settings → the
   * write fans out to every open window so secondary surfaces
   * (changelog, app-log, license, messaging activity) can re-apply
   * `<html data-theme/data-density>` live instead of staying stuck on
   * their bootstrap-time value. The renderer's `useAppearance` hook
   * subscribes for React state; `main.tsx` also subscribes for a bare
   * DOM update so aux windows without React-Appearance follow along.
   */
  onAppearanceChanged?: (
    callback: (appearance: {
      theme: DesktopAppearanceTheme;
      density: DesktopAppearanceDensity;
    }) => void,
  ) => () => void;
  onCodexEnvironmentSetupProgress?: (
    callback: (event: CodexEnvironmentSetupProgressEvent) => void,
  ) => () => void;
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
  getMessagingActivitySummary?: () =>
    Promise<GetMessagingActivitySummaryResponse>;
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
  /** Shut down the messaging runtime in *this* process and release
   *  its lease. The wizard calls this right before spawning the
   *  operator's chosen profile in a child Electron, so the bootstrap
   *  process releases adapter resources (Telegram long-poll, Discord
   *  gateway, etc.) before the child starts up — otherwise the two
   *  processes race and the upstream returns 409 / "another shard
   *  connected" / similar exclusivity errors. Idempotent. */
  shutdownMessagingRuntime?: () => Promise<void>;
  onWindowFocus?: (callback: () => void) => () => void;
  /**
   * Main → renderer push: fires when the user invokes the app's
   * "Settings…" menu item. The main-window shell subscribes and
   * switches its main view to the Settings overlay. Returns an
   * unsubscribe function.
   */
  onOpenSettingsRequested?: (
    callback: (section?: string) => void,
  ) => () => void;
  /**
   * Main → renderer push: fires when the user invokes Help →
   * Replay Onboarding…. Re-opens the first-run wizard overlay
   * without flipping the persisted `onboarding.completed` flag.
   */
  onReplayOnboardingRequested?: (callback: () => void) => () => void;
  getWindowPointerSnapshot?: () => Promise<WindowPointerSnapshot>;
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
