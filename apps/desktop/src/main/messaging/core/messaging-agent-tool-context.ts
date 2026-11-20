import type { MessagingAccessControl } from "./messaging-access-control";
import type { MessagingPrivateResponses } from "./messaging-private-response-state";
import { type MessagingDeliveryGuard, type AssistantMessageDeliveryIdentity, type ActiveAgentMessagingOrigin, type MessagingControllerLogger } from "./messaging-backend-event-helpers";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { FederatedThreadRef, FederationTarget } from "@pwragent/shared/contracts/federation";
import type { MessagingDynamicToolCategory } from "@pwragent/shared/contracts/rbac";
import type {
  PwrAgentMessagingBoundThreadSummary,
  PwrAgentMessagingRequest,
} from "@pwragent/shared/contracts/messaging-tools";
import type {
  NavigationSelectedDetailRequest,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type { MessagingRequestSource, MessagingRequestStore, MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingChannelKind, MessagingDeliveryResult, MessagingInboundEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { type MessagingOutboundFileAccess } from "./messaging-outbound-file.js";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingAdapter, MessagingBackendBridge } from "./messaging-adapter.js";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import { type MessagingNavigationContext } from "./messaging-thread-state.js";
import type { MessagingToolUpdatePolicy } from "./messaging-tool-update-policy.js";
import type { MessagingOriginalAttachmentStore } from "./messaging-original-attachment-store.js";
import type { PdfAttachmentStore } from "../../pdf/pdf-attachment-store.js";
import type { MessagingPermissionId, RbacResolution } from "@pwragent/shared/contracts/rbac";

export interface MessagingAgentToolHost {
  readonly retainedRequestSource: (context: PwrAgentMessagingRequest["context"]) => MessagingRequestSource | undefined;
  readonly isChannelInScope: (channel: MessagingBindingRecord["channel"] | undefined) => boolean;
  readonly retainedRequestCanCrossInstance: (context: PwrAgentMessagingRequest["context"], source: MessagingRequestSource) => boolean;
  readonly retainedSourceHasPermissions: (source: MessagingRequestSource) => boolean;
  readonly retainedSourceIsAuthorized: (source: MessagingRequestSource, verifyAccess?: boolean) => Promise<boolean | undefined>;
  readonly actorHasPermission: (event: MessagingInboundEvent, permission: MessagingPermissionId) => boolean;
  readonly requireRemoteScope: (event: MessagingInboundEvent, target: FederationTarget | undefined, auditAction: string, opts?: { notify?: boolean; }) => Promise<boolean>;
  readonly bindChannelToThread: (event: MessagingInboundEvent, target: { backend: AppServerBackendKind; federatedThread?: FederatedThreadRef; recordTransition?: boolean; statusPresentation?: MessagingBindingRecord["statusPresentation"]; threadId: ThreadIdentifier; targetKind?: MessagingBindingRecord["targetKind"]; }) => Promise<MessagingBindingRecord>;
  readonly restoreAttachedTurnActivity: (binding: MessagingBindingRecord) => Promise<void>;
  readonly renderBindingStatus: (binding: MessagingBindingRecord, event?: MessagingInboundEvent, navigation?: MessagingNavigationContext) => Promise<MessagingBindingRecord>;
  readonly repostLastAssistantMessageForResume: (binding: MessagingBindingRecord, options?: { important?: boolean; }) => Promise<void>;
  readonly notifyBindingChanged: (reason: string) => void;
  readonly resolveBoundThreadSummary: (binding: MessagingBindingRecord, navigation?: MessagingNavigationContext) => Promise<PwrAgentMessagingBoundThreadSummary | undefined>;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly newIntentId: (prefix: string) => string;
  readonly clearTurnProse: (bindingId: string, turnId: string) => void;
  readonly cancelAssistantStreamsForTurn: (binding: MessagingBindingRecord, turnId: string) => Promise<boolean>;
  readonly cancelWorkingUpdatesForTurn: (binding: MessagingBindingRecord, turnId: string) => Promise<boolean>;
  readonly clearTerminalPrivateResponseActivity: (binding: MessagingBindingRecord, turnId: string) => Promise<void>;
  readonly checkDynamicToolPermission: (params: { backend: AppServerBackendKind; threadId: ThreadIdentifier; turnId?: string; category: MessagingDynamicToolCategory; tool: string; arguments?: Record<string, unknown> | null; }, source?: MessagingRequestSource) => { owns: boolean; allowed: boolean; permission?: string; };
  readonly authorizeRetainedTool: (context: PwrAgentMessagingRequest["context"], check: Parameters<MessagingAccessControl["checkDynamicToolPermission"]>[0]) => Promise<{ owns: boolean; allowed: boolean; permission?: string; }>;
  readonly claimAssistantMessageContentDelivery: (event: AgentEvent, binding: MessagingBindingRecord, text: string, identity?: AssistantMessageDeliveryIdentity) => boolean;
  readonly readExactNavigationThread: (request: Omit<NavigationSelectedDetailRequest, "protocol">) => Promise<NavigationThreadSummary | undefined>;
  readonly activeAgentMessagingOriginsByTurnKey: Pick<ReadonlyMap<string, ActiveAgentMessagingOrigin>, "get">;
  readonly filterBindingsForChannel: (bindings: MessagingBindingRecord[]) => MessagingBindingRecord[];
  readonly resolveActorPermissions: (event: MessagingInboundEvent) => RbacResolution | null;
  readonly desktopActivityLog: () => MessagingActivityStorage | undefined;
}

export interface MessagingAgentToolConfiguration {
  readonly channel?: MessagingChannelKind;
  readonly requestStore?: Pick<MessagingRequestStore, "list" | "destination" | "claimAttachment" | "finishAttachment">;
  readonly outboundFileAccess?: () => MessagingOutboundFileAccess;
  readonly originalAttachmentStore?: Pick<MessagingOriginalAttachmentStore, "list" | "read" | "export">;
}

export interface MessagingAgentToolContext {
  readonly store: Pick<MessagingStoreLike, "getBinding" | "upsertBinding" | "findActiveBindingForChannel" | "findActiveBindingsForThread">;
  readonly backend: Pick<MessagingBackendBridge, "resolveThreadTarget">;
  readonly adapter: Pick<MessagingAdapter, "createManagedConversation" | "setConversationTitle" | "resolvePrivateConversation" | "supportsConversationTitle" | "getManagedConversationRights">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly privateResponses: Pick<MessagingPrivateResponses, "beginTool" | "delivered" | "finishTool">;
  readonly toolUpdatePolicy: Pick<MessagingToolUpdatePolicy, "flush">;
  readonly pdfAttachmentStore: Pick<PdfAttachmentStore, "inspect" | "search" | "render" | "authorizesSource">;
  readonly config: MessagingAgentToolConfiguration;
  readonly now: () => number;
  readonly logger: MessagingControllerLogger;
  readonly host: () => MessagingAgentToolHost;
}
