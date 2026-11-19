import type { MessagingBindingService } from "./messaging-binding-service";
import type { MessagingAccessControl } from "./messaging-access-control";
import type { MessagingInboundTurns } from "./messaging-inbound-turns";
import type { MessagingDeliveryGuard, ActiveAgentMessagingOrigin, MessagingControllerLogger } from "./messaging-backend-event-helpers";
import type { AppServerBackendKind, ThreadIdentifier } from "@pwragent/shared";
import type { MessagingRequestSource, MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingActiveTurnSummary, MessagingDeliveryResult, MessagingInboundEvent, MessagingPendingIntentRecord, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter.js";

export interface MessagingPendingRequestHost {
  readonly filterBindingsForChannel: (bindings: MessagingBindingRecord[]) => MessagingBindingRecord[];
  readonly bindingsForAgentTurn: (backend: AppServerBackendKind, threadId: ThreadIdentifier, turnId: string | undefined, persistentBindings: MessagingBindingRecord[]) => MessagingBindingRecord[];
  readonly readBackendThreadStatus: (binding: MessagingBindingRecord) => Promise<string | undefined>;
  readonly reconcileIdleTurn: (binding: MessagingBindingRecord, reason: string) => Promise<void>;
  readonly storePendingIntent: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { expiresAt?: number; }) => Promise<MessagingPendingIntentRecord>;
  readonly flushPendingTurnProseBeforeElicitation: (binding: MessagingBindingRecord, turnId: string | null | undefined) => Promise<void>;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly reconcileActiveTurnFromBackendStatus: (binding: MessagingBindingRecord, reason: string) => Promise<MessagingActiveTurnSummary | undefined>;
  readonly setActiveTurn: (binding: MessagingBindingRecord, activeTurn: MessagingActiveTurnSummary) => void;
  readonly signalTurnActivity: (binding: MessagingBindingRecord, activeTurn: MessagingActiveTurnSummary, options?: { force?: boolean; reason?: string; refreshMs?: number; }) => Promise<void>;
  readonly renderAutomaticBindingStatus: MessagingBindingService["renderAutomaticBindingStatus"];
  readonly newIntentId: (prefix: string) => string;
  readonly requirePermission: MessagingAccessControl["requirePermission"];
  readonly requireRemoteScopeForBinding: MessagingAccessControl["requireRemoteScopeForBinding"];
  readonly isTurnOccupied: MessagingInboundTurns["isTurnOccupied"];
  readonly resolveSteerableActiveTurn: (binding: MessagingBindingRecord, reason: string) => Promise<MessagingActiveTurnSummary | undefined>;
  readonly rememberHumanMessagingSource: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => MessagingRequestSource | undefined;
  readonly startPreparedInput: MessagingInboundTurns["startPreparedInput"];
  readonly isChannelInScope: (channel: MessagingBindingRecord["channel"] | undefined) => boolean;
  readonly agentMessagingOriginForPendingIntent: (pendingIntent: MessagingPendingIntentRecord) => ActiveAgentMessagingOrigin | undefined;
  readonly getActiveTurn: (binding: MessagingBindingRecord) => MessagingActiveTurnSummary | undefined;
  readonly logBindingTurnStateChange: (binding: MessagingBindingRecord, previousTurn: MessagingActiveTurnSummary | undefined, nextTurn: MessagingActiveTurnSummary | undefined, reason: string) => void;
}

export interface MessagingPendingRequestContext {
  readonly store: Pick<MessagingStoreLike, "findActiveBindingsForThread" | "findActivePendingIntentsForRequest" | "upsertPendingIntent" | "deletePendingIntent" | "getBinding" | "findActivePendingAsyncQuestionnaires">;
  readonly backend: Pick<MessagingBackendBridge, "getThreadAdmissionState" | "steerTurn" | "submitServerRequest">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  readonly host: () => MessagingPendingRequestHost;
}
