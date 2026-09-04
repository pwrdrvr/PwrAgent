import type {
  AnalyzeThreadToolHistoryRequest,
  AnalyzeThreadToolHistoryResponse,
  AppServerBackendKind,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerLocalFileInputItem,
  AppServerLocalImageInputItem,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  AgentEvent,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  CancelQueuedTurnRequest,
  CancelQueuedTurnResponse,
  ReleaseQueuedTurnRequest,
  ReleaseQueuedTurnResponse,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  CelestialIconId,
  CheckThreadBranchDriftRequest,
  CheckThreadBranchDriftResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  ControlActiveTurnRequest,
  ControlActiveTurnResponse,
  CreateScheduledThreadActionRequest,
  CodexEnvironmentSetupProgressEvent,
  DetachThreadPullRequestRequest,
  DetachThreadPullRequestResponse,
  FederationCapability,
  FederationJumpSearchRequest,
  FederationJumpSearchResponse,
  FederationInstanceId,
  FederatedThreadRef,
  FederationLoadStatus,
  FederationRequestEnvelope,
  ForkThreadRequest,
  ForkThreadResponse,
  GetNavigationSnapshotRequest,
  GetNavigationSnapshotTransportRequest,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  GetWorktreeUnpublishedCommitDiffRequest,
  GetWorktreeUnpublishedCommitDiffResponse,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  ListThreadMcpServersRequest,
  ListThreadMcpServersResponse,
  ListModelSettingsRecentsRequest,
  ListModelSettingsRecentsResponse,
  ListRecentFileReferencesResponse,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ListWorktreeUnpublishedCommitsRequest,
  ListWorktreeUnpublishedCommitsResponse,
  MaterializeDirectoryLaunchpadOptions,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
  MessagingPlatformStatus,
  PwrSnapConnectionStatus,
  SetThreadReactionRequest,
  SetThreadReactionResponse,
  SetThreadPinRequest,
  SetThreadPinResponse,
  SetThreadPrAutoDispatchRequest,
  SetThreadPrAutoDispatchResponse,
  CancelThreadPrAutoDispatchRequest,
  CancelThreadPrAutoDispatchResponse,
  SendThreadPrAutoDispatchNowRequest,
  SendThreadPrAutoDispatchNowResponse,
  ReorderThreadPinsRequest,
  ReorderThreadPinsResponse,
  NavigationSnapshot,
  NavigationSnapshotTransportResponse,
  NavigationSnapshotTransportSelection,
  NavigationThreadSummary,
  DesktopApplicationsSnapshot,
  OpenDesktopApplicationRequest,
  OpenDesktopApplicationResponse,
  AttachDirectoryToThreadRequest,
  AttachDirectoryToThreadResponse,
  QueueThreadExecutionModeRequest,
  QueueThreadExecutionModeResponse,
  RefreshDirectoryGitStatusesRequest,
  RefreshDirectoryGitStatusesResponse,
  RefreshOwnedThreadPullRequestsRequest,
  RefreshThreadPullRequestsResponse,
  RecordModelSettingsRecentRequest,
  RecordRecentFileReferencesRequest,
  ResolveThreadRequest,
  ResolveThreadResponse,
  RetainThreadBranchDriftRequest,
  RetainThreadBranchDriftResponse,
  ReloadCodexMcpConfigRequest,
  ReloadCodexMcpConfigResponse,
  RenameThreadRequest,
  RenameThreadResponse,
  ResolveActiveTurnRequest,
  ResolveActiveTurnResponse,
  RunCodexEnvironmentActionRequest,
  RunCodexEnvironmentActionResponse,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  SetAcpSessionRuntimeOptionRequest,
  SetAcpSessionRuntimeOptionResponse,
  SetCelestialIconRequest,
  SetCelestialIconResponse,
  StarMapIntakeRequest,
  StarMapIntakeResponse,
  SetCodexThreadEnvironmentRequest,
  SetCodexThreadEnvironmentResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  SetThreadParentRequest,
  SetThreadParentResponse,
  SetSubthreadsCollapsedRequest,
  SetSubthreadsCollapsedResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartTurnRequest,
  StartTurnResponse,
  StartReviewRequest,
  StartReviewResponse,
  StartThreadRequest,
  StartThreadResponse,
  StopSubAgentRequest,
  StopSubAgentResponse,
  StopCodexEnvironmentActionRequest,
  StopCodexEnvironmentActionResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  TrustCodexProjectRequest,
  TrustCodexProjectResponse,
  ThreadAdmissionState,
  UpdateSubthreadOrderRequest,
  UpdateSubthreadOrderResponse,
  UpdateScheduledThreadActionRequest,
  UpdateThreadExpectedBranchRequest,
  UpdateThreadExpectedBranchResponse,
} from "@pwragent/shared";
import {
  encodeNavigationSnapshotThreadKeysForProtocolV1,
  normalizeNavigationSnapshotThreadKeys,
} from "@pwragent/shared";
import { NavigationSnapshotTransport } from "../navigation-snapshot-transport";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcEndpoint } from "./federation-rpc";
import {
  fitNormalizedReplayWithinByteBudget,
  pageNormalizedReplay,
  threadReplayCursorIdSpace,
} from "../app-server/thread-replay-pagination";
import { FEDERATION_MAX_FRAME_BYTES } from "./federation-transport";

export const FEDERATION_RESPONSE_BYTE_BUDGET =
  FEDERATION_MAX_FRAME_BYTES - 64 * 1024;

/**
 * Load queries answer from in-memory OS counters plus one statfs, so a
 * healthy peer replies well inside a second. Callers fan the query out
 * across the fleet and degrade to "no load block" on timeout — a slow
 * peer must cost seconds, not the default 30s RPC leash.
 */
export const FEDERATION_LOAD_STATUS_TIMEOUT_MS = 2_500;

export type FederationReadTranscriptImageRequest = {
  url: string;
};

export type FederatedTranscriptImageResponse = {
  dataBase64: string;
  mimeType: string;
};

export type FederationStartTurnRequest = StartTurnRequest & {
  messageOrigin?: AppServerThreadMessageOrigin;
};

export type FederationTurnInputBlobReference = {
  type: "federationBlob";
  transferId: string;
};

export type FederationWireTurnInputItem =
  | AppServerTurnInputItem
  | FederationTurnInputBlobReference;

export type FederationStarMapIntakeAttachment =
  | Pick<AppServerLocalImageInputItem, "type" | "name" | "path">
  | Pick<AppServerLocalFileInputItem, "type" | "name" | "path">;

export type FederationStarMapIntakeRequest =
  Omit<StarMapIntakeRequest, "attachments"> & {
    attachments?: FederationStarMapIntakeAttachment[];
  };

type FederationWireStarMapIntakeRequest =
  Omit<FederationStarMapIntakeRequest, "attachments"> & {
    attachments?: FederationWireTurnInputItem[];
  };

type FederationWireControlActiveTurnRequest =
  Omit<ControlActiveTurnRequest, "input"> & {
    input?: FederationWireTurnInputItem[];
  };

export type PrepareOutgoingFederationTurnInput = (
  input: readonly AppServerTurnInputItem[],
) => Promise<FederationWireTurnInputItem[]>;

export type ResolveIncomingFederationTurnInput = (
  input: readonly FederationWireTurnInputItem[],
  sourceInstanceId: FederationInstanceId,
) => Promise<AppServerTurnInputItem[]>;

async function resolveFederationTurnInput(
  resolver: ResolveIncomingFederationTurnInput | undefined,
  input: readonly FederationWireTurnInputItem[],
  sourceInstanceId: FederationInstanceId,
): Promise<AppServerTurnInputItem[]> {
  if (resolver) {
    return await resolver(input, sourceInstanceId);
  }
  for (const item of input) {
    if (
      item.type === "federationBlob"
      || item.type === "localImage"
      || item.type === "localFile"
      || item.type === "file"
      || (
        item.type === "image"
        && (item.url.startsWith("data:") || item.url.startsWith("file:"))
      )
    ) {
      throw new Error(
        "Federation attachment references require the staged-input resolver.",
      );
    }
  }
  return input as AppServerTurnInputItem[];
}

export type FederationRefreshThreadPullRequestsRequest =
  RefreshOwnedThreadPullRequestsRequest;

function localizeRefreshThreadPullRequestsRequest(
  request: RefreshOwnedThreadPullRequestsRequest,
): FederationRefreshThreadPullRequestsRequest {
  return {
    backend: request.backend,
    threadId: request.threadId,
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.trigger ? { trigger: request.trigger } : {}),
  };
}

type FederationMaterializeDirectoryLaunchpadRequest =
  Omit<MaterializeDirectoryLaunchpadRequest, "input"> & {
    input?: FederationWireTurnInputItem[];
    messageOrigin?: AppServerThreadMessageOrigin;
  };

export type FederationMountRemoteChildRequest = {
  ref: FederatedThreadRef;
  summary: NavigationThreadSummary;
  instanceLabel: string;
};

export type FederationMountRemoteChildResponse = {
  mounted: true;
};

