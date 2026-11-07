import type { AppServerBackendKind, MessagingCausalSourceRef, PwrAgentMessagingResponse } from "@pwragent/shared";

export type MessagingRequestSource<InboundEvent> = {
  ref: MessagingCausalSourceRef;
  selector: string;
  principalScope: string;
  agent: { backend: AppServerBackendKind; threadId: string };
  bindingId?: string;
  connectionId?: string;
  route: "binding" | "default";
  /** Only routing and admission identity, never message text, attachments or credentials. */
  event: InboundEvent;
};

/** Durable immutable request provenance and idempotent attachment operations. */
export interface MessagingRequestStorage<InboundEvent> {
  remember(params: {
    agent: MessagingRequestSource<InboundEvent>["agent"];
    bindingId?: string;
    connectionId?: string;
    event: InboundEvent;
    instanceId?: string;
  }): MessagingRequestSource<InboundEvent> | undefined;

  get(ref: MessagingCausalSourceRef): MessagingRequestSource<InboundEvent> | undefined;

  destination(source: MessagingRequestSource<InboundEvent>, selector: string): MessagingRequestSource<InboundEvent> | undefined;

  list(source: MessagingRequestSource<InboundEvent>, limit: number, before?: { at: number; selector: string }): MessagingRequestSource<InboundEvent>[];

  claimAttachment(operation: unknown): { id: string; claimed: boolean; result?: PwrAgentMessagingResponse };

  finishAttachment(id: string, result: PwrAgentMessagingResponse): void;
}
