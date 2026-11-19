import type { AppServerBackendKind, AppServerReviewTarget, BackendSummary, FederationTarget, NavigationLaunchpadDefaults, NavigationThreadSummary, ReviewAfterAction, ReviewRunMode } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingCapabilityProfile, MessagingDeliveryResult, MessagingInboundEvent, MessagingPendingIntentRecord, MessagingSurfaceIntent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter";
import type { MessagingControllerLogger, MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import type { MessagingRequestSource, MessagingStoreLike } from "./messaging-storage";
import type { MessagingThreadContext } from "./messaging-thread-state";

export type MessagingReviewSubmission = {
  binding: MessagingBindingRecord;
  event: MessagingInboundEvent;
  cwd?: string;
  runMode?: ReviewRunMode;
  afterReview?: ReviewAfterAction;
  reviewBackend?: AppServerBackendKind;
  reviewerLabel?: string;
  model?: string;
  reasoningEffort?: string;
  targetSurface?: MessagingSurfaceRef;
  pendingIntentId?: string;
} & ({ target: AppServerReviewTarget } | { pullRequestArgs: string });

export interface MessagingReviewHost {
  readonly rememberHumanMessagingSource: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => MessagingRequestSource | undefined;
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
