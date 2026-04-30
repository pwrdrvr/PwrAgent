import type {
  AppServerBackendKind,
  MessagingActorIdentity,
  MessagingAuditContext,
  MessagingChannelRef,
  ThreadIdentifier,
} from "@pwragnt/shared";

export function buildMessagingAuditContext(params: {
  action: string;
  actor: MessagingActorIdentity;
  backend?: AppServerBackendKind;
  bindingId?: string;
  channel: MessagingChannelRef;
  now?: number;
  threadId?: ThreadIdentifier;
}): MessagingAuditContext {
  return {
    action: params.action,
    actor: params.actor,
    backend: params.backend,
    bindingId: params.bindingId,
    channel: params.channel,
    occurredAt: params.now ?? Date.now(),
    threadId: params.threadId,
  };
}
