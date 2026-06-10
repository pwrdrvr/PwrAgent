import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { FederatedThreadRef } from "@pwragent/shared";
import {
  buildFederatedThreadRef,
  isRemoteFederationTarget,
} from "@pwragent/shared";

export function federatedThreadRefForMessagingBinding(
  binding: MessagingBindingRecord,
): FederatedThreadRef {
  return binding.federatedThread ?? buildFederatedThreadRef({
    backend: binding.backend,
    threadId: binding.threadId,
  });
}

export function messagingBindingTargetsRemoteInstance(
  binding: MessagingBindingRecord,
): boolean {
  return isRemoteFederationTarget(
    federatedThreadRefForMessagingBinding(binding).target,
  );
}
