import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerThreadMessageOrigin,
  AppServerThreadStatus,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  CreateScheduledThreadActionRequest,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  GetNavigationSnapshotRequest,
  FederationTarget,
  FederatedThreadRef,
  FederationInstanceId,
  ListBackendsRequest,
  ListBackendsResponse,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  MaterializeDirectoryLaunchpadOptions,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationQueryRequest,
  NavigationQueryPage,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
  NavigationLaunchpadConfigRequest,
  NavigationLaunchpadConfigResponse,
  NavigationSnapshot,
  NavigationThreadSummary,
  SetAcpSessionRuntimeOptionRequest,
  SetAcpSessionRuntimeOptionResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartReviewRequest,
  StartReviewResponse,
  StartTurnRequest,
  StartTurnResponse,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  ThreadAgentMetadata,
  ThreadAdmissionState,
  ThreadMessagingBindingTransition,
  UpdateScheduledThreadActionRequest,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
} from "@pwragent/shared";
import type {
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingRateLimitInfo,
  MessagingAttachmentDownloadRequest,
  MessagingAttachmentDownloadResult,
  MessagingCapabilityProfile,
  MessagingDirectorySearchRequest,
  MessagingDirectorySearchResult,
  MessagingClientRateLimitStrategy,
  MessagingInboundEvent,
  MessagingImagePart,
  MessagingAdapterAuthorizationUpdate,
  MessagingAdapterRenderingPreferencesUpdate,
  MessagingConversationTitleSupportRequest,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
  MessagingManagedConversationActionRequest,
  MessagingManagedConversationActionResult,
  MessagingManagedConversationCreateRequest,
  MessagingManagedConversationCreateResult,
  MessagingManagedConversationRightsRequest,
  MessagingManagedConversationRightsResult,
  MessagingPrivateConversationResolveRequest,
  MessagingPrivateConversationResolveResult,
  MessagingReconnectInfo,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";

export type {
  MessagingConversationTitleSupportRequest,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
} from "@pwragent/messaging-interface";

export type MessagingLastAssistantReply = {
  createdAt?: number;
  text: string;
};

export type MessagingActiveBackendTurn = {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
};

/**
 * Targeted state needed to admit one bound-thread reply. This projection must
 * stay independent of navigation-wide Git, PR, launchpad, directory, and
 * federation enrichment.
 */
export type MessagingThreadAdmissionState = ThreadAdmissionState;

export type MessagingAdapter = {
  capabilityProfile: MessagingCapabilityProfile;
  clientRateLimitStrategy?: MessagingClientRateLimitStrategy;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  resolveDeliveryScope?(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined;
  updateAuthorization?(update: MessagingAdapterAuthorizationUpdate): Promise<void>;
  updateRenderingPreferences?(
    update: MessagingAdapterRenderingPreferencesUpdate,
  ): Promise<void>;
  onRateLimit?(listener: (info: MessagingRateLimitInfo) => void): () => void;
  onReconnect?(listener: (info: MessagingReconnectInfo) => void): () => void;
  downloadAttachment?(
    request: MessagingAttachmentDownloadRequest,
  ): Promise<MessagingAttachmentDownloadResult>;
  setConversationTitle?(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult>;
  supportsConversationTitle?(
    request: MessagingConversationTitleSupportRequest,
  ): boolean;
  getManagedConversationRights?(
    request: MessagingManagedConversationRightsRequest,
  ): Promise<MessagingManagedConversationRightsResult>;
  createManagedConversation?(
    request: MessagingManagedConversationCreateRequest,
  ): Promise<MessagingManagedConversationCreateResult>;
  resolvePrivateConversation?(
    request: MessagingPrivateConversationResolveRequest,
  ): Promise<MessagingPrivateConversationResolveResult>;
  closeManagedConversation?(
    request: MessagingManagedConversationActionRequest,
  ): Promise<MessagingManagedConversationActionResult>;
  reopenManagedConversation?(
    request: MessagingManagedConversationActionRequest,
  ): Promise<MessagingManagedConversationActionResult>;
  deleteManagedConversation?(
    request: MessagingManagedConversationActionRequest,
  ): Promise<MessagingManagedConversationActionResult>;
  /**
   * Search the provider's people/app directory. Only meaningful when
   * `capabilityProfile.directory?.supportsActorSearch` is true; callers must
   * check the capability rather than probing for the method, so an adapter that
   * loses the scope at runtime can turn the capability off in one place.
   */
  searchDirectoryActors?(
    request: MessagingDirectorySearchRequest,
  ): Promise<MessagingDirectorySearchResult>;
};

export type MessagingBackendBridge = {
  getNavigationQueryPage?(request: NavigationQueryRequest): Promise<NavigationQueryPage>;
  getNavigationSelectedDetail?(request: NavigationSelectedDetailRequest): Promise<NavigationSelectedDetailResponse>;
  getNavigationLaunchpadConfig?(request: NavigationLaunchpadConfigRequest): Promise<NavigationLaunchpadConfigResponse>;
  getNavigationSnapshot(
    request?: GetNavigationSnapshotRequest,
    options?: { onProgress?: (snapshot: NavigationSnapshot) => Promise<void> },
  ): Promise<NavigationSnapshot>;
  getThreadAdmissionState(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<MessagingThreadAdmissionState>;
  /**
   * Storage roots no local-file read may reach. Read through the bridge rather
   * than the backend-registry singleton: that getter constructs a registry with
   * real machine ACP discovery, so reaching for it from a tool call would make
   * sending a file trigger a PATH scan, a release fetch, and a binary probe.
   */
  getLocalFilePrivateStorageRoots?(): readonly string[];
  resolveThreadTarget?(request: {
    backend: AppServerBackendKind;
    threadId: string;
    instanceId?: FederationInstanceId;
    includeRemote?: boolean;
  }): Promise<{
    navigation: NavigationSnapshot;
    thread: NavigationThreadSummary;
    federatedThread?: FederatedThreadRef;
  } | undefined>;
  readThreadAgentMetadata?(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadAgentMetadata | undefined>;
  readThreadStatus?(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<AppServerThreadStatus | undefined>;
  readActiveTurn?(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<MessagingActiveBackendTurn | undefined>;
  readThreadLastAssistantMessage?(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<string | undefined>;
  readThreadLastAssistantReply?(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<MessagingLastAssistantReply | undefined>;
  resolveAssistantMessageImages?(request: {
    backend: AppServerBackendKind;
    itemId?: string;
    text: string;
    threadId: string;
    turnId?: string;
  }): Promise<MessagingImagePart[]>;
  handoffThreadWorkspace?(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse>;
  ensureDirectoryLaunchpad?(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse>;
  materializeDirectoryLaunchpad?(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions,
  ): Promise<MaterializeDirectoryLaunchpadResponse>;
  updateDirectoryLaunchpad?(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse>;
  startThread?(request: StartThreadRequest): Promise<StartThreadResponse>;
  submitReview?(request: StartReviewRequest): Promise<
    | {
        status: "started";
        response: StartReviewResponse;
      }
    | {
        status: "scheduled";
        pendingReviewId: string;
        invokingTurnId: string;
      }
  >;
  startTurn(
    request: StartTurnRequest & { messageOrigin?: AppServerThreadMessageOrigin },
  ): Promise<StartTurnResponse>;
  listScheduledThreadActions?(
    request?: ListScheduledThreadActionsRequest,
  ): Promise<ListScheduledThreadActionsResponse>;
  createScheduledThreadAction?(
    request: CreateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  updateScheduledThreadAction?(
    request: UpdateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  cancelScheduledThreadAction?(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  sendScheduledThreadActionNow?(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse>;
  supportsMessagingPdfTools?(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<boolean>;
  steerTurn?(
    request: SteerTurnRequest & { messageOrigin?: AppServerThreadMessageOrigin },
  ): Promise<SteerTurnResponse>;
  compactThread?(request: CompactThreadRequest): Promise<CompactThreadResponse>;
  interruptTurn?(request: InterruptTurnRequest): Promise<InterruptTurnResponse>;
  listSkills?(
    request?: AppServerListSkillsRequest,
  ): Promise<Pick<AppServerListSkillsResponse, "data">>;
  listBackends?(request?: ListBackendsRequest): Promise<ListBackendsResponse>;
  setThreadExecutionMode?(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse>;
  setAcpSessionRuntimeOption?(
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse>;
  cancelThreadExecutionModeQueue?(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse>;
  setThreadModelSettings?(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse>;
  recordMessagingBindingTransition?(request: {
    backend: AppServerBackendKind;
    threadId: string;
    transition: ThreadMessagingBindingTransition;
  }): Promise<void>;
  submitServerRequest?(
    request: SubmitServerRequestRequest,
  ): Promise<SubmitServerRequestResponse>;
};

export class MessagingFederatedThreadTargetError extends Error {
  constructor(
    readonly code: "peer_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "MessagingFederatedThreadTargetError";
  }
}

export type MessagingInboundListener = (
  event: MessagingInboundEvent,
) => Promise<void> | void;

export type MessagingBackendEventListener = (
  event: AgentEvent,
) => Promise<void> | void;
