import type { MessagingTurns } from "./messaging-turn-state";
import { type MessagingDeliveryGuard, type MessagingControllerLogger } from "./messaging-backend-event-helpers";
import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { FederatedThreadRef } from "@pwragent/shared/contracts/federation";
import type {
  NavigationSelectedDetailRequest,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type { MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingChannelKind, MessagingChannelRef, MessagingDeliveryResult, MessagingInboundEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingAdapter, MessagingBackendBridge } from "./messaging-adapter.js";

export interface MessagingMonitorHost {
  readonly cleanupExpiredPrivateReplyContinuations: () => Promise<void>;
  readonly filterBindingsForChannel: (bindings: MessagingBindingRecord[]) => MessagingBindingRecord[];
  readonly isChannelInScope: (channel: MessagingChannelRef) => boolean;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly newIntentId: (prefix: string) => string;
  readonly monitorAuthorizedActorIds: (event: MessagingInboundEvent) => string[];
  readonly readExactNavigationThread: (request: Omit<NavigationSelectedDetailRequest, "protocol">) => Promise<NavigationThreadSummary | undefined>;
  readonly bindChannelToThread: (event: MessagingInboundEvent, target: { backend: AppServerBackendKind; federatedThread?: FederatedThreadRef; recordTransition?: boolean; statusPresentation?: MessagingBindingRecord["statusPresentation"]; threadId: ThreadIdentifier; targetKind?: MessagingBindingRecord["targetKind"]; }) => Promise<MessagingBindingRecord>;
}

export interface MessagingMonitorContext {
  readonly store: Pick<MessagingStoreLike, "findActiveMonitorSubscriptionsForChannelKind" | "findActiveBindingsForBackend" | "findManagedTopicsForSupergroup" | "upsertManagedTopic" | "upsertTopicCleanupProposal" | "findThreadTopicLink" | "getManagedTopic" | "upsertThreadTopicLink" | "findActiveBindingForChannel" | "mergeManagedTopicObservation" | "findManagedTopicByConversation" | "findActiveMonitorSubscriptionForChannel" | "upsertMonitorSubscription" | "upsertBinding" | "getBinding" | "revokeMonitorSubscription" | "getMonitorSubscription">;
  readonly backend: Pick<MessagingBackendBridge, "getNavigationQueryPage" | "readThreadStatus" | "readThreadLastAssistantMessage" | "listBackends">;
  readonly adapter: Pick<MessagingAdapter, "createManagedConversation" | "getManagedConversationRights">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly turns: Pick<MessagingTurns, "snapshot">;
  readonly disposed: boolean;
  readonly config: { readonly channel?: MessagingChannelKind };
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  readonly host: () => MessagingMonitorHost;
}
