import type { MessagingTurns } from "../../messaging/core/messaging-turn-state";
import type { MessagingQueueRecoveries } from "../../messaging/core/messaging-queue-recoveries";
import type { MessagingTurnAdmission } from "../../messaging/core/messaging-turn-admission";
import type { MessagingAccessControl } from "../../messaging/core/messaging-access-control";
import type { MessagingAccessHost } from "../../messaging/core/messaging-access-context";
import type { MessagingBackendEventHost } from "../../messaging/core/messaging-backend-event-context";
import type { MessagingBackendEventRouter } from "../../messaging/core/messaging-backend-event-router";
import type { MessagingController } from "../../messaging/core/messaging-controller";
import type { MessagingPrivateResponses } from "../../messaging/core/messaging-private-response-state";
import type { MessagingPrivateReplyClaims } from "../../messaging/core/messaging-private-reply-claims";
import type { MessagingCallbackHandlers } from "../../messaging/core/messaging-callback-handlers";
import type { MessagingCallbackHost } from "../../messaging/core/messaging-callback-context";
import type { MessagingBindingService } from "../../messaging/core/messaging-binding-service";
import type { MessagingBindingHost } from "../../messaging/core/messaging-binding-context";
import type { MessagingInboundTurns } from "../../messaging/core/messaging-inbound-turns";
import type { MessagingInboundHost } from "../../messaging/core/messaging-inbound-context";
import type { MessagingReviewWorkflow } from "../../messaging/core/messaging-review-workflow";
import type { MessagingReviewHost } from "../../messaging/core/messaging-review-context";
import type { MessagingNewThreadWorkflow } from "../../messaging/core/messaging-new-thread-workflow";
import type { MessagingNewThreadHost } from "../../messaging/core/messaging-new-thread-context";

// Test-only access to the actual owner and the facade's late-bound host ports.
// No moved state or moved operation is accessed through the controller.
export function messagingModules(controller: MessagingController): {
  readonly turns: MessagingTurns;
  readonly queueRecoveries: MessagingQueueRecoveries;
  readonly admission: MessagingTurnAdmission;
  readonly access: MessagingAccessControl;
  readonly accessHost: () => MessagingAccessHost;
  readonly backendEvents: MessagingBackendEventRouter;
  readonly backendEventHost: () => MessagingBackendEventHost;
  readonly privateResponses: MessagingPrivateResponses;
  readonly privateReplyClaims: MessagingPrivateReplyClaims;
  readonly callbacks: MessagingCallbackHandlers;
  readonly callbackHost: () => MessagingCallbackHost;
  readonly bindings: MessagingBindingService;
  readonly bindingHost: () => MessagingBindingHost;
  readonly inbound: MessagingInboundTurns;
  readonly inboundHost: () => MessagingInboundHost;
  readonly reviews: MessagingReviewWorkflow;
  readonly reviewHost: () => MessagingReviewHost;
  readonly newThreads: MessagingNewThreadWorkflow;
  readonly newThreadHost: () => MessagingNewThreadHost;
} {
  const ports = controller as unknown as {
    readonly turns: MessagingTurns;
    readonly queueRecoveries: MessagingQueueRecoveries;
    readonly turnAdmission: MessagingTurnAdmission;
    readonly accessControl: MessagingAccessControl;
    accessHost(): MessagingAccessHost;
    readonly backendEventRouter: MessagingBackendEventRouter;
    backendEventHost(): MessagingBackendEventHost;
    readonly privateResponses: MessagingPrivateResponses;
    readonly privateReplyClaims: MessagingPrivateReplyClaims;
    readonly callbackHandlers: MessagingCallbackHandlers;
    callbackHost(): MessagingCallbackHost;
    readonly bindingService: MessagingBindingService;
    bindingHost(): MessagingBindingHost;
    readonly inboundTurns: MessagingInboundTurns;
    inboundHost(): MessagingInboundHost;
    readonly reviewWorkflow: MessagingReviewWorkflow;
    reviewHost(): MessagingReviewHost;
    readonly newThreadWorkflow: MessagingNewThreadWorkflow;
    newThreadHost(): MessagingNewThreadHost;
  };
  return {
    turns: ports.turns,
    queueRecoveries: ports.queueRecoveries,
    admission: ports.turnAdmission,
    access: ports.accessControl,
    accessHost: () => ports.accessHost(),
    backendEvents: ports.backendEventRouter,
    backendEventHost: () => ports.backendEventHost(),
    privateResponses: ports.privateResponses,
    privateReplyClaims: ports.privateReplyClaims,
    callbacks: ports.callbackHandlers,
    callbackHost: () => ports.callbackHost(),
    bindings: ports.bindingService,
    bindingHost: () => ports.bindingHost(),
    inbound: ports.inboundTurns,
    inboundHost: () => ports.inboundHost(),
    reviews: ports.reviewWorkflow,
    reviewHost: () => ports.reviewHost(),
    newThreads: ports.newThreadWorkflow,
    newThreadHost: () => ports.newThreadHost(),
  };
}
