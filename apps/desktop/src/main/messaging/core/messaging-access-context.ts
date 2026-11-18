import { type MessagingDeliveryGuard, type ActiveAgentMessagingOrigin, type MessagingControllerLogger } from "./messaging-backend-event-helpers";
import type { AppServerBackendKind, ThreadIdentifier } from "@pwragent/shared";
import type { MessagingRbacPolicyProvider } from "../rbac-policy-service";
import type { MessagingRequestStore, MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingChannelRef, MessagingDeliveryResult, MessagingInboundEvent, MessagingPendingIntentRecord, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingAdapter } from "./messaging-adapter.js";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import { type MessagingFullAccessControlsResolver } from "./messaging-inbound-helpers";

export interface MessagingAccessHost {
  readonly desktopActivityLog: () => MessagingActivityStorage | undefined;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly newIntentId: (prefix: string) => string;
  readonly activeAgentMessagingOriginsByTurnKey: Pick<ReadonlyMap<string, Pick<ActiveAgentMessagingOrigin, "event" | "source">>, "get">;
  readonly storePendingIntent: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { expiresAt?: number; }) => Promise<MessagingPendingIntentRecord>;
  readonly isChannelInScope: (channel: MessagingBindingRecord["channel"] | undefined) => boolean;
}

export interface MessagingAccessConfiguration {
  readonly rbacPolicy?: MessagingRbacPolicyProvider;
  readonly fullAccessControls?: MessagingFullAccessControlsResolver;
  readonly onFullAccessPolicyViolation?: ((event: { actorId: string; actorDisplayName?: string; backend?: AppServerBackendKind; bindingId?: string; channel: MessagingChannelRef; requestedAction: string; threadId?: ThreadIdentifier; }) => void | Promise<void>);
  readonly requestStore?: Pick<MessagingRequestStore, "get">;
}

export interface MessagingAccessContext {
  readonly store: Pick<MessagingStoreLike, "upsertBrowseSession" | "upsertPendingIntent" | "findActiveBindingForChannel" | "findActiveDefaultAgentAssignmentForChannel">;
  readonly adapter: Pick<MessagingAdapter, "retainedSourceConnectionId" | "authorizeRetainedSource">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  readonly config: MessagingAccessConfiguration;
  readonly host: () => MessagingAccessHost;
}
