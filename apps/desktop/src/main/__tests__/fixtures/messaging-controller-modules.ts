import type { MessagingBackendEventHost } from "../../messaging/core/messaging-backend-event-context";
import type { MessagingBackendEventRouter } from "../../messaging/core/messaging-backend-event-router";
import type { MessagingController } from "../../messaging/core/messaging-controller";

// Test-only access to the actual owner and the facade's late-bound host ports.
// No moved state or moved operation is accessed through the controller.
export function messagingModules(controller: MessagingController): {
  readonly backendEvents: MessagingBackendEventRouter;
  readonly backendEventHost: () => MessagingBackendEventHost;
} {
  const ports = controller as unknown as {
    readonly backendEventRouter: MessagingBackendEventRouter;
    backendEventHost(): MessagingBackendEventHost;
  };
  return {
    backendEvents: ports.backendEventRouter,
    backendEventHost: () => ports.backendEventHost(),
  };
}
