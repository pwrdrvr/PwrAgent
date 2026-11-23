import type { MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import type { MessagingPermissionId } from "@pwragent/shared/contracts/rbac";
import type { MessagingReviewSubmission } from "./messaging-review-context";
import type { MessagingRequestSource, MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord, MessagingDeliveryResult, MessagingInboundCallbackEvent, MessagingInboundCommandEvent, MessagingInboundEvent, MessagingInboundMediaEvent, MessagingInboundTextEvent, MessagingManagedTopicRecord, MessagingMonitorSubscriptionRecord, MessagingSurfaceRef, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingDefaultAgentScopeKind } from "./messaging-default-agent.js";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter.js";
import type { MessagingTurnInputEvent } from "./messaging-turn-admission.js";
import type { MonitorCommandAction } from "./messaging-command-helpers";

export interface MessagingCommandHost {
  readonly admitBoundAgentTrust: import("./messaging-agent-trust").BoundMessagingAgentTrustAdmission;
  readonly requirePermission: (event: MessagingInboundEvent, permission: MessagingPermissionId, auditAction: string, opts?: { notify?: boolean; }) => Promise<boolean>;
  readonly requireRemoteScopeForBinding: (event: MessagingInboundEvent, binding: MessagingBindingRecord | undefined, auditAction: string, opts?: { notify?: boolean; }) => Promise<boolean>;
  readonly handleStatusCallback: (event: MessagingInboundCallbackEvent, actionId: string) => Promise<void>;
  readonly presentStatus: (event: MessagingInboundEvent) => Promise<void>;
  readonly detachBinding: (event: MessagingInboundEvent) => Promise<void>;
  readonly presentResumeBrowser: (event: MessagingInboundCommandEvent, options?: { cancelDestination?: MessagingBrowseSessionRecord["cancelDestination"]; targetSurface?: MessagingSurfaceRef; }) => Promise<void>;
  readonly presentAgentBrowser: (event: MessagingInboundCommandEvent, options?: { cancelDestination?: MessagingBrowseSessionRecord["cancelDestination"]; targetSurface?: MessagingSurfaceRef; }) => Promise<void>;
  readonly rememberHumanMessagingSource: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => MessagingRequestSource | undefined;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly newIntentId: (prefix: string) => string;
  readonly shouldHandleAmbientSharedMessage: (event: MessagingInboundTextEvent | MessagingInboundMediaEvent, binding?: MessagingBindingRecord) => Promise<boolean>;
  readonly admitTurnInput: (params: { binding: MessagingBindingRecord; event: MessagingTurnInputEvent; }) => Promise<boolean>;
  readonly reviewSupportedForBinding: (binding: MessagingBindingRecord) => Promise<boolean>;
  readonly claudeCodeReviewSupportedForBinding: (binding: MessagingBindingRecord) => Promise<boolean>;
  readonly deliverReviewUnsupported: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => Promise<void>;
  readonly submitMessagingReview: (params: MessagingReviewSubmission) => Promise<void>;
  readonly presentReviewPicker: (binding: MessagingBindingRecord, event: MessagingInboundEvent) => Promise<void>;
  readonly deliverDefaultAgentCommandError: (event: MessagingInboundEvent, body: string) => Promise<void>;
  readonly presentDefaultAgentAssignmentBrowser: (event: MessagingInboundEvent, scopeKind: MessagingDefaultAgentScopeKind) => Promise<void>;
  readonly clearDefaultAgentAssignment: (event: MessagingInboundEvent, scopeKind: MessagingDefaultAgentScopeKind) => Promise<void>;
  readonly presentDefaultAgentStatus: (event: MessagingInboundEvent, options?: { notice?: string; }) => Promise<void>;
  readonly stopMonitoringForChannel: (event: MessagingInboundEvent) => Promise<MessagingMonitorSubscriptionRecord | undefined>;
  readonly enableAndRenderChannelMonitor: (event: MessagingInboundEvent, action?: MonitorCommandAction) => Promise<MessagingMonitorSubscriptionRecord>;
  readonly resolveMonitorControlTopic: (event: MessagingInboundCommandEvent) => Promise<MessagingManagedTopicRecord | undefined>;
  readonly eventForManagedTopic: (event: MessagingInboundEvent, topic: MessagingManagedTopicRecord, args: string[]) => MessagingInboundCommandEvent;
  readonly renderTopicCleanupProposal: (event: MessagingInboundEvent, controlTopic: MessagingManagedTopicRecord) => Promise<void>;
  readonly runTopicMonitorFanout: (event: MessagingInboundEvent, controlTopic: MessagingManagedTopicRecord) => Promise<void>;
  readonly renderTopicControlStatus: (event: MessagingInboundEvent, topic: MessagingManagedTopicRecord) => Promise<void>;
}

export interface MessagingCommandContext {
  readonly store: Pick<MessagingStoreLike, "findActiveBindingForChannel">;
  readonly backend: Pick<MessagingBackendBridge, "createScheduledThreadAction" | "listScheduledThreadActions" | "sendScheduledThreadActionNow" | "cancelScheduledThreadAction" | "updateScheduledThreadAction" | "continueClaudeThreadInNewSession">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly host: () => MessagingCommandHost;
}
