import type {
  AgentEvent,
  GetNavigationSnapshotRequest,
  MessagingDeliveryResult,
  MessagingInboundEvent,
  NavigationSnapshot,
  MessagingSurfaceIntent,
  StartTurnRequest,
  StartTurnResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
} from "@pwragnt/shared";

export type MessagingAdapter = {
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
};

export type MessagingBackendBridge = {
  getNavigationSnapshot(
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot>;
  startTurn(request: StartTurnRequest): Promise<StartTurnResponse>;
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
