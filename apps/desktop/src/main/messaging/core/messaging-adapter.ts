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
  handoffThreadWorkspace?(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse>;
  materializeDirectoryLaunchpad?(
    request: MaterializeDirectoryLaunchpadRequest,
  ): Promise<MaterializeDirectoryLaunchpadResponse>;
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
