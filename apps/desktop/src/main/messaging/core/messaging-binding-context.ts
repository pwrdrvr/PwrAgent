import { type MessagingFullAccessControls } from "./messaging-callback-helpers";
import { type MessagingDeliveryGuard, type MessagingControllerLogger } from "./messaging-backend-event-helpers";
import type { AppServerBackendKind, BackendSummary, FederationTarget, NavigationThreadSummary } from "@pwragent/shared";
import type { MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingActiveTurnSummary, MessagingChannelRef, MessagingDeliveryResult, MessagingInboundEvent, MessagingMonitorSubscriptionRecord, MessagingPendingIntentRecord, MessagingResponseMode, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingAdapter, MessagingBackendBridge } from "./messaging-adapter.js";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import type { MessagingToolUpdateDefaultModeResolver } from "./messaging-binding-helpers";

export interface MessagingBindingContext {
  readonly store: Pick<MessagingStoreLike, "findActiveBindingForChannel" | "findManagedTopicByConversation" | "mergeBindingChannelMetadata" | "findActiveBindingsForThread" | "findActivePendingIntentForChannel" | "deletePendingIntent" | "upsertBinding" | "upsertPendingIntent" | "findActiveMonitorSubscriptionForChannel" | "revokeBinding" | "getBinding" | "deletePendingIntentsForChannel">;
  readonly backend: Pick<MessagingBackendBridge, "getThreadAdmissionState" | "handoffThreadWorkspace" | "recordMessagingBindingTransition">;
  readonly adapter: Pick<MessagingAdapter, "setConversationTitle">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  /** The original configuration object preserves native callback receivers. */
  readonly config: MessagingBindingConfiguration;
  readonly host: () => MessagingBindingHost;
}

export interface MessagingBindingConfiguration {
  readonly toolUpdateDefaultMode?: MessagingToolUpdateDefaultModeResolver;
  readonly onBindingChanged?: () => void;
}

export interface MessagingBindingHost {
  readonly filterBindingsForChannel: (bindings: MessagingBindingRecord[]) => MessagingBindingRecord[];
  readonly storePendingIntent: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { expiresAt?: number; }) => Promise<MessagingPendingIntentRecord>;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly newIntentId: (prefix: string) => string;
  readonly readBoundNavigationThread: (binding: MessagingBindingRecord, probeWorkingStates?: boolean) => Promise<NavigationThreadSummary | undefined>;
  readonly getActiveTurn: (binding: MessagingBindingRecord) => MessagingActiveTurnSummary | undefined;
  readonly disableChannelMonitorSubscription: (subscription: MessagingMonitorSubscriptionRecord, event?: MessagingInboundEvent) => Promise<MessagingMonitorSubscriptionRecord>;
  readonly signalTurnActivity: (binding: MessagingBindingRecord, activeTurn: MessagingActiveTurnSummary, options?: { force?: boolean; reason?: string; refreshMs?: number; }) => Promise<void>;
  readonly flushToolUpdatesForBinding: (binding: MessagingBindingRecord, options: { clear: boolean; turnId?: string; }) => Promise<void>;
  readonly stopMonitoringForBinding: (binding: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { deliverStatus?: boolean; }) => Promise<MessagingBindingRecord>;
  readonly isChannelInScope: (channel: MessagingBindingRecord["channel"] | undefined) => boolean;
  readonly showStreamingOptionConfig: boolean | (() => boolean | Promise<boolean>);
  readonly contextUsageSummaryForBinding: (binding: MessagingBindingRecord) => string | undefined;
  readonly responseModeForConversation: (channel: MessagingChannelRef) => Promise<MessagingResponseMode>;
  readonly reconcileActiveTurnFromBackendStatus: (binding: MessagingBindingRecord, reason: string) => Promise<MessagingActiveTurnSummary | undefined>;
  readonly getBackendSummary: (backend: AppServerBackendKind, federationTarget?: FederationTarget) => Promise<BackendSummary | undefined>;
  readonly resolveFullAccessControls: () => MessagingFullAccessControls | Promise<MessagingFullAccessControls>;
  readonly streamingResponsesDefault: boolean;
  readonly requireRemoteScope: (event: MessagingInboundEvent, target: FederationTarget | undefined, auditAction: string, opts?: { notify?: boolean; }) => Promise<boolean>;
  readonly desktopActivityLog: () => MessagingActivityStorage | undefined;
}
