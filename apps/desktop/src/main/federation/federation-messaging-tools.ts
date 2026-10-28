import type { FilePushResult } from "@pwragent/federation/federation-file-push";
import type { PwrAgentMessagingRequest, PwrAgentMessagingResponse, PwrAgentMessagingContext,
  MessagingDynamicToolCategory, AppServerBackendKind } from "@pwragent/shared";

export const FEDERATION_MESSAGING_DESTINATION_METHOD = "messaging.destination";

export type FederationMessagingDestinationOperation =
  | { kind: "request"; request: PwrAgentMessagingRequest; file?: FilePushResult }
  | { kind: "authorize"; context: PwrAgentMessagingContext; check: {
      backend: AppServerBackendKind; threadId: string; turnId?: string;
      category: MessagingDynamicToolCategory; tool: string; arguments?: Record<string, unknown> | null;
    } };

export type FederationMessagingDestinationResult = PwrAgentMessagingResponse
  | { allowed: boolean; permission?: string };

let handler: ((operation: FederationMessagingDestinationOperation, callerInstanceId: string) => Promise<FederationMessagingDestinationResult>) | undefined;

/** Registration avoids a federation-runtime -> messaging-runtime import cycle. */
export function setFederationMessagingDestinationHandler(next: typeof handler): void { handler = next; }

export async function handleFederationMessagingDestination(
  operation: FederationMessagingDestinationOperation, callerInstanceId: string,
): Promise<FederationMessagingDestinationResult> {
  if (!handler) throw new Error("Messaging destination service is unavailable on this profile.");
  return await handler(operation, callerInstanceId);
}
