import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { MessagingToolUpdateMode } from "@pwragent/shared/contracts/messaging";
import type { MessagingBindingRecord, MessagingBindingTargetKind, MessagingCapabilityProfile, MessagingDeliveryResult, MessagingInboundEvent, MessagingPendingIntentRecord, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter";
import type { MessagingControllerLogger, MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import type { AcpRuntimeRiskWarningContext, FullAccessEscalationContext, MessagingFullAccessControls } from "./messaging-callback-helpers";
import type { MessagingStoreLike } from "./messaging-storage";

export interface MessagingNewThreadHost {
  readonly resolveToolUpdateDefaultMode: (targetKind?: MessagingBindingTargetKind) => Promise<MessagingToolUpdateMode>;
  readonly resolveShowStreamingOption: () => Promise<boolean>;
  readonly requireRemoteScope: (event: MessagingInboundEvent, target: FederationTarget | undefined, auditAction: string, opts?: { notify?: boolean }) => Promise<boolean>;
  readonly resolveFullAccessControls: () => MessagingFullAccessControls | Promise<MessagingFullAccessControls>;
  readonly ensureFullAccessEscalationAllowed: (context: FullAccessEscalationContext, event: MessagingInboundEvent) => Promise<boolean>;
  readonly ensureAcpRuntimeModeAllowed: (context: AcpRuntimeRiskWarningContext, event: MessagingInboundEvent) => Promise<boolean>;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly storePendingIntent: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { expiresAt?: number }) => Promise<MessagingPendingIntentRecord>;
  readonly newIntentId: (prefix: string) => string;
  readonly getBackendSummary: (backend: AppServerBackendKind, federationTarget?: FederationTarget) => Promise<BackendSummary | undefined>;
  readonly deliverInvalidBrowseSelection: (event: MessagingInboundEvent) => Promise<void>;
}

export interface MessagingNewThreadContext {
  readonly store: Pick<MessagingStoreLike, "upsertBrowseSession" | "upsertPendingIntent">;
  readonly backend: Pick<MessagingBackendBridge, "updateDirectoryLaunchpad" | "listBackends" | "materializeDirectoryLaunchpad" | "startThread" | "getNavigationQueryPage" | "getNavigationLaunchpadConfig" | "ensureDirectoryLaunchpad">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly pendingIntentTtlMs: number;
  readonly streamingResponsesDefault: boolean;
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  readonly host: () => MessagingNewThreadHost;
}
