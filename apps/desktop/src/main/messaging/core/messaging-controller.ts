import { MessagingNewThreadWorkflow } from "./messaging-new-thread-workflow";
import type { MessagingNewThreadHost } from "./messaging-new-thread-context";
import { MessagingReviewWorkflow } from "./messaging-review-workflow";
import type { MessagingReviewHost } from "./messaging-review-context";
import { MessagingQueueRecoveries, type MessagingQueuedTurnEntry } from "./messaging-queue-recoveries";
import { MessagingTurns } from "./messaging-turn-state";
import { MessagingAccessControl } from "./messaging-access-control";
import type { MessagingAccessHost } from "./messaging-access-context";
import { MessagingCallbackHandlers } from "./messaging-callback-handlers";
import { isMessagingInteractivePendingRequest } from "./messaging-pending-request";
import type { MessagingCallbackHost } from "./messaging-callback-context";
import { readThreadExecutionModeValue, readAcpRuntimeOptionSource, PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX, ACP_RUNTIME_RISK_ACTION_PREFIX, isSameMessagingSurface, branchPageIndexFromValue, defaultBackendModel, reasoningEffortsForModel, resolveReasoningEffortForModel, readMessagingToolUpdateModeValue, formatDefaultAgentScope, topicChannelRef, findThreadForBinding, type AcpRuntimeRiskWarningContext, type PendingQueueAuditMessage } from "./messaging-callback-helpers";
import { MessagingCommandHandlers } from "./messaging-command-handlers";
import type { MessagingCommandHost } from "./messaging-command-context";
import { messageOriginForInboundEvent, type MonitorCommandAction, readStringValue } from "./messaging-command-helpers";
import { MessagingBackendEventRouter } from "./messaging-backend-event-router";
import type { MessagingBackendEventHost } from "./messaging-backend-event-context";
import { MessagingPrivateResponses } from "./messaging-private-response-state";
import { MessagingPrivateReplyClaims } from "./messaging-private-reply-claims";
import { threadIdForBackendEvent, asPlainRecord, turnIdForBackendEvent, bindingMatchesFederationTarget, federationTargetForBinding, turnQueueUpdateForBackendEvent, threadKeyForBackendEvent, rememberBoundedKey, isTerminalTurnLifecycle, assistantStreamKey, agentMessagingTurnKey, MAX_TRACKED_TURN_PROSE, TYPING_ACTIVITY_REFRESH_MS, type MessagingTaskMonitorLifecycle, type AssistantStreamDelta, type MessagingDeliveryGuard, type MessagingCancellationSignal, type AssistantStreamBuffer, type AssistantMessageDeliveryIdentity, type ActiveAgentMessagingOrigin, type MessagingControllerLogger } from "./messaging-backend-event-helpers";
import { containedMessagingBindingMatches } from "@pwragent/shared";
import { automatedWorkStartedLabel, incomingWorkText } from "./messaging-thread-notifications";
import { codexSpeedOptions, codexSpeedSettings, nextCodexSpeed } from "@pwragent/shared";

import { MessagingBrowseQueryPool } from "./messaging-browse-query-pool";
import type { NavigationQuery } from "@pwragent/shared";
import { readMessagingLaunchpadContext, type MessagingLaunchpadContext, type MessagingNewThreadNavigation } from "./messaging-launchpad-context";
import { rememberBoundedMap } from "../../bounded-map";
import { transitionQueueNotice, type QueueNoticeState, type QueueNoticeEvent } from "@pwragent/owner-core/queue-notice-lifecycle";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFederatedThreadRef, buildThreadIdentityKey, codexAsyncQuestionItemId, federatedThreadIdentityKey, formatCodexAsyncQuestionReply, isAcpBackendId, isAppServerBackendKind, isCodexAsyncQuestionAnswered, isMessagingBindingTargetKind, readProviderResponseBlockNotification, describeProviderResponseBlock, stripCodexGitActionDirectives, summarizeCodexAsyncQuestionReply, type CodexAsyncQuestion, type CodexAsyncQuestionReply } from "@pwragent/shared";
import type { AgentEvent, AppServerTurnInputItem, ThreadIncomingWorkSummary, AppServerBackendKind, AutomationMessagingConversationSnapshot, AutomationRunSourceMetadata, AutomationRunOutputDecision, BackendAcpSessionRuntimeState, AppServerPendingRequestNotification, AppServerThreadMessageOrigin, AppServerToolRequestUserInputNotification, FederatedThreadRef, FederationTarget, HandoffThreadWorkspaceRequest, HandoffThreadWorkspaceResponse, MessagingDynamicToolCategory, MessagingToolUpdateMode, PwrAgentMessagingBoundThreadSummary, PwrAgentMessagingConversationCapabilitiesSummary, PwrAgentMessagingLocationSummary, PwrAgentMessagingManagedConversationSummary, PwrAgentMessagingOutboundAttachmentSummary, PwrAgentMessagingRequest, PwrAgentMessagingResponse, ListMessagingSurfacesResult, NavigationSelectedDetailRequest, NavigationThreadSummary, ThreadExecutionMode, ThreadIdentifier } from "@pwragent/shared";
import type { MessagingRbacPolicyProvider } from "../rbac-policy-service";
import type { MessagingRequestSource, MessagingRequestStore, MessagingStoreLike } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord, MessagingActiveTurnSummary, MessagingApprovalDecision, MessagingChannelKind, MessagingChannelRef, MessagingConfirmationIntent, MessagingDeliveryScope, MessagingDeliveryResult, MessagingInboundCallbackEvent, MessagingInboundCommandEvent, MessagingInboundChannelMetadataUpdate, MessagingInboundEvent, MessagingInboundTextEvent, MessagingImagePart, MessagingAdapterState, MessagingJsonValue, MessagingManagedConversationOperationSupport, MessagingManagedTopicRecord, MessagingMonitorState, MessagingMonitorSubscriptionRecord, MessagingPendingIntentRecord, MessagingPrivateConversationResolveResult, MessagingPrivateReplySource, MessagingQuestionnaireAnswer, MessagingQuestionnaireIntent, MessagingResponseMode, MessagingStreamUpdateIntent, MessagingSurfaceAction, MessagingSurfaceRef, MessagingSurfaceIntent, MessagingTopicCleanupProposalItem, MessagingTopicCleanupProposalRecord } from "@pwragent/messaging-interface";
import { capabilityProfilePageSize, evictStaleStreamAnchors, MESSAGING_CALLBACK_HANDLE_TTL_MS, messagingQuestionnaireAnswerComplete, normalizeMessagingQuestionnaireIntent } from "@pwragent/messaging-interface";
import { buildMonitorStatusIntent, MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT, MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT, MESSAGING_MONITOR_INTERVAL_MS, nextMonitorIntervalMs, nextMonitorThreadLimit, normalizeMonitorIntervalMs, normalizeMonitorThreadLimit, selectMonitorThreads, type MessagingMonitorNavigation, type MessagingMonitorRows } from "./messaging-monitor-card.js";
import { buildMessagingConversationKey } from "./messaging-store.js";
import { resolveMessagingOutboundFile, resolveMessagingOutboundBytes, validateMessagingFileMetadata, type MessagingOutboundFileAccess } from "./messaging-outbound-file.js";
import { resolveScratchProjectsRoots } from "../../app-server/scratch-projects.js";
import { defaultAgentBackendSupport, defaultAgentScopeForChannel, type MessagingDefaultAgentScopeKind } from "./messaging-default-agent.js";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingAdapter, MessagingBackendBridge, MessagingLastAssistantReply, MessagingThreadAdmissionState } from "./messaging-adapter.js";
import { MessagingFederatedThreadTargetError } from "./messaging-adapter.js";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import { buildActivityIntent, buildApprovalIntent, buildAsyncQuestionnaireIntent, buildConfirmationIntent, buildErrorIntent, buildQuestionnaireIntent, buildStatusIntent, buildToolUpdateBatchMessageIntent, buildToolUpdateMessageIntent, buildWorkingCardIntent } from "./messaging-renderer.js";
import { buildArtifactDeliveryIntent, buildArtifactInlineFallbackIntent, type MessagingArtifact, type MessagingArtifactMessageIntent } from "./messaging-artifact-renderer.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import { getMainLogger } from "../../log.js";
import { DeterministicInteractionMapper } from "./deterministic-interaction-mapper.js";
import type { MessagingInteractionMapper } from "./interaction-mapper.js";
import { buildBoundedResumeIntent, isNewThreadLaunchAction, parseResumeCommandArgs, resumeBrowserPageSize } from "./messaging-resume-browser.js";
import { buildStatusAcpRuntimeModePickerIntent, buildHandoffBranchPickerIntent, buildHandoffConfirmationIntent, buildHandoffOverviewIntent, buildHandoffProjectPickerIntent, buildStatusModelPickerIntent, buildStatusPermissionsPickerIntent, buildStatusReasoningPickerIntent, buildStatusResponseModePickerIntent, buildStatusToolUpdateModePickerIntent, formatExecutionModeLabel, handoffRequestFromValue, messagingStreamingResponsesEnabled, messagingToolUpdateModeChoices, nextMessagingStreamingResponseMode, resolveMessagingStreamingResponseMode, resolveMessagingToolUpdateMode, type MessagingWorkspaceHandoffContext } from "./messaging-status-card.js";
import { acpBackendDeclaresExecutionMode, buildMessagingAcpRuntimeModeSummary, messagingAcpRuntimeValueLooksPrivileged } from "./messaging-acp-runtime.js";
import { buildSkillRemovedIntent, buildSkillSelectedIntent, buildSkillsBrowserIntent, buildSkillsSearchPromptIntent, flattenSkillEntries, isSkillsWorkflowIntent, skillSelectionFromValue } from "./messaging-skills-browser.js";
import { resolveMessagingThreadState, type MessagingNavigationContext, type MessagingThreadContext, type MessagingResolvedThreadState } from "./messaging-thread-state.js";
import { summarizeToolActivityFromBackendEvent } from "./messaging-tool-activity.js";
import type { MessagingToolActivity } from "./messaging-tool-activity.js";
import { MessagingToolUpdatePolicy, type MessagingToolUpdatePolicyDelivery } from "./messaging-tool-update-policy.js";
import { isDeferrableDeliveryPriority, MessagingDeliveryBudget, type MessagingDeliveryPriority } from "./messaging-delivery-budget.js";
import { MessagingDeliveryLane, type MessagingDeliveryLaneTicket } from "./messaging-delivery-lane.js";
import { coalesceBackoffMs } from "./messaging-coalesce-backoff.js";
import { type MessagingAttachmentPolicy } from "./messaging-attachment-processor.js";
import { MessagingOriginalAttachmentStore, OriginalAttachmentError, type OriginalAttachmentConsumer } from "./messaging-original-attachment-store.js";
import { PdfAttachmentStore } from "../../pdf/pdf-attachment-store.js";
import { MessagingTurnAdmission, threadKeyForBinding } from "./messaging-turn-admission.js";
import { renderAutomationDecisionForMessaging, renderAutomationOutputForMessaging } from "../../automations/automation-output-decision.js";
import { registerAutomationSourceMessageDeliveryHandler, registerAutomationTargetMessageDeliveryHandler } from "../../automations/automation-action-executor.js";
import { MessagingBindingService } from "./messaging-binding-service";
import type { MessagingBindingHost } from "./messaging-binding-context";
import { threadContextForAdmissionState, normalizeConversationTitle, isDefaultAgentRouteBinding, handoffContextForBinding, type MessagingToolUpdateDefaultModeResolver } from "./messaging-binding-helpers";
import { DEFAULT_INPUT_DEBOUNCE_MS, requestsExplicitPrivateResponse, originalAttachmentActorKey, agentMessagingThreadKey, resolveExecutionModeForThread, type ExecutionModeResolution, truncateText, type MessagingFullAccessControlsResolver } from "./messaging-inbound-helpers";
import { MessagingInboundTurns } from "./messaging-inbound-turns";
import type { MessagingInboundHost } from "./messaging-inbound-context";

const DEFAULT_PENDING_INTENT_TTL_MS = MESSAGING_CALLBACK_HANDLE_TTL_MS;
const TYPING_ACTIVITY_LEASE_MS = 15_000;

type MessagingTurnProseState = {
  latest?: { activityId: string; text: string };
  deliveredIds: Set<string>;
};

export type MessagingWorkingCardState = {
  activities: Map<string, MessagingToolActivity>;
  omittedTaskCount: number;
  sequence: number;
};
const PRIVATE_REPLY_CONTINUATION_TTL_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_TURN_HANDOFF_ERROR =
  "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.";
const messagingControllerLog = getMainLogger("pwragent:messaging");

type MonitorStateOptions = Pick<
  MessagingMonitorState,
  | "intervalMs"
  | "pinnedThreadLimit"
  | "recentThreadLimit"
  | "showLastResponseSnippet"
  | "showStatusLine"
>;

type AutomationTurnMessagingContext = {
  automationName?: string;
  automationRunId?: string;
};

type AgentMessagingOriginResolution =
  | { ok: true; origin: ActiveAgentMessagingOrigin }
  | Extract<PwrAgentMessagingResponse, { ok: false }>;

type AttachTargetResolution =
  | {
      ok: true;
      federatedThread?: FederatedThreadRef;
      thread: NavigationThreadSummary;
    }
  | Extract<PwrAgentMessagingResponse, { ok: false }>;

function attachTargetNotFound(
  backend: AppServerBackendKind,
  threadId: string,
): Extract<PwrAgentMessagingResponse, { ok: false }> {
  return {
    ok: false,
    error: {
      code: "not_found",
      message:
        `Thread ${backend}:${threadId} is not an active attachable thread. `
        + "It may be archived, deleted, or unavailable; restore it in PwrAgent or choose another thread.",
    },
  };
}

function resolveExecutionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: MessagingNavigationContext,
): ExecutionModeResolution {
  return resolveExecutionModeForThread(
    binding,
    findThreadForBinding(navigation, binding),
  );
}

function executionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: MessagingNavigationContext,
): ThreadExecutionMode | undefined {
  return resolveExecutionModeForBinding(binding, navigation).mode;
}

function federationTargetForThread(
  thread: NavigationThreadSummary,
): FederationTarget | undefined {
  return thread.federation?.ref.target.scope === "remote"
    ? thread.federation.ref.target
    : undefined;
}

function threadKeyForNavigationThread(
  thread: NavigationThreadSummary,
): string {
  return thread.federation
    ? federatedThreadIdentityKey(thread.federation.ref)
    : buildThreadIdentityKey(thread.source, thread.id);
}

function readPdfToolString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function readPdfToolPageNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const pageNumbers = value.map(readOptionalPositiveInteger);
  return pageNumbers.every((pageNumber) => pageNumber !== undefined)
    ? pageNumbers as number[]
    : undefined;
}

function pdfToolFailure(error: unknown): Extract<PwrAgentMessagingResponse, { ok: false }> {
  const message = error instanceof Error ? error.message : "PDF attachment could not be read.";
  return {
    ok: false,
    error: {
      code:
        message.startsWith("No PDF attachments") ||
        message.startsWith("That PDF attachment")
          ? "not_found"
          : "invalid_arguments",
      message,
    },
  };
}

export type MessagingControllerDeliveryBudgetEvent = {
  at: number;
  backend?: AppServerBackendKind;
  bindingId?: string;
  federationTarget?: FederationTarget;
  channel: MessagingChannelKind;
  conversation?: MessagingChannelRef["conversation"];
  intentId: string;
  intentKind: MessagingSurfaceIntent["kind"];
  outcome: "deferred" | "dropped";
  priority: MessagingDeliveryPriority;
  reason?: "cool-off" | "slow-mode" | "budget-exhausted" | "missing-scope";
  retryAt?: number;
  scope?: MessagingDeliveryScope;
  slowMode: boolean;
  threadId?: ThreadIdentifier;
};

type DeliveryLaneState = {
  lane?: MessagingDeliveryLane;
  ticket?: MessagingDeliveryLaneTicket;
};

export type MessagingControllerOptions = {
  requestStore?: MessagingRequestStore;
  sourceInstanceId?: string;
  adapter: MessagingAdapter;
  authorizedActorIds: string[];
  /**
   * Per-platform RBAC capability resolver. When absent or not enforcing, the
   * controller runs in legacy-compatible mode: every provider-admitted actor is
   * implicitly Admin (exactly as before RBAC shipped).
   */
  rbacPolicy?: MessagingRbacPolicyProvider;
  automationInboundHandler?: (
    event: Extract<MessagingInboundEvent, { kind: "media" | "text" }>,
  ) => Promise<boolean>;
  /**
   * Tap for the Automations editor live preview. Invoked for every authorized
   * text/media event before trigger matching, regardless of whether a trigger
   * matches, so operators can see what their filter would catch.
   */
  onInboundPreview?: (
    event: Extract<MessagingInboundEvent, { kind: "media" | "text" }>,
  ) => void;
  backend: MessagingBackendBridge;
  channel?: MessagingChannelKind;
  interactionMapper?: MessagingInteractionMapper;
  logger?: MessagingControllerLogger;
  now?: () => number;
  inputDebounceMs?: number;
  pendingIntentTtlMs?: number;
  attachmentPolicy?: Partial<MessagingAttachmentPolicy>;
  pdfAnalysisEnabled?: boolean | (() => boolean | Promise<boolean>);
  store: MessagingStoreLike;
  streamingResponsesDefault?: boolean;
  showStreamingOption?: boolean | (() => boolean | Promise<boolean>);
  responseModeForConversation?: (
    channel: MessagingChannelRef,
  ) => Promise<MessagingResponseMode> | MessagingResponseMode;
  toolUpdateDefaultMode?: MessagingToolUpdateDefaultModeResolver;
  fullAccessControls?: MessagingFullAccessControlsResolver;
  fullAccessControlsSource?: "dynamic" | "runtime-snapshot";
  fullAccessPolicyRevision?: () => number;
  deliveryBudget?: MessagingDeliveryBudget;
  /** Orders deliveries the budget holds back; see MessagingDeliveryLane. */
  deliveryLane?: MessagingDeliveryLane;
  /**
   * The adapter running for this channel after this controller's adapter was
   * replaced. A disposed controller never calls its own, stopped adapter.
   * `now` answers undefined while a restart is still in progress or nothing
   * replaced it; `settled` waits for a restart in progress first.
   */
  replacementAdapter?: {
    now(): MessagingAdapter | undefined;
    settled(): Promise<MessagingAdapter | undefined>;
  };
  sleepUntil?: (retryAt: number, now: () => number) => Promise<void>;
  activityLog?: () => MessagingActivityStorage;
  onDeliveryBudgetEvent?: (event: MessagingControllerDeliveryBudgetEvent) => void;
  onFullAccessPolicyViolation?: (event: {
    actorId: string;
    actorDisplayName?: string;
    backend?: AppServerBackendKind;
    bindingId?: string;
    channel: MessagingChannelRef;
    requestedAction: string;
    threadId?: ThreadIdentifier;
  }) => void | Promise<void>;
  /**
   * Notification hook invoked after any persistent route mutation the
   * controller performs (binding create/refresh/detach or default Agent
   * assignment changes). The runtime supplies a callback
   * that broadcasts a renderer-bound IPC event so the UI re-fetches the
   * navigation snapshot and the binding chip reflects the new state
   * immediately. Best-effort — exceptions thrown by the listener must
   * not abort the controller's mutation flow.
   */
  onBindingChanged?: () => void;
  /**
   * Extra roots the agent may send files from, plus extra private storage
   * roots to refuse. Resolved lazily on each `send_messaging_file` call so
   * starting an adapter never forces heavier singletons into existence.
   */
  outboundFileAccess?: () => MessagingOutboundFileAccess;
  originalAttachmentStore?: MessagingOriginalAttachmentStore;
};

export class MessagingController {
  private readonly backendEventRouter: MessagingBackendEventRouter;
  private readonly accessControl: MessagingAccessControl;
  private readonly capabilityProfile: MessagingCapabilityProfile;
  private readonly deliveredAssistantMessageKeys = new Set<string>();
  /** Turns whose final assistant item already resolved its images, per binding. */
  private readonly finalAssistantImageTurns = new Map<string, true>();
  private readonly assistantStreamBuffers = new Map<string, AssistantStreamBuffer>();
  private readonly assistantStreamDeliveryQueues = new Map<
    string,
    Promise<MessagingDeliveryResult>
  >();
  private readonly assistantStreamCancellationFailures = new Set<string>();
  private readonly assistantStreamCancellationSignals = new Map<
    string,
    MessagingCancellationSignal
  >();
  private readonly workingUpdateCancellationSignals = new Map<
    string,
    MessagingCancellationSignal
  >();
  private readonly workingUpdateDeliveries = new Map<
    string,
    Set<Promise<MessagingDeliveryResult>>
  >();
  private readonly workingUpdateSurfaces = new Map<
    string,
    Map<string, MessagingSurfaceRef>
  >();
  private readonly workingUpdateCancellationFailures = new Set<string>();
  private readonly deliveredThreadNoticeKeys = new Set<string>();
  private readonly automationTurnsByTurnKey = new Map<
    string,
    AutomationTurnMessagingContext
  >();
  private readonly activeAgentMessagingOriginsByTurnKey = new Map<
    string,
    ActiveAgentMessagingOrigin
  >();
  private readonly startingAgentMessagingOriginsByThreadKey = new Map<
    string,
    ActiveAgentMessagingOrigin
  >();
  private readonly privateResponses = new MessagingPrivateResponses();
  private readonly privateReplyClaims = new MessagingPrivateReplyClaims();
  private readonly queuedAgentMessagingOriginsByQueueKey = new Map<
    string,
    ActiveAgentMessagingOrigin
  >();
  private readonly pdfAttachmentStore = new PdfAttachmentStore();
  private readonly deliveredAutomationStartKeys = new Set<string>();
  private readonly deliveredAutomationFinalKeys = new Set<string>();
  private readonly now: () => number;
  private readonly pendingIntentTtlMs: number;
  private readonly pendingRequestPresentations = new Map<string, Promise<void>>();
  private readonly queuedTurnActions = new Set<Promise<void>>();
  private readonly interactionMapper: MessagingInteractionMapper;
  private readonly turns: MessagingTurns;
  private readonly contextUsageSummariesByThreadKey = new Map<string, string>();
  private readonly typingActivityLastSignaledAt = new Map<string, number>();
  private readonly preparingTurnActivity = new Map<string, {
    attempts: Set<symbol>;
    signaled: boolean;
  }>();
  private readonly logger: MessagingControllerLogger;
  private readonly streamingResponsesDefault: boolean;
  private readonly showStreamingOptionConfig:
    | boolean
    | (() => boolean | Promise<boolean>);
  private readonly toolUpdatePolicy: MessagingToolUpdatePolicy;
  // Per-turn in-turn (non-final) prose bookkeeping, keyed by
  // `${bindingId}\0${turnId}`:
  //   - `latest` is the most-recent captured prose block, written before the
  //     Working Updates dial decides delivery so U7 can flush an elicitation's
  //     setup message even when the dial (None) suppressed it.
  //   - `deliveredIds` records which prose activity ids already reached the
  //     channel (individually, in a batch, or via the flush) so the flush stays
  //     idempotent and a later batch does not re-post pre-flushed prose.
  // Bounded so a turn that ends without a clean terminal event to clear it
  // cannot grow the map without limit.
  private readonly turnProse = new Map<string, MessagingTurnProseState>();
  private readonly workingCards = new Map<
    string,
    MessagingWorkingCardState
  >();
  private readonly taskMonitorMessagingOrigins = new Map<
    string,
    { parentTurnId: string; suppressed: boolean }
  >();
  private readonly turnAdmission: MessagingTurnAdmission;
  private readonly queueRecoveries: MessagingQueueRecoveries;
  private readonly sharedQueueNotices = new Map<string, QueueNoticeState<MessagingQueuedTurnEntry>>();
  private readonly sharedQueueNoticeHistory = new Set<string>();
  private readonly monitorTimersByBindingId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly monitorTimersBySubscriptionId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  // Set once dispose() runs. A monitor tick that was already in-flight when
  // dispose() cleared the timer maps would otherwise re-arm a fresh recurring
  // timer at the end of its run (the timer-map `has` guard is false post-clear),
  // resurrecting a timer that keeps touching SQLite after the store is closed.
  // On POSIX a lingering tick is harmless, but on Windows it keeps the WAL file
  // handle open, which blocks the test harness from deleting the temp profile
  // dir. Gate re-scheduling on this flag so a disposed controller stays quiet.
  private disposed = false;
  private stoppedAdapterStub: MessagingAdapter | undefined;
  private readonly browseRenderGenerations = new Map<string, symbol>();
  private readonly browseQueryPool = new MessagingBrowseQueryPool((request) => {
    const backend = this.options.backend;
    if (!backend.getNavigationQueryPage) throw new Error("Upgrade this instance to support bounded messaging navigation.");
    return backend.getNavigationQueryPage(request);
  }, () => this.now());
  private readonly progressiveBrowseByConversation = new Map<string, symbol>();
  private readonly deliveryBudget?: MessagingDeliveryBudget;
  /**
   * Per-thread map of the most-recent "permissions queued" audit message
   * we posted to each bound conversation. Cleared when the queue resolves
   * (cancelled or applied) and we successfully edit the messages in
   * place. Keyed by `buildThreadIdentityKey`.
   */
  private readonly pendingQueueAuditMessages = new Map<
    string,
    PendingQueueAuditMessage
  >();
  private readonly unregisterAutomationSourceMessageDeliveryHandler: () => void;
  private readonly unregisterAutomationTargetMessageDeliveryHandler: () => void;

  private readonly inboundTurns: MessagingInboundTurns;
  private inboundHostPorts?: MessagingInboundHost;

  private readonly commandHandlers: MessagingCommandHandlers;
  private commandHostPorts?: MessagingCommandHost;

  private readonly bindingService: MessagingBindingService;
  private bindingHostPorts?: MessagingBindingHost;
  private readonly callbackHandlers: MessagingCallbackHandlers;
  private callbackHostPorts?: MessagingCallbackHost;

  private readonly newThreadWorkflow: MessagingNewThreadWorkflow;
  private newThreadHostPorts?: MessagingNewThreadHost;
  private readonly reviewWorkflow: MessagingReviewWorkflow;
  private reviewHostPorts?: MessagingReviewHost;

  constructor(private readonly options: MessagingControllerOptions) {
    const readStore = () => this.options.store;
    const readNow = () => this.now;
    const readLogger = () => this.logger;
    this.turns = new MessagingTurns();
    this.queueRecoveries = new MessagingQueueRecoveries({ get now() { return readNow(); } });
    this.backendEventRouter = new MessagingBackendEventRouter({
      get store() { return readStore(); },
      get now() { return readNow(); },
      get logger() { return readLogger(); },
      host: () => this.backendEventHost(),
    });
    const readBackend = () => this.options.backend;
    const readCapabilityProfile = () => this.capabilityProfile;
    const readPendingIntentTtl = () => this.pendingIntentTtlMs;
    const readStreamingDefault = () => this.streamingResponsesDefault;
    this.newThreadWorkflow = new MessagingNewThreadWorkflow({
      get store() { return readStore(); },
      get backend() { return readBackend(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      get pendingIntentTtlMs() { return readPendingIntentTtl(); },
      get streamingResponsesDefault() { return readStreamingDefault(); },
      now: () => this.now(),
      get logger() { return readLogger(); },
      host: () => this.newThreadHost(),
    });
    this.reviewWorkflow = new MessagingReviewWorkflow({
      get store() { return readStore(); },
      get backend() { return readBackend(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      now: () => this.now(),
      get logger() { return readLogger(); },
      host: () => this.reviewHost(),
    });
    this.commandHandlers = new MessagingCommandHandlers({
      get store() { return readStore(); },
      get backend() { return readBackend(); },
      get now() { return readNow(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      host: () => this.commandHost(),
    });
    const readAdapter = () => this.adapter;
    this.callbackHandlers = new MessagingCallbackHandlers({
      get store() { return readStore(); },
      get backend() { return readBackend(); },
      get adapter() { return readAdapter(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      get now() { return readNow(); },
      get logger() { return readLogger(); },
      host: () => this.callbackHost(),
    });
    const readBindingConfig = () => this.options;
    this.bindingService = new MessagingBindingService({
      get store() { return readStore(); },
      get backend() { return readBackend(); },
      get adapter() { return readAdapter(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      now: () => this.now(),
      get logger() { return readLogger(); },
      get config() { return readBindingConfig(); },
      host: () => this.bindingHost(),
    });
    const readInboundConfig = () => this.options;
    this.inboundTurns = new MessagingInboundTurns({
      get store() { return readStore(); },
      get backend() { return readBackend(); },
      get adapter() { return readAdapter(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      now: () => this.now(),
      get logger() { return readLogger(); },
      get config() { return readInboundConfig(); },
      host: () => this.inboundHost(),
    });
    const readAccessConfig = () => this.options;
    this.accessControl = new MessagingAccessControl({
      get store() { return readStore(); },
      get adapter() { return readAdapter(); },
      get capabilityProfile() { return readCapabilityProfile(); },
      now: () => this.now(),
      get logger() { return readLogger(); },
      get config() { return readAccessConfig(); },
      host: () => this.accessHost(),
    }, options.authorizedActorIds);
    this.capabilityProfile = options.adapter.capabilityProfile;
    this.now = options.now ?? Date.now;
    this.pendingIntentTtlMs =
      options.pendingIntentTtlMs ?? DEFAULT_PENDING_INTENT_TTL_MS;
    this.interactionMapper = options.interactionMapper ?? new DeterministicInteractionMapper();
    this.deliveryBudget = options.deliveryBudget;
    this.logger = options.logger ?? messagingControllerLog;
    this.streamingResponsesDefault = options.streamingResponsesDefault ?? false;
    this.showStreamingOptionConfig = options.showStreamingOption ?? false;
    this.turnAdmission = new MessagingTurnAdmission({
      debounceMs: options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS,
      onBundleReady: async (bundle) => {
        await this.inboundTurns.handleAdmittedTurnBundle(bundle);
      },
    });
    this.toolUpdatePolicy = new MessagingToolUpdatePolicy({
      now: this.now,
      onBatchReady: async (delivery) => {
        await this.deliverToolUpdateDelivery(delivery);
      },
    });
    this.unregisterAutomationSourceMessageDeliveryHandler =
      registerAutomationSourceMessageDeliveryHandler((params) =>
        this.deliverAutomationSourceMessage(params),
      );
    this.unregisterAutomationTargetMessageDeliveryHandler =
      registerAutomationTargetMessageDeliveryHandler((params) =>
        this.deliverAutomationTargetMessage(params),
      );
  }

  async handlePwrAgentMessagingRequest(
    request: PwrAgentMessagingRequest,
    receivedFile?: Uint8Array,
    consumeOriginal?: OriginalAttachmentConsumer,
  ): Promise<PwrAgentMessagingResponse> {
    switch (request.operation) {
      case "list_messaging_attachments":
      case "export_messaging_attachment":
        return await this.handleOriginalAttachmentRequest(request, consumeOriginal);
      case "list_messaging_surfaces":
        return await this.listRetainedMessagingSurfaces(request);
      case "attach_thread_to_surface":
        return await this.attachThreadToRetainedSurface(request);
      case "get_current_location":
      case "get_current_messaging_surface": {
        const origin = await this.resolveAgentMessagingOrigin(request.context);
        if (!origin.ok) {
          return origin;
        }
        return {
          ok: true,
          data: {
            location: await this.summarizeAgentMessagingLocation(origin.origin),
          },
        };
      }
      case "rename_current_messaging_conversation":
        return await this.renameCurrentMessagingConversationFromAgentMessagingOrigin(
          request,
        );
      case "send_private_response":
        return await this.sendPrivateResponseFromAgentMessagingOrigin(request);
      case "send_messaging_file":
        return await this.sendMessagingFileFromAgentMessagingOrigin(request, receivedFile);
      case "attach_thread_here":
        return await this.attachThreadHereFromAgentMessagingOrigin(request);
      case "inspect_messaging_pdfs":
        return await this.inspectMessagingPdfsFromAgentMessagingOrigin(request);
      case "search_messaging_pdf_text":
        return await this.searchMessagingPdfTextFromAgentMessagingOrigin(request);
      case "render_messaging_pdf_pages":
        return await this.renderMessagingPdfPagesFromAgentMessagingOrigin(request);
    }
  }

  async startMonitoringForEnabledBindings(): Promise<void> {
    await this.inboundTurns.cleanupExpiredPrivateReplyContinuations();
    if (this.options.channel) {
      const subscriptions =
        await this.options.store.findActiveMonitorSubscriptionsForChannelKind({
          channel: this.options.channel,
        });
      for (const subscription of subscriptions) {
        if (subscription.monitor.enabled) {
          await this.runMonitorSubscriptionTick(subscription.id);
        }
      }
    }

    const backends = await this.resolveMonitorBackendKinds();
    for (const backend of backends) {
      const bindings = this.filterBindingsForChannel(
        await this.options.store.findActiveBindingsForBackend({ backend }),
      );
      for (const binding of bindings) {
        if (binding.monitor?.enabled) {
          await this.runMonitorTick(binding.id);
        }
      }
    }
  }

  private accessHost(): MessagingAccessHost {
    const readController = () => this;
    return {
      desktopActivityLog: (...args) => this.desktopActivityLog(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      get activeAgentMessagingOriginsByTurnKey() { return readController().activeAgentMessagingOriginsByTurnKey; },
      storePendingIntent: (...args) => this.storePendingIntent(...args),
      isChannelInScope: (...args) => this.isChannelInScope(...args),
    };
  }

  async handleInboundEvent(event: MessagingInboundEvent): Promise<void> {
    if (!this.accessControl.authorizeInboundAdmission(event)) {
      // In enforcing mode this fires for actors with no permission-granting
      // role (default-deny); record it so operators can see who was inert.
      if (this.options.rbacPolicy?.isEnforcing()) {
        this.accessControl.recordCapabilityDenied(event, "(admission)", [], "admission");
      }
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("unauthorized"),
          createdAt: this.now(),
          title: "Not authorized",
          body: "This channel user is not authorized to control PwrAgent.",
          recoverable: false,
        }),
        undefined,
        event,
      );
      return;
    }
    // Marked past the authorization gate, not at the door. An unauthorized
    // actor's traffic is not a turn anyone is timing, and marking it would let
    // a burst of rejected events push the entries this map exists to hold out
    // of it.
    this.inboundTurns.markAdmissionStage(event, "handled");
    // An actor's next action owns the surface. Late browse arrivals must not
    // overwrite a selection, cancellation, query edit, or a newer browser.
    this.progressiveBrowseByConversation.delete(buildMessagingConversationKey(event.channel));

    // Breadcrumb self-healing and managed-topic observation are optional UX
    // bookkeeping for turn input. Start them from this lifecycle boundary, but
    // never charge their SQLite reads/writes to accepted reply routing. Control
    // events retain ordering because commands such as `/monitor topics` can
    // intentionally promote an observed topic to owned state.
    if (event.kind === "text" || event.kind === "media") {
      void this.inboundTurns.refreshInboundMetadata(event);
    } else {
      await this.inboundTurns.refreshInboundMetadata(event);
    }

    if (event.kind === "command") {
      await this.commandHandlers.handleCommand(event);
      return;
    }

    if (event.kind === "callback") {
      await this.callbackHandlers.handleCallback(event);
      return;
    }

    if (event.kind === "text" || event.kind === "media") {
      try {
        this.options.onInboundPreview?.(event);
      } catch (error) {
        this.logger.debug?.("messaging inbound preview tap failed", {
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (
      (event.kind === "text" || event.kind === "media") &&
      this.options.automationInboundHandler
    ) {
      const automationMatched = await this.inboundTurns.measureHandledToRoutedSubspan(
        event,
        "handledAutomationInboundMs",
        async () => await this.options.automationInboundHandler?.(event) ?? false,
      );
      if (automationMatched) {
        return;
      }
    }

    if (event.kind === "media") {
      await this.inboundTurns.handleMedia(event);
      return;
    }

    if (event.kind === "text") {
      await this.inboundTurns.handleText(event);
    }
  }

  async handleInboundChannelMetadata(
    update: MessagingInboundChannelMetadataUpdate,
  ): Promise<void> {
    try {
      await this.bindingService.refreshBindingChannelMetadata(
        update.channel,
        update.routingState,
        update.observedAt,
      );
    } catch (error) {
      this.logger.debug?.("messaging inbound metadata enrichment failed", {
        eventId: update.eventId,
        platform: update.channel.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async deliverAutomationSourceMessage(params: {
    broadcast?: boolean;
    destination: "source_thread" | "source_channel";
    intentId: string;
    source: AutomationRunSourceMetadata;
    text: string;
  }): Promise<{ message?: string; ok: boolean; unsupported?: boolean; errorMessage?: string }> {
    if (
      this.options.channel &&
      this.options.channel !== params.source.conversation.channel
    ) {
      return {
        ok: false,
        unsupported: true,
        errorMessage: "Source-message delivery belongs to another provider.",
      };
    }
    const event = messagingEventFromAutomationSource(params.source);
    const result = await this.deliver(
      {
        id: params.intentId,
        kind: "message",
        createdAt: this.now(),
        role: "assistant",
        delivery: {
          sourceRelative: params.destination,
          broadcastThreadReply: params.broadcast,
        },
        parts: [
          {
            type: "text",
            text: params.text,
            markdown: "markdown",
          },
        ],
      },
      undefined,
      event,
    );
    return {
      ok:
        result.outcome === "presented" ||
        result.outcome === "presented_new" ||
        result.outcome === "updated" ||
        result.outcome === "signaled",
      unsupported: result.outcome === "unsupported",
      message: result.outcome,
      errorMessage: result.errorMessage,
    };
  }

  /**
   * Deliver an automation result to an operator-chosen conversation that may
   * differ from (or have no) inbound source. Routed to the controller whose
   * provider matches the target; others report unsupported so the executor can
   * try the next registered handler.
   */
  async deliverAutomationTargetMessage(params: {
    intentId: string;
    target: AutomationMessagingConversationSnapshot;
    text: string;
  }): Promise<{ message?: string; ok: boolean; unsupported?: boolean; errorMessage?: string }> {
    if (this.options.channel && this.options.channel !== params.target.channel) {
      return {
        ok: false,
        unsupported: true,
        errorMessage: "Messaging target belongs to another provider.",
      };
    }
    const event: MessagingInboundTextEvent = {
      id: params.intentId,
      kind: "text",
      actor: { platformUserId: "pwragent-automation", isBot: true },
      channel: {
        channel: params.target.channel,
        conversation: {
          id: params.target.conversationId,
          kind: params.target.conversationKind ?? "channel",
          parentId: params.target.parentId,
          title: params.target.title,
          parentTitle: params.target.parentTitle,
          ancestorTitle: params.target.ancestorTitle,
        },
      },
      receivedAt: this.now(),
      text: "",
    };
    if (params.target.recipientUserId) {
      const resolve = this.adapter.resolveDirectConversation
        ?.bind(this.adapter);
      if (!resolve) {
        return {
          ok: false,
          unsupported: true,
          errorMessage: "Direct-message recipient resolution is unavailable.",
        };
      }
      try {
        const resolved = await resolve(params.target.recipientUserId);
        if (resolved.outcome !== "resolved" || !resolved.conversation) {
          return {
            ok: false,
            unsupported: resolved.outcome === "unsupported",
            errorMessage: resolved.errorMessage ?? "Could not resolve direct-message recipient.",
          };
        }
        event.channel = { channel: params.target.channel, conversation: resolved.conversation };
        event.routingState = resolved.routingState;
      } catch (error) {
        return {
          ok: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const result = await this.deliver(
      {
        id: params.intentId,
        kind: "message",
        createdAt: this.now(),
        role: "assistant",
        parts: [
          {
            type: "text",
            text: params.text,
            markdown: "markdown",
          },
        ],
      },
      undefined,
      event,
    );
    return {
      ok:
        result.outcome === "presented" ||
        result.outcome === "presented_new" ||
        result.outcome === "updated" ||
        result.outcome === "signaled",
      unsupported: result.outcome === "unsupported",
      message: result.outcome,
      errorMessage: result.errorMessage,
    };
  }

  private backendEventPorts?: MessagingBackendEventHost;

  private inboundHost(): MessagingInboundHost {
    const readController = () => this;
    return this.inboundHostPorts ??= {
      get commandHandlers() { return readController().commandHandlers; },
      get interactionMapper() { return readController().interactionMapper; },
      get callbackHandlers() { return readController().callbackHandlers; },
      presentSkillsBrowser: (...args) => this.presentSkillsBrowser(...args),
      handleReviewTextAnswer: (...args) => this.reviewWorkflow.handleReviewTextAnswer(...args),
      handleQuestionnaireTextAnswer: (...args) => this.handleQuestionnaireTextAnswer(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      cycleToolUpdateMode: (...args) => this.cycleToolUpdateMode(...args),
      cycleStreamingResponseMode: (...args) => this.cycleStreamingResponseMode(...args),
      requirePermission: (...args) => this.accessControl.requirePermission(...args),
      requireRemoteScopeForBinding: (...args) => this.accessControl.requireRemoteScopeForBinding(...args),
      get bindingService() { return readController().bindingService; },
      defaultAgentRouteBinding: (...args) => this.defaultAgentRouteBinding(...args),
      get privateReplyClaims() { return readController().privateReplyClaims; },
      rememberHumanMessagingSource: (...args) => this.rememberHumanMessagingSource(...args),
      get turnAdmission() { return readController().turnAdmission; },
      completePrivateReplyContinuation: (...args) => this.completePrivateReplyContinuation(...args),
      clearPendingSkillSelection: (...args) => this.clearPendingSkillSelection(...args),
      filterBindingsForChannel: (...args) => this.filterBindingsForChannel(...args),
      buildAgentMessagingOrigin: (...args) => this.buildAgentMessagingOrigin(...args),
      get startingAgentMessagingOriginsByThreadKey() { return readController().startingAgentMessagingOriginsByThreadKey; },
      resolveFullAccessControls: (...args) => this.accessControl.resolveFullAccessControls(...args),
      deliverFullAccessPolicyError: (...args) => this.accessControl.deliverFullAccessPolicyError(...args),
      beginTurnPreparationActivity: (...args) => this.beginTurnPreparationActivity(...args),
      rememberQueuedAgentMessagingOrigin: (...args) => this.rememberQueuedAgentMessagingOrigin(...args),
      applySharedQueueNoticeEvent: (...args) => this.applySharedQueueNoticeEvent(...args),
      deliverQueuedTurnNotice: (...args) => this.deliverQueuedTurnNotice(...args),
      get pdfAttachmentStore() { return readController().pdfAttachmentStore; },
      rememberAgentMessagingOrigin: (...args) => this.rememberAgentMessagingOrigin(...args),
      setActiveTurn: (...args) => this.setActiveTurn(...args),
      acceptStartedTurn: (...args) => this.turns.accept(...args),
      getActiveTurn: (...args) => this.getActiveTurn(...args),
      signalTurnActivity: (...args) => this.signalTurnActivity(...args),
      reconcileActiveTurnFromThreadStatus: (...args) => this.reconcileActiveTurnFromThreadStatus(...args),
      get backendEventRouter() { return readController().backendEventRouter; },
      observeManagedTopicFromInbound: (...args) => this.observeManagedTopicFromInbound(...args),
      requireRemoteScope: (...args) => this.accessControl.requireRemoteScope(...args),
      loadNewThreadBackendChoices: (...args) => this.newThreadWorkflow.loadNewThreadBackendChoices(...args),
      deliverSelectedNewThreadBackendUnavailable: (...args) => this.newThreadWorkflow.deliverSelectedNewThreadBackendUnavailable(...args),
      resolveNewThreadBackendForSession: (...args) => this.newThreadWorkflow.resolveNewThreadBackendForSession(...args),
      ensureNewThreadProjectLaunchpad: (...args) => this.newThreadWorkflow.ensureNewThreadProjectLaunchpad(...args),
      resolveNewThreadToolUpdateMode: (...args) => this.newThreadWorkflow.resolveNewThreadToolUpdateMode(...args),
      get streamingResponsesDefault() { return readController().streamingResponsesDefault; },
      resolveFullAccessRiskForSession: (...args) => this.accessControl.resolveFullAccessRiskForSession(...args),
      presentFullAccessRiskWarning: (...args) => this.accessControl.presentFullAccessRiskWarning(...args),
    };
  }

  private newThreadHost(): MessagingNewThreadHost {
    return this.newThreadHostPorts ??= {
      resolveToolUpdateDefaultMode: (...args) => this.bindingService.resolveToolUpdateDefaultMode(...args),
      resolveShowStreamingOption: (...args) => this.bindingService.resolveShowStreamingOption(...args),
      requireRemoteScope: (...args) => this.accessControl.requireRemoteScope(...args),
      resolveFullAccessControls: (...args) => this.accessControl.resolveFullAccessControls(...args),
      ensureFullAccessEscalationAllowed: (...args) => this.accessControl.ensureFullAccessEscalationAllowed(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      deliverInvalidBrowseSelection: (...args) => this.deliverInvalidBrowseSelection(...args),
      storePendingIntent: (...args) => this.storePendingIntent(...args),
      getBackendSummary: (...args) => this.getBackendSummary(...args),
      ensureAcpRuntimeModeAllowed: (...args) => this.ensureAcpRuntimeModeAllowed(...args),
    };
  }

  private reviewHost(): MessagingReviewHost {
    return this.reviewHostPorts ??= {
      readBoundWorkspaceContext: (...args) => this.readBoundWorkspaceContext(...args),
      storePendingIntent: (...args) => this.storePendingIntent(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      getBackendSummary: (...args) => this.getBackendSummary(...args),
      readBoundThreadConfiguration: (...args) => this.readBoundThreadConfiguration(...args),
    };
  }

  private commandHost(): MessagingCommandHost {
    return this.commandHostPorts ??= {
      requirePermission: (...args) => this.accessControl.requirePermission(...args),
      requireRemoteScopeForBinding: (...args) => this.accessControl.requireRemoteScopeForBinding(...args),
      handleStatusCallback: (...args) => this.callbackHandlers.handleStatusCallback(...args),
      presentStatus: (...args) => this.presentStatus(...args),
      detachBinding: (...args) => this.bindingService.detachBinding(...args),
      presentResumeBrowser: (...args) => this.presentResumeBrowser(...args),
      presentAgentBrowser: (...args) => this.presentAgentBrowser(...args),
      rememberHumanMessagingSource: (...args) => this.rememberHumanMessagingSource(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      shouldHandleAmbientSharedMessage: (...args) => this.inboundTurns.shouldHandleAmbientSharedMessage(...args),
      admitTurnInput: (...args) => this.inboundTurns.admitTurnInput(...args),
      reviewSupportedForBinding: (...args) => this.reviewWorkflow.reviewSupportedForBinding(...args),
      deliverReviewUnsupported: (...args) => this.reviewWorkflow.deliverReviewUnsupported(...args),
      submitMessagingReview: (...args) => this.reviewWorkflow.submitMessagingReview(...args),
      presentReviewPicker: (...args) => this.reviewWorkflow.presentReviewPicker(...args),
      deliverDefaultAgentCommandError: (...args) => this.deliverDefaultAgentCommandError(...args),
      presentDefaultAgentAssignmentBrowser: (...args) => this.presentDefaultAgentAssignmentBrowser(...args),
      clearDefaultAgentAssignment: (...args) => this.clearDefaultAgentAssignment(...args),
      presentDefaultAgentStatus: (...args) => this.presentDefaultAgentStatus(...args),
      stopMonitoringForChannel: (...args) => this.stopMonitoringForChannel(...args),
      enableAndRenderChannelMonitor: (...args) => this.enableAndRenderChannelMonitor(...args),
      resolveMonitorControlTopic: (...args) => this.resolveMonitorControlTopic(...args),
      eventForManagedTopic: (...args) => this.eventForManagedTopic(...args),
      renderTopicCleanupProposal: (...args) => this.renderTopicCleanupProposal(...args),
      runTopicMonitorFanout: (...args) => this.runTopicMonitorFanout(...args),
      renderTopicControlStatus: (...args) => this.renderTopicControlStatus(...args),
    };
  }

  private bindingHost(): MessagingBindingHost {
    const readController = () => this;
    return this.bindingHostPorts ??= {
      filterBindingsForChannel: (...args) => this.filterBindingsForChannel(...args),
      storePendingIntent: (...args) => this.storePendingIntent(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      readBoundNavigationThread: (...args) => this.readBoundNavigationThread(...args),
      getActiveTurn: (...args) => this.getActiveTurn(...args),
      disableChannelMonitorSubscription: (...args) => this.disableChannelMonitorSubscription(...args),
      signalTurnActivity: (...args) => this.signalTurnActivity(...args),
      flushToolUpdatesForBinding: (...args) => this.flushToolUpdatesForBinding(...args),
      stopMonitoringForBinding: (...args) => this.stopMonitoringForBinding(...args),
      isChannelInScope: (...args) => this.isChannelInScope(...args),
      get showStreamingOptionConfig() { return readController().showStreamingOptionConfig; },
      contextUsageSummaryForBinding: (...args) => this.contextUsageSummaryForBinding(...args),
      responseModeForConversation: (...args) => this.inboundTurns.responseModeForConversation(...args),
      reconcileActiveTurnFromBackendStatus: (...args) => this.reconcileActiveTurnFromBackendStatus(...args),
      getBackendSummary: (...args) => this.getBackendSummary(...args),
      resolveFullAccessControls: (...args) => this.accessControl.resolveFullAccessControls(...args),
      get streamingResponsesDefault() { return readController().streamingResponsesDefault; },
      requireRemoteScope: (...args) => this.accessControl.requireRemoteScope(...args),
      desktopActivityLog: (...args) => this.desktopActivityLog(...args),
    };
  }

  private callbackHost(): MessagingCallbackHost {
    const readController = () => this;
    return this.callbackHostPorts ??= {
      get commandHandlers() { return readController().commandHandlers; },
      presentDefaultAgentAssignmentBrowser: (...args) => this.presentDefaultAgentAssignmentBrowser(...args),
      clearDefaultAgentAssignment: (...args) => this.clearDefaultAgentAssignment(...args),
      requireRemoteScope: (...args) => this.accessControl.requireRemoteScope(...args),
      readExactNavigationThread: (...args) => this.readExactNavigationThread(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      requirePermission: (...args) => this.accessControl.requirePermission(...args),
      canResumeFullAccessThreads: (...args) => this.accessControl.canResumeFullAccessThreads(...args),
      deliverFullAccessPolicyError: (...args) => this.accessControl.deliverFullAccessPolicyError(...args),
      bindChannelToThread: (...args) => this.bindingService.bindChannelToThread(...args),
      renderBindingStatus: (...args) => this.bindingService.renderBindingStatus(...args),
      repostLastAssistantMessageForResume: (...args) => this.repostLastAssistantMessageForResume(...args),
      submitApprovalAction: (...args) => this.submitApprovalAction(...args),
      retireApprovalIntent: (...args) => this.retireApprovalIntent(...args),
      resumeBindingForPendingIntent: (...args) => this.resumeBindingForPendingIntent(...args),
      handleQuestionnaireAction: (...args) => this.handleQuestionnaireAction(...args),
      handleReviewAction: (...args) => this.reviewWorkflow.handleReviewAction(...args),
      get turnAdmission() { return readController().turnAdmission; },
      isDisposed: () => this.disposed,
      get queueRecoveries() { return readController().queueRecoveries; },
      get sharedQueueNotices() { return readController().sharedQueueNotices; },
      requireRemoteScopeForBinding: (...args) => this.accessControl.requireRemoteScopeForBinding(...args),
      startPreparedInput: (...args) => this.inboundTurns.startPreparedInput(...args),
      retireQueuedTurnNotice: (...args) => this.retireQueuedTurnNotice(...args),
      trackQueuedTurnAction: (...args) => this.trackQueuedTurnAction(...args),
      resolveSteerableActiveTurn: (...args) => this.resolveSteerableActiveTurn(...args),
      deliverQueuedTurnNotice: (...args) => this.deliverQueuedTurnNotice(...args),
      applySharedQueueNoticeEvent: (...args) => this.applySharedQueueNoticeEvent(...args),
      renderResumeBrowser: (...args) => this.renderResumeBrowser(...args),
      resolveNewThreadBackendForSession: (...args) => this.newThreadWorkflow.resolveNewThreadBackendForSession(...args),
      retireBrowseSession: (...args) => this.retireBrowseSession(...args),
      deliverInvalidBrowseSelection: (...args) => this.deliverInvalidBrowseSelection(...args),
      startNewThreadFromProject: (...args) => this.newThreadWorkflow.startNewThreadFromProject(...args),
      updateNewThreadStickySettings: (...args) => this.newThreadWorkflow.updateNewThreadStickySettings(...args),
      presentNewThreadPromptGate: (...args) => this.newThreadWorkflow.presentNewThreadPromptGate(...args),
      presentNewThreadBranchPicker: (...args) => this.newThreadWorkflow.presentNewThreadBranchPicker(...args),
      getBackendSummary: (...args) => this.getBackendSummary(...args),
      get streamingResponsesDefault() { return readController().streamingResponsesDefault; },
      presentNewThreadAcpRuntimeModePicker: (...args) => this.newThreadWorkflow.presentNewThreadAcpRuntimeModePicker(...args),
      presentNewThreadPermissionsPicker: (...args) => this.newThreadWorkflow.presentNewThreadPermissionsPicker(...args),
      setNewThreadPermissions: (...args) => this.newThreadWorkflow.setNewThreadPermissions(...args),
      presentNewThreadEnvironmentPicker: (...args) => this.newThreadWorkflow.presentNewThreadEnvironmentPicker(...args),
      setNewThreadEnvironment: (...args) => this.newThreadWorkflow.setNewThreadEnvironment(...args),
      setNewThreadAcpRuntimeMode: (...args) => this.newThreadWorkflow.setNewThreadAcpRuntimeMode(...args),
      ensureNewThreadProjectLaunchpad: (...args) => this.newThreadWorkflow.ensureNewThreadProjectLaunchpad(...args),
      resolveNewThreadToolUpdateMode: (...args) => this.newThreadWorkflow.resolveNewThreadToolUpdateMode(...args),
      presentNewThreadWorkingUpdatesPicker: (...args) => this.newThreadWorkflow.presentNewThreadWorkingUpdatesPicker(...args),
      presentNewThreadBackendPicker: (...args) => this.newThreadWorkflow.presentNewThreadBackendPicker(...args),
      presentNewThreadModelPicker: (...args) => this.newThreadWorkflow.presentNewThreadModelPicker(...args),
      presentNewThreadReasoningPicker: (...args) => this.newThreadWorkflow.presentNewThreadReasoningPicker(...args),
      deliverDefaultAgentCommandError: (...args) => this.deliverDefaultAgentCommandError(...args),
      loadDefaultAgentBackendSummaries: (...args) => this.inboundTurns.loadDefaultAgentBackendSummaries(...args),
      notifyBindingChanged: (...args) => this.bindingService.notifyBindingChanged(...args),
      presentDefaultAgentStatus: (...args) => this.presentDefaultAgentStatus(...args),
      ensureFullAccessEscalationAllowed: (...args) => this.accessControl.ensureFullAccessEscalationAllowed(...args),
      updateBindingPreferences: (...args) => this.bindingService.updateBindingPreferences(...args),
      stopMonitoringForChannel: (...args) => this.stopMonitoringForChannel(...args),
      enableAndRenderChannelMonitor: (...args) => this.enableAndRenderChannelMonitor(...args),
      deliverInvalidTopicApproval: (...args) => this.deliverInvalidTopicApproval(...args),
      getActiveTurn: (...args) => this.getActiveTurn(...args),
      signalTurnActivity: (...args) => this.signalTurnActivity(...args),
      detachBinding: (...args) => this.bindingService.detachBinding(...args),
      rememberHumanMessagingSource: (...args) => this.rememberHumanMessagingSource(...args),
      dismissActiveSkillsWorkflow: (...args) => this.dismissActiveSkillsWorkflow(...args),
      clearActiveBindingSubmodeIntent: (...args) => this.bindingService.clearActiveBindingSubmodeIntent(...args),
      presentSkillsBrowser: (...args) => this.presentSkillsBrowser(...args),
      presentSkillsSearchPrompt: (...args) => this.presentSkillsSearchPrompt(...args),
      selectPendingSkill: (...args) => this.selectPendingSkill(...args),
      removePendingSkill: (...args) => this.removePendingSkill(...args),
      presentHandoffOverview: (...args) => this.presentHandoffOverview(...args),
      presentHandoffProjectPicker: (...args) => this.presentHandoffProjectPicker(...args),
      presentHandoffConfirmation: (...args) => this.presentHandoffConfirmation(...args),
      clearActiveHandoffIntent: (...args) => this.clearActiveHandoffIntent(...args),
      presentHandoffBranchPicker: (...args) => this.presentHandoffBranchPicker(...args),
      executeHandoff: (...args) => this.executeHandoff(...args),
      presentModelPicker: (...args) => this.presentModelPicker(...args),
      presentReasoningPicker: (...args) => this.presentReasoningPicker(...args),
      presentStatusAcpRuntimeModePicker: (...args) => this.presentStatusAcpRuntimeModePicker(...args),
      setBindingModel: (...args) => this.setBindingModel(...args),
      setBindingReasoning: (...args) => this.setBindingReasoning(...args),
      setBindingAcpRuntimeMode: (...args) => this.setBindingAcpRuntimeMode(...args),
      setBindingPermissionsMode: (...args) => this.setBindingPermissionsMode(...args),
      setToolUpdateMode: (...args) => this.setToolUpdateMode(...args),
      setBindingResponseMode: (...args) => this.setBindingResponseMode(...args),
      toggleFastMode: (...args) => this.toggleFastMode(...args),
      readBoundNavigationThread: (...args) => this.readBoundNavigationThread(...args),
      presentPermissionsPicker: (...args) => this.presentPermissionsPicker(...args),
      presentToolUpdateModePicker: (...args) => this.presentToolUpdateModePicker(...args),
      presentResponseModePicker: (...args) => this.presentResponseModePicker(...args),
      cycleStreamingResponseMode: (...args) => this.cycleStreamingResponseMode(...args),
      stopActiveTurn: (...args) => this.stopActiveTurn(...args),
      compactThread: (...args) => this.compactThread(...args),
      toggleThreadLock: (...args) => this.toggleThreadLock(...args),
      syncConversationName: (...args) => this.bindingService.syncConversationName(...args),
      deliverInvalidStatusSelection: (...args) => this.deliverInvalidStatusSelection(...args),
      deliverStaleFullAccessWarning: (...args) => this.deliverStaleFullAccessWarning(...args),
      get pendingFullAccessNewThreadPrompts() { return readController().inboundTurns.pendingFullAccessNewThreadPrompts; },
      withNewThreadPromptCaptureExpiry: (...args) => this.newThreadWorkflow.withNewThreadPromptCaptureExpiry(...args),
      resolveFullAccessControls: (...args) => this.accessControl.resolveFullAccessControls(...args),
      resolveFullAccessWarning: (...args) => this.accessControl.resolveFullAccessWarning(...args),
      deliverMissingFullAccessPrompt: (...args) => this.deliverMissingFullAccessPrompt(...args),
      createNewThreadFromPromptBundle: (...args) => this.inboundTurns.createNewThreadFromPromptBundle(...args),
      deliverNewThreadPromptFailure: (...args) => this.inboundTurns.deliverNewThreadPromptFailure(...args),
      applyNewThreadAcpRuntimeMode: (...args) => this.newThreadWorkflow.applyNewThreadAcpRuntimeMode(...args),
      applyBindingAcpRuntimeMode: (...args) => this.applyBindingAcpRuntimeMode(...args),
      recordFullAccessPolicyViolation: (...args) => this.accessControl.recordFullAccessPolicyViolation(...args),
      queueAuditKey: (...args) => this.queueAuditKey(...args),
      get pendingQueueAuditMessages() { return readController().pendingQueueAuditMessages; },
      agentMessagingOriginForPendingIntent: (...args) => this.agentMessagingOriginForPendingIntent(...args),
      readBackendThreadStatus: (...args) => this.readBackendThreadStatus(...args),
      reconcileActiveTurnFromBackendStatus: (...args) => this.reconcileActiveTurnFromBackendStatus(...args),
      get privateReplyClaims() { return readController().privateReplyClaims; },
      deliverPrivateReplyButtonState: (...args) => this.deliverPrivateReplyButtonState(...args),
      completePrivateReplyContinuation: (...args) => this.completePrivateReplyContinuation(...args),
      admitTurnInput: (...args) => this.inboundTurns.admitTurnInput(...args),
    };
  }

  private backendEventHost(): MessagingBackendEventHost {
    if (this.backendEventPorts) return this.backendEventPorts;
    const readController = () => this;
    return this.backendEventPorts = {
      refreshStatusSurfacesForBackend: (...args) => this.refreshStatusSurfacesForBackend(...args),
      retireAnsweredAsyncQuestionnaires: (...args) => this.retireAnsweredAsyncQuestionnaires(...args),
      filterBindingsForChannel: (...args) => this.filterBindingsForChannel(...args),
      deliver: (...args) => this.deliver(...args),
      newIntentId: (...args) => this.newIntentId(...args),
      applySharedQueueNoticeEvent: (...args) => this.applySharedQueueNoticeEvent(...args),
      reconcileQueuedAgentMessagingOrigin: (...args) => this.reconcileQueuedAgentMessagingOrigin(...args),
      rememberContextUsageSummary: (...args) => this.rememberContextUsageSummary(...args),
      handleBackendRequestResolved: (...args) => this.handleBackendRequestResolved(...args),
      handleExecutionModeQueued: (...args) => this.handleExecutionModeQueued(...args),
      refreshStatusSurfacesForThread: (...args) => this.bindingService.refreshStatusSurfacesForThread(...args),
      handleExecutionModeQueueCleared: (...args) => this.handleExecutionModeQueueCleared(...args),
      bindingsForAgentTurn: (...args) => this.bindingsForAgentTurn(...args),
      getActiveTurn: (...args) => this.getActiveTurn(...args),
      isTerminalPrivateResponseTurn: (...args) => this.isTerminalPrivateResponseTurn(...args),
      isPrivateResponseFallbackTurn: (...args) => this.isPrivateResponseFallbackTurn(...args),
      isPrivateReplyCompletionTurn: (...args) => this.isPrivateReplyCompletionTurn(...args),
      isAutomationTurn: (...args) => this.isAutomationTurn(...args),
      get deliveredThreadNoticeKeys() { return readController().deliveredThreadNoticeKeys; },
      resolveToolUpdateDefaultMode: (...args) => this.bindingService.resolveToolUpdateDefaultMode(...args),
      get toolUpdatePolicy() { return readController().toolUpdatePolicy; },
      deliverToolUpdateDelivery: (...args) => this.deliverToolUpdateDelivery(...args),
      deliverIncomingWork: (...args) => this.deliverIncomingWork(...args),
      suppressTaskMonitorLifecycle: (...args) => this.suppressTaskMonitorLifecycle(...args),
      handleAutomationRunUpdated: (...args) => this.handleAutomationRunUpdated(...args),
      handleAutomationTurnStarted: (...args) => this.handleAutomationTurnStarted(...args),
      handleAutomationTurnTerminal: (...args) => this.handleAutomationTurnTerminal(...args),
      isAutomationTurnEvent: (...args) => this.isAutomationTurnEvent(...args),
      observeBackendTurn: (...args) => this.turns.observeBackend(...args),
      setActiveTurn: (...args) => this.setActiveTurn(...args),
      logBindingTurnStateChange: (...args) => this.logBindingTurnStateChange(...args),
      deliverToolActivityForBackendEvent: (...args) => this.deliverToolActivityForBackendEvent(...args),
      flushToolUpdatesForBinding: (...args) => this.flushToolUpdatesForBinding(...args),
      finalizeWorkingCard: (...args) => this.finalizeWorkingCard(...args),
      clearTurnProse: (...args) => this.clearTurnProse(...args),
      turnProseKey: (...args) => this.turnProseKey(...args),
      get workingUpdateCancellationSignals() { return readController().workingUpdateCancellationSignals; },
      get workingUpdateDeliveries() { return readController().workingUpdateDeliveries; },
      get workingUpdateSurfaces() { return readController().workingUpdateSurfaces; },
      get workingUpdateCancellationFailures() { return readController().workingUpdateCancellationFailures; },
      waitForAssistantStreamDeliveriesForEvent: (...args) => this.waitForAssistantStreamDeliveriesForEvent(...args),
      assistantStreamBufferKeysForEvent: (...args) => this.assistantStreamBufferKeysForEvent(...args),
      get assistantStreamBuffers() { return readController().assistantStreamBuffers; },
      get assistantStreamDeliveryQueues() { return readController().assistantStreamDeliveryQueues; },
      get assistantStreamCancellationSignals() { return readController().assistantStreamCancellationSignals; },
      deliverAssistantStreamUpdate: (...args) => this.deliverAssistantStreamUpdate(...args),
      get privateResponses() { return readController().privateResponses; },
      deliverPrivateResponseFallback: (...args) => this.deliverPrivateResponseFallback(...args),
      takeBufferedAssistantTextForTerminalEvent: (...args) => this.takeBufferedAssistantTextForTerminalEvent(...args),
      markAssistantMessageDelivered: (...args) => this.markAssistantMessageDelivered(...args),
      resolveAssistantMessageImages: (...args) => this.resolveAssistantMessageImages(...args),
      deliverAssistantImages: (...args) => this.deliverAssistantImages(...args),
      deliverAsyncQuestionnaire: (...args) => this.deliverAsyncQuestionnaire(...args),
      flushAssistantStreamForEvent: (...args) => this.flushAssistantStreamForEvent(...args),
      deliverAssistantMessage: (...args) => this.deliverAssistantMessage(...args),
      deliverAssistantProseForBackendEvent: (...args) => this.deliverAssistantProseForBackendEvent(...args),
      flushBufferedAssistantStreamsForTerminalEvent: (...args) => this.flushBufferedAssistantStreamsForTerminalEvent(...args),
      deliverTurnFailureMessage: (...args) => this.deliverTurnFailureMessage(...args),
      deliverResponseBlockedNotice: (...args) => this.deliverResponseBlockedNotice(...args),
      deliverArtifactForBinding: (...args) => this.deliverArtifactForBinding(...args),
      renderAutomaticBindingStatus: (...args) => this.bindingService.renderAutomaticBindingStatus(...args),
      threadContextWithNameFromEvent: (...args) => this.bindingService.threadContextWithNameFromEvent(...args),
      signalTurnActivity: (...args) => this.signalTurnActivity(...args),
      get activeAgentMessagingOriginsByTurnKey() { return readController().activeAgentMessagingOriginsByTurnKey; },
      completePrivateReplyContinuation: (...args) => this.completePrivateReplyContinuation(...args),
      forgetAutomationTurn: (...args) => this.forgetAutomationTurn(...args),
      forgetAgentMessagingOrigin: (...args) => this.forgetAgentMessagingOrigin(...args),
    };
  }

  handleBackendEvent(event: AgentEvent): Promise<void> {
    return this.backendEventRouter.handleBackendEvent(event);
  }

  private async refreshStatusSurfacesForBackend(
    backend: AppServerBackendKind,
    reason: string,
    federationTarget?: FederationTarget,
  ): Promise<void> {
    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForBackend({ backend }),
    ).filter((binding) =>
      bindingMatchesFederationTarget(binding, federationTarget)
    );
    const renderableBindings = bindings.filter(
      (binding) => binding.statusSurface || binding.pinnedStatusSurface,
    );
    if (renderableBindings.length === 0) {
      return;
    }
    const navigationByThreadKey = new Map<string, MessagingNavigationContext>();
    for (const binding of renderableBindings) {
      try {
        const threadKey = threadKeyForBinding(binding);
        let navigation = navigationByThreadKey.get(threadKey);
        if (!navigation) {
          navigation = threadContextForAdmissionState(
            binding,
            await this.options.backend.getThreadAdmissionState({
              backend: binding.backend,
              federationTarget: federationTargetForBinding(binding),
              threadId: binding.threadId,
            }),
          );
          navigationByThreadKey.set(threadKey, navigation);
        }
        await this.bindingService.renderBindingStatus(binding, undefined, navigation);
      } catch (error) {
        this.logger.debug?.("messaging backend status refresh failed", {
          backend,
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          reason,
          threadId: binding.threadId,
        });
      }
    }
  }

  async handleBackendPendingRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
    federationTarget?: FederationTarget,
  ): Promise<void> {
    const key = JSON.stringify([
      backend,
      request.params.threadId,
      request.params.requestId,
      federationTarget?.scope === "remote" ? federationTarget.instanceId : undefined,
    ]);
    const existing = this.pendingRequestPresentations.get(key);
    if (existing) {
      await existing;
      return;
    }
    // Reserve before the first store read completes so overlapping redisplays
    // cannot both create an intent for the same backend request.
    const presentation = this.presentBackendPendingRequest(backend, request, federationTarget);
    this.pendingRequestPresentations.set(key, presentation);
    try {
      await presentation;
    } finally {
      this.pendingRequestPresentations.delete(key);
    }
  }

  private async presentBackendPendingRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
    federationTarget?: FederationTarget,
  ): Promise<void> {
    const persistentBindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend,
        threadId: request.params.threadId,
      }),
    ).filter((binding) =>
      bindingMatchesFederationTarget(binding, federationTarget)
    );
    const bindings = this.bindingsForAgentTurn(
      backend,
      request.params.threadId,
      request.params.turnId ?? undefined,
      persistentBindings,
    );

    const existingIntents = await this.options.store.findActivePendingIntentsForRequest({
      backend,
      threadId: request.params.threadId,
      requestId: request.params.requestId,
      now: this.now(),
    });
    for (const binding of bindings) {
      // Desktop transcript recovery also reaches messaging. Keep the existing
      // actionable message and any questionnaire answers for this binding.
      if (existingIntents.some((intent) => intent.bindingId === binding.id)) {
        continue;
      }
      const intent = this.intentForPendingRequest(request);
      if (!intent) {
        continue;
      }
      intent.bindingId = binding.id;
      intent.requestContext = {
        backend,
        method: request.method,
        requestId: request.params.requestId,
        threadId: request.params.threadId,
        turnId: request.params.turnId ?? undefined,
      };
      intent.audit = buildMessagingAuditContext({
        action: "pending_request.presented",
        actor: {
          platformUserId: binding.authorizedActorIds[0] ?? "unknown",
        },
        backend,
        bindingId: binding.id,
        channel: binding.channel,
        now: this.now(),
        threadId: request.params.threadId,
      });
      if (request.params.turnId) {
        const threadStatus = await this.readBackendThreadStatus(binding);
        if (threadStatus === "idle") {
          await this.reconcileIdleTurn(binding, "pending_request");
          continue;
        }
      }
      const pendingIntent = await this.storePendingIntent(intent, binding);
      await this.flushPendingTurnProseBeforeElicitation(
        binding,
        request.params.turnId,
      );
      const delivery = await this.deliver(intent, binding);
      let deliveredPendingIntent = pendingIntent;
      if (delivery.surface) {
        deliveredPendingIntent = {
          ...pendingIntent,
          surface: delivery.surface,
        };
        await this.options.store.upsertPendingIntent(deliveredPendingIntent);
      }
      if (request.params.turnId) {
        const reconciledTurn = await this.reconcileActiveTurnFromBackendStatus(
          binding,
          "pending_request",
        );
        if (isTerminalTurnLifecycle(reconciledTurn)) {
          await this.retireStalePendingIntent(deliveredPendingIntent);
          continue;
        }
        const threadStatus = await this.readBackendThreadStatus(binding);
        if (threadStatus === "idle") {
          await this.retireStalePendingIntent(deliveredPendingIntent);
          await this.reconcileIdleTurn(binding, "pending_request");
          continue;
        }
        const activeTurn: MessagingActiveTurnSummary = {
          turnId: request.params.turnId,
          status: "waiting",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        await this.signalTurnActivity(binding, activeTurn, {
          force: true,
        });
        await this.bindingService.renderAutomaticBindingStatus(binding);
      }
    }
  }

  private async deliverQueuedTurnNotice(entry: MessagingQueuedTurnEntry): Promise<void> {
    const activeTurn = await this.resolveSteerableActiveTurn(
      entry.binding,
      "queued_turn_notice",
    );
    const canSteer = this.canSteerQueuedTurn(entry, activeTurn);
    const intent = buildConfirmationIntent({
      id: this.newIntentId("queued-turn"),
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      title: "Message queued",
      body: buildQueuedTurnNoticeBody(entry.preview, canSteer, entry.manualRetryRequired),
      actions: [
        ...(entry.manualRetryRequired ? [{
          id: `queued-turn:retry:${entry.id}`,
          label: "Retry",
          style: "primary" as const,
        }] : []),
        {
          id: `queued-turn:steer:${entry.id}`,
          label: "Steer",
          style: "primary",
          disabled: !canSteer,
        },
        {
          id: `queued-turn:cancel:${entry.id}`,
          label: "Cancel",
          style: "secondary",
        },
      ],
    });
    const result = await this.deliver(intent, entry.binding);
    if (result.surface) {
      if (entry.ownerQueueEntryId) entry.surface = result.surface;
      this.queueRecoveries.surface(entry.id, result.surface);
    }
  }

  private canSteerQueuedTurn(
    entry: MessagingQueuedTurnEntry,
    activeTurn: MessagingActiveTurnSummary | undefined,
  ): boolean {
    return Boolean(
      !entry.pdfAttachments?.length &&
        this.options.backend.steerTurn &&
        activeTurn &&
        ["working", "waiting"].includes(activeTurn.status),
    );
  }

  private async retireQueuedTurnNotice(
    entry: MessagingQueuedTurnEntry,
    body: string,
    event?: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const targetSurface = entry.surface ?? event?.sourceSurface ?? event?.interaction;
    if (!targetSurface) {
      return;
    }

    try {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("queued-turn-retired"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "present_new",
          },
          title: "Message queued",
          body,
          targetSurface,
        }),
        entry.binding,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging queued turn notice retirement failed", {
        error: error instanceof Error ? error.message : String(error),
        queuedTurnId: entry.id,
      });
    }
  }

  private async applySharedQueueNoticeEvent(key: string, event: QueueNoticeEvent<MessagingQueuedTurnEntry>): Promise<void> {
    const transition = transitionQueueNotice(this.sharedQueueNotices.get(key), event);
    if (!transition.state) return;
    this.sharedQueueNotices.set(key, transition.state);
    if (transition.state.phase === "observed" || transition.state.phase === "settled") {
      this.sharedQueueNoticeHistory.add(key);
      while (this.sharedQueueNoticeHistory.size > 1000) {
        const oldest = this.sharedQueueNoticeHistory.values().next().value!;
        this.sharedQueueNoticeHistory.delete(oldest);
        this.sharedQueueNotices.delete(oldest);
      }
    } else {
      this.sharedQueueNoticeHistory.delete(key);
    }
    if (transition.started) {
      const { entry, turnId } = transition.started;
      this.pdfAttachmentStore.bindTurn({
        backend: entry.binding.backend, threadId: entry.binding.threadId, turnId,
        sourceInstanceId: entry.binding.federatedThread?.target.scope === "remote"
          ? entry.binding.federatedThread.target.instanceId : undefined,
        sourceRequest: entry.pdfSourceRequest,
      }, entry.pdfAttachments ?? []);
    }
    if (!transition.retire) return;
    const { entry, outcome: { status, turnId } } = transition.retire;
    entry.status = status === "started" ? "submitted" : status === "cancelled" ? "cancelled" : "failed";
    await this.retireQueuedTurnNotice(entry, status === "started"
      ? "Queued message sent as the next turn."
      : status === "cancelled" ? "Queued message cancelled." : "Queued message could not start. Check the thread queue.");
    await this.reconcileQueuedAgentMessagingOrigin({
      backend: entry.binding.backend, threadId: entry.binding.threadId,
      update: { status, turnId, queueEntryId: entry.id, origin: "messaging" },
    });
  }

  private trackQueuedTurnAction(entry: MessagingQueuedTurnEntry, action: Promise<void>): void {
    const task = action.catch((error: unknown) => {
      this.logger.warn?.("messaging queued action failed", {
        queuedTurnId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => { this.queuedTurnActions.delete(task); });
    this.queuedTurnActions.add(task);
  }

  private async handleQuestionnaireTextAnswer(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundTextEvent,
  ): Promise<boolean> {
    if (pendingIntent.intent.kind !== "questionnaire") {
      return false;
    }

    const intent = normalizeMessagingQuestionnaireIntent(pendingIntent.intent);
    const question = intent.questions[intent.currentIndex];
    const value = event.text.trim();
    if (intent.phase !== "answering" || !question?.allowFreeform || !value) {
      return false;
    }

    const updated = this.questionnaireWithRecordedAnswer(intent, {
      kind: "custom",
      value,
    });
    if (this.questionnaireReadyToSubmit(updated)) {
      await this.submitAndRetireQuestionnaire(pendingIntent, updated, event);
      return true;
    }

    await this.updateQuestionnairePendingIntent(pendingIntent, updated, event);
    return true;
  }

  private async handleQuestionnaireAction(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
    action: MessagingSurfaceAction,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "questionnaire") {
      return;
    }

    const intent = normalizeMessagingQuestionnaireIntent(pendingIntent.intent);
    if (action.id === "questionnaire:skip") {
      if (intent.asyncReply) {
        await this.options.store.deletePendingIntent(pendingIntent.id);
        await this.deliverQuestionnaireIntent(
          pendingIntent,
          { ...intent, phase: "skipped" },
          event,
        );
      }
      return;
    }

    if (action.id === "questionnaire:back") {
      await this.updateQuestionnairePendingIntent(
        pendingIntent,
        this.questionnaireWithPreviousQuestion(intent),
        event,
      );
      return;
    }

    if (action.id === "questionnaire:next") {
      await this.updateQuestionnairePendingIntent(
        pendingIntent,
        this.questionnaireWithNextQuestion(intent),
        event,
      );
      return;
    }

    if (action.id === "questionnaire:submit") {
      if (!this.questionnaireReadyToSubmit(intent)) {
        await this.deliver(
          buildConfirmationIntent({
            id: this.newIntentId("questionnaire-incomplete"),
            capabilityProfile: this.capabilityProfile,
            createdAt: this.now(),
            title: "Answer each question",
            body: "Review the input request and answer every question before submitting.",
            fallbackText: "Answer each question before submitting.",
          }),
          undefined,
          event,
        );
        return;
      }

      await this.submitAndRetireQuestionnaire(pendingIntent, intent, event);
      return;
    }

    const updated = this.questionnaireWithOptionAnswer(intent, action.id);
    if (updated !== intent) {
      if (this.questionnaireReadyToSubmit(updated)) {
        await this.submitAndRetireQuestionnaire(pendingIntent, updated, event);
        return;
      }

      await this.updateQuestionnairePendingIntent(pendingIntent, updated, event);
    }
  }

  private questionnaireWithOptionAnswer(
    intent: MessagingQuestionnaireIntent,
    optionId: string,
  ): MessagingQuestionnaireIntent {
    if (intent.phase !== "answering") {
      return intent;
    }

    const question = intent.questions[intent.currentIndex];
    const option = question?.options.find((candidate) => candidate.id === optionId);
    if (!option) {
      return intent;
    }

    return this.questionnaireWithRecordedAnswer(intent, {
      kind: "option",
      optionId: option.id,
      value: typeof option.value === "string" ? option.value : option.label,
    });
  }

  private questionnaireWithRecordedAnswer(
    intent: MessagingQuestionnaireIntent,
    answer: MessagingQuestionnaireAnswer,
  ): MessagingQuestionnaireIntent {
    const answers = [...intent.answers];
    answers[intent.currentIndex] = answer;

    const nextIndex = intent.currentIndex + 1;
    if (nextIndex < intent.questions.length) {
      return {
        ...intent,
        answers,
        currentIndex: nextIndex,
        phase: "answering",
      };
    }

    return {
      ...intent,
      answers,
      phase: "answering",
    };
  }

  private questionnaireWithNextQuestion(
    intent: MessagingQuestionnaireIntent,
  ): MessagingQuestionnaireIntent {
    if (intent.phase !== "answering") {
      return intent;
    }
    if (!messagingQuestionnaireAnswerComplete(intent.answers[intent.currentIndex])) {
      return intent;
    }
    if (intent.currentIndex >= intent.questions.length - 1) {
      return intent;
    }
    return {
      ...intent,
      currentIndex: intent.currentIndex + 1,
    };
  }

  private questionnaireReadyToSubmit(intent: MessagingQuestionnaireIntent): boolean {
    return (
      intent.currentIndex >= intent.questions.length - 1 &&
      intent.answers.every(messagingQuestionnaireAnswerComplete)
    );
  }

  private async submitAndRetireQuestionnaire(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<void> {
    if (intent.asyncReply) {
      await this.submitAsyncQuestionnaire(pendingIntent, intent, event);
      return;
    }
    const submittedIntent: MessagingQuestionnaireIntent = {
      ...intent,
      phase: "submitted",
    };
    await this.submitQuestionnaireIntent(submittedIntent);
    await this.deliverQuestionnaireIntent(pendingIntent, submittedIntent, event);
    await this.options.store.deletePendingIntent(pendingIntent.id);
    await this.resumeBindingForPendingIntent(
      pendingIntent,
      "pending_request.submitted",
    );
  }

  private questionnaireWithPreviousQuestion(
    intent: MessagingQuestionnaireIntent,
  ): MessagingQuestionnaireIntent {
    if (intent.phase === "review") {
      return {
        ...intent,
        currentIndex: Math.max(0, intent.questions.length - 1),
        phase: "answering",
      };
    }
    if (intent.phase !== "answering" || intent.currentIndex <= 0) {
      return intent;
    }
    return {
      ...intent,
      currentIndex: intent.currentIndex - 1,
    };
  }

  private async updateQuestionnairePendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<void> {
    const result = await this.deliverQuestionnaireIntent(pendingIntent, intent, event);
    await this.options.store.upsertPendingIntent({
      ...pendingIntent,
      intent,
      surface: result.surface ?? pendingIntent.surface,
    });
  }

  private async deliverQuestionnaireIntent(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event?: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<MessagingDeliveryResult> {
    const binding = pendingIntent.bindingId
      ? await this.options.store.getBinding(pendingIntent.bindingId)
      : undefined;
    const targetSurface = pendingIntent.surface ?? (
      event?.kind === "callback" ? event.interaction : undefined
    );
    const deliveryIntent: MessagingQuestionnaireIntent = targetSurface
      ? {
          ...intent,
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "present_new",
          },
          targetSurface,
        }
      : intent;
    return await this.deliver(deliveryIntent, binding, event);
  }

  /**
   * Presents the questions a Codex async question message asked. Nothing is
   * waiting on the answer, so the turn keeps its working state.
   */
  private async deliverAsyncQuestionnaire(
    asyncQuestions: { itemId: string; questions: CodexAsyncQuestion[] },
    event: AgentEvent,
    binding: MessagingBindingRecord,
    turnId: string | undefined,
  ): Promise<void> {
    const threadId = threadIdForBackendEvent(event) ?? binding.threadId;
    const intent = buildAsyncQuestionnaireIntent({
      asyncReply: {
        backend: event.backend,
        itemId: asyncQuestions.itemId,
        threadId,
      },
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      id: this.newIntentId("async-question"),
      questions: asyncQuestions.questions,
    });
    intent.bindingId = binding.id;
    intent.audit = buildMessagingAuditContext({
      action: "async_question.presented",
      actor: {
        platformUserId: binding.authorizedActorIds[0] ?? "unknown",
      },
      backend: event.backend,
      bindingId: binding.id,
      channel: binding.channel,
      now: this.now(),
      threadId,
    });
    const pendingIntent = await this.storePendingIntent(intent, binding);
    await this.flushPendingTurnProseBeforeElicitation(binding, turnId);
    const delivery = await this.deliver(intent, binding);
    if (delivery.outcome === "failed") {
      // No turn end retires an async card, so one nobody can see would take
      // the operator's next message as its answer.
      await this.options.store.deletePendingIntent(pendingIntent.id);
      return;
    }
    if (delivery.surface) {
      await this.options.store.upsertPendingIntent({
        ...pendingIntent,
        surface: delivery.surface,
      });
    }
  }

  /**
   * A Codex async question has no pending request to answer. The answers go
   * back as one message in Codex's reply envelope: steered into the turn when
   * one is running, as Codex expects, and otherwise as a new turn.
   */
  private async submitAsyncQuestionnaire(
    pendingIntent: MessagingPendingIntentRecord,
    intent: MessagingQuestionnaireIntent,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<void> {
    const asyncReply = intent.asyncReply;
    if (!asyncReply) {
      return;
    }
    const binding = pendingIntent.bindingId
      ? await this.options.store.getBinding(pendingIntent.bindingId)
      : undefined;
    const text = formatCodexAsyncQuestionReply(
      intent.questions.map((question, index) => ({
        questionItemId: codexAsyncQuestionItemId(asyncReply.itemId, index),
        question: question.question,
        answer: intent.answers[index]?.value ?? "",
      })),
    );
    if (!text) {
      return;
    }
    if (!binding || binding.revokedAt) {
      await this.options.store.deletePendingIntent(pendingIntent.id);
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("async-question-unavailable"),
          createdAt: this.now(),
          title: "Question unavailable",
          body: "This conversation is no longer bound to the thread that asked.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }
    if (
      !(await this.accessControl.requirePermission(
        event,
        "message.reply",
        "questionnaire:async-reply",
      ))
      || !(await this.accessControl.requireRemoteScopeForBinding(
        event,
        binding,
        "questionnaire:async-reply:remote-instance",
      ))
    ) {
      return;
    }

    // Retire the card before sending: the reply's own echo would otherwise
    // find it still pending and close it a second time.
    await this.options.store.deletePendingIntent(pendingIntent.id);
    const sent = await this.sendAsyncQuestionReply({
      binding,
      event,
      preview: summarizeCodexAsyncQuestionReply(
        intent.answers.map((answer) => ({ answer: answer?.value ?? "" })),
      ),
      text,
    });
    if (!sent) {
      await this.updateQuestionnairePendingIntent(pendingIntent, intent, event);
      return;
    }
    await this.deliverQuestionnaireIntent(
      pendingIntent,
      { ...intent, phase: "submitted" },
      event,
    );
  }

  private async sendAsyncQuestionReply(params: {
    binding: MessagingBindingRecord;
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent;
    preview: string;
    text: string;
  }): Promise<boolean> {
    const { binding, event } = params;
    const input: AppServerTurnInputItem[] = [{ type: "text", text: params.text }];
    const threadKey = threadKeyForBinding(binding);
    let admissionState: MessagingThreadAdmissionState;
    try {
      admissionState = await this.options.backend.getThreadAdmissionState({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        threadId: binding.threadId,
      });
    } catch (error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("async-question-reply-failed"),
          createdAt: this.now(),
          title: "Answer could not be sent",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        binding,
        event,
      );
      return false;
    }

    if (await this.inboundTurns.isTurnOccupied(binding, threadKey, admissionState)) {
      const activeTurn = await this.resolveSteerableActiveTurn(
        binding,
        "async_question_reply",
      );
      if (
        this.options.backend.steerTurn
        && activeTurn
        && ["working", "waiting"].includes(activeTurn.status)
      ) {
        try {
          await this.options.backend.steerTurn({
            backend: binding.backend,
            federationTarget: federationTargetForBinding(binding),
            threadId: binding.threadId,
            expectedTurnId: activeTurn.turnId,
            input,
            requestId: this.newIntentId("async-question-reply"),
            messageOrigin: messageOriginForInboundEvent(event, this.rememberHumanMessagingSource(binding, event)?.ref),
          });
          return true;
        } catch (error) {
          this.logger.warn?.("messaging async question reply could not steer", {
            bindingId: binding.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const started = await this.inboundTurns.startPreparedInput({
      admissionState,
      binding,
      event,
      input,
      preview: params.preview,
      threadKey,
    });
    return started !== "failed";
  }

  /**
   * An async question answered anywhere closes its card here, so a later
   * chat message is not captured as a second answer.
   */
  private async retireAnsweredAsyncQuestionnaires(
    event: AgentEvent,
    threadId: ThreadIdentifier,
    replies: readonly CodexAsyncQuestionReply[],
  ): Promise<void> {
    const answers = new Map(
      replies.map((reply) => [reply.questionItemId, reply.answer]),
    );
    const answeredIds = new Set(answers.keys());
    const pendingIntents =
      await this.options.store.findActivePendingAsyncQuestionnaires({
        backend: event.backend,
        threadId,
        now: this.now(),
      });
    for (const pendingIntent of pendingIntents) {
      if (
        pendingIntent.intent.kind !== "questionnaire"
        || !this.isChannelInScope(pendingIntent.channel)
      ) {
        continue;
      }
      const intent = normalizeMessagingQuestionnaireIntent(pendingIntent.intent);
      const itemId = intent.asyncReply?.itemId;
      if (
        !itemId
        || !intent.questions.some((_, index) =>
          isCodexAsyncQuestionAnswered(answeredIds, itemId, index)
        )
      ) {
        continue;
      }
      const binding = pendingIntent.bindingId
        ? await this.options.store.getBinding(pendingIntent.bindingId)
        : undefined;
      if (binding && !bindingMatchesFederationTarget(binding, event.federationTarget)) {
        continue;
      }
      const answered: MessagingQuestionnaireIntent = {
        ...intent,
        answers: intent.questions.map((question, index) => {
          const value = answers.get(codexAsyncQuestionItemId(itemId, index))
            ?? answers.get(itemId);
          if (!value) {
            return intent.answers[index] ?? null;
          }
          const option = question.options.find((candidate) => candidate.value === value);
          return option
            ? { kind: "option", optionId: option.id, value }
            : { kind: "custom", value };
        }),
        phase: "submitted",
      };
      await this.options.store.deletePendingIntent(pendingIntent.id);
      await this.deliverQuestionnaireIntent(pendingIntent, answered);
    }
  }

  private async submitQuestionnaireIntent(
    intent: MessagingQuestionnaireIntent,
  ): Promise<void> {
    const requestContext = intent.requestContext;
    if (!requestContext || !this.options.backend.submitServerRequest) {
      return;
    }
    const binding = intent.bindingId
      ? await this.options.store.getBinding(intent.bindingId)
      : undefined;

    await this.options.backend.submitServerRequest({
      backend: requestContext.backend,
      federationTarget: binding
        ? federationTargetForBinding(binding)
        : undefined,
      threadId: requestContext.threadId,
      turnId: requestContext.turnId,
      requestId: requestContext.requestId,
      response: {
        answers: Object.fromEntries(
          intent.questions.map((question, index) => [
            question.id,
            {
              answers: questionnaireAnswerValue(intent.answers[index]),
            },
          ]),
        ),
      },
    });
  }

  private async submitApprovalAction(
    intent: Extract<MessagingSurfaceIntent, { kind: "approval" }>,
    actionId: string,
  ): Promise<MessagingApprovalDecision | undefined> {
    const requestContext = intent.requestContext;
    const action = intent.decisions.find((candidate) => candidate.id === actionId);
    const decision = action?.decision;
    if (!requestContext || !action || !this.options.backend.submitServerRequest) {
      return decision;
    }
    const binding = intent.bindingId
      ? await this.options.store.getBinding(intent.bindingId)
      : undefined;

    await this.options.backend.submitServerRequest({
      backend: requestContext.backend,
      federationTarget: binding
        ? federationTargetForBinding(binding)
        : undefined,
      threadId: requestContext.threadId,
      turnId: requestContext.turnId,
      requestId: requestContext.requestId,
      response: action.response ?? { decision },
    });
    return decision;
  }

  /**
   * Post a "Permissions queued" audit message in every active binding for
   * the thread, mirroring the desktop transcript audit entry. The
   * registry's `thread/executionMode/queued` notification is the trigger;
   * we resolve from/to mode labels from the targeted thread projection at the
   * time the notification fires.
   */
  private async handleExecutionModeQueued(
    backend: AppServerBackendKind,
    params: {
      threadId: ThreadIdentifier;
      queuedExecutionMode: ThreadExecutionMode;
      queuedAt: number;
    },
  ): Promise<void> {
    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend,
        threadId: params.threadId,
      }),
    );
    if (bindings.length === 0) {
      return;
    }

    const admissionState = await this.options.backend.getThreadAdmissionState({
      backend,
      federationTarget: federationTargetForBinding(bindings[0]!),
      threadId: params.threadId,
    });
    const thread = admissionState?.thread;
    const fromExecutionMode = thread?.executionMode ?? "default";
    const toExecutionMode = params.queuedExecutionMode;

    // The registry's queueCleared notification doesn't carry the queueId
    // back, so we generate the cancel-action id here from the bus event.
    // The registry's cancelThreadExecutionModeQueue is idempotent — extra
    // clicks (or stale buttons) cancel the *current* queue or no-op if
    // nothing is pending. The id encoded here is for human/log
    // observability and to namespace per-queue cancel taps.
    const queueKey = this.queueAuditKey(backend, params.threadId);
    const queueId = `${params.threadId}:${params.queuedAt}`;

    const intent: MessagingConfirmationIntent = buildConfirmationIntent({
      id: this.newIntentId("permissions-queue"),
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      title: "⏳ Permissions queue",
      body: [
        `${formatExecutionModeLabel(fromExecutionMode)} → ${formatExecutionModeLabel(toExecutionMode)}`,
        "Will apply at end of current turn.",
      ].join("\n"),
      fallbackText: "Reply Cancel to drop the queued change.",
      actions: [
        {
          id: `${PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX}${queueId}`,
          label: "Cancel",
          fallbackText: "cancel",
          style: "danger",
          priority: 1,
        },
      ],
    });

    const tracking: PendingQueueAuditMessage = {
      backend,
      threadId: params.threadId,
      queueId,
      fromExecutionMode,
      toExecutionMode,
      queuedAt: params.queuedAt,
      surfaces: new Map(),
    };

    for (const binding of bindings) {
      try {
        const result = await this.deliver({ ...intent }, binding);
        if (result.surface && result.outcome !== "failed") {
          tracking.surfaces.set(binding.id, result.surface);
        }
      } catch (error) {
        this.logger.debug?.("messaging permissions-queue audit deliver failed", {
          bindingId: binding.id,
          threadId: params.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (tracking.surfaces.size > 0) {
      this.pendingQueueAuditMessages.set(queueKey, tracking);
    }
  }

  /**
   * Edit (or, on edit failure, repost) the previously-stored "queued"
   * audit message to reflect the new state — `cancelled` or
   * `applied`. Idempotent on missing tracking state (a queue cleared
   * before we ever managed to post the message has nothing to update).
   */
  private async handleExecutionModeQueueCleared(
    backend: AppServerBackendKind,
    params: {
      threadId: ThreadIdentifier;
      reason: "applied" | "cancelled";
    },
  ): Promise<void> {
    const queueKey = this.queueAuditKey(backend, params.threadId);
    const tracking = this.pendingQueueAuditMessages.get(queueKey);
    // Diagnostic: surface counts and edit outcomes so we can trace
    // "Cancel button still showing after apply" reports — if the
    // edit silently fails (Telegram message-too-old, network blip,
    // adapter not honoring replaceMarkup), the previously-stored
    // surface stays visible with its button until next refresh.
    this.logger.debug?.(
      "messaging permissions-queue clearance",
      {
        backend,
        threadId: params.threadId,
        reason: params.reason,
        hasTracking: !!tracking,
        surfaceCount: tracking?.surfaces.size ?? 0,
        queueId: tracking?.queueId,
      },
    );
    if (!tracking) {
      return;
    }

    const fromLabel = formatExecutionModeLabel(tracking.fromExecutionMode);
    const toLabel = formatExecutionModeLabel(tracking.toExecutionMode);
    const body =
      params.reason === "cancelled"
        ? `✕ Cancelled queued permissions change (${fromLabel} → ${toLabel})`
        : `🔓 Permissions changed: ${fromLabel} → ${toLabel} at ${formatTimeOfDay(this.now())} (submitted)`;
    const title =
      params.reason === "cancelled"
        ? "Permissions queue cancelled"
        : "Permissions changed";

    for (const [bindingId, surface] of tracking.surfaces) {
      const binding = await this.options.store.getBinding(bindingId);
      if (!binding || binding.revokedAt) {
        continue;
      }
      const intent: MessagingConfirmationIntent = buildConfirmationIntent({
        id: this.newIntentId("permissions-queue-cleared"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title,
        body,
        // Edit the existing queued message in place; on edit failure
        // (message gone, too old, edit not supported) the adapter's
        // `present_new` fallback posts a fresh message instead. This
        // mirrors the 2026-04-30-002 messaging-command-surfaces edit
        // failure pattern.
        delivery: {
          mode: "update",
          replaceMarkup: true,
          fallback: "present_new",
        },
        targetSurface: surface,
        // Empty actions array — buttons removed on resolve.
        actions: [],
        fallbackText: body,
      });
      try {
        const result = await this.deliver(intent, binding);
        this.logger.debug?.(
          "messaging permissions-queue audit edit",
          {
            bindingId: binding.id,
            threadId: params.threadId,
            reason: params.reason,
            outcome: result.outcome,
            // If outcome is "presented_new" the adapter posted a
            // fresh "submitted/cancelled" message but couldn't edit
            // the original. The original message (with its Cancel
            // button) stays visible in the chat — that's the user's
            // observed bug. Stale-tap feedback in
            // handlePermissionsQueueCancelCallback handles the
            // recovery path.
          },
        );
      } catch (error) {
        this.logger.debug?.(
          "messaging permissions-queue audit edit failed",
          {
            bindingId: binding.id,
            threadId: params.threadId,
            reason: params.reason,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    this.pendingQueueAuditMessages.delete(queueKey);
  }

  private queueAuditKey(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
  ): string {
    return buildThreadIdentityKey(backend, threadId);
  }

  private async handleBackendRequestResolved(event: AgentEvent): Promise<void> {
    if (event.notification.method !== "serverRequest/resolved") {
      return;
    }

    const pendingIntents =
      await this.options.store.findActivePendingIntentsForRequest({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
        now: this.now(),
      });

    for (const pendingIntent of pendingIntents.filter((intent) =>
      this.isChannelInScope(intent.channel),
    )) {
      const binding = pendingIntent.bindingId
        ? await this.options.store.getBinding(pendingIntent.bindingId)
        : undefined;
      if (
        binding &&
        !bindingMatchesFederationTarget(binding, event.federationTarget)
      ) {
        continue;
      }
      await this.retireApprovalIntent(pendingIntent, undefined, "Resolved");
      await this.options.store.deletePendingIntent(pendingIntent.id);
      await this.resumeBindingForPendingIntent(
        pendingIntent,
        event.notification.method,
      );
    }
  }

  private async retireApprovalIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event?: MessagingInboundCallbackEvent,
    responseLabel = "Resolved",
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "approval") {
      return;
    }

    const targetSurface = pendingIntent.surface ?? event?.interaction;
    if (!targetSurface) {
      return;
    }

    try {
      await this.deliver(
        {
          ...pendingIntent.intent,
          body: approvalBodyWithResponse(pendingIntent.intent.body, responseLabel),
          decisions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          fallbackText: `Approval response received: ${responseLabel}.`,
          targetSurface,
        },
        undefined,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging approval retirement update failed", {
        error: error instanceof Error ? error.message : String(error),
        intentId: pendingIntent.intent.id,
      });
    }
  }

  private async resumeBindingForPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    reason: string,
  ): Promise<MessagingBindingRecord | undefined> {
    const bindingId = pendingIntent.bindingId;
    const turnId = pendingIntent.intent.requestContext?.turnId;
    if (!bindingId || !turnId) {
      return undefined;
    }

    const origin = this.agentMessagingOriginForPendingIntent(pendingIntent);
    const binding = await this.options.store.getBinding(bindingId)
      ?? origin?.deliveryBinding
      ?? origin?.binding;
    const activeTurn = binding ? this.getActiveTurn(binding) : undefined;
    if (
      !binding ||
      binding.revokedAt ||
      !activeTurn ||
      activeTurn.turnId !== turnId ||
      activeTurn.status !== "waiting"
    ) {
      return undefined;
    }

    const resumedTurn: MessagingActiveTurnSummary = {
      ...activeTurn,
      status: "working",
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, resumedTurn);
    this.logBindingTurnStateChange(binding, activeTurn, resumedTurn, reason);
    await this.signalTurnActivity(binding, resumedTurn, {
      force: true,
      reason,
    });
    return binding;
  }

  /**
   * Resolve the effective streaming-responses toggle for a binding. Mirrors the
   * adapter-side check (`policy` + global `config.streamingResponses`) and the
   * new-thread summary in {@link newThreadOptionsForSession}: a per-binding
   * `"inherit"` follows the channel default, otherwise the explicit setting
   * wins. Consulted BEFORE generating stream intents so a disabled setting is a
   * real short-circuit on this path — not a `policy` the adapter discards after
   * the intent has already churned the delivery budget.
   */
  private isStreamingResponsesEnabledForBinding(
    binding: MessagingBindingRecord,
  ): boolean {
    return messagingStreamingResponsesEnabled(
      resolveMessagingStreamingResponseMode(binding),
      this.streamingResponsesDefault,
    );
  }

  private async deliverAssistantStreamUpdate(
    delta: AssistantStreamDelta,
    binding: MessagingBindingRecord,
    options?: { bufferOnly?: boolean },
  ): Promise<void> {
    if (
      this.isTerminalPrivateResponseTurn(
        binding.backend,
        binding.threadId,
        delta.turnId,
      )
    ) {
      return;
    }
    const bufferKey = this.assistantStreamBufferKey(delta.streamKey, binding);
    const now = this.now();
    const existing = this.assistantStreamBuffers.get(bufferKey);
    const buffer: AssistantStreamBuffer = existing
      ? {
          ...existing,
          delta: delta.delta,
          sequence: existing.sequence + 1,
          text: `${existing.text}${delta.delta}`,
        }
      : {
          ...delta,
          // First receipt: hold the first coalesced block for the initial
          // window so a burst of opening tokens becomes one edit, not many.
          nextReleaseAt: now + coalesceBackoffMs(0),
          releaseCount: 0,
          sequence: 1,
          text: delta.delta,
        };
    this.assistantStreamBuffers.set(bufferKey, buffer);
    // Bound the buffer map: a turn whose late deltas arrive after its terminal
    // flush re-creates an entry that no later terminal event clears. Cap it so
    // those orphans are reclaimed rather than accumulating for the process life.
    evictStaleStreamAnchors(this.assistantStreamBuffers);

    if (options?.bufferOnly) {
      return;
    }

    // Streaming off: keep accumulating deltas (the terminal flush still needs
    // the buffered text — e.g. ACP turns whose only output arrives as deltas)
    // but never emit a partial `stream_update`. Those intents would be
    // discarded downstream yet still consume a budget-admission check, and the
    // surface churn is what floods the channel with many separate messages.
    if (!this.isStreamingResponsesEnabledForBinding(binding)) {
      return;
    }

    // Coalesce: buffer this delta into `text` (already done above) and emit
    // nothing until the stored release time passes. Each release then schedules
    // the next one exponentially further out (~400ms → 1s → 2s → 4s → 8s → 16s
    // cap) so a long stream settles to at most one edit every ~16s instead of
    // one edit per delta. The final flush bypasses this timer entirely.
    if (buffer.text.trim().length === 0 || now < buffer.nextReleaseAt) {
      return;
    }

    const releaseCount = buffer.releaseCount + 1;
    this.assistantStreamBuffers.set(bufferKey, {
      ...buffer,
      releaseCount,
      nextReleaseAt: now + coalesceBackoffMs(releaseCount),
    });
    await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, false);
  }

  private async flushAssistantStreamForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    finalText: string,
  ): Promise<boolean> {
    const streamingEnabled = this.isStreamingResponsesEnabledForBinding(binding);
    let deliveredFinalStream = false;
    const completedTurnIds = new Set<string>();
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(bufferKey);
      if (!buffer) {
        continue;
      }
      completedTurnIds.add(buffer.turnId);
      // Streaming off: drop the accumulator without emitting a final
      // `stream_update`. Returning `false` routes the caller to
      // `deliverAssistantMessage`, so the turn lands as a single message
      // instead of a discarded stream edit followed by that same message.
      if (!streamingEnabled) {
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
        continue;
      }
      this.assistantStreamBuffers.set(bufferKey, {
        ...buffer,
        delta: "",
        sequence: buffer.sequence + 1,
        text: finalText,
      });
      const result = await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, true);
      deliveredFinalStream ||= isVisibleAssistantStreamDelivery(result);
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }
    for (const turnId of completedTurnIds) {
      this.assistantStreamCancellationSignals.delete(
        this.turnProseKey(binding.id, turnId),
      );
    }
    return deliveredFinalStream;
  }

  private async flushBufferedAssistantStreamsForTerminalEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const streamingEnabled = this.isStreamingResponsesEnabledForBinding(binding);
    const fallbackMessages: Array<{
      identity: AssistantMessageDeliveryIdentity;
      text: string;
    }> = [];
    const completedTurnIds = new Set<string>();
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(bufferKey);
      if (!buffer) {
        continue;
      }
      completedTurnIds.add(buffer.turnId);
      const text = buffer.text.trim();
      if (!text) {
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
        continue;
      }
      // Streaming off: post the buffered text as a plain message rather than an
      // (immediately discarded) final `stream_update`. Same single-message
      // outcome, without churning the delivery budget on a doomed stream edit.
      if (!streamingEnabled) {
        fallbackMessages.push({
          identity: {
            itemId: buffer.itemId,
            threadId: buffer.threadId,
            turnId: buffer.turnId,
          },
          text,
        });
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
        continue;
      }
      this.assistantStreamBuffers.set(bufferKey, {
        ...buffer,
        delta: "",
        sequence: buffer.sequence + 1,
        text,
      });
      const result = await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, true);
      if (!isVisibleAssistantStreamDelivery(result)) {
        fallbackMessages.push({
          identity: {
            itemId: buffer.itemId,
            threadId: buffer.threadId,
            turnId: buffer.turnId,
          },
          text,
        });
      }
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }

    for (const turnId of completedTurnIds) {
      this.assistantStreamCancellationSignals.delete(
        this.turnProseKey(binding.id, turnId),
      );
    }

    for (const fallback of fallbackMessages) {
      await this.deliverAssistantMessage(
        fallback.text,
        event,
        binding,
        [],
        fallback.identity,
      );
    }
  }

  private takeBufferedAssistantTextForTerminalEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): string | undefined {
    const completedTurnIds = new Set<string>();
    const messages: string[] = [];
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(bufferKey);
      if (!buffer) {
        continue;
      }
      completedTurnIds.add(buffer.turnId);
      const text = buffer.text.trim();
      if (text) {
        messages.push(text);
      }
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }
    for (const turnId of completedTurnIds) {
      this.assistantStreamCancellationSignals.delete(
        this.turnProseKey(binding.id, turnId),
      );
    }
    const text = messages.join("\n\n").trim();
    return text || undefined;
  }

  private async waitForAssistantStreamDeliveriesForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const deliveries = this.assistantStreamBufferKeysForEvent(event, binding)
      .map((bufferKey) => this.assistantStreamDeliveryQueues.get(bufferKey))
      .filter(
        (delivery): delivery is Promise<MessagingDeliveryResult> => Boolean(delivery),
      );
    if (deliveries.length === 0) {
      return;
    }
    await Promise.allSettled(deliveries);
  }

  private assistantStreamBufferKeysForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): string[] {
    const keys = new Set(
      assistantStreamKeysForBackendEvent(event).map((streamKey) =>
        this.assistantStreamBufferKey(streamKey, binding),
      ),
    );
    const filter = assistantStreamFilterForBackendEvent(event);
    if (!filter) {
      return [...keys];
    }
    for (const [bufferKey, buffer] of this.assistantStreamBuffers) {
      if (
        bufferKey.startsWith(`${binding.id}\0`) &&
        buffer.streamKey.startsWith(`${event.backend}:`) &&
        buffer.threadId === filter.threadId &&
        (!filter.turnId || buffer.turnId === filter.turnId)
      ) {
        keys.add(bufferKey);
      }
    }
    return [...keys];
  }

  private async enqueueAssistantStreamBufferDelivery(
    bufferKey: string,
    binding: MessagingBindingRecord,
    isFinal: boolean,
  ): Promise<MessagingDeliveryResult> {
    const previous = this.assistantStreamDeliveryQueues.get(bufferKey) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(async (): Promise<MessagingDeliveryResult> => {
        const latest = this.assistantStreamBuffers.get(bufferKey);
        if (!latest) {
          return {
            channel: binding.channel.channel,
            deliveredAt: this.now(),
            outcome: "discarded",
          };
        }
        return await this.deliverAssistantStreamBuffer(latest, binding, isFinal);
      });
    this.assistantStreamDeliveryQueues.set(bufferKey, delivery);
    try {
      return await delivery;
    } finally {
      if (this.assistantStreamDeliveryQueues.get(bufferKey) === delivery) {
        this.assistantStreamDeliveryQueues.delete(bufferKey);
      }
    }
  }

  private async deliverAssistantStreamBuffer(
    buffer: AssistantStreamBuffer,
    binding: MessagingBindingRecord,
    isFinal: boolean,
  ): Promise<MessagingDeliveryResult> {
    const cancellationKey = this.turnProseKey(binding.id, buffer.turnId);
    const cancellation = this.ensureAssistantStreamCancellationSignal(
      binding,
      buffer.turnId,
    );
    const now = this.now();
    const attribution = isFinal
      ? await this.responseAttributionForBinding(binding)
      : undefined;
    const intent: MessagingStreamUpdateIntent = {
      id: this.newIntentId(isFinal ? "assistant-stream-final" : "assistant-stream"),
      kind: "stream_update",
      bindingId: binding.id,
      createdAt: now,
      ...(buffer.surface
        ? {
            delivery: {
              mode: "update",
              fallback: "fail",
            },
            targetSurface: buffer.surface,
          }
        : {}),
      role: "assistant",
      ...(attribution ? { attribution } : {}),
      markdown: isFinal ? "markdown" : "plain",
      policy: binding.preferences?.streamingResponses ?? "inherit",
      delta: buffer.delta,
      text: buffer.text,
      stream: {
        key: buffer.streamKey,
        turnId: buffer.turnId,
        itemId: buffer.itemId,
        sequence: buffer.sequence,
        isFinal,
      },
    };
    const result = await this.deliver(intent, binding, undefined, {
      isCancelled: cancellation.isCancelled,
      whenCancelled: cancellation.whenCancelled,
      onCancelledDelivery: async (cancelledResult) => {
        if (
          cancelledResult.surface
          && isVisibleAssistantStreamDelivery(cancelledResult)
          && !isSameMessagingSurface(cancelledResult.surface, buffer.surface)
        ) {
          const dismissed = await this.dismissTerminalPrivateResponseSurface(
            binding,
            buffer.turnId,
            cancelledResult.surface,
          );
          if (!dismissed) {
            this.assistantStreamCancellationFailures.add(cancellationKey);
          }
        }
      },
    });
    if (cancellation.isCancelled()) {
      const bufferKey = this.assistantStreamBufferKey(buffer.streamKey, binding);
      this.assistantStreamBuffers.delete(bufferKey);
      return result;
    }
    const surface =
      result.surface && isVisibleAssistantStreamDelivery(result)
        ? result.surface
        : buffer.surface;
    const bufferKey = this.assistantStreamBufferKey(buffer.streamKey, binding);
    const current = this.assistantStreamBuffers.get(bufferKey);
    this.assistantStreamBuffers.set(bufferKey, {
      ...(current && current.sequence >= buffer.sequence ? current : buffer),
      surface,
    });
    return result;
  }

  private assistantStreamBufferKey(
    streamKey: string,
    binding: MessagingBindingRecord,
  ): string {
    return `${binding.id}\0${streamKey}`;
  }

  private ensureAssistantStreamCancellationSignal(
    binding: MessagingBindingRecord,
    turnId: string,
  ): MessagingCancellationSignal {
    const key = this.turnProseKey(binding.id, turnId);
    const existing = this.assistantStreamCancellationSignals.get(key);
    if (existing) {
      return existing;
    }
    let cancelled = this.isTerminalPrivateResponseTurn(
      binding.backend,
      binding.threadId,
      turnId,
    );
    let resolveCancellation!: () => void;
    const whenCancelled = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const cancellation: MessagingCancellationSignal = {
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        resolveCancellation();
      },
      isCancelled: () =>
        cancelled
        || this.isTerminalPrivateResponseTurn(
          binding.backend,
          binding.threadId,
          turnId,
        ),
      whenCancelled,
    };
    if (cancelled) {
      resolveCancellation();
    }
    this.assistantStreamCancellationSignals.set(key, cancellation);
    return cancellation;
  }

  private async cancelAssistantStreamsForTurn(
    binding: MessagingBindingRecord,
    turnId: string,
  ): Promise<boolean> {
    const cancellationKey = this.turnProseKey(binding.id, turnId);
    const deliveries = new Set<Promise<MessagingDeliveryResult>>();
    const surfaces = new Map<string, MessagingSurfaceRef>();
    this.assistantStreamCancellationFailures.delete(cancellationKey);
    this.assistantStreamCancellationSignals.get(cancellationKey)?.cancel();
    for (const [bufferKey, buffer] of this.assistantStreamBuffers) {
      if (
        bufferKey.startsWith(`${binding.id}\0`)
        && buffer.turnId === turnId
      ) {
        if (buffer.surface) {
          surfaces.set(messagingSurfaceKey(buffer.surface), buffer.surface);
        }
        const delivery = this.assistantStreamDeliveryQueues.get(bufferKey);
        if (delivery) {
          deliveries.add(delivery);
        }
        this.assistantStreamBuffers.delete(bufferKey);
      }
    }
    const deliveryResults = await Promise.allSettled(deliveries);
    for (const deliveryResult of deliveryResults) {
      if (
        deliveryResult.status === "fulfilled"
        && deliveryResult.value.surface
        && isVisibleAssistantStreamDelivery(deliveryResult.value)
      ) {
        surfaces.set(
          messagingSurfaceKey(deliveryResult.value.surface),
          deliveryResult.value.surface,
        );
      }
    }

    // A delivery already awaiting its adapter can finish after the buffers are
    // cleared. Retain the settled delivery result above so the cancellation
    // path owns a surface created between the delivery guard's post-adapter
    // check and the caller recording it, then make one final sweep for existing
    // surfaces.
    for (const [bufferKey, buffer] of this.assistantStreamBuffers) {
      if (
        bufferKey.startsWith(`${binding.id}\0`)
        && buffer.turnId === turnId
      ) {
        if (buffer.surface) {
          surfaces.set(messagingSurfaceKey(buffer.surface), buffer.surface);
        }
        this.assistantStreamBuffers.delete(bufferKey);
        this.assistantStreamDeliveryQueues.delete(bufferKey);
      }
    }
    for (const surface of surfaces.values()) {
      const dismissed = await this.dismissTerminalPrivateResponseSurface(
        binding,
        turnId,
        surface,
      );
      if (!dismissed) {
        this.assistantStreamCancellationFailures.add(cancellationKey);
      }
    }
    const cancelledCleanly = !this.assistantStreamCancellationFailures.has(
      cancellationKey,
    );
    this.assistantStreamCancellationFailures.delete(cancellationKey);
    this.assistantStreamCancellationSignals.delete(cancellationKey);
    return cancelledCleanly;
  }

  private ensureWorkingUpdateCancellationSignal(
    binding: MessagingBindingRecord,
    turnId: string,
  ): MessagingCancellationSignal {
    const key = this.turnProseKey(binding.id, turnId);
    const existing = this.workingUpdateCancellationSignals.get(key);
    if (existing) {
      return existing;
    }
    let cancelled = this.isTerminalPrivateResponseTurn(
      binding.backend,
      binding.threadId,
      turnId,
    );
    let resolveCancellation!: () => void;
    const whenCancelled = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const cancellation: MessagingCancellationSignal = {
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        resolveCancellation();
      },
      isCancelled: () =>
        cancelled
        || this.isTerminalPrivateResponseTurn(
          binding.backend,
          binding.threadId,
          turnId,
        ),
      whenCancelled,
    };
    if (cancelled) {
      resolveCancellation();
    }
    this.workingUpdateCancellationSignals.set(key, cancellation);
    return cancellation;
  }

  private async cancelWorkingUpdatesForTurn(
    binding: MessagingBindingRecord,
    turnId: string,
  ): Promise<boolean> {
    const key = this.turnProseKey(binding.id, turnId);
    this.workingUpdateCancellationFailures.delete(key);
    this.workingUpdateCancellationSignals.get(key)?.cancel();
    const deliveryResults = await Promise.allSettled(
      this.workingUpdateDeliveries.get(key) ?? [],
    );

    const surfaces = new Map(this.workingUpdateSurfaces.get(key) ?? []);
    for (const deliveryResult of deliveryResults) {
      if (
        deliveryResult.status === "fulfilled"
        && deliveryResult.value.surface
        && isVisibleAssistantStreamDelivery(deliveryResult.value)
      ) {
        surfaces.set(
          messagingSurfaceKey(deliveryResult.value.surface),
          deliveryResult.value.surface,
        );
      }
    }
    for (const surface of surfaces.values()) {
      const dismissed = await this.dismissTerminalPrivateResponseSurface(
        binding,
        turnId,
        surface,
      );
      if (!dismissed) {
        this.workingUpdateCancellationFailures.add(key);
      }
    }

    const cancelledCleanly = !this.workingUpdateCancellationFailures.has(key);
    this.workingUpdateCancellationFailures.delete(key);
    this.workingUpdateCancellationSignals.delete(key);
    this.workingUpdateDeliveries.delete(key);
    this.workingUpdateSurfaces.delete(key);
    return cancelledCleanly;
  }

  private async dismissTerminalPrivateResponseSurface(
    binding: MessagingBindingRecord,
    turnId: string,
    surface: MessagingSurfaceRef,
  ): Promise<boolean> {
    try {
      const result = await this.deliver(
        {
          id: this.newIntentId("private-response-source-dismiss"),
          kind: "dismiss",
          bindingId: binding.id,
          createdAt: this.now(),
          delivery: { mode: "dismiss" },
          reason: "terminal_private_response",
          targetSurface: surface,
        },
        binding,
      );
      if (result.outcome === "dismissed") {
        return true;
      }
      this.logger.warn?.("messaging private response source dismissal failed", {
        bindingId: binding.id,
        errorMessage: result.errorMessage,
        outcome: result.outcome,
        surfaceId: surface.id,
        threadId: binding.threadId,
        turnId,
      });
      return false;
    } catch (error) {
      this.logger.warn?.("messaging private response source dismissal failed", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        surfaceId: surface.id,
        threadId: binding.threadId,
        turnId,
      });
      return false;
    }
  }

  private async deliverAssistantMessage(
    text: string,
    event: AgentEvent,
    binding: MessagingBindingRecord,
    images: MessagingImagePart[] = [],
    identity?: AssistantMessageDeliveryIdentity,
    deliveryClaimed = false,
  ): Promise<void> {
    if (
      !deliveryClaimed
      && !this.markAssistantMessageDelivered(event, binding, text, identity)
    ) {
      await this.deliverAssistantImages(images, event, binding, identity);
      return;
    }
    // Text and image ownership are independent. Another completion event may
    // have posted these images while this path awaited resolution, even though
    // this path already owns the backend item/text delivery.
    const messageImages = this.takeUndeliveredAssistantImages(
      images,
      event,
      binding,
      identity,
    );
    this.logger.debug?.(
      `messaging assistant deliver thread=${binding.threadId} binding=${binding.id} chars=${text.length} images=${messageImages.length} preview="${compactLogPreview(text)}"`,
    );
    const attribution = await this.responseAttributionForBinding(binding);

    await this.deliver(
      {
        id: this.newIntentId("assistant-message"),
        kind: "message",
        bindingId: binding.id,
        createdAt: this.now(),
        role: "assistant",
        attribution,
        parts: [
          {
            type: "text",
            text,
            markdown: "markdown",
          },
          ...messageImages,
        ],
      },
      binding,
    );
  }

  private async deliverAssistantImages(
    images: MessagingImagePart[],
    event: AgentEvent,
    binding: MessagingBindingRecord,
    identity?: AssistantMessageDeliveryIdentity,
    _deliveryClaimed = false,
  ): Promise<void> {
    if (images.length === 0) {
      return;
    }
    const pendingImages = this.takeUndeliveredAssistantImages(
      images,
      event,
      binding,
      identity,
    );
    if (pendingImages.length === 0) {
      return;
    }
    const attribution = await this.responseAttributionForBinding(binding);
    await this.deliver(
      {
        id: this.newIntentId("assistant-images"),
        kind: "message",
        bindingId: binding.id,
        createdAt: this.now(),
        role: "assistant",
        attribution,
        parts: pendingImages,
      },
      binding,
    );
  }

  private takeUndeliveredAssistantImages(
    images: MessagingImagePart[],
    event: AgentEvent,
    binding: MessagingBindingRecord,
    identity?: AssistantMessageDeliveryIdentity,
  ): MessagingImagePart[] {
    return images.filter((image) =>
      this.claimAssistantMessageContentDelivery(
        event,
        binding,
        assistantImageDeliverySignature([image]),
        identity,
      )
    );
  }

  private async resolveAssistantMessageImages(
    text: string,
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<MessagingImagePart[]> {
    const resolveImages = this.options.backend.resolveAssistantMessageImages?.bind(
      this.options.backend,
    );
    if (!resolveImages) {
      return [];
    }
    const itemId = assistantItemIdForBackendEvent(event);
    const turnId = turnIdForBackendEvent(event);
    // Once per turn. The final item's lookup already covers the turn's images,
    // so turn/completed only resolves a turn that finished without one, such
    // as an ACP turn or a Codex turn whose only output was a tool screenshot.
    const turnKey = turnId
      ? [binding.id, binding.backend, binding.threadId, turnId].join("\0")
      : undefined;
    if (turnKey && itemId) {
      rememberBoundedMap(this.finalAssistantImageTurns, turnKey, true, 256);
    } else if (turnKey && this.finalAssistantImageTurns.has(turnKey)) {
      return [];
    }
    const item = itemId
      ? asPlainRecord((event.notification.params as { item?: unknown }).item)
      : undefined;
    try {
      const images = await resolveImages({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        ...(item ? { item } : {}),
        itemId,
        text,
        threadId: binding.threadId,
        turnId,
      });
      return selectAssistantImagesForCapability(images, this.capabilityProfile);
    } catch (error) {
      // The reply text still goes out, so a failure here otherwise leaves only
      // dead image links in the chat with nothing in the main log to say why.
      this.logger.warn?.("messaging assistant image resolution failed", {
        backend: binding.backend,
        error: error instanceof Error ? error.message : String(error),
        federated: federationTargetForBinding(binding) !== undefined,
        threadId: binding.threadId,
      });
      // A failed item lookup leaves turn/completed to try the turn again.
      if (turnKey && itemId) {
        this.finalAssistantImageTurns.delete(turnKey);
      }
      return [];
    }
  }

  /**
   * Surface a failed turn's error in the bound conversation. Previously a Codex
   * turn failure (e.g. a provider 400) left the chat silent — the turn just
   * stopped. We post it as a recoverable error notice so the operator can see
   * what went wrong and retry. Deduped on (event, binding, text) so a re-emitted
   * terminal turn does not double-post.
   */
  private async deliverTurnFailureMessage(
    text: string,
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    if (!this.markAssistantMessageDelivered(event, binding, `turn-failed:${text}`)) {
      return;
    }
    const startingOrigin = this.startingAgentMessagingOriginsByThreadKey.get(
      agentMessagingThreadKey(event.backend, binding.threadId),
    );
    const startingDeliveryBinding = startingOrigin?.deliveryBinding
      ?? startingOrigin?.binding;
    if (startingOrigin && startingDeliveryBinding?.id === binding.id) {
      // Some backends publish a synthetic failed-turn lifecycle before their
      // startTurn promise rejects. Correlate that report to the in-flight
      // messaging origin so the rejection handler does not post it again.
      startingOrigin.reportedStartFailureText = text;
    }
    this.logger.debug?.(
      `messaging turn-failure deliver thread=${binding.threadId} binding=${binding.id} preview="${compactLogPreview(text)}"`,
    );
    if (
      isClaudeSessionGoneFailure(event)
      && !federationTargetForBinding(binding)
      && this.options.backend.continueClaudeThreadInNewSession
    ) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("claude-session-gone"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Turn failed",
          body: `${text}\n\nSend /continue to continue in a new session.`,
          actions: [{
            id: "claude:continue-session",
            label: "Continue in a new session",
            style: "primary",
            value: { bindingId: binding.id, threadId: binding.threadId },
            fallbackText: "/continue",
          }],
        }),
        binding,
      );
      return;
    }
    const block = readProviderResponseBlockNotification(event.notification);
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("turn-failed"),
        createdAt: this.now(),
        title: block ? "Turn blocked" : "Turn failed",
        body: block
          ? describeProviderResponseBlock({ block: block.block, turnEnded: true })
          : text,
        recoverable: true,
      }),
      binding,
    );
  }

  private async deliverResponseBlockedNotice(
    responseBlock: NonNullable<ReturnType<typeof readProviderResponseBlockNotification>>,
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    // Codex retries each block; one notice per turn is enough.
    if (!this.markAssistantMessageDelivered(event, binding, "response-blocked")) {
      return;
    }
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("response-blocked"),
        createdAt: this.now(),
        title: "Response blocked",
        body: describeProviderResponseBlock({
          block: responseBlock.block,
          turnEnded: false,
        }),
        recoverable: true,
      }),
      binding,
    );
  }

  private async repostLastAssistantMessageForResume(
    binding: MessagingBindingRecord,
    options?: { important?: boolean },
  ): Promise<void> {
    const readLastAssistantReply =
      this.options.backend.readThreadLastAssistantReply?.bind(
        this.options.backend,
      );
    const readLastAssistantMessage =
      this.options.backend.readThreadLastAssistantMessage?.bind(
        this.options.backend,
      );
    if (!readLastAssistantReply && !readLastAssistantMessage) {
      return;
    }

    let reply: MessagingLastAssistantReply | undefined;
    try {
      if (readLastAssistantReply) {
        reply = await readLastAssistantReply({
          backend: binding.backend,
          federationTarget: federationTargetForBinding(binding),
          threadId: binding.threadId,
        });
      } else if (readLastAssistantMessage) {
        const text = await readLastAssistantMessage({
          backend: binding.backend,
          federationTarget: federationTargetForBinding(binding),
          threadId: binding.threadId,
        });
        reply = text ? { text } : undefined;
      }
    } catch (error) {
      this.logger.debug?.("messaging resume last assistant replay failed", {
        backend: binding.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
      return;
    }

    const trimmed = reply?.text.trim();
    if (!trimmed) {
      return;
    }

    let images: MessagingImagePart[] = [];
    if (this.options.backend.resolveAssistantMessageImages) {
      try {
        images = selectAssistantImagesForCapability(
          await this.options.backend.resolveAssistantMessageImages({
            backend: binding.backend,
            federationTarget: federationTargetForBinding(binding),
            text: trimmed,
            threadId: binding.threadId,
          }),
          this.capabilityProfile,
        );
      } catch (error) {
        this.logger.debug?.("messaging resume assistant image resolution failed", {
          backend: binding.backend,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }

    await this.deliver(
      {
        id: this.newIntentId(
          options?.important
            ? "assistant-resume-repost-important"
            : "assistant-resume-repost",
        ),
        kind: "message",
        bindingId: binding.id,
        createdAt: this.now(),
        role: "assistant",
        attribution: await this.responseAttributionForBinding(binding),
        parts: [
          {
            type: "text",
            text: formatResumeRepostText({
              createdAt: reply?.createdAt,
              now: this.now(),
              text: trimmed,
            }),
            markdown: "markdown",
          },
          ...images,
        ],
      },
      binding,
    );
  }

  private markAssistantMessageDelivered(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    text: string,
    identity?: AssistantMessageDeliveryIdentity,
  ): boolean {
    const keys = assistantMessageDeliveryKeys(event, binding, text, identity);
    if (keys.some((key) => this.deliveredAssistantMessageKeys.has(key))) {
      return false;
    }
    for (const key of keys) {
      this.deliveredAssistantMessageKeys.add(key);
    }
    return true;
  }

  private claimAssistantMessageContentDelivery(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    text: string,
    identity?: AssistantMessageDeliveryIdentity,
  ): boolean {
    const key = assistantMessageContentDeliveryKey(event, binding, text, identity);
    if (this.deliveredAssistantMessageKeys.has(key)) {
      return false;
    }
    this.deliveredAssistantMessageKeys.add(key);
    return true;
  }

  updateAuthorizedActorIds(actorIds: readonly string[]): void{
    this.accessControl.updateAuthorizedActorIds(actorIds);
  }

  dispose(): void {
    this.disposed = true;
    this.progressiveBrowseByConversation.clear();
    this.browseQueryPool.clear();
    this.browseRenderGenerations.clear();
    this.unregisterAutomationSourceMessageDeliveryHandler();
    this.unregisterAutomationTargetMessageDeliveryHandler();
    this.turnAdmission.dispose();
    this.queueRecoveries.dispose();
    this.turns.dispose();
    this.sharedQueueNotices.clear();
    this.sharedQueueNoticeHistory.clear();
    this.inboundTurns.clearAdmissionTiming();
    for (const timer of this.monitorTimersByBindingId.values()) {
      clearTimeout(timer);
    }
    this.monitorTimersByBindingId.clear();
    for (const timer of this.monitorTimersBySubscriptionId.values()) {
      clearTimeout(timer);
    }
    this.monitorTimersBySubscriptionId.clear();
    this.inboundTurns.clearPendingPrompts();
    this.toolUpdatePolicy.dispose();
    this.taskMonitorMessagingOrigins.clear();
    this.activeAgentMessagingOriginsByTurnKey.clear();
    this.startingAgentMessagingOriginsByThreadKey.clear();
    this.backendEventRouter.dispose();
    this.privateResponses.dispose();
    this.privateReplyClaims.dispose();
    this.assistantStreamCancellationFailures.clear();
    for (const cancellation of this.assistantStreamCancellationSignals.values()) {
      cancellation.cancel();
    }
    this.assistantStreamCancellationSignals.clear();
    this.workingUpdateCancellationFailures.clear();
    for (const cancellation of this.workingUpdateCancellationSignals.values()) {
      cancellation.cancel();
    }
    this.workingUpdateCancellationSignals.clear();
    this.workingUpdateDeliveries.clear();
    this.workingUpdateSurfaces.clear();
    this.queuedAgentMessagingOriginsByQueueKey.clear();
  }

  /** Resolves after already-started tool-update batches finish their writes. */
  async whenToolUpdatesSettled(): Promise<void> {
    await this.toolUpdatePolicy.whenIdle();
  }

  /** Resolves after detached queued-message actions finish. */
  async whenQueuedTurnActionsSettled(): Promise<void> {
    await Promise.all(this.queuedTurnActions);
  }

  private async presentResumeBrowser(
    event: MessagingInboundCommandEvent,
    options?: {
      cancelDestination?: MessagingBrowseSessionRecord["cancelDestination"];
      targetSurface?: MessagingSurfaceRef;
    },
  ): Promise<void> {
    const parsed = parseResumeCommandArgs(event.args);
    if (parsed.error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("resume-error"),
          createdAt: this.now(),
          title: "Resume command error",
          body: parsed.error,
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.presentProgressiveBrowse(event, {
      backend: "all",
      filter: parsed.query,
    }, async (navigation, current) => {
      const selectedBackend =
        isNewThreadLaunchAction(parsed.launchAction)
          ? await this.newThreadWorkflow.resolveNewThreadBackendForSession(
              {
                launchpadBackend: navigation.launchpadDefaults.backend,
              },
              event,
            )
          : undefined;
      if (isNewThreadLaunchAction(parsed.launchAction) && !selectedBackend) {
        return;
      }
      const selectedDirectory = navigation.directory;
      const preferences = parsed.preferences
        ? {
            ...parsed.preferences,
            updatedAt: this.now(),
          }
        : undefined;
      const session: MessagingBrowseSessionRecord = {
        id: this.newIntentId("browse"),
        allowedActorIds: [event.actor.platformUserId],
        backend: selectedBackend?.kind,
        cancelDestination: options?.cancelDestination,
        channel: event.channel,
        createdAt: this.now(),
        updatedAt: this.now(),
        expiresAt: this.now() + this.pendingIntentTtlMs,
        launchAction: parsed.launchAction,
        mode: parsed.cwd && parsed.mode === "recents" ? "project_threads" : parsed.mode,
        pageIndex: 0,
        pageSize: resumeBrowserPageSize(this.capabilityProfile),
        preferences,
        query: parsed.query,
        directorySelector: parsed.cwd,
        returnTo: parsed.launchAction === "start_new_thread"
          ? {
              launchAction: "resume_thread",
              mode: "recents",
              pageIndex: 0,
              preferences,
              query: parsed.query,
        directorySelector: parsed.cwd,
            }
          : undefined,
        selectedProject: selectedDirectory
          ? {
              directoryKey: selectedDirectory.key,
              label: selectedDirectory.label,
              path: selectedDirectory.path,
            }
          : undefined,
        surface: options?.targetSurface,
      };
      await this.renderResumeBrowser(session, navigation, event, current);
      return session;
    }, parsed.cwd);
  }

  private async presentAgentBrowser(
    event: MessagingInboundCommandEvent,
    options?: {
      cancelDestination?: MessagingBrowseSessionRecord["cancelDestination"];
      targetSurface?: MessagingSurfaceRef;
    },
  ): Promise<void> {
    const parsed = parseResumeCommandArgs(event.args);
    if (parsed.error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("agent-error"),
          createdAt: this.now(),
          title: "Agent command error",
          body: parsed.error,
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.presentProgressiveBrowse(event, {
      backend: "all",
      filter: parsed.query,
    }, async (navigation, current) => {
      const selectedBackend =
        parsed.launchAction === "start_new_thread"
          ? await this.newThreadWorkflow.resolveNewThreadBackendForSession(
              {
                launchpadBackend: navigation.launchpadDefaults.backend,
              },
              event,
            )
          : undefined;
      if (parsed.launchAction === "start_new_thread" && !selectedBackend) {
        return;
      }
      const selectedDirectory = navigation.directory;
      const session: MessagingBrowseSessionRecord = {
        id: this.newIntentId("browse"),
        allowedActorIds: [event.actor.platformUserId],
        backend: selectedBackend?.kind,
        cancelDestination: options?.cancelDestination,
        channel: event.channel,
        createdAt: this.now(),
        updatedAt: this.now(),
        expiresAt: this.now() + this.pendingIntentTtlMs,
        launchAction: parsed.launchAction === "start_new_thread"
          ? "start_new_agent_thread"
          : "resume_thread",
        mode: parsed.launchAction === "start_new_thread" ? "new_project" : "agents",
        pageIndex: 0,
        pageSize: resumeBrowserPageSize(this.capabilityProfile),
        preferences: parsed.preferences
          ? {
              ...parsed.preferences,
              updatedAt: this.now(),
            }
          : undefined,
        query: parsed.query,
        directorySelector: parsed.cwd,
        selectedProject: selectedDirectory
          ? {
              directoryKey: selectedDirectory.key,
              label: selectedDirectory.label,
              path: selectedDirectory.path,
            }
          : undefined,
        surface: options?.targetSurface,
      };
      await this.renderResumeBrowser(session, navigation, event, current);
      return session;
    }, parsed.cwd);
  }

  private async presentProgressiveBrowse(
    event: MessagingInboundEvent,
    _request: { backend?: "all"; filter?: string },
    initial: (navigation: MessagingLaunchpadContext, current: () => boolean) => Promise<MessagingBrowseSessionRecord | undefined>,
    _requestedDirectory?: string,
  ): Promise<void> {
    const key = buildMessagingConversationKey(event.channel);
    const generation = Symbol("browse");
    this.progressiveBrowseByConversation.set(key, generation);
    const current = (): boolean => !this.disposed && this.progressiveBrowseByConversation.get(key) === generation;
    try {
      const configuration = await readMessagingLaunchpadContext({ backend: this.options.backend });
      if (current()) await initial(configuration, current);
    } finally {
      if (current()) this.progressiveBrowseByConversation.delete(key);
    }
  }

  private async presentDefaultAgentAssignmentBrowser(
    event: MessagingInboundEvent,
    scopeKind: MessagingDefaultAgentScopeKind,
  ): Promise<void> {
    const scope = defaultAgentScopeForChannel(event.channel, scopeKind);
    if (!scope) {
      await this.deliverDefaultAgentCommandError(
        event,
        `This messaging surface does not expose a normalized ${scopeKind} scope.`,
      );
      return;
    }
    const navigation = await readMessagingLaunchpadContext({ backend: this.options.backend });
    const session: MessagingBrowseSessionRecord = {
      id: this.newIntentId("default-agent-browse"),
      allowedActorIds: [event.actor.platformUserId],
      channel: event.channel,
      createdAt: this.now(),
      updatedAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
      launchAction: "assign_default_agent",
      defaultAgentScope: scope,
      mode: "agents",
      pageIndex: 0,
      pageSize: resumeBrowserPageSize(this.capabilityProfile),
    };
    await this.renderResumeBrowser(session, navigation, event);
  }

  private async clearDefaultAgentAssignment(
    event: MessagingInboundEvent,
    scopeKind: MessagingDefaultAgentScopeKind,
  ): Promise<void> {
    const scope = defaultAgentScopeForChannel(event.channel, scopeKind);
    if (!scope) {
      await this.deliverDefaultAgentCommandError(
        event,
        `This messaging surface does not expose a normalized ${scopeKind} scope.`,
      );
      return;
    }
    const assignment =
      await this.options.store.findActiveDefaultAgentAssignmentForScope(scope);
    if (assignment) {
      await this.options.store.revokeDefaultAgentAssignment({
        assignmentId: assignment.id,
        revokedAt: this.now(),
      });
    }
    await this.presentDefaultAgentStatus(event, {
      notice: assignment
        ? `${formatDefaultAgentScope(scope)} default cleared.`
        : `No ${formatDefaultAgentScope(scope)} default was configured.`,
    });
  }

  private async presentDefaultAgentStatus(
    event: MessagingInboundEvent,
    options: { notice?: string } = {},
  ): Promise<void> {
    const exactScope = defaultAgentScopeForChannel(event.channel, "conversation")!;
    const exact =
      await this.options.store.findActiveDefaultAgentAssignmentForScope(exactScope);
    const effective =
      await this.options.store.findActiveDefaultAgentAssignmentForChannel(event.channel);
    let targetLabel: string | undefined;
    if (effective) {
      try {
        targetLabel = (await this.readExactNavigationThread({
          ref: { backend: effective.target.backend, threadId: effective.target.threadId },
        }))?.title;
      } catch {
        targetLabel = undefined;
      }
    }
    const body = [
      options.notice,
      effective
        ? `Effective default: ${targetLabel ?? effective.target.threadId} (${formatDefaultAgentScope(effective.scope)}).`
        : "Effective default: none.",
      exact
        ? "This conversation has an explicit default."
        : "This conversation has no explicit default.",
      "",
      "Use /agent default set [scope] or /agent default clear [scope].",
    ].filter((line): line is string => line !== undefined).join("\n");
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("default-agent-status"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Default Agent",
        body,
        actions: [
          {
            id: "agent-default:set",
            label: exact ? "Change" : "Set",
            style: "primary",
            fallbackText: "set",
          },
          {
            id: "agent-default:clear",
            label: "Clear",
            style: "secondary",
            disabled: !exact,
            fallbackText: "clear",
          },
        ],
      }),
      undefined,
      event,
    );
  }

  private async deliverDefaultAgentCommandError(
    event: MessagingInboundEvent,
    body: string,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("default-agent-error"),
        createdAt: this.now(),
        title: "Default Agent command error",
        body,
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async retireBrowseSession(
    session: MessagingBrowseSessionRecord,
  ): Promise<void> {
    this.browseQueryPool.release(session.id);
    this.inboundTurns.clearPendingNewThreadPrompt(session.id);
    this.inboundTurns.pendingFullAccessNewThreadPrompts.delete(session.id);
    await this.options.store.deleteBrowseSession(session.id);
    try {
      const removed = await this.options.store.deletePendingIntentsForChannel({
        channel: session.channel,
      });
      if (removed.length > 0) {
        this.logger.debug?.("messaging retired channel pending intents on browse close", {
          channel: session.channel.channel,
          removedCount: removed.length,
          sessionId: session.id,
        });
      }
    } catch (error) {
      this.logger.debug?.("messaging pending-intent cleanup failed on browse close", {
        channel: session.channel.channel,
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.id,
      });
    }
  }

  private async renderResumeBrowser(
    session: MessagingBrowseSessionRecord,
    _navigation: MessagingNewThreadNavigation,
    event: MessagingInboundEvent,
    stillCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (!stillCurrent()) return;
    const parentCurrent = stillCurrent;
    const token = Symbol("browse-render");
    this.browseRenderGenerations.set(session.id, token);
    stillCurrent = () => parentCurrent() && this.browseRenderGenerations.get(session.id) === token;
    const inventory = await this.options.backend.listNavigationOwners?.() ?? { owners: [{ label: "This instance" }], omitted: 0 };
    const canReadRemote = this.accessControl.actorHasPermission(event, "federation.remote_control");
    let owners = inventory.owners.filter((owner) => !owner.target || (canReadRemote && session.launchAction !== "assign_default_agent"));
    if (!session.directorySelector && session.selectedProject && session.mode !== "projects" && session.mode !== "new_project") {
      const target = session.selectedProject.federationTarget;
      owners = target?.scope === "remote"
        ? (canReadRemote ? [{ target, label: inventory.owners.find((owner) => owner.target?.instanceId === target.instanceId)?.label ?? target.instanceId }] : [])
        : owners.filter((owner) => !owner.target);
    }
    const backendSummaries = session.launchAction === "assign_default_agent" ? await this.inboundTurns.loadDefaultAgentBackendSummaries() : undefined;
    const eligibility = {
      filter: session.query,
      agentOnly: session.mode === "agents" || session.launchAction === "assign_default_agent",
      ...(session.launchAction === "assign_default_agent" ? { allowedBackends: ["codex" as const,
        ...(backendSummaries ?? []).filter((backend) => backend.kind !== "codex" && defaultAgentBackendSupport(backend.kind, backendSummaries) === "supported")
          .map((backend) => backend.kind)] } : {}),
      excludeFullAccess: session.launchAction === "resume_thread" && !await this.accessControl.canResumeFullAccessThreads(),
    };
    const query: NavigationQuery = session.mode === "projects" || session.mode === "new_project"
      ? { kind: "messaging-projects", ...eligibility, scratchpadFirst: isNewThreadLaunchAction(session.launchAction) }
      : { kind: "messaging-threads", ...eligibility, directoryKey: session.directorySelector ?? session.selectedProject?.directoryKey };
    const publish = async (page: Awaited<ReturnType<MessagingBrowseQueryPool["read"]>>): Promise<void> => {
      if (!stillCurrent()) return;
      session = { ...session, pageIndex: page.pageIndex, ...(page.selectedProject ? { selectedProject: page.selectedProject } : {}) };
      await this.options.store.upsertBrowseSession(session);
      const intent = buildBoundedResumeIntent({ id: this.newIntentId("resume"), createdAt: this.now(), page, session });
      if (!stillCurrent()) return;
      await this.storePendingIntent(intent, undefined, event);
      if (!stillCurrent()) return;
      const result = await this.deliver(intent, undefined, event);
      if (!stillCurrent() || !result.surface) {
        return;
      }

      session = { ...session, surface: result.surface, updatedAt: this.now() };
      await this.options.store.upsertBrowseSession(session);
      await this.options.store.upsertPendingIntent({
        id: intent.id,
        channel: event.channel,
        intent,
        allowedActorIds: [event.actor.platformUserId],
        createdAt: this.now(),
        expiresAt: this.now() + this.pendingIntentTtlMs,
        surface: result.surface,
      });
    };
    try {
      const page = await this.browseQueryPool.read({ sessionId: session.id, query, owners,
        omittedOwners: canReadRemote ? inventory.omitted : 0, pageSize: session.pageSize, pageIndex: session.pageIndex, onProgress: publish });
      await publish(page);
    } catch (error) {
      if (stillCurrent()) throw error;
    } finally {
      if (this.browseRenderGenerations.get(session.id) === token) this.browseRenderGenerations.delete(session.id);
    }
  }

  private async presentStatus(event: MessagingInboundEvent): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("status-unbound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "No thread bound",
          body: "Use /resume to choose a PwrAgent thread for this conversation.",
          actions: [
            {
              id: "command:resume",
              label: "Resume",
              style: "primary",
              fallbackText: "/resume",
            },
          ],
        }),
        undefined,
        event,
      );
      return;
    }

    await this.bindingService.recreateBindingStatus(binding, event);
  }

  private supportsMonitorTopicControls(channel: MessagingChannelRef): boolean {
    return channel.channel === "telegram" &&
      (channel.conversation.kind === "topic" || channel.conversation.kind === "channel");
  }

  private async resolveMonitorControlTopic(
    event: MessagingInboundCommandEvent,
  ): Promise<MessagingManagedTopicRecord | undefined> {
    if (event.channel.conversation.kind === "topic") {
      return await this.upsertManagedTopicFromChannel(event, {
        source: "owned",
        lifecycle: "open",
        recommendation: "keep",
      });
    }

    if (event.channel.conversation.kind !== "channel") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("topics-not-supergroup"),
          createdAt: this.now(),
          title: "Telegram supergroup required",
          body: "Open Monitor from a Telegram supergroup or one of its topics so PwrAgent can manage forum topics.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return undefined;
    }

    const supergroupId = event.channel.conversation.id;
    const knownTopics = await this.options.store.findManagedTopicsForSupergroup({
      channel: event.channel.channel,
      supergroupId,
    });
    const existing = knownTopics.find(
      (topic) => topic.source === "owned" && topic.lifecycle !== "deleted",
    );
    if (existing) {
      return existing;
    }

    if (!this.adapter.createManagedConversation) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("topics-create-unsupported"),
          createdAt: this.now(),
          title: "Topic creation unavailable",
          body: "This adapter cannot create a PwrAgent control topic. Run this from an existing Telegram topic to adopt it instead.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return undefined;
    }

    const result = await this.adapter.createManagedConversation({
      actor: event.actor,
      parent: event.channel,
      routingState: event.routingState,
      title: "PwrAgent topic owner",
    });
    if (result.outcome !== "created" || !result.conversation) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("topics-create-failed"),
          createdAt: this.now(),
          title: "Topic creation failed",
          body: result.errorMessage ?? "Telegram could not create the PwrAgent control topic.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return undefined;
    }

    return await this.options.store.upsertManagedTopic(
      managedTopicRecordFromConversation({
        actorIds: this.accessControl.monitorAuthorizedActorIds(event),
        channel: event.channel.channel,
        conversation: result.conversation,
        now: this.now(),
        routingState: result.routingState,
        source: "owned",
      }),
    );
  }

  private eventForManagedTopic(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
    args: string[],
  ): MessagingInboundCommandEvent {
    return {
      ...event,
      id: `${event.id}:topic:${topic.id}`,
      kind: "command",
      channel: topicChannelRef(topic),
      command: "monitor",
      args,
      rawText: `/monitor ${args.join(" ")}`,
      routingState: topic.routingState ?? event.routingState,
    };
  }

  private async deliverInvalidTopicApproval(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("topics-approval-invalid"),
        createdAt: this.now(),
        title: "Topic action expired",
        body: "That cleanup proposal is no longer active. Run /monitor topics cleanup to refresh it.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async renderTopicControlStatus(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
  ): Promise<void> {
    const rights = await this.adapter.getManagedConversationRights?.({
      actor: event.actor,
      channel: event.channel,
      routingState: event.routingState,
    });
    const topics = await this.options.store.findManagedTopicsForSupergroup({
      channel: event.channel.channel,
      supergroupId: topic.supergroupId,
    });
    const rightsLines = rights
      ? formatManagedTopicRights(rights.operations)
      : ["Topic operations: unsupported by this adapter"];
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("topics-control"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "PwrAgent topic owner",
        body: [
          `Control topic: ${topic.title ?? topic.topicId}`,
          `Known topics: ${topics.length}`,
          "",
          ...rightsLines,
          "",
          "Use /monitor topics cleanup for a dry-run cleanup proposal.",
          "Use /monitor topics fanout to create or reuse per-thread monitor topics.",
        ].join("\n"),
        actions: [
          {
            id: "monitor:topics:cleanup",
            label: "Dry Run Cleanup",
            style: "secondary",
            fallbackText: "/monitor topics cleanup",
          },
          {
            id: "monitor:topics:fanout",
            label: "Fanout",
            style: "secondary",
            fallbackText: "/monitor topics fanout",
          },
        ],
      }),
      undefined,
      event,
    );
  }

  private async renderTopicCleanupProposal(
    event: MessagingInboundEvent,
    controlTopic: MessagingManagedTopicRecord,
  ): Promise<void> {
    const topics = await this.options.store.findManagedTopicsForSupergroup({
      channel: event.channel.channel,
      supergroupId: controlTopic.supergroupId,
    });
    const now = this.now();
    const items = topics
      .filter((topic) => topic.lifecycle !== "deleted")
      .map((topic): MessagingTopicCleanupProposalItem => {
        const action =
          topic.id === controlTopic.id ||
          topic.source === "owned" ||
          topic.source === "linked"
            ? "keep"
            : topic.lifecycle === "closed"
              ? "delete"
              : "close";
        return {
          id: topic.topicId,
          action,
          reason:
            action === "keep"
              ? "owned or linked topic"
              : action === "delete"
                ? "already closed known topic"
                : "known topic not owned or linked to a PwrAgent thread",
          title: topic.title,
          topicRecordId: topic.id,
        };
      });
    const proposal: MessagingTopicCleanupProposalRecord = {
      id: `topic-cleanup:${controlTopic.supergroupId}:${now}`,
      authorizedActorIds: this.accessControl.monitorAuthorizedActorIds(event),
      channel: event.channel.channel,
      controlTopicRecordId: controlTopic.id,
      createdAt: now,
      items,
      status: "pending",
      supergroupId: controlTopic.supergroupId,
      updatedAt: now,
    };
    await this.options.store.upsertTopicCleanupProposal(proposal);
    const actions = items
      .filter((item) => item.action === "close" || item.action === "delete")
      .slice(0, 6)
      .map((item) => ({
        id: `monitor:topics:approve:${proposal.id}:${item.id}`,
        label: `${item.action === "delete" ? "Delete" : "Close"} ${item.title ?? item.id}`,
        style: item.action === "delete" ? "danger" as const : "secondary" as const,
        fallbackText: `/monitor topics approve ${proposal.id} ${item.id}`,
      }));
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("topics-cleanup"),
        capabilityProfile: this.capabilityProfile,
        createdAt: now,
        title: "Topic cleanup dry run",
        body: formatTopicCleanupProposalBody(items),
        actions,
      }),
      undefined,
      event,
    );
  }

  private async runTopicMonitorFanout(
    event: MessagingInboundEvent,
    controlTopic: MessagingManagedTopicRecord,
  ): Promise<void> {
    if (!this.adapter.createManagedConversation) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("topics-fanout-unsupported"),
          createdAt: this.now(),
          title: "Topic creation unavailable",
          body: "This adapter cannot create managed topics.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const snapshot = await this.readMonitorRows();
    const selected = selectMonitorThreads({ navigation: snapshot }).threads.slice(0, 3);
    const created: string[] = [];
    const reused: string[] = [];
    const failed: string[] = [];
    for (const row of selected) {
      const target = federationTargetForThread(row);
      const thread = await this.readExactNavigationThread({ ref: { backend: row.source, threadId: row.id,
        ...(target?.scope === "remote" ? { ownerInstanceId: target.instanceId } : {}) }, federationTarget: target });
      if (!thread || thread.archivedAt) {
        failed.push(row.title);
        continue;
      }
      const existing = await this.options.store.findThreadTopicLink({
        backend: thread.source,
        channel: event.channel.channel,
        supergroupId: controlTopic.supergroupId,
        threadId: thread.id,
      });
      if (existing) {
        const topic = await this.options.store.getManagedTopic(existing.topicRecordId);
        if (topic) {
          await this.ensureManagedTopicBinding(event, topic, thread);
        }
        reused.push(thread.title);
        continue;
      }
      const result = await this.adapter.createManagedConversation({
        actor: event.actor,
        parent: event.channel,
        routingState: event.routingState,
        title: topicTitleForThread(thread),
      });
      if (result.outcome !== "created" || !result.conversation) {
        failed.push(thread.title);
        continue;
      }
      const topic = await this.options.store.upsertManagedTopic(
        managedTopicRecordFromConversation({
          actorIds: this.accessControl.monitorAuthorizedActorIds(event),
          channel: event.channel.channel,
          conversation: result.conversation,
          now: this.now(),
          routingState: result.routingState,
          source: "linked",
        }),
      );
      await this.options.store.upsertThreadTopicLink({
        id: `topic-link:${event.channel.channel}:${controlTopic.supergroupId}:${thread.source}:${thread.id}`,
        backend: thread.source,
        channel: event.channel.channel,
        createdAt: this.now(),
        supergroupId: controlTopic.supergroupId,
        threadId: thread.id,
        topicRecordId: topic.id,
        updatedAt: this.now(),
      });
      const bindingOutcome = await this.ensureManagedTopicBinding(event, topic, thread);
      if (bindingOutcome === "conflict") {
        failed.push(thread.title);
        continue;
      }
      await this.deliverTopicSeed(event, topic, thread);
      created.push(thread.title);
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("topics-fanout"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Topic fanout complete",
        body: [
          `Created: ${created.length}${created.length ? ` (${created.join(", ")})` : ""}`,
          `Reused: ${reused.length}${reused.length ? ` (${reused.join(", ")})` : ""}`,
          `Failed: ${failed.length}${failed.length ? ` (${failed.join(", ")})` : ""}`,
        ].join("\n"),
        actions: [],
      }),
      undefined,
      event,
    );
  }

  private async deliverTopicSeed(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
    thread: NavigationThreadSummary,
  ): Promise<void> {
    const project =
      thread.linkedDirectories[0]?.label ??
      thread.linkedDirectories[0]?.path;
    await this.deliver({
      id: this.newIntentId("topic-seed"),
      kind: "message",
      createdAt: this.now(),
      audit: buildMessagingAuditContext({
        action: "topics.seed",
        actor: event.actor,
        backend: thread.source,
        channel: topicChannelRef(topic),
        now: this.now(),
        threadId: thread.id,
      }),
      parts: [
        {
          type: "text",
          text: [
            `Monitoring: ${thread.title}`,
            `Backend: ${thread.source}`,
            project ? `Project: ${project}` : undefined,
            thread.updatedAt ? `Updated: ${formatTimeOfDay(thread.updatedAt)}` : undefined,
            "",
            "This topic is attached to the thread for follow-up messages.",
          ].filter(Boolean).join("\n"),
        },
      ],
    });
  }

  private async ensureManagedTopicBinding(
    event: MessagingInboundEvent,
    topic: MessagingManagedTopicRecord,
    thread: NavigationThreadSummary,
  ): Promise<"bound" | "existing" | "conflict"> {
    const channel = topicChannelRef(topic);
    const existing = await this.options.store.findActiveBindingForChannel(channel);
    if (existing) {
      if (existing.backend === thread.source && existing.threadId === thread.id) {
        return "existing";
      }
      this.logger.debug?.("managed topic already bound to another thread", {
        backend: existing.backend,
        bindingId: existing.id,
        threadId: existing.threadId,
        topicId: topic.topicId,
      });
      return "conflict";
    }

    await this.bindingService.bindChannelToThread(
      {
        ...event,
        id: `${event.id}:topic-bind:${topic.id}`,
        kind: "command",
        channel,
        command: "monitor",
        args: ["topics", "fanout"],
        rawText: "/monitor topics fanout",
        receivedAt: this.now(),
        routingState: topic.routingState ?? event.routingState,
      } satisfies MessagingInboundCommandEvent,
      {
        backend: thread.source,
        threadId: thread.id,
      },
    );
    return "bound";
  }

  private async observeManagedTopicFromInbound(
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (
      event.channel.conversation.kind !== "topic" ||
      !event.channel.conversation.parentId
    ) {
      return;
    }
    const observedAt = event.receivedAt;
    await this.options.store.mergeManagedTopicObservation({
      ...managedTopicRecordFromConversation({
        actorIds: this.accessControl.monitorAuthorizedActorIds(event),
        channel: event.channel.channel,
        conversation: event.channel.conversation,
        now: observedAt,
        routingState: event.routingState,
        source: "observed",
      }),
      lastObservedAt: observedAt,
      lifecycle: "open",
      updatedAt: observedAt,
    });
  }

  private async upsertManagedTopicFromChannel(
    event: MessagingInboundEvent,
    options: Pick<
      MessagingManagedTopicRecord,
      "source" | "lifecycle" | "recommendation"
    >,
  ): Promise<MessagingManagedTopicRecord> {
    const now = this.now();
    const existing = await this.options.store.findManagedTopicByConversation({
      channel: event.channel.channel,
      supergroupId: event.channel.conversation.parentId ?? "",
      topicId: event.channel.conversation.id,
    });
    return await this.options.store.upsertManagedTopic({
      ...managedTopicRecordFromConversation({
        actorIds: this.accessControl.monitorAuthorizedActorIds(event),
        channel: event.channel.channel,
        conversation: event.channel.conversation,
        now,
        routingState: event.routingState,
        source: options.source,
      }),
      ...existing,
      authorizedActorIds: existing?.authorizedActorIds.length
        ? existing.authorizedActorIds
        : this.accessControl.monitorAuthorizedActorIds(event),
      lastObservedAt: now,
      lifecycle: options.lifecycle,
      recommendation: options.recommendation ?? existing?.recommendation,
      routingState: event.routingState ?? existing?.routingState,
      source: existing?.source === "owned" || existing?.source === "linked"
        ? existing.source
        : options.source,
      updatedAt: now,
    });
  }

  private async enableAndRenderChannelMonitor(
    event: MessagingInboundEvent,
    action: MonitorCommandAction = { kind: "start" },
  ): Promise<MessagingMonitorSubscriptionRecord> {
    const now = this.now();
    const existing =
      await this.options.store.findActiveMonitorSubscriptionForChannel(event.channel);
    const monitorOptions = resolveMonitorStateOptions(existing?.monitor, action);
    const subscription = await this.options.store.upsertMonitorSubscription({
      id: existing?.id ?? buildMonitorSubscriptionId(event.channel),
      channel: event.channel,
      authorizedActorIds: existing?.authorizedActorIds.length
        ? existing.authorizedActorIds
        : this.accessControl.monitorAuthorizedActorIds(event),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      monitor: {
        ...existing?.monitor,
        enabled: true,
        intervalMs: monitorOptions.intervalMs,
        lastRenderedAt: existing?.monitor.lastRenderedAt,
        pinnedThreadLimit: monitorOptions.pinnedThreadLimit,
        recentThreadLimit: monitorOptions.recentThreadLimit,
        showLastResponseSnippet: monitorOptions.showLastResponseSnippet,
        showStatusLine: monitorOptions.showStatusLine,
        updatedAt: now,
      },
      monitorSurface: existing?.monitorSurface,
    });
    if (existing) {
      this.clearMonitorSubscriptionTimer(existing.id);
    }
    try {
      const rendered = await this.renderChannelMonitorStatus(subscription, event);
      this.scheduleMonitorSubscriptionTick(rendered);
      return rendered;
    } catch (error) {
      this.logger.debug?.("messaging channel monitor initial render failed", {
        error: error instanceof Error ? error.message : String(error),
        subscriptionId: subscription.id,
      });
      this.scheduleMonitorSubscriptionTick(subscription);
      return subscription;
    }
  }

  private async stopMonitoringForChannel(
    event: MessagingInboundEvent,
  ): Promise<MessagingMonitorSubscriptionRecord | undefined> {
    const subscription =
      await this.options.store.findActiveMonitorSubscriptionForChannel(event.channel);
    if (!subscription) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("monitor-stopped"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Monitor stopped",
          body: "Monitor was not running for this conversation.",
          actions: [],
        }),
        undefined,
        event,
      );
      return undefined;
    }

    this.clearMonitorSubscriptionTimer(subscription.id);
    const now = this.now();
    if (subscription.monitorSurface) {
      try {
        await this.deliver(
          buildConfirmationIntent({
            id: this.newIntentId("monitor-stopped"),
            capabilityProfile: this.capabilityProfile,
            createdAt: now,
            title: "Monitor stopped",
            body: "Recent thread updates will no longer post to this conversation.",
            actions: [],
            delivery: {
              mode: this.capabilityProfile.text.supportsMessageEdit
                ? "update"
                : "present",
              replaceMarkup: true,
              fallback: "present_new",
            },
            targetSurface: this.capabilityProfile.text.supportsMessageEdit
              ? subscription.monitorSurface
              : undefined,
          }),
          undefined,
          event,
        );
      } catch (error) {
        this.logger.debug?.("messaging channel monitor stop update failed", {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: subscription.id,
        });
      }
    } else {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("monitor-stopped"),
          capabilityProfile: this.capabilityProfile,
          createdAt: now,
          title: "Monitor stopped",
          body: "Recent thread updates will no longer post to this conversation.",
          actions: [],
        }),
        undefined,
        event,
      );
    }

    return await this.options.store.upsertMonitorSubscription({
      ...subscription,
      monitor: {
        ...subscription.monitor,
        enabled: false,
        intervalMs: subscription.monitor.intervalMs,
        lastRenderedAt: subscription.monitor.lastRenderedAt,
        updatedAt: now,
      },
      monitorSurface: undefined,
      updatedAt: now,
    });
  }

  private async enableAndRenderMonitor(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingBindingRecord> {
    const enabledBinding = await this.options.store.upsertBinding({
      ...binding,
      monitor: {
        enabled: true,
        intervalMs: binding.monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS,
        lastRenderedAt: binding.monitor?.lastRenderedAt,
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    try {
      const rendered = await this.renderMonitorStatus(enabledBinding, event);
      this.scheduleMonitorTick(rendered);
      return rendered;
    } catch (error) {
      this.logger.debug?.("messaging monitor initial render failed", {
        bindingId: enabledBinding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: enabledBinding.threadId,
      });
      this.scheduleMonitorTick(enabledBinding);
      return enabledBinding;
    }
  }

  private async stopMonitoringForBinding(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    options: { deliverStatus?: boolean } = {},
  ): Promise<MessagingBindingRecord> {
    this.clearMonitorTimer(binding.id);
    const now = this.now();
    const deliverStatus = options.deliverStatus ?? true;
    if (deliverStatus && binding.monitorSurface) {
      try {
        await this.deliver(
          buildConfirmationIntent({
            id: this.newIntentId("monitor-stopped"),
            capabilityProfile: this.capabilityProfile,
            createdAt: now,
            title: "Monitor stopped",
            body: "Recent thread updates will no longer post to this conversation.",
            actions: [],
            delivery: {
              mode: "update",
              replaceMarkup: true,
              fallback: "present_new",
            },
            targetSurface: binding.monitorSurface,
          }),
          binding,
          event,
        );
      } catch (error) {
        this.logger.debug?.("messaging monitor stop update failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    } else if (deliverStatus && event) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("monitor-stopped"),
          capabilityProfile: this.capabilityProfile,
          createdAt: now,
          title: "Monitor stopped",
          body: binding.monitor?.enabled
            ? "Recent thread updates will no longer post to this conversation."
            : "Monitor was not running for this conversation.",
          actions: [],
        }),
        binding,
        event,
      );
    }

    return await this.options.store.upsertBinding({
      ...binding,
      monitor: {
        enabled: false,
        intervalMs: binding.monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS,
        lastRenderedAt: binding.monitor?.lastRenderedAt,
        updatedAt: now,
      },
      monitorSurface: undefined,
      updatedAt: now,
    });
  }

  private async disableChannelMonitorSubscription(
    subscription: MessagingMonitorSubscriptionRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingMonitorSubscriptionRecord> {
    this.clearMonitorSubscriptionTimer(subscription.id);
    const now = this.now();
    if (subscription.monitorSurface) {
      try {
        await this.deliver(
          buildConfirmationIntent({
            id: this.newIntentId("monitor-detached"),
            capabilityProfile: this.capabilityProfile,
            createdAt: now,
            title: "Monitor detached",
            body: "Recent thread updates will no longer post to this conversation.",
            actions: [],
            delivery: {
              mode: "update",
              replaceMarkup: true,
              fallback: "fail",
            },
            targetSurface: subscription.monitorSurface,
          }),
          undefined,
          event,
        );
      } catch (error) {
        this.logger.debug?.("messaging channel monitor detach update failed", {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: subscription.id,
        });
      }
    }
    return await this.options.store.upsertMonitorSubscription({
      ...subscription,
      monitor: {
        ...subscription.monitor,
        enabled: false,
        intervalMs: subscription.monitor.intervalMs,
        lastRenderedAt: subscription.monitor.lastRenderedAt,
        updatedAt: now,
      },
      monitorSurface: undefined,
      updatedAt: now,
    });
  }

  private async presentSkillsBrowser(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    options: {
      pageIndex?: number;
      query?: string;
      targetSurface?: MessagingSurfaceRef;
    } = {},
  ): Promise<void> {
    if (!this.options.backend.listSkills) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("skills-unavailable"),
          createdAt: this.now(),
          title: "Skills unavailable",
          body: "This runtime does not expose skill browsing through messaging.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    try {
      const navigation: MessagingThreadContext = { kind: "thread", thread: await this.readBoundNavigationThread(binding) };
      const threadState = resolveMessagingThreadState({ binding, navigation });
      const cwds = skillSearchCwdsForThreadState(threadState);
      const response = await this.options.backend.listSkills({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        ...(cwds.length > 0 ? { cwds: [...new Set(cwds)] } : {}),
      });
      const targetSurface = options.targetSurface ??
        await this.findActiveSkillsWorkflowSurface(binding, event);
      await this.deliverAndStoreSkillsWorkflow(
        buildSkillsBrowserIntent({
          id: this.newIntentId("skills-browser"),
          binding,
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          entries: flattenSkillEntries(
            response.data,
            threadState.thread?.linkedDirectories,
            response.bundledSkillRoots,
          ),
          pageIndex: options.pageIndex,
          query: options.query,
          targetSurface,
        }),
        binding,
        event,
      );
    } catch (error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("skills-list-failed"),
          createdAt: this.now(),
          title: "Skills unavailable",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        binding,
        event,
      );
    }
  }

  private async presentSkillsSearchPrompt(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const targetSurface = await this.findActiveSkillsWorkflowSurface(binding, event);
    await this.deliverAndStoreSkillsWorkflow(
      buildSkillsSearchPromptIntent({
        id: this.newIntentId("skills-search"),
        binding,
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        targetSurface,
      }),
      binding,
      event,
    );
  }

  private async selectPendingSkill(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const selection = skillSelectionFromValue(
      event.value,
      this.now(),
      event.actor.platformUserId,
    );
    if (!selection) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    const updatedBinding = await this.options.store.upsertBinding({
      ...binding,
      pendingSkillSelection: selection,
      updatedAt: this.now(),
    });
    const targetSurface = await this.findActiveSkillsWorkflowSurface(binding, event);
    await this.deliverAndStoreSkillsWorkflow(
      buildSkillSelectedIntent({
        id: this.newIntentId("skill-selected"),
        binding: updatedBinding,
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        selection,
        targetSurface,
      }),
      updatedBinding,
      event,
    );
  }

  private async removePendingSkill(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const { pendingSkillSelection } = binding;
    const updatedBinding = await this.clearPendingSkillSelection(binding);
    const targetSurface = await this.findActiveSkillsWorkflowSurface(binding, event);
    await this.deliverAndStoreSkillsWorkflow(
      buildSkillRemovedIntent({
        id: this.newIntentId("skill-removed"),
        binding: updatedBinding,
        createdAt: this.now(),
        removed: pendingSkillSelection,
        targetSurface,
      }),
      updatedBinding,
      event,
    );
  }

  private async clearPendingSkillSelection(
    binding: MessagingBindingRecord,
  ): Promise<MessagingBindingRecord> {
    const { pendingSkillSelection: _pendingSkillSelection, ...rest } = binding;
    return await this.options.store.upsertBinding({
      ...rest,
      updatedAt: this.now(),
    });
  }

  private async dismissActiveSkillsWorkflow(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    options: { allowCallbackFallback?: boolean } = {},
  ): Promise<boolean> {
    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    const activeSkillsIntent = pendingIntent &&
      pendingIntent.bindingId === binding.id &&
      isSkillsWorkflowIntent(pendingIntent.intent)
      ? pendingIntent
      : undefined;
    const targetSurface = activeSkillsIntent?.surface ??
      (event.kind === "callback" && (activeSkillsIntent || options.allowCallbackFallback)
        ? event.interaction
        : undefined);

    if (activeSkillsIntent && !activeSkillsIntent.intent.requestContext) {
      await this.options.store.deletePendingIntent(activeSkillsIntent.id);
    }

    if (!activeSkillsIntent && !targetSurface) {
      return false;
    }

    if (targetSurface) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("skills-dismissed"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Skills dismissed",
          body: "Use Skills from the status menu to choose a skill again.",
          actions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "present_new",
          },
          targetSurface,
        }),
        binding,
        event,
      );
    }

    return true;
  }

  private async findActiveSkillsWorkflowSurface(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<MessagingSurfaceRef | undefined> {
    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (
      pendingIntent?.bindingId === binding.id &&
      pendingIntent.surface &&
      isSkillsWorkflowIntent(pendingIntent.intent)
    ) {
      return pendingIntent.surface;
    }
    return undefined;
  }

  private async presentHandoffOverview(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    if (!this.options.backend.handoffThreadWorkspace) {
      await this.deliverHandoffUnavailable(binding, event, "This runtime does not expose workspace handoff through messaging.");
      return;
    }

    const navigation = await this.readBoundWorkspaceContext(binding);
    const context = handoffContextForBinding(binding, navigation);
    if (!context) {
      await this.deliverHandoffUnavailable(binding, event, "This thread does not have enough Git workspace metadata for handoff.");
      return;
    }

    await this.bindingService.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffOverviewIntent({
          id: this.newIntentId("handoff-overview"),
          capabilityProfile: this.capabilityProfile,
          binding,
          context,
          createdAt: this.now(),
        }),
        audit: this.buildHandoffAudit("handoff.overview", binding, event),
      },
      binding,
      event,
    );
  }

  private async presentHandoffProjectPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }
    const context = handoffContextForBinding(binding, await this.readBoundWorkspaceContext(binding));
    if (!context || !this.options.backend.getNavigationQueryPage) {
      await this.deliverHandoffUnavailable(binding, event, "Project selection is unavailable. Use /status to refresh.");
      return;
    }
    const bindingTarget = federationTargetForBinding(binding);
    const target = bindingTarget?.scope === "remote" ? bindingTarget : undefined;
    const pageIndex = branchPageIndexFromValue(event.value);
    const sessionId = `handoff-projects:${binding.id}`;
    if (pageIndex === 0) this.browseQueryPool.release(sessionId);
    const page = await this.browseQueryPool.read({
      sessionId,
      query: { kind: "messaging-projects" },
      owners: [{ target, label: target?.instanceId ?? "Local" }],
      pageSize: Math.min(8, (this.capabilityProfile ? capabilityProfilePageSize(this.capabilityProfile, 4, 8) : 8) || 8),
      pageIndex,
    });
    await this.bindingService.deliverAndStoreStatusSubmode({
      ...buildHandoffProjectPickerIntent({
        id: this.newIntentId("handoff-projects"),
        capabilityProfile: this.capabilityProfile,
        binding, context, createdAt: this.now(),
        page: { ...page, projects: page.projects.filter((directory) =>
          directory.kind === "directory" && directory.path && directory.path !== context.workingDirectoryPath) },
      }),
      audit: this.buildHandoffAudit("handoff.projects", binding, event),
    }, binding, event);
  }

  private async presentHandoffBranchPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    pageIndex = 0,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    const navigation = await this.readBoundWorkspaceContext(binding);
    const context = handoffContextForBinding(binding, navigation);
    if (!context || context.workspaceKind !== "local") {
      await this.deliverHandoffUnavailable(binding, event, "This thread is not currently in a Local workspace that can move to a worktree.");
      return;
    }
    if (context.leaveLocalBranches.length === 0) {
      await this.deliverHandoffUnavailable(binding, event, "No safe branch choices are available to leave checked out in Local.");
      return;
    }

    await this.bindingService.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffBranchPickerIntent({
          id: this.newIntentId("handoff-branch"),
          capabilityProfile: this.capabilityProfile,
          binding,
          context,
          createdAt: this.now(),
          pageIndex,
        }),
        audit: this.buildHandoffAudit("handoff.branch_picker", binding, event),
      },
      binding,
      event,
    );
  }

  private async presentHandoffConfirmation(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    const navigation = await this.readBoundWorkspaceContext(binding);
    const context = handoffContextForBinding(binding, navigation);
    const request = handoffRequestFromValue(event.value);
    if (!context || !request) {
      await this.deliverInvalidHandoffSelection(binding, event);
      return;
    }

    const validation = validateHandoffRequest(request, context);
    if (!validation.valid) {
      await this.deliverHandoffUnavailable(binding, event, validation.reason);
      return;
    }

    await this.bindingService.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffConfirmationIntent({
          id: this.newIntentId("handoff-confirm"),
          capabilityProfile: this.capabilityProfile,
          binding,
          context,
          createdAt: this.now(),
          targetPath: request.targetPath,
          projectPageIndex: branchPageIndexFromValue(event.value),
          leaveLocalBranch: request.leaveLocalBranch,
          strategy: request.strategy,
          direction: request.direction,
        }),
        audit: this.buildHandoffAudit(
          `handoff.confirmation.${request.direction}`,
          binding,
          event,
        ),
      },
      binding,
      event,
    );
  }

  private async executeHandoff(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    if (!this.options.backend.handoffThreadWorkspace) {
      await this.deliverHandoffUnavailable(binding, event, "This runtime does not expose workspace handoff through messaging.");
      return;
    }

    const request = handoffRequestFromValue(event.value);
    if (!request) {
      await this.deliverInvalidHandoffSelection(binding, event);
      return;
    }

    const currentBinding = await this.options.store.getBinding(binding.id);
    if (
      !currentBinding ||
      currentBinding.revokedAt ||
      currentBinding.backend !== binding.backend ||
      currentBinding.threadId !== binding.threadId ||
      !currentBinding.authorizedActorIds.includes(event.actor.platformUserId)
    ) {
      await this.deliverHandoffUnavailable(binding, event, "That handoff prompt is stale. Use /status to refresh.");
      return;
    }

    const navigation = await this.readBoundWorkspaceContext(currentBinding);
    const context = handoffContextForBinding(currentBinding, navigation);
    if (!context) {
      await this.deliverHandoffUnavailable(currentBinding, event, "This thread no longer has enough Git workspace metadata for handoff.");
      return;
    }
    const validation = validateHandoffRequest(request, context);
    if (!validation.valid) {
      await this.deliverHandoffUnavailable(currentBinding, event, validation.reason);
      return;
    }

    await this.deliver(
      {
        ...buildStatusIntent({
          id: this.newIntentId("handoff-running"),
          createdAt: this.now(),
          status: "working",
          text: `Running workspace handoff: ${formatHandoffDirection(request.direction)}.`,
        }),
        audit: this.buildHandoffAudit(
          `handoff.running.${request.direction}`,
          currentBinding,
          event,
        ),
      },
      currentBinding,
      event,
    );

    try {
      const result = await this.options.backend.handoffThreadWorkspace({
        ...request,
        federationTarget: federationTargetForBinding(currentBinding),
      });
      await this.clearActiveHandoffIntent(event);
      const refreshedNavigation: MessagingThreadContext = { kind: "thread", thread: await this.readBoundNavigationThread(currentBinding) };
      const updatedBinding = await this.bindingService.updateBindingAfterHandoff(
        currentBinding,
        result,
      );
      await this.deliver(
        {
          ...buildStatusIntent({
            id: this.newIntentId("handoff-completed"),
            createdAt: this.now(),
            status: "completed",
            text: handoffSuccessText(result),
          }),
          audit: this.buildHandoffAudit(
            `handoff.completed.${request.direction}`,
            updatedBinding,
            event,
          ),
        },
        updatedBinding,
        event,
      );
      await this.bindingService.renderBindingStatus(updatedBinding, event, refreshedNavigation);
    } catch (error) {
      await this.deliver(
        {
          ...buildErrorIntent({
            id: this.newIntentId("handoff-failed"),
            createdAt: this.now(),
            title: "Handoff failed",
            body: error instanceof Error ? error.message : String(error),
            recoverable: true,
          }),
          audit: this.buildHandoffAudit(
            `handoff.failed.${request.direction}`,
            currentBinding,
            event,
          ),
        },
        currentBinding,
        event,
      );
    }
  }

  private async deliverAndStoreSkillsWorkflow(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const activeIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (
      activeIntent &&
      activeIntent.id !== intent.id &&
      activeIntent.bindingId === binding.id &&
      !activeIntent.intent.requestContext
    ) {
      await this.options.store.deletePendingIntent(activeIntent.id);
    }
    const pendingIntent = await this.storePendingIntent(intent, binding, event);
    const result = await this.deliver(intent, binding, event);
    if (!result.surface) {
      return;
    }
    await this.options.store.upsertPendingIntent({
      ...pendingIntent,
      surface: result.surface,
    });
  }

  private async clearActiveHandoffIntent(event: MessagingInboundEvent): Promise<void> {
    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (pendingIntent && pendingIntent.intent.id.includes("handoff")) {
      await this.options.store.deletePendingIntent(pendingIntent.id);
    }
  }

  private handoffBlockedByActiveTurn(binding: MessagingBindingRecord): boolean {
    const activeTurn = this.getActiveTurn(binding);
    return Boolean(activeTurn && ["working", "waiting"].includes(activeTurn.status));
  }

  private async deliverHandoffUnavailable(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    body: string,
  ): Promise<void> {
    await this.deliver(
      {
        ...buildErrorIntent({
          id: this.newIntentId("handoff-unavailable"),
          createdAt: this.now(),
          title: "Handoff unavailable",
          body,
          recoverable: true,
        }),
        audit: this.buildHandoffAudit("handoff.unavailable", binding, event),
      },
      binding,
      event,
    );
  }

  private async deliverInvalidHandoffSelection(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      {
        ...buildErrorIntent({
          id: this.newIntentId("handoff-invalid"),
          createdAt: this.now(),
          title: "Invalid handoff selection",
          body: "That handoff selection is no longer available. Use /status to refresh.",
          recoverable: true,
        }),
        audit: this.buildHandoffAudit("handoff.invalid_selection", binding, event),
      },
      binding,
      event,
    );
  }

  private buildHandoffAudit(
    action: string,
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): NonNullable<MessagingSurfaceIntent["audit"]> {
    return buildMessagingAuditContext({
      action,
      actor: event.actor,
      backend: binding.backend,
      bindingId: binding.id,
      channel: binding.channel,
      now: this.now(),
      threadId: binding.threadId,
    });
  }

  private async presentModelPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    if (models.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-models-unavailable"),
          createdAt: this.now(),
          title: "Models unavailable",
          body: "This backend did not report model choices. Use /status to refresh.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const currentModelId =
      thread?.model ??
      binding.preferences?.model ??
      navigation.defaults.model ??
      models.find((model) => model.current)?.id;

    await this.deliver(
      buildStatusModelPickerIntent({
        id: this.newIntentId("status-model-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        currentModelId,
        models,
        menuValue: event.kind === "callback" ? event.value : undefined,
      }),
      binding,
      event,
    );
  }

  private async presentReasoningPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === thread?.model) ??
      models.find((model) => model.id === binding.preferences?.model) ??
      models.find((model) => model.id === navigation.defaults.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    if (summary && efforts.length === 0) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const fallbackEfforts = efforts.length > 0 ? efforts : ["low", "medium", "high"];
    const currentReasoningEffort =
      resolveReasoningEffortForModel(summary, modelOption, [
        thread?.reasoningEffort,
        binding.preferences?.reasoningEffort,
        navigation.defaults.reasoningEffort,
      ]);

    await this.deliver(
      buildStatusReasoningPickerIntent({
        id: this.newIntentId("status-reasoning-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        currentReasoningEffort,
        efforts: fallbackEfforts,
      }),
      binding,
      event,
    );
  }

  private async presentStatusAcpRuntimeModePicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const runtimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: thread?.acpRuntime ?? binding.preferences?.acpRuntime,
    });
    if (!summary || runtimeMode.choices.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-runtime-unavailable"),
          createdAt: this.now(),
          title: "Permissions unavailable",
          body: "This ACP backend did not report permissions choices. Use /status to refresh.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    await this.bindingService.deliverAndStoreStatusSubmode(
      buildStatusAcpRuntimeModePickerIntent({
        id: this.newIntentId("status-runtime-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        choices: runtimeMode.choices,
        createdAt: this.now(),
        prompt: "Select Permissions",
      }),
      binding,
      event,
    );
  }

  private async presentPermissionsPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    await this.bindingService.deliverAndStoreStatusSubmode(
      buildStatusPermissionsPickerIntent({
        id: this.newIntentId("status-permissions-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        currentMode,
      }),
      binding,
      event,
    );
  }

  private async presentToolUpdateModePicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const currentMode = resolveMessagingToolUpdateMode(
      binding,
      await this.bindingService.resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
    );
    await this.bindingService.deliverAndStoreStatusSubmode(
      buildStatusToolUpdateModePickerIntent({
        id: this.newIntentId("status-tools-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        choices: messagingToolUpdateModeChoices(currentMode),
        createdAt: this.now(),
      }),
      binding,
      event,
    );
  }

  private async presentResponseModePicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.bindingService.deliverAndStoreStatusSubmode(
      buildStatusResponseModePickerIntent({
        id: this.newIntentId("status-response-mode-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        defaultMode: await this.inboundTurns.responseModeForConversation(binding.channel),
      }),
      binding,
      event,
    );
  }

  private async setBindingModel(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const model = readStringValue(event.value, "model");
    if (!model) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.readBoundThreadConfiguration(binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption = models.find((candidate) => candidate.id === model);
    if (summary && !modelOption) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    let updatedBinding = await this.bindingService.updateBindingPreferences(binding, { model });
    const settingsResponse = await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      model,
      fastMode: updatedBinding.preferences?.fastMode,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    const reasoningEffort = settingsResponse?.reasoningEffort;
    if (
      settingsResponse &&
      reasoningEffort !== updatedBinding.preferences?.reasoningEffort
    ) {
      updatedBinding = await this.bindingService.updateBindingPreferences(updatedBinding, {
        reasoningEffort,
      });
    }
    const optimisticNavigation: MessagingThreadContext = {
      ...navigation,
      thread: { ...navigation.thread, model, ...(settingsResponse ? { reasoningEffort } : {}) },
    };
    await this.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
  }

  private async setBindingReasoning(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const reasoningEffort = readStringValue(event.value, "reasoningEffort");
    if (!reasoningEffort) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === thread?.model) ??
      models.find((model) => model.id === binding.preferences?.model) ??
      models.find((model) => model.id === navigation.defaults.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    if (summary && !efforts.includes(reasoningEffort)) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }

    const updatedBinding = await this.bindingService.updateBindingPreferences(binding, {
      reasoningEffort,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      fastMode: updatedBinding.preferences?.fastMode,
      model: updatedBinding.preferences?.model,
      reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    const optimisticNavigation: MessagingThreadContext = {
      ...navigation,
      thread: { ...navigation.thread, reasoningEffort },
    };
    await this.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
  }

  private async setBindingAcpRuntimeMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const source = readAcpRuntimeOptionSource(event.value);
    const optionId = readStringValue(event.value, "optionId");
    const value = readStringValue(event.value, "value");
    if (!source || !optionId || !value) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    if (!isAcpBackendId(binding.backend) || !this.options.backend.setAcpSessionRuntimeOption) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }

    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentRuntime = thread?.acpRuntime ?? binding.preferences?.acpRuntime;
    const runtimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: currentRuntime,
    });
    const choice = runtimeMode.choices.find(
      (candidate) =>
        candidate.source === source &&
        candidate.optionId === optionId &&
        candidate.value === value,
    );
    if (!choice) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    const riskContext: AcpRuntimeRiskWarningContext = {
      bindingId: binding.id,
      kind: "thread",
      label: choice.label,
      optionId,
      source,
      threadId: binding.threadId,
      value,
    };
    if (
      choice.privileged &&
      !messagingAcpRuntimeValueLooksPrivileged(runtimeMode.currentValue)
    ) {
      const allowed = await this.ensureAcpRuntimeModeAllowed(
        riskContext,
        event,
      );
      if (!allowed) {
        return;
      }
    }

    await this.applyBindingAcpRuntimeMode(binding, event, riskContext);
  }

  private async applyBindingAcpRuntimeMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    selection: AcpRuntimeRiskWarningContext & { kind: "thread" },
  ): Promise<void> {
    if (!isAcpBackendId(binding.backend) || !this.options.backend.setAcpSessionRuntimeOption) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentRuntime = thread?.acpRuntime ?? binding.preferences?.acpRuntime;
    const acpRuntime: BackendAcpSessionRuntimeState = {
      ...currentRuntime,
      configValues:
        selection.source === "configOption"
          ? {
              ...(currentRuntime?.configValues ?? {}),
              [selection.optionId]: selection.value,
            }
          : currentRuntime?.configValues,
      currentModeId: selection.source === "mode" || selection.source === "configOption"
        ? selection.value
        : currentRuntime?.currentModeId,
      updatedAt: this.now(),
    };
    const updatedBinding = await this.bindingService.updateBindingPreferences(binding, {
      acpRuntime,
    });
    await this.options.backend.setAcpSessionRuntimeOption({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      source: selection.source,
      optionId: selection.optionId,
      value: selection.value,
    });
    const optimisticNavigation: MessagingThreadContext = {
      ...navigation,
      thread: { ...navigation.thread, acpRuntime },
    };
    await this.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.bindingService.renderBindingStatus(updatedBinding, event, optimisticNavigation);
  }

  private async toggleFastMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    if (
      summary &&
      summary.kind !== "codex"
    ) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentSettings = {
      model: thread?.model ?? binding.preferences?.model,
      fastMode: thread?.fastMode ?? binding.preferences?.fastMode,
      serviceTier: thread?.fastMode !== undefined
        ? thread.serviceTier
        : thread?.serviceTier ?? binding.preferences?.serviceTier,
    };
    const models = summary?.launchpadOptions?.models ?? [];
    const model = models.find((option) => option.id === currentSettings.model)
      ?? defaultBackendModel(models);
    const speeds = codexSpeedOptions(
      model, summary?.codexFastAllowed !== false, summary?.launchpadOptions?.supportsFastMode ?? true,
    );
    if (speeds.length < 2) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const speedPatch = codexSpeedSettings(nextCodexSpeed(speeds, currentSettings));
    const updatedBinding = await this.bindingService.updateBindingPreferences(binding, speedPatch);
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      ...speedPatch,
      model: updatedBinding.preferences?.model,
      reasoningEffort: updatedBinding.preferences?.reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    // Refresh handled by the thread-state update bus.
  }

  private async togglePermissionsMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (isAcpBackendId(binding.backend)) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    // When a queued change is already pending we toggle from the
    // *queued* target (so a second click reverses the queue), not from
    // the currently-applied mode. The registry's setThreadExecutionMode
    // handles "toggle back to currently-applied during queue → cancel".
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    const nextMode = currentMode === "full-access" ? "default" : "full-access";
    const executionMode = nextMode;
    if (executionMode === "full-access") {
      const allowed = await this.accessControl.ensureFullAccessEscalationAllowed(
        {
          backend: binding.backend,
          binding,
          kind: "thread",
          threadId: binding.threadId,
        },
        event,
      );
      if (!allowed) {
        return;
      }
    }
    // Update local binding prefs first so the bus-path render — which
    // fetches the binding fresh from the store — sees the new values
    // even if navigation snapshot hasn't reloaded yet. The registry
    // decides queue-vs-apply; on the queue path the bus emits
    // `thread/executionMode/queued` (not `updated`), and the prefs we
    // wrote here will get unwound naturally if the queue is cancelled
    // before applying — the pre-flip here matches the optimistic-UI
    // behavior the desktop renderer uses, and the bus refresh pulls
    // canonical state on the apply or cancel transition.
    await this.bindingService.updateBindingPreferences(binding, {
      executionMode,
      permissionsMode: nextMode,
    });
    await this.options.backend.setThreadExecutionMode?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      executionMode,
    });
    // Refresh handled by the thread-state update bus on
    // thread/executionMode/updated — see refreshStatusSurfacesForThread.
  }

  private async setBindingPermissionsMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const executionMode = readThreadExecutionModeValue(event.value);
    if (!executionMode) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    const navigation = await this.readBoundThreadConfiguration(binding);
    const thread = findThreadForBinding(navigation, binding);
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    if (executionMode === currentMode) {
      await this.bindingService.clearActiveBindingSubmodeIntent(event, binding);
      await this.bindingService.renderBindingStatus(binding, event, navigation);
      return;
    }
    if (
      isAcpBackendId(binding.backend)
      && executionMode !== "default"
      && !acpBackendDeclaresExecutionMode(
        await this.getBackendSummary(
          binding.backend,
          federationTargetForBinding(binding),
        ),
        executionMode,
      )
    ) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    if (executionMode === "full-access") {
      const allowed = await this.accessControl.ensureFullAccessEscalationAllowed(
        {
          backend: binding.backend,
          binding,
          kind: "thread",
          threadId: binding.threadId,
        },
        event,
      );
      if (!allowed) {
        return;
      }
    }
    await this.bindingService.updateBindingPreferences(binding, {
      executionMode,
      permissionsMode: executionMode,
    });
    await this.bindingService.clearActiveBindingSubmodeIntent(event, binding);
    await this.options.backend.setThreadExecutionMode?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      executionMode,
    });
  }

  private async ensureAcpRuntimeModeAllowed(
    context: AcpRuntimeRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    // RBAC double-gate: a privileged (full-access-equivalent) ACP runtime needs
    // the dedicated danger permission on top of the global Full Access toggle.
    if (
      !(await this.accessControl.requirePermission(
        event,
        "thread.execution.full_access",
        "execution:acp-privileged",
      ))
    ) {
      return false;
    }
    const controls = await this.accessControl.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.accessControl.deliverFullAccessPolicyError(
        context.kind === "thread"
          ? await this.options.store.getBinding(context.bindingId)
          : undefined,
        event,
        `Permissions mode ${context.label} is disabled from messaging by Full Access settings.`,
      );
      return false;
    }

    const warning = await this.accessControl.resolveFullAccessWarning(controls, event);
    if (!warning.shouldWarn) {
      return true;
    }

    await this.presentAcpRuntimeRiskWarning(context, event);
    return false;
  }

  private async presentAcpRuntimeRiskWarning(
    context: AcpRuntimeRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const controls = await this.accessControl.resolveFullAccessControls();
    const warning = await this.accessControl.resolveFullAccessWarning(controls, event);
    const binding =
      context.kind === "thread"
        ? await this.options.store.getBinding(context.bindingId)
        : undefined;
    const session =
      context.kind === "new-thread"
        ? await this.options.store.getBrowseSession(context.sessionId, {
            now: this.now(),
          })
        : undefined;
    const surface =
      context.kind === "thread"
        ? binding?.statusSurface ?? binding?.pinnedStatusSurface
        : session?.surface;
    const actions: MessagingConfirmationIntent["actions"] = [
      {
        id: `${ACP_RUNTIME_RISK_ACTION_PREFIX}accept`,
        label: "Yes",
        style: "primary",
        fallbackText: "yes",
        value: context,
      },
      ...(warning.canDismiss
        ? [
            {
              id: `${ACP_RUNTIME_RISK_ACTION_PREFIX}dismiss`,
              label: "Yes - and stop warning me",
              style: "primary" as const,
              fallbackText: "yes and stop warning me",
              value: context,
            },
          ]
        : []),
      {
        id: `${ACP_RUNTIME_RISK_ACTION_PREFIX}cancel`,
        label: "Cancel",
        style: "secondary",
        fallbackText: "cancel",
        value: context,
      },
    ];

    const intent = buildConfirmationIntent({
      id: this.newIntentId("acp-runtime-risk"),
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      delivery: surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: `Enable ${context.label}?`,
      body: [
        `${context.label} may allow the ACP agent to run commands or edit files with fewer prompts.`,
        "Only enable it for workspaces and prompts you trust.",
      ].join("\n\n"),
      fallbackText: warning.canDismiss
        ? "Reply Yes, Yes - and stop warning me, or Cancel."
        : "Reply Yes or Cancel.",
      actions,
      targetSurface: surface,
    });
    const expiresAt =
      context.kind === "new-thread"
        ? this.now() + MESSAGING_CALLBACK_HANDLE_TTL_MS
        : undefined;
    if (expiresAt !== undefined && session) {
      await this.options.store.upsertBrowseSession({
        ...session,
        expiresAt: Math.max(session.expiresAt, expiresAt),
        textInputExpiresAt: session.textInputExpiresAt ?? session.expiresAt,
        updatedAt: this.now(),
      });
    }
    const pending = await this.storePendingIntent(
      intent,
      binding,
      event,
      expiresAt === undefined ? undefined : { expiresAt },
    );
    const result = await this.deliver(intent, binding, event);
    if (result.surface) {
      await this.options.store.upsertPendingIntent({
        ...pending,
        surface: result.surface,
      });
    }
  }

  private async stopActiveTurn(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const requestedTurn = readStatusStopTurnValue(
      event.kind === "callback" ? event.value : undefined,
      binding,
    );
    const activeTurn = this.getActiveTurn(binding);
    const activeTurnIsInterruptible =
      activeTurn && ["working", "waiting"].includes(activeTurn.status);
    const targetTurn = requestedTurn
      ? !activeTurn
        ? requestedTurn
        : activeTurnIsInterruptible && activeTurn.turnId === requestedTurn.turnId
          ? activeTurn
          : undefined
      : activeTurnIsInterruptible
        ? activeTurn
        : undefined;
    if (!targetTurn) {
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    try {
      await this.options.backend.interruptTurn?.({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        threadId: binding.threadId,
        turnId: targetTurn.turnId,
      });
    } catch (error) {
      if (activeTurn) {
        await this.signalTurnActivity(binding, activeTurn, {
          force: true,
          reason: "stop_failed",
        });
      }
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-stop-failed"),
          createdAt: this.now(),
          title: "Stop failed",
          body: error instanceof Error
            ? error.message
            : "The backend did not accept the stop request.",
          recoverable: true,
        }),
        binding,
        event,
      );
      await this.bindingService.renderBindingStatus(binding, event);
      return;
    }
    if (
      !activeTurn ||
      (activeTurnIsInterruptible && activeTurn.turnId === targetTurn.turnId)
    ) {
      const interruptedTurn: MessagingActiveTurnSummary = {
        ...targetTurn,
        status: "interrupted",
        updatedAt: this.now(),
      };
      this.setActiveTurn(binding, interruptedTurn);
      await this.signalTurnActivity(binding, interruptedTurn, {
        force: true,
      });
    }
    await this.bindingService.renderBindingStatus(binding, event);
  }

  private async toggleThreadLock(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.backend.setThreadLock) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-lock-unavailable"),
          createdAt: this.now(),
          title: "Lock unavailable",
          body: "This backend does not expose thread locks through messaging.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }
    // The button carries the state it asks for. A text fallback carries
    // none, and toggles the thread's current state. A chat has no note
    // field, so a lock from here carries none; one set elsewhere keeps its
    // note.
    const requested = event.kind === "callback" && event.value
      && typeof (event.value as { locked?: unknown }).locked === "boolean"
      ? (event.value as { locked: boolean }).locked
      : undefined;
    const locked = requested ?? !findThreadForBinding(
      await this.readBoundThreadConfiguration(binding),
      binding,
    )?.lock;
    await this.options.backend.setThreadLock({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      locked,
    });
    // Refresh handled by the thread-state update bus.
  }

  private async compactThread(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.backend.compactThread) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-compact-unavailable"),
          createdAt: this.now(),
          title: "Compact unavailable",
          body: "This backend does not expose thread compaction through messaging.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const compacted = await this.options.backend.compactThread({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
    });
    const activeTurn: MessagingActiveTurnSummary = {
      turnId: compacted.turnId,
      status: "working",
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, activeTurn);
    await this.signalTurnActivity(binding, activeTurn, {
      force: true,
    });
    await this.bindingService.renderBindingStatus(binding, event);
  }

  private async cycleToolUpdateMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.presentToolUpdateModePicker(binding, event);
  }

  private async setToolUpdateMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const toolUpdateMode = readMessagingToolUpdateModeValue(event.value);
    if (!toolUpdateMode) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    const updatedBinding = await this.bindingService.updateBindingPreferences(binding, {
      toolUpdateMode,
    });
    await this.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.bindingService.renderBindingStatus(updatedBinding, event);
  }

  private async setBindingResponseMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const selected = readStringValue(event.value, "responseMode");
    if (
      selected !== "inherit" &&
      selected !== "mention_only" &&
      selected !== "every_message"
    ) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    const {
      responseMode: _previousResponseMode,
      ...preferences
    } = binding.preferences ?? { updatedAt: this.now() };
    const updatedBinding = await this.options.store.upsertBinding({
      ...binding,
      preferences: {
        ...preferences,
        ...(selected === "inherit" ? {} : { responseMode: selected }),
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    await this.bindingService.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.bindingService.renderBindingStatus(updatedBinding, event);
  }

  private async cycleStreamingResponseMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const currentMode = resolveMessagingStreamingResponseMode(binding);
    const nextMode = nextMessagingStreamingResponseMode(
      currentMode,
      this.streamingResponsesDefault,
    );
    // Sticky-reveal: once streaming has been enabled on this thread (now, or by
    // this toggle), keep the control visible so it can be turned back on/off
    // even after the global setting hides it for other threads.
    const streamingControlRevealed =
      binding.preferences?.streamingControlRevealed ||
      currentMode === "enabled" ||
      nextMode === "enabled";
    const updatedBinding = await this.bindingService.updateBindingPreferences(binding, {
      streamingResponses: nextMode,
      ...(streamingControlRevealed ? { streamingControlRevealed: true } : {}),
    });
    await this.bindingService.renderBindingStatus(updatedBinding, event);
  }

  private async getBackendSummary(
    backend: AppServerBackendKind,
    federationTarget?: FederationTarget,
  ) {
    const response = await this.options.backend.listBackends?.({
      includeUnavailable: true,
      federationTarget,
    });
    return response?.backends.find((candidate) => candidate.kind === backend);
  }

  private rememberContextUsageSummary(event: AgentEvent): void {
    const params = event.notification.params as {
      threadId?: unknown;
      tokenUsage?: unknown;
    };
    if (typeof params.threadId !== "string") {
      return;
    }
    const summary = contextUsageSummaryFromValue(params.tokenUsage);
    if (!summary) {
      return;
    }
    this.contextUsageSummariesByThreadKey.set(
      event.federationTarget?.scope === "remote"
        ? federatedThreadIdentityKey(
            buildFederatedThreadRef({
              backend: event.backend,
              instanceId: event.federationTarget.instanceId,
              threadId: params.threadId,
            }),
          )
        : buildThreadIdentityKey(event.backend, params.threadId),
      summary,
    );
  }

  private contextUsageSummaryForBinding(
    binding: MessagingBindingRecord,
  ): string | undefined {
    return this.contextUsageSummariesByThreadKey.get(
      this.threadKeyForBinding(binding),
    );
  }

  private async deliverInvalidStatusSelection(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("invalid-status-selection"),
        createdAt: this.now(),
        title: "Invalid status selection",
        body: "That status selection is no longer available. Use /status to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  /**
   * Bus-driven entry point used by the runtime when an UI / archive
   * caller emits `requestBindingRevoke`. Returns true if this
   * controller's adapter owns the binding's channel and therefore
   * handled the revoke; false otherwise so the runtime can try the
   * next controller (or fall back to a direct store revoke if no
   * controller matches — e.g., messaging is currently disabled).
   */
  async handleBindingRevokeRequest(
    binding: MessagingBindingRecord,
  ): Promise<boolean>{
    return await this.bindingService.handleBindingRevokeRequest(binding);
  }

  private async readMonitorRows(monitor?: MessagingMonitorState, federationTarget?: FederationTarget): Promise<MessagingMonitorRows> {
    const read = this.options.backend.getNavigationQueryPage?.bind(this.options.backend);
    if (!read) throw new Error("Upgrade the owning instance to navigation query protocol 2 before opening a monitor.");
    const sections = [
      { pinned: "include" as const, size: normalizeMonitorThreadLimit(monitor?.pinnedThreadLimit, MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT) },
      { pinned: "exclude" as const, size: normalizeMonitorThreadLimit(monitor?.recentThreadLimit, MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT) },
    ];
    const pages = await Promise.all(sections.filter((section) => section.size > 0).map(async (section) => {
      const page = await read({ protocol: 2, consumer: "agent-tool", federationTarget,
        query: { kind: "star-map", filters: { pinned: section.pinned } }, pageSize: section.size });
      if (page.protocol !== 2 || page.unchanged) throw new Error("The owning instance did not provide a monitor row page.");
      return page.entries.map((entry) => entry.row);
    }));
    return { kind: "bounded-monitor", threads: pages.flat() };
  }

  private async renderMonitorStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: MessagingMonitorNavigation,
  ): Promise<MessagingBindingRecord> {
    const snapshot =
      navigation ??
      (await this.readMonitorRows(binding.monitor, federationTargetForBinding(binding)));
    const now = this.now();
    // Startup and timer renders have no inbound operator event.
    const countsAsActivity = event !== undefined;
    const activeTurns = await this.resolveMonitorActiveTurns(
      snapshot,
      binding.monitor,
      countsAsActivity,
    );
    const snippetsByThreadKey = await this.resolveMonitorSnippets(
      snapshot,
      binding.monitor,
      countsAsActivity,
    );
    const intent = buildMonitorStatusIntent({
      activeTurnsByThreadKey: activeTurns,
      binding,
      capabilityProfile: this.capabilityProfile,
      createdAt: now,
      id: this.newIntentId("monitor"),
      navigation: snapshot,
      snippetsByThreadKey,
      topicControls: this.supportsMonitorTopicControls(event?.channel ?? binding.channel),
    });
    const result = await this.deliver(intent, binding, event);
    const latestBinding = await this.options.store.getBinding(binding.id);
    if (latestBinding?.revokedAt) {
      this.clearMonitorTimer(binding.id);
      return latestBinding;
    }
    const currentBinding = latestBinding ?? binding;
    return await this.options.store.upsertBinding({
      ...currentBinding,
      monitor: {
        ...currentBinding.monitor,
        enabled: true,
        intervalMs:
          currentBinding.monitor?.intervalMs ?? MESSAGING_MONITOR_INTERVAL_MS,
        lastRenderedAt: now,
        updatedAt: now,
      },
      monitorSurface:
        result.surface && result.outcome !== "failed"
          ? result.surface
          : currentBinding.monitorSurface,
      updatedAt: now,
    });
  }

  private async renderChannelMonitorStatus(
    subscription: MessagingMonitorSubscriptionRecord,
    event?: MessagingInboundEvent,
    navigation?: MessagingMonitorNavigation,
  ): Promise<MessagingMonitorSubscriptionRecord> {
    const snapshot =
      navigation ??
      (await this.readMonitorRows(subscription.monitor));
    const now = this.now();
    const countsAsActivity = event !== undefined;
    const activeTurns = await this.resolveMonitorActiveTurns(
      snapshot,
      subscription.monitor,
      countsAsActivity,
    );
    const snippetsByThreadKey = await this.resolveMonitorSnippets(
      snapshot,
      subscription.monitor,
      countsAsActivity,
    );
    const intent = {
      ...buildMonitorStatusIntent({
        activeTurnsByThreadKey: activeTurns,
        bindingId: subscription.id,
        capabilityProfile: this.capabilityProfile,
        createdAt: now,
        id: this.newIntentId("monitor"),
        monitor: subscription.monitor,
        monitorSurface: subscription.monitorSurface,
        navigation: snapshot,
        snippetsByThreadKey,
        topicControls: this.supportsMonitorTopicControls(event?.channel ?? subscription.channel),
      }),
      allowedActorIds: subscription.authorizedActorIds,
      ...(event
        ? {}
        : {
            audit: buildMessagingAuditContext({
              action: "monitor.deliver",
              actor: {
                platformUserId: subscription.authorizedActorIds[0] ?? "unknown",
              },
              bindingId: subscription.id,
              channel: subscription.channel,
              now,
            }),
          }),
    };
    const result = await this.deliver(intent, undefined, event);
    if (isPermanentMessagingTargetFailure(result)) {
      const revoked = await this.options.store.revokeMonitorSubscription({
        subscriptionId: subscription.id,
        revokedAt: now,
      });
      this.clearMonitorSubscriptionTimer(subscription.id);
      return revoked ?? {
        ...subscription,
        revokedAt: now,
        updatedAt: now,
      };
    }

    const latest =
      await this.options.store.getMonitorSubscription(subscription.id);
    if (latest?.revokedAt) {
      this.clearMonitorSubscriptionTimer(subscription.id);
      return latest;
    }
    const current = latest ?? subscription;
    return await this.options.store.upsertMonitorSubscription({
      ...current,
      monitor: {
        ...current.monitor,
        enabled: true,
        intervalMs: current.monitor.intervalMs,
        lastRenderedAt: now,
        updatedAt: now,
      },
      monitorSurface:
        result.surface && result.outcome !== "failed"
          ? result.surface
          : current.monitorSurface,
      updatedAt: now,
    });
  }

  private scheduleMonitorTick(binding: MessagingBindingRecord): void {
    if (
      this.disposed ||
      binding.revokedAt ||
      !binding.monitor?.enabled ||
      this.monitorTimersByBindingId.has(binding.id)
    ) {
      return;
    }

    const intervalMs = binding.monitor.intervalMs || MESSAGING_MONITOR_INTERVAL_MS;
    const timer = setTimeout(() => {
      this.monitorTimersByBindingId.delete(binding.id);
      void this.runMonitorTick(binding.id);
    }, intervalMs);
    this.monitorTimersByBindingId.set(binding.id, timer);
  }

  private scheduleMonitorSubscriptionTick(
    subscription: MessagingMonitorSubscriptionRecord,
  ): void {
    if (
      this.disposed ||
      subscription.revokedAt ||
      !subscription.monitor.enabled ||
      this.monitorTimersBySubscriptionId.has(subscription.id)
    ) {
      return;
    }

    const intervalMs =
      subscription.monitor.intervalMs || MESSAGING_MONITOR_INTERVAL_MS;
    const timer = setTimeout(() => {
      this.monitorTimersBySubscriptionId.delete(subscription.id);
      void this.runMonitorSubscriptionTick(subscription.id);
    }, intervalMs);
    this.monitorTimersBySubscriptionId.set(subscription.id, timer);
  }

  private clearMonitorTimer(bindingId: string): void {
    const timer = this.monitorTimersByBindingId.get(bindingId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.monitorTimersByBindingId.delete(bindingId);
  }

  private clearMonitorSubscriptionTimer(subscriptionId: string): void {
    const timer = this.monitorTimersBySubscriptionId.get(subscriptionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.monitorTimersBySubscriptionId.delete(subscriptionId);
  }

  private async runMonitorTick(bindingId: string): Promise<void> {
    const binding = await this.options.store.getBinding(bindingId);
    if (!binding || binding.revokedAt || !binding.monitor?.enabled) {
      this.clearMonitorTimer(bindingId);
      return;
    }

    let rendered: MessagingBindingRecord | undefined;
    try {
      rendered = await this.renderMonitorStatus(binding);
    } catch (error) {
      this.logger.debug?.("messaging monitor tick failed", {
        bindingId,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
    }

    const latest = rendered ?? await this.options.store.getBinding(bindingId);
    if (latest && !latest.revokedAt && latest.monitor?.enabled) {
      this.scheduleMonitorTick(latest);
    }
  }

  private async runMonitorSubscriptionTick(subscriptionId: string): Promise<void> {
    const subscription =
      await this.options.store.getMonitorSubscription(subscriptionId);
    if (
      !subscription ||
      subscription.revokedAt ||
      !subscription.monitor.enabled
    ) {
      this.clearMonitorSubscriptionTimer(subscriptionId);
      return;
    }

    let rendered: MessagingMonitorSubscriptionRecord | undefined;
    try {
      rendered = await this.renderChannelMonitorStatus(subscription);
    } catch (error) {
      this.logger.debug?.("messaging channel monitor tick failed", {
        error: error instanceof Error ? error.message : String(error),
        subscriptionId,
      });
    }

    const latest =
      rendered ?? await this.options.store.getMonitorSubscription(subscriptionId);
    if (latest && !latest.revokedAt && latest.monitor.enabled) {
      this.scheduleMonitorSubscriptionTick(latest);
    }
  }

  private async resolveMonitorActiveTurns(
    navigation: MessagingMonitorNavigation,
    monitor?: MessagingMonitorState,
    countsAsActivity = true,
  ): Promise<ReadonlyMap<string, MessagingActiveTurnSummary>> {
    const activeTurns = new Map(this.turns.snapshot());
    if (!this.options.backend.readThreadStatus) {
      return activeTurns;
    }

    const threads = selectMonitorThreads({ monitor, navigation }).threads;
    await Promise.all(
      threads.map(async (thread) => {
        const threadKey = threadKeyForNavigationThread(thread);
        const existing = activeTurns.get(threadKey);
        try {
          const status = await this.options.backend.readThreadStatus?.({
            backend: thread.source,
            federationTarget: federationTargetForThread(thread),
            threadId: thread.id,
            ...(countsAsActivity ? {} : { countsAsActivity: false }),
          });
          if (status === "active") {
            activeTurns.set(threadKey, {
              status: existing?.status === "waiting" ? "waiting" : "working",
              turnId: existing?.turnId ?? `${threadKey}:monitor`,
              updatedAt: this.now(),
            });
          } else if (
            status === "idle" &&
            existing &&
            (existing.status === "working" || existing.status === "waiting")
          ) {
            activeTurns.set(threadKey, {
              ...existing,
              status: "completed",
              updatedAt: this.now(),
            });
          }
        } catch (error) {
          this.logger.debug?.("messaging monitor thread status read failed", {
            backend: thread.source,
            error: error instanceof Error ? error.message : String(error),
            threadId: thread.id,
          });
        }
      }),
    );
    return activeTurns;
  }

  private async resolveMonitorSnippets(
    navigation: MessagingMonitorNavigation,
    monitor?: MessagingMonitorState,
    countsAsActivity = true,
  ): Promise<ReadonlyMap<string, string>> {
    const snippets = new Map<string, string>();
    if (
      monitor?.showLastResponseSnippet !== true ||
      !this.options.backend.readThreadLastAssistantMessage
    ) {
      return snippets;
    }

    const threads = selectMonitorThreads({ monitor, navigation }).threads;
    await Promise.all(
      threads.map(async (thread) => {
        const threadKey = threadKeyForNavigationThread(thread);
        try {
          const text =
            await this.options.backend.readThreadLastAssistantMessage?.({
              backend: thread.source,
              federationTarget: federationTargetForThread(thread),
              threadId: thread.id,
              ...(countsAsActivity ? {} : { countsAsActivity: false }),
            });
          const trimmed = text?.trim();
          if (trimmed) {
            snippets.set(threadKey, trimmed);
          }
        } catch (error) {
          this.logger.debug?.("messaging monitor thread snippet read failed", {
            backend: thread.source,
            error: error instanceof Error ? error.message : String(error),
            threadId: thread.id,
          });
        }
      }),
    );
    return snippets;
  }

  private async resolveMonitorBackendKinds(): Promise<AppServerBackendKind[]> {
    const listed = await this.options.backend.listBackends?.({
      includeUnavailable: true,
    });
    if (listed?.backends.length) {
      return [...new Set(listed.backends.map((backend) => backend.kind))];
    }
    return ["codex"];
  }

  private async reconcileActiveTurnFromBackendStatus(
    binding: MessagingBindingRecord,
    reason: string,
  ): Promise<MessagingActiveTurnSummary | undefined> {
    const activeTurn = this.getActiveTurn(binding);
    if (
      !activeTurn ||
      !["working", "waiting"].includes(activeTurn.status)
    ) {
      return activeTurn;
    }

    const threadStatus = await this.readBackendThreadStatus(binding);
    return await this.reconcileActiveTurnFromThreadStatus(
      binding,
      reason,
      threadStatus,
    );
  }

  private async reconcileActiveTurnFromThreadStatus(
    binding: MessagingBindingRecord,
    reason: string,
    threadStatus: string | undefined,
  ): Promise<MessagingActiveTurnSummary | undefined> {
    const activeTurn = this.getActiveTurn(binding);
    if (
      !activeTurn ||
      !["working", "waiting"].includes(activeTurn.status)
    ) {
      return activeTurn;
    }

    if (threadStatus !== "idle") {
      return activeTurn;
    }

    const completedTurn: MessagingActiveTurnSummary = {
      ...activeTurn,
      status: "completed",
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, completedTurn);
    this.logBindingTurnStateChange(
      binding,
      activeTurn,
      completedTurn,
      `${reason}:thread_status_idle`,
    );
    await this.signalTurnActivity(binding, completedTurn, {
      force: true,
      reason: `${reason}:thread_status_idle`,
    });
    return completedTurn;
  }

  private async resolveSteerableActiveTurn(
    binding: MessagingBindingRecord,
    reason: string,
  ): Promise<MessagingActiveTurnSummary | undefined> {
    const activeTurn = await this.reconcileActiveTurnFromBackendStatus(
      binding,
      reason,
    );
    if (activeTurn && ["working", "waiting"].includes(activeTurn.status)) {
      return activeTurn;
    }

    const backendTurn = await this.options.backend.readActiveTurn?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
    });
    if (!backendTurn?.turnId) {
      return activeTurn;
    }

    const restoredTurn: MessagingActiveTurnSummary = {
      turnId: backendTurn.turnId,
      status: "working",
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, restoredTurn);
    this.logBindingTurnStateChange(
      binding,
      activeTurn,
      restoredTurn,
      `${reason}:active_turn_lookup`,
    );
    await this.signalTurnActivity(binding, restoredTurn, {
      force: true,
      reason: `${reason}:active_turn_lookup`,
    });
    return restoredTurn;
  }

  private async restoreAttachedTurnActivity(
    binding: MessagingBindingRecord,
  ): Promise<void> {
    // Handoff starts the turn before attaching its messaging conversation.
    // The controller had no binding when turn/started arrived, so hydrate
    // from the owning backend rather than waiting for another start event.
    const previousTurn = this.getActiveTurn(binding);
    try {
      const admission = await this.options.backend.getThreadAdmissionState({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        threadId: binding.threadId,
      });
      let activeTurn = this.getActiveTurn(binding);
      const backendTurn = admission.activeTurn;
      const pendingRequest = admission.pendingRequest;
      const waiting =
        pendingRequest?.params.threadId === binding.threadId
        && (!pendingRequest.params.turnId || pendingRequest.params.turnId === backendTurn?.turnId);
      if (
        activeTurn === previousTurn
        && backendTurn?.backend === binding.backend
        && backendTurn.threadId === binding.threadId
        && admission.threadStatus !== "idle"
        && (
          !activeTurn
          || activeTurn.turnId !== backendTurn.turnId
          || (activeTurn.status === "working" && waiting)
        )
      ) {
        activeTurn = {
          turnId: backendTurn.turnId,
          status: waiting ? "waiting" : "working",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        this.logBindingTurnStateChange(
          binding,
          previousTurn,
          activeTurn,
          "attach:active_turn_lookup",
        );
      }
      // Preserve newer lifecycle/pending-request state delivered during the
      // lookup. In particular, never revive a completed turn or turn a
      // known waiting turn back into working. Signal this new surface even
      // when another binding already knew the turn was active.
      if (activeTurn && ["working", "waiting"].includes(activeTurn.status)) {
        await this.signalTurnActivity(binding, activeTurn, {
          force: true,
          reason: "attach",
        });
      }
    } catch (error) {
      this.logger.warn?.("messaging attached turn activity restore failed", {
        backend: binding.backend,
        bindingId: binding.id,
        threadId: binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async reconcileIdleTurn(
    binding: MessagingBindingRecord,
    reason: string,
  ): Promise<void> {
    await this.reconcileActiveTurnFromBackendStatus(binding, reason);
  }

  private async retireStalePendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
  ): Promise<void> {
    await this.options.store.deletePendingIntent(pendingIntent.id);
    await this.retireApprovalIntent(pendingIntent, undefined, "Resolved");
  }

  private async readBackendThreadStatus(
    binding: MessagingBindingRecord,
  ): Promise<string | undefined> {
    return await this.options.backend.readThreadStatus?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
    });
  }

  private getActiveTurn(
    binding: MessagingBindingRecord,
  ): MessagingActiveTurnSummary | undefined {
    return this.turns.get(binding);
  }

  private setActiveTurn(
    binding: MessagingBindingRecord,
    activeTurn: MessagingActiveTurnSummary,
  ): void {
    this.turns.observe(binding, activeTurn);
  }

  private threadKeyForBinding(binding: MessagingBindingRecord): string {
    return threadKeyForBinding(binding);
  }

  private async handleAutomationTurnStarted(params: {
    messageOrigin?: AppServerThreadMessageOrigin;
    automationName?: string;
    automationRunId?: string;
    backend: AppServerBackendKind;
    bindings: MessagingBindingRecord[];
    threadId: ThreadIdentifier;
    turnId: string;
    suppressBindingBroadcast?: boolean;
  }): Promise<void> {
    // Always remember the turn so its streaming/lifecycle events are recognized
    // as an automation turn and NOT delivered to bindings as ordinary assistant
    // output (see `isAutomationTurnEvent`). Only the visible "started" notice is
    // suppressed when the automation delivers via explicit messaging actions.
    this.rememberAutomationTurn({
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      backend: params.backend,
      threadId: params.threadId,
      turnId: params.turnId,
    });

    if (params.suppressBindingBroadcast) {
      return;
    }

    for (const binding of params.bindings) {
      await this.deliverAutomationStartedMessage(binding, {
        messageOrigin: params.messageOrigin,
        automationName: params.automationName,
        automationRunId: params.automationRunId,
        turnId: params.turnId,
      });
    }
  }

  private async handleAutomationTurnTerminal(params: {
    automationRunId?: string;
    backend: AppServerBackendKind;
    bindings: MessagingBindingRecord[];
    event: AgentEvent;
    finalText?: string;
    threadId: ThreadIdentifier;
    turnId: string;
    suppressBindingBroadcast?: boolean;
  }): Promise<void> {
    // Suppress the legacy broadcast for automations that deliver via explicit
    // messaging actions, but still forget the tracked turn so the map does not
    // leak.
    if (!params.suppressBindingBroadcast) {
      for (const binding of params.bindings) {
        await this.deliverAutomationFinalMessageOnce({
          binding,
          event: params.event,
          finalText: params.finalText,
          keyParts: [
            binding.id,
            params.automationRunId ?? params.threadId,
            params.automationRunId ? "automation-run" : params.turnId,
          ],
        });
      }
    }
    this.forgetAutomationTurn(params.backend, params.threadId, params.turnId);
  }

  private async handleAutomationRunUpdated(params: {
    bindings: MessagingBindingRecord[];
    event: AgentEvent;
    finalText?: string;
    outputDecision?: AutomationRunOutputDecision;
    runId: string;
    status: string;
    suppressBindingBroadcast?: boolean;
  }): Promise<void> {
    // Automations that deliver via explicit messaging actions own their
    // delivery; the legacy "broadcast to every binding" path would double-post
    // the source conversation, so skip it entirely here.
    if (params.suppressBindingBroadcast) {
      return;
    }
    if (
      params.status !== "completed" &&
      params.status !== "failed" &&
      params.status !== "cancelled" &&
      params.status !== "skipped"
    ) {
      return;
    }
    for (const binding of params.bindings) {
      await this.deliverAutomationFinalMessageOnce({
        binding,
        event: params.event,
        finalText: params.finalText,
        keyParts: [binding.id, params.runId, "automation-run"],
        outputDecision: params.outputDecision,
      });
    }
  }

  private async deliverAutomationFinalMessageOnce(params: {
    binding: MessagingBindingRecord;
    event: AgentEvent;
    finalText?: string;
    keyParts: string[];
    outputDecision?: AutomationRunOutputDecision;
  }): Promise<void> {
    if (params.outputDecision?.kind === "quiet") {
      return;
    }
    const messageText =
      params.outputDecision?.kind === "post_card"
        ? renderAutomationDecisionForMessaging(params.outputDecision)
        : renderAutomationOutputForMessaging(params.finalText);
    if (!messageText) {
      return;
    }
    const key = [...params.keyParts, messageText].join("\0");
    if (this.deliveredAutomationFinalKeys.has(key)) {
      return;
    }
    rememberBoundedKey(this.deliveredAutomationFinalKeys, key);
    await this.deliverAssistantMessage(messageText, params.event, params.binding);
  }

  private rememberAutomationTurn(params: {
    automationName?: string;
    automationRunId?: string;
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    turnId: string;
  }): void {
    this.automationTurnsByTurnKey.set(
      automationTurnKey(params),
      {
        automationName: params.automationName,
        automationRunId: params.automationRunId,
      },
    );
  }

  private forgetAutomationTurn(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string,
  ): void {
    this.automationTurnsByTurnKey.delete(
      automationTurnKey({ backend, threadId, turnId }),
    );
  }

  private rememberAgentMessagingOrigin(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    navigation: MessagingNavigationContext;
    origin?: ActiveAgentMessagingOrigin;
    turnId: string;
  }): void {
    const origin = params.origin ?? (
      params.event
      && isLiveMessagingToolOriginBinding(params.binding, params.navigation)
        ? {
            source: this.rememberHumanMessagingSource(params.binding, params.event),
            binding: isDefaultAgentRouteBinding(params.binding)
              ? undefined
              : params.binding,
            deliveryBinding: isDefaultAgentRouteBinding(params.binding)
              ? params.binding
              : undefined,
            event: params.event,
          }
        : undefined
    );
    if (!origin) {
      return;
    }
    const turnKey = agentMessagingTurnKey(
      params.binding.backend,
      params.binding.threadId,
      params.turnId,
    );
    this.activeAgentMessagingOriginsByTurnKey.set(
      turnKey,
      origin,
    );
    this.privateResponses.register(turnKey, {
      replyCompletion: Boolean(origin.privateReplyContinuationBindingId),
      fallback: Boolean(origin.privateResponseRequested || requestsExplicitPrivateResponse(origin.event)),
    });
  }

  private async buildAgentMessagingOrigin(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    navigation: MessagingNavigationContext;
    privateResponseRequested?: boolean;
  }): Promise<ActiveAgentMessagingOrigin | undefined> {
    if (
      !params.event
      || !isLiveMessagingToolOriginBinding(params.binding, params.navigation)
    ) {
      return undefined;
    }
    const continuation = params.binding.privateReplyContinuation;
    if (continuation && continuation.expiresAt > this.now()) {
      return {
        binding: params.binding,
        deliveryBinding: await this.resolvePrivateReplySourceBinding(
          continuation.source,
        ),
        event: params.event,
        privateReplyContinuationBindingId: params.binding.id,
        privateResponseRequested: params.privateResponseRequested,
      };
    }
    return {
      source: this.rememberHumanMessagingSource(params.binding, params.event),
      binding: isDefaultAgentRouteBinding(params.binding)
        ? undefined
        : params.binding,
      deliveryBinding: isDefaultAgentRouteBinding(params.binding)
        ? params.binding
        : undefined,
      event: params.event,
      privateResponseRequested: params.privateResponseRequested,
    };
  }

  private rememberHumanMessagingSource(binding: MessagingBindingRecord, event: MessagingInboundEvent): MessagingRequestSource | undefined {
    const connectionId = this.adapter.retainedSourceConnectionId?.();
    if (!this.adapter.authorizeRetainedSource || !connectionId) return undefined;
    return this.options.requestStore?.remember({
      agent: { backend: binding.backend, threadId: binding.threadId },
      bindingId: isDefaultAgentRouteBinding(binding) ? undefined : binding.id,
      event, instanceId: this.options.sourceInstanceId, connectionId,
    });
  }

  private async resolvePrivateReplySourceBinding(
    source: MessagingPrivateReplySource,
  ): Promise<MessagingBindingRecord> {
    const stored = await this.options.store.getBinding(source.id);
    if (
      stored
      && !stored.revokedAt
      && stored.backend === source.backend
      && stored.threadId === source.threadId
    ) {
      return stored;
    }
    return {
      ...source,
      channel: structuredClone(source.channel),
      routingState: source.routingState
        ? structuredClone(source.routingState)
        : undefined,
      statusPresentation: "on_demand",
    };
  }

  private forgetAgentMessagingOrigin(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string,
  ): void {
    const turnKey = agentMessagingTurnKey(backend, threadId, turnId);
    this.activeAgentMessagingOriginsByTurnKey.delete(turnKey);
    this.privateResponses.retire(turnKey);
    this.pdfAttachmentStore.releaseTurn({ backend, threadId, turnId });
  }

  private isTerminalPrivateResponseTurn(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string | undefined,
  ): boolean {
    return Boolean(
      turnId
      && this.privateResponses.isTerminal(
        agentMessagingTurnKey(backend, threadId, turnId),
      ),
    );
  }

  private isPrivateResponseFallbackTurn(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string | undefined,
  ): boolean {
    return Boolean(
      turnId
      && this.privateResponses.isFallback(
        agentMessagingTurnKey(backend, threadId, turnId),
      ),
    );
  }

  private isPrivateReplyCompletionTurn(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string | undefined,
  ): boolean {
    if (!turnId) {
      return false;
    }
    if (
      this.privateResponses.state(
        agentMessagingTurnKey(backend, threadId, turnId),
      )?.replyCompletion
    ) {
      return true;
    }
    return Boolean(
      this.startingAgentMessagingOriginsByThreadKey.get(
        agentMessagingThreadKey(backend, threadId),
      )?.privateReplyContinuationBindingId,
    );
  }

  private async completePrivateReplyContinuation(
    bindingId: string,
  ): Promise<void> {
    const binding = await this.options.store.getBinding(bindingId);
    if (!binding || binding.revokedAt || !binding.privateReplyContinuation) {
      return;
    }
    await this.options.store.revokeBinding({
      bindingId,
      revokedAt: this.now(),
    });
    this.bindingService.notifyBindingChanged("private-reply-completed");
  }

  private async deliverPrivateReplyButtonState(
    event: MessagingInboundCallbackEvent,
    body: string,
  ): Promise<void> {
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("private-reply-button-state"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        delivery: {
          mode: "update",
          replaceMarkup: true,
          fallback: "present_new",
        },
        title: "Private request",
        body,
        targetSurface: event.sourceSurface,
      }),
      undefined,
      event,
    );
  }

  private rememberQueuedAgentMessagingOrigin(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    navigation: MessagingNavigationContext;
    origin?: ActiveAgentMessagingOrigin;
    queueEntryId: string;
  }): void {
    const origin = params.origin ?? (
      params.event
      && isLiveMessagingToolOriginBinding(params.binding, params.navigation)
        ? {
            source: this.rememberHumanMessagingSource(params.binding, params.event),
            binding: isDefaultAgentRouteBinding(params.binding)
              ? undefined
              : params.binding,
            deliveryBinding: isDefaultAgentRouteBinding(params.binding)
              ? params.binding
              : undefined,
            event: params.event,
          }
        : undefined
    );
    if (!origin) {
      return;
    }
    const queueKey = agentMessagingQueueKey(
      params.binding.backend,
      params.binding.threadId,
      params.queueEntryId,
    );
    this.queuedAgentMessagingOriginsByQueueKey.set(
      queueKey,
      origin,
    );
  }

  private async reconcileQueuedAgentMessagingOrigin(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    update: NonNullable<ReturnType<typeof turnQueueUpdateForBackendEvent>>;
  }): Promise<void> {
    if (!params.update.queueEntryId) {
      return;
    }
    const queueKey = agentMessagingQueueKey(
      params.backend,
      params.threadId,
      params.update.queueEntryId,
    );
    const origin = this.queuedAgentMessagingOriginsByQueueKey.get(queueKey);
    if (!origin) {
      return;
    }
    if (params.update.status === "started" && params.update.turnId) {
      this.queuedAgentMessagingOriginsByQueueKey.delete(queueKey);
      const turnKey = agentMessagingTurnKey(
        params.backend,
        params.threadId,
        params.update.turnId,
      );
      this.activeAgentMessagingOriginsByTurnKey.set(
        turnKey,
        origin,
      );
      this.privateResponses.register(turnKey, {
        replyCompletion: Boolean(origin.privateReplyContinuationBindingId),
        fallback: Boolean(origin.privateResponseRequested || requestsExplicitPrivateResponse(origin.event)),
      });
      const activeTurn: MessagingActiveTurnSummary = {
        turnId: params.update.turnId,
        status: "working",
        startedAt: this.now(),
        updatedAt: this.now(),
      };
      const deliveryBinding = origin.deliveryBinding ?? origin.binding;
      if (!deliveryBinding) {
        return;
      }
      this.setActiveTurn(deliveryBinding, activeTurn);
      await this.signalTurnActivity(deliveryBinding, activeTurn, {
        force: true,
      });
      return;
    }
    if (
      params.update.status !== "failed"
      && params.update.status !== "cancelled"
    ) {
      return;
    }
    this.queuedAgentMessagingOriginsByQueueKey.delete(queueKey);
    if (!origin.deliveryBinding) {
      return;
    }
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("default-agent-turn-queue"),
        createdAt: this.now(),
        title: params.update.status === "failed"
          ? "Default Agent could not respond"
          : "Default Agent request cancelled",
        body: params.update.errorMessage
          ?? (params.update.status === "failed"
            ? "The queued Agent request could not start."
            : "The queued Agent request was cancelled."),
        recoverable: params.update.status === "failed",
      }),
      origin.deliveryBinding,
      origin.event,
    );
  }

  private bindingsForAgentTurn(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string | undefined,
    persistentBindings: MessagingBindingRecord[],
  ): MessagingBindingRecord[] {
    if (!turnId) {
      const startingOrigin = this.startingAgentMessagingOriginsByThreadKey.get(
        agentMessagingThreadKey(backend, threadId),
      );
      const startingDeliveryBinding = startingOrigin?.deliveryBinding
        ?? startingOrigin?.binding;
      if (
        startingDeliveryBinding
        && this.isChannelInScope(startingDeliveryBinding.channel)
      ) {
        const persistedOrigin = persistentBindings.find(
          (binding) => binding.id === startingDeliveryBinding.id,
        );
        return [persistedOrigin ?? startingDeliveryBinding];
      }
      return persistentBindings;
    }
    const origin = this.activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(backend, threadId, turnId),
    ) ?? this.startingAgentMessagingOriginsByThreadKey.get(
      agentMessagingThreadKey(backend, threadId),
    );
    const deliveryBinding = origin?.deliveryBinding ?? origin?.binding;
    if (!origin || !deliveryBinding || !this.isChannelInScope(deliveryBinding.channel)) {
      return persistentBindings;
    }
    const persistedOrigin = persistentBindings.find(
      (binding) => binding.id === deliveryBinding.id,
    );
    return [persistedOrigin ?? deliveryBinding];
  }

  private agentMessagingOriginForPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
  ): ActiveAgentMessagingOrigin | undefined {
    const context = pendingIntent.intent.requestContext;
    if (!context?.turnId) {
      return undefined;
    }
    return this.activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(
        context.backend,
        context.threadId,
        context.turnId,
      ),
    );
  }

  private suppressTaskMonitorLifecycle(
    event: AgentEvent,
    threadId: ThreadIdentifier,
    lifecycle: MessagingTaskMonitorLifecycle,
    fallbackParentTurnId?: string,
  ): boolean {
    const key = `${threadKeyForBackendEvent(event, threadId)}\0${lifecycle.monitorId}`;
    const previous = this.taskMonitorMessagingOrigins.get(key);
    const parentTurnId = lifecycle.parentTurnId ?? previous?.parentTurnId ?? fallbackParentTurnId;
    if (!parentTurnId) {
      return false;
    }
    const suppressed = Boolean(
      previous?.suppressed
      || this.isTerminalPrivateResponseTurn(event.backend, threadId, parentTurnId)
      || this.isPrivateResponseFallbackTurn(event.backend, threadId, parentTurnId)
      || this.isPrivateReplyCompletionTurn(event.backend, threadId, parentTurnId)
      || this.isAutomationTurn(event.backend, threadId, parentTurnId),
    );
    rememberBoundedMap(
      this.taskMonitorMessagingOrigins,
      key,
      { parentTurnId, suppressed },
      MAX_TRACKED_TURN_PROSE,
    );
    return suppressed;
  }

  private isAutomationTurn(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string | undefined,
  ): boolean {
    return Boolean(turnId && this.automationTurnsByTurnKey.has(
      automationTurnKey({ backend, threadId, turnId }),
    ));
  }

  private isAutomationTurnEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    fallbackTurnId?: string,
  ): boolean {
    return this.isAutomationTurn(
      event.backend,
      binding.threadId,
      turnIdForBackendEvent(event) ?? fallbackTurnId,
    );
  }

  private async deliverIncomingWork(
    binding: MessagingBindingRecord,
    deliveryId: string,
    summary: ThreadIncomingWorkSummary,
  ): Promise<void> {
    const key = `${binding.id}\0incoming\0${deliveryId}`;
    if (this.deliveredThreadNoticeKeys.has(key)) return;
    rememberBoundedKey(this.deliveredThreadNoticeKeys, key);
    const recipientTitle = summary.recipientTitle ?? (await this.resolveBoundThreadSummary(binding))?.title;
    await this.deliver({
      id: this.newIntentId("incoming-thread-work"),
      kind: "message",
      bindingId: binding.id,
      createdAt: this.now(),
      role: "system",
      parts: [{ type: "text", text: incomingWorkText({ ...summary, recipientTitle }, binding.threadId), markdown: "plain" }],
    }, binding);
  }

  private async deliverAutomationStartedMessage(
    binding: MessagingBindingRecord,
    params: {
      automationName?: string;
      automationRunId?: string;
      messageOrigin?: AppServerThreadMessageOrigin;
      turnId: string;
    },
  ): Promise<void> {
    const key = [
      binding.id,
      params.automationRunId ?? "",
      params.turnId,
      "automation-started",
    ].join("\0");
    if (this.deliveredAutomationStartKeys.has(key)) {
      return;
    }
    rememberBoundedKey(this.deliveredAutomationStartKeys, key);

    const name = params.automationName?.trim();
    const text = [
      automatedWorkStartedLabel(params.messageOrigin, name),
      "I'll post the final response when it's done.",
    ].join("\n");

    await this.deliver(
      {
        id: this.newIntentId("automation-started"),
        kind: "message",
        bindingId: binding.id,
        createdAt: this.now(),
        role: "system",
        parts: [
          {
            type: "text",
            text,
            markdown: "plain",
          },
        ],
      },
      binding,
    );
  }

  private beginTurnPreparationActivity(binding: MessagingBindingRecord): {
    settled: Promise<void>;
    finish: (started: boolean) => Promise<void>;
  } {
    let group = this.preparingTurnActivity.get(binding.id);
    if (!group) {
      group = { attempts: new Set(), signaled: false };
      this.preparingTurnActivity.set(binding.id, group);
    }
    const attempt = Symbol();
    group.attempts.add(attempt);
    const current = this.getActiveTurn(binding);
    const shouldSignal = group.attempts.size === 1
      && current?.status !== "working"
      && current?.status !== "waiting";
    if (shouldSignal) group.signaled = true;
    const delivery = shouldSignal
      ? this.signalTurnActivity(binding, {
          turnId: `preparing:${binding.id}`,
          status: "working",
          updatedAt: this.now(),
        }, { force: true, reason: "turn_preparation" }).catch((error: unknown) => {
          this.logger.debug?.("messaging preparation activity failed", {
            bindingId: binding.id,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      : Promise.resolve();
    const ownedGroup = group;
    return {
      settled: delivery,
      finish: async (started) => {
        ownedGroup.attempts.delete(attempt);
        if (ownedGroup.attempts.size === 0) {
          this.preparingTurnActivity.delete(binding.id);
          const active = this.getActiveTurn(binding);
          // Another attempt or a real lifecycle event may own this surface by
          // now. A failed/queued start cannot cancel that owner's typing.
          if (!started && ownedGroup.signaled && active?.status !== "working") {
            await this.signalTurnActivity(binding, active ?? {
              turnId: `preparing:${binding.id}`,
              status: "completed",
              updatedAt: this.now(),
            }, { force: true, reason: "turn_preparation_finished" }).catch((error: unknown) => {
              this.logger.debug?.("messaging preparation activity cleanup failed", {
                bindingId: binding.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
        // A failed or queued start must report its outcome even when the
        // earlier activity HTTP request is still pending. It already has a
        // rejection handler; successful starts await it before their retry.
        if (started) await delivery;
      },
    };
  }

  private async signalTurnActivity(
    binding: MessagingBindingRecord,
    activeTurn: MessagingActiveTurnSummary,
    options?: { force?: boolean; reason?: string; refreshMs?: number },
  ): Promise<void> {
    const state = activeTurn.status === "working" ? "active" : "idle";
    const sessionState = activeTurn.status === "working"
      ? "processing"
      : activeTurn.status === "waiting"
        ? "suspended"
        : "active";
    const now = this.now();
    const lastSignaledAt = this.typingActivityLastSignaledAt.get(binding.id);
    const refreshMs = options?.refreshMs ?? TYPING_ACTIVITY_REFRESH_MS;
    if (
      state === "active" &&
      !options?.force &&
      lastSignaledAt !== undefined &&
      now - lastSignaledAt < refreshMs
    ) {
      return;
    }
    if (state === "active") {
      this.typingActivityLastSignaledAt.set(binding.id, now);
    } else {
      this.typingActivityLastSignaledAt.delete(binding.id);
    }

    this.logger.debug?.(
      `messaging typing signaled state=${state} reason=${options?.reason ?? "unknown"} force=${Boolean(options?.force)} leaseMs=${state === "active" ? TYPING_ACTIVITY_LEASE_MS : "none"} status=${activeTurn.status} thread=${binding.threadId} turn=${activeTurn.turnId} binding=${binding.id}`,
    );

    await this.deliver(
      buildActivityIntent({
        id: this.newIntentId("activity"),
        activity: "typing",
        bindingId: binding.id,
        createdAt: now,
        leaseMs: state === "active" ? TYPING_ACTIVITY_LEASE_MS : undefined,
        sessionState,
        state,
      }),
      binding,
    );
  }

  private async clearTerminalPrivateResponseActivity(
    binding: MessagingBindingRecord,
    turnId: string,
  ): Promise<void> {
    try {
      await this.signalTurnActivity(
        binding,
        {
          turnId,
          status: "completed",
          updatedAt: this.now(),
        },
        {
          force: true,
          reason: "terminal_private_response",
        },
      );
    } catch (error) {
      this.logger.debug?.("messaging terminal private activity cleanup failed", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        turnId,
      });
    }
  }

  private logBindingTurnStateChange(
    binding: MessagingBindingRecord,
    previousTurn: MessagingActiveTurnSummary | undefined,
    nextTurn: MessagingActiveTurnSummary | undefined,
    reason: string,
  ): void {
    if (
      previousTurn?.turnId === nextTurn?.turnId &&
      previousTurn?.status === nextTurn?.status
    ) {
      return;
    }

    this.logger.debug?.(
      `messaging turn state changed reason=${reason} backend=${binding.backend} thread=${binding.threadId} binding=${binding.id} previous=${previousTurn?.status ?? "none"}:${previousTurn?.turnId ?? "none"} next=${nextTurn?.status ?? "none"}:${nextTurn?.turnId ?? "none"}`,
    );
  }

  private async deliverInvalidBrowseSelection(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("invalid-browse-selection"),
        createdAt: this.now(),
        title: "Invalid selection",
        body: "That resume selection is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async deliverStaleFullAccessWarning(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("stale-full-access-warning"),
        createdAt: this.now(),
        title: "Full Access approval expired",
        body: "That Full Access approval is no longer available. Start the command again.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async deliverMissingFullAccessPrompt(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("missing-full-access-prompt"),
        createdAt: this.now(),
        title: "Full Access prompt expired",
        body: "That Full Access approval no longer has the pending prompt. Send the prompt again.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private defaultAgentRouteBinding(
    event: MessagingInboundEvent,
    target: {
      backend: AppServerBackendKind;
      threadId: ThreadIdentifier;
      toolUpdateMode?: MessagingToolUpdateMode;
    },
  ): MessagingBindingRecord {
    const now = this.now();
    return {
      id:
        `default-agent-route:${buildMessagingConversationKey(event.channel)}`
        + `:${target.backend}:${target.threadId}`,
      channel: event.channel,
      targetKind: "agent_thread",
      backend: target.backend,
      threadId: target.threadId,
      ...(target.toolUpdateMode
        ? {
            preferences: {
              toolUpdateMode: target.toolUpdateMode,
              updatedAt: now,
            },
          }
        : {}),
      authorizedActorIds: [event.actor.platformUserId],
      routingState: event.routingState,
      createdAt: now,
      updatedAt: now,
      displayName: event.actor.displayName ?? event.actor.username,
    };
  }

  private intentForPendingRequest(
    request: AppServerPendingRequestNotification,
  ): MessagingSurfaceIntent | undefined {
    if (request.method === "item/tool/requestUserInput") {
      return buildQuestionnaireIntent({
        id: this.newIntentId("questionnaire"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        request: request as AppServerToolRequestUserInputNotification,
      });
    }

    if (isMessagingInteractivePendingRequest(request)) {
      return buildApprovalIntent({
        id: this.newIntentId("approval"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        request,
      });
    }

    return undefined;
  }

  private async storePendingIntent(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    options: { expiresAt?: number } = {},
  ): Promise<MessagingPendingIntentRecord> {
    return await this.options.store.upsertPendingIntent({
      id: intent.id,
      bindingId: binding?.id,
      channel: binding?.channel ?? event?.channel,
      intent,
      allowedActorIds: binding?.authorizedActorIds ?? [
        event?.actor.platformUserId ?? "unknown",
      ],
      createdAt: this.now(),
      expiresAt: options.expiresAt ?? this.now() + this.pendingIntentTtlMs,
    });
  }

  private recordOutboundActivity(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord | undefined,
    result: MessagingDeliveryResult,
  ): void {
    // Ordinary replies only update provider-visible freshness. Typing activity,
    // dismissals, and partial stream edits are control/noisy signals; the
    // Activity window stays focused on operator-facing rows. Deliberate
    // agent-initiated sends write their own `outbound` row — see
    // recordOutboundFileActivity.
    if (!shouldRecordOutboundActivity(intent, result)) {
      return;
    }
    const channel = binding?.channel.channel ?? result.channel;
    if (!channel) return;
    try {
      const log = this.desktopActivityLog();
      if (!log) return;
      log.recordPlatformResponseActivity({
        platform: channel,
        createdAt: result.deliveredAt,
      });
    } catch {
      // Activity log is best-effort observability; never break delivery
      // because the summary write threw.
    }
  }

  private desktopActivityLog(): MessagingActivityStorage | undefined {
    return this.options.activityLog?.();
  }

  /**
   * The adapter this controller talks to. Once the controller is disposed its
   * own adapter has been stopped and must never be called again: work still
   * in progress goes to the adapter now running for the channel, or to a
   * stub that does nothing when none is running.
   */
  private get adapter(): MessagingAdapter {
    if (!this.disposed) return this.options.adapter;
    const replacement = this.options.replacementAdapter?.now();
    if (replacement && replacement !== this.options.adapter) return replacement;
    return this.stoppedAdapter();
  }

  private stoppedAdapter(): MessagingAdapter {
    this.stoppedAdapterStub ??= {
      capabilityProfile: this.options.adapter.capabilityProfile,
      deliver: async () => ({
        channel: this.options.channel ?? "telegram",
        deliveredAt: this.now(),
        outcome: "discarded",
      }),
    };
    return this.stoppedAdapterStub;
  }

  /**
   * The adapter for a send. A disposed controller waits for a restart in
   * progress, then sends through the replacement, or gets undefined when
   * nothing replaced its adapter.
   */
  private async adapterForSend(): Promise<MessagingAdapter | undefined> {
    if (!this.disposed) return this.options.adapter;
    const replacement = this.options.replacementAdapter?.now()
      ?? await this.options.replacementAdapter?.settled();
    return replacement && replacement !== this.options.adapter
      ? replacement
      : undefined;
  }

  private async deliver(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    guard?: MessagingDeliveryGuard,
  ): Promise<MessagingDeliveryResult> {
    if (binding && shouldFlushToolUpdatesBeforeIntent(intent)) {
      await this.flushToolUpdatesForBinding(binding, { clear: false });
      // A question asked without pausing the turn leaves the agent working.
      if (
        intent.kind === "approval"
        || (intent.kind === "questionnaire" && !intent.asyncReply)
      ) {
        await this.markWorkingCardWaiting(binding);
      }
    }
    const displayIntent = binding?.backend === "codex"
      ? stripCodexGitActionDirectivesFromMessagingIntent(intent)
      : intent;
    if (!displayIntent) {
      return {
        channel: binding?.channel.channel ?? this.options.channel ?? "telegram",
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }
    const routedIntent = this.withRoutingAudit(displayIntent, binding, event);
    const consumeDeliveryBudget = shouldConsumeDeliveryBudget(routedIntent);
    // A disposed controller budgets against the adapter that will send, not
    // the stopped-adapter stub, which has no scope and would skip cool-off.
    const scopeAdapter = this.disposed
      ? await this.adapterForSend()
      : this.options.adapter;
    if (!scopeAdapter) {
      return {
        channel: binding?.channel.channel ?? this.options.channel ?? "telegram",
        deliveredAt: this.now(),
        outcome: "discarded",
      };
    }
    const scope = scopeAdapter.resolveDeliveryScope?.(routedIntent);
    const priority = messagingDeliveryPriority(routedIntent, {
      userInitiated: isUserInitiatedDeliveryEvent(event),
    });
    const channel = binding?.channel.channel ??
      routedIntent.audit?.channel.channel ??
      this.options.channel;
    const cancelledResult = (): MessagingDeliveryResult => ({
      channel: channel ?? "telegram",
      deliveredAt: this.now(),
      outcome: "discarded",
    });
    // Deferrable deliveries the budget holds back wait in one line per scope,
    // so they reach the provider in the order they were requested, across
    // cool-off extensions and adapter restarts alike. The ticket is held
    // until the provider call returns, and released on every exit.
    const lane: DeliveryLaneState = {
      lane: this.deliveryBudget && isDeferrableDeliveryPriority(priority)
        ? this.options.deliveryLane
        : undefined,
    };
    try {
      return await this.deliverThroughBudget({
        binding,
        cancelledResult,
        channel,
        consumeDeliveryBudget,
        guard,
        intent,
        lane,
        priority,
        routedIntent,
        scope,
      });
    } finally {
      lane.ticket?.release();
    }
  }

  private async deliverThroughBudget(params: {
    binding: MessagingBindingRecord | undefined;
    cancelledResult: () => MessagingDeliveryResult;
    channel: MessagingChannelKind | undefined;
    consumeDeliveryBudget: boolean;
    guard: MessagingDeliveryGuard | undefined;
    intent: MessagingSurfaceIntent;
    lane: DeliveryLaneState;
    priority: MessagingDeliveryPriority;
    routedIntent: MessagingSurfaceIntent;
    scope: MessagingDeliveryScope | undefined;
  }): Promise<MessagingDeliveryResult> {
    const {
      binding,
      cancelledResult,
      channel,
      consumeDeliveryBudget,
      guard,
      intent,
      lane,
      priority,
      routedIntent,
    } = params;
    let { scope } = params;
    const waitForTurn = async (): Promise<boolean> => {
      if (lane.ticket || !lane.lane || !scope) return true;
      lane.ticket = lane.lane.enter(scope.id);
      if (guard?.whenCancelled) {
        await Promise.race([lane.ticket.ready, guard.whenCancelled]);
      } else {
        await lane.ticket.ready;
      }
      return !guard?.isCancelled();
    };
    while (true) {
      if (guard?.isCancelled()) {
        return cancelledResult();
      }
      if (this.deliveryBudget) {
        const budgetChannel = channel ?? scope?.platform ?? "telegram";
        if (scope && lane.lane?.isOccupied(scope.id) && !(await waitForTurn())) {
          return cancelledResult();
        }
        let admission = this.deliveryBudget.admit({
          consumeCapacity: consumeDeliveryBudget,
          priority,
          scope,
        });
        while (admission.outcome === "deferred") {
          const budgetEvent: MessagingControllerDeliveryBudgetEvent = {
            at: this.now(),
            backend: binding?.backend,
            federationTarget: binding?.federatedThread?.target,
            bindingId: binding?.id ?? intent.bindingId,
            channel: budgetChannel,
            conversation: binding?.channel.conversation,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            outcome: "deferred",
            priority,
            reason: admission.reason,
            retryAt: admission.retryAt,
            scope,
            slowMode: admission.slowMode,
            threadId: binding?.threadId,
          };
          this.logger.info?.("messaging delivery budget deferred intent", {
            bindingId: binding?.id ?? intent.bindingId,
            delayMs: Math.max(0, admission.retryAt - this.now()),
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            priority,
            retryAt: admission.retryAt,
            scopeId: scope?.id,
            slowMode: admission.slowMode,
          });
          this.notifyDeliveryBudgetEvent(budgetEvent);
          if (!lane.ticket && lane.lane && scope) {
            // Take a place in line, then ask again: time may have passed.
            if (!(await waitForTurn())) {
              return cancelledResult();
            }
            admission = this.deliveryBudget.admit({
              consumeCapacity: consumeDeliveryBudget,
              priority,
              scope,
            });
            continue;
          }
          const delay = (this.options.sleepUntil ?? sleepUntil)(
            admission.retryAt,
            this.now,
          );
          if (guard?.whenCancelled) {
            await Promise.race([delay, guard.whenCancelled]);
          } else {
            await delay;
          }
          if (guard?.isCancelled()) {
            return cancelledResult();
          }
          admission = this.deliveryBudget.admit({
            consumeCapacity: consumeDeliveryBudget,
            priority,
            scope,
          });
        }
        if (admission.outcome !== "admitted") {
          const budgetEvent: MessagingControllerDeliveryBudgetEvent = {
            at: this.now(),
            backend: binding?.backend,
            federationTarget: binding?.federatedThread?.target,
            bindingId: binding?.id ?? intent.bindingId,
            channel: budgetChannel,
            conversation: binding?.channel.conversation,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            outcome: "dropped",
            priority,
            reason: admission.reason,
            scope,
            slowMode: admission.slowMode,
            threadId: binding?.threadId,
          };
          this.logger.debug?.("messaging delivery budget skipped intent", {
            bindingId: binding?.id ?? intent.bindingId,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            outcome: admission.outcome,
            priority,
            reason: admission.outcome === "dropped" ? admission.reason : undefined,
            scopeId: scope?.id,
            slowMode: admission.slowMode,
          });
          this.notifyDeliveryBudgetEvent(budgetEvent);
          return {
            channel: channel ?? "telegram",
            deliveredAt: this.now(),
            outcome: "discarded",
          };
        }
      }
      if (guard?.isCancelled()) {
        return cancelledResult();
      }
      const adapter = await this.adapterForSend();
      if (!adapter) {
        this.logger.info?.("messaging delivery discarded: adapter stopped and nothing replaced it", {
          bindingId: binding?.id ?? intent.bindingId,
          intentId: routedIntent.id,
          intentKind: routedIntent.kind,
        });
        return cancelledResult();
      }
      if (guard?.isCancelled()) {
        return cancelledResult();
      }
      const result = await adapter.deliver(routedIntent);
      if (guard?.isCancelled()) {
        await guard.onCancelledDelivery?.(result);
        return cancelledResult();
      }
      this.logDeliveryResult(routedIntent, binding, result);
      if (this.deliveryBudget && result.rateLimit) {
        if (lane.ticket && result.rateLimit.scope.id !== scope?.id) {
          // The retry belongs in the new scope's line, not the old one's.
          lane.ticket.release();
          lane.ticket = undefined;
        }
        scope = result.rateLimit.scope;
        this.deliveryBudget.recordRateLimit(result.rateLimit);
        if (result.rateLimit.retryable === true) {
          this.logger.debug?.("messaging delivery rate-limited; rechecking budget", {
            bindingId: binding?.id ?? intent.bindingId,
            intentId: routedIntent.id,
            intentKind: routedIntent.kind,
            priority,
            retryAfterMs: result.rateLimit.retryAfterMs,
            scopeId: result.rateLimit.scope.id,
          });
          continue;
        }
        this.logger.debug?.("messaging delivery rate-limited; not retrying non-replayable attempt", {
          bindingId: binding?.id ?? intent.bindingId,
          intentId: routedIntent.id,
          intentKind: routedIntent.kind,
          priority,
          retryAfterMs: result.rateLimit.retryAfterMs,
          scopeId: result.rateLimit.scope.id,
        });
      }
      await this.options.store.recordDelivery({
        ...result,
        id: `delivery:${routedIntent.id}:${randomUUID()}`,
        bindingId: binding?.id ?? intent.bindingId,
        intentId: routedIntent.id,
      });
      this.recordOutboundActivity(routedIntent, binding, result);
      if (
        binding &&
        result.channel === binding.channel.channel &&
        isPermanentMessagingTargetFailure(result)
      ) {
        await this.options.store.revokeBinding({
          bindingId: binding.id,
          revokedAt: this.now(),
        });
        await this.bindingService.recordBindingTransition("unbound", binding);
        this.bindingService.notifyBindingChanged("permanent-delivery-failure");
        this.logger.debug?.("messaging binding revoked after permanent delivery failure", {
          bindingId: binding.id,
          channel: binding.channel.channel,
          conversationId: binding.channel.conversation.id,
          errorMessage: result.errorMessage,
          outcome: result.outcome,
          threadId: binding.threadId,
        });
      }
      return result;
    }
  }

  private async markWorkingCardWaiting(
    binding: MessagingBindingRecord,
  ): Promise<void> {
    if (binding.channel.channel !== "slack") {
      return;
    }
    const turnId = this.getActiveTurn(binding)?.turnId;
    if (!turnId) {
      return;
    }
    const key = this.turnProseKey(binding.id, turnId);
    const state = this.workingCards.get(key);
    if (!state) return;
    state.sequence += 1;
    const card = buildWorkingCardIntent({
      activities: [...state.activities.values()],
      bindingId: binding.id,
      createdAt: this.now(),
      displayHint: "plan",
      fallbackActivities: [],
      id: this.newIntentId("working-card-waiting"),
      key,
      omittedTaskCount: state.omittedTaskCount,
      sequence: state.sequence,
    });
    card.card.phase = "waiting";
    await this.deliver(
      card,
      binding,
      this.agentMessagingOriginEvent(binding, turnId),
    );
    await this.deliver(buildActivityIntent({
      activity: "typing",
      bindingId: binding.id,
      createdAt: this.now(),
      id: this.newIntentId("working-card-waiting-idle"),
      state: "idle",
    }), binding);
  }

  private async deliverArtifactForBinding(params: {
    artifact: MessagingArtifact;
    binding: MessagingBindingRecord;
    intentId: string;
  }): Promise<void> {
    const intent = buildArtifactDeliveryIntent({
      artifact: params.artifact,
      bindingId: params.binding.id,
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      id: params.intentId,
    });
    const result = await this.deliver(intent, params.binding);
    if (!shouldRetryArtifactInline(intent, result)) {
      return;
    }
    this.logger.debug?.("messaging artifact attachment delivery failed; retrying inline fallback", {
      bindingId: params.binding.id,
      errorMessage: result.errorMessage,
      intentId: intent.id,
      kind: params.artifact.kind,
      outcome: result.outcome,
      threadId: params.binding.threadId,
    });
    await this.deliver(
      buildArtifactInlineFallbackIntent({
        artifact: params.artifact,
        bindingId: params.binding.id,
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        id: `${params.intentId}:inline-fallback`,
      }),
      params.binding,
    );
  }

  private logDeliveryResult(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord | undefined,
    result: MessagingDeliveryResult,
  ): void {
    const logContext = {
      bindingId: binding?.id ?? intent.bindingId,
      channel: result.channel,
      errorMessage: result.errorMessage,
      intentId: intent.id,
      intentKind: intent.kind,
      outcome: result.outcome,
      surfaceId: result.surface?.id,
      threadId: binding?.threadId,
    };
    if (result.outcome === "failed") {
      this.logger.warn?.("messaging delivery failed", logContext);
    } else if (intent.kind === "stream_update" && !intent.stream.isFinal) {
      // A streaming turn edits its message roughly once a second for its whole
      // duration; logging every partial at info drowns the log. Keep the
      // per-partial deliveries at debug — the final stream + message stay info.
      this.logger.debug?.("messaging delivery completed", logContext);
    } else {
      this.logger.info?.("messaging delivery completed", logContext);
    }
  }

  private notifyDeliveryBudgetEvent(
    event: MessagingControllerDeliveryBudgetEvent,
  ): void {
    if (!this.options.onDeliveryBudgetEvent) return;
    try {
      this.options.onDeliveryBudgetEvent(event);
    } catch (error) {
      this.logger.debug?.("messaging delivery-budget listener threw", {
        error: error instanceof Error ? error.message : String(error),
        intentId: event.intentId,
        outcome: event.outcome,
      });
    }
  }

  private async deliverToolActivityForBackendEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    activeTurnId?: string,
  ): Promise<void> {
    const turnId = turnIdForBackendEvent(event) ?? activeTurnId;
    if (!turnId) {
      return;
    }

    const activity = summarizeToolActivityFromBackendEvent(event);
    if (!activity) {
      return;
    }
    if (this.isAutomationTurnEvent(event, binding, activeTurnId)) {
      return;
    }

    const mode = resolveMessagingToolUpdateMode(
      binding,
      await this.bindingService.resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
    );
    const deliveries = this.toolUpdatePolicy.processActivity({
      activity,
      bindingId: binding.id,
      mode,
      turnId,
    });
    for (const delivery of deliveries) {
      await this.deliverToolUpdateDelivery(delivery, binding);
    }
  }

  /**
   * Route the agent's in-turn (non-final) prose through the Working Updates
   * dial, mirroring {@link deliverToolActivityForBackendEvent} for tools. The
   * prose is captured un-gated first (so U7's elicitation flush can surface a
   * suppressed setup message), then handed to the same coalescing policy so it
   * is dropped at None, batched at Less/Some/More, or sent individually at All.
   */
  private async deliverAssistantProseForBackendEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    assistantText: string,
    activeTurnId?: string,
  ): Promise<void> {
    const turnId = turnIdForBackendEvent(event) ?? activeTurnId;
    if (!turnId) {
      return;
    }
    if (this.isAutomationTurnEvent(event, binding, activeTurnId)) {
      return;
    }

    const activity: MessagingToolActivity = {
      id: proseActivityIdForBackendEvent(event, turnId, assistantText),
      kind: "prose",
      status: "completed",
      title: assistantText,
    };
    this.ensureTurnProseState(this.turnProseKey(binding.id, turnId)).latest = {
      activityId: activity.id,
      text: assistantText,
    };

    const mode = resolveMessagingToolUpdateMode(
      binding,
      await this.bindingService.resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
    );
    const deliveries = this.toolUpdatePolicy.processActivity({
      activity,
      bindingId: binding.id,
      mode,
      turnId,
    });
    for (const delivery of deliveries) {
      await this.deliverToolUpdateDelivery(delivery, binding);
    }
  }

  private turnProseKey(bindingId: string, turnId: string): string {
    return `${bindingId}\0${turnId}`;
  }

  private ensureTurnProseState(key: string): MessagingTurnProseState {
    let state = this.turnProse.get(key);
    if (!state) {
      state = { deliveredIds: new Set() };
      this.turnProse.set(key, state);
      // Backstop the terminal-event cleanup: evict the oldest turn(s) so a run
      // that ends without a clean terminal event cannot grow the map unbounded.
      while (this.turnProse.size > MAX_TRACKED_TURN_PROSE) {
        const oldest = this.turnProse.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.turnProse.delete(oldest);
      }
    }
    return state;
  }

  private markProseActivitiesDelivered(
    delivery: MessagingToolUpdatePolicyDelivery,
  ): void {
    const proseIds = delivery.activities
      .filter((activity) => activity.kind === "prose")
      .map((activity) => activity.id);
    if (proseIds.length === 0) {
      return;
    }
    const state = this.ensureTurnProseState(
      this.turnProseKey(delivery.bindingId, delivery.turnId),
    );
    for (const id of proseIds) {
      state.deliveredIds.add(id);
    }
  }

  private clearTurnProse(bindingId: string, turnId: string): void {
    const key = this.turnProseKey(bindingId, turnId);
    this.turnProse.delete(key);
    this.workingCards.delete(key);
  }

  private async flushToolUpdatesForBinding(
    binding: MessagingBindingRecord,
    options: { clear: boolean; turnId?: string },
  ): Promise<void> {
    const deliveries = this.toolUpdatePolicy.flush({
      bindingId: binding.id,
      clear: options.clear,
      turnId: options.turnId,
    });
    for (const delivery of deliveries) {
      await this.deliverToolUpdateDelivery(delivery, binding);
    }
  }

  private async deliverToolUpdateDelivery(
    delivery: MessagingToolUpdatePolicyDelivery,
    knownBinding?: MessagingBindingRecord,
  ): Promise<void> {
    const cancellationKey = this.turnProseKey(
      delivery.bindingId,
      delivery.turnId,
    );
    const binding =
      knownBinding?.id === delivery.bindingId
        ? knownBinding
        : await this.options.store.getBinding(delivery.bindingId);
    if (!binding || binding.revokedAt || !this.isChannelInScope(binding.channel)) {
      return;
    }

    // Drop prose already delivered out-of-band (e.g. flushed ahead of an
    // elicitation by U7) so a later coalesced batch does not re-post it.
    const activities = this.filterUndeliveredProseActivities(delivery);
    if (activities.length === 0) {
      return;
    }

    const intent = binding.channel.channel === "slack" && delivery.lifecycle !== "window"
      ? this.buildWorkingCardDeliveryIntent(delivery, binding.id, activities)
      : delivery.kind === "individual"
        ? buildToolUpdateMessageIntent({
            activity: activities[0]!,
            bindingId: binding.id,
            createdAt: this.now(),
            id: this.newIntentId("tool-update"),
          })
        : buildToolUpdateBatchMessageIntent({
            activities,
            bindingId: binding.id,
            createdAt: this.now(),
            id: this.newIntentId("tool-update-batch"),
          });
    if (delivery.lifecycle === "window") {
      // These receipts have no running turn to own a working card, cancellation
      // surface or terminal cleanup. Their window owns only this delivery.
      await this.deliver(intent, binding);
      return;
    }
    this.markProseActivitiesDelivered({ ...delivery, activities });
    const cancellation = this.ensureWorkingUpdateCancellationSignal(
      binding,
      delivery.turnId,
    );
    const guardedIsCancelled = () =>
      cancellation.isCancelled();
    const deliveryPromise = (async (): Promise<MessagingDeliveryResult> => {
      const result = await this.deliver(
        intent,
        binding,
        this.agentMessagingOriginEvent(binding, delivery.turnId),
        {
          isCancelled: guardedIsCancelled,
          whenCancelled: cancellation.whenCancelled,
          onCancelledDelivery: async (cancelledResult) => {
            if (
              cancelledResult.surface
              && isVisibleAssistantStreamDelivery(cancelledResult)
            ) {
              const dismissed = await this.dismissTerminalPrivateResponseSurface(
                binding,
                delivery.turnId,
                cancelledResult.surface,
              );
              if (!dismissed) {
                this.workingUpdateCancellationFailures.add(cancellationKey);
              }
            }
          },
        },
      );
      if (
        !guardedIsCancelled()
        && result.surface
        && isVisibleAssistantStreamDelivery(result)
      ) {
        let surfaces = this.workingUpdateSurfaces.get(cancellationKey);
        if (!surfaces) {
          surfaces = new Map();
          this.workingUpdateSurfaces.set(cancellationKey, surfaces);
        }
        surfaces.set(messagingSurfaceKey(result.surface), result.surface);
      }
      return result;
    })();
    let deliveries = this.workingUpdateDeliveries.get(cancellationKey);
    if (!deliveries) {
      deliveries = new Set();
      this.workingUpdateDeliveries.set(cancellationKey, deliveries);
    }
    deliveries.add(deliveryPromise);
    try {
      await deliveryPromise;
    } finally {
      deliveries.delete(deliveryPromise);
      if (deliveries.size === 0) {
        this.workingUpdateDeliveries.delete(cancellationKey);
      }
    }
  }

  private buildWorkingCardDeliveryIntent(
    delivery: MessagingToolUpdatePolicyDelivery,
    bindingId: string,
    activities: MessagingToolActivity[],
  ): MessagingSurfaceIntent {
    const key = this.turnProseKey(bindingId, delivery.turnId);
    let state = this.workingCards.get(key);
    if (!state) {
      state = { activities: new Map(), omittedTaskCount: 0, sequence: 0 };
      rememberWorkingCardState(this.workingCards, key, state);
    }
    updateWorkingCardActivities(state, activities);
    state.sequence += 1;
    return buildWorkingCardIntent({
      activities: [...state.activities.values()],
      bindingId,
      createdAt: this.now(),
      displayHint: delivery.mode === "show_all"
        ? "timeline"
        : delivery.mode === "show_less"
          ? "dense"
          : "plan",
      fallbackActivities: activities,
      id: this.newIntentId("working-card"),
      key,
      omittedTaskCount: state.omittedTaskCount,
      sequence: state.sequence,
    });
  }

  private async finalizeWorkingCard(
    binding: MessagingBindingRecord,
    turnId: string,
    phase: "completed" | "failed",
  ): Promise<void> {
    if (binding.channel.channel !== "slack") {
      return;
    }
    const key = this.turnProseKey(binding.id, turnId);
    const state = this.workingCards.get(key);
    if (!state) {
      return;
    }
    state.sequence += 1;
    const intent = buildWorkingCardIntent({
      activities: [...state.activities.values()],
      bindingId: binding.id,
      createdAt: this.now(),
      displayHint: "plan",
      fallbackActivities: [],
      id: this.newIntentId("working-card-final"),
      key,
      omittedTaskCount: state.omittedTaskCount,
      sequence: state.sequence,
    });
    intent.card.phase = phase;
    intent.card.isFinal = true;
    await this.deliver(
      intent,
      binding,
      this.agentMessagingOriginEvent(binding, turnId),
    );
    this.workingCards.delete(key);
  }

  private agentMessagingOriginEvent(
    binding: MessagingBindingRecord,
    turnId: string,
  ): MessagingInboundEvent | undefined {
    return this.activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(binding.backend, binding.threadId, turnId),
    )?.event;
  }

  private filterUndeliveredProseActivities(
    delivery: MessagingToolUpdatePolicyDelivery,
  ): MessagingToolActivity[] {
    const state = this.turnProse.get(
      this.turnProseKey(delivery.bindingId, delivery.turnId),
    );
    if (!state) {
      return delivery.activities;
    }
    return delivery.activities.filter(
      (activity) =>
        activity.kind !== "prose" || !state.deliveredIds.has(activity.id),
    );
  }

  /**
   * Deliver the agent's captured in-turn setup prose immediately before an
   * elicitation (U7), so a questionnaire like "Option A or Option B?" carries
   * the message that described the options — even when the Working Updates dial
   * (None) would otherwise suppress it. Idempotent: prose already delivered this
   * turn (individually, in a batch, or by a prior elicitation) is not re-sent.
   */
  private async flushPendingTurnProseBeforeElicitation(
    binding: MessagingBindingRecord,
    turnId: string | null | undefined,
  ): Promise<void> {
    if (!turnId) {
      return;
    }
    const state = this.turnProse.get(this.turnProseKey(binding.id, turnId));
    const latest = state?.latest;
    if (!state || !latest || state.deliveredIds.has(latest.activityId)) {
      return;
    }
    // Mark before delivering so a re-entrant elicitation for the same turn does
    // not double-post the setup message...
    state.deliveredIds.add(latest.activityId);
    const result = await this.deliver(
      {
        id: this.newIntentId("assistant-prose"),
        kind: "message",
        bindingId: binding.id,
        createdAt: this.now(),
        role: "assistant",
        attribution: await this.responseAttributionForBinding(binding),
        parts: [{ type: "text", text: latest.text, markdown: "markdown" }],
      },
      binding,
    );
    // ...but if the delivery was skipped (e.g. budget-exhausted), roll the mark
    // back so the setup prose can still ride the turn's coalesced batch rather
    // than being silently recorded as delivered and filtered out.
    if (!result.surface) {
      state.deliveredIds.delete(latest.activityId);
    }
  }

  private async deliverPrivateResponseFallback(params: {
    binding: MessagingBindingRecord;
    event: AgentEvent;
    text: string;
    turnId: string;
  }): Promise<void> {
    const turnKey = agentMessagingTurnKey(
      params.event.backend,
      params.binding.threadId,
      params.turnId,
    );
    if (!this.privateResponses.claimFallback(turnKey)) {
      return;
    }

    let response: PwrAgentMessagingResponse;
    try {
      response = await this.sendPrivateResponseFromAgentMessagingOrigin({
        operation: "send_private_response",
        context: {
          backend: params.event.backend,
          threadId: params.binding.threadId,
          turnId: params.turnId,
        },
        args: { text: params.text },
      });
    } finally {
      this.privateResponses.finishFallback(turnKey);
    }
    if (response.ok) {
      return;
    }

    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("private-response-fallback-failed"),
        createdAt: this.now(),
        title: "Private response not delivered",
        body:
          "PwrAgent withheld the response from this conversation because it could not confirm private delivery. Try the request again or DM the bot directly.",
        recoverable: true,
      }),
      params.binding,
    );
  }

  private retainedSourceUnavailable(context: PwrAgentMessagingRequest["context"], code: "forbidden" | "not_found" = "forbidden"): Extract<PwrAgentMessagingResponse, { ok: false }> {
    return { ok: false, error: {
      code: context.causalMessagingAmbiguous ? "ambiguous_location" : code,
      message: context.causalMessagingAmbiguous
        ? "This turn combines different causal messaging requests; choose a separately attributable request before attaching."
        : "No currently authorized human messaging request is available for this operation. Saved bindings do not establish the requesting actor.",
    } };
  }

  private async listRetainedMessagingSurfaces(
    request: Extract<PwrAgentMessagingRequest, { operation: "list_messaging_surfaces" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const source = this.accessControl.retainedRequestSource(request.context);
    if (!source || !this.isChannelInScope(source.event.channel)) return this.retainedSourceUnavailable(request.context, "not_found");
    if (!this.accessControl.retainedRequestCanCrossInstance(request.context, source) || !this.options.requestStore || !this.accessControl.retainedSourceHasPermissions(source)
      || !await this.accessControl.retainedSourceIsAuthorized(source)) return this.retainedSourceUnavailable(request.context);
    if (!isAppServerBackendKind(request.args.backend) || !request.args.threadId?.trim()
      || (request.args.limit !== undefined && (!Number.isInteger(request.args.limit) || request.args.limit < 1 || request.args.limit > 25))) {
      return { ok: false, error: { code: "invalid_arguments", message: "Provide a target backend/threadId and a limit between 1 and 25." } };
    }
    const canUseRemote = this.accessControl.actorHasPermission(source.event, "federation.remote_control");
    if (request.args.instanceId && !canUseRemote) return this.retainedSourceUnavailable(request.context);
    const target = await this.resolveAttachTarget({ ...request.args, includeRemote: canUseRemote && request.args.includeRemote !== false });
    if (!target.ok) return target;
    let before: { at: number; selector: string } | undefined;
    if (request.args.cursor) {
      try {
        if (request.args.cursor.length > 512) throw new Error("oversized cursor");
        const cursor = JSON.parse(Buffer.from(request.args.cursor, "base64url").toString("utf8")) as { scope: string; at: number; selector: string };
        if (cursor.scope !== source.principalScope || !Number.isSafeInteger(cursor.at) || !/^[a-f0-9]{64}$/.test(cursor.selector)) throw new Error("invalid cursor");
        before = cursor;
      } catch {
        return { ok: false, error: { code: "invalid_arguments", message: "Use an unmodified nextCursor from this request's destination listing." } };
      }
    }
    const limit = request.args.limit ?? 25;
    const candidates = this.options.requestStore.list(source, limit + 1, before);
    const page = candidates.slice(0, limit);
    const result: ListMessagingSurfacesResult = {
      surfaces: [], eligibleCount: null, countIsComplete: !before && candidates.length <= limit,
      selectionReason: "unavailable",
    };
    for (const candidate of page) {
      if (!this.accessControl.retainedSourceHasPermissions(candidate)) continue;
      const authorized = await this.accessControl.retainedSourceIsAuthorized(candidate);
      if (authorized === undefined) result.countIsComplete = false;
      if (!authorized) continue;
      // Use the immutable request's reply anchor for its causal destination,
      // even if a later human interaction updated this surface's summary.
      const selected = candidate.selector === source.selector ? source : candidate;
      const origin = await this.originForRetainedSource(selected);
      const location = await this.summarizeAgentMessagingLocation(origin, { navigation: { kind: "thread", thread: target.thread } });
      if (location.managedConversation.outcome === "failed") result.countIsComplete = false;
      if (!this.resolveAttachPlacement({ location, origin, placement: request.args.placement ?? "auto" }).ok) continue;
      result.surfaces.push({ surfaceSelector: candidate.selector, location,
        revision: selected.ref.requestId,
        lastUserInteractionAt: candidate.event.receivedAt, route: candidate.route,
        provenance: candidate.selector === source.selector ? "causal_request" : "last_human_interaction" });
    }
    if (result.countIsComplete) result.eligibleCount = result.surfaces.length;
    if (candidates.length > limit && page.length) {
      const last = page[page.length - 1]!;
      result.nextCursor = Buffer.from(JSON.stringify({ scope: source.principalScope,
        at: last.event.receivedAt, selector: last.selector })).toString("base64url");
    }
    // Recommendation does not reorder the human-recency list and does not
    // require enumerating every surface on the normal causal attach path.
    const origin = await this.originForRetainedSource(source);
    const location = await this.summarizeAgentMessagingLocation(origin, { navigation: { kind: "thread", thread: target.thread } });
    if (this.resolveAttachPlacement({ location, origin, placement: request.args.placement ?? "auto" }).ok) {
      result.recommendedSurfaceSelector = source.selector;
      result.selectionReason = "causal_request";
    } else if (result.surfaces.length) {
      if (result.countIsComplete && result.surfaces.length === 1) {
        result.selectionReason = "sole_eligible";
        result.recommendedSurfaceSelector = result.surfaces[0]!.surfaceSelector;
      } else result.selectionReason = "ambiguous";
    } else if (result.countIsComplete) result.selectionReason = "none";
    return { ok: true, data: result };
  }

  private async originForRetainedSource(source: MessagingRequestSource): Promise<ActiveAgentMessagingOrigin> {
    return { source, event: source.event,
      binding: source.bindingId ? await this.options.store.getBinding(source.bindingId) : undefined };
  }

  private async attachThreadToRetainedSurface(
    request: Extract<PwrAgentMessagingRequest, { operation: "attach_thread_to_surface" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const source = this.accessControl.retainedRequestSource(request.context);
    if (!source || !this.isChannelInScope(source.event.channel)) return this.retainedSourceUnavailable(request.context, "not_found");
    if (!this.accessControl.retainedRequestCanCrossInstance(request.context, source) || !this.accessControl.retainedSourceHasPermissions(source)
      || !await this.accessControl.retainedSourceIsAuthorized(source, false)) return this.retainedSourceUnavailable(request.context);
    if (request.args.instanceId && !this.accessControl.actorHasPermission(source.event, "federation.remote_control")) return this.retainedSourceUnavailable(request.context);
    let selector = request.args.surfaceSelector;
    if (request.args.selection !== undefined && !["causal", "sole_eligible"].includes(request.args.selection)) {
      return { ok: false, error: { code: "invalid_arguments", message: "selection must be causal or sole_eligible." } };
    }
    if (request.args.selection === "sole_eligible") {
      if (selector) return { ok: false, error: { code: "invalid_arguments", message: "Choose an explicit surfaceSelector or sole_eligible selection, not both." } };
      const listed = await this.listRetainedMessagingSurfaces({ operation: "list_messaging_surfaces", context: request.context,
        args: { ...request.args, limit: 25 } });
      if (!listed.ok) return listed;
      if (!("surfaces" in listed.data) || !listed.data.countIsComplete || listed.data.eligibleCount !== 1) {
        return { ok: false, error: { code: "ambiguous_location", message: "Sole-surface selection requires a complete authorized candidate set with exactly one eligible destination. Inspect and select a destination explicitly." } };
      }
      selector = listed.data.surfaces[0]!.surfaceSelector;
    }
    const selected = !selector || selector === source.selector ? source
      : this.options.requestStore?.destination(source, selector);
    if (!selected || !this.accessControl.retainedSourceHasPermissions(selected)
      || !await this.accessControl.retainedSourceIsAuthorized(selected, false)) return this.retainedSourceUnavailable(request.context);
    if (request.args.expectedRevision && request.args.expectedRevision !== selected.ref.requestId) {
      return { ok: false, error: { code: "forbidden", message: "The selected destination's human reply anchor changed. Inspect its current revision before attaching." } };
    }
    if (request.args.idempotencyKey !== undefined && (typeof request.args.idempotencyKey !== "string"
      || !request.args.idempotencyKey || request.args.idempotencyKey.length > 128)) {
      return { ok: false, error: { code: "invalid_arguments", message: "idempotencyKey must contain 1 to 128 characters." } };
    }
    const claim = this.options.requestStore?.claimAttachment([source.ref.requestId, selected.selector,
      request.args.backend, request.args.threadId, request.args.instanceId ?? null,
      request.args.placement ?? "auto", request.args.targetKind ?? "thread", request.args.title ?? null,
      request.args.idempotencyKey ?? null]);
    if (!claim) return this.retainedSourceUnavailable(request.context);
    if (!claim.claimed) {
      if (!await this.accessControl.retainedSourceIsAuthorized(selected)) return this.retainedSourceUnavailable(request.context);
      if (claim.result?.ok && "binding" in claim.result.data) {
        const binding = await this.options.store.getBinding(claim.result.data.binding.id);
        if (!binding || binding.revokedAt) return this.retainedSourceUnavailable(request.context);
      }
      return claim.result ?? { ok: false, error: { code: "internal_error",
        message: "This attachment was already claimed and its provider outcome is unresolved. Reconcile it before retrying; no second conversation was created." } };
    }
    const result = await this.attachThreadHereFromAgentMessagingOrigin({
      operation: "attach_thread_here", context: request.context,
      args: { ...request.args, includeRemote: this.accessControl.actorHasPermission(source.event, "federation.remote_control") && request.args.includeRemote !== false },
    }, await this.originForRetainedSource(selected));
    this.options.requestStore!.finishAttachment(claim.id, result);
    return result;
  }

  async authorizeRetainedTool(
    context: PwrAgentMessagingRequest["context"],
    check: Parameters<MessagingController["checkDynamicToolPermission"]>[0],
  ): Promise<{ owns: boolean; allowed: boolean; permission?: string }>{
    return this.accessControl.authorizeRetainedTool(context, check);
  }

  private async attachThreadHereFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "attach_thread_here" }>,
    retainedOrigin?: ActiveAgentMessagingOrigin,
  ): Promise<PwrAgentMessagingResponse> {
    const { args } = request;
    if (
      !args ||
      !isAppServerBackendKind(args.backend) ||
      typeof args.threadId !== "string" ||
      args.threadId.trim().length === 0
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "attach_thread_here requires backend and threadId.",
        },
      };
    }
    const instanceId = args.instanceId?.trim();
    const includeRemote = args.includeRemote !== false;
    if (Object.hasOwn(args, "instanceId") && !instanceId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "instanceId must be a non-empty string when provided.",
        },
      };
    }
    if (instanceId && !includeRemote) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "instanceId cannot be used when includeRemote is false.",
        },
      };
    }
    const placement = args.placement ?? "auto";
    if (
      placement !== "auto" &&
      placement !== "new_child" &&
      placement !== "current_conversation"
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "placement must be auto, new_child, or current_conversation.",
        },
      };
    }
    const targetKind = args.targetKind ?? "thread";
    if (!isMessagingBindingTargetKind(targetKind)) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "targetKind must be thread or agent_thread.",
        },
      };
    }

    const origin = retainedOrigin ? { ok: true as const, origin: retainedOrigin }
      : await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return origin;
    }
    const target = await this.resolveAttachTarget({
      backend: args.backend,
      threadId: args.threadId,
      ...(instanceId ? { instanceId } : {}),
      includeRemote,
    });
    if (!target.ok) {
      return target;
    }

    if (!await this.accessControl.requireRemoteScope(origin.origin.event, target.federatedThread?.target, "agent-attach:remote-instance", { notify: false })) {
      return { ok: false, error: { code: "forbidden", message: "The requesting actor cannot attach a thread from this instance." } };
    }

    const location = await this.summarizeAgentMessagingLocation(origin.origin, {
      navigation: { kind: "thread", thread: target.thread },
    });
    const resolvedPlacement = this.resolveAttachPlacement({
      location,
      origin: origin.origin,
      placement,
    });
    if (!resolvedPlacement.ok) {
      return resolvedPlacement;
    }

    let attachEvent = origin.origin.event;
    let createdConversation: MessagingChannelRef["conversation"] | undefined;
    if (retainedOrigin?.source && (!this.accessControl.retainedSourceHasPermissions(retainedOrigin.source)
      || !await this.accessControl.retainedSourceIsAuthorized(retainedOrigin.source))) return this.retainedSourceUnavailable(request.context);
    if (resolvedPlacement.placement === "new_child") {
      if (!this.adapter.createManagedConversation) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "This messaging provider does not support creating a native child conversation from PwrAgent.",
          },
        };
      }
      const createResult = await this.adapter.createManagedConversation({
        actor: origin.origin.event.actor,
        parent: origin.origin.event.channel,
        routingState: origin.origin.event.routingState,
        sourceSurface: origin.origin.event.sourceSurface,
        title: sanitizeMessagingChildTitle(args.title),
      });
      if (createResult.outcome !== "created" || !createResult.conversation) {
        return {
          ok: false,
          error: {
            code: createResult.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              createResult.errorMessage ??
              "The messaging provider could not create a native child conversation.",
          },
        };
      }
      createdConversation = createResult.conversation;
      attachEvent = {
        ...origin.origin.event,
        id: `${origin.origin.event.id}:attach:${this.now()}`,
        kind: "lifecycle",
        lifecycle: "bound",
        channel: {
          channel: createResult.channel,
          conversation: createResult.conversation,
        },
        routingState: createResult.routingState,
        receivedAt: this.now(),
      };
    }

    if (retainedOrigin?.source && (!this.accessControl.retainedSourceHasPermissions(retainedOrigin.source)
      || !await this.accessControl.retainedSourceIsAuthorized(retainedOrigin.source))) return this.retainedSourceUnavailable(request.context);
    const binding = await this.bindingService.bindChannelToThread(attachEvent, {
      backend: args.backend,
      federatedThread: target.federatedThread,
      threadId: args.threadId,
      targetKind,
    });
    await this.restoreAttachedTurnActivity(binding);
    const visibleBinding = await this.bindingService.renderBindingStatus(binding);
    await this.repostLastAssistantMessageForResume(visibleBinding, {
      important: true,
    });
    return {
      ok: true,
      data: {
        binding: summarizeMessagingBinding(
          visibleBinding,
          summarizeNavigationThreadForMessaging(target.thread),
        ),
        channel: visibleBinding.channel.channel,
        conversation: summarizeMessagingConversation(visibleBinding.channel.conversation),
        createdConversation: createdConversation
          ? summarizeMessagingConversation(createdConversation)
          : undefined,
        location,
        outcome: resolvedPlacement.placement === "new_child"
          ? "created_and_attached"
          : "attached",
        placement: resolvedPlacement.placement,
      },
    };
  }

  private async renameCurrentMessagingConversationFromAgentMessagingOrigin(
    request: Extract<
      PwrAgentMessagingRequest,
      { operation: "rename_current_messaging_conversation" }
    >,
  ): Promise<PwrAgentMessagingResponse> {
    const title = normalizeConversationTitle(
      typeof request.args?.title === "string" ? request.args.title : undefined,
    );
    if (!title || title.length > 200) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "rename_current_messaging_conversation requires title between 1 and 200 characters.",
        },
      };
    }
    const origin = await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return origin;
    }
    if (!this.adapter.setConversationTitle) {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message:
            "This messaging provider does not support renaming the current conversation.",
        },
      };
    }

    const result = await this.adapter.setConversationTitle({
      actor: origin.origin.event.actor,
      channel: origin.origin.event.channel,
      routingState:
        origin.origin.event.routingState ?? origin.origin.binding?.routingState,
      title,
    });
    if (result.outcome !== "updated") {
      return {
        ok: false,
        error: {
          code: result.outcome === "unsupported"
            ? "unsupported_operation"
            : "internal_error",
          message:
            result.errorMessage
            ?? "The messaging provider could not rename the current conversation.",
        },
      };
    }

    const renamedConversation = {
      ...result.conversation,
      title: result.title,
    };
    if (origin.origin.binding) {
      const updatedBinding = await this.options.store.upsertBinding({
        ...origin.origin.binding,
        channel: {
          ...origin.origin.binding.channel,
          conversation: {
            ...origin.origin.binding.channel.conversation,
            ...renamedConversation,
          },
        },
        updatedAt: result.updatedAt,
      });
      origin.origin.binding = updatedBinding;
      if (origin.origin.deliveryBinding?.id === updatedBinding.id) {
        origin.origin.deliveryBinding = updatedBinding;
      }
      this.bindingService.notifyBindingChanged("agent-rename-conversation");
      // Binding-local mutation with no registry event behind it, so the
      // status card needs the inline render too — the bus never fires for
      // this, and the provider's own rename echo (Slack's
      // `agent_session_title_changed`) only fires for a participant's
      // rename, never for ours.
      await this.bindingService.renderBindingStatus(updatedBinding, origin.origin.event);
    }

    return {
      ok: true,
      data: {
        channel: result.channel,
        conversation: summarizeMessagingConversation(renamedConversation),
        outcome: "renamed",
        title: result.title,
        updatedAt: result.updatedAt,
      },
    };
  }

  private async sendPrivateResponseFromAgentMessagingOrigin(
    request: Extract<
      PwrAgentMessagingRequest,
      { operation: "send_private_response" }
    >,
  ): Promise<PwrAgentMessagingResponse> {
    const text = typeof request.args?.text === "string"
      ? request.args.text
      : "";
    const awaitReply = request.args?.awaitReply === true;
    const replyInstructions = typeof request.args?.replyInstructions === "string"
      ? request.args.replyInstructions.trim()
      : "";
    const suppliedReplyOptions = request.args?.replyOptions;
    const replyOptions = suppliedReplyOptions === undefined
      ? [{ label: "I did it", text: "I did it." }]
      : suppliedReplyOptions;
    if (!text.trim() || text.length > 40_000) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_private_response requires text between 1 and 40,000 characters.",
        },
      };
    }
    if (
      awaitReply
      && (!replyInstructions || replyInstructions.length > 4_000)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_private_response requires replyInstructions between 1 and 4,000 characters when awaitReply is true.",
        },
      };
    }
    if (
      suppliedReplyOptions !== undefined
      && (
        !awaitReply
        || !Array.isArray(suppliedReplyOptions)
        || suppliedReplyOptions.length < 1
        || suppliedReplyOptions.length > 3
        || suppliedReplyOptions.some((option) =>
          !option
          || typeof option.label !== "string"
          || option.label.trim().length < 1
          || option.label.length > 40
          || typeof option.text !== "string"
          || option.text.trim().length < 1
          || option.text.length > 500
        )
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "replyOptions requires awaitReply and one to three buttons with a label (1–40 characters) and text (1–500 characters).",
        },
      };
    }
    const actionCapabilities = this.capabilityProfile.actions;
    const actionCapacity = actionCapabilities
      ? Math.min(
          actionCapabilities.maxActions,
          (actionCapabilities.maxRows ?? Number.POSITIVE_INFINITY)
            * actionCapabilities.maxActionsPerRow,
        )
      : 0;
    if (
      awaitReply
      && actionCapacity >= 2
      && (
        replyOptions.length + 1 > actionCapacity
        || replyOptions.some((option) =>
          option.label.length > (actionCapabilities?.maxLabelLength ?? 40)
        )
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            `This messaging provider supports at most ${actionCapacity - 1} private reply option(s) plus Cancel; labels must fit its button limit.`,
        },
      };
    }
    if (!request.context.turnId) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message:
            "Private responses require the active messaging turn that identified the requesting user.",
        },
      };
    }
    const turnKey = agentMessagingTurnKey(
      request.context.backend,
      request.context.threadId,
      request.context.turnId,
    );
    const privateReceipt = this.privateResponses.beginTool(turnKey);
    try {
      const origin = await this.resolveAgentMessagingOrigin(request.context);
      if (!origin.ok) {
        return origin;
      }
      if (!this.adapter.resolvePrivateConversation) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "This messaging provider cannot start a private response to the requesting user.",
          },
        };
      }

      let privateConversation: MessagingPrivateConversationResolveResult;
      try {
        privateConversation = await this.adapter.resolvePrivateConversation({
          actor: origin.origin.event.actor,
          ...(awaitReply ? { replyContinuationRequired: true } : {}),
          source: origin.origin.event.channel,
          routingState: origin.origin.event.routingState,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message:
              error instanceof Error
                ? `Could not resolve a private conversation: ${error.message}`
                : "Could not resolve a private conversation.",
          },
        };
      }
      if (
        privateConversation.outcome !== "resolved"
        || !privateConversation.conversation
        || privateConversation.channel !== origin.origin.event.channel.channel
      ) {
        return {
          ok: false,
          error: {
            code: privateConversation.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              privateConversation.errorMessage
              ?? "The messaging provider could not resolve a private conversation.",
          },
        };
      }

      const privateEvent: MessagingInboundEvent = {
        ...origin.origin.event,
        id: `${origin.origin.event.id}:private-response:${this.now()}`,
        channel: {
          channel: privateConversation.channel,
          conversation: privateConversation.conversation,
        },
        receivedAt: this.now(),
        routingState: privateConversation.routingState,
      };
      const sourceBinding = origin.origin.deliveryBinding ?? origin.origin.binding;
      if (awaitReply && !sourceBinding) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: "A private reply needs an originating conversation for its completion.",
          },
        };
      }
      const sourceThread = sourceBinding
        ? await this.resolveBoundThreadSummary(sourceBinding)
        : undefined;
      const attributionLabel = sourceBinding
        ? responseAttributionLabel(sourceBinding, sourceThread)
        : "PwrAgent Agent";
      const requestId = awaitReply ? randomUUID() : undefined;
      // Interactive cards use one provider text block. Keep long private content
      // on the ordinary message path so provider block limits cannot clip it.
      const buttonActions = awaitReply && requestId && actionCapacity >= 2 && text.length <= 2_000
        ? [
            ...replyOptions.map((option, index) => ({
              id: `private-reply:${requestId}:reply:${index}`,
              label: option.label,
              style: "primary" as const,
            })),
            {
              id: `private-reply:${requestId}:cancel`,
              label: "Cancel",
              style: "secondary" as const,
            },
          ]
        : [];
      const result = await this.deliver(
        buttonActions.length > 0
          ? {
              ...buildConfirmationIntent({
                id: this.newIntentId("private-response"),
                capabilityProfile: this.capabilityProfile,
                createdAt: this.now(),
                title: attributionLabel,
                body: `${text}\n\nChoose a button or reply in this message's thread. Completion returns to the original conversation.`,
                actions: buttonActions,
              }),
              allowedActorIds: [origin.origin.event.actor.platformUserId],
              bindingId: sourceBinding?.id,
            }
          : {
              id: this.newIntentId("private-response"),
              kind: "message",
              bindingId: sourceBinding?.id,
              createdAt: this.now(),
              role: "assistant",
              attribution: {
                label: attributionLabel,
                hint: awaitReply
                  ? "Private Request · Reply in Thread to Respond to this Agent; Completion Returns to the Original Conversation"
                  : "Private Request · Reply in Thread to Respond to this Agent",
              },
              parts: [{ type: "text", text, markdown: "markdown" }],
            },
        undefined,
        privateEvent,
      );
      if (!isVisibleAssistantStreamDelivery(result)) {
        return {
          ok: false,
          error: {
            code: result.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              result.errorMessage
              ?? "The private response was not delivered, so the source response was not suppressed.",
          },
        };
      }

      this.privateResponses.delivered(privateReceipt);
      let sourceStreamsCancelled = true;
      let sourceWorkingUpdatesCancelled = true;
      if (sourceBinding) {
        this.toolUpdatePolicy.flush({
          bindingId: sourceBinding.id,
          clear: true,
          turnId: request.context.turnId,
        });
        this.clearTurnProse(sourceBinding.id, request.context.turnId);
        [sourceStreamsCancelled, sourceWorkingUpdatesCancelled] = await Promise.all([
          this.cancelAssistantStreamsForTurn(
            sourceBinding,
            request.context.turnId,
          ),
          this.cancelWorkingUpdatesForTurn(
            sourceBinding,
            request.context.turnId,
          ),
        ]);
      }
      if (!sourceStreamsCancelled || !sourceWorkingUpdatesCancelled) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message:
              "The private response was delivered, but existing source output could not be fully retracted. Further source output remains suppressed.",
          },
        };
      }
      if (sourceBinding) {
        await this.clearTerminalPrivateResponseActivity(
          sourceBinding,
          request.context.turnId,
        );
      }
      if (awaitReply && (!sourceBinding || !result.continuation)) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "The private response was delivered, but this provider did not return a reply thread for the requested continuation. Further source output remains suppressed.",
          },
        };
      }
      if (sourceBinding && result.continuation) {
        try {
          let continuationBinding = await this.bindingService.bindChannelToThread(
            {
              ...privateEvent,
              id: `${privateEvent.id}:continuation`,
              channel: result.continuation.channel,
              routingState: result.continuation.routingState,
            },
            {
              backend: request.context.backend,
              recordTransition: false,
              statusPresentation: "on_demand",
              threadId: request.context.threadId,
              targetKind: sourceBinding.targetKind ?? "agent_thread",
            },
          );
          if (awaitReply) {
            continuationBinding = await this.options.store.upsertBinding({
              ...continuationBinding,
              privateReplyContinuation: {
                createdAt: this.now(),
                expiresAt: this.now() + PRIVATE_REPLY_CONTINUATION_TTL_MS,
                instructions: replyInstructions,
                ...(requestId ? { requestId } : {}),
                ...(result.surface ? { requestSurface: result.surface } : {}),
                replyOptions: replyOptions.map((option) => ({
                  label: option.label.trim(),
                  text: option.text.trim(),
                })),
                source: privateReplySourceFromBinding(sourceBinding),
              },
              updatedAt: this.now(),
            });
            this.bindingService.notifyBindingChanged("private-reply-awaiting");
          }
          await this.clearTerminalPrivateResponseActivity(
            continuationBinding,
            request.context.turnId,
          );
        } catch (error) {
          this.logger.warn?.("messaging private response continuation bind failed", {
            backend: request.context.backend,
            error: error instanceof Error ? error.message : String(error),
            threadId: request.context.threadId,
          });
          return {
            ok: false,
            error: {
              code: "internal_error",
              message:
                "The private response was delivered, but replies to it could not be routed back to this Agent. Further source output remains suppressed.",
            },
          };
        }
      }
      return {
        ok: true,
        data: {
          awaitingReply: awaitReply,
          channel: result.channel,
          deliveredAt: result.deliveredAt,
          outcome: "delivered",
          recipient: summarizeMessagingActor(origin.origin.event.actor),
        },
      };
    } finally {
      this.privateResponses.finishTool(privateReceipt);
    }
  }

  private async sendMessagingFileFromAgentMessagingOrigin(
    request: Extract<
      PwrAgentMessagingRequest,
      { operation: "send_messaging_file" }
    >,
    receivedFile?: Uint8Array,
  ): Promise<PwrAgentMessagingResponse> {
    const invalid = validateMessagingFileMetadata(request.args);
    if (invalid) return { ok: false, error: { code: invalid.code, message: invalid.message } };
    if (request.context.requestingInstanceId && !receivedFile) {
      return { ok: false, error: { code: "forbidden", message: "Federated file sends require received bytes, never a provider-owner path." } };
    }
    const caption = typeof request.args?.caption === "string"
      ? request.args.caption.trim()
      : "";
    const filename = typeof request.args?.filename === "string"
      ? request.args.filename.trim()
      : "";
    const mediaKind = request.args?.mediaKind;
    if (
      mediaKind !== undefined
      && mediaKind !== "auto"
      && mediaKind !== "document"
      && mediaKind !== "image"
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_messaging_file mediaKind must be document, image, or auto.",
        },
      };
    }
    if (caption.length > 4_000) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_messaging_file caption must be at most 4,000 characters.",
        },
      };
    }
    const permission = this.accessControl.checkDynamicToolPermission({
      backend: request.context.backend,
      threadId: request.context.threadId,
      turnId: request.context.turnId,
      category: "messaging_context",
      tool: "send_messaging_file",
    });
    if (permission.owns && !permission.allowed) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message:
            `The messaging user who started this turn lacks permission for this tool (${
              permission.permission ?? "message.reply"
            }).`,
        },
      };
    }
    const sendPrivately = request.args?.private === true;
    if (sendPrivately && !request.context.turnId) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message:
            "Private file delivery requires the active messaging turn that identified the requesting user.",
        },
      };
    }
    const origin = await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return origin;
    }

    // Resolve the destination before loading bytes. A file may run to the
    // provider's whole upload ceiling, and every failure below is knowable
    // without reading it.
    let deliveryEvent = origin.origin.event;
    if (sendPrivately) {
      if (!this.adapter.resolvePrivateConversation) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "This messaging provider cannot send a private file to the requesting user.",
          },
        };
      }
      let privateConversation: MessagingPrivateConversationResolveResult;
      try {
        privateConversation = await this.adapter.resolvePrivateConversation({
          actor: origin.origin.event.actor,
          source: origin.origin.event.channel,
          routingState: origin.origin.event.routingState,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message:
              error instanceof Error
                ? `Could not resolve a private conversation: ${error.message}`
                : "Could not resolve a private conversation.",
          },
        };
      }
      if (
        privateConversation.outcome !== "resolved"
        || !privateConversation.conversation
        || privateConversation.channel !== origin.origin.event.channel.channel
      ) {
        return {
          ok: false,
          error: {
            code: privateConversation.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              privateConversation.errorMessage
              ?? "The messaging provider could not resolve a private conversation.",
          },
        };
      }
      deliveryEvent = {
        ...origin.origin.event,
        id: `${origin.origin.event.id}:private-file:${this.now()}`,
        channel: {
          channel: privateConversation.channel,
          conversation: privateConversation.conversation,
        },
        receivedAt: this.now(),
        routingState: privateConversation.routingState,
      };
    }

    const fileRequest = {
      path: typeof request.args?.path === "string" ? request.args.path : "",
      ...(filename ? { filename } : {}),
      ...(mediaKind ? { mediaKind } : {}),
    };
    const outbound = receivedFile
      ? resolveMessagingOutboundBytes(fileRequest, this.capabilityProfile.outboundAttachments ?? {}, receivedFile)
      : await resolveMessagingOutboundFile(fileRequest, this.capabilityProfile.outboundAttachments ?? {},
        await this.resolveOutboundFileAccess(request.context));
    if (!outbound.ok) {
      return {
        ok: false,
        error: {
          code: outbound.code,
          message: outbound.message,
        },
      };
    }

    if (request.context.requestingInstanceId) {
      const permission = await this.accessControl.authorizeRetainedTool(request.context, {
        ...request.context, category: "messaging_context", tool: "send_messaging_file", arguments: request.args,
      });
      if (!permission.allowed || !(await this.resolveAgentMessagingOrigin(request.context)).ok) {
        return { ok: false, error: { code: "forbidden", message: "The original messaging authority changed before file delivery." } };
      }
    }
    const sourceBinding = origin.origin.deliveryBinding ?? origin.origin.binding;
    const filePart = outbound.mediaKind === "image"
      ? {
          type: "image" as const,
          // Bytes, not a base64 data URL. See MessagingImagePart.data — the
          // round trip through text costs several copies of the whole file.
          url: "",
          data: outbound.data,
          mimeType: outbound.mimeType,
          alt: outbound.filename,
          name: outbound.filename,
          sourceUrl: outbound.path,
        }
      : {
          type: "file" as const,
          name: outbound.filename,
          data: outbound.data,
          mimeType: outbound.mimeType,
          sizeBytes: outbound.sizeBytes,
        };
    const result = await this.deliver(
      {
        id: this.newIntentId("messaging-file"),
        kind: "message",
        bindingId: sourceBinding?.id,
        createdAt: this.now(),
        delivery: {
          requireAttachments: true,
        },
        role: "assistant",
        parts: [
          ...(caption
            ? [{ type: "text" as const, text: caption, markdown: "markdown" as const }]
            : []),
          filePart,
        ],
      },
      sendPrivately ? undefined : sourceBinding,
      deliveryEvent,
    );
    if (!isVisibleAssistantStreamDelivery(result)) {
      return {
        ok: false,
        error: {
          code: result.outcome === "unsupported"
            ? "unsupported_operation"
            : "internal_error",
          message:
            result.errorMessage
            ?? "The file was not delivered to the messaging surface.",
        },
      };
    }
    this.recordOutboundFileActivity({
      backend: request.context.backend,
      binding: sourceBinding,
      event: deliveryEvent,
      file: {
        filename: outbound.filename,
        mediaKind: outbound.mediaKind,
        mimeType: outbound.mimeType,
        path: outbound.path,
        sizeBytes: outbound.sizeBytes,
      },
      deliveredAt: result.deliveredAt,
      private: sendPrivately,
      threadId: request.context.threadId,
    });
    if (
      !sendPrivately
      && sourceBinding
      && filePart.type === "image"
    ) {
      this.rememberOutboundMessagingFileImages({
        backend: request.context.backend,
        binding: sourceBinding,
        images: [filePart],
        pathAliases: [outbound.path, typeof request.args?.path === "string"
          ? request.args.path.trim()
          : ""],
        threadId: request.context.threadId,
        turnId: request.context.turnId,
      });
    }

    return {
      ok: true,
      data: {
        channel: deliveryEvent.channel.channel,
        conversation: summarizeMessagingConversation(
          deliveryEvent.channel.conversation,
        ),
        deliveredAt: result.deliveredAt,
        filename: outbound.filename,
        mediaKind: outbound.mediaKind,
        mimeType: outbound.mimeType,
        outcome: "delivered",
        private: sendPrivately,
        sizeBytes: outbound.sizeBytes,
        ...(sendPrivately
          ? { recipient: summarizeMessagingActor(origin.origin.event.actor) }
          : {}),
      },
    };
  }

  private rememberOutboundMessagingFileImages(params: {
    backend: AppServerBackendKind;
    binding: MessagingBindingRecord;
    images: MessagingImagePart[];
    pathAliases?: readonly string[];
    threadId: ThreadIdentifier;
    turnId?: string;
  }): void {
    if (params.images.length === 0) {
      return;
    }
    const identity = {
      threadId: params.threadId,
      turnId: params.turnId,
    };
    const syntheticEvent = {
      backend: params.backend,
      notification: {
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
        },
      },
    } as AgentEvent;
    const variants: MessagingImagePart[][] = [params.images];
    for (const image of params.images) {
      // Only claim the sourceUrl-less shape when `url` still identifies the
      // image. A bytes-backed part has an empty url, and claiming that would
      // register a signature matching any other empty-url image.
      if (image.url) {
        variants.push([{ ...image, sourceUrl: undefined }]);
      }
      const aliases = outboundImageClaimAliases([
        image.sourceUrl,
        image.url,
        ...(params.pathAliases ?? []),
      ]);
      for (const alias of aliases) {
        variants.push([{
          ...image,
          url: alias,
          sourceUrl: alias,
        }]);
      }
    }
    for (const images of variants) {
      this.claimAssistantMessageContentDelivery(
        syntheticEvent,
        params.binding,
        assistantImageDeliverySignature(images),
        identity,
      );
    }
  }

  private async resolveOutboundFileAccess(
    context: PwrAgentMessagingRequest["context"],
  ): Promise<MessagingOutboundFileAccess> {
    const configured = this.options.outboundFileAccess?.();
    const allowedRoots = [
      ...resolveScratchProjectsRoots(),
      ...(configured?.allowedRoots ?? []),
    ];
    try {
      const thread = await this.readExactNavigationThread({ ref: { backend: context.backend, threadId: context.threadId } });
      if (thread?.projectKey) {
        allowedRoots.push(thread.projectKey);
      }
      for (const directory of thread?.linkedDirectories ?? []) {
        allowedRoots.push(directory.path);
        if (directory.worktreePath) {
          allowedRoots.push(directory.worktreePath);
        }
      }
    } catch {
      // Scratch-project and configured roots still apply.
    }
    return {
      allowedRoots,
      ...(configured?.privateStorageRoots
        ? { privateStorageRoots: configured.privateStorageRoots }
        : {}),
    };
  }

  private async handleOriginalAttachmentRequest(
    request: Extract<PwrAgentMessagingRequest, { operation: "list_messaging_attachments" | "export_messaging_attachment" }>,
    consumeOriginal?: OriginalAttachmentConsumer,
  ): Promise<PwrAgentMessagingResponse> {
    const store = this.options.originalAttachmentStore;
    if (!store) return { ok: false, error: { code: "not_found", message: "No original-file cache is available on this messaging owner. Ask the sender to reattach the file after upgrading." } };
    if (request.context.causalMessagingAmbiguous) return this.retainedSourceUnavailable(request.context);
    const active = request.context.turnId ? this.activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(request.context.backend, request.context.threadId, request.context.turnId),
    ) : undefined;
    const source = this.accessControl.retainedRequestSource(request.context);
    const event = source?.event ?? active?.event;
    // The request store is shared by every provider. An unrelated controller
    // must yield before actor authorization, so the owner can decide access.
    if (event && !this.isChannelInScope(event.channel)) {
      return { ok: false, error: { code: "not_found", message: "No original attachments for this messaging provider." } };
    }
    const remote = request.context.requestingInstanceId;
    // The authenticated caller must be the actual execution owner, including
    // full peers. A source ref or colliding thread ID alone is never a grant.
    const remoteAuthorized = async (verifyAccess = true): Promise<boolean> => {
      if (!remote || !source || !source.bindingId || source.agent.backend !== request.context.backend
        || source.agent.threadId !== request.context.threadId) return false;
      if (!await this.accessControl.retainedSourceIsAuthorized(source, verifyAccess)) return false;
      const binding = await this.options.store.findActiveBindingForChannel(source.event.channel);
      return binding?.id === source.bindingId && binding.backend === request.context.backend
        && binding.threadId === request.context.threadId && containedMessagingBindingMatches(request.context, binding)
        && this.accessControl.retainedRequestCanCrossInstance(request.context, source)
        && this.accessControl.checkDynamicToolPermission({ ...request.context, category: "messaging_context",
          tool: request.operation, arguments: request.args }, source).allowed;
    };
    if (remote && !await remoteAuthorized()) return this.retainedSourceUnavailable(request.context);
    if (!event && (request.context.messagingTurn || request.context.causalMessagingSource)) {
      return { ok: false, error: { code: "not_found", message:
        "This messaging turn's actor cannot be reauthorized after restart. Send a new message in the original conversation, or request the save in a local desktop turn on this thread." } };
    }
    if (!remote && !active && request.context.causalMessagingSource && (!source || !await this.accessControl.retainedSourceIsAuthorized(source))) {
      return this.retainedSourceUnavailable(request.context);
    }
    const permission = this.accessControl.checkDynamicToolPermission({ ...request.context,
      category: "messaging_context", tool: request.operation, arguments: request.args,
    }, source);
    if (!permission.allowed) return { ok: false, error: { code: "forbidden", message: "The requesting actor cannot access received attachments." } };
    const scope = { backend: request.context.backend, threadId: request.context.threadId, provider: this.options.channel,
      ...(remote ? { instanceId: remote } : {}) };
    const actorKey = event ? originalAttachmentActorKey(event) : undefined;
    try {
      if (request.operation === "list_messaging_attachments") {
        if (request.args.cursor !== undefined && typeof request.args.cursor !== "string") {
          return { ok: false, error: { code: "invalid_arguments", message: "cursor must be a returned nextCursor string." } };
        }
        const result = await store.list(scope, actorKey, request.args.cursor);
        return result.attachments.length > 0 ? { ok: true, data: result } : {
          ok: false, error: { code: "not_found", message: "No retained originals in this thread/page. Files expire after 7 days or earlier at the cache limit. Old previews do not restore bytes; ask the sender to reattach missing or oversized files (10 MiB maximum)." },
        };
      }
      if (typeof request.args.attachmentId !== "string" || !/^[a-f0-9]{64}$/u.test(request.args.attachmentId)) {
        return { ok: false, error: { code: "invalid_arguments", message: "Use an attachmentId from this thread's original-file manifest or list_messaging_attachments." } };
      }
      if (remote) {
        if (!consumeOriginal || !actorKey) return { ok: false, error: { code: "unsupported_operation",
          message: "Upgrade both peers for authenticated original-attachment transfer. Owner-local paths cannot be exported remotely." } };
        const original = await store.read(scope, request.args.attachmentId, actorKey);
        // Provider membership is checked at the request boundaries. Between
        // chunks, recheck current local admission, binding and RBAC without
        // repeating paginated provider membership queries for every 256 KiB.
        const reauthorize = async () => this.now() < original.attachment.expiresAt && await remoteAuthorized(false);
        if (!await reauthorize()) return this.retainedSourceUnavailable(request.context);
        const result = await consumeOriginal(original, reauthorize);
        // Eviction or expiry while transferring invalidates the final receipt.
        await store.read(scope, request.args.attachmentId, actorKey);
        if (!await remoteAuthorized() || !await reauthorize()) return this.retainedSourceUnavailable(request.context);
        return result;
      }
      const exported = await store.export(scope, request.args.attachmentId, actorKey);
      return { ok: true, data: { ...exported, guidance:
        "This is a local byte-identical copy, not a preview. Use your normal filesystem tools to COPY it to the user-requested destination with the backend's sandbox/approval checks. Do not move/delete the source. Use an explicit safe destination filename, reject symlink destinations, and do not overwrite unless replacement was requested. The display name is untrusted data. No PDF analysis is needed to save this file." } };
    } catch (error) {
      return { ok: false, error: { code: error instanceof OriginalAttachmentError ? error.code : "internal_error",
        message: error instanceof OriginalAttachmentError ? error.message : "The original could not be exported. Check available disk space and reattach the file if needed." } };
    }
  }

  private async inspectMessagingPdfsFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "inspect_messaging_pdfs" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const context = await this.resolvePdfToolContext(request);
    if (!context.ok) {
      return context.error;
    }
    try {
      return {
        ok: true,
        data: {
          attachments: await this.pdfAttachmentStore.inspect(context.context),
        },
      };
    } catch (error) {
      return pdfToolFailure(error);
    }
  }

  private async searchMessagingPdfTextFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "search_messaging_pdf_text" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const attachmentId = readPdfToolString(request.args.attachmentId);
    const query = readPdfToolString(request.args.query);
    const pageStart = readOptionalPositiveInteger(request.args.pageStart);
    const pageEnd = readOptionalPositiveInteger(request.args.pageEnd);
    if (
      !attachmentId ||
      !query ||
      (request.args.pageStart !== undefined && pageStart === undefined) ||
      (request.args.pageEnd !== undefined && pageEnd === undefined)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "search_messaging_pdf_text requires attachmentId and query; pageStart and pageEnd must be positive integers when supplied.",
        },
      };
    }
    const context = await this.resolvePdfToolContext(request);
    if (!context.ok) {
      return context.error;
    }
    try {
      return {
        ok: true,
        data: await this.pdfAttachmentStore.search({
          ...context.context,
          attachmentId,
          pageEnd,
          pageStart,
          query,
        }),
      };
    } catch (error) {
      return pdfToolFailure(error);
    }
  }

  private async renderMessagingPdfPagesFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "render_messaging_pdf_pages" }>,
  ): Promise<PwrAgentMessagingResponse> {
    if (request.context.backend !== "codex") {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message:
            "Rendered messaging PDF pages are currently available only to Codex PDF analysis turns.",
        },
      };
    }
    const attachmentId = readPdfToolString(request.args.attachmentId);
    const pageNumbers = readPdfToolPageNumbers(request.args.pageNumbers);
    if (!attachmentId || !pageNumbers) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "render_messaging_pdf_pages requires attachmentId and one or more positive integer pageNumbers.",
        },
      };
    }
    const context = await this.resolvePdfToolContext(request);
    if (!context.ok) {
      return context.error;
    }
    try {
      const rendered = await this.pdfAttachmentStore.render({
        ...context.context,
        attachmentId,
        pageNumbers,
      });
      return {
        ok: true,
        data: rendered.result,
        imageContent: rendered.imageContent,
      };
    } catch (error) {
      return pdfToolFailure(error);
    }
  }

  private async resolvePdfToolContext(
    request: PwrAgentMessagingRequest,
  ): Promise<
    | {
        ok: true;
        context: {
          backend: AppServerBackendKind;
          threadId: ThreadIdentifier;
          turnId: string;
        };
      }
    | { ok: false; error: Extract<PwrAgentMessagingResponse, { ok: false }> }
  > {
    if (!request.context.turnId) {
      return {
        ok: false,
        error: {
          ok: false,
          error: {
            code: "not_found",
            message: "Messaging PDF tools require an active messaging turn.",
          },
        },
      };
    }
    if (request.context.requestingInstanceId && !this.pdfAttachmentStore.authorizesSource({
      backend: request.context.backend, threadId: request.context.threadId, turnId: request.context.turnId,
    }, request.context.requestingInstanceId, request.context.causalMessagingSource)) {
      return { ok: false, error: { ok: false, error: { code: "forbidden", message: "PDF attachments do not belong to this source and messaging turn." } } };
    }
    const origin = await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return { ok: false, error: origin };
    }
    return {
      ok: true,
      context: {
        backend: request.context.backend,
        threadId: request.context.threadId,
        turnId: request.context.turnId,
      },
    };
  }

  private async resolveAttachTarget(request: {
    backend: AppServerBackendKind;
    threadId: string;
    instanceId?: string;
    includeRemote: boolean;
  }): Promise<AttachTargetResolution> {
    let target: NavigationThreadSummary | undefined;
    try {
      if (this.options.backend.resolveThreadTarget) {
        const resolved = await this.options.backend.resolveThreadTarget(request);
        return resolved
          ? { ok: true, ...resolved }
          : attachTargetNotFound(request.backend, request.threadId);
      }
      if (request.instanceId || request.includeRemote === false) {
        return attachTargetNotFound(request.backend, request.threadId);
      }
      target = await this.readExactNavigationThread({ ref: { backend: request.backend, threadId: request.threadId } });
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof MessagingFederatedThreadTargetError
              ? error.code
              : "internal_error",
          message:
            error instanceof Error
              ? `Could not verify target thread before attaching: ${error.message}`
              : "Could not verify target thread before attaching.",
        },
      };
    }

    if (!target) {
      return attachTargetNotFound(request.backend, request.threadId);
    }

    return { ok: true, thread: target };
  }

  private resolveAttachPlacement(params: {
    location: PwrAgentMessagingLocationSummary;
    origin: ActiveAgentMessagingOrigin;
    placement: "auto" | "current_conversation" | "new_child";
  }):
    | { ok: true; placement: "current_conversation" | "new_child" }
    | Extract<PwrAgentMessagingResponse, { ok: false }> {
    if (params.placement !== "auto") {
      if (
        params.placement === "new_child" &&
        !params.location.managedConversation.canCreateChild
      ) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: managedConversationUnavailableMessage(
              params.location.managedConversation,
            ),
          },
        };
      }
      return { ok: true, placement: params.placement };
    }

    if (params.location.managedConversation.canCreateChild) {
      return { ok: true, placement: "new_child" };
    }

    const sourceConversationKind = params.origin.event.channel.conversation.kind;
    const canAttachToCurrentUnboundConversation =
      !params.origin.binding
      && (
        sourceConversationKind === "dm"
        || sourceConversationKind === "thread"
        || sourceConversationKind === "topic"
      );
    const canReplaceCurrentThreadOrTopicBinding =
      Boolean(params.origin.binding)
      && params.origin.binding?.targetKind !== "agent_thread"
      && (
        sourceConversationKind === "thread"
        || sourceConversationKind === "topic"
      );
    if (
      canAttachToCurrentUnboundConversation
      || canReplaceCurrentThreadOrTopicBinding
    ) {
      return { ok: true, placement: "current_conversation" };
    }

    return {
      ok: false,
      error: {
        code: "unsupported_operation",
        message:
          `${managedConversationUnavailableMessage(
            params.location.managedConversation,
          )} Pass placement=current_conversation only if replacing the current conversation binding is intended.`,
      },
    };
  }

  private async resolveAgentMessagingOrigin(
    context: PwrAgentMessagingRequest["context"],
  ): Promise<AgentMessagingOriginResolution> {
    if (context.requestingInstanceId && context.causalMessagingSource) {
      const source = this.accessControl.retainedRequestSource(context);
      if (!source || !this.isChannelInScope(source.event.channel)) return this.retainedSourceUnavailable(context, "not_found");
      if (!this.accessControl.retainedRequestCanCrossInstance(context, source) || !this.accessControl.retainedSourceHasPermissions(source)
        || !await this.accessControl.retainedSourceIsAuthorized(source)) return this.retainedSourceUnavailable(context);
      return { ok: true, origin: await this.originForRetainedSource(source) };
    }
    if (context.turnId) {
      const origin = this.activeAgentMessagingOriginsByTurnKey.get(
        agentMessagingTurnKey(context.backend, context.threadId, context.turnId),
      );
      if (
        !origin
        || !this.isChannelInScope(origin.binding?.channel ?? origin.event.channel)
      ) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message:
              "No active messaging origin is recorded for this Agent turn. For a delegated/completion request, use list_messaging_surfaces and attach_thread_to_surface to inspect and select its retained destination.",
          },
        };
      }
      return { ok: true, origin };
    }

    let navigation: MessagingThreadContext | undefined;
    try {
      navigation = { kind: "thread", thread: await this.readExactNavigationThread({
        ref: { backend: context.backend, threadId: context.threadId },
      }) };
    } catch {
      navigation = undefined;
    }

    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend: context.backend,
        threadId: context.threadId,
      }),
    ).filter((binding) =>
      isMessagingToolOriginBinding(binding, navigation)
    );
    if (bindings.length === 0) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message:
            "No active messaging binding is attached to this Agent or handoff thread.",
        },
      };
    }
    if (bindings.length > 1) {
      return {
        ok: false,
        error: {
          code: "ambiguous_location",
          message:
            "This Agent or handoff thread is attached to more than one messaging surface; call from an active messaging turn so PwrAgent can resolve here.",
        },
      };
    }
    const binding = bindings[0]!;
    return {
      ok: true,
      origin: {
        binding,
        event: eventFromBinding(binding, this.now()),
      },
    };
  }

  private async summarizeAgentMessagingLocation(
    origin: ActiveAgentMessagingOrigin,
    options: { navigation?: MessagingNavigationContext } = {},
  ): Promise<PwrAgentMessagingLocationSummary> {
    return {
      actor: summarizeMessagingActor(origin.event.actor),
      ...(origin.binding
        ? {
            binding: summarizeMessagingBinding(
              origin.binding,
              await this.resolveBoundThreadSummary(
                origin.binding,
                options.navigation,
              ),
            ),
          }
        : {}),
      channel: origin.event.channel.channel,
      conversation: summarizeMessagingConversation(origin.event.channel.conversation),
      conversationCapabilities: this.summarizeConversationCapabilities(origin),
      managedConversation: await this.resolveManagedConversationSummary(origin),
      outboundAttachments: this.summarizeOutboundAttachments(),
    };
  }

  private summarizeConversationCapabilities(
    origin: ActiveAgentMessagingOrigin,
  ): PwrAgentMessagingConversationCapabilitiesSummary {
    const permissions = this.accessControl.resolveActorPermissions(origin.event);
    return {
      rename: {
        allowed:
          permissions === null
          || permissions.permissions.has("thread.settings.name"),
        supported: this.adapter.supportsConversationTitle?.({
          actor: origin.event.actor,
          channel: origin.event.channel,
          routingState: origin.event.routingState ?? origin.binding?.routingState,
        }) === true,
      },
    };
  }

  private summarizeOutboundAttachments(): PwrAgentMessagingOutboundAttachmentSummary {
    const profile = this.capabilityProfile.outboundAttachments;
    return {
      ...(profile?.maxUploadBytes !== undefined
        ? { maxUploadBytes: profile.maxUploadBytes }
        : {}),
      supportsFileUpload: profile?.supportsFileUpload === true,
      supportsImageUpload: profile?.supportsImageUpload === true,
    };
  }

  private async readExactNavigationContext(request: Omit<NavigationSelectedDetailRequest, "protocol">) {
    if (!this.options.backend.getNavigationSelectedDetail) {
      throw new Error("Upgrade the owning instance to navigation query protocol 2 before using thread configuration.");
    }
    const detail = await this.options.backend.getNavigationSelectedDetail({ protocol: 2, ...request });
    if (detail.protocol !== 2 || detail.unchanged || detail.readiness !== "ready"
      || detail.ref.backend !== request.ref.backend || detail.ref.threadId !== request.ref.threadId
      || detail.ref.ownerInstanceId !== request.ref.ownerInstanceId) {
      throw new Error("The owning instance did not provide matching ready thread configuration.");
    }
    if (detail.identity !== "present") return { kind: "thread" as const };
    if (!detail.thread || detail.thread.id !== request.ref.threadId || detail.thread.source !== request.ref.backend) {
      throw new Error("Selected thread configuration belongs to a different identity.");
    }
    const federation = detail.thread.federation;
    if (federation && (federation.ref.backend !== request.ref.backend || federation.ref.threadId !== request.ref.threadId
      || (federation.ref.target.scope === "remote" ? federation.ref.target.instanceId : undefined) !== request.ref.ownerInstanceId)) {
      throw new Error("Selected thread configuration belongs to a different owner.");
    }
    if (!federation && request.ref.ownerInstanceId) {
      const target = { scope: "remote" as const, instanceId: request.ref.ownerInstanceId };
      detail.thread = { ...detail.thread, federation: { ref: { backend: request.ref.backend, threadId: request.ref.threadId, target }, instanceLabel: target.instanceId } };
    }
    return { kind: "thread" as const, thread: detail.thread, workspaceDirectories: detail.workspaceDirectories };
  }
  private async readExactNavigationThread(request: Omit<NavigationSelectedDetailRequest, "protocol">): Promise<NavigationThreadSummary | undefined> {
    return (await this.readExactNavigationContext(request)).thread;
  }

  private async readBoundWorkspaceContext(binding: MessagingBindingRecord): Promise<MessagingThreadContext> {
    const target = federationTargetForBinding(binding);
    const context = await this.readExactNavigationContext({ ref: { backend: binding.backend, threadId: binding.threadId,
      ...(target?.scope === "remote" ? { ownerInstanceId: target.instanceId } : {}) },
      federationTarget: target, includeWorkspaceConfiguration: true, probeWorkingStates: true });
    const linked = context.thread?.linkedDirectories.find((directory) => directory.kind === "local")
      ?? context.thread?.linkedDirectories[0];
    return { ...context, directory: context.workspaceDirectories?.find((directory) => directory.path === linked?.path) };
  }

  private async readBoundThreadConfiguration(binding: MessagingBindingRecord) {
    if (!this.options.backend.getNavigationLaunchpadConfig) {
      throw new Error("Upgrade the owning instance to navigation query protocol 2 before using thread configuration.");
    }
    const [thread, configuration] = await Promise.all([
      this.readBoundNavigationThread(binding),
      this.options.backend.getNavigationLaunchpadConfig({ protocol: 2, federationTarget: federationTargetForBinding(binding) }),
    ]);
    if (!thread || configuration.protocol !== 2 || configuration.unchanged || !configuration.defaults) {
      throw new Error("The owning instance did not provide ready thread configuration and defaults.");
    }
    return { kind: "thread" as const, thread, defaults: configuration.defaults };
  }

  private async readBoundNavigationThread(binding: MessagingBindingRecord, probeWorkingStates = false): Promise<NavigationThreadSummary | undefined> {
    const target = federationTargetForBinding(binding);
    return this.readExactNavigationThread({ ref: { backend: binding.backend, threadId: binding.threadId,
      ...(target?.scope === "remote" ? { ownerInstanceId: target.instanceId } : {}) },
      federationTarget: target, ...(probeWorkingStates ? { probeWorkingStates: true } : {}) });
  }

  private async resolveBoundThreadSummary(
    binding: MessagingBindingRecord,
    navigation?: MessagingNavigationContext,
  ): Promise<PwrAgentMessagingBoundThreadSummary | undefined> {
    const existingThread = navigation
      ? findThreadForBinding(navigation, binding)
      : undefined;
    if (existingThread) {
      return summarizeNavigationThreadForMessaging(existingThread);
    }
    try {
      const thread = await this.readBoundNavigationThread(binding);
      if (!thread) {
        return undefined;
      }
      return summarizeNavigationThreadForMessaging(thread);
    } catch (error) {
      this.logger.warn?.("failed to resolve messaging surface bound thread summary", {
        backend: binding.backend,
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
      return undefined;
    }
  }

  private async responseAttributionForBinding(
    binding: MessagingBindingRecord,
  ): Promise<{ label: string }> {
    return {
      label: responseAttributionLabel(
        binding,
        await this.resolveBoundThreadSummary(binding),
      ),
    };
  }

  private async resolveManagedConversationSummary(
    origin: ActiveAgentMessagingOrigin,
  ): Promise<PwrAgentMessagingManagedConversationSummary> {
    const providerSupportsCreation =
      typeof this.adapter.createManagedConversation === "function";
    if (!this.adapter.getManagedConversationRights) {
      const operation = {
        operation: "create_child" as const,
        supported: providerSupportsCreation,
        reason: providerSupportsCreation
          ? "provider does not expose permission preflight"
          : "provider does not support managed conversations",
      };
      return {
        canCreateChild: providerSupportsCreation,
        operation,
        operations: [operation],
        outcome: providerSupportsCreation ? "ok" : "unsupported",
        providerSupportsCreation,
      };
    }

    const rights = await this.adapter.getManagedConversationRights({
      actor: origin.event.actor,
      channel: origin.event.channel,
      routingState: origin.event.routingState,
      sourceSurface: origin.event.sourceSurface,
    });
    const operation = rights.operations.find(
      (candidate) => candidate.operation === "create_child",
    );
    return {
      canCreateChild: providerSupportsCreation && operation?.supported === true,
      operation,
      operations: rights.operations.map((candidate) => ({ ...candidate })),
      outcome: rights.outcome,
      errorMessage: rights.errorMessage,
      providerSupportsCreation,
      updatedAt: rights.updatedAt,
    };
  }

  private filterBindingsForChannel(
    bindings: MessagingBindingRecord[],
  ): MessagingBindingRecord[] {
    if (!this.options.channel) {
      return bindings;
    }
    return bindings.filter((binding) => binding.channel.channel === this.options.channel);
  }

  private isChannelInScope(channel: MessagingBindingRecord["channel"] | undefined): boolean {
    return !this.options.channel || channel?.channel === this.options.channel;
  }

  private withRoutingAudit(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): MessagingSurfaceIntent {
    const allowedActorIds = binding?.authorizedActorIds ?? (
      event ? [event.actor.platformUserId] : undefined
    );

    if (intent.audit || (!binding && !event)) {
      return allowedActorIds && !intent.allowedActorIds
        ? { ...intent, allowedActorIds }
        : intent;
    }

    const channel = binding?.channel ?? event?.channel;
    if (!channel) {
      return intent;
    }
    const targetRoutingState =
      event?.routingState ??
      (intent.kind === "activity" ? binding?.routingState : undefined);

    return {
      ...intent,
      audit: buildMessagingAuditContext({
        actor: event?.actor ?? {
          platformUserId: binding?.authorizedActorIds[0] ?? "unknown",
        },
        action: "intent.deliver",
        backend: binding?.backend,
        bindingId: binding?.id ?? intent.bindingId,
        channel,
        now: this.now(),
        threadId: binding?.threadId,
      }),
      ...(intent.targetSurface
        ? { targetSurface: intent.targetSurface }
        : targetRoutingState
          ? {
              targetSurface: {
                channel: channel.channel,
                id: event?.id ?? binding?.id ?? intent.id,
                state: targetRoutingState,
              },
            }
          : {}),
      ...(allowedActorIds ? { allowedActorIds } : {}),
    };
  }

  /**
   * `send_messaging_file` reads a workspace file and pushes its bytes to an
   * external platform. That is the one outbound delivery an operator needs to
   * be able to audit after the fact, so it gets a real row rather than the
   * timestamp bump ordinary replies write.
   */
  private recordOutboundFileActivity(params: {
    backend: AppServerBackendKind;
    binding: MessagingBindingRecord | undefined;
    event: MessagingInboundEvent;
    file: {
      filename: string;
      mediaKind: "document" | "image";
      mimeType: string;
      path: string;
      sizeBytes: number;
    };
    deliveredAt: number;
    private: boolean;
    threadId: ThreadIdentifier;
  }): void {
    try {
      const log = this.desktopActivityLog();
      if (!log) return;
      const conversation = params.event.channel.conversation;
      log.record({
        platform: params.event.channel.channel,
        kind: "outbound",
        backend: params.backend,
        threadId: params.threadId,
        bindingId: params.binding?.id,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: params.event.actor.platformUserId,
        actorDisplayName: params.event.actor.displayName,
        summary: `Sent ${params.file.filename}${
          params.private ? " privately" : ""
        } (${params.file.sizeBytes} bytes)`,
        createdAt: params.deliveredAt,
        payload: {
          tool: "send_messaging_file",
          filename: params.file.filename,
          mediaKind: params.file.mediaKind,
          mimeType: params.file.mimeType,
          sizeBytes: params.file.sizeBytes,
          sourcePath: params.file.path,
          private: params.private,
          conversationKind: conversation.kind,
        },
      });
    } catch {
      // Activity log is best-effort observability.
    }
  }

  /**
   * Authorize an agent dynamic-tool call against the RBAC actor who started the
   * turn. `owns: false` means this controller has no record of the turn (a
   * different platform's controller, or a desktop-operator turn) — the runtime
   * asks each controller and only the owner decides. When owned: legacy mode is
   * allow-all; otherwise gate on the tool's required permission and audit
   * denials. This is the second RBAC surface — the agent reaching BEYOND the
   * bound thread — distinct from the actor's direct command/button surface.
   *
   * Known window: turn origins live only in this in-memory map. If a
   * controller is torn down mid-turn (messaging stop / adapter restart), a
   * still-running turn it started loses its origin, every controller answers
   * `owns: false`, and the runtime treats the turn as desktop-originated
   * (unrestricted). Accepted for Phase 1: teardown also severs the actor's
   * channel back to that turn, and persisting origins would couple RBAC to
   * turn-lifecycle storage. Revisit if turns ever survive controller restarts.
   */
  checkDynamicToolPermission(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    turnId?: string;
    category: MessagingDynamicToolCategory;
    tool: string;
    arguments?: Record<string, unknown> | null;
  }, source?: MessagingRequestSource): { owns: boolean; allowed: boolean; permission?: string }{
    return this.accessControl.checkDynamicToolPermission(params, source);
  }

  private newIntentId(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }
}

export { isMessagingInteractivePendingRequest };

/**
 * Format a wall-clock timestamp as `HH:MM AM/PM` for messaging audit
 * messages. Mirrors the format the user sees in the desktop transcript.
 */
function formatTimeOfDay(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  const paddedMinutes = minutes < 10 ? `0${minutes}` : String(minutes);
  return `${displayHours}:${paddedMinutes} ${period}`;
}

function resolveMonitorStateOptions(
  monitor: MessagingMonitorState | undefined,
  action: MonitorCommandAction,
): MonitorStateOptions {
  const currentPinned = normalizeMonitorThreadLimit(
    monitor?.pinnedThreadLimit,
    MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT,
  );
  const currentIntervalMs = normalizeMonitorIntervalMs(
    monitor?.intervalMs,
    MESSAGING_MONITOR_INTERVAL_MS,
  );
  const currentRecent = normalizeMonitorThreadLimit(
    monitor?.recentThreadLimit,
    MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT,
  );
  const currentShowStatusLine = monitor?.showStatusLine === true;
  const currentShowSnippet = monitor?.showLastResponseSnippet === true;

  switch (action.kind) {
    case "cycle-pinned":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: nextMonitorThreadLimit(currentPinned),
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "cycle-recent":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: nextMonitorThreadLimit(currentRecent),
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "cycle-interval":
      return {
        intervalMs: nextMonitorIntervalMs(currentIntervalMs),
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "toggle-status-line":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: !currentShowStatusLine,
      };
    case "toggle-snippet":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: !currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-pinned":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: normalizeMonitorThreadLimit(action.count, currentPinned),
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-interval":
      return {
        intervalMs: normalizeMonitorIntervalMs(action.intervalMs, currentIntervalMs),
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-recent":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: normalizeMonitorThreadLimit(action.count, currentRecent),
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
    case "set-status-line":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: action.enabled,
      };
    case "set-snippet":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: action.enabled,
        showStatusLine: currentShowStatusLine,
      };
    case "refresh":
    case "start":
    case "stop":
    case "topics-adopt":
    case "topics-cleanup":
    case "topics-fanout":
      return {
        intervalMs: currentIntervalMs,
        pinnedThreadLimit: currentPinned,
        recentThreadLimit: currentRecent,
        showLastResponseSnippet: currentShowSnippet,
        showStatusLine: currentShowStatusLine,
      };
  }
}

function buildMonitorSubscriptionId(channel: MessagingChannelRef): string {
  return `monitor:${buildMessagingConversationKey(channel)}`;
}

function managedTopicRecordFromConversation(params: {
  actorIds: string[];
  channel: MessagingChannelKind;
  conversation: MessagingChannelRef["conversation"];
  now: number;
  routingState?: MessagingAdapterState;
  source: MessagingManagedTopicRecord["source"];
}): MessagingManagedTopicRecord {
  const supergroupId = params.conversation.parentId ?? params.conversation.id;
  const topicId = params.conversation.kind === "topic"
    ? params.conversation.id
    : "";
  return {
    id: `topic:${params.channel}:${supergroupId}:${topicId}`,
    authorizedActorIds: params.actorIds,
    channel: params.channel,
    conversation: params.conversation,
    createdAt: params.now,
    lastObservedAt: params.now,
    lifecycle: "open",
    routingState: params.routingState,
    source: params.source,
    supergroupId,
    title: params.conversation.title,
    topicId,
    updatedAt: params.now,
  };
}

function topicTitleForThread(thread: NavigationThreadSummary): string {
  const trimmed = thread.title.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : `${thread.source} thread`;
}

function formatManagedTopicRights(
  operations: readonly MessagingManagedConversationOperationSupport[],
): string[] {
  return operations.map((operation) => {
    const label =
      operation.operation === "create_child"
        ? "create"
        : operation.operation;
    if (operation.supported) {
      return `${label}: available`;
    }
    return `${label}: unavailable${operation.missingPermission ? ` (${operation.missingPermission})` : operation.reason ? ` (${operation.reason})` : ""}`;
  });
}

function formatTopicCleanupProposalBody(
  items: readonly MessagingTopicCleanupProposalItem[],
): string {
  if (items.length === 0) {
    return [
      "No known topics yet.",
      "",
      "Telegram bots cannot list every historical topic. Adopt topics from inside the topic first, then run cleanup again.",
    ].join("\n");
  }
  const grouped = {
    keep: items.filter((item) => item.action === "keep"),
    close: items.filter((item) => item.action === "close"),
    delete: items.filter((item) => item.action === "delete"),
  };
  return [
    "Dry run only. No topic will be closed or deleted until you approve one of the actions below.",
    "",
    `Keep: ${grouped.keep.length}`,
    ...grouped.keep.slice(0, 5).map((item) => `- ${item.title ?? item.id}: ${item.reason}`),
    `Close candidates: ${grouped.close.length}`,
    ...grouped.close.slice(0, 5).map((item) => `- ${item.title ?? item.id}: ${item.reason}`),
    `Delete candidates: ${grouped.delete.length}`,
    ...grouped.delete.slice(0, 5).map((item) => `- ${item.title ?? item.id}: ${item.reason}`),
  ].join("\n");
}

function validateHandoffRequest(
  request: HandoffThreadWorkspaceRequest,
  context: MessagingWorkspaceHandoffContext,
): { valid: true } | { valid: false; reason: string } {
  const expectedDirections: HandoffThreadWorkspaceRequest["direction"][] =
    context.workspaceKind === "local" ? ["local-to-worktree"] : ["worktree-to-local", "worktree-to-worktree"];
  if (
    request.backend !== context.backend ||
    request.threadId !== context.threadId ||
    (request.direction !== "to-project" && !expectedDirections.includes(request.direction)) ||
    request.repositoryPath !== context.repositoryPath ||
    request.sourcePath !== context.workingDirectoryPath
  ) {
    return {
      valid: false,
      reason: "That handoff prompt is stale. Use /status to refresh.",
    };
  }
  if (request.direction === "to-project") {
    return request.targetPath?.trim()
      ? { valid: true }
      : { valid: false, reason: "Choose a destination project before handoff." };
  }
  if (!context.branch) {
    return { valid: false, reason: "This workspace has no Git branch available for handoff." };
  }
  if (context.branch && request.sourceBranch !== context.branch) {
    return {
      valid: false,
      reason: "The thread branch changed. Use /status to refresh before handoff.",
    };
  }
  if (request.direction === "worktree-to-worktree") {
    return request.strategy === "new-branch" && !request.newBranchName?.trim()
      ? { valid: false, reason: "Choose the new branch name before handoff." }
      : { valid: true };
  }
  if (request.direction === "local-to-worktree") {
    if (request.strategy === "detached-changes") {
      return { valid: true };
    }
    if (request.strategy === "new-branch") {
      if (!request.newBranchName?.trim()) {
        return {
          valid: false,
          reason: "Choose the new branch name before handoff.",
        };
      }
      return { valid: true };
    }
    if (!request.leaveLocalBranch) {
      return {
        valid: false,
        reason: "Choose the branch to leave checked out in Local before handoff.",
      };
    }
    if (!context.leaveLocalBranches.includes(request.leaveLocalBranch)) {
      return {
        valid: false,
        reason: "That Local branch choice is no longer available. Use /status to refresh.",
      };
    }
  }
  return { valid: true };
}

function formatHandoffDirection(
  direction: HandoffThreadWorkspaceRequest["direction"],
): string {
  return direction === "to-project" ? "Move to Project"
    : direction === "local-to-worktree" ? "Local to new worktree"
      : direction === "worktree-to-worktree" ? "Worktree to new worktree" : "Worktree to Local";
}

function handoffSuccessText(result: HandoffThreadWorkspaceResponse): string {
  return [
    `Workspace handoff complete: ${formatHandoffDirection(result.direction)}.`,
    `Workspace: ${result.workMode === "worktree" ? "Worktree" : "Local"}`,
    `Target: ${result.targetPath}`,
    result.branch ? `Branch: ${result.branch}` : undefined,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function contextUsageSummaryFromValue(value: unknown): string | undefined {
  const explicitSummary = findStringField(value, "summary");
  if (explicitSummary) {
    return explicitSummary;
  }

  const usage = findTokenUsageRecord(value);
  if (!usage) {
    return undefined;
  }

  const cachedInputTokens = Math.max(
    0,
    readNumberField(usage, "cachedInputTokens", "cached_input_tokens") ?? 0,
  );
  const inputTokens = Math.max(
    0,
    readNumberField(usage, "inputTokens", "input_tokens") ?? 0,
  );
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = Math.max(
    0,
    readNumberField(usage, "outputTokens", "output_tokens") ?? 0,
  );
  const reasoningOutputTokens = Math.max(
    0,
    readNumberField(usage, "reasoningOutputTokens", "reasoning_output_tokens") ?? 0,
  );
  const outputLabel = reasoningOutputTokens > 0
    ? `${formatContextUsageNumber(outputTokens)} out (${formatContextUsageNumber(
        reasoningOutputTokens,
      )} reasoning)`
    : `${formatContextUsageNumber(outputTokens)} out`;

  return [
    `Latest request usage: ${formatContextUsageNumber(uncachedInputTokens)} uncached in`,
    `${formatContextUsageNumber(cachedInputTokens)} cached`,
    outputLabel,
  ].join(" · ");
}

function findTokenUsageRecord(value: unknown): Record<string, unknown> | undefined {
  const root = asPlainRecord(value);
  if (!root) {
    return undefined;
  }
  const container =
    asPlainRecord(root.tokenUsage) ??
    asPlainRecord(root.token_usage) ??
    root;
  const direct =
    asPlainRecord(container.last) ??
    asPlainRecord(container.last_token_usage) ??
    asPlainRecord(container.total) ??
    asPlainRecord(container.total_token_usage) ??
    container;
  if (
    readNumberField(direct, "inputTokens", "input_tokens") !== undefined ||
    readNumberField(direct, "cachedInputTokens", "cached_input_tokens") !== undefined ||
    readNumberField(direct, "outputTokens", "output_tokens") !== undefined ||
    readNumberField(
      direct,
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ) !== undefined
  ) {
    return direct;
  }
  for (const key of ["data", "payload", "info", "usage", "result"]) {
    const nested = findTokenUsageRecord(root[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function findStringField(value: unknown, key: string): string | undefined {
  const record = asPlainRecord(value);
  const direct = record?.[key];
  return typeof direct === "string" && direct.trim() ? direct.trim() : undefined;
}

function readNumberField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function formatContextUsageNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function assistantItemIdForBackendEvent(event: AgentEvent): string | undefined {
  if (
    event.notification.method !== "item/started"
    && event.notification.method !== "item/completed"
  ) {
    return undefined;
  }
  const item = (event.notification.params as {
    item?: { id?: unknown; itemId?: unknown; item_id?: unknown };
  }).item;
  for (const value of [item?.id, item?.itemId, item?.item_id]) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function selectAssistantImagesForCapability(
  images: readonly MessagingImagePart[],
  capabilityProfile: MessagingCapabilityProfile,
): MessagingImagePart[] {
  const attachments = capabilityProfile.outboundAttachments;
  if (!attachments) {
    return [];
  }
  const selected: MessagingImagePart[] = [];
  const seen = new Set<string>();
  for (const image of images) {
    if (seen.has(image.url)) {
      continue;
    }
    if (image.url.startsWith("data:image/")) {
      const sizeBytes = imageDataUrlSizeBytes(image.url);
      if (
        !attachments.supportsImageUpload
        || sizeBytes === undefined
        || sizeBytes > (attachments.maxUploadBytes ?? Infinity)
      ) {
        continue;
      }
    } else if (
      !attachments.supportsRemoteImageUrl
      || !/^https:\/\//iu.test(image.url)
    ) {
      continue;
    }
    seen.add(image.url);
    selected.push(image);
  }
  return selected;
}

function imageDataUrlSizeBytes(url: string): number | undefined {
  const payload = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/]+={0,2})$/iu.exec(url)?.[1];
  if (!payload) {
    return undefined;
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor(payload.length * 3 / 4) - padding;
}

function assistantImageDeliverySignature(images: readonly MessagingImagePart[]): string {
  return `images:${images.map((image) => image.sourceUrl ?? image.url).join("\0")}`;
}

function outboundImageClaimAliases(
  values: readonly (string | undefined)[],
): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    aliases.add(value);
    if (
      value.startsWith("data:")
      || /^https?:\/\//iu.test(value)
    ) {
      continue;
    }
    if (path.isAbsolute(value)) {
      aliases.add(pathToFileURL(value).toString());
    }
  }
  return [...aliases];
}

function automationTurnKey(params: {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
}): string {
  return `${params.backend}:${params.threadId}:${params.turnId}`;
}

function agentMessagingQueueKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
  queueEntryId: string,
): string {
  return `${backend}:${threadId}:${queueEntryId}`;
}

function privateReplySourceFromBinding(
  binding: MessagingBindingRecord,
): MessagingPrivateReplySource {
  return {
    authorizedActorIds: [...binding.authorizedActorIds],
    backend: binding.backend,
    channel: structuredClone(binding.channel),
    createdAt: binding.createdAt,
    displayName: binding.displayName,
    federatedThread: binding.federatedThread,
    id: binding.id,
    routingState: binding.routingState
      ? structuredClone(binding.routingState)
      : undefined,
    targetKind: binding.targetKind,
    threadId: binding.threadId,
    updatedAt: binding.updatedAt,
  };
}

function summarizeMessagingConversation(
  conversation: MessagingChannelRef["conversation"],
): PwrAgentMessagingLocationSummary["conversation"] {
  return {
    id: conversation.id,
    kind: conversation.kind,
    parentId: conversation.parentId,
    parentConversationId: conversation.parentConversationId,
    workspaceId: conversation.workspaceId,
    title: conversation.title,
    parentTitle: conversation.parentTitle,
    ancestorTitle: conversation.ancestorTitle,
  };
}

function summarizeMessagingActor(
  actor: MessagingInboundEvent["actor"],
): NonNullable<PwrAgentMessagingLocationSummary["actor"]> {
  return {
    platformUserId: actor.platformUserId,
    displayName: actor.displayName,
    username: actor.username,
    isBot: actor.isBot,
  };
}

function summarizeMessagingBinding(
  binding: MessagingBindingRecord,
  thread?: PwrAgentMessagingBoundThreadSummary,
): PwrAgentMessagingLocationSummary["binding"] {
  return {
    id: binding.id,
    backend: binding.backend,
    threadId: binding.threadId,
    targetKind: binding.targetKind ?? "thread",
    displayName: binding.displayName,
    ...(thread ? { thread } : {}),
  };
}

function isMessagingToolOriginBinding(
  binding: MessagingBindingRecord,
  navigation: MessagingNavigationContext | undefined,
): boolean {
  if (binding.backend === "codex" && navigation
    && findThreadForBinding(navigation, binding)?.agent) {
    return true;
  }
  if (binding.targetKind === "agent_thread") {
    return true;
  }
  if (binding.targetKind !== "thread" || !navigation) {
    return false;
  }
  return Boolean(findThreadForBinding(navigation, binding)?.handoffOrigin);
}

function isLiveMessagingToolOriginBinding(
  binding: MessagingBindingRecord,
  navigation: MessagingNavigationContext | undefined,
): boolean {
  return (
    // A live, admitted human turn carries its actor on every backend. The
    // persisted source was already captured at admission; dropping it here
    // makes ordinary Claude/ACP turns look like local operator turns.
    binding.targetKind === "thread"
    || isMessagingToolOriginBinding(binding, navigation)
  );
}

function summarizeNavigationThreadForMessaging(
  thread: NavigationThreadSummary,
): PwrAgentMessagingBoundThreadSummary {
  const gitBranch = thread.gitBranch ?? thread.observedGitBranch;
  return {
    title: thread.title,
    titleSource: thread.titleSource,
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.executionMode ? { executionMode: thread.executionMode } : {}),
    ...(thread.agent?.name ? { agentName: thread.agent.name } : {}),
  };
}

function responseAttributionLabel(
  binding: MessagingBindingRecord,
  thread: PwrAgentMessagingBoundThreadSummary | undefined,
): string {
  const targetKind = binding.targetKind ?? "thread";
  const identity = targetKind === "agent_thread"
    ? thread?.agentName
    : thread?.titleSource === "fallback"
      ? undefined
      : thread?.title;
  const normalized = identity?.replace(/\s+/g, " ").trim();
  if (normalized) {
    return targetKind === "agent_thread"
      ? `Agent: ${normalized}`
      : `Bound thread: ${normalized}`;
  }
  return targetKind === "agent_thread"
    ? "PwrAgent Agent"
    : "PwrAgent thread";
}

function eventFromBinding(
  binding: MessagingBindingRecord,
  now: number,
): MessagingInboundEvent {
  return {
    id: `agent-origin:${binding.id}`,
    kind: "lifecycle",
    lifecycle: "bound",
    actor: {
      platformUserId: binding.authorizedActorIds[0] ?? "unknown",
      displayName: binding.displayName,
    },
    channel: binding.channel,
    receivedAt: now,
    routingState: binding.routingState,
  };
}

function sanitizeMessagingChildTitle(title: string | undefined): string {
  const normalized = (title ?? "PwrAgent thread").replace(/\s+/g, " ").trim();
  return Array.from(normalized || "PwrAgent thread").slice(0, 100).join("");
}

function managedConversationUnavailableMessage(
  summary: PwrAgentMessagingManagedConversationSummary,
): string {
  if (!summary.providerSupportsCreation) {
    return "This messaging provider does not support creating native child conversations.";
  }
  const operation = summary.operation;
  if (operation?.missingPermission) {
    return `PwrAgent cannot create a native child conversation because the provider permission ${operation.missingPermission} is missing.`;
  }
  if (operation?.reason) {
    return `PwrAgent cannot create a native child conversation: ${operation.reason}.`;
  }
  if (summary.errorMessage) {
    return `PwrAgent cannot create a native child conversation: ${summary.errorMessage}.`;
  }
  return "PwrAgent cannot create a native child conversation in the current messaging location.";
}

/**
 * Stable id for an in-turn prose activity so the coalescing policy dedups
 * re-emitted events. Prefers the backend item id; falls back to a
 * turn-scoped signature of the text (distinct prose blocks differ, and verbatim
 * repeats are intentionally deduped).
 */
function proseActivityIdForBackendEvent(
  event: AgentEvent,
  turnId: string,
  text: string,
): string {
  if (event.notification.method === "item/completed") {
    const item = (event.notification.params as { item?: Record<string, unknown> })
      .item;
    const rawId =
      (typeof item?.id === "string" && item.id) ||
      (typeof item?.itemId === "string" && item.itemId) ||
      (typeof item?.item_id === "string" && item.item_id) ||
      undefined;
    if (rawId) {
      return `prose:${rawId}`;
    }
  }
  return `prose:${turnId}:${text.length}:${text.slice(0, 24)}`;
}

function shouldFlushToolUpdatesBeforeIntent(intent: MessagingSurfaceIntent): boolean {
  if (intent.kind === "activity" || intent.kind === "dismiss") {
    return false;
  }
  if (
    intent.kind === "message" &&
    intent.role === "system" &&
    intent.id.startsWith("tool-update")
  ) {
    return false;
  }
  return true;
}

function stripCodexGitActionDirectivesFromMessagingIntent(
  intent: MessagingSurfaceIntent,
): MessagingSurfaceIntent | undefined {
  if (intent.kind === "message" && intent.role === "assistant") {
    let changed = false;
    const parts = intent.parts.map((part) => {
      if (part.type !== "text") {
        return part;
      }
      const text = stripCodexGitActionDirectives(part.text);
      if (text === part.text) {
        return part;
      }
      changed = true;
      return { ...part, text };
    });
    if (!changed) {
      return intent;
    }
    const hasDeliverablePart = parts.some(
      (part) => part.type !== "text" || part.text.trim().length > 0,
    );
    return hasDeliverablePart ? { ...intent, parts } : undefined;
  }

  if (intent.kind === "stream_update" && intent.role === "assistant") {
    const text = stripCodexGitActionDirectives(intent.text);
    if (text === intent.text) {
      return intent;
    }
    if (text.trim().length === 0) {
      return undefined;
    }
    return {
      ...intent,
      delta: undefined,
      text,
    };
  }

  return intent;
}

function messagingEventFromAutomationSource(
  source: AutomationRunSourceMetadata,
): MessagingInboundTextEvent {
  return {
    id: source.eventId ?? source.sourceEventKey,
    kind: "text",
    actor: {
      platformUserId: source.actor.platformUserId,
      displayName: source.actor.displayName,
      username: source.actor.username,
      isBot: source.actor.isBot,
    },
    channel: {
      channel: source.conversation.channel,
      conversation: {
        id: source.conversation.conversationId,
        kind: source.conversation.conversationKind ?? "channel",
        isDirectMessage: source.conversation.isDirectMessage,
        parentId: source.conversation.parentId,
        title: source.conversation.title,
        parentTitle: source.conversation.parentTitle,
        ancestorTitle: source.conversation.ancestorTitle,
      },
    },
    receivedAt: source.receivedAt,
    routingState: source.routingState as MessagingAdapterState | undefined,
    text: source.message?.text ?? "",
  };
}

export function shouldConsumeDeliveryBudget(intent: MessagingSurfaceIntent): boolean {
  if (intent.kind === "stream_update" && !intent.stream.isFinal) {
    return false;
  }
  return intent.kind !== "activity";
}

export function messagingDeliveryPriority(
  intent: MessagingSurfaceIntent,
  context?: { userInitiated?: boolean },
): MessagingDeliveryPriority {
  switch (intent.kind) {
    case "approval":
      if (intent.decisions.length === 0) {
        return "routine_status";
      }
      return "critical_interactive";
    case "questionnaire":
    case "review":
      return "critical_interactive";
    case "stream_update":
      return intent.stream.isFinal ? "final_turn" : "stream_partial";
    case "working_card":
      return intent.card.isFinal ? "final_turn" : "tool_progress";
    case "message":
      if (intent.id.startsWith("assistant-resume-repost-important")) {
        return "user_command";
      }
      if (intent.id.startsWith("assistant-resume-repost")) {
        return "routine_status";
      }
      if (intent.role === "assistant") {
        return "final_turn";
      }
      if (intent.role === "system" && intent.id.startsWith("tool-update")) {
        return "tool_progress";
      }
      return "user_command";
    case "status":
      if (context?.userInitiated) {
        return "user_command";
      }
      if (intent.delivery?.mode === "present" && intent.delivery.pin === true) {
        return "user_command";
      }
      return "routine_status";
    case "activity":
    case "progress":
    case "dismiss":
      return "routine_status";
    case "thread_picker":
    case "project_picker":
    case "single_select":
    case "multi_select":
    case "confirmation":
    case "error":
      return "user_command";
  }
}

export function updateWorkingCardActivities(
  state: MessagingWorkingCardState,
  activities: readonly MessagingToolActivity[],
  maxVisibleTasks = 12,
): void {
  for (const activity of activities) {
    if (
      !state.activities.has(activity.id)
      && state.activities.size >= maxVisibleTasks
    ) {
      const oldestId = state.activities.keys().next().value;
      if (oldestId !== undefined) {
        state.activities.delete(oldestId);
        state.omittedTaskCount += 1;
      }
    }
    state.activities.set(activity.id, activity);
  }
}

export function rememberWorkingCardState(
  states: Map<string, MessagingWorkingCardState>,
  key: string,
  state: MessagingWorkingCardState,
  maxStates = MAX_TRACKED_TURN_PROSE,
): string[] {
  states.set(key, state);
  const evicted: string[] = [];
  while (states.size > maxStates) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
    evicted.push(oldest);
  }
  return evicted;
}

function isUserInitiatedDeliveryEvent(
  event: MessagingInboundEvent | undefined,
): boolean {
  return Boolean(
    event &&
      (event.kind === "callback" ||
        event.kind === "command" ||
        event.kind === "media" ||
        event.kind === "text"),
  );
}

function approvalBodyWithResponse(body: string, responseLabel: string): string {
  const blocks = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const preservedBlocks = blocks.filter((block, index) => {
    if (index === 0) {
      return false;
    }
    return !/^Reply with\b/i.test(block);
  });

  return [...preservedBlocks, `Response Received: ${responseLabel}`].join("\n\n");
}

function sleepUntil(
  retryAt: number,
  now: () => number,
): Promise<void> {
  const delayMs = Math.max(0, retryAt - now());
  if (delayMs === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isClaudeSessionGoneFailure(event: AgentEvent): boolean {
  if (event.backend !== "claude" || event.notification.method !== "turn/failed") {
    return false;
  }
  const turn = asPlainRecord(event.notification.params.turn);
  const error = asPlainRecord(turn?.error);
  return error?.recovery === "claudeSessionGone";
}

function assistantStreamKeysForBackendEvent(event: AgentEvent): string[] {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.threadId !== "string") {
    return [];
  }
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined;
  return [
    assistantStreamKey({
      backend: event.backend,
      threadId: params.threadId,
      turnId,
    }),
  ];
}

function assistantStreamFilterForBackendEvent(
  event: AgentEvent,
): { threadId: ThreadIdentifier; turnId?: string } | undefined {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.threadId !== "string") {
    return undefined;
  }
  return {
    threadId: params.threadId,
    turnId: typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined,
  };
}

function compactLogPreview(text: string, limit = 96): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
  return preview.replace(/["\\]/g, "\\$&");
}

function buildQueuedTurnNoticeBody(preview: string, canSteer: boolean, manualRetryRequired = false): string {
  const quotedPreview = truncateText(preview, 500)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  if (manualRetryRequired) return `${quotedPreview}\n\nThe message is still queued. Choose Retry to send it, or Cancel to discard it.`;
  const steeringSentence = canSteer
    ? " To submit it as a steering message, click Steer."
    : "";
  return `${quotedPreview}\n\nI got your message, but there is a turn in progress. I've queued it to be sent when the turn completes.${steeringSentence} You can cancel if you don't want this queued.`;
}

function isPermanentMessagingTargetFailure(result: MessagingDeliveryResult): boolean {
  return (
    result.outcome === "failed" &&
    Boolean(
      result.errorMessage?.match(
        /\bUnknown Channel\b|chat not found|message thread not found/i,
      ),
    )
  );
}

function shouldRetryArtifactInline(
  intent: MessagingArtifactMessageIntent,
  result: MessagingDeliveryResult,
): boolean {
  return (
    intent.artifactDelivery.mode === "attachment_summary" &&
    (result.outcome === "failed" || result.outcome === "unsupported")
  );
}

function isVisibleAssistantStreamDelivery(result: MessagingDeliveryResult): boolean {
  return (
    result.outcome === "presented" ||
    result.outcome === "presented_new" ||
    result.outcome === "updated" ||
    result.outcome === "pinned"
  );
}

function messagingSurfaceKey(surface: MessagingSurfaceRef): string {
  return `${surface.channel}\0${surface.id}`;
}

function shouldRecordOutboundActivity(
  intent: MessagingSurfaceIntent,
  result: MessagingDeliveryResult,
): boolean {
  if (
    result.outcome === "discarded" ||
    result.outcome === "failed" ||
    result.outcome === "unsupported" ||
    result.outcome === "dismissed"
  ) {
    return false;
  }
  if (intent.kind === "stream_update" && !intent.stream.isFinal) {
    return false;
  }
  return intent.kind !== "activity" && intent.kind !== "dismiss";
}

function assistantMessageDeliveryKeys(
  event: AgentEvent,
  binding: MessagingBindingRecord,
  text: string,
  identity?: AssistantMessageDeliveryIdentity,
): string[] {
  const contentKey = assistantMessageContentDeliveryKey(
    event,
    binding,
    text,
    identity,
  );
  const itemId = identity?.itemId ?? assistantItemIdForBackendEvent(event);
  if (!itemId) {
    return [contentKey];
  }
  // Backend item identity is authoritative and intentionally independent of
  // turn/text: replaying one item with changed metadata must never post it
  // again. Keep the content alias so a later turn/completed event, which may
  // omit the item id, is deduped against the same already-delivered message.
  return [
    [
      binding.id,
      event.backend,
      assistantMessageThreadId(event, identity),
      `item:${itemId}`,
    ].join("\0"),
    contentKey,
  ];
}

function assistantMessageContentDeliveryKey(
  event: AgentEvent,
  binding: MessagingBindingRecord,
  text: string,
  identity?: AssistantMessageDeliveryIdentity,
): string {
  const params = event.notification.params as {
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  const turnId =
    identity?.turnId
    ?? (typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : "");
  return [
    binding.id,
    event.backend,
    assistantMessageThreadId(event, identity),
    turnId,
    `text:${createHash("sha256").update(text).digest("base64url")}`,
  ].join("\0");
}

function assistantMessageThreadId(
  event: AgentEvent,
  identity?: AssistantMessageDeliveryIdentity,
): string {
  const params = event.notification.params as { threadId?: unknown };
  return identity?.threadId
    ?? (typeof params.threadId === "string" ? params.threadId : "");
}

function formatResumeRepostText(params: {
  createdAt?: number;
  now: number;
  text: string;
}): string {
  return [
    formatResumeRepostHeading(params.createdAt, params.now),
    params.text,
  ].join("\n\n");
}

function formatResumeRepostHeading(
  createdAt: number | undefined,
  now: number,
): string {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return "Last Bot Reply";
  }
  const relativeAge = formatRelativeAge(createdAt, now);
  const absoluteTime = formatAbsoluteDateTime(createdAt);
  return `Last Bot Reply (${relativeAge}, ${absoluteTime})`;
}

function formatRelativeAge(createdAt: number, now: number): string {
  const elapsedMs = Math.max(0, now - createdAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "just now";
  }
  if (elapsedMinutes < 60) {
    return formatAgeUnit(elapsedMinutes, "minute");
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return formatAgeUnit(elapsedHours, "hour");
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 14) {
    return formatAgeUnit(elapsedDays, "day");
  }

  return formatAgeUnit(Math.floor(elapsedDays / 7), "week");
}

function formatAgeUnit(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

function formatAbsoluteDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function skillSearchCwdsForThreadState(
  threadState: MessagingResolvedThreadState,
): string[] {
  return [
    threadState.worktreePath,
    threadState.directoryPath,
    ...(threadState.thread?.linkedDirectories ?? []).flatMap((directory) => [
      directory.worktreePath,
      directory.path,
    ]),
  ].filter((cwd, index, candidates): cwd is string =>
    Boolean(cwd) && candidates.indexOf(cwd) === index,
  );
}

function readStatusStopTurnValue(
  value: MessagingJsonValue | undefined,
  binding: MessagingBindingRecord,
): { turnId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const backend = value.backend;
  const threadId = value.threadId;
  const turnId = value.turnId;
  if (
    typeof backend !== "string" ||
    !isAppServerBackendKind(backend) ||
    backend !== binding.backend ||
    typeof threadId !== "string" ||
    threadId !== binding.threadId ||
    typeof turnId !== "string"
  ) {
    return undefined;
  }

  return {
    turnId,
  };
}

function questionnaireAnswerValue(
  answer: MessagingQuestionnaireAnswer | null | undefined,
): string[] {
  const value = answer?.value.trim();
  return value ? [value] : [];
}
