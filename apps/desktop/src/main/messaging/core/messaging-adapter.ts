import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerThreadStatus,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  GetNavigationSnapshotRequest,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationSnapshot,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  ThreadMessagingBindingTransition,
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
    threadId: string;
  }): Promise<AppServerThreadStatus | undefined>;
  readThreadLastAssistantMessage?(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<string | undefined>;
  readThreadLastAssistantReply?(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<MessagingLastAssistantReply | undefined>;
  handoffThreadWorkspace?(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse>;
  materializeDirectoryLaunchpad?(
    request: MaterializeDirectoryLaunchpadRequest,
  ): Promise<MaterializeDirectoryLaunchpadResponse>;
  updateDirectoryLaunchpad?(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse>;
  startThread?(request: StartThreadRequest): Promise<StartThreadResponse>;
  startTurn(request: StartTurnRequest): Promise<StartTurnResponse>;
  steerTurn?(request: SteerTurnRequest): Promise<SteerTurnResponse>;
  compactThread?(request: CompactThreadRequest): Promise<CompactThreadResponse>;
  interruptTurn?(request: InterruptTurnRequest): Promise<InterruptTurnResponse>;
  listSkills?(
    request?: AppServerListSkillsRequest,
  ): Promise<Pick<AppServerListSkillsResponse, "data">>;
  listBackends?(request?: ListBackendsRequest): Promise<ListBackendsResponse>;
  setThreadExecutionMode?(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse>;
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
