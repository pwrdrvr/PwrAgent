import type {
  AgentEvent,
  CompactThreadRequest,
  CompactThreadResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  GetNavigationSnapshotRequest,
  ListBackendsRequest,
  ListBackendsResponse,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingActorIdentity,
  MessagingAdapterState,
  MessagingChannelRef,
  MessagingChannelKind,
  NavigationSnapshot,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  MessagingSurfaceIntent,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
} from "@pwragnt/shared";

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
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  setConversationTitle?(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult>;
};

export type MessagingBackendBridge = {
  getNavigationSnapshot(
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot>;
  startThread?(request: StartThreadRequest): Promise<StartThreadResponse>;
  startTurn(request: StartTurnRequest): Promise<StartTurnResponse>;
  compactThread?(request: CompactThreadRequest): Promise<CompactThreadResponse>;
  interruptTurn?(request: InterruptTurnRequest): Promise<InterruptTurnResponse>;
  listBackends?(request?: ListBackendsRequest): Promise<ListBackendsResponse>;
  setThreadExecutionMode?(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse>;
  setThreadModelSettings?(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse>;
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
