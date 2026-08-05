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
  ListBackendsRequest,
  ListBackendsResponse,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  MaterializeDirectoryLaunchpadOptions,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationSnapshot,
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
  MessagingClientRateLimitStrategy,
  MessagingInboundEvent,
  MessagingImagePart,
  MessagingActorIdentity,
  MessagingAdapterState,
  MessagingAdapterAuthorizationUpdate,
  MessagingAdapterRenderingPreferencesUpdate,
  MessagingChannelRef,
  MessagingChannelKind,
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

export type MessagingConversationTitleUpdateRequest = {
  actor?: MessagingActorIdentity;
  channel: MessagingChannelRef;
  routingState?: MessagingAdapterState;
  title: string;
};

export type MessagingConversationTitleUpdateResult = {
  channel: MessagingChannelKind;
  conversation: MessagingChannelRef["conversation"];
  errorMessage?: string;
  outcome: "updated" | "unsupported" | "failed";
  title: string;
  updatedAt: number;
};

export type MessagingLastAssistantReply = {
  createdAt?: number;
  text: string;
};

export type MessagingActiveBackendTurn = {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
};

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
};

export type MessagingBackendBridge = {
  getNavigationSnapshot(
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot>;
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

export type MessagingInboundListener = (
  event: MessagingInboundEvent,
) => Promise<void> | void;

export type MessagingBackendEventListener = (
  event: AgentEvent,
) => Promise<void> | void;