type ResolvedSourceInstance = {
  label: string;
  celestialIcon?: CelestialIconId;
};

function authenticateMessageOrigin(params: {
  messageOrigin: AppServerThreadMessageOrigin | undefined;
  resolveSourceInstance?: (
    instanceId: string,
  ) => ResolvedSourceInstance | undefined;
  sourceInstanceId: string;
}): AppServerThreadMessageOrigin | undefined {
  const sourceThread = params.messageOrigin?.sourceThread;
  if (!params.messageOrigin || !sourceThread) {
    return params.messageOrigin;
  }

  let sourceInstance: ResolvedSourceInstance | undefined;
  try {
    sourceInstance = params.resolveSourceInstance?.(params.sourceInstanceId);
  } catch {
    // The authenticated instance id remains useful when display metadata is
    // temporarily unavailable. Never fall back to caller-provided identity.
  }

  return {
    ...params.messageOrigin,
    sourceThread: {
      backend: sourceThread.backend,
      instanceId: params.sourceInstanceId,
      ...(sourceInstance?.label
        ? { instanceLabel: sourceInstance.label }
        : {}),
      ...(sourceInstance?.celestialIcon
        ? { celestialIcon: sourceInstance.celestialIcon }
        : {}),
      threadId: sourceThread.threadId,
      ...(sourceThread.title ? { title: sourceThread.title } : {}),
    },
  };
}

function authenticateScheduledTurnOrigin<
  T extends {
    turn?: { messageOrigin?: AppServerThreadMessageOrigin };
  },
>(params: {
  request: T;
  resolveSourceInstance?: (
    instanceId: string,
  ) => ResolvedSourceInstance | undefined;
  sourceInstanceId: string;
}): T {
  const messageOrigin = params.request.turn?.messageOrigin;
  if (!params.request.turn || !messageOrigin) {
    return params.request;
  }
  return {
    ...params.request,
    turn: {
      ...params.request.turn,
      messageOrigin: authenticateMessageOrigin({
        messageOrigin,
        resolveSourceInstance: params.resolveSourceInstance,
        sourceInstanceId: params.sourceInstanceId,
      }),
    },
  };
}

export const FEDERATION_BACKEND_METHODS = {
  getNavigationSnapshot: "backend.getNavigationSnapshot",
  searchNavigationThreads: "backend.searchNavigationThreads",
  listThreads: "backend.listThreads",
  resolveThread: "backend.resolveThread",
  resolveThreadAdmissionState: "backend.resolveThreadAdmissionState",
  readThread: "backend.readThread",
  analyzeThreadToolHistory: "backend.analyzeThreadToolHistory",
  readTranscriptImage: "backend.readTranscriptImage",
  listSkills: "backend.listSkills",
  listBackends: "backend.listBackends",
  markThreadSeen: "backend.markThreadSeen",
  setThreadReaction: "backend.setThreadReaction",
  setThreadPin: "backend.setThreadPin",
  reorderThreadPins: "backend.reorderThreadPins",
  mountRemoteChild: "backend.mountRemoteChild",
  setThreadParent: "backend.setThreadParent",
  updateSubthreadOrder: "backend.updateSubthreadOrder",
  setSubthreadsCollapsed: "backend.setSubthreadsCollapsed",
  detachThreadPullRequest: "backend.detachThreadPullRequest",
  setThreadPrAutoDispatch: "backend.setThreadPrAutoDispatch",
  cancelThreadPrAutoDispatch: "backend.cancelThreadPrAutoDispatch",
  sendThreadPrAutoDispatchNow: "backend.sendThreadPrAutoDispatchNow",
  archiveThread: "backend.archiveThread",
  startThread: "backend.startThread",
  forkThread: "backend.forkThread",
  startTurn: "backend.startTurn",
  cancelQueuedTurn: "backend.cancelQueuedTurn",
  releaseQueuedTurn: "backend.releaseQueuedTurn",
  startReview: "backend.startReview",
  listScheduledThreadActions: "backend.listScheduledThreadActions",
  createScheduledThreadAction: "backend.createScheduledThreadAction",
  updateScheduledThreadAction: "backend.updateScheduledThreadAction",
  cancelScheduledThreadAction: "backend.cancelScheduledThreadAction",
  sendScheduledThreadActionNow: "backend.sendScheduledThreadActionNow",
  compactThread: "backend.compactThread",
  listThreadMcpServers: "backend.listThreadMcpServers",
  reloadCodexMcpConfig: "backend.reloadCodexMcpConfig",
  controlActiveTurn: "backend.controlActiveTurn",
  resolveActiveTurn: "backend.resolveActiveTurn",
  interruptTurn: "backend.interruptTurn",
  stopSubAgent: "backend.stopSubAgent",
  steerTurn: "backend.steerTurn",
  setThreadExecutionMode: "backend.setThreadExecutionMode",
  queueThreadExecutionMode: "backend.queueThreadExecutionMode",
  cancelThreadExecutionModeQueue: "backend.cancelThreadExecutionModeQueue",
  setAcpSessionRuntimeOption: "backend.setAcpSessionRuntimeOption",
  setThreadModelSettings: "backend.setThreadModelSettings",
  checkThreadBranchDrift: "backend.checkThreadBranchDrift",
  updateThreadExpectedBranch: "backend.updateThreadExpectedBranch",
  retainThreadBranchDrift: "backend.retainThreadBranchDrift",
  submitServerRequest: "backend.submitServerRequest",
  runCodexEnvironmentAction: "backend.runCodexEnvironmentAction",
  stopCodexEnvironmentAction: "backend.stopCodexEnvironmentAction",
  setCodexThreadEnvironment: "backend.setCodexThreadEnvironment",
  refreshThreadPullRequests: "backend.refreshThreadPullRequests",
  refreshDirectoryGitStatuses: "backend.refreshDirectoryGitStatuses",
  ensureDirectoryLaunchpad: "backend.ensureDirectoryLaunchpad",
  listRecentFileReferences: "backend.listRecentFileReferences",
  recordRecentFileReferences: "backend.recordRecentFileReferences",
  listModelSettingsRecents: "backend.listModelSettingsRecents",
  recordModelSettingsRecent: "backend.recordModelSettingsRecent",
  attachDirectoryToThread: "backend.attachDirectoryToThread",
  listWorktreeUnpublishedCommits: "backend.listWorktreeUnpublishedCommits",
  getWorktreeUnpublishedCommitDiff: "backend.getWorktreeUnpublishedCommitDiff",
  materializeDirectoryLaunchpad: "backend.materializeDirectoryLaunchpad",
  handoffThreadWorkspace: "backend.handoffThreadWorkspace",
  renameThread: "backend.renameThread",
  readApplications: "backend.readApplications",
  openApplication: "backend.openApplication",
  readMessagingPlatformStatuses: "backend.readMessagingPlatformStatuses",
  readPwrSnapConnectionStatus: "backend.readPwrSnapConnectionStatus",
  getLoadStatus: "backend.getLoadStatus",
  trustCodexProject: "backend.trustCodexProject",
  setCelestialIcon: "backend.setCelestialIcon",
  starMapIntake: "backend.starMapIntake",
} as const;

export const FEDERATION_BACKEND_EVENT_METHOD = "backend.event";
export const FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD =
  "backend.environmentSetupProgress";

export type FederationBackendEventNotification = {
  method: typeof FEDERATION_BACKEND_EVENT_METHOD;
  params: AgentEvent;
};

export type FederationEnvironmentSetupProgressNotification = {
  method: typeof FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD;
  params: CodexEnvironmentSetupProgressEvent;
};

export type FederationBackendMethod =
  (typeof FEDERATION_BACKEND_METHODS)[keyof typeof FEDERATION_BACKEND_METHODS];

export const FEDERATION_BACKEND_METHOD_CAPABILITIES: Record<
  FederationBackendMethod,
  FederationCapability
