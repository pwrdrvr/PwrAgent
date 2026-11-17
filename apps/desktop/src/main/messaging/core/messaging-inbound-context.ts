import type { MessagingCallbackHandlers } from "./messaging-callback-handlers";
import type { NewThreadOptionsSummary, FullAccessEscalationContext, MessagingFullAccessControls } from "./messaging-callback-helpers";
import type { MessagingCommandHandlers } from "./messaging-command-handlers";
import type { MessagingBackendEventRouter } from "./messaging-backend-event-router";
import type { MessagingPrivateReplyClaims } from "./messaging-private-reply-claims";
import type { MessagingDeliveryGuard, ActiveAgentMessagingOrigin, MessagingControllerLogger } from "./messaging-backend-event-helpers";
import type { MessagingLaunchpadDirectory, MessagingLaunchpadContext, MessagingNewThreadNavigation } from "./messaging-launchpad-context";
import type { QueueNoticeEvent } from "@pwragent/owner-core/queue-notice-lifecycle";
import type { AppServerBackendKind, BackendSummary, FederationTarget, MessagingPermissionId, MessagingToolUpdateMode, ThreadIdentifier } from "@pwragent/shared";
import type { MessagingRequestSource, MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord, MessagingActiveTurnSummary, MessagingChannelKind, MessagingChannelRef, MessagingDeliveryResult, MessagingInboundEvent, MessagingInboundTextEvent, MessagingPendingIntentRecord, MessagingResponseMode, MessagingSurfaceRef, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingAdapter, MessagingBackendBridge } from "./messaging-adapter.js";
import type { MessagingInteractionMapper } from "./interaction-mapper.js";
import type { MessagingNavigationContext } from "./messaging-thread-state.js";
import type { MessagingAttachmentPolicy } from "./messaging-attachment-processor.js";
import type { MessagingOriginalAttachmentStore } from "./messaging-original-attachment-store.js";
import type { PdfAttachmentStore } from "../../pdf/pdf-attachment-store.js";
import type { MessagingTurnAdmission, MessagingQueuedTurnEntry } from "./messaging-turn-admission.js";
import type { MessagingBindingService } from "./messaging-binding-service";
import type { MessagingFullAccessControlsResolver, FullAccessRiskPresentationMode } from "./messaging-inbound-helpers";

