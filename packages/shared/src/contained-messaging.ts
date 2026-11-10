import type { FederatedThreadRef } from "./contracts/federation";
import type { PwrAgentMessagingContext } from "./contracts/messaging-tools";

export function containedMessagingBindingMatches(context: PwrAgentMessagingContext, binding: {
  revokedAt?: number; federatedThread?: FederatedThreadRef;
} | undefined): boolean {
  const ref = binding?.federatedThread;
  return Boolean(binding && binding.revokedAt === undefined && ref?.target.scope === "remote"
    && ref.target.instanceId === context.requestingInstanceId
    && ref.backend === context.backend && ref.threadId === context.threadId);
}
