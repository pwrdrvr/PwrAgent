import type { MessagingBackendEventHost } from "../../messaging/core/messaging-backend-event-context";
import type { MessagingBackendEventRouter } from "../../messaging/core/messaging-backend-event-router";
import type { MessagingController } from "../../messaging/core/messaging-controller";
import type { MessagingPrivateResponses } from "../../messaging/core/messaging-private-response-state";
import type { MessagingPrivateReplyClaims } from "../../messaging/core/messaging-private-reply-claims";

// Test-only access to the actual owner and the facade's late-bound host ports.
// No moved state or moved operation is accessed through the controller.
export function messagingModules(controller: MessagingController): {
  readonly backendEvents: MessagingBackendEventRouter;
  readonly backendEventHost: () => MessagingBackendEventHost;
  readonly privateResponses: MessagingPrivateResponses;
  readonly privateReplyClaims: MessagingPrivateReplyClaims;
} {
  const ports = controller as unknown as {
    readonly backendEventRouter: MessagingBackendEventRouter;
    backendEventHost(): MessagingBackendEventHost;
    readonly privateResponses: MessagingPrivateResponses;
    readonly privateReplyClaims: MessagingPrivateReplyClaims;
  };
  return {
    backendEvents: ports.backendEventRouter,
    backendEventHost: () => ports.backendEventHost(),
    privateResponses: ports.privateResponses,
    privateReplyClaims: ports.privateReplyClaims,
  };
}