> = {
  [FEDERATION_BACKEND_METHODS.getNavigationSnapshot]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.searchNavigationThreads]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.listThreads]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.resolveThread]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.resolveThreadAdmissionState]: "messaging_route",
  [FEDERATION_BACKEND_METHODS.readThread]: "thread_detail",
  /* Reads the thread's own transcript history; same data class as reading it. */
  [FEDERATION_BACKEND_METHODS.analyzeThreadToolHistory]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.readTranscriptImage]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.listSkills]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.listBackends]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.markThreadSeen]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.setThreadReaction]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.setThreadPin]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.reorderThreadPins]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.mountRemoteChild]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.setThreadParent]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.updateSubthreadOrder]: "thread_grouping",
  [FEDERATION_BACKEND_METHODS.setSubthreadsCollapsed]: "thread_grouping",
  // PR detach cancels pending auto-dispatch work and auto-dispatch arms
  // automatic repair turns, so both sit with the turn-control grants
  // (like archiveThread) rather than the browse-level navigation grants.
  [FEDERATION_BACKEND_METHODS.detachThreadPullRequest]: "turn_control",
  [FEDERATION_BACKEND_METHODS.setThreadPrAutoDispatch]: "turn_control",
  [FEDERATION_BACKEND_METHODS.cancelThreadPrAutoDispatch]: "turn_control",
  [FEDERATION_BACKEND_METHODS.sendThreadPrAutoDispatchNow]: "turn_control",
  [FEDERATION_BACKEND_METHODS.archiveThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.startThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.forkThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.startTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.cancelQueuedTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.releaseQueuedTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.startReview]: "turn_control",
  [FEDERATION_BACKEND_METHODS.listScheduledThreadActions]: "scheduled_actions",
  [FEDERATION_BACKEND_METHODS.createScheduledThreadAction]: "scheduled_actions",
  [FEDERATION_BACKEND_METHODS.updateScheduledThreadAction]: "scheduled_actions",
  [FEDERATION_BACKEND_METHODS.cancelScheduledThreadAction]: "scheduled_actions",
  [FEDERATION_BACKEND_METHODS.sendScheduledThreadActionNow]: "scheduled_actions",
  [FEDERATION_BACKEND_METHODS.compactThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.listThreadMcpServers]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.reloadCodexMcpConfig]: "turn_control",
  [FEDERATION_BACKEND_METHODS.controlActiveTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.resolveActiveTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.interruptTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.stopSubAgent]: "turn_control",
  [FEDERATION_BACKEND_METHODS.steerTurn]: "turn_control",
  [FEDERATION_BACKEND_METHODS.setThreadExecutionMode]: "turn_control",
  [FEDERATION_BACKEND_METHODS.queueThreadExecutionMode]: "turn_control",
  [FEDERATION_BACKEND_METHODS.cancelThreadExecutionModeQueue]: "turn_control",
  [FEDERATION_BACKEND_METHODS.setAcpSessionRuntimeOption]: "turn_control",
  [FEDERATION_BACKEND_METHODS.setThreadModelSettings]: "turn_control",
  [FEDERATION_BACKEND_METHODS.checkThreadBranchDrift]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.updateThreadExpectedBranch]: "turn_control",
  [FEDERATION_BACKEND_METHODS.retainThreadBranchDrift]: "turn_control",
  [FEDERATION_BACKEND_METHODS.submitServerRequest]: "pending_request_control",
  [FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.stopCodexEnvironmentAction]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.refreshThreadPullRequests]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.refreshDirectoryGitStatuses]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.ensureDirectoryLaunchpad]: "launchpad_metadata",
  [FEDERATION_BACKEND_METHODS.listRecentFileReferences]: "remote_window",
  [FEDERATION_BACKEND_METHODS.recordRecentFileReferences]: "remote_window",
  // Reviewer/composer model-settings history is read-only preference data at
  // the same sensitivity tier as the recent-file list it sits beside.
  [FEDERATION_BACKEND_METHODS.listModelSettingsRecents]: "remote_window",
  [FEDERATION_BACKEND_METHODS.recordModelSettingsRecent]: "remote_window",
  [FEDERATION_BACKEND_METHODS.attachDirectoryToThread]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.listWorktreeUnpublishedCommits]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.getWorktreeUnpublishedCommitDiff]: "thread_detail",
  [FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad]: "environment_actions",
  [FEDERATION_BACKEND_METHODS.handoffThreadWorkspace]: "turn_control",
  [FEDERATION_BACKEND_METHODS.renameThread]: "turn_control",
  [FEDERATION_BACKEND_METHODS.readApplications]: "remote_window",
  [FEDERATION_BACKEND_METHODS.openApplication]: "remote_window",
  // Read-only peer messaging health for the remote window's MSG chip.
  // messaging_route stays reserved for messaging-originated remote control.
  [FEDERATION_BACKEND_METHODS.readMessagingPlatformStatuses]: "remote_window",
  [FEDERATION_BACKEND_METHODS.readPwrSnapConnectionStatus]: "pwrsnap_connection",
  // On-demand load readings (CPU load averages, available RAM, free
  // disk) are read-only health facts at the same sensitivity tier as
  // the browse-level grants, and the Star Map surface that polls them
  // already rides thread_navigation for its event class. A dedicated
  // capability would buy no isolation and cost every peer a handshake
  // re-advertisement.
  [FEDERATION_BACKEND_METHODS.getLoadStatus]: "thread_navigation",
  [FEDERATION_BACKEND_METHODS.trustCodexProject]: "environment_actions",
  // Celestial icon overrides are directed at the gateway (the assignment
  // coordinator). No dedicated capability exists for federation-level
  // cosmetic state; thread_navigation is the least-privileged grant every
  // browsing peer already holds.
  [FEDERATION_BACKEND_METHODS.setCelestialIcon]: "thread_navigation",
  // Intake creates a thread and starts its first turn on the owning
  // instance — the same trust the materialize-launchpad path carries.
  [FEDERATION_BACKEND_METHODS.starMapIntake]: "environment_actions",
};

export function additionalFederationBackendCapabilities(
  envelope: FederationRequestEnvelope,
): readonly FederationCapability[] {
  if (envelope.method !== FEDERATION_BACKEND_METHODS.steerTurn) return [];
  const request = envelope.params as Partial<SteerTurnRequest> | undefined;
  return request?.fallback ? ["scheduled_actions"] : [];
}

