import type { AppServerBackendKind, BackendSummary, FederationTarget, NavigationLaunchpadDefaults, NavigationThreadSummary } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingCapabilityProfile, MessagingDeliveryResult, MessagingInboundEvent, MessagingPendingIntentRecord, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter";
import type { MessagingControllerLogger, MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import type { MessagingStoreLike } from "./messaging-storage";
import type { MessagingThreadContext } from "./messaging-thread-state";

export interface MessagingReviewHost {
  readonly readBoundWorkspaceContext: (binding: MessagingBindingRecord) => Promise<MessagingThreadContext>;
  readonly readBoundThreadConfiguration: (binding: MessagingBindingRecord) => Promise<{ kind: "thread"; thread: NavigationThreadSummary; defaults: NavigationLaunchpadDefaults }>;
  readonly storePendingIntent: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { expiresAt?: number }) => Promise<MessagingPendingIntentRecord>;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly newIntentId: (prefix: string) => string;
  readonly getBackendSummary: (backend: AppServerBackendKind, federationTarget?: FederationTarget) => Promise<BackendSummary | undefined>;
}

export interface MessagingReviewContext {
  readonly store: Pick<MessagingStoreLike, "upsertPendingIntent" | "getBinding" | "deletePendingIntent">;
  readonly backend: Pick<MessagingBackendBridge, "submitReview" | "listBackends">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  readonly host: () => MessagingReviewHost;
}
