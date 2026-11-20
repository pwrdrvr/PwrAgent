import { FederationRoleDeniedError } from "@pwragent/federation/federation-router";
import type { FilePushResult } from "@pwragent/federation/federation-file-push";
import type { OriginalAttachmentConsumer } from "../messaging/core/messaging-original-attachment-store";
import type {
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
  PwrAgentMessagingContext,
} from "@pwragent/shared/contracts/messaging-tools";
import type { MessagingDynamicToolCategory } from "@pwragent/shared/contracts/rbac";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";

export const FEDERATION_MESSAGING_DESTINATION_METHOD = "messaging.destination";

export type FederationMessagingDestinationOperation =
  | { kind: "request"; request: PwrAgentMessagingRequest; file?: FilePushResult }
  | { kind: "authorize"; context: PwrAgentMessagingContext; check: {
      backend: AppServerBackendKind; threadId: string; turnId?: string;
      category: MessagingDynamicToolCategory; tool: string; arguments?: Record<string, unknown> | null;
    } };

export type FederationMessagingDestinationResult = PwrAgentMessagingResponse
  | { allowed: boolean; permission?: string };

let handler: ((operation: FederationMessagingDestinationOperation, callerInstanceId: string, contained: boolean,
  consumeOriginal?: OriginalAttachmentConsumer) => Promise<FederationMessagingDestinationResult>) | undefined;

/** Registration avoids a federation-runtime -> messaging-runtime import cycle. */
export function setFederationMessagingDestinationHandler(next: typeof handler): void { handler = next; }

export async function handleFederationMessagingDestination(
  operation: FederationMessagingDestinationOperation, callerInstanceId: string, contained = false,
  consumeOriginal?: OriginalAttachmentConsumer,
): Promise<FederationMessagingDestinationResult> {
  if (!handler) throw new Error("Messaging destination service is unavailable on this profile.");
  const result = await handler(operation, callerInstanceId, contained, consumeOriginal);
  if (contained && (("allowed" in result && !result.allowed) || ("ok" in result && !result.ok))) {
    throw new FederationRoleDeniedError("Contained messaging destination is not bound to this peer's thread.");
  }
  return result;
}