export type FederationBackendOperations = {
  getNavigationSnapshot(
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot>;
  /**
   * Optional for test doubles and non-desktop adapters. When absent, the RPC
   * handler is omitted so callers receive method_not_found and may use their
   * bounded legacy fallback without forcing a persistent owner refresh.
   */
  searchNavigationThreads?(
    request: FederationJumpSearchRequest,
  ): Promise<FederationJumpSearchResponse>;
  listThreads(
    request?: AppServerListThreadsRequest,
  ): Promise<AppServerListThreadsResponse>;
  resolveThread(request: ResolveThreadRequest): Promise<ResolveThreadResponse>;
  resolveThreadAdmissionState?(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadAdmissionState>;
  readThread(
    request: AppServerReadThreadRequest,
  ): Promise<AppServerReadThreadResponse>;
  analyzeThreadToolHistory(
    request: AnalyzeThreadToolHistoryRequest,
  ): Promise<AnalyzeThreadToolHistoryResponse>;
  readTranscriptImage(
    request: FederationReadTranscriptImageRequest,
  ): Promise<FederatedTranscriptImageResponse>;
  listSkills(
    request?: AppServerListSkillsRequest,
  ): Promise<AppServerListSkillsResponse>;
  listBackends(request?: ListBackendsRequest): Promise<ListBackendsResponse>;
  markThreadSeen(request: MarkThreadSeenRequest): Promise<MarkThreadSeenResponse>;
  setThreadReaction(
    request: SetThreadReactionRequest,
  ): Promise<SetThreadReactionResponse>;
  setThreadPin(request: SetThreadPinRequest): Promise<SetThreadPinResponse>;
  reorderThreadPins(
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse>;
  mountRemoteChild(
    request: FederationMountRemoteChildRequest,
  ): Promise<FederationMountRemoteChildResponse>;
  setThreadParent(
    request: SetThreadParentRequest,
  ): Promise<SetThreadParentResponse>;
  updateSubthreadOrder(
    request: UpdateSubthreadOrderRequest,
  ): Promise<UpdateSubthreadOrderResponse>;
  setSubthreadsCollapsed(
    request: SetSubthreadsCollapsedRequest,
  ): Promise<SetSubthreadsCollapsedResponse>;
  detachThreadPullRequest(
    request: DetachThreadPullRequestRequest,
  ): Promise<DetachThreadPullRequestResponse>;
  setThreadPrAutoDispatch(
    request: SetThreadPrAutoDispatchRequest,
  ): Promise<SetThreadPrAutoDispatchResponse>;
  cancelThreadPrAutoDispatch(
    request: CancelThreadPrAutoDispatchRequest,
  ): Promise<CancelThreadPrAutoDispatchResponse>;
  sendThreadPrAutoDispatchNow(
    request: SendThreadPrAutoDispatchNowRequest,
  ): Promise<SendThreadPrAutoDispatchNowResponse>;
  archiveThread(request: ArchiveThreadRequest): Promise<ArchiveThreadResponse>;
  startThread(request: StartThreadRequest): Promise<StartThreadResponse>;
  forkThread(
    request: ForkThreadRequest,
    options?: Pick<
      MaterializeDirectoryLaunchpadOptions,
      "onCodexEnvironmentSetupProgress"
    >,
  ): Promise<ForkThreadResponse>;
  startTurn(request: FederationStartTurnRequest): Promise<StartTurnResponse>;
  cancelQueuedTurn(
    request: CancelQueuedTurnRequest,
  ): Promise<CancelQueuedTurnResponse>;
  releaseQueuedTurn(
    request: ReleaseQueuedTurnRequest,
  ): Promise<ReleaseQueuedTurnResponse>;
  startReview(request: StartReviewRequest): Promise<StartReviewResponse>;
  listScheduledThreadActions(
    request?: ListScheduledThreadActionsRequest,
  ): Promise<ListScheduledThreadActionsResponse>;
  createScheduledThreadAction(
    request: CreateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  updateScheduledThreadAction(
    request: UpdateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  cancelScheduledThreadAction(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  sendScheduledThreadActionNow(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  compactThread(request: CompactThreadRequest): Promise<CompactThreadResponse>;
  listThreadMcpServers(
    request: ListThreadMcpServersRequest,
  ): Promise<ListThreadMcpServersResponse>;
  reloadCodexMcpConfig(
    request: ReloadCodexMcpConfigRequest,
  ): Promise<ReloadCodexMcpConfigResponse>;
  controlActiveTurn?(
    request: ControlActiveTurnRequest,
  ): Promise<ControlActiveTurnResponse>;
  resolveActiveTurn(
    request: ResolveActiveTurnRequest,
  ): Promise<ResolveActiveTurnResponse>;
  interruptTurn(request: InterruptTurnRequest): Promise<InterruptTurnResponse>;
  stopSubAgent(request: StopSubAgentRequest): Promise<StopSubAgentResponse>;
  steerTurn(request: SteerTurnRequest): Promise<SteerTurnResponse>;
  setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse>;
  queueThreadExecutionMode(
    request: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse>;
  cancelThreadExecutionModeQueue(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse>;
  setAcpSessionRuntimeOption(
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse>;
  setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse>;
  checkThreadBranchDrift(
    request: CheckThreadBranchDriftRequest,
  ): Promise<CheckThreadBranchDriftResponse>;
  updateThreadExpectedBranch(
    request: UpdateThreadExpectedBranchRequest,
  ): Promise<UpdateThreadExpectedBranchResponse>;
  retainThreadBranchDrift(
    request: RetainThreadBranchDriftRequest,
  ): Promise<RetainThreadBranchDriftResponse>;
  submitServerRequest(
    request: SubmitServerRequestRequest,
  ): Promise<SubmitServerRequestResponse>;
  runCodexEnvironmentAction(
    request: RunCodexEnvironmentActionRequest,
  ): Promise<RunCodexEnvironmentActionResponse>;
  stopCodexEnvironmentAction(
    request: StopCodexEnvironmentActionRequest,
  ): Promise<StopCodexEnvironmentActionResponse>;
  setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse>;
  refreshThreadPullRequests(
    request: FederationRefreshThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse>;
  refreshDirectoryGitStatuses(
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse>;
  ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse>;
  listRecentFileReferences(): Promise<ListRecentFileReferencesResponse>;
  recordRecentFileReferences(
    request: RecordRecentFileReferencesRequest,
  ): Promise<void>;
  listModelSettingsRecents(
    request: ListModelSettingsRecentsRequest,
  ): Promise<ListModelSettingsRecentsResponse>;
  recordModelSettingsRecent(
    request: RecordModelSettingsRecentRequest,
  ): Promise<void>;
  attachDirectoryToThread(
    request: AttachDirectoryToThreadRequest,
  ): Promise<AttachDirectoryToThreadResponse>;
  listWorktreeUnpublishedCommits(
    request: ListWorktreeUnpublishedCommitsRequest,
  ): Promise<ListWorktreeUnpublishedCommitsResponse>;
  getWorktreeUnpublishedCommitDiff(
    request: GetWorktreeUnpublishedCommitDiffRequest,
  ): Promise<GetWorktreeUnpublishedCommitDiffResponse>;
  materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions & {
      sourceInstanceId?: FederationInstanceId;
    },
  ): Promise<MaterializeDirectoryLaunchpadResponse>;
  handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse>;
  renameThread(request: RenameThreadRequest): Promise<RenameThreadResponse>;
  readApplications(): Promise<DesktopApplicationsSnapshot>;
  openApplication(
    request: OpenDesktopApplicationRequest,
  ): Promise<OpenDesktopApplicationResponse>;
  readMessagingPlatformStatuses(): Promise<MessagingPlatformStatus[]>;
  readPwrSnapConnectionStatus(): Promise<PwrSnapConnectionStatus>;
  getLoadStatus(): Promise<FederationLoadStatus>;
  trustCodexProject(
    request: TrustCodexProjectRequest,
  ): Promise<TrustCodexProjectResponse>;
  setCelestialIcon(
    request: SetCelestialIconRequest,
  ): Promise<SetCelestialIconResponse>;
  starMapIntake(
    request: FederationStarMapIntakeRequest,
  ): Promise<StarMapIntakeResponse>;
};

export function registerFederationBackendHandlers(params: {
  router: FederationRouter;
  backend: FederationBackendOperations;
  resolveSourceInstance?: (
    instanceId: string,
  ) => ResolvedSourceInstance | undefined;
  onEnvironmentSetupProgress?: (
    event: CodexEnvironmentSetupProgressEvent,
    targetInstanceId: string,
  ) => void;
  resolveTurnInput?: ResolveIncomingFederationTurnInput;
}): NavigationSnapshotTransport {
  const navigationSnapshotTransport = new NavigationSnapshotTransport({
    // Federation has one owner collection and one resource-version history.
    // Request selectors never create histories of their own.
    maxScopes: 1,
  });
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.getNavigationSnapshot,
    async (envelope) => {
      const request = (envelope.params ?? {}) as
        | GetNavigationSnapshotRequest
        | GetNavigationSnapshotTransportRequest;
      const transportRequest =
        "transport" in request && request.transport?.protocol === 1
          ? request
          : undefined;
      if (!transportRequest) {
        const { transport: _unsupportedTransport, ...snapshotRequest } =
          request as GetNavigationSnapshotRequest & {
            transport?: unknown;
          };
        return encodeNavigationSnapshotThreadKeysForProtocolV1(
          await params.backend.getNavigationSnapshot(snapshotRequest),
        );
      }
      const { transport, ...snapshotRequest } = transportRequest;
      const selection: NavigationSnapshotTransportSelection =
        transport.selection?.kind === "threads"
        && Array.isArray(transport.selection.threadKeys)
          ? {
              kind: "threads",
              threadKeys: transport.selection.threadKeys.filter(
                (key): key is string => typeof key === "string",
              ),
            }
          : { kind: "all" };
      const snapshot = encodeNavigationSnapshotThreadKeysForProtocolV1(
        // One canonical collection drives Federation resource versions.
        // Backend/filter/search are client-side lenses over that collection;
        // allowing them into this read would recreate per-query histories.
        await params.backend.getNavigationSnapshot({
          forceRefresh: snapshotRequest.forceRefresh,
          refreshMode: "full",
        }),
      );
      return navigationSnapshotTransport.encode({
        baseRevision: transport.baseRevision,
        request: {},
        scopeKey: "federation-navigation",
        selection,
        snapshot,
      });
    },
  );
  if (params.backend.searchNavigationThreads) {
    params.router.registerHandler(
      FEDERATION_BACKEND_METHODS.searchNavigationThreads,
      async (envelope) => {
        if (!params.backend.searchNavigationThreads) {
          throw new Error("Bounded navigation search became unavailable.");
        }
        return await params.backend.searchNavigationThreads(
          envelope.params as FederationJumpSearchRequest,
        );
      },
    );
  }
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listThreads,
    async (envelope) =>
      await params.backend.listThreads(
        (envelope.params ?? {}) as AppServerListThreadsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.resolveThread,
    async (envelope) =>
      await params.backend.resolveThread(
        envelope.params as ResolveThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.resolveThreadAdmissionState,
    async (envelope) => {
      if (!params.backend.resolveThreadAdmissionState) {
        throw new Error("Targeted thread admission state is unavailable.");
      }
      return await params.backend.resolveThreadAdmissionState(
        envelope.params as {
          backend: AppServerBackendKind;
          threadId: string;
        },
      );
    },
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.analyzeThreadToolHistory,
    async (envelope) =>
      await params.backend.analyzeThreadToolHistory(
        envelope.params as AnalyzeThreadToolHistoryRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.readThread,
    async (envelope) => {
      const request = envelope.params as AppServerReadThreadRequest;
      let response = await params.backend.readThread(request);

      // Federation needs the complete replay to mint reliable cursors for a
      // backend that does not expose native pagination. Some backends honor
      // before/limit while still reporting supportsPagination=false, so retry
      // without those bounds only after the bounded read proves that native
      // pagination is unavailable.
      if (
        !response.replay.pagination.supportsPagination
        && (request.before !== undefined || request.limit !== undefined)
      ) {
        const boundedReadDurationMs = response.readDurationMs;
        const {
          before: _before,
          limit: _limit,
          ...unpagedRequest
        } = request;
        response = await params.backend.readThread(unpagedRequest);
        if (typeof boundedReadDurationMs === "number") {
          response = {
            ...response,
            readDurationMs:
              boundedReadDurationMs + (response.readDurationMs ?? 0),
          };
        }
      }

      // Bound non-paginating replays before they reach the federation
      // transport's per-frame receive ceiling.
      //
      // The trim rewrites the page, so it can also invalidate the page's
      // cursor, and the id space that cursor lives in belongs to whoever paged
      // the replay. Paging it here makes it ours, resolved by entry id against
      // the merged replay on the way back in. Leaving an already-paged replay
      // alone leaves the cursor with the backend, whose own cursor need not be
      // a transcript entry id at all — Codex returns an opaque
      // `thread/turns/list` cursor. Either way this replay has overlay-owned
      // rows merged into it, and neither space can resolve one of those.
      const alreadyPaged = response.replay.pagination.supportsPagination;
      const pagedReplay = alreadyPaged
        ? response.replay
        : pageNormalizedReplay(response.replay, request);
      const replay = fitNormalizedReplayWithinByteBudget({
        // `response.backend` rather than `request.backend`: the request field
        // is optional and the remote forwarding path passes it through
        // undefined, while the response always names the backend the owner
        // actually read with.
        cursorIdSpace: alreadyPaged
          ? threadReplayCursorIdSpace(response.backend)
          : "entry-id",
        replay: pagedReplay,
        maxBytes: FEDERATION_RESPONSE_BYTE_BUDGET,
        measureBytes: (candidate) =>
          Buffer.byteLength(
            JSON.stringify({ ...response, replay: candidate }),
            "utf8",
          ),
      });
      return { ...response, replay };
    },
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.readTranscriptImage,
    async (envelope) =>
      await params.backend.readTranscriptImage(
        envelope.params as FederationReadTranscriptImageRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listSkills,
    async (envelope) =>
      await params.backend.listSkills(
        (envelope.params ?? {}) as AppServerListSkillsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listBackends,
    async (envelope) =>
      await params.backend.listBackends(
        (envelope.params ?? {}) as ListBackendsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.markThreadSeen,
    async (envelope) =>
      await params.backend.markThreadSeen(
        envelope.params as MarkThreadSeenRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadReaction,
    async (envelope) =>
      await params.backend.setThreadReaction(
        envelope.params as SetThreadReactionRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadPin,
    async (envelope) =>
      await params.backend.setThreadPin(
        envelope.params as SetThreadPinRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.reorderThreadPins,
    async (envelope) =>
      await params.backend.reorderThreadPins(
        envelope.params as ReorderThreadPinsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.mountRemoteChild,
    async (envelope) =>
      await params.backend.mountRemoteChild(
        envelope.params as FederationMountRemoteChildRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadParent,
    async (envelope) =>
      await params.backend.setThreadParent(
        envelope.params as SetThreadParentRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.updateSubthreadOrder,
    async (envelope) =>
      await params.backend.updateSubthreadOrder(
        envelope.params as UpdateSubthreadOrderRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setSubthreadsCollapsed,
    async (envelope) =>
      await params.backend.setSubthreadsCollapsed(
        envelope.params as SetSubthreadsCollapsedRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.detachThreadPullRequest,
    async (envelope) =>
      await params.backend.detachThreadPullRequest(
        envelope.params as DetachThreadPullRequestRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadPrAutoDispatch,
    async (envelope) =>
      await params.backend.setThreadPrAutoDispatch(
        envelope.params as SetThreadPrAutoDispatchRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.cancelThreadPrAutoDispatch,
    async (envelope) =>
      await params.backend.cancelThreadPrAutoDispatch(
        envelope.params as CancelThreadPrAutoDispatchRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.sendThreadPrAutoDispatchNow,
    async (envelope) =>
      await params.backend.sendThreadPrAutoDispatchNow(
        envelope.params as SendThreadPrAutoDispatchNowRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.archiveThread,
    async (envelope) =>
      await params.backend.archiveThread(
        envelope.params as ArchiveThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.startThread,
    async (envelope) =>
      await params.backend.startThread(
        envelope.params as StartThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.forkThread,
    async (envelope) =>
      await params.backend.forkThread(
        envelope.params as ForkThreadRequest,
        {
          onCodexEnvironmentSetupProgress: (event) => {
            params.onEnvironmentSetupProgress?.(
              event,
              envelope.sourceInstanceId,
            );
          },
        },
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.startTurn,
    async (envelope) => {
      const request = envelope.params as Omit<
        FederationStartTurnRequest,
        "input"
      > & { input: FederationWireTurnInputItem[] };
      const messageOrigin = authenticateMessageOrigin({
        messageOrigin: request.messageOrigin,
        resolveSourceInstance: params.resolveSourceInstance,
        sourceInstanceId: envelope.sourceInstanceId,
      });
      const input = await resolveFederationTurnInput(
        params.resolveTurnInput,
        request.input,
        envelope.sourceInstanceId,
      );
      return await params.backend.startTurn({
        ...request,
        input,
        ...(messageOrigin ? { messageOrigin } : {}),
      });
    },
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.cancelQueuedTurn,
    async (envelope) =>
      await params.backend.cancelQueuedTurn(
        envelope.params as CancelQueuedTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.releaseQueuedTurn,
    async (envelope) =>
      await params.backend.releaseQueuedTurn(
        envelope.params as ReleaseQueuedTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.startReview,
    async (envelope) =>
      await params.backend.startReview(
        envelope.params as StartReviewRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listScheduledThreadActions,
    async (envelope) =>
      await params.backend.listScheduledThreadActions(
        (envelope.params ?? {}) as ListScheduledThreadActionsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.createScheduledThreadAction,
    async (envelope) => {
      const request = envelope.params as CreateScheduledThreadActionRequest;
      return await params.backend.createScheduledThreadAction(
        authenticateScheduledTurnOrigin({
          request,
          resolveSourceInstance: params.resolveSourceInstance,
          sourceInstanceId: envelope.sourceInstanceId,
        }),
      );
    },
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.updateScheduledThreadAction,
    async (envelope) => {
      const request = envelope.params as UpdateScheduledThreadActionRequest;
      return await params.backend.updateScheduledThreadAction(
        authenticateScheduledTurnOrigin({
          request,
          resolveSourceInstance: params.resolveSourceInstance,
          sourceInstanceId: envelope.sourceInstanceId,
        }),
      );
    },
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.cancelScheduledThreadAction,
    async (envelope) =>
      await params.backend.cancelScheduledThreadAction(
        envelope.params as ScheduledThreadActionIdRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.sendScheduledThreadActionNow,
    async (envelope) =>
      await params.backend.sendScheduledThreadActionNow(
        envelope.params as ScheduledThreadActionIdRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.compactThread,
    async (envelope) =>
      await params.backend.compactThread(
        envelope.params as CompactThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listThreadMcpServers,
    async (envelope) =>
      await params.backend.listThreadMcpServers(
        envelope.params as ListThreadMcpServersRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.reloadCodexMcpConfig,
    async (envelope) =>
      await params.backend.reloadCodexMcpConfig(
        envelope.params as ReloadCodexMcpConfigRequest,
      ),
  );
  if (params.backend.controlActiveTurn) {
    params.router.registerHandler(
      FEDERATION_BACKEND_METHODS.controlActiveTurn,
      async (envelope) => {
        const {
          input: wireInput,
          ...request
        } = envelope.params as FederationWireControlActiveTurnRequest;
        const messageOrigin = authenticateMessageOrigin({
          messageOrigin: request.messageOrigin,
          resolveSourceInstance: params.resolveSourceInstance,
          sourceInstanceId: envelope.sourceInstanceId,
        });
        const input = wireInput
          ? await resolveFederationTurnInput(
              params.resolveTurnInput,
              wireInput,
              envelope.sourceInstanceId,
            )
          : undefined;
        return await params.backend.controlActiveTurn!({
          ...request,
          ...(input ? { input } : {}),
          ...(messageOrigin ? { messageOrigin } : {}),
        });
      },
    );
  }
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.resolveActiveTurn,
    async (envelope) =>
      await params.backend.resolveActiveTurn(
        envelope.params as ResolveActiveTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.interruptTurn,
    async (envelope) =>
      await params.backend.interruptTurn(
        envelope.params as InterruptTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.stopSubAgent,
    async (envelope) =>
      await params.backend.stopSubAgent(
        envelope.params as StopSubAgentRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.steerTurn,
    async (envelope) =>
      await params.backend.steerTurn(
        envelope.params as SteerTurnRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadExecutionMode,
    async (envelope) =>
      await params.backend.setThreadExecutionMode(
        envelope.params as SetThreadExecutionModeRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.queueThreadExecutionMode,
    async (envelope) =>
      await params.backend.queueThreadExecutionMode(
        envelope.params as QueueThreadExecutionModeRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.cancelThreadExecutionModeQueue,
    async (envelope) =>
      await params.backend.cancelThreadExecutionModeQueue(
        envelope.params as CancelThreadExecutionModeQueueRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setAcpSessionRuntimeOption,
    async (envelope) =>
      await params.backend.setAcpSessionRuntimeOption(
        envelope.params as SetAcpSessionRuntimeOptionRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setThreadModelSettings,
    async (envelope) =>
      await params.backend.setThreadModelSettings(
        envelope.params as SetThreadModelSettingsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.checkThreadBranchDrift,
    async (envelope) =>
      await params.backend.checkThreadBranchDrift(
        envelope.params as CheckThreadBranchDriftRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.updateThreadExpectedBranch,
    async (envelope) =>
      await params.backend.updateThreadExpectedBranch(
        envelope.params as UpdateThreadExpectedBranchRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.retainThreadBranchDrift,
    async (envelope) =>
      await params.backend.retainThreadBranchDrift(
        envelope.params as RetainThreadBranchDriftRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.submitServerRequest,
    async (envelope) =>
      await params.backend.submitServerRequest(
        envelope.params as SubmitServerRequestRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction,
    async (envelope) =>
      await params.backend.runCodexEnvironmentAction(
        envelope.params as RunCodexEnvironmentActionRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.stopCodexEnvironmentAction,
    async (envelope) =>
      await params.backend.stopCodexEnvironmentAction(
        envelope.params as StopCodexEnvironmentActionRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
    async (envelope) =>
      await params.backend.setCodexThreadEnvironment(
        envelope.params as SetCodexThreadEnvironmentRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.refreshThreadPullRequests,
    async (envelope) =>
      await params.backend.refreshThreadPullRequests(
        localizeRefreshThreadPullRequestsRequest(
          envelope.params as RefreshOwnedThreadPullRequestsRequest,
        ),
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.refreshDirectoryGitStatuses,
    async (envelope) =>
      await params.backend.refreshDirectoryGitStatuses(
        envelope.params as RefreshDirectoryGitStatusesRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.ensureDirectoryLaunchpad,
    async (envelope) =>
      await params.backend.ensureDirectoryLaunchpad(
        envelope.params as EnsureDirectoryLaunchpadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listRecentFileReferences,
    async () => await params.backend.listRecentFileReferences(),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.recordRecentFileReferences,
    async (envelope) =>
      await params.backend.recordRecentFileReferences(
        envelope.params as RecordRecentFileReferencesRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listModelSettingsRecents,
    async (envelope) =>
      await params.backend.listModelSettingsRecents(
        envelope.params as ListModelSettingsRecentsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.recordModelSettingsRecent,
    async (envelope) =>
      await params.backend.recordModelSettingsRecent(
        envelope.params as RecordModelSettingsRecentRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.attachDirectoryToThread,
    async (envelope) =>
      await params.backend.attachDirectoryToThread(
        envelope.params as AttachDirectoryToThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.listWorktreeUnpublishedCommits,
    async (envelope) =>
      await params.backend.listWorktreeUnpublishedCommits(
        envelope.params as ListWorktreeUnpublishedCommitsRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.getWorktreeUnpublishedCommitDiff,
    async (envelope) =>
      await params.backend.getWorktreeUnpublishedCommitDiff(
        envelope.params as GetWorktreeUnpublishedCommitDiffRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad,
    async (envelope) => {
      const {
        messageOrigin: claimedMessageOrigin,
        input: wireInput,
        ...request
      } = envelope.params as FederationMaterializeDirectoryLaunchpadRequest;
      const messageOrigin = authenticateMessageOrigin({
        messageOrigin: claimedMessageOrigin,
        resolveSourceInstance: params.resolveSourceInstance,
        sourceInstanceId: envelope.sourceInstanceId,
      });
      const input = wireInput
        ? await resolveFederationTurnInput(
            params.resolveTurnInput,
            wireInput,
            envelope.sourceInstanceId,
          )
        : undefined;
      return await params.backend.materializeDirectoryLaunchpad(
        {
          ...request,
          ...(input ? { input } : {}),
        },
        {
          ...(messageOrigin ? { messageOrigin } : {}),
          sourceInstanceId: envelope.sourceInstanceId,
          onCodexEnvironmentSetupProgress: (event) => {
            params.onEnvironmentSetupProgress?.(
              event,
              envelope.sourceInstanceId,
            );
          },
        },
      );
    },
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.handoffThreadWorkspace,
    async (envelope) =>
      await params.backend.handoffThreadWorkspace(
        envelope.params as HandoffThreadWorkspaceRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.renameThread,
    async (envelope) =>
      await params.backend.renameThread(
        envelope.params as RenameThreadRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.readApplications,
    async () => await params.backend.readApplications(),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.readMessagingPlatformStatuses,
    async () => await params.backend.readMessagingPlatformStatuses(),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.readPwrSnapConnectionStatus,
    async () => await params.backend.readPwrSnapConnectionStatus(),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.getLoadStatus,
    async () => await params.backend.getLoadStatus(),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.openApplication,
    async (envelope) =>
      await params.backend.openApplication(
        envelope.params as OpenDesktopApplicationRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.trustCodexProject,
    async (envelope) =>
      await params.backend.trustCodexProject(
        envelope.params as TrustCodexProjectRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.setCelestialIcon,
    async (envelope) =>
      await params.backend.setCelestialIcon(
        envelope.params as SetCelestialIconRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_BACKEND_METHODS.starMapIntake,
    async (envelope) => {
      const {
        attachments: wireAttachments,
        ...request
      } = envelope.params as FederationWireStarMapIntakeRequest;
      const attachments = wireAttachments
        ? await resolveFederationTurnInput(
            params.resolveTurnInput,
            wireAttachments,
            envelope.sourceInstanceId,
          )
        : undefined;
      if (
        attachments?.some(
          (item) => item.type !== "localImage" && item.type !== "localFile",
        )
      ) {
        throw new Error(
          "Star Map intake attachments must resolve to staged local inputs.",
        );
      }
      return await params.backend.starMapIntake({
        ...request,
        ...(attachments
          ? {
              attachments:
                attachments as FederationStarMapIntakeAttachment[],
            }
          : {}),
      });
    },
  );
  return navigationSnapshotTransport;
}

export class FederationRemoteBackendClient implements FederationBackendOperations {
  constructor(
    private readonly rpc: FederationRpcEndpoint,
    private readonly transformReadThreadResponse: (
      response: AppServerReadThreadResponse,
    ) =>
      | AppServerReadThreadResponse
      | Promise<AppServerReadThreadResponse> = (response) => response,
    private readonly prepareTurnInput?: PrepareOutgoingFederationTurnInput,
  ) {}

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    return normalizeNavigationSnapshotThreadKeys(
      await this.rpc.request<NavigationSnapshot>({
        method: FEDERATION_BACKEND_METHODS.getNavigationSnapshot,
        params: request,
      }),
    );
  }

  async getNavigationSnapshotTransport(
    request: GetNavigationSnapshotTransportRequest,
  ): Promise<NavigationSnapshot | NavigationSnapshotTransportResponse> {
    return await this.rpc.request<
      NavigationSnapshot | NavigationSnapshotTransportResponse
    >({
      method: FEDERATION_BACKEND_METHODS.getNavigationSnapshot,
      params: request,
    });
  }

  async searchNavigationThreads(
    request: FederationJumpSearchRequest,
  ): Promise<FederationJumpSearchResponse> {
    return await this.rpc.request<FederationJumpSearchResponse>({
      method: FEDERATION_BACKEND_METHODS.searchNavigationThreads,
      params: request,
    });
  }

  async listThreads(
    request: AppServerListThreadsRequest = {},
  ): Promise<AppServerListThreadsResponse> {
    return await this.rpc.request<AppServerListThreadsResponse>({
      method: FEDERATION_BACKEND_METHODS.listThreads,
      params: request,
    });
  }

  async resolveThread(
    request: ResolveThreadRequest,
  ): Promise<ResolveThreadResponse> {
    return await this.rpc.request<ResolveThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.resolveThread,
      params: request,
    });
  }

  async resolveThreadAdmissionState(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadAdmissionState> {
    return await this.rpc.request<ThreadAdmissionState>({
      method: FEDERATION_BACKEND_METHODS.resolveThreadAdmissionState,
      params: request,
    });
  }

  async readThread(
    request: AppServerReadThreadRequest,
  ): Promise<AppServerReadThreadResponse> {
    const response = await this.rpc.request<AppServerReadThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.readThread,
      params: request,
    });
    return await this.transformReadThreadResponse(response);
  }

  async analyzeThreadToolHistory(
    request: AnalyzeThreadToolHistoryRequest,
  ): Promise<AnalyzeThreadToolHistoryResponse> {
    return await this.rpc.request<AnalyzeThreadToolHistoryResponse>({
      method: FEDERATION_BACKEND_METHODS.analyzeThreadToolHistory,
      params: request,
    });
  }

  async readTranscriptImage(
    request: FederationReadTranscriptImageRequest,
  ): Promise<FederatedTranscriptImageResponse> {
    return await this.rpc.request<FederatedTranscriptImageResponse>({
      method: FEDERATION_BACKEND_METHODS.readTranscriptImage,
      params: request,
    });
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<AppServerListSkillsResponse> {
    return await this.rpc.request<AppServerListSkillsResponse>({
      method: FEDERATION_BACKEND_METHODS.listSkills,
      params: request,
    });
  }

  async listBackends(
    request: ListBackendsRequest = {},
  ): Promise<ListBackendsResponse> {
    return await this.rpc.request<ListBackendsResponse>({
      method: FEDERATION_BACKEND_METHODS.listBackends,
      params: request,
    });
  }

  async archiveThread(
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> {
    return await this.rpc.request<ArchiveThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.archiveThread,
      params: request,
    });
  }

  async setThreadPin(
    request: SetThreadPinRequest,
  ): Promise<SetThreadPinResponse> {
    return await this.rpc.request<SetThreadPinResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadPin,
      params: request,
    });
  }

  async setThreadReaction(
    request: SetThreadReactionRequest,
  ): Promise<SetThreadReactionResponse> {
    return await this.rpc.request<SetThreadReactionResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadReaction,
      params: request,
    });
  }

  async reorderThreadPins(
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse> {
    return await this.rpc.request<ReorderThreadPinsResponse>({
      method: FEDERATION_BACKEND_METHODS.reorderThreadPins,
      params: request,
    });
  }

  async mountRemoteChild(
    request: FederationMountRemoteChildRequest,
  ): Promise<FederationMountRemoteChildResponse> {
    return await this.rpc.request<FederationMountRemoteChildResponse>({
      method: FEDERATION_BACKEND_METHODS.mountRemoteChild,
      params: request,
    });
  }

  async setThreadParent(
    request: SetThreadParentRequest,
  ): Promise<SetThreadParentResponse> {
    return await this.rpc.request<SetThreadParentResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadParent,
      params: request,
    });
  }

  async updateSubthreadOrder(
    request: UpdateSubthreadOrderRequest,
  ): Promise<UpdateSubthreadOrderResponse> {
    return await this.rpc.request<UpdateSubthreadOrderResponse>({
      method: FEDERATION_BACKEND_METHODS.updateSubthreadOrder,
      params: request,
    });
  }

  async setSubthreadsCollapsed(
    request: SetSubthreadsCollapsedRequest,
  ): Promise<SetSubthreadsCollapsedResponse> {
    return await this.rpc.request<SetSubthreadsCollapsedResponse>({
      method: FEDERATION_BACKEND_METHODS.setSubthreadsCollapsed,
      params: request,
    });
  }

  async markThreadSeen(
    request: MarkThreadSeenRequest,
  ): Promise<MarkThreadSeenResponse> {
    return await this.rpc.request<MarkThreadSeenResponse>({
      method: FEDERATION_BACKEND_METHODS.markThreadSeen,
      params: request,
    });
  }

  async detachThreadPullRequest(
    request: DetachThreadPullRequestRequest,
  ): Promise<DetachThreadPullRequestResponse> {
    return await this.rpc.request<DetachThreadPullRequestResponse>({
      method: FEDERATION_BACKEND_METHODS.detachThreadPullRequest,
      params: request,
    });
  }

  async setThreadPrAutoDispatch(
    request: SetThreadPrAutoDispatchRequest,
  ): Promise<SetThreadPrAutoDispatchResponse> {
    return await this.rpc.request<SetThreadPrAutoDispatchResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadPrAutoDispatch,
      params: request,
    });
  }

  async cancelThreadPrAutoDispatch(
    request: CancelThreadPrAutoDispatchRequest,
  ): Promise<CancelThreadPrAutoDispatchResponse> {
    return await this.rpc.request<CancelThreadPrAutoDispatchResponse>({
      method: FEDERATION_BACKEND_METHODS.cancelThreadPrAutoDispatch,
      params: request,
    });
  }

  async sendThreadPrAutoDispatchNow(
    request: SendThreadPrAutoDispatchNowRequest,
  ): Promise<SendThreadPrAutoDispatchNowResponse> {
    return await this.rpc.request<SendThreadPrAutoDispatchNowResponse>({
      method: FEDERATION_BACKEND_METHODS.sendThreadPrAutoDispatchNow,
      params: request,
    });
  }

  async startThread(request: StartThreadRequest): Promise<StartThreadResponse> {
    return await this.rpc.request<StartThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.startThread,
      params: request,
    });
  }

  async forkThread(request: ForkThreadRequest): Promise<ForkThreadResponse> {
    return await this.rpc.request<ForkThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.forkThread,
      params: request,
    });
  }

  async startTurn(
    request: FederationStartTurnRequest,
  ): Promise<StartTurnResponse> {
    const input = this.prepareTurnInput
      ? await this.prepareTurnInput(request.input)
      : request.input;
    return await this.rpc.request<StartTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.startTurn,
      params: { ...request, input },
    });
  }

  async startReview(request: StartReviewRequest): Promise<StartReviewResponse> {
    return await this.rpc.request<StartReviewResponse>({
      method: FEDERATION_BACKEND_METHODS.startReview,
      params: request,
    });
  }

  async cancelQueuedTurn(
    request: CancelQueuedTurnRequest,
  ): Promise<CancelQueuedTurnResponse> {
    return await this.rpc.request<CancelQueuedTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.cancelQueuedTurn,
      params: request,
    });
  }

  async releaseQueuedTurn(
    request: ReleaseQueuedTurnRequest,
  ): Promise<ReleaseQueuedTurnResponse> {
    return await this.rpc.request<ReleaseQueuedTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.releaseQueuedTurn,
      params: request,
    });
  }

  async listScheduledThreadActions(
    request: ListScheduledThreadActionsRequest = {},
  ): Promise<ListScheduledThreadActionsResponse> {
    return await this.rpc.request<ListScheduledThreadActionsResponse>({
      method: FEDERATION_BACKEND_METHODS.listScheduledThreadActions,
      params: request,
    });
  }

  async createScheduledThreadAction(
    request: CreateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    return await this.rpc.request<ScheduledThreadActionMutationResponse>({
      method: FEDERATION_BACKEND_METHODS.createScheduledThreadAction,
      params: request,
    });
  }

  async updateScheduledThreadAction(
    request: UpdateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    return await this.rpc.request<ScheduledThreadActionMutationResponse>({
      method: FEDERATION_BACKEND_METHODS.updateScheduledThreadAction,
      params: request,
    });
  }

  async cancelScheduledThreadAction(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    return await this.rpc.request<ScheduledThreadActionMutationResponse>({
      method: FEDERATION_BACKEND_METHODS.cancelScheduledThreadAction,
      params: request,
    });
  }

  async sendScheduledThreadActionNow(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    return await this.rpc.request<ScheduledThreadActionMutationResponse>({
      method: FEDERATION_BACKEND_METHODS.sendScheduledThreadActionNow,
      params: request,
    });
  }

  async compactThread(
    request: CompactThreadRequest,
  ): Promise<CompactThreadResponse> {
    return await this.rpc.request<CompactThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.compactThread,
      params: request,
    });
  }

  async listThreadMcpServers(
    request: ListThreadMcpServersRequest,
  ): Promise<ListThreadMcpServersResponse> {
    return await this.rpc.request<ListThreadMcpServersResponse>({
      method: FEDERATION_BACKEND_METHODS.listThreadMcpServers,
      params: request,
    });
  }

  async reloadCodexMcpConfig(
    request: ReloadCodexMcpConfigRequest,
  ): Promise<ReloadCodexMcpConfigResponse> {
    return await this.rpc.request<ReloadCodexMcpConfigResponse>({
      method: FEDERATION_BACKEND_METHODS.reloadCodexMcpConfig,
      params: request,
    });
  }

  async controlActiveTurn(
    request: ControlActiveTurnRequest,
  ): Promise<ControlActiveTurnResponse> {
    const input = request.input && this.prepareTurnInput
      ? await this.prepareTurnInput(request.input)
      : request.input;
    return await this.rpc.request<ControlActiveTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.controlActiveTurn,
      params: { ...request, ...(input ? { input } : {}) },
    });
  }

  async resolveActiveTurn(
    request: ResolveActiveTurnRequest,
  ): Promise<ResolveActiveTurnResponse> {
    return await this.rpc.request<ResolveActiveTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.resolveActiveTurn,
      params: request,
    });
  }

  async interruptTurn(
    request: InterruptTurnRequest,
  ): Promise<InterruptTurnResponse> {
    return await this.rpc.request<InterruptTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.interruptTurn,
      params: request,
    });
  }

  async stopSubAgent(
    request: StopSubAgentRequest,
  ): Promise<StopSubAgentResponse> {
    return await this.rpc.request<StopSubAgentResponse>({
      method: FEDERATION_BACKEND_METHODS.stopSubAgent,
      params: request,
    });
  }

  async steerTurn(request: SteerTurnRequest): Promise<SteerTurnResponse> {
    return await this.rpc.request<SteerTurnResponse>({
      method: FEDERATION_BACKEND_METHODS.steerTurn,
      params: request,
    });
  }

  async setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse> {
    return await this.rpc.request<SetThreadExecutionModeResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadExecutionMode,
      params: request,
    });
  }

  async queueThreadExecutionMode(
    request: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse> {
    return await this.rpc.request<QueueThreadExecutionModeResponse>({
      method: FEDERATION_BACKEND_METHODS.queueThreadExecutionMode,
      params: request,
    });
  }

  async cancelThreadExecutionModeQueue(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    return await this.rpc.request<CancelThreadExecutionModeQueueResponse>({
      method: FEDERATION_BACKEND_METHODS.cancelThreadExecutionModeQueue,
      params: request,
    });
  }

  async setAcpSessionRuntimeOption(
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    return await this.rpc.request<SetAcpSessionRuntimeOptionResponse>({
      method: FEDERATION_BACKEND_METHODS.setAcpSessionRuntimeOption,
      params: request,
    });
  }

  async setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse> {
    return await this.rpc.request<SetThreadModelSettingsResponse>({
      method: FEDERATION_BACKEND_METHODS.setThreadModelSettings,
      params: request,
    });
  }

  async checkThreadBranchDrift(
    request: CheckThreadBranchDriftRequest,
  ): Promise<CheckThreadBranchDriftResponse> {
    return await this.rpc.request<CheckThreadBranchDriftResponse>({
      method: FEDERATION_BACKEND_METHODS.checkThreadBranchDrift,
      params: request,
    });
  }

  async updateThreadExpectedBranch(
    request: UpdateThreadExpectedBranchRequest,
  ): Promise<UpdateThreadExpectedBranchResponse> {
    return await this.rpc.request<UpdateThreadExpectedBranchResponse>({
      method: FEDERATION_BACKEND_METHODS.updateThreadExpectedBranch,
      params: request,
    });
  }

  async retainThreadBranchDrift(
    request: RetainThreadBranchDriftRequest,
  ): Promise<RetainThreadBranchDriftResponse> {
    return await this.rpc.request<RetainThreadBranchDriftResponse>({
      method: FEDERATION_BACKEND_METHODS.retainThreadBranchDrift,
      params: request,
    });
  }

  async submitServerRequest(
    request: SubmitServerRequestRequest,
  ): Promise<SubmitServerRequestResponse> {
    return await this.rpc.request<SubmitServerRequestResponse>({
      method: FEDERATION_BACKEND_METHODS.submitServerRequest,
      params: request,
    });
  }

  async runCodexEnvironmentAction(
    request: RunCodexEnvironmentActionRequest,
  ): Promise<RunCodexEnvironmentActionResponse> {
    return await this.rpc.request<RunCodexEnvironmentActionResponse>({
      method: FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction,
      params: request,
    });
  }

  async stopCodexEnvironmentAction(
    request: StopCodexEnvironmentActionRequest,
  ): Promise<StopCodexEnvironmentActionResponse> {
    return await this.rpc.request<StopCodexEnvironmentActionResponse>({
      method: FEDERATION_BACKEND_METHODS.stopCodexEnvironmentAction,
      params: request,
    });
  }

  async setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse> {
    return await this.rpc.request<SetCodexThreadEnvironmentResponse>({
      method: FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
      params: request,
    });
  }

  async refreshDirectoryGitStatuses(
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse> {
    return await this.rpc.request<RefreshDirectoryGitStatusesResponse>({
      method: FEDERATION_BACKEND_METHODS.refreshDirectoryGitStatuses,
      params: request,
    });
  }

  async refreshThreadPullRequests(
    request: FederationRefreshThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> {
    return await this.rpc.request<RefreshThreadPullRequestsResponse>({
      method: FEDERATION_BACKEND_METHODS.refreshThreadPullRequests,
      params: request,
    });
  }

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    return await this.rpc.request<EnsureDirectoryLaunchpadResponse>({
      method: FEDERATION_BACKEND_METHODS.ensureDirectoryLaunchpad,
      params: request,
    });
  }

  async listRecentFileReferences(): Promise<ListRecentFileReferencesResponse> {
    return await this.rpc.request<ListRecentFileReferencesResponse>({
      method: FEDERATION_BACKEND_METHODS.listRecentFileReferences,
      params: {},
    });
  }

  async recordRecentFileReferences(
    request: RecordRecentFileReferencesRequest,
  ): Promise<void> {
    await this.rpc.request<void>({
      method: FEDERATION_BACKEND_METHODS.recordRecentFileReferences,
      params: request,
    });
  }

  async listModelSettingsRecents(
    request: ListModelSettingsRecentsRequest,
  ): Promise<ListModelSettingsRecentsResponse> {
    return await this.rpc.request<ListModelSettingsRecentsResponse>({
      method: FEDERATION_BACKEND_METHODS.listModelSettingsRecents,
      params: request,
    });
  }

  async recordModelSettingsRecent(
    request: RecordModelSettingsRecentRequest,
  ): Promise<void> {
    await this.rpc.request<void>({
      method: FEDERATION_BACKEND_METHODS.recordModelSettingsRecent,
      params: request,
    });
  }

  async attachDirectoryToThread(
    request: AttachDirectoryToThreadRequest,
  ): Promise<AttachDirectoryToThreadResponse> {
    return await this.rpc.request<AttachDirectoryToThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.attachDirectoryToThread,
      params: request,
    });
  }

  async listWorktreeUnpublishedCommits(
    request: ListWorktreeUnpublishedCommitsRequest,
  ): Promise<ListWorktreeUnpublishedCommitsResponse> {
    return await this.rpc.request<ListWorktreeUnpublishedCommitsResponse>({
      method: FEDERATION_BACKEND_METHODS.listWorktreeUnpublishedCommits,
      params: request,
    });
  }

  async getWorktreeUnpublishedCommitDiff(
    request: GetWorktreeUnpublishedCommitDiffRequest,
  ): Promise<GetWorktreeUnpublishedCommitDiffResponse> {
    return await this.rpc.request<GetWorktreeUnpublishedCommitDiffResponse>({
      method: FEDERATION_BACKEND_METHODS.getWorktreeUnpublishedCommitDiff,
      params: request,
    });
  }

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    const input = request.input && this.prepareTurnInput
      ? await this.prepareTurnInput(request.input)
      : request.input;
    return await this.rpc.request<MaterializeDirectoryLaunchpadResponse>({
      method: FEDERATION_BACKEND_METHODS.materializeDirectoryLaunchpad,
      params: {
        ...request,
        ...(input ? { input } : {}),
        ...(options?.messageOrigin
          ? { messageOrigin: options.messageOrigin }
          : {}),
      } satisfies FederationMaterializeDirectoryLaunchpadRequest,
    });
  }

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    return await this.rpc.request<HandoffThreadWorkspaceResponse>({
      method: FEDERATION_BACKEND_METHODS.handoffThreadWorkspace,
      params: request,
    });
  }

  async renameThread(
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> {
    return await this.rpc.request<RenameThreadResponse>({
      method: FEDERATION_BACKEND_METHODS.renameThread,
      params: request,
    });
  }

  async openApplication(
    request: OpenDesktopApplicationRequest,
  ): Promise<OpenDesktopApplicationResponse> {
    return await this.rpc.request<OpenDesktopApplicationResponse>({
      method: FEDERATION_BACKEND_METHODS.openApplication,
      params: request,
    });
  }

  async readApplications(): Promise<DesktopApplicationsSnapshot> {
    return await this.rpc.request<DesktopApplicationsSnapshot>({
      method: FEDERATION_BACKEND_METHODS.readApplications,
      params: {},
    });
  }

  async readMessagingPlatformStatuses(): Promise<MessagingPlatformStatus[]> {
    return await this.rpc.request<MessagingPlatformStatus[]>({
      method: FEDERATION_BACKEND_METHODS.readMessagingPlatformStatuses,
      params: {},
    });
  }

  async readPwrSnapConnectionStatus(): Promise<PwrSnapConnectionStatus> {
    return await this.rpc.request<PwrSnapConnectionStatus>({
      method: FEDERATION_BACKEND_METHODS.readPwrSnapConnectionStatus,
      params: {},
    });
  }

  async getLoadStatus(): Promise<FederationLoadStatus> {
    return await this.rpc.request<FederationLoadStatus>({
      method: FEDERATION_BACKEND_METHODS.getLoadStatus,
      params: {},
      timeoutMs: FEDERATION_LOAD_STATUS_TIMEOUT_MS,
    });
  }

  async trustCodexProject(
    request: TrustCodexProjectRequest,
  ): Promise<TrustCodexProjectResponse> {
    return await this.rpc.request<TrustCodexProjectResponse>({
      method: FEDERATION_BACKEND_METHODS.trustCodexProject,
      params: request,
    });
  }

  async setCelestialIcon(
    request: SetCelestialIconRequest,
  ): Promise<SetCelestialIconResponse> {
    return await this.rpc.request<SetCelestialIconResponse>({
      method: FEDERATION_BACKEND_METHODS.setCelestialIcon,
      params: request,
    });
  }

  async starMapIntake(
    request: FederationStarMapIntakeRequest,
  ): Promise<StarMapIntakeResponse> {
    const attachments = request.attachments && this.prepareTurnInput
      ? await this.prepareTurnInput(
          request.attachments as AppServerTurnInputItem[],
        )
      : request.attachments;
    return await this.rpc.request<StarMapIntakeResponse>({
      method: FEDERATION_BACKEND_METHODS.starMapIntake,
      params: {
        ...request,
        ...(attachments ? { attachments } : {}),
      } satisfies FederationWireStarMapIntakeRequest,
      // Resolution + thread materialization can outlive the default 30s
      // (Grok call + worktree preparation), so give intake a longer leash.
      timeoutMs: 120_000,
    });
  }
}