export interface MessagingInboundHost {
  readonly commandHandlers: Pick<MessagingCommandHandlers, "handleCommand" | "presentHelp">;
  readonly interactionMapper: Pick<MessagingInteractionMapper, "mapText">;
  readonly callbackHandlers: Pick<MessagingCallbackHandlers, "handleCallback">;
  readonly presentSkillsBrowser: (binding: MessagingBindingRecord, event: MessagingInboundEvent, options?: { pageIndex?: number; query?: string; targetSurface?: MessagingSurfaceRef; }) => Promise<void>;
  readonly handleReviewTextAnswer: (pendingIntent: MessagingPendingIntentRecord, event: MessagingInboundTextEvent) => Promise<boolean>;
  readonly handleQuestionnaireTextAnswer: (pendingIntent: MessagingPendingIntentRecord, event: MessagingInboundTextEvent) => Promise<boolean>;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly newIntentId: (prefix: string) => string;
  readonly cycleToolUpdateMode: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => Promise<void>;
  readonly cycleStreamingResponseMode: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => Promise<void>;
  readonly requirePermission: (event: MessagingInboundEvent, permission: MessagingPermissionId, auditAction: string, opts?: { notify?: boolean; }) => Promise<boolean>;
  readonly requireRemoteScopeForBinding: (event: MessagingInboundEvent, binding: MessagingBindingRecord | undefined, auditAction: string, opts?: { notify?: boolean; }) => Promise<boolean>;
  readonly bindingService: Pick<MessagingBindingService, "notifyBindingChanged" | "renderAutomaticBindingStatus" | "refreshBindingFromInbound" | "bindChannelToThread" | "updateBindingPreferences" | "renderBindingStatus">;
  readonly defaultAgentRouteBinding: (event: MessagingInboundEvent, target: { backend: AppServerBackendKind; threadId: ThreadIdentifier; toolUpdateMode?: MessagingToolUpdateMode; }) => MessagingBindingRecord;
  readonly privateReplyClaims: Pick<MessagingPrivateReplyClaims, "claim" | "complete" | "release">;
  readonly rememberHumanMessagingSource: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => MessagingRequestSource | undefined;
  readonly turnAdmission: Pick<MessagingTurnAdmission, "append" | "markStarting" | "clearStarting" | "isStarting" | "enqueue">;
  readonly completePrivateReplyContinuation: (bindingId: string) => Promise<void>;
  readonly clearPendingSkillSelection: (binding: MessagingBindingRecord) => Promise<MessagingBindingRecord>;
  readonly filterBindingsForChannel: (bindings: MessagingBindingRecord[]) => MessagingBindingRecord[];
  readonly buildAgentMessagingOrigin: (params: { binding: MessagingBindingRecord; event?: MessagingInboundEvent; navigation: MessagingNavigationContext; privateResponseRequested?: boolean; }) => Promise<ActiveAgentMessagingOrigin | undefined>;
  readonly startingAgentMessagingOriginsByThreadKey: Pick<Map<string, ActiveAgentMessagingOrigin>, "set" | "get" | "delete">;
  readonly resolveFullAccessControls: () => MessagingFullAccessControls | Promise<MessagingFullAccessControls>;
  readonly deliverFullAccessPolicyError: (binding: MessagingBindingRecord | undefined, event: MessagingInboundEvent | undefined, body: string) => Promise<void>;
  readonly beginTurnPreparationActivity: (binding: MessagingBindingRecord) => { settled: Promise<void>; finish: (started: boolean) => Promise<void>; };
  readonly rememberQueuedAgentMessagingOrigin: (params: { binding: MessagingBindingRecord; event?: MessagingInboundEvent; navigation: MessagingNavigationContext; origin?: ActiveAgentMessagingOrigin; queueEntryId: string; }) => void;
  readonly applySharedQueueNoticeEvent: (key: string, event: QueueNoticeEvent<MessagingQueuedTurnEntry>) => Promise<void>;
  readonly deliverQueuedTurnNotice: (entry: MessagingQueuedTurnEntry) => Promise<void>;
  readonly pdfAttachmentStore: Pick<PdfAttachmentStore, "bindTurn">;
  readonly rememberAgentMessagingOrigin: (params: { binding: MessagingBindingRecord; event?: MessagingInboundEvent; navigation: MessagingNavigationContext; origin?: ActiveAgentMessagingOrigin; turnId: string; }) => void;
  readonly setActiveTurn: (binding: MessagingBindingRecord, activeTurn: MessagingActiveTurnSummary) => void;
  readonly getActiveTurn: (binding: MessagingBindingRecord) => MessagingActiveTurnSummary | undefined;
  readonly signalTurnActivity: (binding: MessagingBindingRecord, activeTurn: MessagingActiveTurnSummary, options?: { force?: boolean; reason?: string; refreshMs?: number; }) => Promise<void>;
  readonly reconcileActiveTurnFromThreadStatus: (binding: MessagingBindingRecord, reason: string, threadStatus: string | undefined) => Promise<MessagingActiveTurnSummary | undefined>;
  readonly backendEventRouter: Pick<MessagingBackendEventRouter, "waitForPendingTurnFailureHandlers">;
  readonly observeManagedTopicFromInbound: (event: MessagingInboundEvent) => Promise<void>;
  readonly requireRemoteScope: (event: MessagingInboundEvent, target: FederationTarget | undefined, auditAction: string, opts?: { notify?: boolean; }) => Promise<boolean>;
  readonly loadNewThreadBackendChoices: (event: MessagingInboundEvent) => Promise<{ backends: BackendSummary[]; selectable: BackendSummary[]; } | undefined>;
  readonly deliverSelectedNewThreadBackendUnavailable: (event: MessagingInboundEvent) => Promise<void>;
  readonly resolveNewThreadBackendForSession: (params: { launchpadBackend: AppServerBackendKind; preferredBackend?: string; requirePreferred?: boolean; session?: MessagingBrowseSessionRecord; }, event: MessagingInboundEvent) => Promise<BackendSummary | undefined>;
  readonly ensureNewThreadProjectLaunchpad: (session: MessagingBrowseSessionRecord, _navigation: MessagingNewThreadNavigation, preferredBackend?: AppServerBackendKind) => Promise<{ directory?: MessagingLaunchpadDirectory; navigation: MessagingLaunchpadContext; }>;
  readonly resolveNewThreadToolUpdateMode: (session: MessagingBrowseSessionRecord, directory?: MessagingLaunchpadDirectory) => Promise<MessagingToolUpdateMode>;
  readonly streamingResponsesDefault: boolean;
  readonly resolveFullAccessRiskForSession: (session: MessagingBrowseSessionRecord, event: MessagingInboundEvent, options: NewThreadOptionsSummary) => Promise<"accepted" | "blocked" | "warning">;
  readonly presentFullAccessRiskWarning: (context: FullAccessEscalationContext, event: MessagingInboundEvent, options?: { presentationMode?: FullAccessRiskPresentationMode; }) => Promise<void>;
}

export interface MessagingInboundConfiguration {
  readonly responseModeForConversation?: ((channel: MessagingChannelRef) => Promise<MessagingResponseMode> | MessagingResponseMode);
  readonly inputDebounceMs?: number;
  readonly attachmentPolicy?: Partial<MessagingAttachmentPolicy>;
  readonly originalAttachmentStore?: Pick<MessagingOriginalAttachmentStore, "retain">;
  readonly channel?: MessagingChannelKind;
  readonly pdfAnalysisEnabled?: boolean | (() => boolean | Promise<boolean>);
  readonly fullAccessControlsSource?: "dynamic" | "runtime-snapshot";
  readonly fullAccessControls?: MessagingFullAccessControlsResolver;
  readonly fullAccessPolicyRevision?: (() => number);
}

export interface MessagingInboundContext {
  readonly store: Pick<MessagingStoreLike, "findActivePendingIntentForChannel" | "getBinding" | "deletePendingIntent" | "findActiveBindingForChannel" | "findActiveDefaultAgentAssignmentsForChannel" | "revokeDefaultAgentAssignment" | "revokeDefaultAgentAssignmentsForTarget" | "findActiveBrowseSessionForChannel" | "revokeBinding" | "findActiveBindings" | "deleteBrowseSession" | "upsertBinding">;
  readonly backend: Pick<MessagingBackendBridge, "getThreadAdmissionState" | "ownsTurnQueue" | "supportsMessagingPdfTools" | "startTurn" | "materializeDirectoryLaunchpad" | "startThread" | "getNavigationQueryPage" | "getNavigationLaunchpadConfig" | "ensureDirectoryLaunchpad" | "listBackends">;
  readonly adapter: Pick<MessagingAdapter, "capabilityProfile" | "deliver" | "downloadAttachment">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  readonly config: MessagingInboundConfiguration;
  readonly host: () => MessagingInboundHost;
}
