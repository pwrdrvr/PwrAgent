import { rememberBoundedMap } from "../../bounded-map";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  buildReviewBranchOptions,
  buildFederatedThreadRef,
  buildThreadIdentityKey,
  findPreferredReviewWorkspaceCwd,
  federatedThreadIdentityKey,
  isAcpBackendId,
  isAppServerBackendKind,
  isMessagingBindingTargetKind,
  normalizeRenamedTitleSource,
  parseCodexTurnErrorMessage,
  permissionForActionId,
  permissionForCommandVerb,
  permissionForDynamicTool,
  permissionsForThreadMutation,
  toolArgsTargetRemoteInstance,
  resolveNewThreadBackend,
  selectableNewThreadBackends,
  stripCodexGitActionDirectives,
} from "@pwragent/shared";
import type {
  AgentEvent,
  AppServerTurnInputItem,
  AppServerBackendKind,
  AppServerThreadPlanEntry,
  AppServerThreadReviewEntry,
  AppServerReviewTarget,
  ModelSettingsRecent,
  AutomationMessagingConversationSnapshot,
  AutomationRunSourceMetadata,
  AutomationRunOutputDecision,
  CodexEnvironmentSetupProgressEvent,
  CodexEnvironmentOption,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  BackendModelOption,
  BackendSummary,
  AppServerPendingRequestNotification,
  AppServerThreadMessageOrigin,
  AppServerToolRequestUserInputNotification,
  DesktopAuthorizedContact,
  DesktopMessagingFullAccessWarningGlobalPolicy,
  FederatedThreadRef,
  FederationTarget,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  LinkedDirectorySummary,
  LaunchpadWorkMode,
  MaterializedDirectoryLaunchpadThread,
  MessagingBindingTargetKind,
  MessagingDynamicToolCategory,
  MessagingPermissionId,
  MessagingToolUpdateMode,
  PwrAgentMessagingBoundThreadSummary,
  PwrAgentMessagingLocationSummary,
  PwrAgentMessagingManagedConversationSummary,
  PwrAgentMessagingOutboundAttachmentSummary,
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationSnapshot,
  NavigationThreadSummary,
  RbacResolution,
  ScheduledThreadAction,
  ThreadMessagingBindingTransition,
  ThreadExecutionMode,
  ThreadIdentifier,
  UpdateDirectoryLaunchpadRequest,
} from "@pwragent/shared";
import type { MessagingRbacPolicyProvider } from "../rbac-policy-service";
import type {
  MessagingBindingRecord,
  MessagingCallbackHandleRecord,
  MessagingBrowseSessionRecord,
  MessagingActiveTurnSummary,
  MessagingApprovalDecision,
  MessagingChannelKind,
  MessagingChannelRef,
  MessagingConfirmationIntent,
  MessagingDeliveryScope,
  MessagingDeliveryResult,
  MessagingDefaultAgentAssignmentRecord,
  MessagingDefaultAgentScope,
  MessagingInboundCallbackEvent,
  MessagingInboundCommandEvent,
  MessagingInboundChannelMetadataUpdate,
  MessagingInboundEvent,
  MessagingInboundMediaEvent,
  MessagingInboundTextEvent,
  MessagingImagePart,
  MessagingAdapterState,
  MessagingJsonValue,
  MessagingManagedConversationActionResult,
  MessagingManagedConversationOperationSupport,
  MessagingManagedTopicRecord,
  MessagingMonitorState,
  MessagingMonitorSubscriptionRecord,
  MessagingPendingIntentRecord,
  MessagingPrivateConversationResolveResult,
  MessagingPrivateReplySource,
  MessagingQuestionnaireAnswer,
  MessagingQuestionnaireIntent,
  MessagingReviewIntent,
  MessagingResponseMode,
  MessagingStreamUpdateIntent,
  MessagingSurfaceAction,
  MessagingSurfaceRef,
  MessagingSurfaceIntent,
  MessagingTopicCleanupProposalItem,
  MessagingTopicCleanupProposalRecord,
} from "@pwragent/messaging-interface";
import {
  applyActionCapabilityLimits,
  evictStaleStreamAnchors,
  MESSAGING_CALLBACK_HANDLE_TTL_MS,
  messagingQuestionnaireAnswerComplete,
  normalizeMessagingQuestionnaireIntent,
} from "@pwragent/messaging-interface";
import {
  buildHelpActions,
  formatMessagingCommandHelpBody,
  matchMessagingCommandVerb,
  MESSAGING_COMMAND_CATALOG,
  MESSAGING_HELP_ACTION_COMMANDS,
  MESSAGING_REVIEW_HELP_SPEC,
  paginateHelpCatalog,
} from "./messaging-command-catalog.js";
import {
  buildMonitorStatusIntent,
  MESSAGING_MONITOR_DEFAULT_PINNED_THREAD_LIMIT,
  MESSAGING_MONITOR_DEFAULT_RECENT_THREAD_LIMIT,
  MESSAGING_MONITOR_INTERVAL_MS,
  nextMonitorIntervalMs,
  nextMonitorThreadLimit,
  normalizeMonitorIntervalMs,
  normalizeMonitorThreadLimit,
  selectMonitorThreads,
} from "./messaging-monitor-card.js";
import { buildMessagingConversationKey } from "./messaging-store.js";
import {
  resolveMessagingOutboundFile,
  type MessagingOutboundFileAccess,
} from "./messaging-outbound-file.js";
import { resolveScratchProjectsRoots } from "../../app-server/scratch-projects.js";
import {
  defaultAgentBackendSupport,
  defaultAgentScopeForChannel,
  type MessagingDefaultAgentScopeKind,
} from "./messaging-default-agent.js";
import type { MessagingStoreLike } from "../../state/messaging-store-sqlite";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type {
  MessagingAdapter,
  MessagingBackendBridge,
  MessagingLastAssistantReply,
  MessagingThreadAdmissionState,
} from "./messaging-adapter.js";
import { MessagingFederatedThreadTargetError } from "./messaging-adapter.js";
import type { MessagingActivityLog } from "../messaging-activity-log.js";
import {
  buildActivityIntent,
  buildApprovalIntent,
  buildConfirmationIntent,
  buildErrorIntent,
  buildQuestionnaireIntent,
  buildStatusIntent,
  buildToolUpdateBatchMessageIntent,
  buildToolUpdateMessageIntent,
  buildWorkingCardIntent,
} from "./messaging-renderer.js";
import {
  artifactFromPlanEntry,
  artifactFromReviewEntry,
  buildArtifactDeliveryIntent,
  buildArtifactInlineFallbackIntent,
  planEntryFromUpdate,
  type MessagingArtifact,
  type MessagingArtifactMessageIntent,
} from "./messaging-artifact-renderer.js";
import {
  artifactFromMarkdownFileSelection,
  MessagingMarkdownFileAttachmentSelector,
} from "./messaging-markdown-file-attachment-selector.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import { getMainLogger } from "../../log.js";
import { PerKeyAsyncLock } from "../../util/per-key-async-lock.js";
import { DeterministicInteractionMapper } from "./deterministic-interaction-mapper.js";
import { actionsForIntent } from "./deterministic-interaction-mapper.js";
import {
  normalizeReviewOutputRecord,
  parseReviewCommand,
} from "../../../shared/review-command.js";
import type { MessagingInteractionMapper } from "./interaction-mapper.js";
import {
  buildResumeIntent,
  directoryForProjectSelection,
  isNewAgentThreadLaunchAction,
  isNewThreadLaunchAction,
  parseResumeCommandArgs,
  resumeBrowserPageSize,
  resumeReturnTargetForSession,
  selectProjectFromValue,
  selectThreadFromValue,
  shouldStartNewAgentThreadFromSession,
} from "./messaging-resume-browser.js";
import {
  buildBindingStatusIntent,
  buildNewThreadEnvironmentPickerIntent,
  buildStatusAcpRuntimeModePickerIntent,
  buildBranchPickerPage,
  buildHandoffBranchPickerIntent,
  buildHandoffConfirmationIntent,
  buildHandoffOverviewIntent,
  buildStatusModelPickerIntent,
  buildStatusPermissionsPickerIntent,
  buildStatusReasoningPickerIntent,
  buildStatusResponseModePickerIntent,
  buildStatusToolUpdateModePickerIntent,
  formatExecutionModeLabel,
  formatMessagingToolUpdateModeLabel,
  formatPermissionsActionDisplayLabel,
  formatPermissionsLineDisplayLabel,
  handoffRequestFromValue,
  messagingStreamingResponsesEnabled,
  messagingToolUpdateModeChoices,
  nextMessagingStreamingResponseMode,
  resolveMessagingResponseMode,
  resolveMessagingStreamingResponseMode,
  resolveMessagingToolUpdateMode,
  shouldShowStreamingControl,
  type MessagingWorkspaceHandoffContext,
} from "./messaging-status-card.js";
import {
  buildMessagingAcpRuntimeModeSummary,
  messagingAcpRuntimeValueLooksPrivileged,
} from "./messaging-acp-runtime.js";
import {
  buildSkillRemovedIntent,
  buildSkillSelectedIntent,
  buildSkillsBrowserIntent,
  buildSkillsSearchPromptIntent,
  flattenSkillEntries,
  formatSkillInputPrefix,
  isSkillSelectionNoticeIntent,
  isSkillsSearchIntent,
  isSkillsWorkflowIntent,
  skillSelectionFromValue,
  skillsBrowserPageFromValue,
} from "./messaging-skills-browser.js";
import {
  resolveMessagingThreadState,
  type MessagingResolvedThreadState,
} from "./messaging-thread-state.js";
import { summarizeToolActivityFromBackendEvent } from "./messaging-tool-activity.js";
import type { MessagingToolActivity } from "./messaging-tool-activity.js";
import {
  parseMessagingSchedule,
  resolveScheduledAction,
  scheduledActionDisplayId,
} from "./messaging-scheduled-actions.js";
import {
  MessagingToolUpdatePolicy,
  type MessagingToolUpdatePolicyDelivery,
} from "./messaging-tool-update-policy.js";
import {
  MessagingDeliveryBudget,
  type MessagingDeliveryPriority,
} from "./messaging-delivery-budget.js";
import { coalesceBackoffMs } from "./messaging-coalesce-backoff.js";
import {
  DEFAULT_MESSAGING_ATTACHMENT_POLICY,
  processMessagingAttachments,
  type MessagingAttachmentPolicy,
  type MessagingAttachmentRejection,
} from "./messaging-attachment-processor.js";
import {
  PdfAttachmentStore,
  type PendingPdfAttachment,
} from "../../pdf/pdf-attachment-store.js";
import {
  MessagingTurnAdmission,
  threadKeyForBinding,
  type MessagingQueuedTurnEntry,
  type MessagingTurnAdmissionBundle,
  type MessagingTurnInputEvent,
} from "./messaging-turn-admission.js";
import {
  renderAutomationDecisionForMessaging,
  renderAutomationOutputForMessaging,
} from "../../automations/automation-output-decision.js";
import {
  registerAutomationSourceMessageDeliveryHandler,
  registerAutomationTargetMessageDeliveryHandler,
} from "../../automations/automation-action-executor.js";
const DEFAULT_PENDING_INTENT_TTL_MS = MESSAGING_CALLBACK_HANDLE_TTL_MS;
const NEW_THREAD_PROMPT_CAPTURE_TTL_MS = MESSAGING_CALLBACK_HANDLE_TTL_MS;
const TYPING_ACTIVITY_LEASE_MS = 15_000;
const TYPING_ACTIVITY_REFRESH_MS = 10_000;
// Discrete item lifecycle events are cheap provider lease renewals, not
// visible message sends. Let them through a little sooner than noisy deltas.
const TYPING_ACTIVITY_CONTINUATION_REFRESH_MS = 9_000;
const DEFAULT_INPUT_DEBOUNCE_MS = 500;
// Upper bound on retained admission stage marks. A turn that is queued behind a
// busy thread, or that fails before `startTurn`, never reaches the log that
// consumes its marks, so the ceiling cannot depend on the happy path. Oldest
// entry is evicted first; each holds one fixed, bounded set of stage/subspan
// numbers.
const ADMISSION_STAGE_MARK_LIMIT = 256;

/**
 * Stage marks for one inbound message's trip from receipt to `startTurn`.
 *
 * `pwragentReceivedToStartTurnIssueMs` already measures that whole trip, which
 * is enough to see that it is slow and not enough to see where. A slow trip is
 * ambiguous between work this process chooses to do (resolving the route,
 * preparing the input, reading admission state, enforcing policy) and a wait it
 * merely schedules (the input debounce). These marks separate them, so one log
 * line says which stage owns the latency instead of requiring a bisect.
 *
 * Marks are keyed by inbound event id, not by the event object: the command and
 * media paths re-spread the event into a new object, so object identity does
 * not survive the trip and a `WeakMap` would silently record nothing.
 */
type MessagingAdmissionStage =
  | "handled"
  | "routed"
  | "bundleReady"
  | "inputPrepared"
  | "admissionStateResolved"
  | "queued"
  | "occupancyResolved"
  | "originBuilt"
  | "policyResolved";

type MessagingHandledToRoutedSubspan =
  | "handledAutomationInboundMs"
  | "handledBindingLookupMs"
  | "handledDefaultAgentAssignmentsMs"
  | "handledDefaultAgentBackendValidationMs"
  | "handledDefaultAgentRevocationsMs"
  | "handledDefaultAgentTargetValidationMs"
  | "handledPendingIntentReadMs"
  | "handledPendingNewThreadReadMs"
  | "handledPrivateContinuationExpirationMs"
  | "handledRemoteScopeMs"
  | "handledRequirePermissionMs"
  | "handledResponseModeMs"
  | "handledSharedMessagePolicyMs"
  | "handledTextParsingMs"
  | "finalAdmissionAppendAwaitMs";

type MessagingInputPreparationSpan =
  | "inputPrepPendingSkillBindingReloadMs"
  | "inputPrepPdfHandlingResolutionMs"
  | "inputPrepPdfAnalysisPolicyMs"
  | "inputPrepPdfToolSupportProbeMs"
  | "inputPrepPrivateResponseMs"
  | "inputPrepTextConstructionMs"
  | "inputPrepAttachmentProcessingMs";

type MessagingAdmissionTimingRecord = {
  marks: Partial<Record<MessagingAdmissionStage, number>>;
  subspans: Partial<Record<
    MessagingHandledToRoutedSubspan | MessagingInputPreparationSpan,
    number
  >>;
};
// Upper bound on retained automation start/final delivery-dedup keys. Each entry
// embeds the full rendered message text and is only consulted while a run's
// terminal events are in flight; oldest-first eviction reclaims keys for runs
// that completed long ago so a long-lived controller does not grow without
// bound (one entry per automation run).
const MAX_DELIVERED_AUTOMATION_KEYS = 1_000;
const MAX_TRACKED_REVIEW_TURNS = 1_000;
const MAX_TRACKED_TURN_PROSE = 256;
const MIN_NEAR_DUPLICATE_ASSISTANT_WORDS = 12;
const MIN_NEAR_DUPLICATE_ASSISTANT_LENGTH_RATIO = 0.7;
const MIN_NEAR_DUPLICATE_ASSISTANT_BIGRAM_OVERLAP = 0.8;
const MESSAGING_ENVIRONMENT_SETUP_PROGRESS_INTERVAL_MS = 15_000;

type MessagingTurnProseState = {
  latest?: { activityId: string; text: string };
  deliveredIds: Set<string>;
};

export type MessagingWorkingCardState = {
  activities: Map<string, MessagingToolActivity>;
  omittedTaskCount: number;
  sequence: number;
};
const DEFAULT_MESSAGING_AGENT_NAME = "Messaging Agent";
const DEFAULT_MESSAGING_AGENT_INSTRUCTIONS =
  "You are an Agent thread created from messaging. Keep shared context for the attached messaging surfaces and use available Agent tools when they are relevant.";
const PRIVATE_RESPONSE_FALLBACK_INSTRUCTION =
  "PwrAgent detected an explicit request for a private terminal response. "
  + "Do not include sensitive response content in commentary or working updates. "
  + "Use send_private_response if it is available. If that tool is unavailable, "
  + "put the intended private content only in your final answer; PwrAgent will "
  + "deliver that final privately and suppress it on the source surface.";
const PRIVATE_REPLY_CONTINUATION_TTL_MS = 24 * 60 * 60 * 1_000;
const PRIVATE_REPLY_COMPLETION_INSTRUCTION =
  "PwrAgent is completing a one-shot private reply requested by this Agent. "
  + "Treat the user's following message as the private response to your earlier request. "
  + "Your final answer will be delivered to the originating messaging surface, not this private thread. "
  + "Do not quote or expose private reply content there unless the initiating instructions explicitly require it. "
  + "Do not emit commentary, working updates, or partial answers containing the private reply. "
  + "If the private exchange is not complete, call send_private_response again with awaitReply and new replyInstructions; otherwise answer finally to complete the callback on the originating surface.";
const EXPLICIT_PRIVATE_RESPONSE_REQUEST_PATTERN = new RegExp(
  [
    "\\b(?:dm|direct[\\s-]+message|private[\\s-]+message)\\s+me\\b",
    "\\bsend\\s+me(?:\\s+\\S+){0,3}\\s+(?:dm|direct[\\s-]+message|private[\\s-]+message)\\b",
    "\\b(?:send|reply|respond)(?:\\s+\\S+){0,6}\\s+privately\\b",
    "\\bsend(?:\\s+\\S+){0,6}\\s+(?:only|just)\\s+to\\s+me\\b",
  ].join("|"),
  "i",
);
const NEGATED_PRIVATE_RESPONSE_PREFIX_PATTERN = new RegExp(
  [
    "\\b(?:(?:do\\s+not|don't|dont|never)(?:\\s+\\w+){0,8}(?:\\s+to)?",
    "|not(?:\\s+(?:asking|requesting|telling|wanting|going|trying|supposed|allowed|permitted|send|reply|respond|dm)){1,8}(?:\\s+to)?)\\s*$",
  ].join(""),
  "i",
);
const ACTIVE_TURN_HANDOFF_ERROR =
  "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.";

type PreparedInputStartResult = "failed" | "queued" | "started";
const messagingControllerLog = getMainLogger("pwragent:messaging");

type MonitorCommandAction =
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "refresh" }
  | { kind: "topics-adopt" }
  | { kind: "topics-cleanup" }
  | { kind: "topics-fanout" }
  | { kind: "cycle-interval" }
  | { kind: "cycle-pinned" }
  | { kind: "cycle-recent" }
  | { kind: "toggle-snippet" }
  | { kind: "toggle-status-line" }
  | { kind: "set-pinned"; count: number }
  | { kind: "set-interval"; intervalMs: number }
  | { kind: "set-recent"; count: number }
  | { kind: "set-snippet"; enabled: boolean }
  | { kind: "set-status-line"; enabled: boolean };

type MonitorStateOptions = Pick<
  MessagingMonitorState,
  | "intervalMs"
  | "pinnedThreadLimit"
  | "recentThreadLimit"
  | "showLastResponseSnippet"
  | "showStatusLine"
>;

type AssistantStreamDelta = {
  delta: string;
  itemId: string;
  streamKey: string;
  threadId: ThreadIdentifier;
  turnId: string;
};

type AssistantStreamBuffer = AssistantStreamDelta & {
  // Earliest time a non-final `stream_update` may be emitted for this message.
  // Deltas arriving before it are coalesced into `text`; see
  // {@link coalesceBackoffMs}. The final flush ignores this and emits at once.
  nextReleaseAt: number;
  // Count of non-final edits already emitted for this message, driving the
  // exponential backoff between successive coalesced releases.
  releaseCount: number;
  sequence: number;
  surface?: MessagingSurfaceRef;
  text: string;
};

type AssistantMessageDeliveryIdentity = {
  itemId?: string;
  threadId?: string;
  turnId?: string;
};

type AutomationTurnMessagingContext = {
  automationName?: string;
  automationRunId?: string;
};

type ActiveAgentMessagingOrigin = {
  binding?: MessagingBindingRecord;
  deliveryBinding?: MessagingBindingRecord;
  event: MessagingInboundEvent;
  privateReplyContinuationBindingId?: string;
  privateResponseRequested?: boolean;
};

type AgentMessagingOriginResolution =
  | { ok: true; origin: ActiveAgentMessagingOrigin }
  | Extract<PwrAgentMessagingResponse, { ok: false }>;

type AttachTargetResolution =
  | {
      ok: true;
      federatedThread?: FederatedThreadRef;
      navigation: NavigationSnapshot;
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

type ExecutionModeResolution = {
  mode: ThreadExecutionMode | undefined;
  source: "thread" | "binding-preferences" | "permissions-mode" | "unset";
};

function resolveExecutionModeForThread(
  binding: MessagingBindingRecord,
  thread: NavigationThreadSummary | undefined,
): ExecutionModeResolution {
  if (thread?.executionMode) {
    return { mode: thread.executionMode, source: "thread" };
  }
  if (binding.preferences?.executionMode) {
    return { mode: binding.preferences.executionMode, source: "binding-preferences" };
  }
  if (binding.preferences?.permissionsMode === "full-access") {
    return { mode: "full-access", source: "permissions-mode" };
  }
  if (binding.preferences?.permissionsMode === "default") {
    return { mode: "default", source: "permissions-mode" };
  }
  return { mode: undefined, source: "unset" };
}

function resolveExecutionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): ExecutionModeResolution {
  return resolveExecutionModeForThread(
    binding,
    findThreadForBinding(navigation, binding),
  );
}

function executionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): ThreadExecutionMode | undefined {
  return resolveExecutionModeForBinding(binding, navigation).mode;
}

function turnSettingsForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): {
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
} {
  const thread = findThreadForBinding(navigation, binding);
  return turnSettingsForThread(
    binding,
    thread,
    resolveExecutionModeForThread(binding, thread),
  );
}

function turnSettingsForThread(
  binding: MessagingBindingRecord,
  thread: NavigationThreadSummary | undefined,
  executionResolution: ExecutionModeResolution,
): {
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
} {
  return {
    executionMode: executionResolution.mode,
    fastMode: thread?.fastMode ?? binding.preferences?.fastMode,
    model: thread?.model ?? binding.preferences?.model,
    reasoningEffort: thread?.reasoningEffort ?? binding.preferences?.reasoningEffort,
    serviceTier: thread?.serviceTier ?? binding.preferences?.serviceTier,
  };
}

function findThreadForBinding(
  navigation: NavigationSnapshot | undefined,
  binding: MessagingBindingRecord,
): NavigationThreadSummary | undefined {
  return navigation?.threads.find(
    (thread) =>
      thread.source === binding.backend &&
      thread.id === binding.threadId &&
      federationRefsMatch(thread.federation?.ref, binding.federatedThread),
  );
}

function navigationSnapshotForAdmissionState(
  binding: MessagingBindingRecord,
  state: MessagingThreadAdmissionState,
): NavigationSnapshot {
  return {
    backend: binding.backend,
    directories: [],
    fetchedAt: Date.now(),
    inboxThreadKeys: [],
    launchpadDefaults: {
      backend: binding.backend,
      executionMode: "default",
    },
    threads: state.thread ? [state.thread] : [],
    unchanged: false,
  };
}

function federationRefsMatch(
  left: FederatedThreadRef | undefined,
  right: FederatedThreadRef | undefined,
): boolean {
  const leftTarget = left?.target ?? { scope: "local" as const };
  const rightTarget = right?.target ?? { scope: "local" as const };
  return leftTarget.scope === rightTarget.scope &&
    (leftTarget.scope === "local" ||
      (rightTarget.scope === "remote" &&
        leftTarget.instanceId === rightTarget.instanceId));
}

function federationTargetForBinding(
  binding: MessagingBindingRecord,
): FederationTarget | undefined {
  return binding.federatedThread?.target.scope === "remote"
    ? binding.federatedThread.target
    : undefined;
}

function bindingMatchesFederationTarget(
  binding: MessagingBindingRecord,
  target: FederationTarget | undefined,
): boolean {
  const bindingTarget = federationTargetForBinding(binding);
  if (!bindingTarget) {
    return !target || target.scope === "local";
  }
  return target?.scope === "remote" &&
    bindingTarget.scope === "remote" &&
    bindingTarget.instanceId === target.instanceId;
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

function formatAttachmentRejections(
  rejections: MessagingAttachmentRejection[],
): string {
  return rejections
    .map((rejection) => `${rejection.name}: ${rejection.reason}`)
    .join("\n");
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

type MessagingControllerLogger = {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
};

type MessagingToolUpdateDefaultModeResolver =
  | MessagingToolUpdateMode
  | ((
    targetKind: MessagingBindingTargetKind,
  ) => MessagingToolUpdateMode | Promise<MessagingToolUpdateMode>);

type MessagingFullAccessControls = {
  allowEscalation: boolean;
  allowThreadResume: boolean;
  warningPolicy: DesktopMessagingFullAccessWarningGlobalPolicy;
  authorizedUsers?: Partial<Record<MessagingChannelKind, DesktopAuthorizedContact[]>>;
  dismissWarning?: (params: {
    actorId: string;
    channel: MessagingChannelKind;
  }) => Promise<void>;
  canDismissWarning?: (params: {
    actorId: string;
    channel: MessagingChannelKind;
  }) => boolean | Promise<boolean>;
};

type MessagingFullAccessControlsResolverFn = () =>
  | MessagingFullAccessControls
  | undefined
  | Promise<MessagingFullAccessControls | undefined>;

type MessagingFullAccessControlsResolver =
  | MessagingFullAccessControls
  | MessagingFullAccessControlsResolverFn;

function normalizeMessagingFullAccessControls(
  resolved: MessagingFullAccessControls | undefined,
): MessagingFullAccessControls {
  return {
    allowEscalation: resolved?.allowEscalation ?? true,
    allowThreadResume: resolved?.allowThreadResume ?? true,
    warningPolicy: resolved?.warningPolicy ?? "dismissable",
    authorizedUsers: resolved?.authorizedUsers ?? {},
    dismissWarning: resolved?.dismissWarning,
    canDismissWarning: resolved?.canDismissWarning,
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === "function";
}

type FullAccessEscalationContext =
  | {
      backend: AppServerBackendKind;
      binding?: MessagingBindingRecord;
      kind: "thread";
      threadId: ThreadIdentifier;
    }
  | {
      kind: "new-thread";
      pendingPrompt?: boolean;
      session: MessagingBrowseSessionRecord;
    }
  | {
      backend: AppServerBackendKind;
      federatedThread?: FederatedThreadRef;
      kind: "resume-thread";
      session: MessagingBrowseSessionRecord;
      threadId: ThreadIdentifier;
    };

type FullAccessRiskWarningContext =
  | {
      bindingId: string;
      kind: "thread";
      threadId: ThreadIdentifier;
    }
  | {
      kind: "new-thread";
      pendingPrompt?: boolean;
      sessionId: string;
    }
  | {
      backend: AppServerBackendKind;
      federationInstanceId?: string;
      kind: "resume-thread";
      sessionId: string;
      threadId: ThreadIdentifier;
    };

type AcpRuntimeRiskWarningContext =
  | {
      kind: "new-thread";
      label: string;
      optionId: string;
      sessionId: string;
      source: BackendAcpRuntimeOptionSource;
      value: string;
    }
  | {
      bindingId: string;
      kind: "thread";
      label: string;
      optionId: string;
      source: BackendAcpRuntimeOptionSource;
      threadId: ThreadIdentifier;
      value: string;
    };

type FullAccessRiskPresentation = {
  binding?: MessagingBindingRecord;
  surface?: MessagingSurfaceRef;
};

type FullAccessWarningResolution = {
  canDismiss: boolean;
  policy: DesktopMessagingFullAccessWarningGlobalPolicy;
  shouldWarn: boolean;
};

type FullAccessRiskPresentationMode = "surface" | "message";

export type MessagingControllerDeliveryBudgetEvent = {
  at: number;
  backend?: AppServerBackendKind;
  bindingId?: string;
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

type QueuedTurnAction = {
  entryId: string;
  kind: "cancel" | "steer";
};

/**
 * Per-binding tracking of a posted "permissions queued" audit message so
 * we can edit it in place when the queue resolves (cancelled / applied).
 * One controller-side map keyed by `buildThreadIdentityKey` is enough —
 * only one queued mode change can exist per thread at a time, and the
 * registry's queueCleared notification is per-thread.
 */
type PendingQueueAuditMessage = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** ULID-shaped queueId from the registry, used for the cancel button action id. */
  queueId: string;
  fromExecutionMode: ThreadExecutionMode;
  toExecutionMode: ThreadExecutionMode;
  queuedAt: number;
  /** Surface refs for every binding we successfully posted to. */
  surfaces: Map<string, MessagingSurfaceRef>;
};

const PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX = "permissions:queue:cancel:";
const FULL_ACCESS_RISK_ACTION_PREFIX = "full-access-risk:";
const ACP_RUNTIME_RISK_ACTION_PREFIX = "acp-runtime-risk:";

type PendingNewThreadPromptWindow = {
  events: MessagingTurnInputEvent[];
  session: MessagingBrowseSessionRecord;
  timer?: ReturnType<typeof setTimeout>;
};

type PendingNewThreadPromptBundle = {
  events: MessagingTurnInputEvent[];
  session: MessagingBrowseSessionRecord;
};

type MessagingDeliveryGuard = {
  isCancelled: () => boolean;
  onCancelledDelivery?: (result: MessagingDeliveryResult) => Promise<void>;
  whenCancelled?: Promise<void>;
};

type MessagingCancellationSignal = MessagingDeliveryGuard & {
  cancel: () => void;
};

export type MessagingControllerOptions = {
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
  sleepUntil?: (retryAt: number, now: () => number) => Promise<void>;
  activityLog?: () => MessagingActivityLog;
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
};

export class MessagingController {
  private readonly authorizedActorIds: Set<string>;
  private readonly capabilityProfile: MessagingCapabilityProfile;
  private readonly statusRenderLock = new PerKeyAsyncLock();
  private readonly deliveredAssistantMessageKeys = new Set<string>();
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
  private readonly privateReplyCompletionTurnKeys = new Set<string>();
  private readonly terminalPrivateResponseTurnKeys = new Set<string>();
  private readonly privateResponseFallbackTurnKeys = new Set<string>();
  private readonly attemptedPrivateResponseFallbackTurnKeys = new Set<string>();
  private readonly queuedAgentMessagingOriginsByQueueKey = new Map<
    string,
    ActiveAgentMessagingOrigin
  >();
  private readonly pdfAttachmentStore = new PdfAttachmentStore();
  private readonly deliveredAutomationStartKeys = new Set<string>();
  private readonly deliveredAutomationFinalKeys = new Set<string>();
  private readonly now: () => number;
  private readonly admissionStageMarks = new Map<
    string,
    MessagingAdmissionTimingRecord
  >();
  private readonly pendingIntentTtlMs: number;
  private readonly interactionMapper: MessagingInteractionMapper;
  private readonly activeTurnsByThreadKey = new Map<string, MessagingActiveTurnSummary>();
  private readonly contextUsageSummariesByThreadKey = new Map<string, string>();
  private readonly planArtifactsByTurnKey = new Map<string, AppServerThreadPlanEntry>();
  // Codex emits a review result twice on the live protocol: first as an
  // exitedReviewMode artifact, then as the turn's final agentMessage. Hold the
  // pair by turn so messaging providers receive one enriched artifact intent.
  private readonly pendingReviewArtifactsByTurnKey = new Map<
    string,
    AppServerThreadReviewEntry
  >();
  private readonly pendingReviewAssistantTextByTurnKey = new Map<string, string>();
  private readonly completedReviewTurnKeys = new Set<string>();
  private readonly reviewTurnKeys = new Set<string>();
  private readonly markdownFileAttachmentSelector =
    new MessagingMarkdownFileAttachmentSelector();
  private readonly typingActivityLastSignaledAt = new Map<string, number>();
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
  private readonly completedTaskMonitorTurns = new Set<string>();
  private readonly turnAdmission: MessagingTurnAdmission;
  private readonly pendingNewThreadPrompts = new Map<string, PendingNewThreadPromptWindow>();
  private readonly pendingFullAccessNewThreadPrompts = new Map<
    string,
    PendingNewThreadPromptBundle
  >();
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

  constructor(private readonly options: MessagingControllerOptions) {
    this.authorizedActorIds = new Set(options.authorizedActorIds);
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
      now: this.now,
      onBundleReady: async (bundle) => {
        await this.handleAdmittedTurnBundle(bundle);
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
  ): Promise<PwrAgentMessagingResponse> {
    switch (request.operation) {
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
        return await this.sendMessagingFileFromAgentMessagingOrigin(request);
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
    await this.cleanupExpiredPrivateReplyContinuations();
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

  async handleInboundEvent(event: MessagingInboundEvent): Promise<void> {
    if (!this.authorizeInboundAdmission(event)) {
      // In enforcing mode this fires for actors with no permission-granting
      // role (default-deny); record it so operators can see who was inert.
      if (this.options.rbacPolicy?.isEnforcing()) {
        this.recordCapabilityDenied(event, "(admission)", [], "admission");
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
    this.markAdmissionStage(event, "handled");

    // Breadcrumb self-healing and managed-topic observation are optional UX
    // bookkeeping for turn input. Start them from this lifecycle boundary, but
    // never charge their SQLite reads/writes to accepted reply routing. Control
    // events retain ordering because commands such as `/monitor topics` can
    // intentionally promote an observed topic to owned state.
    if (event.kind === "text" || event.kind === "media") {
      void this.refreshInboundMetadata(event);
    } else {
      await this.refreshInboundMetadata(event);
    }

    if (event.kind === "command") {
      await this.handleCommand(event);
      return;
    }

    if (event.kind === "callback") {
      await this.handleCallback(event);
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
      const automationMatched = await this.measureHandledToRoutedSubspan(
        event,
        "handledAutomationInboundMs",
        async () => await this.options.automationInboundHandler?.(event) ?? false,
      );
      if (automationMatched) {
        return;
      }
    }

    if (event.kind === "media") {
      await this.handleMedia(event);
      return;
    }

    if (event.kind === "text") {
      await this.handleText(event);
    }
  }

  async handleInboundChannelMetadata(
    update: MessagingInboundChannelMetadataUpdate,
  ): Promise<void> {
    try {
      await this.refreshBindingChannelMetadata(
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

  async handleBackendEvent(event: AgentEvent): Promise<void> {
    const threadId = threadIdForBackendEvent(event);
    if (!threadId && event.notification.method === "account/updated") {
      await this.refreshStatusSurfacesForBackend(
        event.backend,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }
    if (!threadId && event.notification.method === "account/rateLimits/updated") {
      this.logger.debug?.("messaging skipped bound status refresh for backend rate limits", {
        backend: event.backend,
        method: event.notification.method,
      });
      return;
    }
    if (!threadId) {
      return;
    }
    if (event.notification.method === "item/transientMessage/updated") {
      // Transient transcript text is a local, replaceable desktop surface.
      // It is intentionally not translated into a messaging intent: remote
      // delivery would give it durable-message queueing, retry, and budget
      // semantics that it must never inherit.
      return;
    }
    const scheduledAction = scheduledActionForBackendEvent(event);
    if (
      scheduledAction?.origin === "messaging"
      && scheduledAction.status === "failed"
    ) {
      const bindings = this.filterBindingsForChannel(
        await this.options.store.findActiveBindingsForThread({
          backend: event.backend,
          threadId,
        }),
      ).filter((binding) =>
        bindingMatchesFederationTarget(binding, event.federationTarget)
        && bindingMatchesScheduledActionOrigin(binding, scheduledAction)
      );
      for (const binding of bindings) {
        await this.deliver(
          buildErrorIntent({
            id: this.newIntentId("scheduled-message-dispatch-failed"),
            createdAt: this.now(),
            title: "Scheduled message could not be sent",
            body: [
              scheduledAction.displayText,
              scheduledAction.errorMessage
                ?? "The backend rejected the scheduled message.",
            ].filter(Boolean).join("\n\n"),
            recoverable: true,
          }),
          binding,
        );
      }
      return;
    }
    const eventTurnId = turnIdForBackendEvent(event);
    const turnQueueUpdate = turnQueueUpdateForBackendEvent(event);
    if (turnQueueUpdate) {
      await this.reconcileQueuedAgentMessagingOrigin({
        backend: event.backend,
        threadId,
        update: turnQueueUpdate,
      });
    }
    const eventTurnKey = eventTurnId
      ? artifactTurnKey(event.backend, threadId, eventTurnId)
      : undefined;
    if (eventTurnKey && isReviewTurnMarkerEvent(event)) {
      rememberBoundedKey(
        this.reviewTurnKeys,
        eventTurnKey,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    const reviewTurnEvent = Boolean(
      eventTurnKey && this.reviewTurnKeys.has(eventTurnKey),
    );
    const reviewTurnCompleted = Boolean(
      eventTurnKey && this.completedReviewTurnKeys.has(eventTurnKey),
    );
    const reviewArtifact = reviewArtifactForBackendEvent(event, this.now());
    if (eventTurnKey && reviewArtifact && !reviewTurnCompleted) {
      rememberBoundedMap(
        this.pendingReviewArtifactsByTurnKey,
        eventTurnKey,
        reviewArtifact,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    const rawAssistantText = assistantTextForBackendEvent(event);
    const isFinalReviewAssistant = Boolean(
      eventTurnKey
      && reviewTurnEvent
      && rawAssistantText
      && !isNonFinalAssistantTextForBackendEvent(event)
      && !isTaskMonitorProgressEvent(event),
    );
    if (
      eventTurnKey
      && rawAssistantText
      && isFinalReviewAssistant
      && !reviewTurnCompleted
    ) {
      rememberBoundedMap(
        this.pendingReviewAssistantTextByTurnKey,
        eventTurnKey,
        rawAssistantText,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    const lifecycle = turnLifecycleForBackendEvent(event, this.now());
    const pendingReviewArtifact = eventTurnKey
      ? this.pendingReviewArtifactsByTurnKey.get(eventTurnKey)
      : undefined;
    const pendingReviewAssistantText = eventTurnKey
      ? this.pendingReviewAssistantTextByTurnKey.get(eventTurnKey)
      : undefined;
    const reviewCompletionReady = Boolean(
      eventTurnKey
      && reviewTurnEvent
      && lifecycle?.status === "completed",
    );
    const reviewCompletionDiscarded = Boolean(
      eventTurnKey
      && reviewTurnEvent
      && isTerminalTurnLifecycle(lifecycle)
      && lifecycle?.status !== "completed",
    );
    const completedReviewArtifact = !eventTurnKey
      ? reviewArtifact
      : reviewCompletionReady && pendingReviewArtifact
        ? {
            ...pendingReviewArtifact,
            ...(pendingReviewAssistantText
              ? { review: pendingReviewAssistantText }
              : {}),
          }
        : undefined;
    const standaloneReviewAssistantText =
      reviewCompletionReady && !pendingReviewArtifact
        ? pendingReviewAssistantText
        : undefined;
    if ((reviewCompletionReady || reviewCompletionDiscarded) && eventTurnKey) {
      this.pendingReviewArtifactsByTurnKey.delete(eventTurnKey);
      this.pendingReviewAssistantTextByTurnKey.delete(eventTurnKey);
      rememberBoundedKey(
        this.completedReviewTurnKeys,
        eventTurnKey,
        MAX_TRACKED_REVIEW_TURNS,
      );
    }
    if (completedReviewArtifact && pendingReviewAssistantText) {
      this.logger.debug?.(
        "messaging grouped review artifact with final assistant text",
        {
          backend: event.backend,
          method: event.notification.method,
          threadId,
          turnId: eventTurnId,
        },
      );
    }
    if (event.notification.method === "thread/archived") {
      await this.options.store.revokeDefaultAgentAssignmentsForTarget({
        backend: event.backend,
        threadId,
        revokedAt: this.now(),
      });
    }
    if (event.notification.method === "thread/tokenUsage/updated") {
      this.rememberContextUsageSummary(event);
      return;
    }
    if (event.notification.method === "serverRequest/resolved") {
      await this.handleBackendRequestResolved(event);
      return;
    }
    const queuedParams = readExecutionModeQueuedParams(event.notification);
    if (queuedParams) {
      await this.handleExecutionModeQueued(event.backend, queuedParams);
      await this.refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }
    const queueClearedParams = readExecutionModeQueueClearedParams(event.notification);
    if (queueClearedParams) {
      await this.handleExecutionModeQueueCleared(event.backend, queueClearedParams);
      await this.refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }
    if (
      event.notification.method === "thread/executionMode/updated" ||
      event.notification.method === "thread/modelSettings/updated" ||
      event.notification.method === "thread/rewound" ||
      event.notification.method === "thread/prAutoDispatch/updated" ||
      event.notification.method === "thread/prAutoDispatch/pendingUpdated" ||
      event.notification.method === "thread/codexEnvironment/updated" ||
      event.notification.method === "thread/parent/set" ||
      event.notification.method === "thread/parent/cleared" ||
      event.notification.method === "thread/subthreadOrder/updated" ||
      event.notification.method === "thread/subthreadsCollapsed/updated"
    ) {
      await this.refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
        event.federationTarget,
      );
      return;
    }

    const persistentBindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend: event.backend,
        threadId,
      }),
    ).filter((binding) =>
      bindingMatchesFederationTarget(binding, event.federationTarget)
    );
    const bindings = this.bindingsForAgentTurn(
      event.backend,
      threadId,
      eventTurnId,
      persistentBindings,
    );
    const reviewStartOutcome = reviewStartOutcomeForBackendEvent(event);
    if (reviewStartOutcome) {
      if (
        reviewStartOutcome.status === "failed"
        || reviewStartOutcome.status === "cancelled"
      ) {
        for (const binding of bindings) {
          await this.deliver(
            buildErrorIntent({
              id: this.newIntentId("queued-review-terminal"),
              createdAt: this.now(),
              title:
                reviewStartOutcome.status === "failed"
                  ? "Queued review could not start"
                  : "Queued review cancelled",
              body:
                reviewStartOutcome.error
                ?? (
                  reviewStartOutcome.status === "failed"
                    ? "The queued review failed to start."
                    : "The active turn did not complete successfully, so the queued review was cancelled."
                ),
              recoverable: reviewStartOutcome.status === "failed",
            }),
            binding,
          );
        }
      }
      return;
    }
    const automationRunUpdate = automationRunUpdateForBackendEvent(event);
    if (automationRunUpdate) {
      await this.handleAutomationRunUpdated({
        bindings,
        event,
        runId: automationRunUpdate.runId,
        finalText: automationRunUpdate.finalText,
        outputDecision: automationRunUpdate.outputDecision,
        status: automationRunUpdate.status,
        suppressBindingBroadcast: automationRunUpdate.suppressBindingBroadcast,
      });
      return;
    }
    if (turnQueueUpdate) {
      if (
        turnQueueUpdate.origin === "automation" &&
        turnQueueUpdate.status === "started" &&
        turnQueueUpdate.turnId
      ) {
        await this.handleAutomationTurnStarted({
          automationName: turnQueueUpdate.automationName,
          automationRunId: turnQueueUpdate.automationRunId,
          backend: event.backend,
          bindings,
          threadId,
          turnId: turnQueueUpdate.turnId,
          suppressBindingBroadcast: turnQueueUpdate.suppressBindingBroadcast,
        });
      }
      if (
        turnQueueUpdate.origin === "automation" &&
        turnQueueUpdate.status === "terminal" &&
        turnQueueUpdate.turnId
      ) {
        await this.handleAutomationTurnTerminal({
          automationRunId: turnQueueUpdate.automationRunId,
          backend: event.backend,
          bindings,
          event,
          finalText: turnQueueUpdate.finalText,
          threadId,
          turnId: turnQueueUpdate.turnId,
          suppressBindingBroadcast: turnQueueUpdate.suppressBindingBroadcast,
        });
      }
      return;
    }
    const planUpdate = planEntryForBackendEvent(event, this.now());
    if (planUpdate) {
      this.planArtifactsByTurnKey.set(
        artifactTurnKey(event.backend, threadId, planUpdate.turn?.id ?? planUpdate.id),
        planUpdate,
      );
    }
    const markdownFileArtifactSelection =
      this.markdownFileAttachmentSelector.selectFromBackendEvent(event);
    const completedPlan = lifecycle && isTerminalTurnLifecycle(lifecycle)
      ? this.planArtifactsByTurnKey.get(artifactTurnKey(event.backend, threadId, lifecycle.turnId))
      : undefined;
    for (const binding of bindings) {
      let activeTurn = this.getActiveTurn(binding);
      let turnStateChanged = false;
      const automationTurnEvent = this.isAutomationTurnEvent(
        event,
        binding,
        eventTurnId ?? lifecycle?.turnId ?? activeTurn?.turnId,
      );
      if (lifecycle && !automationTurnEvent) {
        const previousTurn = activeTurn;
        activeTurn = lifecycle;
        turnStateChanged = !isSameActiveTurnState(previousTurn, activeTurn);
        if (turnStateChanged) {
          this.setActiveTurn(binding, activeTurn);
          this.logBindingTurnStateChange(
            binding,
            previousTurn,
            activeTurn,
            event.notification.method,
          );
        }
      } else if (isThreadStatusIdleEvent(event) && activeTurn) {
        const previousTurn = activeTurn;
        activeTurn = {
          ...activeTurn,
          status: "completed",
          updatedAt: this.now(),
        };
        turnStateChanged = !isSameActiveTurnState(previousTurn, activeTurn);
        if (turnStateChanged) {
          this.setActiveTurn(binding, activeTurn);
          this.logBindingTurnStateChange(
            binding,
            previousTurn,
            activeTurn,
            event.notification.method,
          );
        }
      }

      const terminalPrivateResponse = this.isTerminalPrivateResponseTurn(
        event.backend,
        binding.threadId,
        eventTurnId ?? activeTurn?.turnId,
      );
      const privateResponseFallback = this.isPrivateResponseFallbackTurn(
        event.backend,
        binding.threadId,
        eventTurnId ?? activeTurn?.turnId,
      );
      const privateReplyCompletion = this.isPrivateReplyCompletionTurn(
        event.backend,
        binding.threadId,
        eventTurnId ?? activeTurn?.turnId,
      );
      const suppressSourceResponse =
        terminalPrivateResponse || privateResponseFallback;
      if (!suppressSourceResponse && !privateReplyCompletion) {
        await this.deliverToolActivityForBackendEvent(
          event,
          binding,
          activeTurn?.turnId,
        );
      }
      if (eventTurnId && isTaskMonitorCompletionEvent(event)) {
        // A monitor's terminal result wakes the parent agent, whose final
        // response is the one user-facing completion notification. Tombstone
        // the monitor turn before clearing its batch so a heartbeat already
        // released into budget/retry handling is also cancelled before a
        // pending or replayed adapter attempt.
        this.rememberCompletedTaskMonitorTurn(binding.id, eventTurnId);
        this.toolUpdatePolicy.flush({
          bindingId: binding.id,
          clear: true,
          turnId: eventTurnId,
        });
        await this.finalizeWorkingCard(binding, eventTurnId, "completed");
        this.clearTurnProse(binding.id, eventTurnId);
      }
      if (
        turnStateChanged &&
        (isTerminalTurnLifecycle(lifecycle) ||
          (isThreadStatusIdleEvent(event) && activeTurn))
      ) {
        const terminalTurnId = turnIdForBackendEvent(event) ?? activeTurn?.turnId;
        if (suppressSourceResponse && terminalTurnId) {
          this.toolUpdatePolicy.flush({
            bindingId: binding.id,
            clear: true,
            turnId: terminalTurnId,
          });
        } else {
          await this.flushToolUpdatesForBinding(binding, {
            clear: true,
            turnId: terminalTurnId,
          });
        }
        if (terminalTurnId) {
          await this.finalizeWorkingCard(
            binding,
            terminalTurnId,
            lifecycle?.status === "failed" || lifecycle?.status === "interrupted"
              ? "failed"
              : "completed",
          );
          this.clearTurnProse(binding.id, terminalTurnId);
          if (!privateResponseFallback) {
            const workingUpdateKey = this.turnProseKey(
              binding.id,
              terminalTurnId,
            );
            this.workingUpdateCancellationSignals.delete(workingUpdateKey);
            this.workingUpdateDeliveries.delete(workingUpdateKey);
            this.workingUpdateSurfaces.delete(workingUpdateKey);
            this.workingUpdateCancellationFailures.delete(workingUpdateKey);
          }
        }
      }

      const assistantDelta = assistantDeltaForBackendEvent(event);
      if (
        assistantDelta
        && !reviewTurnEvent
        && !terminalPrivateResponse
        && !privateReplyCompletion
      ) {
        if (!automationTurnEvent) {
          await this.deliverAssistantStreamUpdate(assistantDelta, binding, {
            bufferOnly: privateResponseFallback,
          });
        }
      }

      const assistantText = standaloneReviewAssistantText ?? (
        isFinalReviewAssistant ? undefined : rawAssistantText
      );
      if (
        assistantText
        && privateResponseFallback
        && !terminalPrivateResponse
        && !isNonFinalAssistantTextForBackendEvent(event)
      ) {
        const fallbackTurnId = eventTurnId ?? activeTurn?.turnId;
        if (fallbackTurnId) {
          await this.deliverPrivateResponseFallback({
            binding,
            event,
            text: assistantText,
            turnId: fallbackTurnId,
          });
        }
      } else if (
        privateResponseFallback
        && !terminalPrivateResponse
        && isTerminalTurnLifecycle(activeTurn)
        && !assistantDelta
      ) {
        await this.waitForAssistantStreamDeliveriesForEvent(event, binding);
        const bufferedText = this.takeBufferedAssistantTextForTerminalEvent(
          event,
          binding,
        );
        const fallbackTurnId = eventTurnId ?? activeTurn?.turnId;
        if (bufferedText && fallbackTurnId) {
          await this.deliverPrivateResponseFallback({
            binding,
            event,
            text: bufferedText,
            turnId: fallbackTurnId,
          });
        }
      } else if (
        assistantText
        && !suppressSourceResponse
        && (
          !privateReplyCompletion
          || !isNonFinalAssistantTextForBackendEvent(event)
        )
      ) {
        if (
          !isNonFinalAssistantTextForBackendEvent(event)
          && !isTaskMonitorProgressEvent(event)
        ) {
          // Claim the stable backend item before image resolution yields. A
          // nearly-simultaneous idle/terminal event may flush the same buffered
          // deltas while this lookup is in flight; both paths must contend for
          // one item identity before either can create a provider message.
          const assistantMessageClaimed = this.markAssistantMessageDelivered(
            event,
            binding,
            assistantText,
          );
          const assistantImages = await this.resolveAssistantMessageImages(
            assistantText,
            event,
            binding,
          );
          if (!assistantMessageClaimed) {
            await this.deliverAssistantImages(assistantImages, event, binding);
          } else {
            const deliveredFinalStream = await this.flushAssistantStreamForEvent(
              event,
              binding,
              assistantText,
            );
            if (deliveredFinalStream) {
              await this.deliverAssistantImages(
                assistantImages,
                event,
                binding,
                undefined,
                true,
              );
            } else {
              await this.deliverAssistantMessage(
                assistantText,
                event,
                binding,
                assistantImages,
                undefined,
                true,
              );
            }
          }
        } else if (!automationTurnEvent) {
          // NON-final agentMessage completions (e.g. Codex "commentary" phases
          // the agent emits while thinking) are the agent's in-turn prose. They
          // flow through the Working Updates dial: suppressed at None, coalesced
          // into batches at Less/Some/More, sent individually at All — the same
          // policy that governs tool activity. This replaces the old outright
          // drop that was added to stop the "pinged a dozen times" flood; the
          // coalescing preserves that anti-flood intent at low dial settings.
          await this.deliverAssistantProseForBackendEvent(
            event,
            binding,
            assistantText,
            activeTurn?.turnId,
          );
        }
      } else {
        if (
          !suppressSourceResponse &&
          isFinalAssistantImageResolutionEvent(event)
          && !reviewTurnEvent
          && !isTaskMonitorProgressEvent(event)
        ) {
          const assistantImages = await this.resolveAssistantMessageImages(
            "",
            event,
            binding,
          );
          await this.deliverAssistantImages(assistantImages, event, binding);
        }
        if (
          !suppressSourceResponse &&
          isTerminalTurnLifecycle(activeTurn)
          && !assistantDelta
          && !reviewTurnEvent
        ) {
          // Only flush buffered stream text on a genuine terminal event (e.g.
          // turn/completed, idle) — never on an assistant delta. Deltas are
          // mid-stream content owned by deliverAssistantStreamUpdate's buffer;
          // when the turn lifecycle is already terminal but the backend keeps
          // emitting deltas, letting each delta run the terminal flush re-posts
          // the (growing) buffer as a brand-new message every time — the
          // multi-message channel flood (and the budget starvation it caused).
          await this.waitForAssistantStreamDeliveriesForEvent(event, binding);
          await this.flushBufferedAssistantStreamsForTerminalEvent(event, binding);
        }
      }

      // Automation turns surface their own terminal output (incl. errors) via
      // handleAutomationTurnTerminal, so skip them here to avoid a double post.
      if (
        !suppressSourceResponse
        && !automationTurnEvent
        && activeTurn?.status === "failed"
      ) {
        const turnFailureText = errorTextForBackendEvent(event);
        if (turnFailureText) {
          await this.deliverTurnFailureMessage(turnFailureText, event, binding);
        }
      }

      if (completedPlan && !automationTurnEvent && !suppressSourceResponse) {
        await this.deliverArtifactForBinding({
          artifact: artifactFromPlanEntry(completedPlan),
          binding,
          intentId: `artifact:plan:${completedPlan.turn?.id ?? completedPlan.id}:${binding.id}`,
        });
      }

      if (
        completedReviewArtifact
        && !automationTurnEvent
        && !suppressSourceResponse
      ) {
        await this.deliverArtifactForBinding({
          artifact: artifactFromReviewEntry(completedReviewArtifact),
          binding,
          intentId: `artifact:review:${completedReviewArtifact.id}:${binding.id}`,
        });
      }

      if (
        markdownFileArtifactSelection
        && !automationTurnEvent
        && !suppressSourceResponse
      ) {
        await this.deliverArtifactForBinding({
          artifact: artifactFromMarkdownFileSelection(markdownFileArtifactSelection),
          binding,
          intentId: `artifact:markdown-file:${markdownFileArtifactSelection.path}:${binding.id}`,
        });
      }

      if (isThreadNameUpdatedEvent(event)) {
        await this.renderAutomaticBindingStatus(
          binding,
          undefined,
          await this.navigationSnapshotWithThreadNameFromEvent(event),
        );
        continue;
      }

      // A terminal private response owns the visible completion for this turn.
      // Backend work events may continue after the tool returns, but must not
      // re-arm provider typing/activity on either the source binding or the
      // newly-created private continuation. Terminal lifecycle still flows
      // through below so any existing activity lease is explicitly cleared.
      if (suppressSourceResponse && activeTurn?.status === "working") {
        continue;
      }

      if (turnStateChanged && (lifecycle || (isThreadStatusIdleEvent(event) && activeTurn))) {
        await this.signalTurnActivity(binding, activeTurn!, {
          reason: event.notification.method,
          force: true,
        });
        if (shouldRenderStatusForTurnStateChange(event, lifecycle)) {
          await this.renderAutomaticBindingStatus(binding);
        }
        await this.startNextQueuedTurn(binding);
      } else if (activeTurn?.status === "waiting" && isTurnWorkActivityEvent(event, activeTurn)) {
        const previousTurn = activeTurn;
        activeTurn = {
          ...activeTurn,
          status: "working",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        this.logBindingTurnStateChange(
          binding,
          previousTurn,
          activeTurn,
          event.notification.method,
        );
        await this.signalTurnActivity(binding, activeTurn, {
          reason: event.notification.method,
          force: true,
        });
      } else {
        const latestActiveTurn = this.getActiveTurn(binding);
        if (latestActiveTurn?.status !== "working") {
          continue;
        }
        if (eventTurnId && latestActiveTurn.turnId !== eventTurnId) {
          continue;
        }
        await this.signalTurnActivity(binding, latestActiveTurn, {
          reason: event.notification.method,
          refreshMs: typingActivityRefreshMsForBackendEvent(event),
        });
      }
    }
    if (lifecycle && isTerminalTurnLifecycle(lifecycle)) {
      const turnKey = agentMessagingTurnKey(
        event.backend,
        threadId,
        lifecycle.turnId,
      );
      const origin = this.activeAgentMessagingOriginsByTurnKey.get(turnKey);
      if (origin?.privateReplyContinuationBindingId) {
        await this.completePrivateReplyContinuation(
          origin.privateReplyContinuationBindingId,
        );
      }
      this.privateReplyCompletionTurnKeys.delete(turnKey);
      this.forgetAutomationTurn(event.backend, threadId, lifecycle.turnId);
      this.forgetAgentMessagingOrigin(event.backend, threadId, lifecycle.turnId);
      this.planArtifactsByTurnKey.delete(artifactTurnKey(event.backend, threadId, lifecycle.turnId));
    }
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
    const navigationByThreadKey = new Map<string, NavigationSnapshot>();
    for (const binding of renderableBindings) {
      try {
        const threadKey = threadKeyForBinding(binding);
        let navigation = navigationByThreadKey.get(threadKey);
        if (!navigation) {
          navigation = navigationSnapshotForAdmissionState(
            binding,
            await this.options.backend.getThreadAdmissionState({
              backend: binding.backend,
              federationTarget: federationTargetForBinding(binding),
              threadId: binding.threadId,
            }),
          );
          navigationByThreadKey.set(threadKey, navigation);
        }
        await this.renderBindingStatus(binding, undefined, navigation);
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

    for (const binding of bindings) {
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
          await this.reconcileIdleTurnAndStartNext(binding, "pending_request");
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
          await this.startNextQueuedTurn(binding);
          continue;
        }
        const threadStatus = await this.readBackendThreadStatus(binding);
        if (threadStatus === "idle") {
          await this.retireStalePendingIntent(deliveredPendingIntent);
          await this.reconcileIdleTurnAndStartNext(binding, "pending_request");
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
        await this.renderAutomaticBindingStatus(binding);
      }
    }
  }

  private async refreshInboundMetadata(event: MessagingInboundEvent): Promise<void> {
    const startedAt = this.now();
    let refreshBindingFromInboundMs = 0;
    let observeManagedTopicFromInboundMs = 0;
    try {
      const refreshStartedAt = this.now();
      await this.refreshBindingFromInbound(event);
      refreshBindingFromInboundMs = this.now() - refreshStartedAt;

      const observeStartedAt = this.now();
      await this.observeManagedTopicFromInbound(event);
      observeManagedTopicFromInboundMs = this.now() - observeStartedAt;
    } catch (error) {
      this.logger.debug?.("messaging inbound metadata refresh failed", {
        eventId: event.id,
        platform: event.channel.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.logger.debug?.("messaging off-path inbound metadata timing", {
        eventId: event.id,
        platform: event.channel.channel,
        refreshBindingFromInboundMs,
        observeManagedTopicFromInboundMs,
        totalMs: this.now() - startedAt,
      });
    }
  }

  /**
   * Self-heal stored bindings from the freshest data on every inbound.
   * The adapter populates `parentTitle` / `ancestorTitle` (supergroup
   * / server / channel breadcrumbs) on every inbound channel ref;
   * legacy bindings stored before those fields existed don't have
   * them. Merge in any new fields the binding doesn't already have so
   * the navigation snapshot's binding chip can render full
   * breadcrumbs without waiting for an explicit unbind/rebind.
   */
  private async refreshBindingFromInbound(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.refreshBindingChannelMetadata(
      event.channel,
      event.routingState,
      event.receivedAt,
    );
  }

  private async refreshBindingChannelMetadata(
    channel: MessagingChannelRef,
    routingStateUpdate?: MessagingAdapterState,
    observedAt = this.now(),
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(
      channel,
    );
    if (!binding) return;
    const incoming = channel.conversation;
    // Incoming wins when present. Adapters fetch fresher metadata
    // than we stored at bind time:
    //   - Discord publishes channel/parent/guild names through the
    //     post-dispatch metadata hook after bounded-LRU REST enrichment,
    //     so a server or channel rename reaches us without delaying admission.
    //   - Telegram caches forum-topic names from `forum_topic_created`
    //     and `forum_topic_edited` service messages, so renames done
    //     in the Telegram client propagate to subsequent inbound
    //     messages.
    // When `incoming` doesn't carry a field (e.g. a regular Telegram
    // topic message that doesn't ship the topic name and the cache
    // missed), the store merge keeps the current value so we never
    // lose data we already have. The read/compare/write is one store
    // transaction: this off-path task cannot restore a binding that
    // routing revoked or overwrite a newer preference update.
    //
    // Loop safety: the store's `changed` guard means an inbound
    // whose values match what's stored produces no write and no
    // broadcast — so the gateway echo of our own `editForumTopic`
    // call (which carries the same name we just wrote in
    // `syncConversationName`) is a no-op, not a refresh storm.
    const managedTopic =
      incoming.kind === "topic" && incoming.parentId
        ? await this.options.store.findManagedTopicByConversation({
            channel: channel.channel,
            supergroupId: incoming.parentId,
            topicId: incoming.id,
          })
        : undefined;
    const managedConversation = managedTopic?.conversation;
    const merged = await this.options.store.mergeBindingChannelMetadata({
      ancestorTitle: incoming.ancestorTitle ?? managedConversation?.ancestorTitle,
      bindingId: binding.id,
      // Root-conversation fallback lookup can resolve a DM/channel binding
      // from a thread-shaped Agent Session event. Preserve the binding's
      // identity key while applying the fresher metadata from that event.
      channel: binding.channel,
      observedAt,
      parentTitle: incoming.parentTitle ?? managedConversation?.parentTitle,
      routingState: routingStateUpdate,
      title: incoming.title ?? managedConversation?.title,
    });
    if (!merged?.changed) return;
    // The chip now has fresher breadcrumbs in the store; nudge the
    // renderer to refetch so the tooltip / label reflect them.
    this.notifyBindingChanged("refresh-from-inbound");
  }

  private async handleCommand(
    event: MessagingInboundCommandEvent,
    options?: {
      targetSurface?: MessagingSurfaceRef;
    },
  ): Promise<void> {
    const verb = matchMessagingCommandVerb(event.command);
    // RBAC: gate the verb before dispatching. `help` and unknown commands are
    // ungated (they only surface the command list). `permissionForCommandVerb`
    // is the same lookup the render-time button filter uses, so they can't drift.
    // This stays ABOVE every verb branch so a newly added command cannot slip
    // in below the gate.
    if (verb) {
      const permission = permissionForCommandVerb(verb);
      if (
        permission &&
        !(await this.requirePermission(event, permission, `command:${verb}`))
      ) {
        return;
      }
      // Scope gate: a command against a conversation already bound to a peer's
      // thread drives that peer. Exempt: `resume`/`agent` only open the picker
      // (which filters, and the bind is gated at bind time), and `detach` is a
      // local unbind that must stay available or a scope-revoked actor is
      // stranded in a conversation they can neither use nor leave.
      if (
        verb !== "resume" &&
        verb !== "agent" &&
        verb !== "detach" &&
        !(await this.requireRemoteScopeForBinding(
          event,
          await this.options.store.findActiveBindingForChannel(event.channel),
          `command:${verb}:remote-instance`,
        ))
      ) {
        return;
      }
    }
    if (verb === "schedule") {
      await this.handleScheduleCommand(event);
      return;
    }
    if (verb === "scheduled") {
      await this.handleScheduledCommand(event);
      return;
    }
    if (verb === "status") {
      await this.presentStatus(event);
      return;
    }
    if (verb === "detach") {
      await this.detachBinding(event);
      return;
    }
    if (verb === "monitor") {
      await this.handleMonitorCommand(event);
      return;
    }
    if (verb === "resume") {
      await this.presentResumeBrowser(event, {
        cancelDestination: options?.targetSurface ? "help" : undefined,
        targetSurface: options?.targetSurface,
      });
      return;
    }
    if (verb === "agent") {
      if (event.args[0]?.toLowerCase() === "default") {
        await this.handleDefaultAgentCommand(event);
        return;
      }
      await this.presentAgentBrowser(event, {
        cancelDestination: options?.targetSurface ? "help" : undefined,
        targetSurface: options?.targetSurface,
      });
      return;
    }
    if (verb === "new") {
      await this.presentResumeBrowser(
        {
          ...event,
          command: "resume",
          args: ["--new", ...event.args],
          rawText: ["/resume", "--new", ...event.args].join(" "),
        },
        {
          cancelDestination: options?.targetSurface ? "help" : undefined,
          targetSurface: options?.targetSurface,
        },
      );
      return;
    }
    if (verb === "help") {
      await this.presentHelp(event, {
        targetSurface: options?.targetSurface,
      });
      return;
    }
    if (
      event.command.trim().replace(/^\/+/, "").toLowerCase()
        === "review"
    ) {
      await this.handleReviewCommand(event);
      return;
    }
    await this.routeUnknownCommandToBoundThread(event);
  }

  private async handleScheduleCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    if (!this.options.backend.createScheduledThreadAction) {
      await this.deliverScheduledActionError(
        binding,
        event,
        "Scheduled messages are unavailable.",
      );
      return;
    }
    const parsed = parseMessagingSchedule(event.args, this.now());
    if (!parsed.ok) {
      await this.deliverScheduledActionError(binding, event, parsed.error);
      return;
    }
    const response = await this.options.backend.createScheduledThreadAction({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      kind: "turn",
      origin: "messaging",
      scheduledFor: parsed.scheduledFor,
      displayText: parsed.text,
      turn: {
        input: [{ type: "text", text: parsed.text }],
        messageOrigin: messageOriginForInboundEvent(event),
      },
    });
    const failureMessage = scheduledActionFailureMessage(response.action);
    if (failureMessage) {
      await this.deliverScheduledActionError(binding, event, failureMessage);
      return;
    }
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("scheduled-message-created"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Message scheduled",
        body: [
          `ID: ${scheduledActionDisplayId(response.action.id)}`,
          `Sends: ${new Date(response.action.scheduledFor).toISOString()}`,
          "",
          response.action.displayText,
        ].join("\n"),
      }),
      binding,
      event,
    );
  }

  private async handleScheduledCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    const list = this.options.backend.listScheduledThreadActions?.bind(
      this.options.backend,
    );
    if (!list) {
      await this.deliverScheduledActionError(
        binding,
        event,
        "Scheduled messages are unavailable.",
      );
      return;
    }
    const response = await list({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
    });
    const [operation, candidateId, ...remaining] = event.args;
    if (!operation) {
      const body = response.actions.length > 0
        ? response.actions.map((action) => [
            `${scheduledActionDisplayId(action.id)} · ${action.status} · ${new Date(action.scheduledFor).toISOString()}`,
            action.displayText,
          ].join("\n")).join("\n\n")
        : "No scheduled messages are waiting for this thread.";
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("scheduled-message-list"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Scheduled messages",
          body: [
            body,
            "",
            "Manage with /scheduled send <id>, /scheduled cancel <id>, or /scheduled edit <id> <time> <message>.",
          ].join("\n"),
        }),
        binding,
        event,
      );
      return;
    }
    const resolved = resolveScheduledAction(response.actions, candidateId);
    if (!resolved.ok) {
      await this.deliverScheduledActionError(binding, event, resolved.error);
      return;
    }
    try {
      if (operation === "send" || operation === "now") {
        if (!this.options.backend.sendScheduledThreadActionNow) {
          throw new Error("Sending scheduled messages now is unavailable.");
        }
        const mutation = await this.options.backend.sendScheduledThreadActionNow({
          federationTarget: federationTargetForBinding(binding),
          id: resolved.action.id,
        });
        const failureMessage = scheduledActionFailureMessage(mutation.action);
        if (failureMessage) throw new Error(failureMessage);
      } else if (operation === "cancel" || operation === "remove") {
        if (!this.options.backend.cancelScheduledThreadAction) {
          throw new Error("Cancelling scheduled messages is unavailable.");
        }
        await this.options.backend.cancelScheduledThreadAction({
          federationTarget: federationTargetForBinding(binding),
          id: resolved.action.id,
        });
      } else if (operation === "edit") {
        if (
          resolved.action.kind !== "turn"
          || !this.options.backend.updateScheduledThreadAction
        ) {
          throw new Error("That scheduled action cannot be edited here.");
        }
        const parsed = parseMessagingSchedule(remaining, this.now());
        if (!parsed.ok) throw new Error(parsed.error);
        const mutation = await this.options.backend.updateScheduledThreadAction({
          federationTarget: federationTargetForBinding(binding),
          id: resolved.action.id,
          scheduledFor: parsed.scheduledFor,
          displayText: parsed.text,
          turn: {
            ...resolved.action.turn,
            input: [{ type: "text", text: parsed.text }],
            messageOrigin:
              resolved.action.turn?.messageOrigin
              ?? messageOriginForInboundEvent(event),
          },
        });
        const failureMessage = scheduledActionFailureMessage(mutation.action);
        if (failureMessage) throw new Error(failureMessage);
      } else {
        throw new Error(
          "Use /scheduled, /scheduled send <id>, /scheduled cancel <id>, or /scheduled edit <id> <time> <message>.",
        );
      }
    } catch (error) {
      await this.deliverScheduledActionError(
        binding,
        event,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("scheduled-message-updated"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title:
          operation === "edit"
            ? "Scheduled message updated"
            : operation === "cancel" || operation === "remove"
              ? "Scheduled message cancelled"
              : "Scheduled message sent",
        body: resolved.action.displayText,
      }),
      binding,
      event,
    );
  }

  private async deliverScheduledActionError(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    message: string,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("scheduled-message-error"),
        createdAt: this.now(),
        title: "Scheduled message error",
        body: message,
        recoverable: true,
      }),
      binding,
      event,
    );
  }

  private async routeUnknownCommandToBoundThread(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    if (
      binding.targetKind === "agent_thread" &&
      !await this.shouldHandleAmbientSharedMessage(
        {
          ...event,
          kind: "text",
          text: event.rawText,
        },
        binding,
      )
    ) {
      return;
    }
    const text = `/${[event.command.replace(/^\/+/, ""), ...event.args]
      .filter(Boolean)
      .join(" ")}`;
    await this.admitTurnInput({
      binding,
      event: {
        ...event,
        kind: "text",
        text,
      },
    });
  }

  private async presentThreadCommandNeedsBinding(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("thread-command-needs-binding"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Choose a thread",
        body: "Bind this conversation to a PwrAgent thread before sending thread commands.",
        fallbackText: "Reply /resume to choose a thread.",
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
  }

  private async handleReviewCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.presentThreadCommandNeedsBinding(event);
      return;
    }
    if (!await this.reviewSupportedForBinding(binding)) {
      await this.deliverReviewUnsupported(binding, event);
      return;
    }

    if (event.args.length > 0) {
      const parsed = parseReviewCommand(
        `/${["review", ...event.args].join(" ")}`,
      );
      if (!parsed) {
        await this.deliver(
          buildErrorIntent({
            id: this.newIntentId("invalid-review-command"),
            createdAt: this.now(),
            title: "Invalid review command",
            body:
              "Use /review, /review <base branch>, /review --commit <sha>, or /review --custom <instructions>.",
            recoverable: true,
          }),
          binding,
          event,
        );
        return;
      }
      await this.submitMessagingReview({
        binding,
        event,
        target: parsed.target,
      });
      return;
    }

    await this.presentReviewPicker(binding, event);
  }

  private async presentReviewPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    // findPreferredReviewWorkspaceCwd and buildReviewBranchOptions below read
    // thread.gitWorkingState to choose a workspace and infer a base branch, so
    // this picker cannot race the background refresh.
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: binding.backend,
      probeWorkingStates: true,
    });
    const thread = findThreadForBinding(navigation, binding);
    const workspaces = (thread?.linkedDirectories ?? [])
      .map((directory) => ({
        cwd: directory.worktreePath ?? directory.path,
        label: directory.label,
        repositoryPath: directory.path,
      }))
      .filter(
        (workspace): workspace is {
          cwd: string;
          label: string;
          repositoryPath: string;
        } =>
          Boolean(workspace.cwd),
      );
    const preferredWorkspaceCwd = findPreferredReviewWorkspaceCwd(thread);
    const selectedWorkspace = workspaces.find(
      (workspace) => workspace.cwd.trim() === preferredWorkspaceCwd,
    ) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    const defaultRepositoryPath =
      selectedWorkspace?.repositoryPath
      ?? workspaces[0]?.repositoryPath;
    const directory = navigation.directories.find((candidate) =>
      reviewWorkspaceMatches(candidate.path, defaultRepositoryPath),
    );
    const workspaceThread = reviewThreadForWorkspace(
      thread,
      selectedWorkspace?.cwd,
    );
    const target: AppServerReviewTarget = {
      type: "baseBranch",
      branch:
        buildReviewBranchOptions({ directory, thread: workspaceThread })[0]
        ?? "main",
    };
    const intent = this.buildReviewIntent({
      binding,
      navigation,
      phase: "summary",
      target,
      reviewerBackends: await this.listReviewerBackends(),
      ...(selectedWorkspace
        ? {
            cwd: selectedWorkspace.cwd,
            repositoryPath: selectedWorkspace.repositoryPath,
          }
        : {}),
    });
    const pending = await this.storePendingIntent(intent, binding, event);
    const result = await this.deliver(intent, binding, event);
    await this.options.store.upsertPendingIntent({
      ...pending,
      surface: result.surface ?? pending.surface,
    });
  }

  private buildReviewIntent(params: {
    binding: MessagingBindingRecord;
    navigation: NavigationSnapshot;
    phase: MessagingReviewIntent["review"]["phase"];
    cwd?: string;
    repositoryPath?: string;
    workspacePageIndex?: number;
    target?: AppServerReviewTarget;
    reviewer?: ModelSettingsRecent;
    reviewerBackends?: MessagingReviewIntent["review"]["reviewerBackends"];
    id?: string;
    createdAt?: number;
    targetSurface?: MessagingSurfaceRef;
  }): MessagingReviewIntent {
    const thread = findThreadForBinding(params.navigation, params.binding);
    const linkedWorkspaces = (thread?.linkedDirectories ?? []).flatMap((directory) => {
      const cwd = directory.worktreePath ?? directory.path;
      return cwd
        ? [{
            cwd,
            label: directory.label,
            repositoryPath: directory.path,
          }]
        : [];
    });
    const directory = params.navigation.directories.find((candidate) =>
      reviewWorkspaceMatches(
        candidate.path,
        params.repositoryPath
        ?? params.cwd
        ?? linkedWorkspaces[0]?.repositoryPath,
      ),
    );
    const selectedWorkspace = linkedWorkspaces.find(
      (workspace) => workspace.cwd === params.cwd,
    );
    const workspaceThread = reviewThreadForWorkspace(thread, params.cwd);
    const defaultBaseBranch =
      buildReviewBranchOptions({ directory, thread: workspaceThread })[0]
      ?? "main";
    const target =
      params.target
      ?? {
        type: "baseBranch" as const,
        branch: defaultBaseBranch,
      };
    const reviewerBackends = params.reviewerBackends ?? [];
    // No advertised review runners means this instance predates reviewer
    // overrides; the Reviewer button stays off rather than offering a choice
    // that cannot land.
    const reviewerOverridesSupported = reviewerBackends.length > 0;
    const reviewerBackendKind = params.reviewer?.backend ?? params.binding.backend;
    const reviewerEntry = reviewerBackends.find(
      (entry) => entry.backend === reviewerBackendKind,
    );
    // The inherited case must report the same settings the non-override
    // submit path resolves, which falls back to the binding's own preferences
    // when the thread carries none — reading `thread` alone would show
    // "provider default" and then run with the binding's model.
    const inheritedSettings = params.reviewer
      ? undefined
      : turnSettingsForBinding(params.binding, params.navigation);
    // An un-picked model/effort stays blank rather than guessing the
    // provider's first entry — the review resolves those against the picked
    // provider's own defaults.
    const reviewerModelId = params.reviewer?.model ?? inheritedSettings?.model;
    const reviewerEffort =
      params.reviewer?.reasoningEffort ?? inheritedSettings?.reasoningEffort;
    const reviewerModelEntry = reviewerEntry?.models.find(
      (model) => model.id === reviewerModelId,
    );
    const reviewerSummaryLabel = [
      reviewerEntry?.label ?? reviewerBackendKind,
      reviewerModelId ?? "provider default",
      reviewerEffort,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");

    let title = "Review";
    let body: string;
    let allowFreeform = false;
    let actions: MessagingSurfaceAction[] = [];
    const backAction: MessagingSurfaceAction = {
      id: "review:back",
      label: "Back",
      fallbackText: "back",
      priority: 1,
    };
    const cancelAction: MessagingSurfaceAction = {
      id: "review:cancel",
      label: "Cancel",
      style: "danger",
      fallbackText: "cancel",
      priority: 2,
    };

    if (params.phase === "summary") {
      const projectLabel =
        selectedWorkspace?.label
        ?? (
          linkedWorkspaces.length > 1
            ? "[needs selection]"
            : linkedWorkspaces[0]?.label ?? "Thread workspace"
        );
      const summaryLines = [
        `Project: ${projectLabel}`,
        `Review: ${formatMessagingReviewScope(target)}`,
      ];
      if (target.type === "baseBranch") {
        summaryLines.push(`Base Branch: ${target.branch}`);
      } else if (target.type === "commit") {
        summaryLines.push(
          `Commit: ${target.title?.trim() || target.sha || "[needs selection]"}`,
        );
      } else if (target.type === "custom") {
        summaryLines.push(`Instructions: ${target.instructions}`);
      }
      if (reviewerOverridesSupported) {
        summaryLines.push(
          `Reviewer: ${reviewerSummaryLabel}${params.reviewer ? "" : " (thread default)"}`,
        );
      }
      body = summaryLines.join("\n");
      actions = [
        ...(linkedWorkspaces.length > 1
          ? [{
              id: "review:summary:workspace",
              label: "Project",
              fallbackText: "project",
              priority: 10,
            }]
          : []),
        {
          id: "review:summary:target",
          label: "Review Scope",
          fallbackText: "review scope",
          priority: 11,
        },
        ...(target.type === "baseBranch"
          ? [{
              id: "review:summary:base-branch",
              label: "Base Branch",
              fallbackText: "base branch",
              priority: 12,
            }]
          : target.type === "commit"
            ? [{
                id: "review:summary:commit",
                label: "Commit",
                fallbackText: "commit",
                priority: 12,
              }]
            : target.type === "custom"
              ? [{
                  id: "review:summary:custom",
                  label: "Instructions",
                  fallbackText: "instructions",
                  priority: 12,
                }]
              : []),
        ...(reviewerOverridesSupported
          ? [{
              id: "review:summary:reviewer",
              label: "Reviewer",
              fallbackText: "reviewer",
              priority: 13,
            }]
          : []),
        {
          id: "review:summary:start",
          label: "Start Review",
          style: "primary",
          fallbackText: "start review",
          priority: 0,
        },
        cancelAction,
      ];
    } else if (params.phase === "workspace") {
      const page = paginateReviewWorkspaces({
        itemCount: linkedWorkspaces.length,
        maxActions: this.capabilityProfile.actions?.maxActions,
        pageIndex: params.workspacePageIndex,
      });
      title = "Review project";
      body = [
        "Choose the linked project to review.",
        page.totalPages > 1
          ? `Page ${page.pageIndex + 1}/${page.totalPages}.`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      actions = [
        ...linkedWorkspaces
          .slice(page.startIndex, page.endIndex)
          .map((workspace, index) => ({
            id: `review:workspace:${page.startIndex + index}`,
            label: workspace.label,
            fallbackText: workspace.cwd,
            priority: 10 + index,
            value: {
              cwd: workspace.cwd,
              repositoryPath: workspace.repositoryPath,
            },
          })),
        ...(page.pageIndex > 0
          ? [{
              id: "review:workspace:previous",
              label: "Previous",
              fallbackText: "previous",
              priority: 3,
              value: { pageIndex: page.pageIndex - 1 },
            }]
          : []),
        ...(page.pageIndex < page.totalPages - 1
          ? [{
              id: "review:workspace:next",
              label: "Next",
              fallbackText: "next",
              priority: 4,
              value: { pageIndex: page.pageIndex + 1 },
            }]
          : []),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "target") {
      title = "Review scope";
      body = "Choose what PwrAgent should review.";
      actions = [
        {
          id: "review:target:base-branch",
          label: "Base branch",
          description: "Compare this branch with a base branch",
          fallbackText: "base branch",
          value: { targetType: "baseBranch" },
        },
        {
          id: "review:target:current-changes",
          label: "Current changes",
          description: "Review staged, unstaged, and untracked files",
          fallbackText: "current changes",
          value: { targetType: "uncommittedChanges" },
        },
        {
          id: "review:target:commit",
          label: "Commit",
          description: "Review one commit by SHA",
          fallbackText: "commit",
          value: { targetType: "commit" },
        },
        {
          id: "review:target:custom",
          label: "Custom",
          description: "Review using custom instructions",
          fallbackText: "custom",
          value: { targetType: "custom" },
        },
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "base_branch") {
      title = "Base branch";
      body = "Choose a suggested base branch or reply with any branch name.";
      allowFreeform = true;
      actions = [
        ...messagingReviewBranchOptions({
          directory,
          thread: workspaceThread,
        }).map((branch, index) => ({
          id: `review:base-branch:${index}`,
          label: branch,
          fallbackText: branch,
          priority: 10 + index,
          value: { branch },
        })),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "commit") {
      title = "Commit";
      body = "Choose a recent commit or reply with a commit SHA.";
      allowFreeform = true;
      actions = [
        ...(directory?.gitStatus?.recentCommits ?? []).map((commit, index) => ({
          id: `review:commit:${index}`,
          label: `${commit.shortSha} ${commit.subject}`,
          fallbackText: commit.sha,
          priority: 10 + index,
          value: {
            sha: commit.sha,
            title: commit.subject,
          },
        })),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "custom") {
      title = "Custom review";
      body = "Reply with the review instructions.";
      allowFreeform = true;
      actions = [backAction, cancelAction];
    } else if (params.phase === "reviewer_provider") {
      title = "Review provider";
      body = [
        "Choose the provider that runs this review.",
        "It applies to this review only — the thread keeps its own settings.",
      ].join("\n");
      actions = [
        ...reviewerBackends.map((entry, index) => ({
          id: `review:reviewer:provider:${index}`,
          label: entry.label,
          fallbackText: entry.backend,
          priority: 10 + index,
          value: { backend: entry.backend },
        })),
        // Priority sits with Back/Cancel, not with the options: truncation
        // drops the highest priority number first, and the escape hatch is
        // the last thing that should go when a profile caps actions.
        ...(params.reviewer
          ? [{
              id: "review:reviewer:inherit",
              label: "Use Thread Default",
              fallbackText: "use thread default",
              priority: 3,
            }]
          : []),
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "reviewer_model") {
      const models = reviewerEntry?.models ?? [];
      const maxActions = this.capabilityProfile.actions?.maxActions;
      if (maxActions !== undefined && models.length + 3 > maxActions) {
        this.logger.debug?.("messaging reviewer model list truncated", {
          backend: reviewerBackendKind,
          maxActions,
          modelCount: models.length,
        });
      }
      title = "Review model";
      body = `Choose the model ${reviewerEntry?.label ?? reviewerBackendKind} should review with.`;
      actions = [
        ...models.map((model, index) => ({
          id: `review:reviewer:model:${index}`,
          label: model.label,
          fallbackText: model.id,
          priority: 10 + index,
          value: { model: model.id },
        })),
        {
          id: "review:reviewer:model:default",
          label: "Provider Default",
          fallbackText: "provider default",
          priority: 3,
        },
        backAction,
        cancelAction,
      ];
    } else if (params.phase === "reviewer_effort") {
      const efforts = reviewerModelEntry?.reasoningEfforts ?? [];
      title = "Review reasoning";
      body = `Choose the reasoning effort for ${reviewerModelEntry?.label ?? reviewerModelId ?? "this model"}.`;
      actions = [
        ...efforts.map((effort, index) => ({
          id: `review:reviewer:effort:${index}`,
          label: effort,
          fallbackText: effort,
          priority: 10 + index,
          value: { reasoningEffort: effort },
        })),
        {
          id: "review:reviewer:effort:default",
          label: "Provider Default",
          fallbackText: "provider default",
          priority: 3,
        },
        backAction,
        cancelAction,
      ];
    } else {
      title = "Review submitted";
      body = "The review request was submitted.";
    }

    actions = applyActionCapabilityLimits(actions, this.capabilityProfile);
    return {
      id: params.id ?? this.newIntentId("review"),
      kind: "review",
      bindingId: params.binding.id,
      createdAt: params.createdAt ?? this.now(),
      title,
      body,
      actions,
      allowFreeform,
      fallbackText: allowFreeform
        ? `${body} Reply with text or tap an option.`
        : body,
      review: {
        backend: params.binding.backend,
        threadId: params.binding.threadId,
        phase: params.phase,
        ...(params.reviewer ? { reviewer: params.reviewer } : {}),
        ...(reviewerBackends.length > 0 ? { reviewerBackends } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.repositoryPath
          ? { repositoryPath: params.repositoryPath }
          : {}),
        workspaceSelectionRequired: linkedWorkspaces.length > 1,
        ...(params.workspacePageIndex !== undefined
          ? { workspacePageIndex: params.workspacePageIndex }
          : {}),
        targetType: target.type,
        target,
      },
      ...(params.targetSurface
        ? {
            targetSurface: params.targetSurface,
            delivery: {
              mode: "update",
              replaceMarkup: true,
              fallback: "present_new",
            },
          }
        : {}),
    };
  }

  /**
   * Render the help surface. The body is the prose
   * description-list (derived from `MESSAGING_COMMAND_CATALOG` so it
   * never drifts from the verb set) and the action row is one
   * `command:<verb>` button per catalog entry on the current page,
   * plus Prev/Next/Cancel navigation when the catalog overflows a
   * single page.
   *
   * Pagination is stateless: the next/previous page index travels in
   * `action.value.pageIndex` and comes back through the
   * `MessagingInboundCallbackEvent.value` field. Help has no
   * persistent session record like the resume browser does — the
   * page content is deterministic from the catalog plus the page
   * index.
   *
   * Re-renders pass `targetSurface` from the originating callback's
   * interaction state so we update the existing post in place
   * instead of stacking new help posts on every Next click.
   */
  private async presentHelp(
    event: MessagingInboundEvent,
    options?: { pageIndex?: number; targetSurface?: MessagingSurfaceRef },
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    const reviewSupported = binding
      ? await this.reviewSupportedForBinding(binding)
      : false;
    const actionCatalog =
      reviewSupported
        ? MESSAGING_HELP_ACTION_COMMANDS.flatMap((command) =>
            command.verb === "help"
              ? [MESSAGING_REVIEW_HELP_SPEC, command]
              : [command],
          )
        : MESSAGING_HELP_ACTION_COMMANDS;
    const helpCatalog = [
      ...MESSAGING_COMMAND_CATALOG,
      ...(reviewSupported
        ? [MESSAGING_REVIEW_HELP_SPEC]
        : []),
    ];
    const page = paginateHelpCatalog({
      catalog: actionCatalog,
      profile: this.capabilityProfile,
      pageIndex: options?.pageIndex,
    });
    const actions = buildHelpActions({ page });
    const titleSuffix
      = page.totalPages > 1
        ? ` (page ${page.pageIndex + 1}/${page.totalPages})`
        : "";
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("help"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: `PwrAgent commands${titleSuffix}`,
        body: formatMessagingCommandHelpBody({ catalog: helpCatalog }),
        actions,
        ...(options?.targetSurface
          ? {
              targetSurface: options.targetSurface,
              delivery: { mode: "update" as const, replaceMarkup: true },
            }
          : {}),
      }),
      undefined,
      event,
    );
  }

  private async handleText(event: MessagingInboundTextEvent): Promise<void> {
    const command = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => parseTextCommand(event.text),
    );
    if (command) {
      await this.handleCommand({
        ...event,
        kind: "command",
        command,
        args: parseTextCommandArgs(event.text),
        rawText: event.text,
      });
      return;
    }

    const mentionCommand = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => event.botMention ? parseMentionCommand(event.text) : undefined,
    );
    if (mentionCommand) {
      await this.handleCommand({
        ...event,
        kind: "command",
        command: mentionCommand.command,
        args: mentionCommand.args,
        rawText: `/${[mentionCommand.command, ...mentionCommand.args].join(" ")}`,
      });
      return;
    }

    const [pendingNewThread, pendingIntent] = await Promise.all([
      this.measureHandledToRoutedSubspan(
        event,
        "handledPendingNewThreadReadMs",
        async () => await this.findPendingNewThreadSession(event),
      ),
      this.measureHandledToRoutedSubspan(
        event,
        "handledPendingIntentReadMs",
        async () =>
          await this.options.store.findActivePendingIntentForChannel({
            actorId: event.actor.platformUserId,
            channel: event.channel,
            now: this.now(),
          }),
      ),
    ]);
    if (pendingIntent) {
      if (isSkillsSearchIntent(pendingIntent.intent)) {
        const mapped = await this.interactionMapper.mapText({
          intent: pendingIntent.intent,
          text: event.text,
        });
        if (mapped.kind === "matched") {
          await this.handleCallback({
            ...event,
            kind: "callback",
            interaction: {
              channel: event.channel.channel,
              id: mapped.action.id,
            },
            sourceSurface: pendingIntent.surface,
            actionId: mapped.action.id,
            value: mapped.action.value,
          });
          return;
        }

        const binding = pendingIntent.bindingId
          ? await this.options.store.getBinding(pendingIntent.bindingId)
          : undefined;
        await this.options.store.deletePendingIntent(pendingIntent.id);
        if (binding && !binding.revokedAt) {
          await this.presentSkillsBrowser(binding, event, {
            pageIndex: 0,
            query: event.text,
            targetSurface: pendingIntent.surface,
          });
          return;
        }
      } else {
        const mapped = await this.interactionMapper.mapText({
          intent: pendingIntent.intent,
          text: event.text,
        });
        if (mapped.kind === "matched") {
          await this.handleCallback({
            ...event,
            kind: "callback",
            interaction: {
              channel: event.channel.channel,
              id: mapped.action.id,
            },
            sourceSurface: pendingIntent.surface,
            actionId: mapped.action.id,
            value: mapped.action.value,
          });
          return;
        }
        if (
          pendingIntent.intent.kind === "review" &&
          await this.handleReviewTextAnswer(pendingIntent, event)
        ) {
          return;
        }
        if (
          pendingIntent.intent.kind === "questionnaire" &&
          await this.handleQuestionnaireTextAnswer(pendingIntent, event)
        ) {
          return;
        }
        if (pendingNewThread) {
          await this.appendPendingNewThreadPrompt(pendingNewThread, event);
          return;
        }
        if (isSkillSelectionNoticeIntent(pendingIntent.intent)) {
          await this.options.store.deletePendingIntent(pendingIntent.id);
        } else if (mapped.kind === "ambiguous") {
          await this.deliver(
            buildConfirmationIntent({
              id: this.newIntentId("ambiguous-reply"),
              capabilityProfile: this.capabilityProfile,
              createdAt: this.now(),
              title: "Choose an option",
              body: pendingIntent.intent.fallbackText ?? "Reply with one of the shown options.",
              fallbackText: pendingIntent.intent.fallbackText,
            }),
            undefined,
            event,
          );
          return;
        }
      }
    }

    if (pendingNewThread) {
      await this.appendPendingNewThreadPrompt(pendingNewThread, event);
      return;
    }

    let binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledBindingLookupMs",
      async () => await this.options.store.findActiveBindingForChannel(event.channel),
    );
    binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledPrivateContinuationExpirationMs",
      async () => await this.revokeExpiredPrivateReplyContinuation(binding),
    );
    binding = bindingWithInboundRoutingState(binding, event.routingState);
    if (!binding) {
      if (!await this.measureHandledToRoutedSubspan(
        event,
        "handledSharedMessagePolicyMs",
        async () => await this.shouldHandleAmbientSharedMessage(event),
      )) {
        return;
      }
      if (await this.bootstrapDefaultAgentForAcceptedMessage(event)) {
        return;
      }
      await this.presentHelp(event);
      return;
    }

    if (!await this.measureHandledToRoutedSubspan(
      event,
      "handledSharedMessagePolicyMs",
      async () => await this.shouldHandleAmbientSharedMessage(event, binding),
    )) {
      return;
    }

    if (isToolsFallbackText(event.text)) {
      await this.cycleToolUpdateMode(binding, event);
      return;
    }
    if (isStreamFallbackText(event.text)) {
      await this.cycleStreamingResponseMode(binding, event);
      return;
    }

    // RBAC floor: sending a turn to the agent needs `message.reply`. Silent
    // drop (no reply) so an under-permissioned sender can't be spammed with
    // rejections in a shared channel.
    if (!(await this.measureHandledToRoutedSubspan(
      event,
      "handledRequirePermissionMs",
      async () =>
        await this.requirePermission(
          event,
          "message.reply",
          "message:reply",
          { notify: false },
        ),
    ))) {
      return;
    }
    // A turn into a remote-bound thread runs on the peer's machine.
    if (
      !(await this.measureHandledToRoutedSubspan(
        event,
        "handledRemoteScopeMs",
        async () =>
          await this.requireRemoteScopeForBinding(
            event,
            binding,
            "message:reply:remote-instance",
            { notify: false },
          ),
      ))
    ) {
      return;
    }

    await this.admitTurnInput({ binding, event });
  }

  private async bootstrapDefaultAgentForAcceptedMessage(
    event: MessagingInboundTextEvent | MessagingInboundMediaEvent,
  ): Promise<boolean> {
    const assignments =
      await this.measureHandledToRoutedSubspan(
        event,
        "handledDefaultAgentAssignmentsMs",
        async () =>
          await this.options.store.findActiveDefaultAgentAssignmentsForChannel(
            event.channel,
          ),
      );
    if (assignments.length === 0) {
      return false;
    }
    if (
      !(await this.measureHandledToRoutedSubspan(
        event,
        "handledRequirePermissionMs",
        async () =>
          await this.requirePermission(
            event,
            "message.reply",
            event.kind === "media" ? "media:reply" : "message:reply",
            { notify: false },
          ),
      ))
    ) {
      return true;
    }

    let selected:
      | {
          assignment: MessagingDefaultAgentAssignmentRecord;
        }
      | undefined;
    let backendSummaries: BackendSummary[] | undefined;
    let backendSummariesLoaded = false;
    // Revocations are buffered, not applied as they are decided. Every
    // iteration reads backend state that can fail, and a failure part-way
    // through used to leave the channel half-revoked: the assignments already
    // rejected were gone, the ones not yet examined survived, and the operator
    // saw only "Default Agent unavailable". Deciding first and writing after
    // makes the pass all-or-nothing.
    const revocations: MessagingDefaultAgentAssignmentRecord[] = [];
    for (const assignment of assignments) {
      let targetIsAgentThread: boolean;
      try {
        targetIsAgentThread =
          await this.measureHandledToRoutedSubspan(
            event,
            "handledDefaultAgentTargetValidationMs",
            async () =>
              await this.defaultAgentTargetIsAgentThread(assignment.target),
          );
      } catch (error) {
        await this.deliverDefaultAgentBootstrapError(
          event,
          "Default Agent unavailable",
          error instanceof Error ? error.message : String(error),
        );
        return true;
      }
      if (
        isAcpBackendId(assignment.target.backend)
        && !backendSummariesLoaded
      ) {
        backendSummaries = await this.measureHandledToRoutedSubspan(
          event,
          "handledDefaultAgentBackendValidationMs",
          async () => await this.loadDefaultAgentBackendSummaries(),
        );
        backendSummariesLoaded = true;
      }
      const backendSupport = defaultAgentBackendSupport(
        assignment.target.backend,
        backendSummaries,
      );
      if (
        assignment.target.kind === "agent"
        && targetIsAgentThread
        && backendSupport === "supported"
      ) {
        selected = { assignment };
        break;
      }
      if (targetIsAgentThread && backendSupport === "unknown") {
        await this.deliverDefaultAgentBootstrapError(
          event,
          "Default Agent unavailable",
          "PwrAgent could not confirm that this Agent backend currently exposes the required tools. The default assignment was preserved.",
        );
        return true;
      }
      revocations.push(assignment);
    }
    await this.measureHandledToRoutedSubspan(
      event,
      "handledDefaultAgentRevocationsMs",
      async () => {
        for (const assignment of revocations) {
          await this.options.store.revokeDefaultAgentAssignment({
            assignmentId: assignment.id,
            revokedAt: this.now(),
          });
          this.notifyBindingChanged("default-agent-cleared");
        }
      },
    );
    if (!selected) {
      return false;
    }

    const binding = this.defaultAgentRouteBinding(event, {
      backend: selected.assignment.target.backend,
      threadId: selected.assignment.target.threadId,
      toolUpdateMode: selected.assignment.toolUpdateMode,
    });
    await this.admitTurnInput({
      binding,
      event,
    });
    return true;
  }

  /**
   * Does this assignment still point at an agent thread?
   *
   * Answered from what this process already knows about the one thread whose
   * id the assignment carries. Deciding to start or queue a turn needs the
   * target's identity, settings and occupancy; it does not need Git state,
   * pull-request status, launchpads or the rest of the fleet.
   *
   * This used to call `getNavigationSnapshot({ backend: "all" })` on every
   * accepted message, which enumerates every thread on every backend and then
   * hydrates overlays, canonicalizes pull requests, probes Git working state,
   * refreshes directory status and hydrates launchpads — all to answer one
   * yes-or-no question about one thread. Opening the same thread in the app
   * does none of that.
   *
   * ## What the listing proved, and what replaces it
   *
   * The listing proved two things at once: the thread still has an agent, and
   * the provider still serves it. Only the first survives here, and the
   * difference is deliberate rather than overlooked.
   *
   * `agent` is desktop-owned state that lives in the thread's overlay row, and
   * a navigation row reads it from that same row — so the targeted answer and
   * the listing's answer are the same answer.
   *
   * Existence is the one this cannot prove. `admission.thread` is built from
   * the overlay when no listing row is remembered, and nothing deletes an
   * overlay, so an agent thread deleted at the provider still presents a row
   * here. Proving otherwise costs a provider round trip on every accepted
   * message, and the two ways a target legitimately goes away are already
   * covered more cheaply: archival revokes these assignments from the
   * `thread/archived` handler, and a thread this machine has no record of at
   * all fails the check below. What remains — an out-of-band deletion whose
   * overlay outlives it — surfaces as a failed `startTurn` with a recoverable
   * error rather than as a fleet walk charged to every message.
   */
  private async defaultAgentTargetIsAgentThread(
    target: MessagingDefaultAgentAssignmentRecord["target"],
  ): Promise<boolean> {
    const admission = await this.options.backend.getThreadAdmissionState({
      backend: target.backend,
      threadId: target.threadId,
    });
    return Boolean(admission.thread?.agent);
  }

  private async deliverDefaultAgentBootstrapError(
    event: MessagingInboundEvent,
    title: string,
    body: string,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("default-agent-bootstrap"),
        createdAt: this.now(),
        title,
        body,
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async handleMedia(event: MessagingInboundMediaEvent): Promise<void> {
    const command = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => event.text ? parseTextCommand(event.text) : undefined,
    );
    if (command) {
      await this.handleCommand({
        ...event,
        kind: "command",
        command,
        args: parseTextCommandArgs(event.text ?? ""),
        rawText: event.text ?? "",
      });
      return;
    }
    const mentionCommand = this.measureHandledToRoutedSyncSubspan(
      event,
      "handledTextParsingMs",
      () => event.botMention && event.text
        ? parseMentionCommand(event.text)
        : undefined,
    );
    if (mentionCommand) {
      await this.handleCommand({
        ...event,
        kind: "command",
        command: mentionCommand.command,
        args: mentionCommand.args,
        rawText: `/${[mentionCommand.command, ...mentionCommand.args].join(" ")}`,
      });
      return;
    }

    const pendingNewThread = await this.measureHandledToRoutedSubspan(
      event,
      "handledPendingNewThreadReadMs",
      async () => await this.findPendingNewThreadSession(event),
    );
    if (pendingNewThread) {
      await this.appendPendingNewThreadPrompt(pendingNewThread, event);
      return;
    }

    let binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledBindingLookupMs",
      async () => await this.options.store.findActiveBindingForChannel(event.channel),
    );
    binding = await this.measureHandledToRoutedSubspan(
      event,
      "handledPrivateContinuationExpirationMs",
      async () => await this.revokeExpiredPrivateReplyContinuation(binding),
    );
    binding = bindingWithInboundRoutingState(binding, event.routingState);
    if (!binding) {
      if (!await this.measureHandledToRoutedSubspan(
        event,
        "handledSharedMessagePolicyMs",
        async () => await this.shouldHandleAmbientSharedMessage(event),
      )) {
        return;
      }
      if (await this.bootstrapDefaultAgentForAcceptedMessage(event)) {
        return;
      }
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("needs-binding-media"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Choose a thread",
          body: "Bind this conversation to a PwrAgent thread before sending attachments.",
          fallbackText: "Reply /resume to choose a thread.",
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

    if (!await this.measureHandledToRoutedSubspan(
      event,
      "handledSharedMessagePolicyMs",
      async () => await this.shouldHandleAmbientSharedMessage(event, binding),
    )) {
      return;
    }

    if (!(await this.measureHandledToRoutedSubspan(
      event,
      "handledRequirePermissionMs",
      async () =>
        await this.requirePermission(
          event,
          "message.reply",
          "media:reply",
          { notify: false },
        ),
    ))) {
      return;
    }
    if (
      !(await this.measureHandledToRoutedSubspan(
        event,
        "handledRemoteScopeMs",
        async () =>
          await this.requireRemoteScopeForBinding(
            event,
            binding,
            "media:reply:remote-instance",
            { notify: false },
          ),
      ))
    ) {
      return;
    }

    await this.admitTurnInput({ binding, event });
  }

  private async shouldHandleAmbientSharedMessage(
    event: MessagingInboundTextEvent | MessagingInboundMediaEvent,
    binding?: MessagingBindingRecord,
  ): Promise<boolean> {
    if (
      event.channel.conversation.kind === "dm"
      || event.channel.conversation.isDirectMessage === true
    ) {
      return true;
    }
    if (
      this.capabilityProfile.conversationInput?.reportsBotMention !== true
    ) {
      return true;
    }
    const responseMode = resolveMessagingResponseMode(
      binding,
      await this.measureHandledToRoutedSubspan(
        event,
        "handledResponseModeMs",
        async () => await this.responseModeForConversation(event.channel),
      ),
    );
    return responseMode === "every_message" || event.botMention === true;
  }

  private async responseModeForConversation(
    channel: MessagingChannelRef,
  ): Promise<MessagingResponseMode> {
    return await this.options.responseModeForConversation?.(channel) ?? "every_message";
  }

  /**
   * Retire a Default Agent assignment whose target could not start a turn.
   *
   * Scoped to bindings this controller routed through a Default Agent: an
   * ordinary bound thread failing to start is a transient the operator can
   * retry, not evidence that the binding is wrong. A revoked assignment leaves
   * the channel unbound, so the next message falls through to normal handling
   * and the operator is told the default was cleared.
   */
  private async revokeDefaultAgentRouteForFailedStart(
    binding: MessagingBindingRecord,
  ): Promise<void> {
    if (!isDefaultAgentRouteBinding(binding)) {
      return;
    }
    const revoked = await this.options.store
      .revokeDefaultAgentAssignmentsForTarget({
        backend: binding.backend,
        threadId: binding.threadId,
        revokedAt: this.now(),
      })
      .catch((error: unknown) => {
        this.logger.debug?.("messaging default agent revoke after failed start failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
        return [];
      });
    // An empty array is still truthy, and a start can fail on a channel whose
    // assignment was already retired -- announce a change only when one moved.
    if (revoked.length > 0) {
      this.notifyBindingChanged("default-agent-cleared");
    }
  }

  /**
   * The one door into the admission queue, so every route marks the same stage.
   */
  private async admitTurnInput(params: {
    binding: MessagingBindingRecord;
    event: MessagingTurnInputEvent;
  }): Promise<void> {
    this.markAdmissionStage(params.event, "routed");
    const startedAt = this.now();
    try {
      await this.turnAdmission.append(params);
    } finally {
      const finalAdmissionAppendAwaitMs = this.now() - startedAt;
      this.recordHandledToRoutedSubspan(
        params.event,
        "finalAdmissionAppendAwaitMs",
        finalAdmissionAppendAwaitMs,
        false,
      );
      this.logger.debug?.("messaging admission append timing", {
        eventId: params.event.id,
        platform: params.event.channel.channel,
        finalAdmissionAppendAwaitMs,
      });
    }
  }

  private async measureHandledToRoutedSubspan<T>(
    event: MessagingInboundEvent,
    subspan: MessagingHandledToRoutedSubspan,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      this.recordHandledToRoutedSubspan(
        event,
        subspan,
        this.now() - startedAt,
      );
    }
  }

  private measureHandledToRoutedSyncSubspan<T>(
    event: MessagingInboundEvent,
    subspan: MessagingHandledToRoutedSubspan,
    operation: () => T,
  ): T {
    const startedAt = this.now();
    try {
      return operation();
    } finally {
      this.recordHandledToRoutedSubspan(
        event,
        subspan,
        this.now() - startedAt,
      );
    }
  }

  private recordHandledToRoutedSubspan(
    event: MessagingInboundEvent,
    subspan: MessagingHandledToRoutedSubspan,
    durationMs: number,
    create = true,
  ): void {
    const timing = create
      ? this.admissionTimingForEvent(event)
      : this.admissionStageMarks.get(event.id);
    if (!timing) return;
    timing.subspans[subspan] =
      (timing.subspans[subspan] ?? 0) + durationMs;
  }

  private admissionTimingForEvent(
    event: MessagingInboundEvent,
  ): MessagingAdmissionTimingRecord {
    let timing = this.admissionStageMarks.get(event.id);
    if (!timing) {
      timing = { marks: {}, subspans: {} };
      rememberBoundedMap(
        this.admissionStageMarks,
        event.id,
        timing,
        ADMISSION_STAGE_MARK_LIMIT,
      );
    }
    return timing;
  }

  /**
   * Record when this message reached {@link stage}, if it has not already.
   *
   * First mark wins: a stage reached twice (an admission state resolved once
   * per bundle and again per queued release) keeps the earlier time, so a span
   * never reads as negative.
   */
  private markAdmissionStage(
    event: MessagingInboundEvent | undefined,
    stage: MessagingAdmissionStage,
  ): void {
    if (!event) return;
    const timing = this.admissionTimingForEvent(event);
    timing.marks[stage] ??= this.now();
  }

  /**
   * Add one bounded subspan to the existing start-turn admission log.
   *
   * A bundle can contain several text or media events, so repeated spans add
   * together. The record is keyed by the provider event id and never includes
   * message content, attachment names, or actor identifiers.
   */
  private addInputPreparationTiming(
    event: MessagingInboundEvent | undefined,
    span: MessagingInputPreparationSpan,
    startedAt: number,
  ): void {
    if (!event) return;
    const timing = this.admissionTimingForEvent(event);
    timing.subspans[span] =
      (timing.subspans[span] ?? 0) + (this.now() - startedAt);
  }

  /**
   * Consume this message's marks as span durations for the start-turn log.
   *
   * A span is emitted only when both of its ends were reached, so a path that
   * skips a stage (a queued release, which never prepares input) reports the
   * stages it did run instead of a misleading zero.
   *
   * `routedToBundleReadyMs` covers the input debounce, and for a coalesced
   * burst it also covers the operator's own typing: the bundle carries its
   * first event, but flushes {@link DEFAULT_INPUT_DEBOUNCE_MS} after the last.
   * A large value there is the operator still typing, not PwrAgent stalling.
   */
  private takeAdmissionStageTiming(
    event: MessagingInboundEvent | undefined,
    startTurnIssuedAt: number,
  ): Record<string, number> {
    if (!event) return {};
    const admissionTiming = this.admissionStageMarks.get(event.id);
    if (!admissionTiming) return {};
    this.admissionStageMarks.delete(event.id);
    const marks = admissionTiming.marks;
    const spans: Array<[string, number | undefined, number | undefined]> = [
      ["receivedToHandledMs", event.receivedAt, marks.handled],
      ["handledToRoutedMs", marks.handled, marks.routed],
      ["routedToBundleReadyMs", marks.routed, marks.bundleReady],
      ["bundleReadyToInputPreparedMs", marks.bundleReady, marks.inputPrepared],
      [
        "inputPreparedToAdmissionStateMs",
        marks.inputPrepared,
        marks.admissionStateResolved,
      ],
      [
        "admissionStateToOccupancyMs",
        marks.admissionStateResolved,
        marks.occupancyResolved,
      ],
      // A turn that waited behind a busy thread reports its wait here instead.
      // Without these two the wait belonged to no span at all, so the stages
      // stopped summing to the end-to-end number with nothing saying why -- the
      // one reading that would send someone hunting for time that was never
      // lost.
      ["admissionStateToQueuedMs", marks.admissionStateResolved, marks.queued],
      ["queuedToOriginMs", marks.queued, marks.originBuilt],
      ["occupancyToOriginMs", marks.occupancyResolved, marks.originBuilt],
      ["originToPolicyMs", marks.originBuilt, marks.policyResolved],
      ["policyToStartTurnIssueMs", marks.policyResolved, startTurnIssuedAt],
    ];
    const timing: Record<string, number> = {};
    for (const [name, from, to] of spans) {
      if (from !== undefined && to !== undefined) {
        timing[name] = to - from;
      }
    }
    Object.assign(timing, admissionTiming.subspans);
    return timing;
  }

  private async handleAdmittedTurnBundle(
    bundle: MessagingTurnAdmissionBundle,
  ): Promise<void> {
    this.markAdmissionStage(bundle.events[0], "bundleReady");
    // Only the first event of a bundle is carried forward to the start-turn
    // log, so the others' marks can never be consumed. Dropping them here is
    // what keeps the ceiling from evicting a turn that is still in flight --
    // eviction is oldest-first, and the oldest entry is the one still waiting.
    for (const event of bundle.events.slice(1)) {
      this.admissionStageMarks.delete(event.id);
    }
    let currentBinding = bundle.binding;
    if (bundle.binding.pendingSkillSelection) {
      const pendingSkillBindingReloadStartedAt = this.now();
      try {
        currentBinding =
          await this.options.store.getBinding(bundle.binding.id)
          ?? bundle.binding;
      } finally {
        this.addInputPreparationTiming(
          bundle.events[0],
          "inputPrepPendingSkillBindingReloadMs",
          pendingSkillBindingReloadStartedAt,
        );
      }
    }
    const prepared = await this.prepareTurnInput(bundle.events, currentBinding, bundle.events[0]);
    if (!prepared) {
      return;
    }
    this.markAdmissionStage(bundle.events[0], "inputPrepared");
    const preparedWithSkill = this.prependPendingSkillSelection(
      prepared,
      currentBinding,
    );
    if (currentBinding.privateReplyContinuation) {
      await this.completePrivateReplyContinuation(currentBinding.id);
    }
    const consumedSkillBinding = currentBinding.pendingSkillSelection
      ? bindingWithoutPendingSkillSelection(currentBinding)
      : currentBinding;
    let admissionState: MessagingThreadAdmissionState | undefined;
    try {
      admissionState = await this.options.backend.getThreadAdmissionState({
        backend: consumedSkillBinding.backend,
        federationTarget: federationTargetForBinding(consumedSkillBinding),
        threadId: consumedSkillBinding.threadId,
      });
      this.markAdmissionStage(bundle.events[0], "admissionStateResolved");
    } catch (error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("turn-start-failed"),
          createdAt: this.now(),
          title: "Turn could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        consumedSkillBinding,
        bundle.events[0],
      );
      return;
    }

    if (
      !isDefaultAgentRouteBinding(currentBinding)
      && await this.isTurnOccupied(
        currentBinding,
        bundle.threadKey,
        admissionState,
      )
    ) {
      this.markAdmissionStage(bundle.events[0], "queued");
      await this.queuePreparedInput({
        binding: consumedSkillBinding,
        event: bundle.events[0],
        input: preparedWithSkill.input,
        pdfAttachments: preparedWithSkill.pdfAttachments,
        privateResponseRequested: preparedWithSkill.privateResponseRequested,
        preview: preparedWithSkill.preview,
        threadKey: bundle.threadKey,
      });
      if (currentBinding.pendingSkillSelection) {
        await this.clearPendingSkillSelection(currentBinding);
      }
      return;
    }

    this.markAdmissionStage(bundle.events[0], "occupancyResolved");
    const startResult = await this.startPreparedInput({
      binding: consumedSkillBinding,
      input: preparedWithSkill.input,
      pdfAttachments: preparedWithSkill.pdfAttachments,
      privateResponseRequested: preparedWithSkill.privateResponseRequested,
      preview: preparedWithSkill.preview,
      threadKey: bundle.threadKey,
      event: bundle.events[0],
      admissionState,
    });
    if (startResult !== "failed" && currentBinding.pendingSkillSelection) {
      const updatedBinding = await this.clearPendingSkillSelection(currentBinding);
      await this.renderAutomaticBindingStatus(updatedBinding, bundle.events[0]);
    }
  }

  private prependPendingSkillSelection(
    prepared: {
      input: AppServerTurnInputItem[];
      pdfAttachments: PendingPdfAttachment[];
      privateResponseRequested: boolean;
      preview: string;
    },
    binding: MessagingBindingRecord,
  ): {
    input: AppServerTurnInputItem[];
    pdfAttachments: PendingPdfAttachment[];
    privateResponseRequested: boolean;
    preview: string;
  } {
    const selection = binding.pendingSkillSelection;
    if (!selection) return prepared;
    const prefix = formatSkillInputPrefix(selection);
    return {
      input: [
        {
          type: "text",
          text: prefix,
        },
        ...prepared.input,
      ],
      pdfAttachments: prepared.pdfAttachments,
      privateResponseRequested: prepared.privateResponseRequested,
      preview: `${prefix}\n${prepared.preview}`,
    };
  }

  private async findPendingNewThreadSession(
    event: MessagingInboundTextEvent | MessagingInboundMediaEvent,
  ): Promise<MessagingBrowseSessionRecord | undefined> {
    const session = await this.options.store.findActiveBrowseSessionForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (
      session &&
      isNewThreadLaunchAction(session.launchAction) &&
      session.mode === "new_thread_options" &&
      session.selectedProject &&
      (session.textInputExpiresAt ?? session.expiresAt) > this.now()
    ) {
      return session;
    }
    return undefined;
  }

  private async appendPendingNewThreadPrompt(
    session: MessagingBrowseSessionRecord,
    event: MessagingTurnInputEvent,
  ): Promise<void> {
    const key = this.pendingNewThreadPromptKey(session);
    const existing = this.pendingNewThreadPrompts.get(key);
    if (existing) {
      existing.events.push(event);
      existing.session = session;
      if ((this.options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS) <= 0) {
        await this.flushPendingNewThreadPrompt(key);
        return;
      }
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      existing.timer = this.schedulePendingNewThreadPrompt(key);
      return;
    }

    this.pendingNewThreadPrompts.set(key, {
      events: [event],
      session,
      timer:
        (this.options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS) > 0
          ? this.schedulePendingNewThreadPrompt(key)
          : undefined,
    });
    if ((this.options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS) <= 0) {
      await this.flushPendingNewThreadPrompt(key);
    }
  }

  private schedulePendingNewThreadPrompt(
    key: string,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flushPendingNewThreadPrompt(key);
    }, this.options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS);
  }

  private async flushPendingNewThreadPrompt(key: string): Promise<void> {
    const pending = this.pendingNewThreadPrompts.get(key);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingNewThreadPrompts.delete(key);
    try {
      await this.createNewThreadFromPromptBundle({
        events: pending.events,
        session: pending.session,
      });
    } catch (error) {
      this.logger.warn?.("messaging new-thread prompt failed", {
        channel: pending.session.channel.channel,
        error: error instanceof Error ? error.message : String(error),
        sessionId: pending.session.id,
      });
      await this.deliverNewThreadPromptFailure(pending, error);
    }
  }

  private async deliverNewThreadPromptFailure(
    pending: PendingNewThreadPromptWindow,
    error: unknown,
  ): Promise<void> {
    const event = pending.events[0];
    if (!event) {
      return;
    }
    try {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-start-failed"),
          createdAt: this.now(),
          title: "Thread could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        undefined,
        event,
      );
    } catch (deliveryError) {
      this.logger.debug?.("messaging new-thread failure notice failed", {
        channel: pending.session.channel.channel,
        deliveryError: deliveryError instanceof Error
          ? deliveryError.message
          : String(deliveryError),
        sessionId: pending.session.id,
      });
    }
  }

  private clearPendingNewThreadPrompt(sessionId: string): void {
    for (const [key, pending] of this.pendingNewThreadPrompts.entries()) {
      if (pending.session.id !== sessionId) {
        continue;
      }
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pendingNewThreadPrompts.delete(key);
    }
  }

  private pendingNewThreadPromptKey(session: MessagingBrowseSessionRecord): string {
    return [
      buildMessagingConversationKey(session.channel),
      session.allowedActorIds.join(","),
      session.id,
    ].join(":");
  }

  private async prepareTurnInput(
    events: MessagingTurnInputEvent[],
    binding: MessagingBindingRecord | undefined,
    event?: MessagingInboundEvent,
  ): Promise<
    | {
        input: AppServerTurnInputItem[];
        pdfAttachments: PendingPdfAttachment[];
        privateResponseRequested: boolean;
        preview: string;
      }
    | undefined
  > {
    const input: AppServerTurnInputItem[] = [];
    const pdfAttachments: PendingPdfAttachment[] = [];
    const previewParts: string[] = [];
    const rejections: MessagingAttachmentRejection[] = [];
    let pdfHandling:
      | "model_directed"
      | "render_initial_pages"
      | "pass_through"
      | undefined;
    const privateResponseStartedAt = this.now();
    const privateReplyContinuation = binding?.privateReplyContinuation;
    if (
      privateReplyContinuation
      && privateReplyContinuation.expiresAt > this.now()
    ) {
      input.push({
        type: "text",
        text: [
          PRIVATE_REPLY_COMPLETION_INSTRUCTION,
          "",
          "Initiating Agent instructions:",
          privateReplyContinuation.instructions,
        ].join("\n"),
      });
    }
    const privateResponseRequested = events.some(
      (turnEvent) => requestsExplicitPrivateResponse(turnEvent),
    );

    if (privateResponseRequested) {
      input.push({
        type: "text",
        text: PRIVATE_RESPONSE_FALLBACK_INSTRUCTION,
      });
    }
    this.addInputPreparationTiming(
      event,
      "inputPrepPrivateResponseMs",
      privateResponseStartedAt,
    );

    for (const turnEvent of events) {
      if (turnEvent.kind === "text") {
        const textConstructionStartedAt = this.now();
        const previewText = turnEvent.text.trim();
        if (previewText) {
          input.push({ type: "text", text: turnEvent.text });
          previewParts.push(previewText);
        }
        this.addInputPreparationTiming(
          event,
          "inputPrepTextConstructionMs",
          textConstructionStartedAt,
        );
        continue;
      }

      if (turnEvent.attachments.length > 0 && pdfHandling === undefined) {
        const pdfHandlingStartedAt = this.now();
        try {
          pdfHandling = await this.resolveMessagingPdfHandling(binding, event);
        } finally {
          this.addInputPreparationTiming(
            event,
            "inputPrepPdfHandlingResolutionMs",
            pdfHandlingStartedAt,
          );
        }
      }
      const attachmentProcessingStartedAt = this.now();
      const processed = await processMessagingAttachments({
        adapter: this.options.adapter,
        attachments: turnEvent.attachments,
        policy: {
          ...DEFAULT_MESSAGING_ATTACHMENT_POLICY,
          ...this.options.attachmentPolicy,
        },
        pdfHandling,
        text: turnEvent.text,
      });
      this.addInputPreparationTiming(
        event,
        "inputPrepAttachmentProcessingMs",
        attachmentProcessingStartedAt,
      );

      input.push(...processed.input);
      pdfAttachments.push(...processed.pdfAttachments);
      rejections.push(...processed.rejections);
      if (turnEvent.text?.trim()) {
        previewParts.push(turnEvent.text.trim());
      }
      for (const attachment of turnEvent.attachments) {
        previewParts.push(`[${attachment.name}]`);
      }
    }

    if (input.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("unsupported-media"),
          createdAt: this.now(),
          title: "Attachment not supported",
          body:
            rejections.length > 0
              ? formatAttachmentRejections(rejections)
              : "This attachment could not be prepared for the model.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return undefined;
    }

    if (rejections.length > 0) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("attachment-partial"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Some attachments were skipped",
          body: formatAttachmentRejections(rejections),
        }),
        binding,
        event,
      );
    }

    const previewConstructionStartedAt = this.now();
    const preview = buildQueuedInputPreview(previewParts);
    this.addInputPreparationTiming(
      event,
      "inputPrepTextConstructionMs",
      previewConstructionStartedAt,
    );

    return {
      input,
      pdfAttachments,
      privateResponseRequested,
      preview,
    };
  }

  private async revokeExpiredPrivateReplyContinuation(
    binding: MessagingBindingRecord | undefined,
  ): Promise<MessagingBindingRecord | undefined> {
    if (
      !binding?.privateReplyContinuation
      || binding.privateReplyContinuation.expiresAt > this.now()
    ) {
      return binding;
    }
    await this.options.store.revokeBinding({
      bindingId: binding.id,
      revokedAt: this.now(),
    });
    this.notifyBindingChanged("private-reply-expired");
    return undefined;
  }

  private async cleanupExpiredPrivateReplyContinuations(): Promise<void> {
    const now = this.now();
    const expired = this.filterBindingsForChannel(
      await this.options.store.findActiveBindings(),
    ).filter(
      (binding) =>
        binding.privateReplyContinuation
        && binding.privateReplyContinuation.expiresAt <= now,
    );
    for (const binding of expired) {
      await this.options.store.revokeBinding({
        bindingId: binding.id,
        revokedAt: now,
      });
    }
    if (expired.length > 0) {
      this.notifyBindingChanged("private-reply-expired");
    }
  }

  private async resolveMessagingPdfHandling(
    binding: MessagingBindingRecord | undefined,
    event?: MessagingInboundEvent,
  ): Promise<"model_directed" | "render_initial_pages" | "pass_through"> {
    if (!(await this.resolvePdfAnalysisEnabled(event))) {
      return "pass_through";
    }
    if (
      binding?.backend !== "codex" ||
      !this.options.backend.supportsMessagingPdfTools
    ) {
      return "render_initial_pages";
    }
    const pdfToolSupportStartedAt = this.now();
    try {
      return await this.options.backend.supportsMessagingPdfTools({
        backend: binding.backend,
        threadId: binding.threadId,
      })
        ? "model_directed"
        : "render_initial_pages";
    } catch (error) {
      this.logger.warn?.("could not resolve messaging PDF tool support", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
      return "render_initial_pages";
    } finally {
      this.addInputPreparationTiming(
        event,
        "inputPrepPdfToolSupportProbeMs",
        pdfToolSupportStartedAt,
      );
    }
  }

  private async resolvePdfAnalysisEnabled(
    event?: MessagingInboundEvent,
  ): Promise<boolean> {
    const pdfAnalysisPolicyStartedAt = this.now();
    const configured = this.options.pdfAnalysisEnabled;
    try {
      if (typeof configured === "function") {
        return (await configured()) !== false;
      }
      return configured !== false;
    } finally {
      this.addInputPreparationTiming(
        event,
        "inputPrepPdfAnalysisPolicyMs",
        pdfAnalysisPolicyStartedAt,
      );
    }
  }

  private async startPreparedInput(params: {
    admissionState?: MessagingThreadAdmissionState;
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    input: AppServerTurnInputItem[];
    navigation?: NavigationSnapshot;
    pdfAttachments?: PendingPdfAttachment[];
    privateResponseRequested?: boolean;
    preview: string;
    queueOnConcurrentStart?: boolean;
    threadKey: string;
  }): Promise<PreparedInputStartResult> {
    this.turnAdmission.markStarting(params.threadKey);
    let turnStarted = false;
    let startingOrigin: ActiveAgentMessagingOrigin | undefined;
    const startingThreadKey = agentMessagingThreadKey(
      params.binding.backend,
      params.binding.threadId,
    );

    try {
      const admissionState = params.admissionState
        ?? await this.options.backend.getThreadAdmissionState({
          backend: params.binding.backend,
          federationTarget: federationTargetForBinding(params.binding),
          threadId: params.binding.threadId,
        });
      this.markAdmissionStage(params.event, "admissionStateResolved");
      const navigation = params.navigation
        ?? navigationSnapshotForAdmissionState(params.binding, admissionState);
      startingOrigin = await this.buildAgentMessagingOrigin({
        binding: params.binding,
        event: params.event,
        navigation,
        privateResponseRequested: params.privateResponseRequested,
      });
      if (startingOrigin) {
        this.startingAgentMessagingOriginsByThreadKey.set(
          startingThreadKey,
          startingOrigin,
        );
      }
      this.markAdmissionStage(params.event, "originBuilt");
      const targetThreadLookupStartedAt = this.now();
      const targetThread = findThreadForBinding(navigation, params.binding);
      const targetThreadLookupCompletedAt = this.now();
      const executionModeResolutionStartedAt = this.now();
      const executionResolution = resolveExecutionModeForThread(
        params.binding,
        targetThread,
      );
      const executionModeResolutionCompletedAt = this.now();
      const turnSettingsResolutionStartedAt = this.now();
      const turnSettings = turnSettingsForThread(
        params.binding,
        targetThread,
        executionResolution,
      );
      const turnSettingsResolutionCompletedAt = this.now();
      if (
        turnSettings.executionMode === "full-access" &&
        targetThread?.executionMode === "full-access"
      ) {
        const fullAccessControlsLoadStartedAt = this.now();
        const controlsResolution = this.resolveFullAccessControls();
        const fullAccessControlsLoadAwaitCount = isPromiseLike(controlsResolution)
          ? 1
          : 0;
        const controls = isPromiseLike(controlsResolution)
          ? await controlsResolution
          : controlsResolution;
        const fullAccessControlsLoadCompletedAt = this.now();
        const resumeSettingCheckStartedAt = this.now();
        const allowed = controls.allowThreadResume;
        const resumeSettingCheckCompletedAt = this.now();
        const policyResolvedAt = this.now();
        const controlsSource = this.options.fullAccessControlsSource
          ?? (typeof this.options.fullAccessControls === "function"
            ? "dynamic"
            : "static");
        this.markAdmissionStage(params.event, "policyResolved");
        this.logger.info?.("messaging Full Access resume policy evaluated", {
          inboundEventId: params.event?.id,
          channel: params.binding.channel.channel,
          allowed,
          controlsSource,
          policyRevision: this.options.fullAccessPolicyRevision?.(),
          targetThreadFound: true,
          targetThreadLookupMs:
            targetThreadLookupCompletedAt - targetThreadLookupStartedAt,
          executionModeResolutionMs:
            executionModeResolutionCompletedAt - executionModeResolutionStartedAt,
          turnSettingsResolutionMs:
            turnSettingsResolutionCompletedAt - turnSettingsResolutionStartedAt,
          fullAccessControlsLoadMs:
            fullAccessControlsLoadCompletedAt - fullAccessControlsLoadStartedAt,
          fullAccessControlsLoadAwaitCount,
          settingsConfigReadMs:
            controlsSource === "runtime-snapshot"
              ? 0
              : fullAccessControlsLoadCompletedAt - fullAccessControlsLoadStartedAt,
          settingsConfigReadAwaitCount:
            controlsSource === "runtime-snapshot"
              ? 0
              : fullAccessControlsLoadAwaitCount,
          resumeSettingCheckMs:
            resumeSettingCheckCompletedAt - resumeSettingCheckStartedAt,
          authorizedUserPolicyCheckMs: 0,
          authorizedUserPolicyCheckAwaitCount: 0,
          allowedPathAuditPersistenceMs: 0,
          allowedPathAuditPersistenceAwaitCount: 0,
          fullAccessPolicyTotalMs: policyResolvedAt - targetThreadLookupStartedAt,
        });
        // Provider authorization already completed before turn admission.
        // An allowed Full Access resume performs no audit or persistence.
        if (!allowed) {
          await this.deliverFullAccessPolicyError(
            params.binding,
            params.event,
            "Full Access threads cannot be resumed from messaging with the current settings.",
          );
          return "failed";
        }
      } else {
        this.markAdmissionStage(params.event, "policyResolved");
      }
      // Diagnostic for #203-class regressions: a turn that the UI shows
      // as Default Access but routes to the Full Access codex client is
      // a silent security bug — the user thinks they're sandboxed but
      // commands like `npm view` succeed because the full-access client
      // skipped the network sandbox. We log the resolved mode + where
      // it came from here at the messaging layer; with Debug log collection
      // enabled, the registry's `codex thread client routing` log shows which
      // client actually received the turn. Cross-reference both lines by
      // threadId to verify the routing matched intent. `executionModeSource` of
      // anything other than `thread` is suspicious for a thread the UI
      // claims has been explicitly toggled.
      const startTurnIssuedAt = this.now();
      const inboundTiming = params.event
        ? {
            inboundEventId: params.event.id,
            providerSentAt: params.event.providerSentAt,
            pwragentReceivedAt: params.event.receivedAt,
            providerSentToPwragentReceivedMs:
              params.event.providerSentAt === undefined
                ? undefined
                : params.event.receivedAt - params.event.providerSentAt,
            pwragentReceivedToStartTurnIssueMs:
              startTurnIssuedAt - params.event.receivedAt,
          }
        : {};
      const stageTiming = this.takeAdmissionStageTiming(
        params.event,
        startTurnIssuedAt,
      );
      this.logger.info?.("messaging starting turn", {
        backend: params.binding.backend,
        bindingId: params.binding.id,
        channel: params.binding.channel.channel,
        threadId: params.binding.threadId,
        executionMode: turnSettings.executionMode ?? "unset",
        executionModeSource: executionResolution.source,
        model: turnSettings.model,
        fastMode: turnSettings.fastMode,
        startTurnIssuedAt,
        ...inboundTiming,
        ...stageTiming,
      });
      const started = await this.options.backend.startTurn({
        backend: params.binding.backend,
        federationTarget: federationTargetForBinding(params.binding),
        threadId: params.binding.threadId,
        input: params.input,
        messageOrigin: messageOriginForInboundEvent(params.event),
        ...turnSettings,
      });
      const startTurnAcceptedAt = this.now();
      const acceptanceTiming = params.event
        ? {
            pwragentReceivedToStartTurnAcceptedMs:
              startTurnAcceptedAt - params.event.receivedAt,
            startTurnIssueToAcceptedMs: startTurnAcceptedAt - startTurnIssuedAt,
            startTurnAcceptedAt,
          }
        : {
            startTurnIssueToAcceptedMs: startTurnAcceptedAt - startTurnIssuedAt,
            startTurnAcceptedAt,
          };
      if (started.queueStatus === "queued") {
        this.rememberQueuedAgentMessagingOrigin({
          binding: params.binding,
          event: params.event,
          navigation,
          origin: startingOrigin,
          queueEntryId: started.queueEntryId ?? started.turnId,
        });
        this.logger.info?.("messaging turn queued in shared thread FIFO", {
          bindingId: params.binding.id,
          threadId: params.binding.threadId,
          queueEntryId: started.queueEntryId ?? started.turnId,
          requestedExecutionMode: turnSettings.executionMode ?? "unset",
          ...acceptanceTiming,
        });
        return "queued";
      }
      turnStarted = true;
      this.logger.info?.("messaging turn started", {
        bindingId: params.binding.id,
        threadId: params.binding.threadId,
        turnId: started.turnId,
        requestedExecutionMode: turnSettings.executionMode ?? "unset",
        ...acceptanceTiming,
      });
      const activeTurn: MessagingActiveTurnSummary = {
        turnId: started.turnId,
        status: "working",
        startedAt: this.now(),
        updatedAt: this.now(),
      };
      this.pdfAttachmentStore.bindTurn(
        {
          backend: params.binding.backend,
          threadId: params.binding.threadId,
          turnId: started.turnId,
        },
        params.pdfAttachments ?? [],
      );
      this.rememberAgentMessagingOrigin({
        binding: params.binding,
        event: params.event,
        navigation,
        origin: startingOrigin,
        turnId: started.turnId,
      });
      const deliveryBinding = startingOrigin?.deliveryBinding
        ?? startingOrigin?.binding
        ?? params.binding;
      this.setActiveTurn(deliveryBinding, activeTurn);
      await this.signalTurnActivity(deliveryBinding, activeTurn, {
        force: true,
      });
      await this.renderAutomaticBindingStatus(
        deliveryBinding,
        undefined,
        navigation,
      );
      return "started";
    } catch (error) {
      if (turnStarted) {
        this.logger.debug?.("messaging post-start update failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: params.binding.threadId,
        });
        return "started";
      }
      if (isTurnInProgressStartError(error)) {
        if (params.queueOnConcurrentStart !== false) {
          await this.queuePreparedInput({
            binding: params.binding,
            event: params.event,
            input: params.input,
            pdfAttachments: params.pdfAttachments,
            privateResponseRequested: params.privateResponseRequested,
            preview: params.preview,
            threadKey: params.threadKey,
          });
          return "queued";
        }
        return "failed";
      }
      // The durable overlay outlives its provider thread, so a targeted
      // missing-thread response is the one reliable signal that a Default
      // Agent assignment is dead. Other start failures are recoverable: a
      // disconnect, rate limit, or invalid runtime option must not destroy the
      // operator's persisted route.
      if (isMissingTurnTargetStartError(error, params.binding)) {
        await this.revokeDefaultAgentRouteForFailedStart(params.binding);
      }
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("turn-start-failed"),
          createdAt: this.now(),
          title: "Turn could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        params.binding,
        params.event,
      );
      return "failed";
    } finally {
      this.turnAdmission.clearStarting(params.threadKey);
      if (
        startingOrigin
        && this.startingAgentMessagingOriginsByThreadKey.get(startingThreadKey)
          === startingOrigin
      ) {
        this.startingAgentMessagingOriginsByThreadKey.delete(startingThreadKey);
      }
    }
  }

  private async isTurnOccupied(
    binding: MessagingBindingRecord,
    threadKey: string,
    admissionState: MessagingThreadAdmissionState,
  ): Promise<boolean> {
    if (this.turnAdmission.isStarting(threadKey)) {
      return true;
    }

    const rememberedTurn = await this.reconcileActiveTurnFromThreadStatus(
      binding,
      "turn_admission",
      admissionState.threadStatus,
    );
    if (
      rememberedTurn
      && ["working", "waiting"].includes(rememberedTurn.status)
    ) {
      return true;
    }
    return Boolean(
      admissionState.activeTurn
      || admissionState.threadStatus === "active",
    );
  }

  private async adoptStartedTurn(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    navigation: NavigationSnapshot;
    turnId: string;
  }): Promise<void> {
    const currentTurn = this.getActiveTurn(params.binding);
    if (
      currentTurn?.turnId === params.turnId &&
      isTerminalTurnLifecycle(currentTurn)
    ) {
      await this.renderAutomaticBindingStatus(
        params.binding,
        undefined,
        params.navigation,
      );
      return;
    }
    const activeTurn: MessagingActiveTurnSummary = {
      turnId: params.turnId,
      status: "working",
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.setActiveTurn(params.binding, activeTurn);
    this.rememberAgentMessagingOrigin({
      binding: params.binding,
      event: params.event,
      navigation: params.navigation,
      turnId: params.turnId,
    });
    await this.signalTurnActivity(params.binding, activeTurn, {
      force: true,
    });
    await this.renderAutomaticBindingStatus(
      params.binding,
      undefined,
      params.navigation,
    );
  }

  private async queuePreparedInput(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    input: AppServerTurnInputItem[];
    pdfAttachments?: PendingPdfAttachment[];
    privateResponseRequested?: boolean;
    preview: string;
    threadKey: string;
  }): Promise<void> {
    const queued = this.turnAdmission.enqueue(params);
    await this.deliverQueuedTurnNotice(queued);
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
      body: buildQueuedTurnNoticeBody(entry.preview, canSteer),
      actions: [
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
      this.turnAdmission.updateQueuedEntry(entry, {
        surface: result.surface,
      });
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
    const targetSurface = entry.surface ?? event?.interaction;
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

  private async handleQueuedTurnCallback(
    event: MessagingInboundCallbackEvent,
    action: QueuedTurnAction,
  ): Promise<void> {
    const entry = this.turnAdmission.findQueuedEntry(action.entryId);
    if (!entry || entry.status !== "queued") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-queued-turn"),
          createdAt: this.now(),
          title: "Queued message unavailable",
          body: "That queued message is no longer waiting.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if (action.kind === "cancel") {
      const cancelled = this.turnAdmission.updateQueuedEntry(entry, {
        status: "cancelled",
      });
      await this.retireQueuedTurnNotice(
        cancelled,
        "Queued message cancelled.",
        event,
      );
      return;
    }

    const activeTurn = await this.resolveSteerableActiveTurn(
      entry.binding,
      "queued_turn_steer",
    );
    if (
      entry.pdfAttachments?.length ||
      !this.options.backend.steerTurn ||
      !activeTurn ||
      !["working", "waiting"].includes(activeTurn.status)
    ) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("queued-turn-steer-unavailable"),
          createdAt: this.now(),
          title: "Steer unavailable",
          body: "There is no active turn available to steer. The message is still queued.",
          recoverable: true,
        }),
        entry.binding,
        event,
      );
      return;
    }

    try {
      await this.options.backend.steerTurn({
        backend: entry.binding.backend,
        federationTarget: federationTargetForBinding(entry.binding),
        threadId: entry.binding.threadId,
        expectedTurnId: activeTurn.turnId,
        input: entry.input,
        requestId: entry.id,
        messageOrigin: messageOriginForInboundEvent(entry.event),
      });
    } catch (error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("queued-turn-steer-failed"),
          createdAt: this.now(),
          title: "Steer failed",
          body: `${
            error instanceof Error ? error.message : String(error)
          }\n\nThe message is still queued.`,
          recoverable: true,
        }),
        entry.binding,
        event,
      );
      return;
    }
    const steered = this.turnAdmission.updateQueuedEntry(entry, {
      status: "steered",
    });
    await this.retireQueuedTurnNotice(
      steered,
      "Queued message was sent as a steering message.",
      event,
    );
  }

  private async startNextQueuedTurn(binding: MessagingBindingRecord): Promise<void> {
    const threadKey = this.threadKeyForBinding(binding);
    const admissionState = await this.options.backend.getThreadAdmissionState({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
    });
    if (await this.isTurnOccupied(binding, threadKey, admissionState)) {
      return;
    }

    const entry = this.turnAdmission.peekNextQueued(threadKey);
    if (!entry) {
      return;
    }

    const startResult = await this.startPreparedInput({
      binding: entry.binding,
      event: entry.event,
      input: entry.input,
      pdfAttachments: entry.pdfAttachments,
      privateResponseRequested: entry.privateResponseRequested,
      preview: entry.preview,
      queueOnConcurrentStart: false,
      threadKey,
      admissionState,
    });
    if (startResult !== "started") {
      return;
    }

    const submitted = this.turnAdmission.updateQueuedEntry(entry, {
      status: "submitted",
    });
    this.turnAdmission.removeQueuedEntry(submitted);
    await this.retireQueuedTurnNotice(
      submitted,
      "Queued message sent as the next turn.",
    );
  }

  private async handleCallback(event: MessagingInboundCallbackEvent): Promise<void> {
    if (event.actionId === "agent-default:set") {
      await this.presentDefaultAgentAssignmentBrowser(event, "conversation");
      return;
    }
    if (event.actionId === "agent-default:clear") {
      await this.clearDefaultAgentAssignment(event, "conversation");
      return;
    }
    const command = readCommandAction(event);
    if (command) {
      await this.handleCommand(
        {
          ...event,
          kind: "command",
          args: [],
          command,
          rawText: `/${command}`,
        },
        {
          targetSurface: event.sourceSurface,
        },
      );
      return;
    }

    const helpAction = readHelpNavAction(event);
    if (helpAction) {
      await this.handleHelpNavCallback(event, helpAction);
      return;
    }

    const browseAction = readBrowseAction(event);
    if (browseAction) {
      await this.handleBrowseCallback(event, browseAction);
      return;
    }

    const permissionsQueueCancelAction = readPermissionsQueueCancelAction(event);
    if (permissionsQueueCancelAction) {
      await this.handlePermissionsQueueCancelCallback(
        event,
        permissionsQueueCancelAction.queueId,
      );
      return;
    }

    const monitorAction = readMonitorAction(event);
    if (monitorAction) {
      await this.handleMonitorCallback(event, monitorAction);
      return;
    }

    const fullAccessRiskAction = readFullAccessRiskAction(event);
    if (fullAccessRiskAction) {
      await this.handleFullAccessRiskCallback(event, fullAccessRiskAction);
      return;
    }

    const acpRuntimeRiskAction = readAcpRuntimeRiskAction(event);
    if (acpRuntimeRiskAction) {
      await this.handleAcpRuntimeRiskCallback(event, acpRuntimeRiskAction);
      return;
    }

    const statusAction = readStatusAction(event);
    if (statusAction) {
      await this.handleStatusCallback(event, statusAction);
      return;
    }

    const queuedTurnAction = readQueuedTurnAction(event);
    if (queuedTurnAction) {
      await this.handleQueuedTurnCallback(event, queuedTurnAction);
      return;
    }

    const bindingTarget = readBindingTarget(event);
    if (bindingTarget) {
      const navigation = await this.options.backend.getNavigationSnapshot({
        backend: "all",
      });
      const targetThread = navigation.threads.find(
        (thread) =>
          thread.source === bindingTarget.backend &&
          thread.id === bindingTarget.threadId,
      );
      // RBAC scope: binding to a thread that lives on a federated peer is
      // remote control, whatever the thread's execution mode. Gate before the
      // bind so an actor without the scope can never create a remote binding
      // (the picker also hides remote threads from them).
      if (
        !(await this.requireRemoteScope(
          event,
          targetThread ? federationTargetForThread(targetThread) : undefined,
          "resume:remote-instance",
        ))
      ) {
        return;
      }
      if (targetThread?.executionMode === "full-access") {
        // RBAC: binding a conversation to a Full Access thread needs the danger
        // permission, in addition to the global resume-full-access setting.
        if (
          !(await this.requirePermission(
            event,
            "thread.execution.full_access",
            "resume:full-access",
          ))
        ) {
          return;
        }
        if (!(await this.canResumeFullAccessThreads())) {
          await this.deliverFullAccessPolicyError(
            undefined,
            event,
            "Full Access threads cannot be resumed from messaging with the current settings.",
          );
          return;
        }
      }
      const binding = await this.bindChannelToThread(event, bindingTarget);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("bound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Thread bound",
          body: boundThreadConfirmationBody(binding, this.capabilityProfile),
          fallbackText: boundThreadFallbackText(binding, this.capabilityProfile),
        }),
        binding,
      );
      await this.renderBindingStatus(binding);
      await this.repostLastAssistantMessageForResume(binding);
      return;
    }

    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (pendingIntent) {
      const action = actionsForIntent(pendingIntent.intent).find(
        (candidate) => candidate.id === (event.actionId ?? event.interaction.id),
      );
      if (action && pendingIntent.intent.kind === "approval") {
        // RBAC (fail closed): a pending-request approval is the agent asking to
        // act OUTSIDE its sandbox (run a command, touch the network/filesystem).
        // We can't reliably prove any such request is benign, so every one
        // requires the escalation permission — never the weaker default. This
        // avoids under-classifying an exec/network approval whose payload lacks
        // the subject fields (path/grantRoot/diff/files) we can recognize.
        if (
          !(await this.requirePermission(
            event,
            "approval.respond.escalation",
            "approval:respond",
          ))
        ) {
          return;
        }
        if (await this.retireApprovalCallbackIfBackendIdle(pendingIntent, event)) {
          return;
        }
        const decision = await this.submitApprovalAction(
          pendingIntent.intent,
          action.id,
        );
        await this.retireApprovalIntent(
          pendingIntent,
          event,
          approvalResponseLabel(decision),
        );
        await this.options.store.deletePendingIntent(pendingIntent.id);
        await this.resumeBindingForPendingIntent(
          pendingIntent,
          "pending_request.submitted",
        );
        return;
      }
      if (action && pendingIntent.intent.kind === "questionnaire") {
        if (
          !(await this.requirePermission(
            event,
            "elicitation.answer",
            "questionnaire:answer",
          ))
        ) {
          return;
        }
        await this.handleQuestionnaireAction(pendingIntent, event, action);
        return;
      }
      if (action && pendingIntent.intent.kind === "review") {
        await this.handleReviewAction(pendingIntent, event, action);
        return;
      }
    }

    if ((event.actionId ?? event.interaction.id).startsWith("approval:")) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-approval"),
          createdAt: this.now(),
          title: "Approval expired",
          body: "That approval request is no longer available. Retry the command or request that needed approval.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if ((event.actionId ?? event.interaction.id).startsWith("questionnaire:")) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-questionnaire"),
          createdAt: this.now(),
          title: "Input request expired",
          body: "That input request is no longer available. Retry the command or request that needed input.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if ((event.actionId ?? event.interaction.id).startsWith("review:")) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-review"),
          createdAt: this.now(),
          title: "Review picker expired",
          body: "That review picker is no longer available. Send /review to open a new one.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("expired-callback"),
        createdAt: this.now(),
        title: "Action expired",
        body: "That action is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
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

  private async handleReviewTextAnswer(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundTextEvent,
  ): Promise<boolean> {
    if (pendingIntent.intent.kind !== "review") {
      return false;
    }

    const value = event.text.trim();
    if (!pendingIntent.intent.allowFreeform || !value) {
      return false;
    }

    let target: AppServerReviewTarget | undefined;
    if (pendingIntent.intent.review.phase === "base_branch") {
      target = { type: "baseBranch", branch: value };
    } else if (pendingIntent.intent.review.phase === "commit") {
      const [sha, ...titleParts] = value.split(/\s+/);
      if (sha) {
        target = {
          type: "commit",
          sha,
          title: titleParts.length > 0 ? titleParts.join(" ") : null,
        };
      }
    } else if (pendingIntent.intent.review.phase === "custom") {
      target = { type: "custom", instructions: value };
    }

    if (!target) {
      return false;
    }

    await this.updateReviewPendingIntent(pendingIntent, event, {
      phase: "summary",
      target,
    });
    return true;
  }

  private async handleReviewAction(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
    action: MessagingSurfaceAction,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "review") {
      return;
    }

    const value = asPlainRecord(action.value);
    const phase = pendingIntent.intent.review.phase;
    if (action.id === "review:cancel") {
      await this.cancelReviewPendingIntent(pendingIntent, event);
      return;
    }
    if (action.id === "review:back") {
      await this.updateReviewPendingIntent(pendingIntent, event, {
        phase: "summary",
      });
      return;
    }

    if (phase === "summary") {
      if (action.id === "review:summary:workspace") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "workspace",
          workspacePageIndex: 0,
        });
      } else if (action.id === "review:summary:target") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "target",
        });
      } else if (action.id === "review:summary:base-branch") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "base_branch",
        });
      } else if (action.id === "review:summary:commit") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "commit",
        });
      } else if (action.id === "review:summary:custom") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "custom",
        });
      } else if (action.id === "review:summary:reviewer") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "reviewer_provider",
        });
      } else if (action.id === "review:summary:start") {
        if (
          pendingIntent.intent.review.workspaceSelectionRequired
          && !pendingIntent.intent.review.cwd
        ) {
          await this.updateReviewPendingIntent(pendingIntent, event, {
            phase: "workspace",
            workspacePageIndex: 0,
          });
          return;
        }
        const target = pendingIntent.intent.review.target;
        if (!target) {
          await this.updateReviewPendingIntent(pendingIntent, event, {
            phase: "target",
          });
          return;
        }
        await this.submitMessagingReviewFromPending(
          pendingIntent,
          event,
          target,
        );
      }
      return;
    }

    if (
      phase === "reviewer_provider"
      || phase === "reviewer_model"
      || phase === "reviewer_effort"
    ) {
      const current = pendingIntent.intent.review.reviewer;
      if (action.id === "review:reviewer:inherit") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          clearReviewer: true,
        });
        return;
      }
      if (phase === "reviewer_provider") {
        const backend = typeof value?.backend === "string"
          ? (value.backend as AppServerBackendKind)
          : undefined;
        if (!backend) {
          return;
        }
        // Switching provider drops the model and effort: they belong to the
        // previous provider's catalog and cannot carry across.
        const entry = pendingIntent.intent.review.reviewerBackends?.find(
          (candidate) => candidate.backend === backend,
        );
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: entry?.models.length ? "reviewer_model" : "summary",
          reviewer: { backend },
        });
        return;
      }
      if (!current) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "reviewer_provider",
        });
        return;
      }
      if (phase === "reviewer_model") {
        const model = typeof value?.model === "string" ? value.model : undefined;
        const next: ModelSettingsRecent = {
          backend: current.backend,
          ...(model ? { model } : {}),
        };
        const entry = pendingIntent.intent.review.reviewerBackends?.find(
          (candidate) => candidate.backend === current.backend,
        );
        const efforts = model
          ? entry?.models.find((candidate) => candidate.id === model)
              ?.reasoningEfforts ?? []
          : [];
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: efforts.length > 0 ? "reviewer_effort" : "summary",
          reviewer: next,
        });
        return;
      }
      const reasoningEffort =
        typeof value?.reasoningEffort === "string"
          ? value.reasoningEffort
          : undefined;
      await this.updateReviewPendingIntent(pendingIntent, event, {
        phase: "summary",
        reviewer: {
          ...current,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      });
      return;
    }

    if (phase === "workspace") {
      const workspacePageIndex =
        typeof value?.pageIndex === "number" && Number.isFinite(value.pageIndex)
          ? Math.max(0, Math.trunc(value.pageIndex))
          : undefined;
      if (
        (
          action.id === "review:workspace:previous"
          || action.id === "review:workspace:next"
        )
        && workspacePageIndex !== undefined
      ) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "workspace",
          workspacePageIndex,
        });
        return;
      }
      const cwd = typeof value?.cwd === "string" ? value.cwd.trim() : "";
      const repositoryPath =
        typeof value?.repositoryPath === "string"
          ? value.repositoryPath.trim()
          : "";
      if (cwd) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          cwd,
          ...(repositoryPath ? { repositoryPath } : {}),
          resetRepositoryTarget: true,
          resetBaseBranch: true,
        });
      }
      return;
    }

    if (phase === "target") {
      const targetType =
        typeof value?.targetType === "string" ? value.targetType : undefined;
      if (targetType === "uncommittedChanges") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          target: { type: "uncommittedChanges" },
        });
      } else if (targetType === "baseBranch") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          forceBaseBranch: true,
          resetBaseBranch: true,
        });
      } else if (targetType === "commit") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "commit",
        });
      } else if (targetType === "custom") {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "custom",
        });
      }
      return;
    }

    if (phase === "base_branch") {
      const branch = typeof value?.branch === "string" ? value.branch.trim() : "";
      if (branch) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          target: { type: "baseBranch", branch },
        });
      }
      return;
    }

    if (phase === "commit") {
      const sha = typeof value?.sha === "string" ? value.sha.trim() : "";
      const title = typeof value?.title === "string" ? value.title : null;
      if (sha) {
        await this.updateReviewPendingIntent(pendingIntent, event, {
          phase: "summary",
          target: { type: "commit", sha, title },
        });
      }
    }
  }

  private async updateReviewPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
    review: {
      phase: MessagingReviewIntent["review"]["phase"];
      cwd?: string;
      repositoryPath?: string;
      workspacePageIndex?: number;
      target?: AppServerReviewTarget;
      reviewer?: ModelSettingsRecent;
      clearReviewer?: boolean;
      forceBaseBranch?: boolean;
      resetRepositoryTarget?: boolean;
      resetBaseBranch?: boolean;
    },
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "review") {
      return;
    }
    const binding = pendingIntent.bindingId
      ? await this.options.store.getBinding(pendingIntent.bindingId)
      : undefined;
    if (!binding || binding.revokedAt) {
      await this.options.store.deletePendingIntent(pendingIntent.id);
      return;
    }

    // buildReviewBranchOptions below infers the base branch from
    // thread.gitWorkingState, so this callback awaits working state for the
    // same reason presentReviewPicker does.
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: binding.backend,
      probeWorkingStates: true,
    });
    const targetSurface = pendingIntent.surface ?? (
      event.kind === "callback" ? event.interaction : undefined
    );
    const cwd = review.cwd ?? pendingIntent.intent.review.cwd;
    const repositoryPath =
      review.repositoryPath
      ?? pendingIntent.intent.review.repositoryPath;
    let target = review.target ?? pendingIntent.intent.review.target;
    if (review.resetRepositoryTarget && target?.type === "commit") {
      target = undefined;
    }
    if (
      review.resetBaseBranch
      && (
        review.forceBaseBranch
        || !target
        || target.type === "baseBranch"
      )
    ) {
      const thread = findThreadForBinding(navigation, binding);
      const workspaceThread = reviewThreadForWorkspace(thread, cwd);
      const directory = navigation.directories.find((candidate) =>
        reviewWorkspaceMatches(
          candidate.path,
          repositoryPath ?? cwd,
        ),
      );
      target = {
        type: "baseBranch",
        branch:
          buildReviewBranchOptions({ directory, thread: workspaceThread })[0]
          ?? "main",
      };
    }
    const intent = this.buildReviewIntent({
      binding,
      navigation,
      phase: review.phase,
      cwd,
      repositoryPath,
      workspacePageIndex: review.workspacePageIndex,
      target,
      ...(review.clearReviewer
        ? {}
        : {
            reviewer: review.reviewer ?? pendingIntent.intent.review.reviewer,
          }),
      reviewerBackends:
        pendingIntent.intent.review.reviewerBackends
        ?? await this.listReviewerBackends(),
      id: pendingIntent.intent.id,
      createdAt: pendingIntent.intent.createdAt,
      targetSurface,
    });
    const result = await this.deliver(intent, binding, event);
    await this.options.store.upsertPendingIntent({
      ...pendingIntent,
      intent,
      surface: result.surface ?? pendingIntent.surface,
    });
  }

  private async cancelReviewPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const binding = pendingIntent.bindingId
      ? await this.options.store.getBinding(pendingIntent.bindingId)
      : undefined;
    await this.options.store.deletePendingIntent(pendingIntent.id);
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("review-cancelled"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Review cancelled",
        body: "No review was started.",
        targetSurface: pendingIntent.surface ?? event.interaction,
        delivery: {
          mode: "update",
          replaceMarkup: true,
          fallback: "present_new",
        },
      }),
      binding && !binding.revokedAt ? binding : undefined,
      event,
    );
  }

  private async submitMessagingReviewFromPending(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
    target: AppServerReviewTarget,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "review") {
      return;
    }
    const binding = pendingIntent.bindingId
      ? await this.options.store.getBinding(pendingIntent.bindingId)
      : undefined;
    if (!binding || binding.revokedAt) {
      await this.options.store.deletePendingIntent(pendingIntent.id);
      return;
    }

    const reviewer = pendingIntent.intent.review.reviewer;
    await this.submitMessagingReview({
      binding,
      event,
      target,
      cwd: pendingIntent.intent.review.cwd,
      ...(reviewer
        ? {
            reviewBackend: reviewer.backend,
            ...(reviewer.model ? { model: reviewer.model } : {}),
            ...(reviewer.reasoningEffort
              ? { reasoningEffort: reviewer.reasoningEffort }
              : {}),
          }
        : {}),
      targetSurface: pendingIntent.surface,
      pendingIntentId: pendingIntent.id,
    });
  }

  private async submitMessagingReview(params: {
    binding: MessagingBindingRecord;
    event: MessagingInboundEvent;
    target: AppServerReviewTarget;
    cwd?: string;
    /** Reviewer override typed on the command; absent means inherit. */
    reviewBackend?: AppServerBackendKind;
    model?: string;
    reasoningEffort?: string;
    targetSurface?: MessagingSurfaceRef;
    pendingIntentId?: string;
  }): Promise<void> {
    const submitReview = this.options.backend.submitReview?.bind(
      this.options.backend,
    );
    if (!submitReview || !await this.reviewSupportedForBinding(params.binding)) {
      await this.deliverReviewUnsupported(params.binding, params.event);
      return;
    }

    try {
      const navigation = await this.options.backend.getNavigationSnapshot({
        backend: params.binding.backend,
      });
      const settings = turnSettingsForBinding(params.binding, navigation);
      const result = await submitReview({
        backend: params.binding.backend,
        threadId: params.binding.threadId,
        target: params.target,
        delivery: "inline",
        ...(params.cwd ? { cwd: params.cwd } : {}),
        // An explicit reviewer replaces the binding's inherited settings
        // wholesale — its model belongs to a different catalog.
        ...(params.reviewBackend
          ? {
              reviewBackend: params.reviewBackend,
              ...(params.model ? { model: params.model } : {}),
              ...(params.reasoningEffort
                ? { reasoningEffort: params.reasoningEffort }
                : {}),
            }
          : {
              ...(settings.model ? { model: settings.model } : {}),
              ...(settings.reasoningEffort
                ? { reasoningEffort: settings.reasoningEffort }
                : {}),
              ...(settings.serviceTier
                ? { serviceTier: settings.serviceTier }
                : {}),
              ...(settings.fastMode !== undefined
                ? { fastMode: settings.fastMode }
                : {}),
            }),
      });
      if (params.pendingIntentId) {
        await this.options.store.deletePendingIntent(params.pendingIntentId);
      }
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("review-submitted"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: result.status === "scheduled" ? "Review queued" : "Review started",
          body:
            result.status === "scheduled"
              ? `${formatReviewTarget(params.target)} will start after the active turn completes successfully.`
              : `${formatReviewTarget(params.target)} is now running.`,
          fallbackText:
            result.status === "scheduled"
              ? "Review queued until the active turn completes."
              : "Review started.",
          ...(params.targetSurface
            ? {
                targetSurface: params.targetSurface,
                delivery: {
                  mode: "update" as const,
                  replaceMarkup: true,
                  fallback: "present_new" as const,
                },
              }
            : {}),
        }),
        params.binding,
        params.event,
      );
    } catch (error) {
      this.logger.warn?.("messaging review submission failed", {
        backend: params.binding.backend,
        threadId: params.binding.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("review-submit-failed"),
          createdAt: this.now(),
          title: "Review could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        params.binding,
        params.event,
      );
    }
  }

  private async deliverReviewUnsupported(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("review-unsupported"),
        createdAt: this.now(),
        title: "Review unavailable",
        body: "This thread backend does not support code review.",
        recoverable: false,
      }),
      binding,
      event,
    );
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
    event: MessagingInboundCallbackEvent | MessagingInboundTextEvent,
  ): Promise<MessagingDeliveryResult> {
    const binding = pendingIntent.bindingId
      ? await this.options.store.getBinding(pendingIntent.bindingId)
      : undefined;
    const targetSurface = pendingIntent.surface ?? (
      event.kind === "callback" ? event.interaction : undefined
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
   * Re-render status surfaces for every binding tied to a thread on this
   * controller's channel. Used by the thread-state update bus to fan out
   * cross-surface refreshes when state changes anywhere — desktop UI,
   * Telegram callback, Discord callback — so every surface reflects the new
   * value. The reason is logged for audit only.
   */
  private async refreshStatusSurfacesForThread(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    reason: string,
    federationTarget?: FederationTarget,
  ): Promise<void> {
    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend,
        threadId,
      }),
    ).filter((binding) =>
      bindingMatchesFederationTarget(binding, federationTarget)
    );
    const renderableBindings = bindings.filter(
      (binding) => binding.statusSurface || binding.pinnedStatusSurface,
    );
    if (renderableBindings.length === 0) {
      return;
    }
    // Resolve one targeted thread projection and reuse it across every
    // binding. Thread-state bus fan-out must not rebuild unrelated navigation,
    // Git, PR, launchpad, or federation state just to repaint a status card.
    const admissionState = await this.options.backend.getThreadAdmissionState({
      backend,
      ...(federationTarget ? { federationTarget } : {}),
      threadId,
    });
    const navigation = navigationSnapshotForAdmissionState(
      renderableBindings[0]!,
      admissionState,
    );
    for (const binding of renderableBindings) {
      try {
        await this.renderBindingStatus(binding, undefined, navigation);
      } catch (error) {
        this.logger.debug?.("messaging status refresh failed", {
          backend,
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          reason,
          threadId,
        });
      }
    }
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
    try {
      const images = await resolveImages({
        backend: binding.backend,
        itemId: assistantItemIdForBackendEvent(event),
        text,
        threadId: binding.threadId,
        turnId: turnIdForBackendEvent(event),
      });
      return selectAssistantImagesForCapability(images, this.capabilityProfile);
    } catch (error) {
      this.logger.debug?.("messaging assistant image resolution failed", {
        backend: binding.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
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
    this.logger.debug?.(
      `messaging turn-failure deliver thread=${binding.threadId} binding=${binding.id} preview="${compactLogPreview(text)}"`,
    );
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("turn-failed"),
        createdAt: this.now(),
        title: "Turn failed",
        body: text,
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

  updateAuthorizedActorIds(actorIds: readonly string[]): void {
    this.authorizedActorIds.clear();
    for (const actorId of actorIds) {
      this.authorizedActorIds.add(actorId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unregisterAutomationSourceMessageDeliveryHandler();
    this.unregisterAutomationTargetMessageDeliveryHandler();
    this.turnAdmission.dispose();
    this.admissionStageMarks.clear();
    for (const timer of this.monitorTimersByBindingId.values()) {
      clearTimeout(timer);
    }
    this.monitorTimersByBindingId.clear();
    for (const timer of this.monitorTimersBySubscriptionId.values()) {
      clearTimeout(timer);
    }
    this.monitorTimersBySubscriptionId.clear();
    for (const pending of this.pendingNewThreadPrompts.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingNewThreadPrompts.clear();
    this.pendingFullAccessNewThreadPrompts.clear();
    this.toolUpdatePolicy.dispose();
    this.completedTaskMonitorTurns.clear();
    this.activeAgentMessagingOriginsByTurnKey.clear();
    this.startingAgentMessagingOriginsByThreadKey.clear();
    this.privateReplyCompletionTurnKeys.clear();
    this.terminalPrivateResponseTurnKeys.clear();
    this.privateResponseFallbackTurnKeys.clear();
    this.attemptedPrivateResponseFallbackTurnKeys.clear();
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

  /**
   * Handle navigation callbacks on the paginated help surface
   * (Prev / Next / Cancel). The page index travels in
   * `event.value.pageIndex` so help has no persistent session
   * record — re-rendering is a function of catalog + page index.
   *
   * `targetSurface` is taken from the originating callback's
   * interaction state so the help post is updated in place rather
   * than stacking new posts on every Next click.
   */
  private async handleHelpNavCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    const targetSurface: MessagingSurfaceRef | undefined = {
      channel: event.interaction.channel,
      id: event.interaction.id,
      ...(event.interaction.state ? { state: event.interaction.state } : {}),
    };
    if (actionId === "help:cancel") {
      // Replace the help body with a brief dismissal and strip the
      // action row. Mirrors the resume browser's "Resume cancelled"
      // pattern for consistent dismissed-surface UX across both
      // paginated flows.
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("help-dismissed"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Help dismissed",
          body: "Send `/help` or `@<bot> help` to see commands again.",
          actions: [],
          delivery: { mode: "update", replaceMarkup: true },
          targetSurface,
        }),
        undefined,
        event,
      );
      return;
    }
    const requestedPage = readHelpPageIndex(event);
    await this.presentHelp(event, {
      pageIndex: requestedPage,
      targetSurface,
    });
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

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      filter: parsed.query,
    });
    const selectedBackend =
      isNewThreadLaunchAction(parsed.launchAction)
        ? await this.resolveNewThreadBackendForSession(
            {
              launchpadBackend: navigation.launchpadDefaults.backend,
            },
            event,
          )
        : undefined;
    if (isNewThreadLaunchAction(parsed.launchAction) && !selectedBackend) {
      return;
    }
    const selectedDirectory = parsed.cwd
      ? navigation.directories.find(
          (directory) => directory.path === parsed.cwd || directory.key === parsed.cwd,
        )
      : undefined;
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
      mode: selectedDirectory && parsed.mode === "recents" ? "project_threads" : parsed.mode,
      pageIndex: 0,
      pageSize: resumeBrowserPageSize(this.capabilityProfile),
      preferences,
      query: parsed.query,
      returnTo: parsed.launchAction === "start_new_thread"
        ? {
            launchAction: "resume_thread",
            mode: "recents",
            pageIndex: 0,
            preferences,
            query: parsed.query,
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
    await this.renderResumeBrowser(session, navigation, event);
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

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      filter: parsed.query,
    });
    const selectedBackend =
      parsed.launchAction === "start_new_thread"
        ? await this.resolveNewThreadBackendForSession(
            {
              launchpadBackend: navigation.launchpadDefaults.backend,
            },
            event,
          )
        : undefined;
    if (parsed.launchAction === "start_new_thread" && !selectedBackend) {
      return;
    }
    const selectedDirectory = parsed.cwd
      ? navigation.directories.find(
          (directory) => directory.path === parsed.cwd || directory.key === parsed.cwd,
        )
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
      selectedProject: selectedDirectory
        ? {
            directoryKey: selectedDirectory.key,
            label: selectedDirectory.label,
            path: selectedDirectory.path,
          }
        : undefined,
      surface: options?.targetSurface,
    };
    await this.renderResumeBrowser(session, navigation, event);
  }

  private async handleDefaultAgentCommand(
    event: MessagingInboundCommandEvent,
  ): Promise<void> {
    const action = event.args[1]?.toLowerCase() ?? "show";
    const requestedScope = parseDefaultAgentScopeKind(event.args[2]);
    if (event.args[2] && !requestedScope) {
      await this.deliverDefaultAgentCommandError(
        event,
        "Scope must be conversation, parent, workspace, provider, or profile.",
      );
      return;
    }
    const scopeKind = requestedScope ?? "conversation";
    if (action === "set" || action === "change") {
      await this.presentDefaultAgentAssignmentBrowser(event, scopeKind);
      return;
    }
    if (action === "clear") {
      await this.clearDefaultAgentAssignment(event, scopeKind);
      return;
    }
    if (action !== "show") {
      await this.deliverDefaultAgentCommandError(
        event,
        "Use /agent default, /agent default set [scope], or /agent default clear [scope].",
      );
      return;
    }
    await this.presentDefaultAgentStatus(event);
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
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
        const navigation = await this.options.backend.getNavigationSnapshot({
          backend: "all",
        });
        targetLabel = navigation.threads.find(
          (thread) =>
            thread.source === effective.target.backend
            && thread.id === effective.target.threadId,
        )?.title;
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

  private async handleBrowseCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    const session = await this.findBrowseSessionForCallback(event);
    if (!session) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-browse"),
          createdAt: this.now(),
          title: "Action expired",
          body: "That browser action is no longer available. Use /resume to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      filter: session.query,
    });
    const nextSession = {
      ...session,
      updatedAt: this.now(),
    };

    if (actionId === "browse:page:next") {
      await this.renderResumeBrowser(
        { ...nextSession, pageIndex: nextSession.pageIndex + 1 },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:page:prev") {
      await this.renderResumeBrowser(
        { ...nextSession, pageIndex: Math.max(0, nextSession.pageIndex - 1) },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:projects") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "projects",
          pageIndex: 0,
          returnTo: shouldStartNewAgentThreadFromSession(session)
            ? session.returnTo ?? resumeReturnTargetForSession(session)
            : undefined,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:recents") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "recents",
          pageIndex: 0,
          returnTo: shouldStartNewAgentThreadFromSession(session)
            ? session.returnTo ?? resumeReturnTargetForSession(session)
            : undefined,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:agents") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "agents",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new") {
      const selectedBackend = await this.resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: nextSession,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      await this.renderResumeBrowser(
        {
          ...nextSession,
          backend: selectedBackend.kind,
          launchAction: shouldStartNewAgentThreadFromSession(session)
            ? "start_new_agent_thread"
            : "start_new_thread",
          mode: "new_project",
          pageIndex: 0,
          returnTo: session.returnTo ?? resumeReturnTargetForSession(nextSession),
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new-agent") {
      const selectedBackend = await this.resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: nextSession,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      await this.renderResumeBrowser(
        {
          ...nextSession,
          backend: selectedBackend.kind,
          launchAction: "start_new_agent_thread",
          mode: "new_project",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new-thread") {
      const selectedBackend = await this.resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: nextSession,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      await this.renderResumeBrowser(
        {
          ...nextSession,
          backend: selectedBackend.kind,
          launchAction: "start_new_thread",
          mode: "new_project",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:resume") {
      const target = session.returnTo;
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: target?.mode ?? "recents",
          pageIndex: target?.pageIndex ?? 0,
          preferences: target?.preferences,
          query: target?.query,
          returnTo: undefined,
          selectedProject: target?.selectedProject,
          workMode: undefined,
          branchName: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:cancel") {
      await this.retireBrowseSession(session);
      if (session.cancelDestination === "help" && session.surface) {
        await this.presentHelp(event, {
          targetSurface: session.surface,
        });
        return;
      }
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("browse-cancelled"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Resume cancelled",
          body: "No thread binding changed.",
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      return;
    }
    if (actionId === "browse:select-project") {
      const project = selectProjectFromValue(event.value);
      if (!project) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      if (isNewThreadLaunchAction(session.launchAction)) {
        await this.startNewThreadFromProject(event, session, navigation, project);
        return;
      }
      await this.renderResumeBrowser(
        {
          ...nextSession,
          mode: "project_threads",
          pageIndex: 0,
          selectedProject: project,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:new:workspace:toggle") {
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      const currentWorkMode = resolveNewThreadWorkMode({
        requestedWorkMode:
          nextSession.workMode ??
          directory?.launchpad?.workMode ??
          navigation.launchpadDefaults.workMode ??
          "local",
        directory,
      });
      const nextWorkMode =
        currentWorkMode === "worktree" || !canCreateNewThreadWorktree(directory)
          ? "local"
          : "worktree";
      const branchName = nextWorkMode === "worktree"
        ? resolveNewThreadBaseBranch(nextSession, navigation, directory)
        : undefined;
      await this.updateNewThreadStickySettings(nextSession, {
        branchName,
        workMode: nextWorkMode,
      });
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: nextWorkMode,
          branchName,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:workspace:local") {
      await this.updateNewThreadStickySettings(nextSession, {
        branchName: undefined,
        workMode: "local",
      });
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: "local",
          branchName: undefined,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:workspace:worktree") {
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      if (!canCreateNewThreadWorktree(directory)) {
        await this.presentNewThreadPromptGate(
          {
            ...nextSession,
            workMode: "local",
            branchName: undefined,
          },
          event,
          navigation,
        );
        return;
      }
      const branchName = resolveNewThreadBaseBranch(nextSession, navigation);
      await this.updateNewThreadStickySettings(nextSession, {
        branchName,
        workMode: "worktree",
      });
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: "worktree",
          branchName,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:base-branch") {
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      if (!canCreateNewThreadWorktree(directory)) {
        await this.presentNewThreadPromptGate(
          {
            ...nextSession,
            workMode: "local",
            branchName: undefined,
          },
          event,
          navigation,
        );
        return;
      }
      await this.presentNewThreadBranchPicker(nextSession, navigation, event);
      return;
    }
    if (
      actionId === "browse:new:branches:next" ||
      actionId === "browse:new:branches:previous"
    ) {
      await this.presentNewThreadBranchPicker(
        nextSession,
        navigation,
        event,
        branchPageIndexFromValue(event.value),
      );
      return;
    }
    if (actionId === "browse:new:set-base-branch") {
      const branchName = readStringValue(event.value, "branchName");
      if (!branchName) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      if (!canCreateNewThreadWorktree(directory)) {
        await this.presentNewThreadPromptGate(
          {
            ...nextSession,
            workMode: "local",
            branchName: undefined,
          },
          event,
          navigation,
        );
        return;
      }
      await this.updateNewThreadStickySettings(nextSession, {
        branchName,
        workMode: "worktree",
      });
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          workMode: "worktree",
          branchName,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:permissions") {
      if (nextSession.backend && isAcpBackendId(nextSession.backend)) {
        const summary = await this.getBackendSummary(nextSession.backend);
        const directory = nextSession.selectedProject
          ? directoryForProjectSelection(navigation, nextSession.selectedProject)
          : undefined;
        const runtimeChoices = summary
          ? buildMessagingAcpRuntimeModeSummary({
              backend: summary,
              runtime: newThreadOptionsForSession(
                nextSession,
                navigation,
                directory,
                this.streamingResponsesDefault,
                summary,
              ).acpRuntime,
            }).choices
          : [];
        if (runtimeChoices.length > 0) {
          await this.presentNewThreadAcpRuntimeModePicker(
            nextSession,
            event,
            nextSession.backend,
            navigation,
          );
        } else {
          await this.presentNewThreadPermissionsPicker(nextSession, event, navigation);
        }
        return;
      }
      await this.presentNewThreadPermissionsPicker(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:set-permissions") {
      await this.setNewThreadPermissions(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:environment") {
      await this.presentNewThreadEnvironmentPicker(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:environment:back") {
      await this.presentNewThreadPromptGate(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:set-environment") {
      await this.setNewThreadEnvironment(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:runtime-mode") {
      await this.presentNewThreadAcpRuntimeModePicker(
        nextSession,
        event,
        nextSession.backend ?? navigation.launchpadDefaults.backend,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:set-runtime-mode") {
      await this.setNewThreadAcpRuntimeMode(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:fast") {
      const fastMode = !(
        nextSession.preferences?.fastMode ??
        navigation.launchpadDefaults.fastMode ??
        false
      );
      await this.updateNewThreadStickySettings(nextSession, {
        fastMode,
      });
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences: {
            ...nextSession.preferences,
            fastMode,
            updatedAt: this.now(),
          },
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:streaming") {
      const streamingResponses = nextMessagingStreamingResponseMode(
        nextSession.preferences?.streamingResponses ?? "inherit",
        this.streamingResponsesDefault,
      );
      // Sticky-reveal so the control stays in the gate once enabled here, and
      // carries onto the created binding.
      const streamingControlRevealed =
        nextSession.preferences?.streamingControlRevealed ||
        streamingResponses === "enabled";
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences: {
            ...nextSession.preferences,
            streamingResponses,
            ...(streamingControlRevealed
              ? { streamingControlRevealed: true }
              : {}),
            updatedAt: this.now(),
          },
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:working-updates") {
      const ensured = await this.ensureNewThreadProjectLaunchpad(
        nextSession,
        navigation,
        nextSession.backend,
      );
      const currentMode =
        await this.resolveNewThreadToolUpdateMode(nextSession, ensured.directory);
      await this.presentNewThreadWorkingUpdatesPicker(
        nextSession,
        event,
        currentMode,
      );
      return;
    }
    if (actionId === "browse:new:set-working-updates") {
      const toolUpdateMode = readMessagingToolUpdateModeValue(event.value);
      if (!toolUpdateMode) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      const updatedSession = {
        ...nextSession,
        preferences: {
          ...nextSession.preferences,
          toolUpdateMode,
          updatedAt: this.now(),
        },
      };
      // This is sticky only for the selected project. The backend's broad
      // sticky flag would also freeze unrelated launchpad defaults.
      await this.updateNewThreadStickySettings(
        updatedSession,
        { messagingToolUpdateMode: toolUpdateMode },
        false,
      );
      await this.presentNewThreadPromptGate(
        updatedSession,
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:backend") {
      await this.presentNewThreadBackendPicker(nextSession, event, navigation);
      return;
    }
    if (actionId === "browse:new:set-backend") {
      const backend = readStringValue(event.value, "backend");
      const selectedBackend = await this.resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          preferredBackend: backend,
          session: nextSession,
          requirePreferred: true,
        },
        event,
      );
      if (!selectedBackend) {
        return;
      }
      const backendChanged =
        selectedBackend.kind !==
        (nextSession.backend ?? navigation.launchpadDefaults.backend);
      const updatedAt = this.now();
      const normalizedSession = normalizeNewThreadSessionForBackend(
        backendChanged
          ? clearNewThreadProviderPreferences(
              {
                ...nextSession,
                backend: selectedBackend.kind,
              },
              updatedAt,
            )
          : {
              ...nextSession,
              backend: selectedBackend.kind,
            },
        selectedBackend,
        updatedAt,
      );
      await this.updateNewThreadStickySettings(normalizedSession, {
        backend: selectedBackend.kind,
      });
      await this.presentNewThreadPromptGate(
        normalizedSession,
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:model") {
      await this.presentNewThreadModelPicker(
        nextSession,
        event,
        nextSession.backend ?? navigation.launchpadDefaults.backend,
      );
      return;
    }
    if (actionId === "browse:new:set-model") {
      const model = readStringValue(event.value, "model");
      if (!model) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      const backend = nextSession.backend ?? navigation.launchpadDefaults.backend;
      const summary = await this.getBackendSummary(backend);
      const models = summary?.launchpadOptions?.models ?? [];
      const modelOption = models.find((candidate) => candidate.id === model);
      if (summary && !modelOption) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      const directory = nextSession.selectedProject
        ? directoryForProjectSelection(navigation, nextSession.selectedProject)
        : undefined;
      const launchpadSettings = applyNavigationLaunchpadProviderSettingsPatch(
        directory?.launchpad ?? navigation.launchpadDefaults,
        { backend, model },
      );
      const reasoningEffort = summary
        ? normalizeReasoningEffortForModel(summary, modelOption, [
            launchpadSettings.reasoningEffort,
            nextSession.preferences?.reasoningEffort,
          ])
        : nextSession.preferences?.reasoningEffort;
      const preferences = {
        ...nextSession.preferences,
        model,
        updatedAt: this.now(),
      };
      if (summary && reasoningEffort === undefined) {
        delete preferences.reasoningEffort;
      } else if (reasoningEffort !== undefined) {
        preferences.reasoningEffort = reasoningEffort;
      }
      await this.updateNewThreadStickySettings(nextSession, { model });
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences,
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:new:reasoning") {
      await this.presentNewThreadReasoningPicker(
        nextSession,
        event,
        nextSession.backend ?? navigation.launchpadDefaults.backend,
      );
      return;
    }
    if (actionId === "browse:new:set-reasoning") {
      const reasoningEffort = readStringValue(event.value, "reasoningEffort");
      if (!reasoningEffort) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      await this.updateNewThreadStickySettings(nextSession, {
        reasoningEffort,
      });
      await this.presentNewThreadPromptGate(
        {
          ...nextSession,
          preferences: {
            ...nextSession.preferences,
            reasoningEffort,
            updatedAt: this.now(),
          },
        },
        event,
        navigation,
      );
      return;
    }
    if (actionId === "browse:select-thread") {
      const target = selectThreadFromValue(event.value);
      if (!target) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      const targetThread = navigation.threads.find(
        (thread) =>
          thread.source === target.backend &&
          thread.id === target.threadId &&
          federationRefsMatch(thread.federation?.ref, target.federatedThread),
      );
      if (session.mode === "agents" && !targetThread?.agent) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      if (session.launchAction === "assign_default_agent") {
        const backendSummaries = await this.loadDefaultAgentBackendSummaries();
        if (
          !session.defaultAgentScope
          || !targetThread?.agent
          || defaultAgentBackendSupport(target.backend, backendSummaries)
            !== "supported"
        ) {
          await this.deliverDefaultAgentCommandError(
            event,
            "That thread is not an eligible default Agent. Choose a Codex Agent or an ACP Agent with PwrAgent HTTP MCP tools.",
          );
          return;
        }
        const assignment: MessagingDefaultAgentAssignmentRecord = {
          id: this.newIntentId("default-agent-assignment"),
          scope: session.defaultAgentScope,
          target: {
            kind: "agent",
            backend: target.backend,
            threadId: target.threadId,
          },
          createdAt: this.now(),
          updatedAt: this.now(),
        };
        await this.options.store.upsertDefaultAgentAssignment(assignment);
        this.notifyBindingChanged("default-agent-assigned");
        await this.options.store.deleteBrowseSession(session.id);
        await this.presentDefaultAgentStatus(event, {
          notice:
            `${targetThread.title || target.threadId} is now the `
            + `${formatDefaultAgentScope(assignment.scope)} default.`,
        });
        return;
      }
      if (
        targetThread?.executionMode === "full-access" &&
        !(await this.canResumeFullAccessThreads())
      ) {
        await this.deliverFullAccessPolicyError(
          undefined,
          event,
          "Full Access threads cannot be resumed from messaging with the current settings.",
        );
        return;
      }
      // Scope: the picker hides remote threads from actors without the scope,
      // but a browse session outlives its render (it is persisted with a TTL),
      // so the selection is gated too rather than trusting the filter.
      if (
        !(await this.requireRemoteScope(
          event,
          target.federatedThread?.target,
          "resume:select:remote-instance",
        ))
      ) {
        return;
      }
      const requestedExecutionMode = session.preferences?.executionMode;
      const shouldEscalateTarget =
        requestedExecutionMode === "full-access" &&
        targetThread?.executionMode !== "full-access";
      if (shouldEscalateTarget) {
        const allowed = await this.ensureFullAccessEscalationAllowed(
          {
            backend: target.backend,
            federatedThread: target.federatedThread,
            kind: "resume-thread",
            session,
            threadId: target.threadId,
          },
          event,
        );
        if (!allowed) {
          return;
        }
      }
      const binding = await this.bindChannelToThread(event, {
        ...target,
        targetKind: session.mode === "agents" ? "agent_thread" : "thread",
      });
      const updatedBinding = session.preferences
        ? await this.updateBindingPreferences(binding, session.preferences)
        : binding;
      if (shouldEscalateTarget) {
        await this.options.backend.setThreadExecutionMode?.({
          backend: target.backend,
          federationTarget: target.federatedThread?.target,
          threadId: target.threadId,
          executionMode: "full-access",
        });
      }
      await this.options.store.deleteBrowseSession(session.id);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("bound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Thread bound",
          body: boundThreadConfirmationBody(
            updatedBinding,
            this.capabilityProfile,
          ),
          fallbackText: boundThreadFallbackText(
            updatedBinding,
            this.capabilityProfile,
          ),
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      await this.renderBindingStatus(updatedBinding, event, navigation);
      await this.repostLastAssistantMessageForResume(updatedBinding);
      return;
    }

    await this.deliverInvalidBrowseSelection(event);
  }

  private async findBrowseSessionForCallback(
    event: MessagingInboundCallbackEvent,
  ): Promise<MessagingBrowseSessionRecord | undefined> {
    const callbackHandle = await this.resolveCallbackHandleForEvent(event);
    if (callbackHandle?.browseSessionId) {
      return await this.options.store.getBrowseSession(callbackHandle.browseSessionId, {
        now: this.now(),
      });
    }
    if (callbackHandle) {
      return undefined;
    }

    return await this.options.store.findActiveBrowseSessionForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
  }

  private async retireBrowseSession(
    session: MessagingBrowseSessionRecord,
  ): Promise<void> {
    this.clearPendingNewThreadPrompt(session.id);
    this.pendingFullAccessNewThreadPrompts.delete(session.id);
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

  private async updateNewThreadStickySettings(
    session: MessagingBrowseSessionRecord,
    patch: UpdateDirectoryLaunchpadRequest["patch"],
    stickySettingsChanged = true,
  ): Promise<void> {
    const directoryKey = session.selectedProject?.directoryKey;
    if (!directoryKey || !this.options.backend.updateDirectoryLaunchpad) {
      return;
    }

    try {
      await this.options.backend.updateDirectoryLaunchpad({
        directoryKey,
        patch,
        stickySettingsChanged,
      });
    } catch (error) {
      this.logger.debug?.("messaging new-thread sticky launchpad update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolveNewThreadToolUpdateMode(
    session: MessagingBrowseSessionRecord,
    directory?: NavigationDirectorySummary,
  ): Promise<MessagingToolUpdateMode> {
    if (session.preferences?.toolUpdateMode) {
      return session.preferences.toolUpdateMode;
    }
    if (isNewAgentThreadLaunchAction(session.launchAction)) {
      return await this.resolveToolUpdateDefaultMode("agent_thread");
    }
    return (
      directory?.launchpad?.messagingToolUpdateMode
      ?? await this.resolveToolUpdateDefaultMode("thread")
    );
  }

  private async loadNewThreadBackendChoices(
    event: MessagingInboundEvent,
  ): Promise<{ backends: BackendSummary[]; selectable: BackendSummary[] } | undefined> {
    try {
      const response = await this.options.backend.listBackends?.({
        includeUnavailable: true,
      });
      if (!response) {
        throw new Error("backend discovery is unavailable");
      }
      const selectable = selectableNewThreadBackends(response.backends);
      if (selectable.length === 0) {
        await this.deliver(
          buildErrorIntent({
            id: this.newIntentId("new-thread-no-backends"),
            createdAt: this.now(),
            title: "No backends available",
            body: "No backends are available to create a thread right now.",
            recoverable: true,
          }),
          undefined,
          event,
        );
        return undefined;
      }
      return {
        backends: response.backends,
        selectable,
      };
    } catch (error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-backends-unavailable"),
          createdAt: this.now(),
          title: "Backends unavailable",
          body: "Backend choices are unavailable right now. Try /new again in a moment.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      this.logger.debug?.("messaging new-thread backend discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async resolveNewThreadBackendForSession(
    params: {
      launchpadBackend: AppServerBackendKind;
      preferredBackend?: string;
      requirePreferred?: boolean;
      session?: MessagingBrowseSessionRecord;
    },
    event: MessagingInboundEvent,
  ): Promise<BackendSummary | undefined> {
    const choices = await this.loadNewThreadBackendChoices(event);
    if (!choices) {
      return undefined;
    }

    if (params.requirePreferred) {
      const selected = choices.selectable.find(
        (backend) => backend.kind === params.preferredBackend,
      );
      if (!selected) {
        await this.deliverInvalidBrowseSelection(event);
        return undefined;
      }
      return selected;
    }

    return resolveNewThreadBackend(
      choices.backends,
      params.session?.backend ?? params.launchpadBackend,
    );
  }

  private async ensureNewThreadProjectLaunchpad(
    session: MessagingBrowseSessionRecord,
    navigation: NavigationSnapshot,
    preferredBackend?: AppServerBackendKind,
  ): Promise<{
    directory?: NavigationDirectorySummary;
    navigation: NavigationSnapshot;
  }> {
    if (!session.selectedProject || !this.options.backend.ensureDirectoryLaunchpad) {
      return {
        directory: session.selectedProject
          ? directoryForProjectSelection(navigation, session.selectedProject)
          : undefined,
        navigation,
      };
    }

    const directory = directoryForProjectSelection(navigation, session.selectedProject);
    const directoryKey =
      session.selectedProject.directoryKey ??
      directory?.key ??
      session.selectedProject.path ??
      session.selectedProject.label;
    try {
      const response = await this.options.backend.ensureDirectoryLaunchpad({
        directoryKey,
        directoryKind: directory?.kind ?? "directory",
        directoryLabel: directory?.label ?? session.selectedProject.label,
        ...((directory?.path ?? session.selectedProject.path)
          ? { directoryPath: directory?.path ?? session.selectedProject.path }
          : {}),
        ...(directory?.gitStatus?.currentBranch
          ? { currentBranch: directory.gitStatus.currentBranch }
          : {}),
        ...(preferredBackend ? { preferredBackend } : {}),
      });
      const nextDirectories = navigation.directories.map((candidate) =>
        candidate.key === directoryKey
          ? {
              ...candidate,
              launchpad: response.launchpad,
            }
          : candidate,
      );
      const nextNavigation = {
        ...navigation,
        directories: nextDirectories,
      };
      return {
        directory: nextDirectories.find((candidate) => candidate.key === directoryKey),
        navigation: nextNavigation,
      };
    } catch (error) {
      this.logger.debug?.("messaging new-thread launchpad ensure failed", {
        directoryKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        directory,
        navigation,
      };
    }
  }

  private async resolveCallbackHandleForEvent(
    event: MessagingInboundCallbackEvent,
  ): Promise<MessagingCallbackHandleRecord | undefined> {
    return await this.options.store.resolveCallbackHandle({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      handle: event.interaction.id,
      now: this.now(),
    });
  }

  private async renderResumeBrowser(
    session: MessagingBrowseSessionRecord,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.options.store.upsertBrowseSession(session);
    const browseNavigation = this.filterRemoteThreadsForActor(
      event,
      await this.navigationForResumeBrowser(session, navigation),
    );
    const intent = buildResumeIntent({
      id: this.newIntentId("resume"),
      createdAt: this.now(),
      navigation: browseNavigation,
      session,
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (!result.surface) {
      return;
    }

    await this.options.store.upsertBrowseSession({
      ...session,
      surface: result.surface,
      updatedAt: this.now(),
    });
    await this.options.store.upsertPendingIntent({
      id: intent.id,
      channel: event.channel,
      intent,
      allowedActorIds: [event.actor.platformUserId],
      createdAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
      surface: result.surface,
    });
  }

  private async startNewThreadFromProject(
    event: MessagingInboundCallbackEvent,
    session: MessagingBrowseSessionRecord,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
    project: NonNullable<ReturnType<typeof selectProjectFromValue>>,
  ): Promise<void> {
    if (!this.options.backend.materializeDirectoryLaunchpad && !this.options.backend.startThread) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-unavailable"),
          createdAt: this.now(),
          title: "New thread unavailable",
          body: "This backend does not support starting a thread from messaging yet.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const directory = directoryForProjectSelection(navigation, project);
    const selectedBackend = await this.resolveNewThreadBackendForSession(
      {
        launchpadBackend: navigation.launchpadDefaults.backend,
        session,
      },
      event,
    );
    if (!selectedBackend) {
      return;
    }
    const workMode = resolveNewThreadWorkMode({
      requestedWorkMode:
        session.workMode ??
        directory?.launchpad?.workMode ??
        navigation.launchpadDefaults.workMode ??
        "local",
      directory,
    });
    await this.presentNewThreadPromptGate(
      normalizeNewThreadSessionForBackend(
        this.withNewThreadPromptCaptureExpiry({
          ...session,
          backend: selectedBackend.kind,
          mode: "new_thread_options",
          pageIndex: 0,
          workMode,
          branchName: workMode === "worktree" ? session.branchName : undefined,
          selectedProject: project,
          updatedAt: this.now(),
          expiresAt: this.now() + this.pendingIntentTtlMs,
        }),
        selectedBackend,
        this.now(),
      ),
      event,
      navigation,
    );
  }

  private withNewThreadPromptCaptureExpiry(
    session: MessagingBrowseSessionRecord,
  ): MessagingBrowseSessionRecord {
    if (
      !isNewThreadLaunchAction(session.launchAction) ||
      session.mode !== "new_thread_options" ||
      !session.selectedProject
    ) {
      return session;
    }

    const expiresAt = this.now() + NEW_THREAD_PROMPT_CAPTURE_TTL_MS;
    return {
      ...session,
      expiresAt: Math.max(session.expiresAt, expiresAt),
      textInputExpiresAt: Math.max(
        session.textInputExpiresAt ?? session.expiresAt,
        expiresAt,
      ),
    };
  }

  private async presentNewThreadPromptGate(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation?: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
  ): Promise<void> {
    let snapshot = navigation ?? await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const backendChoices = await this.loadNewThreadBackendChoices(event);
    if (!backendChoices) {
      return;
    }
    const selectedBackend = session.backend
      ? backendChoices.selectable.find((backend) => backend.kind === session.backend)
      : resolveNewThreadBackend(
          backendChoices.backends,
          snapshot.launchpadDefaults.backend,
    );
    if (!selectedBackend) {
      await this.deliverSelectedNewThreadBackendUnavailable(event);
      return;
    }
    const effectiveSession = normalizeNewThreadSessionForBackend(
      {
        ...session,
        backend: selectedBackend.kind,
      },
      selectedBackend,
      this.now(),
    );
    const ensured = await this.ensureNewThreadProjectLaunchpad(
      effectiveSession,
      snapshot,
      selectedBackend.kind,
    );
    snapshot = ensured.navigation;
    const directory = ensured.directory ?? (effectiveSession.selectedProject
      ? directoryForProjectSelection(snapshot, effectiveSession.selectedProject)
      : undefined);
    const options = newThreadOptionsForSession(
      effectiveSession,
      snapshot,
      directory,
      this.streamingResponsesDefault,
      selectedBackend,
    );
    const canCreateWorktree = canCreateNewThreadWorktree(directory);
    const fullAccessControls = await this.resolveFullAccessControls();
    const hasMultipleBackends = backendChoices.selectable.length > 1;
    const supportsModel = (selectedBackend.launchpadOptions?.models?.length ?? 0) > 0;
    const supportsReasoning =
      (selectedBackend.launchpadOptions?.reasoningEfforts?.length ?? 0) > 0 ||
      Boolean(
        selectedBackend.launchpadOptions?.models?.some(
          (model) => model.supportsReasoning,
        ),
      );
    const supportsFast =
      Boolean(selectedBackend.launchpadOptions?.supportsFastMode) ||
      Boolean(
        selectedBackend.launchpadOptions?.models?.some((model) => model.supportsFast),
      );
    const supportsPermissionsControls =
      !isAcpBackendId(selectedBackend.kind) ||
      options.executionMode === "full-access";
    const acpRuntimeMode = isAcpBackendId(selectedBackend.kind)
      ? buildMessagingAcpRuntimeModeSummary({
          backend: selectedBackend,
          runtime: options.acpRuntime,
        })
      : undefined;
    const permissionsLabel = formatPermissionsActionDisplayLabel({
      acpRuntimeLabel: acpRuntimeMode?.currentLabel,
      current: options.executionMode,
    });
    const environmentLabel = formatNewThreadEnvironmentLabel(options);
    const supportsEnvironment =
      options.codexEnvironmentOptions.length > 0 ||
      Boolean(options.codexEnvironmentId);
    const toolUpdateMode = await this.resolveNewThreadToolUpdateMode(
      effectiveSession,
      directory,
    );
    const showStreaming = shouldShowStreamingControl(
      effectiveSession.preferences?.streamingResponses ?? "inherit",
      await this.resolveShowStreamingOption(),
      effectiveSession.preferences?.streamingControlRevealed,
    );
    await this.options.store.upsertBrowseSession(effectiveSession);
    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-ready"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: effectiveSession.id,
      createdAt: this.now(),
      delivery: effectiveSession.surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: "Ready to start",
      body: newThreadPromptGateBody(
        effectiveSession,
        options,
        selectedBackend,
        toolUpdateMode,
        showStreaming,
      ),
      fallbackText: "Send your first instruction, or use the option buttons before sending it.",
      targetSurface: effectiveSession.surface,
      actions: [
        ...(hasMultipleBackends
          ? [
              {
                id: "browse:new:backend",
                label: `Provider: ${selectedBackend.label}`,
                style: "secondary" as const,
                fallbackText: "provider",
              },
            ]
          : []),
        ...(canCreateWorktree
          ? [
              {
                id: "browse:new:workspace:toggle",
                label: `Start In: ${
                  options.workMode === "worktree" ? "New Worktree" : "Local"
                }`,
                style: "secondary" as const,
                fallbackText: "start in",
              },
            ]
          : []),
        ...(options.workMode === "worktree"
          ? [
              {
                id: "browse:new:base-branch",
                label: `Base: ${options.branchName}`,
                style: "secondary" as const,
                fallbackText: "base",
              },
            ]
          : []),
        ...(((supportsPermissionsControls &&
          (options.executionMode === "full-access" ||
            fullAccessControls.allowEscalation)) ||
          (acpRuntimeMode && acpRuntimeMode.choices.length > 0))
          ? [
              {
                id: "browse:new:permissions",
                label: `Permissions: ${permissionsLabel}`,
                style: "secondary" as const,
                fallbackText: "permissions",
              },
            ]
          : []),
        ...(supportsEnvironment
          ? [
              {
                id: "browse:new:environment",
                label: `Environment: ${environmentLabel}`,
                style: "secondary" as const,
                fallbackText: "environment",
              },
            ]
          : []),
        ...(supportsFast
          ? [
              {
                id: "browse:new:fast",
                label: options.fastMode ? "Fast: on" : "Fast: off",
                style: "secondary" as const,
                fallbackText: "fast",
              },
            ]
          : []),
        {
          id: "browse:new:working-updates",
          label: `Working Updates: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
          style: "secondary",
          fallbackText: "working updates",
        },
        ...(showStreaming
          ? [
              {
                id: "browse:new:streaming",
                label: options.streamingResponses ? "Stream: on" : "Stream: off",
                style: "secondary" as const,
                fallbackText: "stream",
              },
            ]
          : []),
        ...(supportsModel
          ? [
              {
                id: "browse:new:model",
                label: "Model",
                style: "secondary" as const,
                fallbackText: "model",
              },
            ]
          : []),
        ...(supportsReasoning && options.reasoningEffort
          ? [
              {
                id: "browse:new:reasoning",
                label: `Reasoning: ${options.reasoningEffort}`,
                style: "secondary" as const,
                fallbackText: "reasoning",
              },
            ]
          : []),
        {
          id: "browse:mode:new",
          label: "Back",
          style: "navigation",
          fallbackText: "back",
        },
        {
          id: "browse:cancel",
          label: "Cancel",
          style: "secondary",
          fallbackText: "cancel",
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (!result.surface) {
      return;
    }

    const updatedSession = {
      ...effectiveSession,
      workMode: options.workMode,
      branchName: options.workMode === "worktree" ? options.branchName : undefined,
      surface: result.surface,
      updatedAt: this.now(),
    };
    await this.options.store.upsertBrowseSession(updatedSession);
    await this.options.store.upsertPendingIntent({
      id: intent.id,
      channel: event.channel,
      intent,
      allowedActorIds: [event.actor.platformUserId],
      createdAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
      surface: result.surface,
    });
  }

  private async presentNewThreadBackendPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
  ): Promise<void> {
    const choices = await this.loadNewThreadBackendChoices(event);
    if (!choices) {
      return;
    }
    const selectedBackend =
      choices.selectable.find((backend) => backend.kind === session.backend) ??
      resolveNewThreadBackend(choices.backends, navigation.launchpadDefaults.backend);
    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-backend"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select provider",
      body: "Choose the provider for the new thread.",
      fallbackText: "Choose a provider, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...choices.selectable.map((backend, index) => ({
          id: "browse:new:set-backend",
          label: `${backend.label}${backend.kind === selectedBackend?.kind ? " ✓" : ""}`,
          style: backend.kind === selectedBackend?.kind
            ? "primary" as const
            : "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { backend: backend.kind },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async deliverSelectedNewThreadBackendUnavailable(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("new-thread-selected-backend-unavailable"),
        createdAt: this.now(),
        title: "Backend unavailable",
        body: "The selected backend is no longer available to create a thread. Use /new to start again.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async presentNewThreadBranchPicker(
    session: MessagingBrowseSessionRecord,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
    event: MessagingInboundEvent,
    pageIndex = 0,
  ): Promise<void> {
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const branches = newThreadBranchChoices(session, navigation, directory);
    const page = buildBranchPickerPage({
      branches,
      branchActionId: "browse:new:set-base-branch",
      branchValue: (branchName) => ({ branchName }),
      capabilityProfile: this.capabilityProfile,
      navActionCountBase: 2,
      navActionCountMultipage: 4,
      nextActionId: "browse:new:branches:next",
      pageIndex,
      previousActionId: "browse:new:branches:previous",
    });
    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-branch"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.now(),
      delivery: session.surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: "Pick base branch",
      body: [
        `New worktree base for ${session.selectedProject?.label ?? "this project"}.`,
        page.totalPages > 1
          ? `Page ${page.pageIndex + 1}/${page.totalPages}.`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      fallbackText: [
        "Choose a branch, or reply back.",
        ...page.branchChoices.map((choice) => choice.label),
      ].join("\n"),
      targetSurface: session.surface,
      actions: [
        ...page.branchChoices,
        ...page.pageActions,
        {
          id: "browse:new:workspace:worktree",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
        {
          id: "browse:cancel",
          label: "Cancel",
          style: "secondary" as const,
          fallbackText: "cancel",
          priority: 2,
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async presentNewThreadModelPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    backend: AppServerBackendKind,
  ): Promise<void> {
    const summary = await this.getBackendSummary(backend);
    const models = summary?.launchpadOptions?.models ?? [];
    if (models.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-models-unavailable"),
          createdAt: this.now(),
          title: "Models unavailable",
          body: "This backend did not report model choices.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }
    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-model"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select model",
      body: "Choose the model for the new thread.",
      fallbackText: "Choose a model, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...models.map((model, index) => ({
          id: "browse:new:set-model",
          label: model.label ?? model.id,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { model: model.id },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async presentNewThreadAcpRuntimeModePicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    backend: AppServerBackendKind,
    navigation: NavigationSnapshot,
  ): Promise<void> {
    const summary = await this.getBackendSummary(backend);
    if (!summary) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-runtime-unavailable"),
          createdAt: this.now(),
          title: "Permissions unavailable",
          body: "This ACP backend did not report permissions choices.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const options = newThreadOptionsForSession(
      session,
      navigation,
      directory,
      this.streamingResponsesDefault,
      summary,
    );
    const runtimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: options.acpRuntime,
    });
    if (runtimeMode.choices.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-runtime-unavailable"),
          createdAt: this.now(),
          title: "Permissions unavailable",
          body: "This ACP backend did not report permissions choices.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-runtime"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select permissions",
      body: "Choose the permissions mode for the new thread.",
      fallbackText: "Choose a permissions option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...runtimeMode.choices.map((choice, index) => ({
          id: "browse:new:set-runtime-mode",
          label: `${choice.label}${choice.selected ? " (current)" : ""}`,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: {
            optionId: choice.optionId,
            source: choice.source,
            value: choice.value,
          },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async presentNewThreadPermissionsPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: NavigationSnapshot,
  ): Promise<void> {
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const backend = await this.resolveNewThreadBackendForSession(
      {
        launchpadBackend: navigation.launchpadDefaults.backend,
        preferredBackend: session.backend,
        session,
      },
      event,
    );
    const currentMode = backend
      ? newThreadOptionsForSession(
          session,
          navigation,
          directory,
          this.streamingResponsesDefault,
          backend,
        ).executionMode
      : session.preferences?.executionMode ?? "default";
    const choices: Array<{ label: string; mode: ThreadExecutionMode }> = [
      { label: "Default", mode: "default" },
      { label: "Full Access", mode: "full-access" },
    ];
    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-permissions"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select permissions",
      body: "Choose the permissions mode for the new thread.",
      fallbackText: "Choose a permissions option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...choices.map((choice, index) => ({
          id: "browse:new:set-permissions",
          label: `${choice.label}${choice.mode === currentMode ? " (current)" : ""}`,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { executionMode: choice.mode },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async setNewThreadPermissions(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundCallbackEvent,
    navigation: NavigationSnapshot,
  ): Promise<void> {
    const executionMode = readThreadExecutionModeValue(event.value);
    if (!executionMode) {
      await this.deliverInvalidBrowseSelection(event);
      return;
    }
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const currentMode =
      session.preferences?.executionMode ??
      directory?.launchpad?.executionMode ??
      navigation.launchpadDefaults.executionMode;
    if (executionMode === currentMode) {
      await this.presentNewThreadPromptGate(session, event, navigation);
      return;
    }
    if (executionMode === "full-access") {
      const allowed = await this.ensureFullAccessEscalationAllowed(
        { kind: "new-thread", session },
        event,
      );
      if (!allowed) {
        return;
      }
    }
    await this.updateNewThreadStickySettings(session, {
      executionMode,
    });
    await this.presentNewThreadPromptGate(
      {
        ...session,
        preferences: {
          ...session.preferences,
          executionMode,
          permissionsMode: executionMode,
          updatedAt: this.now(),
        },
      },
      event,
      navigation,
    );
  }

  private async presentNewThreadEnvironmentPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: NavigationSnapshot,
  ): Promise<void> {
    const ensured = await this.ensureNewThreadProjectLaunchpad(
      session,
      navigation,
      session.backend ?? navigation.launchpadDefaults.backend,
    );
    const directory = ensured.directory ?? (session.selectedProject
      ? directoryForProjectSelection(ensured.navigation, session.selectedProject)
      : undefined);
    const options = directory?.launchpad?.codexEnvironmentOptions ?? [];
    const currentEnvironmentId = resolveNewThreadCodexEnvironmentId(
      session,
      directory?.launchpad,
    );
    if (options.length === 0 && !currentEnvironmentId) {
      await this.presentNewThreadPromptGate(session, event, navigation);
      return;
    }
    const intent = buildNewThreadEnvironmentPickerIntent({
      id: this.newIntentId("new-thread-environment"),
      browseSessionId: session.id,
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      currentEnvironmentId,
      options,
      targetSurface: session.surface,
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async setNewThreadEnvironment(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundCallbackEvent,
    navigation: NavigationSnapshot,
  ): Promise<void> {
    const ensured = await this.ensureNewThreadProjectLaunchpad(
      session,
      navigation,
      session.backend ?? navigation.launchpadDefaults.backend,
    );
    const directory = ensured.directory ?? (session.selectedProject
      ? directoryForProjectSelection(ensured.navigation, session.selectedProject)
      : undefined);
    const environmentId = readNullableStringValue(event.value, "environmentId");
    if (environmentId === undefined) {
      await this.deliverInvalidBrowseSelection(event);
      return;
    }
    const environment = environmentId === null
      ? undefined
      : directory?.launchpad?.codexEnvironmentOptions?.find(
          (candidate) => candidate.id === environmentId,
        );
    if (environmentId !== null && !environment) {
      await this.deliverInvalidBrowseSelection(event);
      return;
    }
    const codexEnvironmentActionId =
      environment && directory?.launchpad?.codexEnvironmentId === environment.id
        ? directory.launchpad.codexEnvironmentActionId
        : undefined;
    await this.updateNewThreadStickySettings(session, {
      codexEnvironmentId: environment?.id,
      codexEnvironmentExecutionTarget: environment ? "local" : undefined,
      codexEnvironmentActionId,
    });
    await this.presentNewThreadPromptGate(
      {
        ...session,
        preferences: {
          ...session.preferences,
          codexEnvironmentId: environment?.id ?? null,
          codexEnvironmentExecutionTarget: environment ? "local" : undefined,
          codexEnvironmentActionId: codexEnvironmentActionId ?? null,
          updatedAt: this.now(),
        },
      },
      event,
      ensured.navigation,
    );
  }

  private async setNewThreadAcpRuntimeMode(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundCallbackEvent,
    navigation: NavigationSnapshot,
  ): Promise<void> {
    const source = readAcpRuntimeOptionSource(event.value);
    const optionId = readStringValue(event.value, "optionId");
    const value = readStringValue(event.value, "value");
    if (!source || !optionId || !value) {
      await this.deliverInvalidBrowseSelection(event);
      return;
    }

    const backend = session.backend ?? navigation.launchpadDefaults.backend;
    const summary = await this.getBackendSummary(backend);
    if (!summary) {
      await this.deliverInvalidBrowseSelection(event);
      return;
    }
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const options = newThreadOptionsForSession(
      session,
      navigation,
      directory,
      this.streamingResponsesDefault,
      summary,
    );
    const currentRuntime = options.acpRuntime;
    const currentRuntimeMode = buildMessagingAcpRuntimeModeSummary({
      backend: summary,
      runtime: currentRuntime,
    });
    const choice = currentRuntimeMode.choices.find(
      (candidate) =>
        candidate.source === source &&
        candidate.optionId === optionId &&
        candidate.value === value,
    );
    if (!choice) {
      await this.deliverInvalidBrowseSelection(event);
      return;
    }

    const riskContext: AcpRuntimeRiskWarningContext = {
      kind: "new-thread",
      label: choice.label,
      optionId,
      sessionId: session.id,
      source,
      value,
    };
    if (
      choice.privileged &&
      !messagingAcpRuntimeValueLooksPrivileged(currentRuntimeMode.currentValue)
    ) {
      const allowed = await this.ensureAcpRuntimeModeAllowed(
        riskContext,
        event,
      );
      if (!allowed) {
        return;
      }
    }

    await this.applyNewThreadAcpRuntimeMode(session, event, navigation, riskContext);
  }

  private async applyNewThreadAcpRuntimeMode(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    navigation: NavigationSnapshot,
    selection: AcpRuntimeRiskWarningContext & { kind: "new-thread" },
  ): Promise<void> {
    const backend = session.backend ?? navigation.launchpadDefaults.backend;
    const summary = await this.getBackendSummary(backend);
    const directory = session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined;
    const currentRuntime = summary
      ? newThreadOptionsForSession(
          session,
          navigation,
          directory,
          this.streamingResponsesDefault,
          summary,
        ).acpRuntime
      : session.preferences?.acpRuntime;
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
    const executionMode = messagingAcpRuntimeValueLooksPrivileged(selection.value)
      ? "full-access"
      : "default";
    await this.updateNewThreadStickySettings(session, {
      acpRuntime,
      executionMode,
    });
    await this.presentNewThreadPromptGate(
      {
        ...session,
        preferences: {
          ...session.preferences,
          acpRuntime,
          executionMode,
          permissionsMode: executionMode,
          updatedAt: this.now(),
        },
      },
      event,
      navigation,
    );
  }

  private async presentNewThreadReasoningPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    backend: AppServerBackendKind,
  ): Promise<void> {
    const summary = await this.getBackendSummary(backend);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === session.preferences?.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    const fallbackEfforts = efforts.length > 0 ? efforts : ["low", "medium", "high"];
    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-reasoning"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Select reasoning",
      body: "Choose the reasoning effort for the new thread.",
      fallbackText: "Choose a reasoning option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...fallbackEfforts.map((effort, index) => ({
          id: "browse:new:set-reasoning",
          label: effort,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { reasoningEffort: effort },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async presentNewThreadWorkingUpdatesPicker(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    currentMode: MessagingToolUpdateMode,
  ): Promise<void> {
    const intent = buildConfirmationIntent({
      id: this.newIntentId("new-thread-working-updates"),
      capabilityProfile: this.capabilityProfile,
      browseSessionId: session.id,
      createdAt: this.now(),
      delivery: session.surface
        ? { mode: "update", replaceMarkup: true }
        : undefined,
      title: "Working Updates",
      body:
        "How much of the agent's in-progress work is bridged to this chat.\n\n"
        + "None: only final answers and questions.\n"
        + "Less / Some / More: coalesced batches that respect platform rate limits.\n"
        + "All: the most (the rate budget may still hold some back).",
      fallbackText: "Choose a Working Updates option, or reply back.",
      targetSurface: session.surface,
      actions: [
        ...messagingToolUpdateModeChoices(currentMode).map((choice, index) => ({
          id: "browse:new:set-working-updates",
          label: `${choice.label}${choice.current ? " (current)" : ""}`,
          style: "secondary" as const,
          fallbackText: String(index + 1),
          priority: 10 + index,
          value: { toolUpdateMode: choice.mode },
        })),
        {
          id: session.workMode === "worktree"
            ? "browse:new:workspace:worktree"
            : "browse:new:workspace:local",
          label: "Back",
          style: "secondary" as const,
          fallbackText: "back",
          priority: 1,
        },
      ],
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (result.surface) {
      await this.options.store.upsertBrowseSession({
        ...session,
        surface: result.surface,
        updatedAt: this.now(),
      });
    }
  }

  private async createNewThreadFromPromptBundle(
    bundle: PendingNewThreadPromptBundle,
  ): Promise<void> {
    const event = bundle.events[0];
    if (!event || !bundle.session.selectedProject) {
      return;
    }

    const prepared = await this.prepareTurnInput(bundle.events, undefined, event);
    if (!prepared) {
      return;
    }

    if (!this.options.backend.materializeDirectoryLaunchpad && !this.options.backend.startThread) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-unavailable"),
          createdAt: this.now(),
          title: "New thread unavailable",
          body: "This backend does not support starting a thread from messaging yet.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    let navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    let selectedBackend: BackendSummary | undefined;
    if (bundle.session.backend) {
      const backendChoices = await this.loadNewThreadBackendChoices(event);
      if (!backendChoices) {
        return;
      }
      selectedBackend = backendChoices.selectable.find(
        (backend) => backend.kind === bundle.session.backend,
      );
      if (!selectedBackend) {
        await this.deliverSelectedNewThreadBackendUnavailable(event);
        return;
      }
    } else {
      selectedBackend = await this.resolveNewThreadBackendForSession(
        {
          launchpadBackend: navigation.launchpadDefaults.backend,
          session: bundle.session,
        },
        event,
      );
    }
    if (!selectedBackend) {
      return;
    }
    const session = normalizeNewThreadSessionForBackend(
      {
        ...bundle.session,
        backend: selectedBackend.kind,
      },
      selectedBackend,
      this.now(),
    );
    const project = bundle.session.selectedProject;
    const ensured = await this.ensureNewThreadProjectLaunchpad(
      session,
      navigation,
      selectedBackend.kind,
    );
    navigation = ensured.navigation;
    const directory = ensured.directory ?? directoryForProjectSelection(navigation, project);
    const preferences = {
      ...session.preferences,
      toolUpdateMode: await this.resolveNewThreadToolUpdateMode(session, directory),
      updatedAt: session.preferences?.updatedAt ?? this.now(),
    };
    const options = newThreadOptionsForSession(
      session,
      navigation,
      directory,
      this.streamingResponsesDefault,
      selectedBackend,
    );
    if (options.executionMode === "full-access") {
      const decision = await this.resolveFullAccessRiskForSession(
        session,
        event,
        options,
      );
      if (decision === "blocked") {
        return;
      }
      if (decision === "warning") {
        this.pendingFullAccessNewThreadPrompts.set(session.id, {
          events: bundle.events,
          session,
        });
        await this.presentFullAccessRiskWarning(
          { kind: "new-thread", session },
          event,
          { presentationMode: "message" },
        );
        return;
      }
    }
    type StartedLaunchpadThread = Pick<
      MaterializedDirectoryLaunchpadThread,
      "backend" | "threadId" | "executionMode"
    > &
      Partial<
        Pick<
          MaterializedDirectoryLaunchpadThread,
          "codexEnvironmentRuntime" | "linkedDirectory" | "workMode"
        >
      >;
    let boundThread:
      | {
          binding: MessagingBindingRecord;
          navigation: NavigationSnapshot;
        }
      | undefined;
    let browseSessionRetired = false;
    const retireBrowseSession = async (): Promise<void> => {
      if (browseSessionRetired) {
        return;
      }
      browseSessionRetired = true;
      this.pendingFullAccessNewThreadPrompts.delete(session.id);
      await this.options.store.deleteBrowseSession(session.id);
    };
    const bindStartedThread = async (
      started: StartedLaunchpadThread,
    ): Promise<{
      binding: MessagingBindingRecord;
      navigation: NavigationSnapshot;
    }> => {
      if (boundThread) {
        return boundThread;
      }
      const binding = await this.bindChannelToThread(event, {
        backend: started.backend,
        threadId: started.threadId,
        targetKind: isNewAgentThreadLaunchAction(session.launchAction)
          ? "agent_thread"
          : undefined,
      });
      await retireBrowseSession();
      let updatedBinding = preferences
        ? await this.updateBindingPreferences(binding, preferences)
        : binding;
      if (bundle.session.surface) {
        updatedBinding = await this.options.store.upsertBinding({
          ...updatedBinding,
          statusSurface: bundle.session.surface,
          updatedAt: this.now(),
        });
      }
      const optimisticNavigation = navigationWithStartedThread({
        backend: started.backend,
        directory,
        executionMode: started.executionMode,
        linkedDirectory: started.linkedDirectory,
        navigation,
        now: this.now(),
        model: options.supportsModel ? options.model : undefined,
        reasoningEffort: options.supportsReasoning ? options.reasoningEffort : undefined,
        serviceTier: options.serviceTier,
        fastMode: options.supportsFast ? options.fastMode : undefined,
        acpRuntime: options.acpRuntime,
        codexEnvironmentRuntime: started.codexEnvironmentRuntime,
        agent: agentForNewThreadSession(session),
        preferences,
        project,
        threadId: started.threadId,
        worktreePath: started.linkedDirectory?.worktreePath,
        workMode: started.workMode ?? options.workMode,
      });
      boundThread = {
        binding: updatedBinding,
        navigation: optimisticNavigation,
      };
      return boundThread;
    };
    const launchpad = launchpadForMessagingProject({
      backend: selectedBackend.kind,
      directory,
      navigation,
      preferences,
      project,
      now: this.now(),
      workMode: options.workMode,
      branchName: options.branchName,
      options,
      acpRuntime: options.acpRuntime,
    });
    const startFirstTurnAfterEnvironmentSetup = Boolean(
      launchpad.codexEnvironmentId,
    );
    const environmentSetupReporter = startFirstTurnAfterEnvironmentSetup
      ? this.createMessagingEnvironmentSetupReporter(event)
      : undefined;
    let materialized: Awaited<
      ReturnType<NonNullable<MessagingBackendBridge["materializeDirectoryLaunchpad"]>>
    > | undefined;
    try {
      materialized = this.options.backend.materializeDirectoryLaunchpad
        ? await this.options.backend.materializeDirectoryLaunchpad(
            {
              directoryKey: messagingLaunchpadMaterializationKey(session),
              agent: agentForNewThreadSession(session),
              launchpad,
              ...(startFirstTurnAfterEnvironmentSetup
                ? {}
                : { input: prepared.input }),
            },
            {
              messageOrigin: messageOriginForInboundEvent(event),
              ...(environmentSetupReporter
                ? {
                    onCodexEnvironmentSetupProgress: (
                      setupEvent: CodexEnvironmentSetupProgressEvent,
                    ) => {
                      environmentSetupReporter.record(setupEvent);
                    },
                  }
                : {}),
              onThreadMaterialized: async (started) => {
                await bindStartedThread(started);
              },
            },
          )
        : undefined;
    } finally {
      await environmentSetupReporter?.stop();
    }
    const started = materialized ?? (await this.options.backend.startThread!({
      backend: selectedBackend.kind,
      cwd: directory?.path ?? project.path,
      directoryKey: directory?.key,
      executionMode: options.executionMode,
      fastMode: options.supportsFast ? options.fastMode : undefined,
      model: options.supportsModel ? options.model : undefined,
      reasoningEffort: options.supportsReasoning ? options.reasoningEffort : undefined,
      serviceTier: options.serviceTier,
      acpRuntime: options.acpRuntime,
      agent: agentForNewThreadSession(session),
      ...(options.workMode === "worktree"
        ? {
            workMode: "worktree" as const,
            branchName: options.branchName,
          }
        : {}),
    }));
    const {
      binding: updatedBinding,
      navigation: optimisticNavigation,
    } = await bindStartedThread(started);
    await retireBrowseSession();
    if (startFirstTurnAfterEnvironmentSetup && materialized) {
      await this.deliverMessagingEnvironmentSetupFinal({
        binding: updatedBinding,
        event,
        materialized,
      });
      await this.renderBindingStatus(updatedBinding, event, optimisticNavigation);
    }
    if (materialized?.turnStartFailure) {
      const activeTurn = this.getActiveTurn(updatedBinding);
      if (activeTurn?.status === "failed") {
        await this.renderBindingStatus(updatedBinding, event, optimisticNavigation);
        return;
      }
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("turn-start-failed"),
          createdAt: this.now(),
          title: "Turn could not start",
          body: materialized.turnStartFailure.message,
          recoverable: true,
        }),
        updatedBinding,
        event,
      );
      await this.renderBindingStatus(updatedBinding, event, optimisticNavigation);
      return;
    }
    if (materialized?.turnId) {
      this.logger.info?.("messaging materialized launchpad turn started", {
        bindingId: updatedBinding.id,
        threadId: started.threadId,
        turnId: materialized.turnId,
      });
      await this.adoptStartedTurn({
        binding: updatedBinding,
        event,
        navigation: optimisticNavigation,
        turnId: materialized.turnId,
      });
      return;
    }
    if (startFirstTurnAfterEnvironmentSetup) {
      await this.startPreparedInput({
        binding: updatedBinding,
        input: prepared.input,
        preview: prepared.preview,
        threadKey: buildThreadIdentityKey(started.backend, started.threadId),
        event,
        navigation: optimisticNavigation,
      });
      return;
    }
    if (materialized) {
      this.logger.debug?.("messaging materialized launchpad without turn id", {
        bindingId: updatedBinding.id,
        threadId: started.threadId,
      });
    }
    await this.startPreparedInput({
      binding: updatedBinding,
      input: prepared.input,
      preview: prepared.preview,
      threadKey: buildThreadIdentityKey(started.backend, started.threadId),
      event,
      navigation: optimisticNavigation,
    });
  }

  private createMessagingEnvironmentSetupReporter(
    event: MessagingInboundEvent,
  ): {
    record: (setupEvent: CodexEnvironmentSetupProgressEvent) => void;
    stop: () => Promise<void>;
  } {
    let latestEvent: CodexEnvironmentSetupProgressEvent | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let deliveryQueue: Promise<void> = Promise.resolve();
    let stopped = false;

    const deliverProgress = (setupEvent: CodexEnvironmentSetupProgressEvent) => {
      deliveryQueue = deliveryQueue.then(async () => {
        try {
          await this.deliver(
            buildConfirmationIntent({
              id: this.newIntentId("environment-setup-progress"),
              capabilityProfile: this.capabilityProfile,
              createdAt: this.now(),
              title: "Environment setup running",
              body: buildMessagingEnvironmentSetupProgressBody(setupEvent),
            }),
            undefined,
            event,
          );
        } catch (error) {
          this.logger.debug?.("messaging environment setup progress deliver failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    };

    const ensureInterval = () => {
      if (interval || stopped) {
        return;
      }
      interval = setInterval(() => {
        if (latestEvent && !isTerminalCodexEnvironmentSetupProgress(latestEvent)) {
          deliverProgress(latestEvent);
        }
      }, MESSAGING_ENVIRONMENT_SETUP_PROGRESS_INTERVAL_MS);
    };

    return {
      record: (setupEvent) => {
        latestEvent = setupEvent;
        if (setupEvent.phase === "started") {
          deliverProgress(setupEvent);
          ensureInterval();
          return;
        }
        if (isTerminalCodexEnvironmentSetupProgress(setupEvent)) {
          if (interval) {
            clearInterval(interval);
            interval = undefined;
          }
          return;
        }
        ensureInterval();
      },
      stop: async () => {
        stopped = true;
        if (interval) {
          clearInterval(interval);
          interval = undefined;
        }
        await deliveryQueue;
      },
    };
  }

  private async deliverMessagingEnvironmentSetupFinal(params: {
    binding: MessagingBindingRecord;
    event: MessagingInboundEvent;
    materialized: MaterializedDirectoryLaunchpadThread;
  }): Promise<void> {
    const runtime = params.materialized.codexEnvironmentRuntime;
    const failure = params.materialized.codexEnvironmentStartupFailure;
    if (failure) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("environment-startup-failed"),
          createdAt: this.now(),
          title: failure.phase === "action"
            ? "Environment action failed"
            : "Environment setup failed",
          body: buildMessagingEnvironmentSetupFailureBody(runtime, failure.message),
          recoverable: true,
        }),
        params.binding,
        params.event,
      );
      return;
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("environment-startup-succeeded"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: runtime?.setupStatus === "skipped"
          ? "Environment setup skipped"
          : "Environment setup completed",
        body: buildMessagingEnvironmentSetupSuccessBody(runtime),
      }),
      params.binding,
      params.event,
    );
  }

  private async navigationForResumeBrowser(
    session: MessagingBrowseSessionRecord,
    navigation: NavigationSnapshot,
  ): Promise<NavigationSnapshot> {
    if (session.launchAction === "assign_default_agent") {
      const backendSummaries = await this.loadDefaultAgentBackendSummaries();
      const threads = navigation.threads.filter(
        (thread) =>
          Boolean(thread.agent)
          && defaultAgentBackendSupport(thread.source, backendSummaries)
            === "supported",
      );
      return filterNavigationToThreads(navigation, threads);
    }
    if (session.launchAction !== "resume_thread") {
      return navigation;
    }
    if (await this.canResumeFullAccessThreads()) {
      return navigation;
    }
    const threads = navigation.threads.filter(
      (thread) => thread.executionMode !== "full-access",
    );
    return filterNavigationToThreads(navigation, threads);
  }

  private async loadDefaultAgentBackendSummaries(): Promise<
    BackendSummary[] | undefined
  > {
    if (!this.options.backend.listBackends) {
      return undefined;
    }
    try {
      return (await this.options.backend.listBackends({
        includeUnavailable: true,
      })).backends;
    } catch (error) {
      this.logger.debug?.("default Agent backend capability lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
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

    await this.recreateBindingStatus(binding, event);
  }

  private async handleMonitorCommand(event: MessagingInboundCommandEvent): Promise<void> {
    const action = normalizeMonitorCommandAction(event.args);
    if (
      action.kind === "topics-adopt" ||
      action.kind === "topics-cleanup" ||
      action.kind === "topics-fanout"
    ) {
      await this.handleMonitorTopicCommand(event, action);
      return;
    }
    if (action.kind === "stop") {
      await this.stopMonitoringForChannel(event);
      return;
    }

    await this.enableAndRenderChannelMonitor(event, action);
  }

  private async handleMonitorCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    if (actionId === "monitor:topics" || actionId.startsWith("monitor:topics:")) {
      await this.handleMonitorTopicCallback(event, actionId);
      return;
    }
    if (actionId === "monitor:stop") {
      await this.stopMonitoringForChannel(event);
      return;
    }

    await this.enableAndRenderChannelMonitor(event, normalizeMonitorCallbackAction(actionId));
  }

  private async handleMonitorTopicCommand(
    event: MessagingInboundCommandEvent,
    action: Extract<
      MonitorCommandAction,
      { kind: "topics-adopt" | "topics-cleanup" | "topics-fanout" }
    >,
  ): Promise<void> {
    if (event.channel.channel !== "telegram") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("topics-unsupported"),
          createdAt: this.now(),
          title: "Topic management unavailable",
          body: "Topic cleanup and fanout are currently implemented for Telegram supergroup topics only.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const topic = await this.resolveMonitorControlTopic(event);
    if (!topic) {
      return;
    }
    const topicEvent = this.eventForManagedTopic(
      event,
      topic,
      action.kind === "topics-cleanup"
        ? ["topics", "cleanup"]
        : action.kind === "topics-fanout"
          ? ["topics", "fanout"]
          : ["topics"],
    );
    if (action.kind === "topics-cleanup") {
      await this.renderTopicCleanupProposal(topicEvent, topic);
      return;
    }
    if (action.kind === "topics-fanout") {
      await this.runTopicMonitorFanout(topicEvent, topic);
      return;
    }

    await this.renderTopicControlStatus(topicEvent, topic);
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

    if (!this.options.adapter.createManagedConversation) {
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

    const result = await this.options.adapter.createManagedConversation({
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
        actorIds: this.monitorAuthorizedActorIds(event),
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

  private async handleMonitorTopicCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    if (actionId === "monitor:topics:cleanup") {
      await this.handleMonitorTopicCommand(
        {
          ...event,
          kind: "command",
          command: "monitor",
          args: ["topics", "cleanup"],
          rawText: "/monitor topics cleanup",
        },
        { kind: "topics-cleanup" },
      );
      return;
    }
    if (actionId === "monitor:topics:fanout") {
      await this.handleMonitorTopicCommand(
        {
          ...event,
          kind: "command",
          command: "monitor",
          args: ["topics", "fanout"],
          rawText: "/monitor topics fanout",
        },
        { kind: "topics-fanout" },
      );
      return;
    }
    const approvePrefix = "monitor:topics:approve:";
    if (!actionId.startsWith(approvePrefix)) {
      await this.handleMonitorTopicCommand(
        {
          ...event,
          kind: "command",
          command: "monitor",
          args: ["topics"],
          rawText: "/monitor topics",
        },
        { kind: "topics-adopt" },
      );
      return;
    }

    const approvalKey = actionId.slice(approvePrefix.length);
    const separatorIndex = approvalKey.lastIndexOf(":");
    const proposalId = separatorIndex > 0 ? approvalKey.slice(0, separatorIndex) : "";
    const itemId = separatorIndex > 0 ? approvalKey.slice(separatorIndex + 1) : "";
    if (!proposalId || !itemId) {
      await this.deliverInvalidTopicApproval(event);
      return;
    }
    const proposal = await this.options.store.getTopicCleanupProposal(proposalId);
    const item = proposal?.items.find((candidate) => candidate.id === itemId);
    if (!proposal || proposal.status !== "pending" || !item) {
      await this.deliverInvalidTopicApproval(event);
      return;
    }

    const topic = await this.options.store.getManagedTopic(item.topicRecordId);
    if (!topic) {
      await this.deliverInvalidTopicApproval(event);
      return;
    }

    let result: MessagingManagedConversationActionResult | undefined;
    if (item.action === "close") {
      result = await this.options.adapter.closeManagedConversation?.({
        actor: event.actor,
        channel: topicChannelRef(topic),
        routingState: topic.routingState,
      });
    } else if (item.action === "delete") {
      result = await this.options.adapter.deleteManagedConversation?.({
        actor: event.actor,
        channel: topicChannelRef(topic),
        routingState: topic.routingState,
      });
    }
    const now = this.now();
    if (!result || result.outcome !== "updated") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("topics-approval-failed"),
          createdAt: now,
          title: "Topic action failed",
          body: result?.errorMessage ?? "The Telegram adapter could not apply that topic action.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.options.store.upsertManagedTopic({
      ...topic,
      closedAt: item.action === "close" ? now : topic.closedAt,
      deletedAt: item.action === "delete" ? now : topic.deletedAt,
      lifecycle: item.action === "delete" ? "deleted" : "closed",
      recommendation: item.action,
      updatedAt: now,
    });
    await this.options.store.upsertTopicCleanupProposal({
      ...proposal,
      appliedAt: now,
      status: "applied",
      updatedAt: now,
    });
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("topics-action-applied"),
        capabilityProfile: this.capabilityProfile,
        createdAt: now,
        title: "Topic action applied",
        body: `${item.action === "delete" ? "Deleted" : "Closed"} ${topic.title ?? topic.topicId}.`,
        actions: [],
      }),
      undefined,
      event,
    );
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
    const rights = await this.options.adapter.getManagedConversationRights?.({
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
      authorizedActorIds: this.monitorAuthorizedActorIds(event),
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
    if (!this.options.adapter.createManagedConversation) {
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

    const snapshot = await this.options.backend.getNavigationSnapshot({ backend: "all" });
    const selected = selectMonitorThreads({ navigation: snapshot }).threads.slice(0, 3);
    const created: string[] = [];
    const reused: string[] = [];
    const failed: string[] = [];
    for (const thread of selected) {
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
      const result = await this.options.adapter.createManagedConversation({
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
          actorIds: this.monitorAuthorizedActorIds(event),
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

    await this.bindChannelToThread(
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
        actorIds: this.monitorAuthorizedActorIds(event),
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
        actorIds: this.monitorAuthorizedActorIds(event),
        channel: event.channel.channel,
        conversation: event.channel.conversation,
        now,
        routingState: event.routingState,
        source: options.source,
      }),
      ...existing,
      authorizedActorIds: existing?.authorizedActorIds.length
        ? existing.authorizedActorIds
        : this.monitorAuthorizedActorIds(event),
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
        : this.monitorAuthorizedActorIds(event),
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

  private monitorAuthorizedActorIds(event: MessagingInboundEvent): string[] {
    return this.authorizedActorIds.size > 0
      ? [...this.authorizedActorIds]
      : [event.actor.platformUserId];
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

  private async handleStatusCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    // RBAC top-guard: every status/handoff action maps to a permission through
    // the shared lookup table, so one check covers every mutation method below
    // without touching each individually. Unmapped actions (skills sub-nav)
    // fall through ungated. The full-access double-gate is enforced deeper, at
    // ensureFullAccessEscalationAllowed / ensureAcpRuntimeModeAllowed.
    const requiredPermission = permissionForActionId(actionId);
    if (
      requiredPermission &&
      !(await this.requirePermission(event, requiredPermission, actionId))
    ) {
      if (
        actionId === "status:stop"
        && readStringValue(event.value, "source") === "agent_session_stopped"
      ) {
        const binding = await this.options.store.findActiveBindingForChannel(
          event.channel,
        );
        const activeTurn = binding ? this.getActiveTurn(binding) : undefined;
        if (binding && activeTurn) {
          await this.signalTurnActivity(binding, activeTurn, {
            force: true,
            reason: "agent_session_stop_denied",
          });
        }
      }
      return;
    }
    // Detach is exempt: it removes the LOCAL binding record and never touches
    // the peer. Gating it would strand an actor whose scope was revoked while
    // bound to a remote thread — unable to act, and unable to let go either.
    if (actionId === "status:detach") {
      await this.detachBinding(event);
      return;
    }

    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    // Scope gate: a binding created while the actor still had remote scope (or
    // by an operator) must not stay drivable after the scope is revoked.
    if (
      !(await this.requireRemoteScopeForBinding(
        event,
        binding,
        `${actionId}:remote-instance`,
      ))
    ) {
      return;
    }
    if (!binding) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-expired"),
          createdAt: this.now(),
          title: "Action expired",
          body: "That status action is no longer available. Use /status to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if (actionId === "status:refresh" || actionId === "handoff:back-to-status") {
      if (
        actionId === "status:refresh" &&
        await this.dismissActiveSkillsWorkflow(binding, event)
      ) {
        return;
      }
      // "Back" buttons from handoff sub-flows resolve to a status card
      // refresh, same as an explicit Refresh tap.
      await this.clearActiveBindingSubmodeIntent(event, binding);
      await this.renderBindingStatus(binding, event);
      return;
    }
    if (actionId === "status:skills") {
      await this.presentSkillsBrowser(binding, event);
      return;
    }
    if (actionId === "skills:next" || actionId === "skills:previous") {
      const page = skillsBrowserPageFromValue(event.value);
      await this.presentSkillsBrowser(binding, event, page);
      return;
    }
    if (actionId === "skills:search") {
      await this.presentSkillsSearchPrompt(binding, event);
      return;
    }
    if (actionId === "skills:cancel" || actionId === "skills:search:cancel") {
      await this.dismissActiveSkillsWorkflow(binding, event, {
        allowCallbackFallback: true,
      });
      return;
    }
    if (actionId === "skills:select") {
      await this.selectPendingSkill(binding, event);
      return;
    }
    if (actionId === "skills:remove") {
      await this.removePendingSkill(binding, event);
      return;
    }
    if (actionId === "status:handoff") {
      await this.presentHandoffOverview(binding, event);
      return;
    }
    if (actionId === "handoff:cancel") {
      await this.clearActiveHandoffIntent(event);
      await this.renderBindingStatus(binding, event);
      return;
    }
    if (actionId === "handoff:move-branch" || actionId === "handoff:local-to-worktree") {
      await this.presentHandoffBranchPicker(binding, event);
      return;
    }
    if (actionId === "handoff:create-detached") {
      await this.presentHandoffConfirmation(binding, event);
      return;
    }
    if (
      actionId === "handoff:branches:next" ||
      actionId === "handoff:branches:previous"
    ) {
      await this.presentHandoffBranchPicker(
        binding,
        event,
        branchPageIndexFromValue(event.value),
      );
      return;
    }
    if (actionId === "handoff:worktree-to-local") {
      await this.presentHandoffConfirmation(binding, event);
      return;
    }
    if (actionId === "handoff:select-leave-branch") {
      await this.presentHandoffConfirmation(binding, event);
      return;
    }
    if (actionId === "handoff:confirm") {
      await this.executeHandoff(binding, event);
      return;
    }
    if (actionId === "status:model") {
      await this.presentModelPicker(binding, event);
      return;
    }
    if (actionId === "status:reasoning") {
      await this.presentReasoningPicker(binding, event);
      return;
    }
    if (actionId === "status:runtime-mode") {
      await this.presentStatusAcpRuntimeModePicker(binding, event);
      return;
    }
    if (actionId === "status:set-model") {
      await this.setBindingModel(binding, event);
      return;
    }
    if (actionId === "status:set-reasoning") {
      await this.setBindingReasoning(binding, event);
      return;
    }
    if (actionId === "status:set-runtime-mode") {
      await this.setBindingAcpRuntimeMode(binding, event);
      return;
    }
    if (actionId === "status:set-permissions") {
      await this.setBindingPermissionsMode(binding, event);
      return;
    }
    if (actionId === "status:set-tool-updates") {
      await this.setToolUpdateMode(binding, event);
      return;
    }
    if (actionId === "status:set-response-mode") {
      await this.setBindingResponseMode(binding, event);
      return;
    }
    if (actionId === "status:fast") {
      await this.toggleFastMode(binding, event);
      return;
    }
    if (actionId === "status:permissions") {
      if (isAcpBackendId(binding.backend)) {
        const summary = await this.getBackendSummary(
          binding.backend,
          federationTargetForBinding(binding),
        );
        const navigation = await this.options.backend.getNavigationSnapshot({
          backend: "all",
          federationTarget: federationTargetForBinding(binding),
        });
        const thread = findThreadForBinding(navigation, binding);
        const runtimeMode = buildMessagingAcpRuntimeModeSummary({
          backend: summary,
          runtime: thread?.acpRuntime ?? binding.preferences?.acpRuntime,
        });
        if (runtimeMode.choices.length > 0) {
          await this.presentStatusAcpRuntimeModePicker(binding, event);
        } else {
          await this.presentPermissionsPicker(binding, event);
        }
      } else {
        await this.presentPermissionsPicker(binding, event);
      }
      return;
    }
    if (actionId === "status:tool-updates") {
      await this.presentToolUpdateModePicker(binding, event);
      return;
    }
    if (actionId === "status:response-mode") {
      await this.presentResponseModePicker(binding, event);
      return;
    }
    if (actionId === "status:streaming") {
      await this.cycleStreamingResponseMode(binding, event);
      return;
    }
    if (actionId === "status:stop") {
      await this.stopActiveTurn(binding, event);
      return;
    }
    if (actionId === "status:compact") {
      await this.compactThread(binding, event);
      return;
    }
    if (actionId === "status:sync-name") {
      await this.syncConversationName(binding, event);
      return;
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("status-action-pending"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Status action unavailable",
        body: "Use /status to refresh. This control will be wired to backend actions in the next implementation slice.",
      }),
      binding,
    );
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
      const navigation = await this.options.backend.getNavigationSnapshot({
        backend: "all",
      });
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
          entries: flattenSkillEntries(response.data),
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

  private async clearActiveBindingSubmodeIntent(
    event: MessagingInboundEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    while (true) {
      const pendingIntent =
        await this.options.store.findActivePendingIntentForChannel({
          actorId: event.actor.platformUserId,
          channel: event.channel,
          now: this.now(),
        });
      if (
        !pendingIntent ||
        pendingIntent.bindingId !== binding.id ||
        pendingIntent.intent.requestContext
      ) {
        return;
      }
      await this.options.store.deletePendingIntent(pendingIntent.id);
    }
  }

  private async hasActiveBindingSubmodeIntent(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    const statusSurface = binding.statusSurface ?? binding.pinnedStatusSurface;
    if (!statusSurface) {
      return false;
    }
    for (const actorId of binding.authorizedActorIds) {
      const pendingIntent =
        await this.options.store.findActivePendingIntentForChannel({
          actorId,
          channel: binding.channel,
          now: this.now(),
        });
      if (
        pendingIntent?.bindingId === binding.id &&
        !pendingIntent.intent.requestContext &&
        pendingIntent.surface?.channel === statusSurface.channel &&
        pendingIntent.surface.id === statusSurface.id
      ) {
        return true;
      }
    }
    return false;
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

    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
    const context = handoffContextForBinding(binding, navigation);
    if (!context) {
      await this.deliverHandoffUnavailable(binding, event, "This thread does not have enough Git workspace metadata for handoff.");
      return;
    }

    await this.deliverAndStoreStatusSubmode(
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

  private async presentHandoffBranchPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    pageIndex = 0,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
    const context = handoffContextForBinding(binding, navigation);
    if (!context || context.workspaceKind !== "local") {
      await this.deliverHandoffUnavailable(binding, event, "This thread is not currently in a Local workspace that can move to a worktree.");
      return;
    }
    if (context.leaveLocalBranches.length === 0) {
      await this.deliverHandoffUnavailable(binding, event, "No safe branch choices are available to leave checked out in Local.");
      return;
    }

    await this.deliverAndStoreStatusSubmode(
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

    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
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

    await this.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffConfirmationIntent({
          id: this.newIntentId("handoff-confirm"),
          capabilityProfile: this.capabilityProfile,
          binding,
          context,
          createdAt: this.now(),
          leaveLocalBranch: request.leaveLocalBranch,
          strategy: request.strategy,
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

    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
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
      const refreshedNavigation = await this.options.backend.getNavigationSnapshot({
        backend: "all",
      });
      const updatedBinding = await this.updateBindingAfterHandoff(
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
      await this.renderBindingStatus(updatedBinding, event, refreshedNavigation);
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

  private async updateBindingAfterHandoff(
    binding: MessagingBindingRecord,
    _result: HandoffThreadWorkspaceResponse,
  ): Promise<MessagingBindingRecord> {
    // Live navigation now owns status display metadata; keep the binding current
    // without restoring legacy threadDisplay cache fields that the store strips.
    return await this.options.store.upsertBinding({
      ...binding,
      updatedAt: this.now(),
    });
  }

  private async deliverAndStoreStatusSubmode(
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
    await this.options.store.upsertBinding({
      ...binding,
      statusSurface: result.surface,
      updatedAt: this.now(),
    });
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      federationTarget: federationTargetForBinding(binding),
    });
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
      navigation.launchpadDefaults.model ??
      models.find((model) => model.current)?.id;

    await this.deliver(
      buildStatusModelPickerIntent({
        id: this.newIntentId("status-model-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        currentModelId,
        models,
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      federationTarget: federationTargetForBinding(binding),
    });
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === thread?.model) ??
      models.find((model) => model.id === binding.preferences?.model) ??
      models.find((model) => model.id === navigation.launchpadDefaults.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    if (summary && efforts.length === 0) {
      await this.renderBindingStatus(binding, event);
      return;
    }
    const fallbackEfforts = efforts.length > 0 ? efforts : ["low", "medium", "high"];
    const currentReasoningEffort =
      resolveReasoningEffortForModel(summary, modelOption, [
        thread?.reasoningEffort,
        binding.preferences?.reasoningEffort,
        navigation.launchpadDefaults.reasoningEffort,
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
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

    await this.deliverAndStoreStatusSubmode(
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const thread = findThreadForBinding(navigation, binding);
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    await this.deliverAndStoreStatusSubmode(
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
      await this.resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
    );
    await this.deliverAndStoreStatusSubmode(
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
    await this.deliverAndStoreStatusSubmode(
      buildStatusResponseModePickerIntent({
        id: this.newIntentId("status-response-mode-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        defaultMode: await this.responseModeForConversation(binding.channel),
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      federationTarget: federationTargetForBinding(binding),
    });
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption = models.find((candidate) => candidate.id === model);
    if (summary && !modelOption) {
      await this.renderBindingStatus(binding, event);
      return;
    }
    let updatedBinding = await this.updateBindingPreferences(binding, { model });
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
      updatedBinding = await this.updateBindingPreferences(updatedBinding, {
        reasoningEffort,
      });
    }
    const optimisticNavigation: NavigationSnapshot = {
      ...navigation,
      threads: navigation.threads.map((candidate) =>
        candidate.source === binding.backend &&
        candidate.id === binding.threadId &&
        federationRefsMatch(candidate.federation?.ref, binding.federatedThread)
          ? {
              ...candidate,
              model,
              ...(settingsResponse ? { reasoningEffort } : {}),
            }
          : candidate,
      ),
    };
    await this.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.renderBindingStatus(updatedBinding, event, optimisticNavigation);
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      federationTarget: federationTargetForBinding(binding),
    });
    const thread = findThreadForBinding(navigation, binding);
    const models = summary?.launchpadOptions?.models ?? [];
    const modelOption =
      models.find((model) => model.id === thread?.model) ??
      models.find((model) => model.id === binding.preferences?.model) ??
      models.find((model) => model.id === navigation.launchpadDefaults.model) ??
      defaultBackendModel(models);
    const efforts = reasoningEffortsForModel(summary, modelOption);
    if (summary && !efforts.includes(reasoningEffort)) {
      await this.renderBindingStatus(binding, event);
      return;
    }

    const updatedBinding = await this.updateBindingPreferences(binding, {
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
    const optimisticNavigation: NavigationSnapshot = {
      ...navigation,
      threads: navigation.threads.map((candidate) =>
        candidate.source === binding.backend &&
        candidate.id === binding.threadId &&
        federationRefsMatch(candidate.federation?.ref, binding.federatedThread)
          ? { ...candidate, reasoningEffort }
          : candidate,
      ),
    };
    await this.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.renderBindingStatus(updatedBinding, event, optimisticNavigation);
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
      await this.renderBindingStatus(binding, event);
      return;
    }

    const summary = await this.getBackendSummary(
      binding.backend,
      federationTargetForBinding(binding),
    );
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      federationTarget: federationTargetForBinding(binding),
    });
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
      await this.renderBindingStatus(binding, event);
      return;
    }
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
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
    const updatedBinding = await this.updateBindingPreferences(binding, {
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
    const optimisticNavigation: NavigationSnapshot = {
      ...navigation,
      threads: navigation.threads.map((candidate) =>
        candidate.source === binding.backend &&
        candidate.id === binding.threadId &&
        federationRefsMatch(candidate.federation?.ref, binding.federatedThread)
          ? { ...candidate, acpRuntime }
          : candidate,
      ),
    };
    await this.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.renderBindingStatus(updatedBinding, event, optimisticNavigation);
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
      (summary.kind !== "codex" || summary.launchpadOptions?.supportsFastMode === false)
    ) {
      await this.renderBindingStatus(binding, event);
      return;
    }
    const fastMode = !binding.preferences?.fastMode;
    const updatedBinding = await this.updateBindingPreferences(binding, {
      fastMode,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: binding.threadId,
      fastMode,
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
      await this.renderBindingStatus(binding, event);
      return;
    }
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
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
      const allowed = await this.ensureFullAccessEscalationAllowed(
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
    await this.updateBindingPreferences(binding, {
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
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const thread = findThreadForBinding(navigation, binding);
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    if (executionMode === currentMode) {
      await this.clearActiveBindingSubmodeIntent(event, binding);
      await this.renderBindingStatus(binding, event, navigation);
      return;
    }
    if (executionMode === "full-access") {
      const allowed = await this.ensureFullAccessEscalationAllowed(
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
    await this.updateBindingPreferences(binding, {
      executionMode,
      permissionsMode: executionMode,
    });
    await this.clearActiveBindingSubmodeIntent(event, binding);
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
      !(await this.requirePermission(
        event,
        "thread.execution.full_access",
        "execution:acp-privileged",
      ))
    ) {
      return false;
    }
    const controls = await this.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.deliverFullAccessPolicyError(
        context.kind === "thread"
          ? await this.options.store.getBinding(context.bindingId)
          : undefined,
        event,
        `Permissions mode ${context.label} is disabled from messaging by Full Access settings.`,
      );
      return false;
    }

    const warning = await this.resolveFullAccessWarning(controls, event);
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
    const controls = await this.resolveFullAccessControls();
    const warning = await this.resolveFullAccessWarning(controls, event);
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

  private async ensureFullAccessEscalationAllowed(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    // RBAC double-gate: escalating a thread to Codex Full Access requires the
    // dedicated danger permission IN ADDITION to the global Full Access
    // settings toggle below — the permission is never a bypass of the toggle.
    if (
      !(await this.requirePermission(
        event,
        "thread.execution.full_access",
        "execution:full-access",
      ))
    ) {
      return false;
    }
    const controls = await this.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.recordFullAccessPolicyViolation(context, event);
      await this.deliverFullAccessPolicyError(
        context.kind === "thread" ? context.binding : undefined,
        event,
        "Escalating to Full Access from messaging is disabled in Settings.",
      );
      return false;
    }

    const warning = await this.resolveFullAccessWarning(controls, event);
    if (!warning.shouldWarn) {
      return true;
    }

    await this.presentFullAccessRiskWarning(context, event);
    return false;
  }

  private async presentFullAccessRiskWarning(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
    options: { presentationMode?: FullAccessRiskPresentationMode } = {},
  ): Promise<void> {
    const controls = await this.resolveFullAccessControls();
    const warning = await this.resolveFullAccessWarning(controls, event);
    const actionContext: FullAccessRiskWarningContext =
      context.kind === "thread"
        ? {
            kind: "thread",
            bindingId: context.binding?.id ?? "",
            threadId: context.threadId,
          }
        : context.kind === "new-thread"
          ? {
            kind: "new-thread",
            ...(options.presentationMode === "message"
              ? { pendingPrompt: true }
              : {}),
            sessionId: context.session.id,
          }
          : {
              backend: context.backend,
              ...(context.federatedThread?.target.scope === "remote"
                ? {
                    federationInstanceId:
                      context.federatedThread.target.instanceId,
                  }
                : {}),
              kind: "resume-thread",
              sessionId: context.session.id,
              threadId: context.threadId,
          };
    const presentation = fullAccessRiskPresentationForContext(
      context,
      options.presentationMode ?? "surface",
    );
    const actions: MessagingConfirmationIntent["actions"] = [
      {
        id: `${FULL_ACCESS_RISK_ACTION_PREFIX}accept`,
        label: "Yes",
        style: "primary",
        fallbackText: "yes",
        value: actionContext,
      },
      ...(warning.canDismiss
        ? [
            {
              id: `${FULL_ACCESS_RISK_ACTION_PREFIX}dismiss`,
              label: "Yes - and stop warning me",
              style: "primary" as const,
              fallbackText: "yes and stop warning me",
              value: actionContext,
            },
          ]
        : []),
      {
        id: `${FULL_ACCESS_RISK_ACTION_PREFIX}cancel`,
        label: "Cancel",
        style: "secondary",
        fallbackText: "cancel",
        value: actionContext,
      },
    ];
    const intent = buildConfirmationIntent({
      id: this.newIntentId("full-access-risk"),
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      delivery: presentation.surface
        ? {
            mode: "update",
            replaceMarkup: true,
          }
        : undefined,
      title: "Enable Full Access?",
      body: [
        "Full Access allows network access and read/write access to almost all files on this machine.",
        "That means data can be exfiltrated unintentionally, or by malicious code the agent downloads and executes through a supply chain attack on npm, PyPI, Rust crates, Go modules, or a similar dependency source.",
      ].join("\n\n"),
      fallbackText: warning.canDismiss
        ? "Reply Yes, Yes - and stop warning me, or Cancel."
        : "Reply Yes or Cancel.",
      actions,
      targetSurface: presentation.surface,
    });
    const expiresAt =
      context.kind === "new-thread" || context.kind === "resume-thread"
        ? this.now() + MESSAGING_CALLBACK_HANDLE_TTL_MS
        : undefined;
    if (
      expiresAt !== undefined &&
      (context.kind === "new-thread" || context.kind === "resume-thread")
    ) {
      await this.options.store.upsertBrowseSession({
        ...context.session,
        expiresAt: Math.max(context.session.expiresAt, expiresAt),
        textInputExpiresAt:
          options.presentationMode === "message"
            ? this.now()
            : context.session.textInputExpiresAt ?? context.session.expiresAt,
        updatedAt: this.now(),
      });
    }
    const pending = await this.storePendingIntent(
      intent,
      presentation.binding,
      event,
      expiresAt === undefined ? undefined : { expiresAt },
    );
    const result = await this.deliver(intent, presentation.binding, event);
    if (result.surface) {
      await this.options.store.upsertPendingIntent({
        ...pending,
        surface: result.surface,
      });
    }
  }

  private async handleFullAccessRiskCallback(
    event: MessagingInboundCallbackEvent,
    action: "accept" | "dismiss" | "cancel",
  ): Promise<void> {
    const context = readFullAccessRiskContext(event.value);
    if (!context) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    if (action === "cancel") {
      if (context.kind === "new-thread" || context.kind === "resume-thread") {
        const session = await this.options.store.getBrowseSession(context.sessionId, {
          now: this.now(),
        });
        if (!session) {
          await this.deliverStaleFullAccessWarning(event);
          return;
        }
        if (context.kind === "new-thread") {
          this.pendingFullAccessNewThreadPrompts.delete(session.id);
        }
        const navigation = await this.options.backend.getNavigationSnapshot({
          backend: "all",
          filter: session.query,
        });
        if (context.kind === "new-thread") {
          await this.presentNewThreadPromptGate(
            this.withNewThreadPromptCaptureExpiry(session),
            event,
            navigation,
          );
        } else {
          await this.renderResumeBrowser(session, navigation, event);
        }
        return;
      }
      const binding = await this.options.store.getBinding(context.bindingId);
      if (!binding) {
        await this.deliverInvalidStatusSelection(event);
        return;
      }
      if (binding.statusSurface || binding.pinnedStatusSurface) {
        await this.clearActiveBindingSubmodeIntent(event, binding);
        await this.renderBindingStatus(binding, event);
        return;
      }
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("full-access-risk-cancelled"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Full Access cancelled",
          body: "No Full Access change was made.",
        }),
        undefined,
        event,
      );
      return;
    }

    const escalationContext =
      await this.resolveFullAccessRiskCallbackContext(context, event);
    if (!escalationContext) {
      return;
    }
    if (!(await this.ensureFullAccessRiskCallbackAllowed(escalationContext, event))) {
      return;
    }

    if (action === "dismiss") {
      const controls = await this.resolveFullAccessControls();
      const warning = await this.resolveFullAccessWarning(controls, event);
      if (warning.canDismiss) {
        await controls.dismissWarning?.({
          actorId: event.actor.platformUserId,
          channel: event.channel.channel,
        });
      }
    }

    if (escalationContext.kind === "new-thread") {
      const { session } = escalationContext;
      const acceptedSession = {
        ...session,
        fullAccessRiskAcceptedAt: this.now(),
        preferences: {
          ...session.preferences,
          executionMode: "full-access" as const,
          permissionsMode: "full-access" as const,
          updatedAt: this.now(),
        },
      };
      const pendingPrompt = this.pendingFullAccessNewThreadPrompts.get(session.id);
      if (escalationContext.pendingPrompt && !pendingPrompt) {
        await this.deliverMissingFullAccessPrompt(event);
        return;
      }
      if (pendingPrompt) {
        try {
          await this.createNewThreadFromPromptBundle({
            events: pendingPrompt.events,
            session: acceptedSession,
          });
        } catch (error) {
          this.logger.warn?.("messaging new-thread prompt failed", {
            channel: pendingPrompt.session.channel.channel,
            error: error instanceof Error ? error.message : String(error),
            sessionId: pendingPrompt.session.id,
          });
          await this.deliverNewThreadPromptFailure(
            {
              events: pendingPrompt.events,
              session: acceptedSession,
            },
            error,
          );
        }
        return;
      }
      await this.presentNewThreadPromptGate(acceptedSession, event);
      return;
    }

    if (escalationContext.kind === "resume-thread") {
      const { session } = escalationContext;
      const target = {
        backend: escalationContext.backend,
        federatedThread: escalationContext.federatedThread,
        threadId: escalationContext.threadId,
      };
      const binding = await this.bindChannelToThread(event, target);
      const preferences = {
        ...session.preferences,
        executionMode: "full-access" as const,
        permissionsMode: "full-access" as const,
        updatedAt: this.now(),
      };
      const updatedBinding = await this.updateBindingPreferences(binding, preferences);
      await this.options.backend.setThreadExecutionMode?.({
        backend: escalationContext.backend,
        federationTarget: escalationContext.federatedThread?.target,
        threadId: escalationContext.threadId,
        executionMode: "full-access",
      });
      await this.options.store.deleteBrowseSession(session.id);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("bound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Thread bound",
          body: "Messages in this conversation will route to the selected thread.",
          fallbackText: "Send a message to continue the thread.",
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      await this.renderBindingStatus(updatedBinding, event);
      await this.repostLastAssistantMessageForResume(updatedBinding);
      return;
    }

    const { binding } = escalationContext;
    if (!binding) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    await this.updateBindingPreferences(binding, {
      executionMode: "full-access",
      permissionsMode: "full-access",
    });
    await this.clearActiveBindingSubmodeIntent(event, binding);
    await this.options.backend.setThreadExecutionMode?.({
      backend: binding.backend,
      federationTarget: federationTargetForBinding(binding),
      threadId: escalationContext.threadId,
      executionMode: "full-access",
    });
  }

  private async handleAcpRuntimeRiskCallback(
    event: MessagingInboundCallbackEvent,
    action: "accept" | "dismiss" | "cancel",
  ): Promise<void> {
    const context = readAcpRuntimeRiskContext(event.value);
    if (!context) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    if (action === "cancel") {
      if (context.kind === "new-thread") {
        const session = await this.options.store.getBrowseSession(context.sessionId, {
          now: this.now(),
        });
        if (!session) {
          await this.deliverStaleFullAccessWarning(event);
          return;
        }
        const navigation = await this.options.backend.getNavigationSnapshot({
          backend: "all",
        });
        await this.presentNewThreadPromptGate(session, event, navigation);
        return;
      }
      const binding = await this.options.store.getBinding(context.bindingId);
      if (!binding) {
        await this.deliverInvalidStatusSelection(event);
        return;
      }
      await this.renderBindingStatus(binding, event);
      return;
    }

    if (!(await this.ensureAcpRuntimeRiskCallbackAllowed(context, event))) {
      return;
    }
    if (action === "dismiss") {
      const controls = await this.resolveFullAccessControls();
      const warning = await this.resolveFullAccessWarning(controls, event);
      if (warning.canDismiss) {
        await controls.dismissWarning?.({
          actorId: event.actor.platformUserId,
          channel: event.channel.channel,
        });
      }
    }

    if (context.kind === "new-thread") {
      const session = await this.options.store.getBrowseSession(context.sessionId, {
        now: this.now(),
      });
      if (!session) {
        await this.deliverStaleFullAccessWarning(event);
        return;
      }
      const navigation = await this.options.backend.getNavigationSnapshot({
        backend: "all",
      });
      await this.applyNewThreadAcpRuntimeMode(session, event, navigation, context);
      return;
    }

    const binding = await this.options.store.getBinding(context.bindingId);
    if (!binding) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }
    await this.applyBindingAcpRuntimeMode(binding, event, context);
  }

  private async ensureAcpRuntimeRiskCallbackAllowed(
    context: AcpRuntimeRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    const controls = await this.resolveFullAccessControls();
    if (controls.allowEscalation) {
      return true;
    }
    await this.deliverFullAccessPolicyError(
      context.kind === "thread"
        ? await this.options.store.getBinding(context.bindingId)
        : undefined,
      event,
        `Permissions mode ${context.label} is disabled from messaging by Full Access settings.`,
    );
    return false;
  }

  private async resolveFullAccessRiskCallbackContext(
    context: FullAccessRiskWarningContext,
    event: MessagingInboundEvent,
  ): Promise<FullAccessEscalationContext | undefined> {
    if (context.kind === "new-thread") {
      const session = await this.options.store.getBrowseSession(context.sessionId, {
        now: this.now(),
      });
      if (!session) {
        await this.deliverStaleFullAccessWarning(event);
        return undefined;
      }
      return {
        kind: "new-thread",
        pendingPrompt: context.pendingPrompt,
        session,
      };
    }

    if (context.kind === "resume-thread") {
      const session = await this.options.store.getBrowseSession(context.sessionId, {
        now: this.now(),
      });
      if (!session) {
        await this.deliverStaleFullAccessWarning(event);
        return undefined;
      }
      return {
        backend: context.backend,
        ...(context.federationInstanceId
          ? {
              federatedThread: buildFederatedThreadRef({
                backend: context.backend,
                instanceId: context.federationInstanceId,
                threadId: context.threadId,
              }),
            }
          : {}),
        kind: "resume-thread",
        session,
        threadId: context.threadId,
      };
    }

    const binding = await this.options.store.getBinding(context.bindingId);
    if (!binding) {
      await this.deliverInvalidStatusSelection(event);
      return undefined;
    }
    return {
      backend: binding.backend,
      binding,
      kind: "thread",
      threadId: context.threadId,
    };
  }

  private async ensureFullAccessRiskCallbackAllowed(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
  ): Promise<boolean> {
    const controls = await this.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.recordFullAccessPolicyViolation(context, event);
      await this.deliverFullAccessPolicyError(
        context.kind === "thread" ? context.binding : undefined,
        event,
        "Escalating to Full Access from messaging is disabled in Settings.",
      );
      return false;
    }
    return true;
  }

  private async canResumeFullAccessThreads(): Promise<boolean> {
    return (await this.resolveFullAccessControls()).allowThreadResume;
  }

  private async resolveFullAccessRiskForSession(
    session: MessagingBrowseSessionRecord,
    event: MessagingInboundEvent,
    options: NewThreadOptionsSummary,
  ): Promise<"accepted" | "blocked" | "warning"> {
    if (session.fullAccessRiskAcceptedAt) {
      return "accepted";
    }
    const controls = await this.resolveFullAccessControls();
    if (!controls.allowEscalation) {
      await this.recordFullAccessPolicyViolation(
        { kind: "new-thread", session },
        event,
      );
      await this.deliverFullAccessPolicyError(
        undefined,
        event,
        "Starting a Full Access thread from messaging is disabled in Settings.",
      );
      return "blocked";
    }
    const warning = await this.resolveFullAccessWarning(controls, event);
    if (
      warning.policy === "dismissable" &&
      options.executionModeSource !== "session"
    ) {
      return "accepted";
    }
    return warning.shouldWarn ? "warning" : "accepted";
  }

  private resolveFullAccessControls():
    | MessagingFullAccessControls
    | Promise<MessagingFullAccessControls> {
    const controls = this.options.fullAccessControls;
    const resolved =
      typeof controls === "function" ? controls() : controls;
    return isPromiseLike(resolved)
      ? Promise.resolve(resolved).then(normalizeMessagingFullAccessControls)
      : normalizeMessagingFullAccessControls(resolved);
  }

  private async resolveFullAccessWarning(
    controls: MessagingFullAccessControls,
    event: MessagingInboundEvent,
  ): Promise<FullAccessWarningResolution> {
    const contact = controls.authorizedUsers?.[event.channel.channel]?.find(
      (candidate) => candidate.id === event.actor.platformUserId,
    );
    const policy = contact?.fullAccessWarningOverride ?? "default";
    const effectivePolicy =
      policy === "default" ? controls.warningPolicy : policy;
    if (effectivePolicy === "never") {
      return { canDismiss: false, policy: effectivePolicy, shouldWarn: false };
    }
    if (effectivePolicy === "always") {
      return { canDismiss: false, policy: effectivePolicy, shouldWarn: true };
    }
    const canPersistDismissal =
      controls.canDismissWarning
        ? await controls.canDismissWarning({
            actorId: event.actor.platformUserId,
            channel: event.channel.channel,
          })
        : Boolean(controls.dismissWarning);
    return {
      canDismiss: Boolean(controls.dismissWarning) && canPersistDismissal,
      policy: effectivePolicy,
      shouldWarn: contact?.fullAccessWarningDismissed !== true,
    };
  }

  private async deliverFullAccessPolicyError(
    binding: MessagingBindingRecord | undefined,
    event: MessagingInboundEvent | undefined,
    body: string,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("full-access-policy"),
        createdAt: this.now(),
        title: "Full Access blocked",
        body,
        recoverable: true,
      }),
      binding,
      event,
    );
  }

  private async recordFullAccessPolicyViolation(
    context: FullAccessEscalationContext,
    event: MessagingInboundEvent,
  ): Promise<void> {
    try {
      await this.options.onFullAccessPolicyViolation?.({
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        backend:
          context.kind === "thread" || context.kind === "resume-thread"
            ? context.backend
            : undefined,
        bindingId: context.kind === "thread" ? context.binding?.id : undefined,
        channel: event.channel,
        requestedAction:
          context.kind === "thread"
            ? "messaging.full_access.escalate_thread"
            : context.kind === "resume-thread"
              ? "messaging.full_access.resume_with_escalation"
              : "messaging.full_access.start_new_thread",
        threadId:
          context.kind === "thread" || context.kind === "resume-thread"
            ? context.threadId
            : undefined,
      });
    } catch (error) {
      this.logger.debug?.("messaging full-access policy log failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a tap on the Cancel button of a queued-permissions audit
   * message. The actionId is `permissions:queue:cancel:${queueId}`; we
   * validate that the queueId still matches the active tracking entry
   * before calling the bridge.
   *
   * Stale-click feedback (mirroring `handleQueuedTurnCallback`'s
   * "queued message no longer waiting" pattern): if the queue this
   * button references has already been applied or cancelled, OR a
   * different queue has replaced it, we post an explicit "no longer
   * waiting" reply instead of silently routing through the registry's
   * idempotent no-op. This is the same UX contract queued reply
   * messages have used since `2026-05-03-001-fix-messaging-turn-admission-plan.md`.
   *
   * The visual button SHOULD have been removed by the
   * `handleExecutionModeQueueCleared` edit when the queue resolved,
   * but Telegram/Discord chat history can still show stale buttons
   * (the user scrolled up; the edit failed; the tab was offline at
   * the time of the edit; etc.) — we treat the click as the
   * authoritative "user wants to interact with this queue" signal
   * and respond with the truth at click time.
   */
  private async handlePermissionsQueueCancelCallback(
    event: MessagingInboundCallbackEvent,
    queueId: string,
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      return;
    }

    const queueKey = this.queueAuditKey(binding.backend, binding.threadId);
    const tracking = this.pendingQueueAuditMessages.get(queueKey);
    const isStale = !tracking || tracking.queueId !== queueId;
    if (isStale) {
      try {
        await this.deliver(
          buildErrorIntent({
            id: this.newIntentId("expired-permissions-queue"),
            createdAt: this.now(),
            title: "Permissions change unavailable",
            body: "That queued permissions change is no longer waiting.",
            recoverable: true,
          }),
          binding,
          event,
        );
      } catch (error) {
        this.logger.debug?.(
          "messaging permissions-queue stale-cancel notice failed",
          {
            bindingId: binding.id,
            threadId: binding.threadId,
            queueId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return;
    }

    if (!this.options.backend.cancelThreadExecutionModeQueue) {
      return;
    }
    try {
      await this.options.backend.cancelThreadExecutionModeQueue({
        backend: binding.backend,
        federationTarget: federationTargetForBinding(binding),
        threadId: binding.threadId,
      });
    } catch (error) {
      this.logger.debug?.("messaging permissions-queue cancel failed", {
        bindingId: binding.id,
        threadId: binding.threadId,
        queueId,
        error: error instanceof Error ? error.message : String(error),
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
      await this.renderBindingStatus(binding, event);
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
      await this.renderBindingStatus(binding, event);
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
    await this.renderBindingStatus(binding, event);
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
    await this.renderBindingStatus(binding, event);
  }

  private async syncConversationName(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.adapter.setConversationTitle) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-unavailable"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body: "This messaging provider does not support syncing the conversation name.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const threadState = resolveMessagingThreadState({
      activeTurn: this.getActiveTurn(binding),
      binding,
      navigation,
    });
    const threadTitle = normalizeConversationTitle(threadState.title);
    if (!threadTitle) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-missing-title"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body: "This thread does not have a Codex thread name to sync yet.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const result = await this.options.adapter.setConversationTitle({
      actor: event.actor,
      channel: binding.channel,
      routingState: event.routingState ?? binding.routingState,
      title: threadTitle,
    });
    if (result.outcome !== "updated") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-failed"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body:
            result.errorMessage ??
            `This ${conversationKindLabel(binding.channel.conversation.kind)} cannot be renamed from messaging.`,
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const updatedBinding = await this.options.store.upsertBinding({
      ...binding,
      channel: {
        ...binding.channel,
        conversation: {
          ...binding.channel.conversation,
          title: result.title,
        },
      },
      updatedAt: this.now(),
    });
    // Title changed — make the chip's label/tooltip pick up the new
    // value without waiting for the next backend tick.
    this.notifyBindingChanged("sync-conversation-name");
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("status-sync-name-confirmed"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Name synced",
        body: `Set this ${conversationKindLabel(binding.channel.conversation.kind)} name to "${result.title}".`,
      }),
      updatedBinding,
      event,
    );
    await this.renderBindingStatus(updatedBinding, event, navigation);
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
    const updatedBinding = await this.updateBindingPreferences(binding, {
      toolUpdateMode,
    });
    await this.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.renderBindingStatus(updatedBinding, event);
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
    await this.clearActiveBindingSubmodeIntent(event, updatedBinding);
    await this.renderBindingStatus(updatedBinding, event);
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
    const updatedBinding = await this.updateBindingPreferences(binding, {
      streamingResponses: nextMode,
      ...(streamingControlRevealed ? { streamingControlRevealed: true } : {}),
    });
    await this.renderBindingStatus(updatedBinding, event);
  }

  private async updateBindingPreferences(
    binding: MessagingBindingRecord,
    patch: Partial<NonNullable<MessagingBindingRecord["preferences"]>>,
  ): Promise<MessagingBindingRecord> {
    return await this.options.store.upsertBinding({
      ...binding,
      preferences: {
        ...binding.preferences,
        ...patch,
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
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

  /**
   * Providers on this instance that can run a review, with the models and
   * reasoning levels each offers. Drives the configurator's Provider / Model /
   * Effort buttons. Returns an empty list — which hides those buttons — when
   * nothing advertises `reviewRunner`, so an instance that predates reviewer
   * overrides never offers a choice it cannot honor.
   */
  private async listReviewerBackends(): Promise<
    NonNullable<MessagingReviewIntent["review"]["reviewerBackends"]>
  > {
    try {
      const response = await this.options.backend.listBackends?.({
        includeUnavailable: false,
      });
      return (response?.backends ?? [])
        .filter((candidate) => candidate.capabilities.reviewRunner === true)
        .map((candidate) => ({
          backend: candidate.kind,
          label: candidate.label,
          models: (candidate.launchpadOptions?.models ?? []).map((model) => ({
            id: model.id,
            label: model.label ?? model.id,
            reasoningEfforts:
              model.reasoningEfforts
              ?? candidate.launchpadOptions?.reasoningEfforts
              ?? [],
          })),
        }));
    } catch (error) {
      this.logger.debug?.("messaging reviewer backend lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async reviewSupportedForBinding(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    if (!this.options.backend.submitReview) {
      return false;
    }
    try {
      const summary = await this.getBackendSummary(binding.backend);
      return Boolean(summary?.available && summary.capabilities.startReview);
    } catch (error) {
      this.logger.debug?.("messaging review capability lookup failed", {
        backend: binding.backend,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
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

  private async detachBinding(event: MessagingInboundEvent): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    const channelMonitor =
      await this.options.store.findActiveMonitorSubscriptionForChannel(event.channel);
    const hasThread = Boolean(binding);
    const hasChannelMonitor = channelMonitor?.monitor.enabled === true;
    const hasBindingMonitor = binding?.monitor?.enabled === true;
    const hasMonitor = hasChannelMonitor || hasBindingMonitor;
    if (!hasThread && !hasMonitor) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("detach-unbound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Nothing attached",
          body: "Neither a thread nor Monitor is attached to this conversation.",
        }),
        undefined,
        event,
      );
      return;
    }

    if (channelMonitor && hasChannelMonitor) {
      await this.disableChannelMonitorSubscription(channelMonitor, event);
    }
    if (binding) {
      await this.runDetachPipeline(binding, event, {
        deliverConfirmation: false,
        deliverMonitorStatus: false,
      });
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("detached"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: hasThread && hasMonitor
          ? "Thread and Monitor detached"
          : hasThread
            ? "Thread detached"
            : "Monitor detached",
        body: hasThread && hasMonitor
          ? "Messages in this conversation will no longer route to PwrAgent, and recent thread updates will no longer post here."
          : hasThread
            ? "Messages in this conversation will no longer route to PwrAgent."
            : "Recent thread updates will no longer post to this conversation.",
      }),
      binding,
      event,
    );
  }

  /**
   * Platform-agnostic detach pipeline. Called by both the inbound
   * `/detach` slash-command path and the bus-driven UI / archive
   * paths. The only seam for platform-specific behavior is
   * `this.options.adapter.deliver`, which the registered adapter
   * implements per the messaging contract — adding a new platform
   * requires zero changes to this method. `event` is supplied only
   * when the detach was initiated by an inbound command (used for
   * audit context and reply targeting); for non-inbound origins
   * (`requestBindingRevoke` from IPC, archive flows) the binding's
   * own channel is the routing source.
   */
  private async runDetachPipeline(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    options: {
      deliverConfirmation?: boolean;
      deliverMonitorStatus?: boolean;
    } = {},
  ): Promise<void> {
    const activeTurn = this.getActiveTurn(binding);
    if (activeTurn) {
      await this.signalTurnActivity(
        binding,
        {
          ...activeTurn,
          status: "interrupted",
          updatedAt: this.now(),
        },
        { force: true },
      );
    }
    await this.deliver(
      buildActivityIntent({
        id: this.newIntentId("activity-closed"),
        activity: "typing",
        bindingId: binding.id,
        createdAt: this.now(),
        sessionState: "closed",
        state: "idle",
      }),
      binding,
      event,
    );
    await this.flushToolUpdatesForBinding(binding, { clear: true });
    await this.stopMonitoringForBinding(binding, event, {
      deliverStatus: options.deliverMonitorStatus,
    });
    await this.retireBindingStatus(
      binding,
      event,
      await this.options.backend.getNavigationSnapshot({ backend: "all" }),
    );

    await this.options.store.revokeBinding({
      bindingId: binding.id,
      revokedAt: this.now(),
    });
    await this.recordBindingTransition("unbound", binding);
    this.notifyBindingChanged("detach");
    if (options.deliverConfirmation !== false) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("detached"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Thread detached",
          body: "Messages in this conversation will no longer route to PwrAgent.",
        }),
        binding,
        event,
      );
    }
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
  ): Promise<boolean> {
    if (!this.isChannelInScope(binding.channel)) {
      return false;
    }
    await this.runDetachPipeline(binding, undefined);
    return true;
  }

  private async recreateBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<MessagingBindingRecord> {
    await this.clearActiveBindingSubmodeIntent(event, binding);
    const snapshot = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const retiredBinding = await this.retireBindingStatus(binding, event, snapshot);
    return await this.renderBindingStatus(retiredBinding, event, snapshot);
  }

  private async resolveToolUpdateDefaultMode(
    targetKind: MessagingBindingTargetKind = "thread",
  ): Promise<MessagingToolUpdateMode> {
    const configured = this.options.toolUpdateDefaultMode;
    if (!configured) {
      return targetKind === "agent_thread" ? "show_none" : "show_some";
    }

    try {
      return typeof configured === "function"
        ? await configured(targetKind)
        : configured;
    } catch (error) {
      this.logger.debug?.("messaging tool update default resolution failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return targetKind === "agent_thread" ? "show_none" : "show_some";
    }
  }

  /**
   * Resolve the global "show streaming option on thread cards" setting. Resolved
   * live (like {@link resolveToolUpdateDefaultMode}) rather than snapshotted at
   * construction, so toggling it in Settings takes effect on the next status
   * render instead of only after a messaging restart.
   */
  private async resolveShowStreamingOption(): Promise<boolean> {
    const configured = this.showStreamingOptionConfig;
    try {
      return typeof configured === "function" ? await configured() : configured;
    } catch (error) {
      this.logger.debug?.("messaging show-streaming-option resolution failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async retireBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent | undefined,
    navigation: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    const statusSurface = binding.statusSurface ?? binding.pinnedStatusSurface;
    if (!statusSurface) {
      return binding;
    }

    try {
      await this.deliver(
        {
          ...buildBindingStatusIntent({
            id: this.newIntentId("status-retire"),
            binding,
            capabilityProfile: this.capabilityProfile,
            contextUsageSummary: this.contextUsageSummaryForBinding(binding),
            createdAt: this.now(),
            responseModeDefault: await this.responseModeForConversation(
              binding.channel,
            ),
            threadState: resolveMessagingThreadState({
              activeTurn: this.getActiveTurn(binding),
              binding,
              navigation,
            }),
            toolUpdateMode: await this.resolveToolUpdateDefaultMode(
              binding.targetKind ?? "thread",
            ),
          }),
          actions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          targetSurface: statusSurface,
        },
        binding,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging status retirement update failed", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
    }

    if (binding.pinnedStatusSurface) {
      try {
        await this.deliver(
          {
            id: this.newIntentId("status-unpin"),
            kind: "dismiss",
            bindingId: binding.id,
            createdAt: this.now(),
            delivery: {
              mode: "dismiss",
              unpin: true,
            },
            reason: "status_recreated",
            targetSurface: binding.pinnedStatusSurface,
          },
          binding,
          event,
        );
      } catch (error) {
        this.logger.debug?.("messaging status retirement unpin failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }

    return await this.options.store.upsertBinding({
      ...binding,
      pinnedStatusSurface: undefined,
      statusSurface: undefined,
      updatedAt: this.now(),
    });
  }

  private async renderBindingStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    return await this.statusRenderLock.run(binding.id, async () => {
      const latestBinding = await this.options.store.getBinding(binding.id);
      if (latestBinding?.revokedAt) {
        return latestBinding;
      }
      return await this.renderBindingStatusUnlocked(
        latestBinding ?? binding,
        event,
        navigation,
      );
    });
  }

  private async renderBindingStatusUnlocked(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    if (isDefaultAgentRouteBinding(binding)) {
      return binding;
    }
    if (!event && await this.hasActiveBindingSubmodeIntent(binding)) {
      this.logger.debug?.("messaging deferred automatic status refresh during active interaction", {
        bindingId: binding.id,
        threadId: binding.threadId,
      });
      return await this.options.store.getBinding(binding.id) ?? binding;
    }
    const federationTarget = federationTargetForBinding(binding);
    const snapshot =
      navigation ??
      (await this.options.backend.getNavigationSnapshot({
        backend: "all",
        ...(federationTarget ? { federationTarget } : {}),
      }));
    const activeTurn = await this.reconcileActiveTurnFromBackendStatus(
      binding,
      "status_refresh",
    );
    const backendSummary = await this.getBackendSummary(
      binding.backend,
      federationTarget,
    );
    const intent = buildBindingStatusIntent({
      id: this.newIntentId("status"),
      allowFullAccessEscalation: (await this.resolveFullAccessControls())
        .allowEscalation,
      backendSummary,
      binding,
      capabilityProfile: this.capabilityProfile,
      contextUsageSummary: this.contextUsageSummaryForBinding(binding),
      createdAt: this.now(),
      handoff: this.options.backend.handoffThreadWorkspace
        ? handoffContextForBinding(binding, snapshot)
        : undefined,
      responseModeDefault: await this.responseModeForConversation(
        binding.channel,
      ),
      streamingResponsesDefault: this.streamingResponsesDefault,
      showStreamingOption: await this.resolveShowStreamingOption(),
      threadState: resolveMessagingThreadState({
        activeTurn,
        binding,
        navigation: snapshot,
      }),
      toolUpdateMode: await this.resolveToolUpdateDefaultMode(
        binding.targetKind ?? "thread",
      ),
    });
    const result = await this.deliver(intent, binding, event);
    const latestBinding = await this.options.store.getBinding(binding.id);
    if (latestBinding?.revokedAt) {
      return latestBinding;
    }
    if (!result.surface) {
      return latestBinding ?? binding;
    }

    const currentBinding = latestBinding ?? binding;
    return await this.options.store.upsertBinding({
      ...currentBinding,
      pinnedStatusSurface:
        result.outcome === "pinned"
          ? result.surface
          : currentBinding.pinnedStatusSurface,
      statusSurface: result.surface,
      updatedAt: this.now(),
    });
  }

  private async renderAutomaticBindingStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    if (
      binding.statusPresentation === "on_demand"
      && !binding.statusSurface
      && !binding.pinnedStatusSurface
    ) {
      return binding;
    }
    const targetedNavigation = navigation
      ?? navigationSnapshotForAdmissionState(
        binding,
        await this.options.backend.getThreadAdmissionState({
          backend: binding.backend,
          federationTarget: federationTargetForBinding(binding),
          threadId: binding.threadId,
        }),
      );
    return await this.renderBindingStatus(binding, event, targetedNavigation);
  }

  private async navigationSnapshotWithThreadNameFromEvent(
    event: AgentEvent,
  ): Promise<NavigationSnapshot> {
    const snapshot = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const params = event.notification.params as {
      threadId?: unknown;
      threadName?: unknown;
      titleSource?: unknown;
    };
    if (
      typeof params.threadId !== "string" ||
      typeof params.threadName !== "string" ||
      !params.threadName.trim()
    ) {
      return snapshot;
    }
    const threadId = params.threadId;
    const threadName = params.threadName.trim();
    // The new name's own provenance. Carrying the row's previous source over
    // to a new title is the orphaned pair the thread information store
    // refuses to hold: the status and monitor cards read `derived` to decide
    // whether to shorten a title, so a stale source formats the same rename
    // two different ways depending on what the row said before.
    const titleSource = normalizeRenamedTitleSource(params.titleSource);

    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.source === event.backend && thread.id === threadId
          ? {
              ...thread,
              title: threadName,
              titleSource,
            }
          : thread,
      ),
    };
  }

  private async renderMonitorStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    const snapshot =
      navigation ??
      (await this.options.backend.getNavigationSnapshot({
        backend: "all",
      }));
    const now = this.now();
    const activeTurns = await this.resolveMonitorActiveTurns(
      snapshot,
      binding.monitor,
    );
    const snippetsByThreadKey = await this.resolveMonitorSnippets(
      snapshot,
      binding.monitor,
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
    navigation?: NavigationSnapshot,
  ): Promise<MessagingMonitorSubscriptionRecord> {
    const snapshot =
      navigation ??
      (await this.options.backend.getNavigationSnapshot({
        backend: "all",
      }));
    const now = this.now();
    const activeTurns = await this.resolveMonitorActiveTurns(
      snapshot,
      subscription.monitor,
    );
    const snippetsByThreadKey = await this.resolveMonitorSnippets(
      snapshot,
      subscription.monitor,
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
    navigation: NavigationSnapshot,
    monitor?: MessagingMonitorState,
  ): Promise<ReadonlyMap<string, MessagingActiveTurnSummary>> {
    const activeTurns = new Map(this.activeTurnsByThreadKey);
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
    navigation: NavigationSnapshot,
    monitor?: MessagingMonitorState,
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

  private async retireApprovalCallbackIfBackendIdle(
    pendingIntent: MessagingPendingIntentRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<boolean> {
    const persistedBinding = pendingIntent.bindingId
      ? await this.options.store.getBinding(pendingIntent.bindingId)
      : undefined;
    const origin = this.agentMessagingOriginForPendingIntent(pendingIntent);
    const binding = persistedBinding ?? origin?.deliveryBinding ?? origin?.binding;
    const turnId = pendingIntent.intent.requestContext?.turnId;
    if (!binding || binding.revokedAt || !turnId) {
      return false;
    }

    const threadStatus = await this.readBackendThreadStatus(binding);
    if (threadStatus !== "idle") {
      return false;
    }

    await this.reconcileActiveTurnFromBackendStatus(
      binding,
      "pending_request.submitted",
    );
    await this.options.store.deletePendingIntent(pendingIntent.id);
    await this.retireApprovalIntent(pendingIntent, event, "Resolved");
    await this.startNextQueuedTurn(binding);
    return true;
  }

  private async reconcileIdleTurnAndStartNext(
    binding: MessagingBindingRecord,
    reason: string,
  ): Promise<void> {
    await this.reconcileActiveTurnFromBackendStatus(binding, reason);
    await this.startNextQueuedTurn(binding);
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
    return this.activeTurnsByThreadKey.get(this.threadKeyForBinding(binding));
  }

  private setActiveTurn(
    binding: MessagingBindingRecord,
    activeTurn: MessagingActiveTurnSummary,
  ): void {
    this.activeTurnsByThreadKey.set(this.threadKeyForBinding(binding), activeTurn);
  }

  private threadKeyForBinding(binding: MessagingBindingRecord): string {
    return threadKeyForBinding(binding);
  }

  private async handleAutomationTurnStarted(params: {
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
    navigation: NavigationSnapshot;
    origin?: ActiveAgentMessagingOrigin;
    turnId: string;
  }): void {
    const origin = params.origin ?? (
      params.event
      && isLiveMessagingToolOriginBinding(params.binding, params.navigation)
        ? {
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
    if (origin.privateReplyContinuationBindingId) {
      rememberBoundedKey(this.privateReplyCompletionTurnKeys, turnKey);
    }
    if (
      origin.privateResponseRequested
      || requestsExplicitPrivateResponse(origin.event)
    ) {
      rememberBoundedKey(this.privateResponseFallbackTurnKeys, turnKey);
    }
  }

  private async buildAgentMessagingOrigin(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    navigation: NavigationSnapshot;
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
    this.pdfAttachmentStore.releaseTurn({ backend, threadId, turnId });
  }

  private isTerminalPrivateResponseTurn(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    turnId: string | undefined,
  ): boolean {
    return Boolean(
      turnId
      && this.terminalPrivateResponseTurnKeys.has(
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
      && this.privateResponseFallbackTurnKeys.has(
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
      this.privateReplyCompletionTurnKeys.has(
        agentMessagingTurnKey(backend, threadId, turnId),
      )
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
    this.notifyBindingChanged("private-reply-completed");
  }

  private rememberQueuedAgentMessagingOrigin(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    navigation: NavigationSnapshot;
    origin?: ActiveAgentMessagingOrigin;
    queueEntryId: string;
  }): void {
    const origin = params.origin ?? (
      params.event
      && isLiveMessagingToolOriginBinding(params.binding, params.navigation)
        ? {
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
    if (!params.update.queueEntryId || params.update.origin !== "messaging") {
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
      if (origin.privateReplyContinuationBindingId) {
        rememberBoundedKey(this.privateReplyCompletionTurnKeys, turnKey);
      }
      if (
        origin.privateResponseRequested
        || requestsExplicitPrivateResponse(origin.event)
      ) {
        rememberBoundedKey(this.privateResponseFallbackTurnKeys, turnKey);
      }
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

  private isAutomationTurnEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    fallbackTurnId?: string,
  ): boolean {
    const turnId = turnIdForBackendEvent(event) ?? fallbackTurnId;
    if (!turnId) {
      return false;
    }
    return this.automationTurnsByTurnKey.has(
      automationTurnKey({
        backend: event.backend,
        threadId: binding.threadId,
        turnId,
      }),
    );
  }

  private async deliverAutomationStartedMessage(
    binding: MessagingBindingRecord,
    params: {
      automationName?: string;
      automationRunId?: string;
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
      name ? `Automation started: ${name}` : "Automation started.",
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

  /**
   * Best-effort fan-out to the runtime's bindings-changed listener.
   * Wrapped so a misbehaving listener (e.g. closed BrowserWindow) can
   * never abort the mutation that produced the event.
   */
  private notifyBindingChanged(reason: string): void {
    if (!this.options.onBindingChanged) return;
    try {
      this.options.onBindingChanged();
    } catch (error) {
      this.logger.debug?.("messaging onBindingChanged listener threw", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordBindingTransition(
    action: ThreadMessagingBindingTransition["action"],
    binding: MessagingBindingRecord,
    occurredAt: number = this.now(),
  ): Promise<void> {
    const conversation = binding.channel.conversation;
    const transition: ThreadMessagingBindingTransition = {
      id: randomUUID(),
      action,
      bindingId: binding.id,
      platform: binding.channel.channel,
      conversationKind: conversation.kind,
      conversationTitle: conversation.title,
      parentTitle: conversation.parentTitle,
      ancestorTitle: conversation.ancestorTitle,
      occurredAt,
    };
    if (this.options.backend.recordMessagingBindingTransition) {
      try {
        await this.options.backend.recordMessagingBindingTransition({
          backend: binding.backend,
          threadId: binding.threadId,
          transition,
        });
      } catch (error) {
        this.logger.debug?.("messaging binding-transition audit failed", {
          action,
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }
    this.recordBindingActivity(action, binding, occurredAt);
  }

  private async bindChannelToThread(
    event: MessagingInboundEvent,
    target: {
      backend: AppServerBackendKind;
      federatedThread?: FederatedThreadRef;
      recordTransition?: boolean;
      statusPresentation?: MessagingBindingRecord["statusPresentation"];
      threadId: ThreadIdentifier;
      targetKind?: MessagingBindingRecord["targetKind"];
    },
  ): Promise<MessagingBindingRecord> {
    // Scope backstop. EVERY bind funnels through here, so a caller that forgets
    // the gate still cannot create a remote binding. Interactive entry points
    // check first and deliver a proper denial; reaching this throw means a path
    // was missed, so it fails closed loudly (the runtime's inbound dispatch
    // logs it) instead of quietly binding a peer's thread.
    if (
      !(await this.requireRemoteScope(
        event,
        target.federatedThread?.target,
        "bind:remote-instance",
      ))
    ) {
      throw new Error(
        "Refusing to bind a thread on another instance: actor lacks federation.remote_control.",
      );
    }
    const now = this.now();
    const previousBinding = await this.options.store.findActiveBindingForChannel(
      event.channel,
    );
    const targetIdentity = target.federatedThread
      ? federatedThreadIdentityKey(target.federatedThread)
      : buildThreadIdentityKey(target.backend, target.threadId);
    const binding: MessagingBindingRecord = {
      id: `binding:${buildMessagingConversationKey(event.channel)}:${targetIdentity}`,
      channel: event.channel,
      targetKind: target.targetKind ?? "thread",
      backend: target.backend,
      threadId: target.threadId,
      federatedThread: target.federatedThread,
      authorizedActorIds: [event.actor.platformUserId],
      routingState: event.routingState,
      statusPresentation: target.statusPresentation,
      createdAt: now,
      updatedAt: now,
      displayName: event.actor.displayName ?? event.actor.username,
    };
    if (
      previousBinding &&
      (previousBinding.id !== binding.id ||
        previousBinding.backend !== binding.backend ||
        previousBinding.threadId !== binding.threadId ||
        !federationRefsMatch(
          previousBinding.federatedThread,
          binding.federatedThread,
        ))
    ) {
      await this.options.store.revokeBinding({
        bindingId: previousBinding.id,
        revokedAt: now,
      });
    }
    const upserted = await this.options.store.upsertBinding(binding);
    if (
      target.recordTransition !== false &&
      previousBinding &&
      (previousBinding.backend !== upserted.backend ||
        previousBinding.threadId !== upserted.threadId ||
        !federationRefsMatch(
          previousBinding.federatedThread,
          upserted.federatedThread,
        ))
    ) {
      await this.recordBindingTransition("unbound", previousBinding, now);
    }
    if (
      target.recordTransition !== false &&
      (
        !previousBinding ||
        previousBinding.backend !== upserted.backend ||
        previousBinding.threadId !== upserted.threadId ||
        !federationRefsMatch(
          previousBinding.federatedThread,
          upserted.federatedThread,
        )
      )
    ) {
      await this.recordBindingTransition("bound", upserted, now);
    }
    // Retire any channel-scoped pending intents that pre-date this
    // bind. Without this, the resume browser's pending intent (and any
    // other pre-binding picker intent) survives the bind, and the next
    // text inbound on this channel matches the stale picker — making
    // the bot bounce "Choose an option" instead of routing to the new
    // binding. Best-effort: log and continue if the cleanup fails so
    // the bind itself still succeeds (fresh binding is the source of
    // truth; stale intents will eventually be evicted by TTL GC).
    //
    // Not transactional with `upsertBinding` on purpose: the store
    // API doesn't expose a transaction boundary for cross-row work,
    // and adding one would push transaction plumbing into the
    // messaging interface — over-architecture for a recovery window
    // measured in minutes. If the process crashes between these two
    // writes, the next bind on the same channel re-runs the cleanup,
    // and the TTL GC catches anything missed within 15 minutes.
    try {
      const removed = await this.options.store.deletePendingIntentsForChannel({
        channel: event.channel,
      });
      if (removed.length > 0) {
        this.logger.debug?.("messaging retired channel pending intents on bind", {
          bindingId: upserted.id,
          channel: event.channel.channel,
          removedCount: removed.length,
        });
      }
    } catch (error) {
      this.logger.debug?.(
        "messaging channel pending-intent cleanup failed on bind",
        {
          bindingId: upserted.id,
          channel: event.channel.channel,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    // Renderer's binding chip is fed by the navigation snapshot. The
    // snapshot only refetches on backend events — and binding creation
    // doesn't emit one. Fan out a bindings-changed notification so the
    // UI picks up the new chip immediately (issue #191).
    this.notifyBindingChanged("bind");
    return upserted;
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

  private recordBindingActivity(
    action: ThreadMessagingBindingTransition["action"],
    binding: MessagingBindingRecord,
    occurredAt: number,
  ): void {
    try {
      const conversation = binding.channel.conversation;
      const log = this.desktopActivityLog();
      if (!log) return;
      log.record({
        platform: binding.channel.channel,
        kind: "binding",
        backend: binding.backend,
        threadId: binding.threadId,
        bindingId: binding.id,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        summary: `Channel ${action}: ${describeConversation(conversation)} / ${binding.threadId}`,
        createdAt: occurredAt,
        payload: {
          action,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          parentTitle: conversation.parentTitle,
          ancestorTitle: conversation.ancestorTitle,
        },
      });
    } catch {
      // Activity log is best-effort observability.
    }
  }

  private desktopActivityLog(): MessagingActivityLog | undefined {
    return this.options.activityLog?.();
  }

  private async deliver(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    guard?: MessagingDeliveryGuard,
  ): Promise<MessagingDeliveryResult> {
    if (binding && shouldFlushToolUpdatesBeforeIntent(intent)) {
      await this.flushToolUpdatesForBinding(binding, { clear: false });
      if (intent.kind === "approval" || intent.kind === "questionnaire") {
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
    let scope = this.options.adapter.resolveDeliveryScope?.(routedIntent);
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
    while (true) {
      if (guard?.isCancelled()) {
        return cancelledResult();
      }
      if (this.deliveryBudget) {
        const budgetChannel = channel ?? scope?.platform ?? "telegram";
        let admission = this.deliveryBudget.admit({
          consumeCapacity: consumeDeliveryBudget,
          priority,
          scope,
        });
        while (admission.outcome === "deferred") {
          const budgetEvent: MessagingControllerDeliveryBudgetEvent = {
            at: this.now(),
            backend: binding?.backend,
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
      const result = await this.options.adapter.deliver(routedIntent);
      if (guard?.isCancelled()) {
        await guard.onCancelledDelivery?.(result);
        return cancelledResult();
      }
      this.logDeliveryResult(routedIntent, binding, result);
      if (this.deliveryBudget && result.rateLimit) {
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
        await this.recordBindingTransition("unbound", binding);
        this.notifyBindingChanged("permanent-delivery-failure");
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
      await this.resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
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
      await this.resolveToolUpdateDefaultMode(binding.targetKind ?? "thread"),
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

  private rememberCompletedTaskMonitorTurn(
    bindingId: string,
    turnId: string,
  ): void {
    this.completedTaskMonitorTurns.add(this.turnProseKey(bindingId, turnId));
    while (this.completedTaskMonitorTurns.size > MAX_TRACKED_TURN_PROSE) {
      const oldest = this.completedTaskMonitorTurns.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.completedTaskMonitorTurns.delete(oldest);
    }
  }

  private isTaskMonitorTurnComplete(
    bindingId: string,
    turnId: string,
  ): boolean {
    return this.completedTaskMonitorTurns.has(
      this.turnProseKey(bindingId, turnId),
    );
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
    const isTaskMonitorCancelled = () =>
      this.isTaskMonitorTurnComplete(delivery.bindingId, delivery.turnId);
    if (isTaskMonitorCancelled()) {
      return;
    }
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

    const intent = binding.channel.channel === "slack"
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
    this.markProseActivitiesDelivered({ ...delivery, activities });
    const cancellation = this.ensureWorkingUpdateCancellationSignal(
      binding,
      delivery.turnId,
    );
    const guardedIsCancelled = () =>
      isTaskMonitorCancelled() || cancellation.isCancelled();
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
    if (this.attemptedPrivateResponseFallbackTurnKeys.has(turnKey)) {
      return;
    }
    rememberBoundedKey(this.attemptedPrivateResponseFallbackTurnKeys, turnKey);

    const response = await this.sendPrivateResponseFromAgentMessagingOrigin({
      operation: "send_private_response",
      context: {
        backend: params.event.backend,
        threadId: params.binding.threadId,
        turnId: params.turnId,
      },
      args: { text: params.text },
    });
    if (response.ok) {
      return;
    }
    rememberBoundedKey(this.privateResponseFallbackTurnKeys, turnKey);

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

  private async attachThreadHereFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "attach_thread_here" }>,
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

    const origin = await this.resolveAgentMessagingOrigin(request.context);
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

    const location = await this.summarizeAgentMessagingLocation(origin.origin, {
      navigation: target.navigation,
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
    if (resolvedPlacement.placement === "new_child") {
      if (!this.options.adapter.createManagedConversation) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "This messaging provider does not support creating a native child conversation from PwrAgent.",
          },
        };
      }
      const createResult = await this.options.adapter.createManagedConversation({
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

    const binding = await this.bindChannelToThread(attachEvent, {
      backend: args.backend,
      federatedThread: target.federatedThread,
      threadId: args.threadId,
      targetKind,
    });
    const visibleBinding = await this.renderBindingStatus(binding);
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
    if (!this.options.adapter.setConversationTitle) {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message:
            "This messaging provider does not support renaming the current conversation.",
        },
      };
    }

    const result = await this.options.adapter.setConversationTitle({
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

    return {
      ok: true,
      data: {
        channel: result.channel,
        conversation: summarizeMessagingConversation(result.conversation),
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
    this.privateResponseFallbackTurnKeys.delete(turnKey);
    rememberBoundedKey(this.attemptedPrivateResponseFallbackTurnKeys, turnKey);
    const origin = await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return origin;
    }
    if (!this.options.adapter.resolvePrivateConversation) {
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
      privateConversation = await this.options.adapter.resolvePrivateConversation({
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
    const sourceThread = sourceBinding
      ? await this.resolveBoundThreadSummary(sourceBinding)
      : undefined;
    const attributionLabel = sourceBinding
      ? responseAttributionLabel(sourceBinding, sourceThread)
      : "PwrAgent Agent";
    const result = await this.deliver(
      {
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

    rememberBoundedKey(this.terminalPrivateResponseTurnKeys, turnKey);
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
        let continuationBinding = await this.bindChannelToThread(
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
              source: privateReplySourceFromBinding(sourceBinding),
            },
            updatedAt: this.now(),
          });
          this.notifyBindingChanged("private-reply-awaiting");
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
  }

  private async sendMessagingFileFromAgentMessagingOrigin(
    request: Extract<
      PwrAgentMessagingRequest,
      { operation: "send_messaging_file" }
    >,
  ): Promise<PwrAgentMessagingResponse> {
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
    const permission = this.checkDynamicToolPermission({
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
      if (!this.options.adapter.resolvePrivateConversation) {
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
        privateConversation = await this.options.adapter.resolvePrivateConversation({
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

    const outbound = await resolveMessagingOutboundFile(
      {
        path: typeof request.args?.path === "string" ? request.args.path : "",
        ...(filename ? { filename } : {}),
        ...(mediaKind ? { mediaKind } : {}),
      },
      this.capabilityProfile.outboundAttachments ?? {},
      await this.resolveOutboundFileAccess(request.context),
    );
    if (!outbound.ok) {
      return {
        ok: false,
        error: {
          code: outbound.code,
          message: outbound.message,
        },
      };
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
      const navigation = await this.options.backend.getNavigationSnapshot({
        backend: context.backend,
      });
      const thread = navigation.threads.find(
        (candidate) =>
          candidate.source === context.backend
          && candidate.id === context.threadId,
      );
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
    let navigation: NavigationSnapshot;
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
      navigation = await this.options.backend.getNavigationSnapshot({
        backend: request.backend,
      });
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

    const target = navigation.threads.find(
      (thread) =>
        thread.source === request.backend
        && thread.id === request.threadId,
    );
    if (!target) {
      return attachTargetNotFound(request.backend, request.threadId);
    }

    return { ok: true, navigation, thread: target };
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
              "No active messaging origin is recorded for this Agent turn.",
          },
        };
      }
      return { ok: true, origin };
    }

    let navigation: NavigationSnapshot | undefined;
    try {
      navigation = await this.options.backend.getNavigationSnapshot({
        backend: context.backend,
      });
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
    options: { navigation?: NavigationSnapshot } = {},
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
      managedConversation: await this.resolveManagedConversationSummary(origin),
      outboundAttachments: this.summarizeOutboundAttachments(),
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

  private async resolveBoundThreadSummary(
    binding: MessagingBindingRecord,
    navigation?: NavigationSnapshot,
  ): Promise<PwrAgentMessagingBoundThreadSummary | undefined> {
    const existingThread = navigation
      ? findThreadForBinding(navigation, binding)
      : undefined;
    if (existingThread) {
      return summarizeNavigationThreadForMessaging(existingThread);
    }
    try {
      const refreshedNavigation = await this.options.backend.getNavigationSnapshot({
        backend: binding.backend,
      });
      const thread = findThreadForBinding(refreshedNavigation, binding);
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
      typeof this.options.adapter.createManagedConversation === "function";
    if (!this.options.adapter.getManagedConversationRights) {
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

    const rights = await this.options.adapter.getManagedConversationRights({
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

  private isAuthorized(platformUserId: string): boolean {
    return this.authorizedActorIds.has(platformUserId);
  }

  // -------------------------------------------------------------------------
  // RBAC — capability layer (issue #260). Composes with, never replaces, the
  // provider admission gate. In legacy-compatible mode (no policy provider, or
  // enforcement disabled) every method here is a no-op so behavior is identical
  // to pre-RBAC PwrAgent.
  // -------------------------------------------------------------------------

  /**
   * Resolve the triggering actor's effective permissions, or `null` in
   * legacy-compatible mode (caller should treat null as "allow, Admin-implied").
   *
   * The admission-path inference: a caller in `authorizedActorIds` is a *named*
   * actor (only their named attachments apply); anyone else was admitted by the
   * provider through a bucket access mode (DM workspace bucket for direct
   * messages, channel bucket otherwise), so the matching bucket attachment
   * applies. See #260 §3.
   */
  private resolveActorPermissions(
    event: MessagingInboundEvent,
  ): RbacResolution | null {
    const provider = this.options.rbacPolicy;
    if (!provider) {
      return null;
    }
    const actorId = event.actor.platformUserId;
    const named = this.authorizedActorIds.has(actorId);
    const admittedVia = named
      ? {}
      : event.channel.conversation.kind === "dm"
        ? { dmBucket: true }
        : { channelBucket: true };
    const input = {
      actorId,
      conversationId: event.channel.conversation.id,
      admittedVia,
    };
    // One policy read when the provider supports it — a gated action asks both
    // "are we enforcing?" and "what may they do?", and each ask re-reads.
    if (provider.resolveIfEnforcing) {
      return provider.resolveIfEnforcing(input);
    }
    return provider.isEnforcing() ? provider.resolve(input) : null;
  }

  /**
   * Admission gate replacement. Legacy mode preserves the exact
   * `authorizedActorIds` membership check. Enforcing mode admits any actor that
   * resolves to at least one permission-granting role (named or bucket) and
   * default-denies the rest.
   */
  private authorizeInboundAdmission(event: MessagingInboundEvent): boolean {
    const resolution = this.resolveActorPermissions(event);
    if (resolution === null) {
      return this.isAuthorized(event.actor.platformUserId);
    }
    return !resolution.rejected;
  }

  /**
   * Gate a single action. Returns true (proceed) in legacy mode or when the
   * actor holds `permission`; otherwise records an audit row, optionally
   * notifies the user, and returns false. `notify: false` silently drops (used
   * for the plain-reply floor to avoid spamming a channel).
   */
  private async requirePermission(
    event: MessagingInboundEvent,
    permission: MessagingPermissionId,
    auditAction: string,
    opts?: { notify?: boolean },
  ): Promise<boolean> {
    const resolution = this.resolveActorPermissions(event);
    if (resolution === null) {
      return true;
    }
    if (resolution.permissions.has(permission)) {
      return true;
    }
    this.recordCapabilityDenied(event, permission, resolution.roleIds, auditAction);
    if (opts?.notify !== false) {
      await this.deliverCapabilityDenied(event);
    }
    return false;
  }

  /**
   * Federation SCOPE gate. Every other permission answers "what may this actor
   * do"; this one answers "where". Required IN ADDITION to the action's own
   * permission whenever the thread being acted on lives on another instance —
   * the same double-gate shape as `thread.execution.full_access`, and for the
   * same reason: `thread.resume` on a peer's thread is a materially bigger
   * grant than on a local one, and `thread.execution.full_access` on a peer's
   * thread is full access on ANOTHER MACHINE.
   *
   * Local targets short-circuit to `true`, so this costs nothing for the
   * single-instance case. Legacy (unenforced) mode is allow-all as always.
   */
  private async requireRemoteScope(
    event: MessagingInboundEvent,
    target: FederationTarget | undefined,
    auditAction: string,
    opts?: { notify?: boolean },
  ): Promise<boolean> {
    if (!target || target.scope !== "remote") {
      return true;
    }
    return await this.requirePermission(
      event,
      "federation.remote_control",
      auditAction,
      opts,
    );
  }

  /**
   * Non-auditing permission probe for render-time filtering. `requirePermission`
   * records a denial and messages the user, which is right when they ASKED to do
   * something and wrong when we're deciding what to put on a menu.
   */
  private actorHasPermission(
    event: MessagingInboundEvent,
    permission: MessagingPermissionId,
  ): boolean {
    const resolution = this.resolveActorPermissions(event);
    return resolution === null || resolution.permissions.has(permission);
  }

  /**
   * Strip peers' threads from a snapshot before it reaches a picker. Enforcement
   * alone would still leak: the resume browser lists thread titles and projects,
   * so an actor without remote scope would read a peer's work before being told
   * they can't touch it. Filtering here keeps the menu honest — every row it
   * shows is a row the actor may actually bind.
   */
  private filterRemoteThreadsForActor<T extends NavigationSnapshot>(
    event: MessagingInboundEvent,
    navigation: T,
  ): T {
    if (this.actorHasPermission(event, "federation.remote_control")) {
      return navigation;
    }
    const localThreads = navigation.threads.filter(
      (thread) => federationTargetForThread(thread) === undefined,
    );
    if (localThreads.length === navigation.threads.length) {
      return navigation;
    }
    const localKeys = new Set(localThreads.map(threadKeyForNavigationThread));
    return {
      ...navigation,
      threads: localThreads,
      inboxThreadKeys: navigation.inboxThreadKeys.filter((key) =>
        localKeys.has(key),
      ),
    };
  }

  /** `requireRemoteScope` for an already-resolved binding. */
  private async requireRemoteScopeForBinding(
    event: MessagingInboundEvent,
    binding: MessagingBindingRecord | undefined,
    auditAction: string,
    opts?: { notify?: boolean },
  ): Promise<boolean> {
    if (!binding) return true;
    return await this.requireRemoteScope(
      event,
      federationTargetForBinding(binding),
      auditAction,
      opts,
    );
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

  private recordCapabilityDenied(
    event: MessagingInboundEvent,
    permission: MessagingPermissionId | "(admission)",
    roleIds: readonly string[],
    auditAction: string,
  ): void {
    try {
      const log = this.desktopActivityLog();
      if (!log) return;
      const conversation = event.channel.conversation;
      const who = event.actor.displayName ?? event.actor.platformUserId;
      log.record({
        platform: event.channel.channel,
        kind: "inbound-rejected",
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary: `Denied ${auditAction}: ${who} lacks ${permission}`,
        createdAt: this.now(),
        payload: {
          reason: "unauthorized-capability",
          permission,
          roleIds: [...roleIds],
          auditAction,
          conversationKind: conversation.kind,
        },
      });
    } catch {
      // Activity log is best-effort observability.
    }
  }

  private async deliverCapabilityDenied(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("capability-denied"),
        createdAt: this.now(),
        title: "Not permitted",
        body: "You don't have permission to do that.",
        recoverable: false,
      }),
      undefined,
      event,
    );
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
  }): { owns: boolean; allowed: boolean; permission?: string } {
    if (!params.turnId) {
      return { owns: false, allowed: true };
    }
    const origin = this.activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(params.backend, params.threadId, params.turnId),
    );
    if (!origin) {
      return { owns: false, allowed: true };
    }
    const resolution = this.resolveActorPermissions(origin.event);
    if (resolution === null) {
      // Legacy-compatible mode: full capability, exactly as before RBAC.
      return { owns: true, allowed: true };
    }
    // `mutate_thread` is gated PER FIELD (model/reasoning/fast/rename/execution
    // mode) at parity with the status buttons, including the Full Access danger
    // gate; every other tool needs a single category permission.
    const required =
      params.category === "thread_inspection" && params.tool === "mutate_thread"
        ? permissionsForThreadMutation(params.arguments)
        : ((): MessagingPermissionId[] => {
            const permission = permissionForDynamicTool(params.category, params.tool);
            return permission ? [permission] : [];
          })();
    // Scope: the thread tools accept `instanceId` / `includeRemote`, so the
    // agent can aim them at a peer. Reaching another instance needs the scope
    // permission on top of the tool's own — and it applies even to otherwise
    // ungated tools, because "benign here" is not benign on someone else's
    // machine.
    if (toolArgsTargetRemoteInstance(params.arguments)) {
      required.push("federation.remote_control");
    }
    if (required.length === 0) {
      // Benign tool (e.g. get_current_messaging_surface, or a no-op mutation).
      return { owns: true, allowed: true };
    }
    const missing = required.find(
      (permission) => !resolution.permissions.has(permission),
    );
    if (!missing) {
      return { owns: true, allowed: true };
    }
    this.recordCapabilityDenied(
      origin.event,
      missing,
      resolution.roleIds,
      `tool:${params.category}:${params.tool}`,
    );
    return { owns: true, allowed: false, permission: missing };
  }

  private newIntentId(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }
}

export function isMessagingInteractivePendingRequest(
  notification: AgentEvent["notification"],
): notification is AppServerPendingRequestNotification {
  return (
    notification.method === "item/tool/requestUserInput"
    || notification.method === "mcpServer/elicitation/request"
    || notification.method === "applyPatchApproval"
    || notification.method === "execCommandApproval"
    || notification.method.toLowerCase().includes("requestapproval")
  );
}

function readCommandAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const match = /^command:([a-z0-9_-]+)$/i.exec(actionId);
  return match?.[1]?.toLowerCase();
}


/**
 * Narrow an `AppServerNotification` to the `thread/executionMode/queued`
 * variant and return its strongly-typed params. The shared union is
 * tricky to narrow because `AppServerPendingRequestNotification` widens
 * `method: string`, so we look at the params shape too.
 */
function readExecutionModeQueuedParams(
  notification: AgentEvent["notification"],
):
  | { threadId: ThreadIdentifier; queuedExecutionMode: ThreadExecutionMode; queuedAt: number }
  | undefined {
  if (notification.method !== "thread/executionMode/queued") {
    return undefined;
  }
  const params = notification.params as {
    threadId?: unknown;
    queuedExecutionMode?: unknown;
    queuedAt?: unknown;
  };
  if (
    typeof params.threadId === "string" &&
    (params.queuedExecutionMode === "default" || params.queuedExecutionMode === "full-access") &&
    typeof params.queuedAt === "number"
  ) {
    return {
      threadId: params.threadId,
      queuedExecutionMode: params.queuedExecutionMode,
      queuedAt: params.queuedAt,
    };
  }
  return undefined;
}

function readExecutionModeQueueClearedParams(
  notification: AgentEvent["notification"],
): { threadId: ThreadIdentifier; reason: "applied" | "cancelled" } | undefined {
  if (notification.method !== "thread/executionMode/queueCleared") {
    return undefined;
  }
  const params = notification.params as {
    threadId?: unknown;
    reason?: unknown;
  };
  if (
    typeof params.threadId === "string" &&
    (params.reason === "applied" || params.reason === "cancelled")
  ) {
    return { threadId: params.threadId, reason: params.reason };
  }
  return undefined;
}

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

function readBrowseAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("browse:") ? actionId : undefined;
}

function readHelpNavAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (
    actionId === "help:page:next"
    || actionId === "help:page:prev"
    || actionId === "help:cancel"
  ) {
    return actionId;
  }
  return undefined;
}

/**
 * Read the target page index from a help-nav callback's value
 * payload. Returns 0 (first page) when the value is missing or
 * malformed — clamping in `paginateHelpCatalog` will pin to the
 * first/last page anyway, so an absent value never crashes the
 * re-render.
 */
function readHelpPageIndex(event: MessagingInboundCallbackEvent): number {
  const value = event.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).pageIndex;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return 0;
}

function readStatusAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("status:")
    || actionId.startsWith("handoff:")
    || actionId.startsWith("skills:")
    ? actionId
    : undefined;
}

function readMonitorAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("monitor:") ? actionId : undefined;
}

function normalizeMonitorCommandAction(
  args: readonly string[] | undefined,
): MonitorCommandAction {
  const normalized = args?.[0]?.trim().toLowerCase();
  if (normalized === "stop" || normalized === "off" || normalized === "disable") {
    return { kind: "stop" };
  }
  if (normalized === "refresh" || normalized === "now") {
    return { kind: "refresh" };
  }
  if (normalized === "topic" || normalized === "topics") {
    const topicAction = args?.[1]?.trim().toLowerCase();
    if (
      topicAction === "cleanup" ||
      topicAction === "clean" ||
      topicAction === "sweep"
    ) {
      return { kind: "topics-cleanup" };
    }
    if (
      topicAction === "fanout" ||
      topicAction === "fan-out" ||
      topicAction === "attach"
    ) {
      return { kind: "topics-fanout" };
    }
    return { kind: "topics-adopt" };
  }
  if (
    normalized === "interval" ||
    normalized === "every" ||
    normalized === "frequency"
  ) {
    const intervalMs = parseMonitorIntervalArg(args?.[1]);
    return typeof intervalMs === "number"
      ? { kind: "set-interval", intervalMs }
      : { kind: "cycle-interval" };
  }
  if (normalized === "pins" || normalized === "pin") {
    const count = parseMonitorCountArg(args?.[1]);
    return typeof count === "number"
      ? { kind: "set-pinned", count }
      : { kind: "cycle-pinned" };
  }
  if (
    normalized === "recent" ||
    normalized === "recents" ||
    normalized === "threads"
  ) {
    const count = parseMonitorCountArg(args?.[1]);
    return typeof count === "number"
      ? { kind: "set-recent", count }
      : { kind: "cycle-recent" };
  }
  if (
    normalized === "status" ||
    normalized === "details" ||
    normalized === "detail"
  ) {
    const enabled = parseMonitorStatusLineArg(args?.[1]);
    return typeof enabled === "boolean"
      ? { kind: "set-status-line", enabled }
      : { kind: "toggle-status-line" };
  }
  if (
    normalized === "snippet" ||
    normalized === "snippets" ||
    normalized === "response"
  ) {
    const enabled = parseMonitorBooleanArg(args?.[1]);
    return typeof enabled === "boolean"
      ? { kind: "set-snippet", enabled }
      : { kind: "toggle-snippet" };
  }
  return { kind: "start" };
}

function normalizeMonitorCallbackAction(actionId: string): MonitorCommandAction {
  if (actionId === "monitor:interval") {
    return { kind: "cycle-interval" };
  }
  if (actionId === "monitor:pins") {
    return { kind: "cycle-pinned" };
  }
  if (actionId === "monitor:recent") {
    return { kind: "cycle-recent" };
  }
  if (actionId === "monitor:status") {
    return { kind: "toggle-status-line" };
  }
  if (actionId === "monitor:snippet") {
    return { kind: "toggle-snippet" };
  }
  return { kind: "refresh" };
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

function parseMonitorCountArg(arg: string | undefined): number | undefined {
  if (!arg) {
    return undefined;
  }
  const parsed = Number(arg.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMonitorIntervalArg(arg: string | undefined): number | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const match = normalized.match(
    /^(\d+(?:\.\d+)?)(?:\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes))?$/,
  );
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = match[2];
  if (unit?.startsWith("m")) {
    return value * 60_000;
  }
  return value * 1000;
}

function parseMonitorStatusLineArg(arg: string | undefined): boolean | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "line" ||
    normalized === "lines" ||
    normalized === "detail" ||
    normalized === "details"
  ) {
    return true;
  }
  if (normalized === "inline" || normalized === "off") {
    return false;
  }
  return parseMonitorBooleanArg(normalized);
}

function parseMonitorBooleanArg(arg: string | undefined): boolean | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "on" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "off" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
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

function topicChannelRef(topic: MessagingManagedTopicRecord): MessagingChannelRef {
  return {
    channel: topic.channel,
    conversation: topic.conversation,
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

/**
 * Match the cancel button on a "Permissions queued" audit message. The
 * action id is `permissions:queue:cancel:${queueId}`; the queueId is
 * encoded so multiple queue posts in the same conversation can't
 * collide. Returns the parsed queueId on match, undefined otherwise.
 *
 * The queueId is what the controller-side tracking map keys against,
 * so the cancel handler can detect stale clicks (the apply has
 * already happened, or a different queue has replaced this one) and
 * respond with explicit feedback rather than silently no-op'ing
 * through the registry's `cancelThreadExecutionModeQueue` call.
 */
function readPermissionsQueueCancelAction(
  event: MessagingInboundCallbackEvent,
): { queueId: string } | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith(PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX)) {
    return undefined;
  }
  const queueId = actionId.slice(PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX.length);
  if (!queueId) {
    return undefined;
  }
  return { queueId };
}

function readFullAccessRiskAction(
  event: MessagingInboundCallbackEvent,
): "accept" | "dismiss" | "cancel" | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith(FULL_ACCESS_RISK_ACTION_PREFIX)) {
    return undefined;
  }
  const action = actionId.slice(FULL_ACCESS_RISK_ACTION_PREFIX.length);
  return action === "accept" || action === "dismiss" || action === "cancel"
    ? action
    : undefined;
}

function readAcpRuntimeRiskAction(
  event: MessagingInboundCallbackEvent,
): "accept" | "dismiss" | "cancel" | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith(ACP_RUNTIME_RISK_ACTION_PREFIX)) {
    return undefined;
  }
  const action = actionId.slice(ACP_RUNTIME_RISK_ACTION_PREFIX.length);
  return action === "accept" || action === "dismiss" || action === "cancel"
    ? action
    : undefined;
}

function readAcpRuntimeRiskContext(
  value: MessagingJsonValue | undefined,
): AcpRuntimeRiskWarningContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source =
    value.source === "mode" ||
    value.source === "configOption" ||
    value.source === "model"
      ? value.source
      : undefined;
  if (
    value.kind === "new-thread" &&
    typeof value.sessionId === "string" &&
    typeof value.optionId === "string" &&
    typeof value.value === "string" &&
    typeof value.label === "string" &&
    source
  ) {
    return {
      kind: "new-thread",
      label: value.label,
      optionId: value.optionId,
      sessionId: value.sessionId,
      source,
      value: value.value,
    };
  }
  if (
    value.kind === "thread" &&
    typeof value.bindingId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.optionId === "string" &&
    typeof value.value === "string" &&
    typeof value.label === "string" &&
    source
  ) {
    return {
      bindingId: value.bindingId,
      kind: "thread",
      label: value.label,
      optionId: value.optionId,
      source,
      threadId: value.threadId,
      value: value.value,
    };
  }
  return undefined;
}

function readFullAccessRiskContext(
  value: MessagingJsonValue | undefined,
): FullAccessRiskWarningContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (value.kind === "new-thread" && typeof value.sessionId === "string") {
    return {
      kind: "new-thread",
      ...(value.pendingPrompt === true ? { pendingPrompt: true } : {}),
      sessionId: value.sessionId,
    };
  }
  if (
    value.kind === "resume-thread" &&
    typeof value.backend === "string" &&
    isAppServerBackendKind(value.backend) &&
    typeof value.sessionId === "string" &&
    typeof value.threadId === "string"
  ) {
    return {
      backend: value.backend,
      ...(typeof value.federationInstanceId === "string"
        ? { federationInstanceId: value.federationInstanceId }
        : {}),
      kind: "resume-thread",
      sessionId: value.sessionId,
      threadId: value.threadId,
    };
  }
  if (
    value.kind === "thread" &&
    typeof value.bindingId === "string" &&
    typeof value.threadId === "string"
  ) {
    return {
      bindingId: value.bindingId,
      kind: "thread",
      threadId: value.threadId,
    };
  }
  return undefined;
}

function fullAccessRiskPresentationForContext(
  context: FullAccessEscalationContext,
  presentationMode: FullAccessRiskPresentationMode,
): FullAccessRiskPresentation {
  if (presentationMode === "message") {
    return {};
  }
  if (context.kind === "thread") {
    return {
      binding: context.binding,
      surface: context.binding?.statusSurface ?? context.binding?.pinnedStatusSurface,
    };
  }
  return { surface: context.session.surface };
}

function readQueuedTurnAction(
  event: MessagingInboundCallbackEvent,
): QueuedTurnAction | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const steerPrefix = "queued-turn:steer:";
  if (actionId.startsWith(steerPrefix)) {
    return {
      kind: "steer",
      entryId: actionId.slice(steerPrefix.length),
    };
  }

  const cancelPrefix = "queued-turn:cancel:";
  if (actionId.startsWith(cancelPrefix)) {
    return {
      kind: "cancel",
      entryId: actionId.slice(cancelPrefix.length),
    };
  }

  return undefined;
}

function handoffContextForBinding(
  binding: MessagingBindingRecord,
  navigation: NavigationSnapshot,
): MessagingWorkspaceHandoffContext | undefined {
  const thread = findThreadForBinding(navigation, binding);
  if (!thread) {
    return undefined;
  }

  const worktreeDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree" || Boolean(directory.worktreePath),
  );
  if (worktreeDirectory) {
    const repositoryPath = worktreeDirectory.path;
    const workingDirectoryPath = worktreeDirectory.worktreePath ?? worktreeDirectory.path;
    const branch = thread.observedGitBranch ?? thread.gitBranch;
    if (!repositoryPath || !workingDirectoryPath || !branch) {
      return undefined;
    }
    return {
      backend: binding.backend,
      branch,
      leaveLocalBranches: [],
      projectLabel: worktreeDirectory.label,
      repositoryPath,
      threadId: binding.threadId,
      threadTitle: thread.title,
      workingDirectoryPath,
      workspaceKind: "worktree",
    };
  }

  const localDirectory =
    thread.linkedDirectories.find((directory) => directory.kind === "local") ??
    thread.linkedDirectories[0];
  if (!localDirectory?.path) {
    return undefined;
  }
  const directorySummary = findNavigationDirectory(navigation, localDirectory);
  const branch =
    thread.observedGitBranch ??
    thread.gitBranch ??
    directorySummary?.gitStatus?.currentBranch;
  if (!branch) {
    return undefined;
  }
  const leaveLocalBranches = (
    directorySummary?.gitStatus?.handoffBranches ??
    directorySummary?.gitStatus?.branches?.filter((candidate) => candidate !== branch) ??
    []
  ).filter(
    (candidate, index, branches) =>
      candidate !== "HEAD" && candidate !== branch && branches.indexOf(candidate) === index,
  );
  const leaveLocalBranchChoices = ["HEAD", ...leaveLocalBranches];

  return {
    backend: binding.backend,
    branch,
    leaveLocalBranches: leaveLocalBranchChoices,
    projectLabel: localDirectory.label,
    repositoryPath: localDirectory.path,
    threadId: binding.threadId,
    threadTitle: thread.title,
    workingDirectoryPath: localDirectory.path,
    workspaceKind: "local",
  };
}

function branchPageIndexFromValue(value: MessagingJsonValue | undefined): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const pageIndex = value.pageIndex;
  return typeof pageIndex === "number" && Number.isFinite(pageIndex)
    ? Math.max(0, Math.trunc(pageIndex))
    : 0;
}

function findNavigationDirectory(
  navigation: NavigationSnapshot,
  linkedDirectory: LinkedDirectorySummary,
): NavigationDirectorySummary | undefined {
  return navigation.directories.find(
    (directory) =>
      directory.key === linkedDirectory.id ||
      directory.path === linkedDirectory.path ||
      (linkedDirectory.worktreePath && directory.path === linkedDirectory.worktreePath),
  );
}

function reviewWorkspaceMatches(
  directoryPath: string | undefined,
  cwd: string | undefined,
): boolean {
  if (!directoryPath || !cwd) {
    return false;
  }
  const normalize = (value: string) => value.replace(/\/+$/, "");
  return normalize(directoryPath) === normalize(cwd);
}

function reviewWorkspaceContains(
  workspacePath: string | undefined,
  cwd: string | undefined,
): boolean {
  if (!workspacePath || !cwd) {
    return false;
  }
  const relative = path.relative(
    path.resolve(workspacePath),
    path.resolve(cwd),
  );
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function reviewThreadForWorkspace(
  thread: NavigationThreadSummary | undefined,
  cwd: string | undefined,
): NavigationThreadSummary | undefined {
  if (!thread || thread.linkedDirectories.length <= 1) {
    return thread;
  }
  return reviewWorkspaceContains(cwd, thread.projectKey)
    ? thread
    : undefined;
}

function paginateReviewWorkspaces(params: {
  itemCount: number;
  maxActions: number | undefined;
  pageIndex: number | undefined;
}): {
  endIndex: number;
  pageIndex: number;
  startIndex: number;
  totalPages: number;
} {
  const maxActions =
    params.maxActions === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.trunc(params.maxActions));
  const singlePageSize = Math.max(1, maxActions - 2);
  const pageSize =
    params.itemCount > singlePageSize
      ? Math.max(1, maxActions - 4)
      : singlePageSize;
  const totalPages = Math.max(1, Math.ceil(params.itemCount / pageSize));
  const requestedPage = Math.max(0, Math.trunc(params.pageIndex ?? 0));
  const pageIndex = Math.min(requestedPage, totalPages - 1);
  const startIndex = pageIndex * pageSize;
  return {
    endIndex: Math.min(params.itemCount, startIndex + pageSize),
    pageIndex,
    startIndex,
    totalPages,
  };
}

function messagingReviewBranchOptions(params: {
  directory: NavigationDirectorySummary | undefined;
  thread: NavigationThreadSummary | undefined;
}): string[] {
  const options = buildReviewBranchOptions(params);
  const primaryBranch = options[0]?.trim();
  const localBranchNames = new Set(
    [
      ...(params.directory?.gitStatus?.branches ?? []),
      params.directory?.gitStatus?.defaultBranch,
    ]
      .map((branch) => branch?.trim())
      .filter((branch): branch is string => Boolean(branch)),
  );
  const baseBranchNames = new Set(
    (params.directory?.gitStatus?.baseBranches ?? [])
      .map((branch) => branch.trim())
      .filter(Boolean),
  );
  const knownBranchNames = new Set(
    [...localBranchNames, ...baseBranchNames],
  );
  const conventionalBaseBranches = new Set([
    "main",
    "master",
    "develop",
    "trunk",
  ]);
  const conventionalName = (branch: string): string | undefined => {
    const value = branch.trim();
    if (conventionalBaseBranches.has(value)) {
      return value;
    }
    if (!baseBranchNames.has(value) || localBranchNames.has(value)) {
      return undefined;
    }
    const remoteSeparator = value.indexOf("/");
    const remoteBranch =
      remoteSeparator >= 0 ? value.slice(remoteSeparator + 1) : "";
    return conventionalBaseBranches.has(remoteBranch)
      ? remoteBranch
      : undefined;
  };
  const knownConventionalOptions = options.filter(
    (branch) =>
      knownBranchNames.has(branch.trim())
      && Boolean(conventionalName(branch)),
  );
  const keepPrimary =
    primaryBranch !== undefined
    && (
      knownBranchNames.has(primaryBranch)
      || primaryBranch !== "main"
      || knownConventionalOptions.length === 0
    );
  return [
    ...(keepPrimary && primaryBranch ? [primaryBranch] : []),
    ...knownConventionalOptions,
  ]
    .filter((branch, index, branches) => branches.indexOf(branch) === index)
    .slice(0, 8);
}

function formatMessagingReviewScope(target: AppServerReviewTarget): string {
  switch (target.type) {
    case "uncommittedChanges":
      return "Current Changes";
    case "baseBranch":
      return "Base Branch";
    case "commit":
      return "Commit";
    case "custom":
      return "Custom";
  }
}

function formatReviewTarget(target: AppServerReviewTarget): string {
  switch (target.type) {
    case "uncommittedChanges":
      return "Current changes review";
    case "baseBranch":
      return `Review against ${target.branch}`;
    case "commit":
      return `Review of commit ${target.sha}`;
    case "custom":
      return "Custom review";
  }
}

function validateHandoffRequest(
  request: HandoffThreadWorkspaceRequest,
  context: MessagingWorkspaceHandoffContext,
): { valid: true } | { valid: false; reason: string } {
  const expectedDirection =
    context.workspaceKind === "local" ? "local-to-worktree" : "worktree-to-local";
  if (
    request.backend !== context.backend ||
    request.threadId !== context.threadId ||
    request.direction !== expectedDirection ||
    request.repositoryPath !== context.repositoryPath ||
    request.sourcePath !== context.workingDirectoryPath
  ) {
    return {
      valid: false,
      reason: "That handoff prompt is stale. Use /status to refresh.",
    };
  }
  if (context.branch && request.sourceBranch !== context.branch) {
    return {
      valid: false,
      reason: "The thread branch changed. Use /status to refresh before handoff.",
    };
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
  return direction === "local-to-worktree"
    ? "Local to new worktree"
    : "Worktree to Local";
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

function filterNavigationToThreads(
  navigation: NavigationSnapshot,
  threads: NavigationThreadSummary[],
): NavigationSnapshot {
  const allowedThreadKeys = new Set(
    threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)),
  );
  return {
    ...navigation,
    threads,
    directories: navigation.directories.map((directory) => ({
      ...directory,
      threadKeys: directory.threadKeys.filter((threadKey) =>
        allowedThreadKeys.has(threadKey)
      ),
    })),
    inboxThreadKeys: navigation.inboxThreadKeys.filter((threadKey) =>
      allowedThreadKeys.has(threadKey)
    ),
  };
}

function normalizeNewThreadSessionForBackend(
  session: MessagingBrowseSessionRecord,
  backend: BackendSummary,
  updatedAt: number,
): MessagingBrowseSessionRecord {
  if (!session.preferences) {
    return session;
  }

  const preferences = { ...session.preferences };
  if (isAcpBackendId(backend.kind)) {
    delete preferences.permissionsMode;
  } else {
    delete preferences.acpRuntime;
  }
  const models = backend.launchpadOptions?.models ?? [];
  if (preferences.model !== undefined) {
    const modelIsValid = models.some((model) => model.id === preferences.model);
    if (models.length === 0) {
      delete preferences.model;
    } else if (!modelIsValid) {
      preferences.model = defaultBackendModel(models)?.id;
    }
  }

  const selectedModel =
    models.find((model) => model.id === preferences.model) ??
    defaultBackendModel(models);
  const reasoningEfforts = reasoningEffortsForModel(backend, selectedModel);
  if (preferences.reasoningEffort !== undefined) {
    if (reasoningEfforts.length === 0) {
      delete preferences.reasoningEffort;
    } else if (!reasoningEfforts.includes(preferences.reasoningEffort)) {
      const defaultReasoningEffort = defaultReasoningEffortForModel(
        backend,
        selectedModel,
      );
      if (defaultReasoningEffort) {
        preferences.reasoningEffort = defaultReasoningEffort;
      } else {
        delete preferences.reasoningEffort;
      }
    }
  }

  const supportsFast =
    Boolean(backend.launchpadOptions?.supportsFastMode) ||
    Boolean(selectedModel?.supportsFast);
  if (!supportsFast) {
    delete preferences.fastMode;
  }

  const serviceTiers = backend.launchpadOptions?.serviceTiers ?? [];
  if (preferences.serviceTier !== undefined) {
    if (serviceTiers.length === 0) {
      delete preferences.serviceTier;
    } else if (!serviceTiers.includes(preferences.serviceTier)) {
      preferences.serviceTier = serviceTiers[0];
    }
  }

  const hasPreferences = Object.keys(preferences).some((key) => key !== "updatedAt");
  return {
    ...session,
    preferences: hasPreferences
      ? {
          ...preferences,
          updatedAt,
        }
      : undefined,
  };
}

function clearNewThreadProviderPreferences(
  session: MessagingBrowseSessionRecord,
  updatedAt: number,
): MessagingBrowseSessionRecord {
  if (!session.preferences) {
    return session;
  }

  const preferences = { ...session.preferences };
  delete preferences.acpRuntime;
  delete preferences.codexEnvironmentActionId;
  delete preferences.codexEnvironmentExecutionTarget;
  delete preferences.codexEnvironmentId;
  delete preferences.codexEnvironmentSetupEnabled;
  delete preferences.executionMode;
  delete preferences.fastMode;
  delete preferences.model;
  delete preferences.permissionsMode;
  delete preferences.reasoningEffort;
  delete preferences.serviceTier;

  const hasPreferences = Object.keys(preferences).some((key) => key !== "updatedAt");
  return {
    ...session,
    preferences: hasPreferences
      ? {
          ...preferences,
          updatedAt,
        }
      : undefined,
  };
}

function defaultBackendModel(
  models: NonNullable<BackendSummary["launchpadOptions"]>["models"] = [],
) {
  return models.find((model) => model.current) ?? models[0];
}

function reasoningEffortsForModel(
  backend: BackendSummary | undefined,
  model: BackendModelOption | undefined,
): string[] {
  return model?.reasoningEfforts ?? backend?.launchpadOptions?.reasoningEfforts ?? [];
}

function defaultReasoningEffortForModel(
  backend: BackendSummary | undefined,
  model: BackendModelOption | undefined,
): string | undefined {
  const efforts = reasoningEffortsForModel(backend, model);
  if (
    model?.defaultReasoningEffort &&
    efforts.includes(model.defaultReasoningEffort)
  ) {
    return model.defaultReasoningEffort;
  }
  return efforts[0];
}

function resolveReasoningEffortForModel(
  backend: BackendSummary | undefined,
  model: BackendModelOption | undefined,
  candidates: Array<string | undefined>,
): string | undefined {
  if (!backend && !model) {
    return candidates.find((candidate): candidate is string => Boolean(candidate));
  }
  const efforts = reasoningEffortsForModel(backend, model);
  const selected = candidates.find((candidate) =>
    candidate ? efforts.includes(candidate) : false,
  );
  return selected ?? defaultReasoningEffortForModel(backend, model);
}

function normalizeReasoningEffortForModel(
  backend: BackendSummary,
  model: BackendModelOption | undefined,
  candidates: Array<string | undefined>,
): string | undefined {
  if (!candidates.some((candidate) => Boolean(candidate))) {
    return undefined;
  }
  return resolveReasoningEffortForModel(backend, model, candidates);
}

type NewThreadOptionsSummary = {
  acpRuntime?: BackendAcpSessionRuntimeState;
  backend: AppServerBackendKind;
  backendLabel: string;
  branchName: string;
  codexEnvironmentActionId?: string | null;
  codexEnvironmentExecutionTarget?: "local" | "remote";
  codexEnvironmentId?: string | null;
  codexEnvironmentOptions: CodexEnvironmentOption[];
  executionMode: ThreadExecutionMode;
  executionModeSource: "session" | "directory-launchpad" | "launchpad-defaults";
  fastMode: boolean;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  supportsFast: boolean;
  supportsModel: boolean;
  supportsReasoning: boolean;
  streamingResponses: boolean;
  workMode: LaunchpadWorkMode;
};

function newThreadOptionsForSession(
  session: MessagingBrowseSessionRecord,
  navigation: NavigationSnapshot,
  directory: NavigationDirectorySummary | undefined,
  streamingResponsesDefault: boolean,
  backend: BackendSummary,
): NewThreadOptionsSummary {
  const launchpadDefaults = applyNavigationLaunchpadProviderSettingsPatch(
    navigation.launchpadDefaults,
    { backend: backend.kind },
  );
  const directoryLaunchpad = directory?.launchpad
    ? applyNavigationLaunchpadProviderSettingsPatch(directory.launchpad, {
        backend: backend.kind,
      })
    : undefined;
  const workMode = resolveNewThreadWorkMode({
    requestedWorkMode:
      session.workMode ??
      directoryLaunchpad?.workMode ??
      launchpadDefaults.workMode ??
      "local",
    directory,
  });
  const streamingMode = session.preferences?.streamingResponses ?? "inherit";
  const models = backend.launchpadOptions?.models ?? [];
  const modelOption =
    models.find((model) => model.id === session.preferences?.model) ??
    models.find((model) => model.id === directoryLaunchpad?.model) ??
    models.find((model) => model.id === launchpadDefaults.model) ??
    models.find((model) => model.current) ??
    models[0];
  const reasoningEfforts = reasoningEffortsForModel(backend, modelOption);
  const reasoningEffort = resolveReasoningEffortForModel(backend, modelOption, [
    session.preferences?.reasoningEffort,
    directoryLaunchpad?.reasoningEffort,
    launchpadDefaults.reasoningEffort,
  ]);
  const serviceTiers = backend.launchpadOptions?.serviceTiers ?? [];
  const serviceTier = [
    session.preferences?.serviceTier,
    directoryLaunchpad?.serviceTier,
    launchpadDefaults.serviceTier,
  ].find((candidate) => candidate ? serviceTiers.includes(candidate) : false);
  const supportsFast =
    Boolean(backend.launchpadOptions?.supportsFastMode) ||
    Boolean(modelOption?.supportsFast);
  const supportsReasoning =
    reasoningEfforts.length > 0 || Boolean(modelOption?.supportsReasoning);
  const acpRuntime = isAcpBackendId(backend.kind)
    ? session.preferences?.acpRuntime ??
      directoryLaunchpad?.acpRuntime ??
      launchpadDefaults.acpRuntime
    : undefined;
  const executionMode =
    session.preferences?.executionMode ??
    directoryLaunchpad?.executionMode ??
    launchpadDefaults.executionMode;
  const executionModeSource = session.preferences?.executionMode
    ? "session"
    : directoryLaunchpad?.executionMode
      ? "directory-launchpad"
      : "launchpad-defaults";
  const codexEnvironmentOptions = directoryLaunchpad?.codexEnvironmentOptions ?? [];
  const codexEnvironmentId = resolveNewThreadCodexEnvironmentId(
    session,
    directoryLaunchpad,
  );
  const selectedEnvironment = codexEnvironmentOptions.find(
    (environment) => environment.id === codexEnvironmentId,
  );
  return {
    backend: backend.kind,
    backendLabel: backend.label,
    acpRuntime,
    branchName: resolveNewThreadBaseBranch(session, navigation, directory),
    codexEnvironmentActionId: selectedEnvironment
      ? session.preferences?.codexEnvironmentActionId ??
        directoryLaunchpad?.codexEnvironmentActionId
      : undefined,
    codexEnvironmentExecutionTarget: selectedEnvironment
      ? session.preferences?.codexEnvironmentExecutionTarget ??
        directoryLaunchpad?.codexEnvironmentExecutionTarget ??
        "local"
      : undefined,
    codexEnvironmentId: selectedEnvironment?.id ?? (codexEnvironmentId === null ? null : undefined),
    codexEnvironmentOptions,
    executionMode,
    executionModeSource,
    fastMode:
      supportsFast
        ? session.preferences?.fastMode ??
          directoryLaunchpad?.fastMode ??
          launchpadDefaults.fastMode ??
          false
        : false,
    model: session.preferences?.model ?? modelOption?.id ?? "default",
    reasoningEffort,
    serviceTier,
    supportsFast,
    supportsModel: models.length > 0,
    supportsReasoning,
    streamingResponses: messagingStreamingResponsesEnabled(
      streamingMode,
      streamingResponsesDefault,
    ),
    workMode,
  };
}

function canCreateNewThreadWorktree(
  directory: NavigationDirectorySummary | undefined,
): boolean {
  if (!directory?.path || directory.kind !== "directory") {
    return false;
  }
  if (directory.gitStatus?.worktreeCreationAvailable !== undefined) {
    return directory.gitStatus.worktreeCreationAvailable;
  }
  return Boolean(
    directory.gitStatus?.currentBranch
    || (directory.gitStatus?.baseBranches?.length ?? 0) > 0
    || (directory.gitStatus?.branches?.length ?? 0) > 0,
  );
}

function resolveNewThreadWorkMode(params: {
  requestedWorkMode: LaunchpadWorkMode;
  directory: NavigationDirectorySummary | undefined;
}): LaunchpadWorkMode {
  return params.requestedWorkMode === "worktree" &&
    canCreateNewThreadWorktree(params.directory)
    ? "worktree"
    : "local";
}

function newThreadPromptGateBody(
  session: MessagingBrowseSessionRecord,
  options: NewThreadOptionsSummary,
  backend: BackendSummary,
  toolUpdateMode: MessagingToolUpdateMode,
  showStreaming: boolean,
): string {
  const acpRuntimeMode = isAcpBackendId(options.backend)
    ? buildMessagingAcpRuntimeModeSummary({
        backend,
        runtime: options.acpRuntime,
      })
    : undefined;
  const permissionsLabel = formatPermissionsLineDisplayLabel({
    acpRuntimeLabel: acpRuntimeMode?.currentLabel,
    current: options.executionMode,
  });
  return [
    `Send the first instruction for ${session.selectedProject?.label ?? "this project"}.`,
    "The thread will be created when that message arrives.",
    isNewAgentThreadLaunchAction(session.launchAction)
      ? `Agent: ${DEFAULT_MESSAGING_AGENT_NAME}`
      : undefined,
    `Provider: ${backend.label}`,
    `Workspace: ${options.workMode === "worktree" ? "New Worktree" : "Local"}`,
    options.workMode === "worktree" ? `Base branch: ${options.branchName}` : undefined,
    acpRuntimeMode || !isAcpBackendId(options.backend) || options.executionMode === "full-access"
      ? `Permissions: ${permissionsLabel}`
      : undefined,
    options.codexEnvironmentOptions.length > 0 || options.codexEnvironmentId
      ? `Environment: ${formatNewThreadEnvironmentLabel(options)}`
      : undefined,
    options.supportsModel ? `Model: ${options.model}` : undefined,
    options.supportsReasoning && options.reasoningEffort
      ? `Reasoning: ${options.reasoningEffort}`
      : undefined,
    options.supportsFast ? `Fast mode: ${options.fastMode ? "on" : "off"}` : undefined,
    `Working Updates: ${formatMessagingToolUpdateModeLabel(toolUpdateMode)}`,
    showStreaming
      ? `Streaming: ${options.streamingResponses ? "on" : "off"}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function resolveNewThreadCodexEnvironmentId(
  session: MessagingBrowseSessionRecord,
  launchpad: NavigationLaunchpadDraft | undefined,
): string | null | undefined {
  if (session.preferences?.codexEnvironmentId === null) {
    return null;
  }
  return (
    session.preferences?.codexEnvironmentId ??
    launchpad?.codexEnvironmentId
  );
}

function formatNewThreadEnvironmentLabel(
  options: Pick<
    NewThreadOptionsSummary,
    "codexEnvironmentId" | "codexEnvironmentOptions"
  >,
): string {
  if (!options.codexEnvironmentId) {
    return "None";
  }
  return (
    options.codexEnvironmentOptions.find(
      (environment) => environment.id === options.codexEnvironmentId,
    )?.name ?? options.codexEnvironmentId
  );
}

function isTerminalCodexEnvironmentSetupProgress(
  event: CodexEnvironmentSetupProgressEvent,
): boolean {
  return event.phase === "completed" || event.phase === "failed";
}

function buildMessagingEnvironmentSetupProgressBody(
  event: CodexEnvironmentSetupProgressEvent,
): string {
  const chunk = event.chunk?.trim();
  return [
    `Environment: ${event.environmentName}`,
    event.command ? `Command: ${event.command}` : undefined,
    event.cwd ? `Directory: ${event.cwd}` : undefined,
    chunk ? `Latest output: ${truncateText(chunk, 500)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildMessagingEnvironmentSetupFailureBody(
  runtime: MaterializedDirectoryLaunchpadThread["codexEnvironmentRuntime"],
  message: string,
): string {
  return [
    runtime?.environmentName ? `Environment: ${runtime.environmentName}` : undefined,
    runtime?.setupCommand ? `Command: ${runtime.setupCommand}` : undefined,
    message,
    "The thread was created and your first message will still be submitted.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildMessagingEnvironmentSetupSuccessBody(
  runtime: MaterializedDirectoryLaunchpadThread["codexEnvironmentRuntime"],
): string {
  const duration = formatDurationMs(runtime?.setupDurationMs);
  return [
    runtime?.environmentName ? `Environment: ${runtime.environmentName}` : undefined,
    runtime?.setupCommand ? `Command: ${runtime.setupCommand}` : undefined,
    duration ? `Duration: ${duration}` : undefined,
    "Your first message will be submitted now.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatDurationMs(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function resolveNewThreadBaseBranch(
  session: MessagingBrowseSessionRecord,
  navigation: NavigationSnapshot,
  directory?: NavigationDirectorySummary,
): string {
  const selectedDirectory =
    directory ??
    (session.selectedProject
      ? directoryForProjectSelection(navigation, session.selectedProject)
      : undefined);
  return (
    sanitizeBranchLabel(session.branchName) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.defaultBranch) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.baseBranches?.[0]) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.branches?.[0]) ??
    sanitizeBranchLabel(selectedDirectory?.gitStatus?.currentBranch) ??
    "main"
  );
}

function newThreadBranchChoices(
  session: MessagingBrowseSessionRecord,
  navigation: NavigationSnapshot,
  directory: NavigationDirectorySummary | undefined,
): string[] {
  const defaultBranch = resolveNewThreadBaseBranch(session, navigation, directory);
  const branches = [
    defaultBranch,
    ...(directory?.gitStatus?.baseBranches ?? []),
    ...(directory?.gitStatus?.branches ?? []),
    directory?.gitStatus?.currentBranch,
  ].flatMap((branch) => {
    const sanitized = sanitizeBranchLabel(branch);
    return sanitized ? [sanitized] : [];
  });
  return branches.filter((branch, index) => branches.indexOf(branch) === index);
}

function sanitizeBranchLabel(branch: string | undefined): string | undefined {
  const normalized = branch?.replace(/^refs\/heads\//, "").trim();
  return normalized || undefined;
}

function normalizeConversationTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function conversationKindLabel(kind: MessagingBindingRecord["channel"]["conversation"]["kind"]): string {
  switch (kind) {
    case "topic":
      return "topic";
    case "thread":
      return "thread";
    case "channel":
      return "channel";
    case "dm":
      return "conversation";
  }
}

function boundThreadConfirmationBody(
  binding: MessagingBindingRecord,
  capabilityProfile: MessagingCapabilityProfile,
): string {
  const noun = binding.targetKind === "agent_thread" ? "Agent thread" : "thread";
  return [
    `Messages in this conversation will route to the selected ${noun}.`,
    sharedConversationMentionInstruction(binding, capabilityProfile),
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

function boundThreadFallbackText(
  binding: MessagingBindingRecord,
  capabilityProfile: MessagingCapabilityProfile,
): string {
  return sharedConversationMentionInstruction(binding, capabilityProfile)
    ?? (binding.targetKind === "agent_thread"
      ? "Send a message to continue with the Agent thread."
      : "Send a message to continue the thread.");
}

function sharedConversationMentionInstruction(
  binding: MessagingBindingRecord,
  capabilityProfile: MessagingCapabilityProfile,
): string | undefined {
  if (
    binding.channel.conversation.kind === "dm" ||
    !capabilityProfile.conversationInput?.sharedConversationRequiresMention
  ) {
    return undefined;
  }
  return capabilityProfile.conversationInput.sharedConversationMentionInstruction;
}

function threadIdForBackendEvent(event: AgentEvent): ThreadIdentifier | undefined {
  const params = event.notification.params as {
    action?: unknown;
    parentThreadId?: unknown;
    threadId?: unknown;
  };
  if (typeof params.threadId === "string") {
    return params.threadId;
  }
  if (typeof params.parentThreadId === "string") return params.parentThreadId;
  const action = params.action as { threadId?: unknown } | undefined;
  return typeof action?.threadId === "string" ? action.threadId : undefined;
}

function scheduledActionForBackendEvent(
  event: AgentEvent,
): ScheduledThreadAction | undefined {
  if (event.notification.method !== "thread/scheduledAction/updated") {
    return undefined;
  }
  const action = (event.notification.params as { action?: unknown }).action;
  return action && typeof action === "object"
    ? action as ScheduledThreadAction
    : undefined;
}

function bindingMatchesScheduledActionOrigin(
  binding: MessagingBindingRecord,
  action: ScheduledThreadAction,
): boolean {
  const origin = action.turn?.messageOrigin?.messaging;
  if (!origin) return true;
  return binding.channel.channel === origin.platform
    && binding.channel.conversation.id === origin.surface.id;
}

function scheduledActionFailureMessage(
  action: ScheduledThreadAction,
): string | undefined {
  return action.status === "failed"
    ? action.errorMessage ?? "The scheduled action could not be dispatched."
    : undefined;
}

function reviewStartOutcomeForBackendEvent(
  event: AgentEvent,
):
  | {
      status: "started" | "cancelled" | "failed";
      error?: string;
    }
  | undefined {
  if (event.notification.method !== "thread/reviewStart/updated") {
    return undefined;
  }
  const params = event.notification.params as {
    status?: unknown;
    error?: unknown;
  };
  if (
    params.status !== "started"
    && params.status !== "cancelled"
    && params.status !== "failed"
  ) {
    return undefined;
  }
  return {
    status: params.status,
    ...(typeof params.error === "string"
      ? { error: params.error }
      : {}),
  };
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

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function formatContextUsageNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function planEntryForBackendEvent(
  event: AgentEvent,
  createdAt: number,
): AppServerThreadPlanEntry | undefined {
  if (event.notification.method !== "turn/plan/updated") {
    return undefined;
  }
  const params = event.notification.params as {
    plan?: {
      explanation?: unknown;
      steps?: unknown;
    };
    turnId?: unknown;
  };
  if (typeof params.turnId !== "string" || !Array.isArray(params.plan?.steps)) {
    return undefined;
  }
  const explanation = typeof params.plan.explanation === "string"
    ? params.plan.explanation.trim()
    : undefined;
  const steps = params.plan.steps.flatMap((step): AppServerThreadPlanEntry["steps"] => {
    if (!step || typeof step !== "object") {
      return [];
    }
    const record = step as { status?: unknown; step?: unknown };
    if (
      typeof record.step !== "string" ||
      !isPlanStepStatus(record.status) ||
      !record.step.trim()
    ) {
      return [];
    }
    return [{ step: record.step.trim(), status: record.status }];
  });
  if (!explanation && steps.length === 0) {
    return undefined;
  }
  return planEntryFromUpdate({
    createdAt,
    id: `plan:${params.turnId}`,
    ...(explanation ? { explanation } : {}),
    steps,
    turnId: params.turnId,
  });
}

function reviewArtifactForBackendEvent(
  event: AgentEvent,
  createdAt: number,
): AppServerThreadReviewEntry | undefined {
  if (event.notification.method !== "item/completed") {
    return undefined;
  }
  const params = event.notification.params as {
    item?: unknown;
    turnId?: unknown;
  };
  if (!params.item || typeof params.item !== "object") {
    return undefined;
  }
  const item = params.item as {
    data?: unknown;
    id?: unknown;
    review?: unknown;
    review_output?: unknown;
    reviewOutput?: unknown;
    text?: unknown;
    type?: unknown;
  };
  if (typeof item.id !== "string" || typeof item.type !== "string") {
    return undefined;
  }
  const normalizedType = normalizeReviewItemType(item.type);
  if (
    normalizedType !== "exitedreviewmode" &&
    normalizedType !== "review" &&
    normalizedType !== "reviewartifact"
  ) {
    return undefined;
  }
  const reviewOutput = normalizeStructuredReviewOutput(item as Record<string, unknown>);
  const review = (typeof item.review === "string" ? item.review.trim() : "") ||
    (typeof item.text === "string" ? item.text.trim() : "") ||
    reviewOutput?.overall_explanation.trim() ||
    "";
  if (!review) {
    return undefined;
  }
  return {
    type: "review",
    id: item.id,
    createdAt,
    review,
    displayText: "Code review completed",
    ...(reviewOutput ? { output: reviewOutput } : {}),
    ...(typeof params.turnId === "string"
      ? {
          turn: {
            id: params.turnId,
          },
        }
      : {}),
  };
}

function normalizeStructuredReviewOutput(
  item: Record<string, unknown>,
): AppServerThreadReviewEntry["output"] | undefined {
  const data = asPlainRecord(item.data);
  const reviewOutput =
    asPlainRecord(data?.reviewOutput) ??
    asPlainRecord(data?.review_output) ??
    asPlainRecord(item.reviewOutput) ??
    asPlainRecord(item.review_output);
  return normalizeReviewOutputRecord(reviewOutput);
}

function isPlanStepStatus(value: unknown): value is AppServerThreadPlanEntry["steps"][number]["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function normalizeReviewItemType(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isReviewTurnMarkerEvent(event: AgentEvent): boolean {
  if (
    event.notification.method !== "item/started"
    && event.notification.method !== "item/completed"
  ) {
    return false;
  }
  const item = (event.notification.params as {
    item?: { type?: unknown };
  }).item;
  if (typeof item?.type !== "string") {
    return false;
  }
  const normalizedType = normalizeReviewItemType(item.type);
  return (
    normalizedType === "enteredreviewmode"
    || normalizedType === "exitedreviewmode"
    || normalizedType === "review"
    || normalizedType === "reviewartifact"
  );
}

function artifactTurnKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

function turnIdForBackendEvent(event: AgentEvent): string | undefined {
  const params = event.notification.params as {
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.turnId === "string") {
    return params.turnId;
  }
  return typeof params.turn?.id === "string" ? params.turn.id : undefined;
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

function agentMessagingTurnKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

function agentMessagingThreadKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
): string {
  return buildThreadIdentityKey(backend, threadId);
}

function agentMessagingQueueKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
  queueEntryId: string,
): string {
  return `${backend}:${threadId}:${queueEntryId}`;
}

function isDefaultAgentRouteBinding(binding: MessagingBindingRecord): boolean {
  return binding.id.startsWith("default-agent-route:");
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

function parseDefaultAgentScopeKind(
  value: string | undefined,
): MessagingDefaultAgentScopeKind | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "conversation"
    || normalized === "parent"
    || normalized === "workspace"
    || normalized === "provider"
    || normalized === "profile"
  ) {
    return normalized;
  }
  return undefined;
}

function formatDefaultAgentScope(scope: MessagingDefaultAgentScope): string {
  switch (scope.kind) {
    case "conversation":
      return "conversation";
    case "parent":
      return "parent conversation";
    case "workspace":
      return "workspace";
    case "provider":
      return `${scope.channel} provider`;
    case "profile":
      return "profile";
  }
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
  navigation: NavigationSnapshot | undefined,
): boolean {
  if (binding.targetKind === "agent_thread") {
    return true;
  }
  if (binding.targetKind !== "thread" || !navigation) {
    return false;
  }
  return navigation.threads.some(
    (thread) =>
      thread.source === binding.backend &&
      thread.id === binding.threadId &&
      Boolean(thread.handoffOrigin),
  );
}

function isLiveMessagingToolOriginBinding(
  binding: MessagingBindingRecord,
  navigation: NavigationSnapshot | undefined,
): boolean {
  return (
    binding.backend === "codex"
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

function turnQueueUpdateForBackendEvent(event: AgentEvent): {
  automationName?: string;
  automationRunId?: string;
  errorMessage?: string;
  finalText?: string;
  origin?: string;
  queueEntryId?: string;
  status?: string;
  suppressBindingBroadcast?: boolean;
  turnId?: string;
} | undefined {
  if (event.notification.method !== "thread/turnQueue/updated") {
    return undefined;
  }
  const params = event.notification.params as {
    automationName?: unknown;
    automationRunId?: unknown;
    errorMessage?: unknown;
    finalText?: unknown;
    origin?: unknown;
    queueEntryId?: unknown;
    status?: unknown;
    suppressBindingBroadcast?: unknown;
    turnId?: unknown;
  };
  return {
    automationName:
      typeof params.automationName === "string" ? params.automationName : undefined,
    automationRunId:
      typeof params.automationRunId === "string" ? params.automationRunId : undefined,
    errorMessage:
      typeof params.errorMessage === "string" ? params.errorMessage : undefined,
    finalText: typeof params.finalText === "string" ? params.finalText : undefined,
    origin: typeof params.origin === "string" ? params.origin : undefined,
    queueEntryId:
      typeof params.queueEntryId === "string" ? params.queueEntryId : undefined,
    status: typeof params.status === "string" ? params.status : undefined,
    suppressBindingBroadcast: params.suppressBindingBroadcast === true,
    turnId: typeof params.turnId === "string" ? params.turnId : undefined,
  };
}

function automationRunUpdateForBackendEvent(event: AgentEvent): {
  finalText?: string;
  outputDecision?: AutomationRunOutputDecision;
  runId: string;
  status: string;
  suppressBindingBroadcast?: boolean;
} | undefined {
  if (event.notification.method !== "automation/run/updated") {
    return undefined;
  }
  const params = event.notification.params as {
    finalText?: unknown;
    outputDecision?: unknown;
    runId?: unknown;
    status?: unknown;
    suppressBindingBroadcast?: unknown;
  };
  if (typeof params.runId !== "string" || typeof params.status !== "string") {
    return undefined;
  }
  return {
    finalText: typeof params.finalText === "string" ? params.finalText : undefined,
    outputDecision: isAutomationRunOutputDecision(params.outputDecision)
      ? params.outputDecision
      : undefined,
    runId: params.runId,
    status: params.status,
    suppressBindingBroadcast: params.suppressBindingBroadcast === true,
  };
}

function isAutomationRunOutputDecision(
  value: unknown,
): value is AutomationRunOutputDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "post_card" || kind === "quiet" || kind === "parse_failed";
}

/**
 * True for a mid-stream (non-final) `agentMessage` completion — a phased item
 * whose phase is neither `final` nor `final_answer` (e.g. Codex `commentary`).
 * These are suppressed on messaging so a turn posts one answer, not a message
 * per intermediate phase.
 *
 * Assumption: a backend marks its user-facing answer with the `final` /
 * `final_answer` phase (or no phase). If a future backend used a different phase
 * string for its terminal text, this would treat it as intermediate — but the
 * answer would still reach messaging via the `turn/completed` output text (see
 * {@link assistantTextForBackendEvent}), so nothing is lost, only slightly
 * delayed to turn end. Widen the allowlist here if that assumption changes.
 */
function isNonFinalAssistantTextForBackendEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "item/completed") {
    return false;
  }
  const params = event.notification.params as {
    item?: {
      phase?: unknown;
      type?: unknown;
    };
  };
  if (params.item?.type !== "agentMessage") {
    return false;
  }
  const phase = typeof params.item.phase === "string" ? params.item.phase : undefined;
  return Boolean(phase && phase !== "final" && phase !== "final_answer");
}

function isFinalAssistantImageResolutionEvent(event: AgentEvent): boolean {
  if (event.notification.method === "turn/completed") {
    return true;
  }
  if (event.notification.method !== "item/completed") {
    return false;
  }
  const item = (event.notification.params as {
    item?: { type?: unknown };
  }).item;
  return item?.type === "agentMessage"
    && !isNonFinalAssistantTextForBackendEvent(event);
}

function isTaskMonitorProgressEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "item/completed") {
    return false;
  }
  const item = (event.notification.params as {
    item?: {
      data?: unknown;
      type?: unknown;
    };
  }).item;
  const data = asPlainRecord(item?.data);
  return (
    item?.type === "agentMessage"
    && data?.source === "pwragent_task_monitor"
    && data.transient === true
  );
}

function isTaskMonitorCompletionEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "item/completed") {
    return false;
  }
  const item = (event.notification.params as {
    item?: {
      data?: unknown;
      type?: unknown;
    };
  }).item;
  const data = asPlainRecord(item?.data);
  return (
    item?.type === "taskMonitorCompletion"
    && data?.source === "pwragent_task_monitor"
  );
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

function isTerminalTurnLifecycle(
  lifecycle: MessagingActiveTurnSummary | undefined,
): boolean {
  return Boolean(
    lifecycle &&
      ["completed", "failed", "interrupted"].includes(lifecycle.status),
  );
}

function rememberBoundedKey(
  set: Set<string>,
  key: string,
  maxSize = MAX_DELIVERED_AUTOMATION_KEYS,
): void {
  set.add(key);
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function isSameActiveTurnState(
  previous: MessagingActiveTurnSummary | undefined,
  next: MessagingActiveTurnSummary | undefined,
): boolean {
  return Boolean(
    previous &&
      next &&
      previous.turnId === next.turnId &&
      previous.status === next.status,
  );
}

function isThreadNameUpdatedEvent(event: AgentEvent): boolean {
  return event.notification.method === "thread/name/updated";
}

function shouldRenderStatusForTurnStateChange(
  event: AgentEvent,
  lifecycle: MessagingActiveTurnSummary | undefined,
): boolean {
  if (event.notification.method === "thread/status/changed") {
    return false;
  }
  return Boolean(lifecycle && ["failed", "interrupted"].includes(lifecycle.status));
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

function approvalResponseLabel(
  decision: MessagingApprovalDecision | undefined,
): string {
  switch (decision) {
    case "accept":
      return "Approved";
    case "accept_for_session":
      return "Approved for Session";
    case "accept_with_execpolicy_amendment":
      return "Approved and Remembered";
    case "apply_network_policy_amendment":
      return "Network Rule Applied";
    case "decline":
      return "Declined";
    case "cancel":
      return "Canceled";
    case undefined:
      return "Resolved";
  }
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

function assistantTextForBackendEvent(event: AgentEvent): string | undefined {
  if (event.notification.method === "item/completed") {
    const params = event.notification.params as {
      item?: {
        text?: unknown;
        type?: unknown;
      };
    };
    if (params.item?.type !== "agentMessage" || typeof params.item.text !== "string") {
      return undefined;
    }
    return params.item.text.trim() || undefined;
  }

  if (event.notification.method === "turn/completed") {
    const text = assistantOutputTextFragmentsForBackendEvent(event)
      .join("\n\n")
      .trim();
    return text || undefined;
  }

  return undefined;
}

function assistantOutputTextFragmentsForBackendEvent(
  event: AgentEvent,
): string[] {
  return deduplicateAssistantOutputTextFragments(
    rawAssistantOutputTextFragmentsForBackendEvent(event),
  );
}

function rawAssistantOutputTextFragmentsForBackendEvent(
  event: AgentEvent,
): string[] {
  if (event.notification.method !== "turn/completed") {
    return [];
  }
  const params = event.notification.params as {
    turn?: {
      output?: unknown;
    };
  };
  if (!Array.isArray(params.turn?.output)) {
    return [];
  }
  return params.turn.output
    .map((item) =>
      item && typeof item === "object" && "text" in item
        ? (item as { text?: unknown }).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function deduplicateAssistantOutputTextFragments(fragments: string[]): string[] {
  // Some backends expose commentary and a rewritten final answer only through
  // turn/completed. Keep the later fragment when the two are substantially the
  // same response, but require enough ordered overlap that short acknowledgments
  // and related multi-part answers remain separate.
  const preserved: string[] = [];
  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index]!;
    if (
      preserved.some((laterFragment) =>
        areNearDuplicateAssistantTextFragments(fragment, laterFragment)
      )
    ) {
      continue;
    }
    preserved.unshift(fragment);
  }
  return preserved;
}

function areNearDuplicateAssistantTextFragments(
  left: string,
  right: string,
): boolean {
  if (left === right) {
    return true;
  }
  const leftWords = normalizedAssistantTextWords(left);
  const rightWords = normalizedAssistantTextWords(right);
  const shorterWords = leftWords.length <= rightWords.length
    ? leftWords
    : rightWords;
  const longerWords = leftWords.length <= rightWords.length
    ? rightWords
    : leftWords;
  if (
    shorterWords.length < MIN_NEAR_DUPLICATE_ASSISTANT_WORDS
    || shorterWords.length / longerWords.length
      < MIN_NEAR_DUPLICATE_ASSISTANT_LENGTH_RATIO
  ) {
    return false;
  }

  const shorterBigrams = assistantTextBigrams(shorterWords);
  const longerBigramCounts = new Map<string, number>();
  for (const bigram of assistantTextBigrams(longerWords)) {
    longerBigramCounts.set(bigram, (longerBigramCounts.get(bigram) ?? 0) + 1);
  }
  let overlap = 0;
  for (const bigram of shorterBigrams) {
    const remaining = longerBigramCounts.get(bigram) ?? 0;
    if (remaining === 0) {
      continue;
    }
    overlap += 1;
    longerBigramCounts.set(bigram, remaining - 1);
  }
  return overlap / shorterBigrams.length
    >= MIN_NEAR_DUPLICATE_ASSISTANT_BIGRAM_OVERLAP;
}

function normalizedAssistantTextWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function assistantTextBigrams(words: string[]): string[] {
  return words.slice(1).map((word, index) => `${words[index]}\0${word}`);
}

/**
 * The user-facing error text for a failed terminal turn, or undefined when the
 * event is not a turn failure. Codex turn failures are normalized to
 * `turn/failed` at the adapter boundary, so keying on that single method covers
 * both Codex and synthetic (start-failure / ACP) failures. The message is run
 * through {@link parseCodexTurnErrorMessage} to unwrap provider JSON envelopes;
 * the parse is idempotent for already-clean messages.
 */
function errorTextForBackendEvent(event: AgentEvent): string | undefined {
  if (event.notification.method !== "turn/failed") {
    return undefined;
  }
  const params = event.notification.params as {
    turn?: { error?: { message?: unknown } };
  };
  const message = params.turn?.error?.message;
  if (typeof message !== "string" || !message.trim()) {
    return undefined;
  }
  return parseCodexTurnErrorMessage(message);
}

function assistantDeltaForBackendEvent(
  event: AgentEvent,
): AssistantStreamDelta | undefined {
  if (event.notification.method !== "item/agentMessage/delta") {
    return undefined;
  }
  const params = event.notification.params as {
    delta?: unknown;
    itemId?: unknown;
    phase?: unknown;
    threadId?: unknown;
    turnId?: unknown;
  };
  if (params.phase === "commentary") {
    return undefined;
  }
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    typeof params.delta !== "string" ||
    params.delta.length === 0
  ) {
    return undefined;
  }
  return {
    delta: params.delta,
    itemId: params.itemId,
    streamKey: assistantStreamKey({
      backend: event.backend,
      threadId: params.threadId,
      turnId: params.turnId,
    }),
    threadId: params.threadId,
    turnId: params.turnId,
  };
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

function assistantStreamKey(params: {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
}): string {
  return [
    params.backend,
    params.threadId,
    params.turnId ?? "",
    "assistant-text",
  ].join(":");
}

function compactLogPreview(text: string, limit = 96): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
  return preview.replace(/["\\]/g, "\\$&");
}

function buildQueuedInputPreview(parts: string[]): string {
  const preview = parts
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return preview || "[attachment]";
}

function buildQueuedTurnNoticeBody(preview: string, canSteer: boolean): string {
  const quotedPreview = truncateText(preview, 500)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const steeringSentence = canSteer
    ? " To submit it as a steering message, click Steer."
    : "";
  return `${quotedPreview}\n\nI got your message, but there is a turn in progress. I've queued it to be sent when the turn completes.${steeringSentence} You can cancel if you don't want this queued.`;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function isTurnInProgressStartError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(active turn|turn already|already active|in progress)\b/i.test(message);
}

function isMissingTurnTargetStartError(
  error: unknown,
  binding: MessagingBindingRecord,
): boolean {
  const message = (error instanceof Error ? error.message : String(error))
    .toLowerCase();
  const threadId = binding.threadId.trim().toLowerCase();
  if (!threadId || !message.includes(threadId)) {
    return false;
  }
  return (
    message.includes("thread not found")
    || message.includes("thread does not exist")
    || message.includes("thread was deleted")
    || message.includes("thread has been deleted")
    || message.includes("deleted thread")
    || message.includes("unknown thread")
  );
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

function isSameMessagingSurface(
  left: MessagingSurfaceRef,
  right: MessagingSurfaceRef | undefined,
): boolean {
  return Boolean(
    right
    && left.channel === right.channel
    && left.id === right.id,
  );
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
  // A terminal aggregate can contain earlier commentary followed by a final
  // assistant item that was already delivered. Include each output fragment's
  // content key in the same claim so that prior final-item delivery suppresses
  // the repeated aggregate without changing completion-only aggregation.
  const contentKeys = [
    contentKey,
    ...rawAssistantOutputTextFragmentsForBackendEvent(event).map((fragment) =>
      assistantMessageContentDeliveryKey(event, binding, fragment, identity)
    ),
  ];
  const uniqueContentKeys = [...new Set(contentKeys)];
  const itemId = identity?.itemId ?? assistantItemIdForBackendEvent(event);
  if (!itemId) {
    return uniqueContentKeys;
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
    ...uniqueContentKeys,
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

function isThreadStatusIdleEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "thread/status/changed") {
    return false;
  }
  const params = event.notification.params as {
    status?: {
      type?: unknown;
    };
  };
  return params.status?.type === "idle";
}

function isTurnWorkActivityEvent(
  event: AgentEvent,
  activeTurn: MessagingActiveTurnSummary,
): boolean {
  const params = event.notification.params as {
    turn?: {
      id?: unknown;
    };
    turnId?: unknown;
  };
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined;
  if (turnId !== activeTurn.turnId) {
    return false;
  }

  return (
    event.notification.method.startsWith("item/") ||
    event.notification.method.startsWith("turn/") ||
    event.notification.method.startsWith("thread/")
  );
}

function typingActivityRefreshMsForBackendEvent(event: AgentEvent): number {
  const method = event.notification.method;
  return method.startsWith("item/") && !isHighFrequencyItemActivityEvent(method)
    ? TYPING_ACTIVITY_CONTINUATION_REFRESH_MS
    : TYPING_ACTIVITY_REFRESH_MS;
}

function isHighFrequencyItemActivityEvent(method: string): boolean {
  return (
    method.endsWith("/delta") ||
    method.endsWith("Delta") ||
    method.endsWith("/progress")
  );
}

function turnLifecycleForBackendEvent(
  event: AgentEvent,
  now: number,
): MessagingActiveTurnSummary | undefined {
  switch (event.notification.method) {
    case "turn/started": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "working",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/completed": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "completed",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/failed": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "failed",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/cancelled": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "interrupted",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    default:
      return undefined;
  }
}

type TurnLifecycleParams = {
  turnId?: string | null;
  turn?: {
    id?: string | null;
    startedAt?: number | null;
  };
};

function navigationWithStartedThread(params: {
  acpRuntime?: BackendAcpSessionRuntimeState;
  agent?: ReturnType<typeof agentForNewThreadSession>;
  backend: AppServerBackendKind;
  codexEnvironmentRuntime?: NavigationThreadSummary["codexEnvironmentRuntime"];
  directory?: NavigationDirectorySummary;
  executionMode?: ThreadExecutionMode;
  linkedDirectory?: LinkedDirectorySummary;
  fastMode?: boolean;
  model?: string;
  navigation: NavigationSnapshot;
  now: number;
  preferences?: MessagingBrowseSessionRecord["preferences"];
  project: NonNullable<ReturnType<typeof selectProjectFromValue>>;
  reasoningEffort?: string;
  serviceTier?: string;
  threadId: ThreadIdentifier;
  worktreePath?: string;
  workMode: LaunchpadWorkMode;
}): NavigationSnapshot {
  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  if (
    params.navigation.threads.some(
      (thread) => thread.source === params.backend && thread.id === params.threadId,
    )
  ) {
    return params.navigation;
  }

  const directoryPath = params.directory?.path ?? params.project.path;
  const linkedDirectory: LinkedDirectorySummary | undefined = directoryPath
    ? params.linkedDirectory ?? {
        id: params.directory?.key ?? directoryPath,
        kind: params.workMode === "worktree" && params.worktreePath ? "worktree" : "local",
        label: params.directory?.label ?? params.project.label,
        path: directoryPath,
        ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
      }
    : undefined;

  return {
    ...params.navigation,
    unchanged: false,
    threads: [
      {
        id: params.threadId,
        source: params.backend,
        title: params.threadId,
        titleSource: "fallback",
        projectKey: directoryPath,
        createdAt: params.now,
        updatedAt: params.now,
        executionMode: params.executionMode,
        acpRuntime: params.acpRuntime,
        codexEnvironmentRuntime: params.codexEnvironmentRuntime,
        agent: params.agent
          ? {
              ...params.agent,
              instructionLineCount: params.agent.instructions
                ? params.agent.instructions.split(/\r?\n/).length
                : 0,
              instructionsTooLong: false,
              updatedAt: params.now,
            }
          : undefined,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        serviceTier: params.serviceTier,
        fastMode: params.fastMode,
        linkedDirectories: linkedDirectory ? [linkedDirectory] : [],
        inbox: {
          inInbox: true,
          reason: "new-thread",
        },
      },
      ...params.navigation.threads,
    ],
    directories: params.navigation.directories.map((directory) =>
      directory.key === params.directory?.key
        ? {
            ...directory,
            threadKeys: directory.threadKeys.includes(threadKey)
              ? directory.threadKeys
              : [threadKey, ...directory.threadKeys],
            latestUpdatedAt: Math.max(directory.latestUpdatedAt ?? 0, params.now),
          }
        : directory,
    ),
    inboxThreadKeys: params.navigation.inboxThreadKeys.includes(threadKey)
      ? params.navigation.inboxThreadKeys
      : [threadKey, ...params.navigation.inboxThreadKeys],
  };
}

function launchpadForMessagingProject(params: {
  acpRuntime?: BackendAcpSessionRuntimeState;
  backend: AppServerBackendKind;
  branchName: string;
  directory?: NavigationDirectorySummary;
  navigation: NavigationSnapshot;
  now: number;
  options: NewThreadOptionsSummary;
  preferences?: MessagingBrowseSessionRecord["preferences"];
  project: NonNullable<ReturnType<typeof selectProjectFromValue>>;
  workMode: LaunchpadWorkMode;
}): NavigationLaunchpadDraft {
  const defaults = params.navigation.launchpadDefaults;
  const directoryPath = params.directory?.path ?? params.project.path;
  const base: NavigationLaunchpadDraft = params.directory?.launchpad ?? {
    directoryKey:
      params.directory?.key ??
      params.project.directoryKey ??
      params.project.path ??
      params.project.label,
    directoryKind: params.directory?.kind ?? "directory",
    directoryLabel: params.directory?.label ?? params.project.label,
    directoryPath,
    backend: params.backend,
    executionMode: defaults.executionMode,
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    serviceTier: defaults.serviceTier,
    fastMode: defaults.fastMode,
    prompt: "",
    workMode: params.workMode,
    branchName: params.branchName,
    createdAt: params.now,
    updatedAt: params.now,
  };

  return {
    ...base,
    backend: params.backend,
    acpRuntime: params.acpRuntime ?? params.options.acpRuntime,
    codexEnvironmentId:
      params.preferences?.codexEnvironmentId === null
        ? undefined
        : params.options.codexEnvironmentId ?? undefined,
    codexEnvironmentExecutionTarget:
      params.preferences?.codexEnvironmentId === null
        ? undefined
        : params.options.codexEnvironmentExecutionTarget,
    codexEnvironmentActionId:
      params.preferences?.codexEnvironmentId === null
        ? undefined
        : params.preferences?.codexEnvironmentActionId === null
          ? undefined
          : params.options.codexEnvironmentActionId ?? undefined,
    executionMode: params.options.executionMode,
    model: params.options.supportsModel ? params.options.model : undefined,
    reasoningEffort: params.options.supportsReasoning
      ? params.options.reasoningEffort
      : undefined,
    serviceTier: params.options.serviceTier,
    fastMode: params.options.supportsFast ? params.options.fastMode : undefined,
    prompt: "",
    workMode: params.workMode,
    branchName: params.branchName,
    codexEnvironmentOptions: base.codexEnvironmentOptions,
    updatedAt: params.now,
  };
}

function messagingLaunchpadMaterializationKey(
  session: MessagingBrowseSessionRecord,
): string {
  return `messaging:${session.id}`;
}

function agentForNewThreadSession(
  session: MessagingBrowseSessionRecord,
): { name: string; instructions?: string } | undefined {
  if (!isNewAgentThreadLaunchAction(session.launchAction)) {
    return undefined;
  }
  return {
    name: DEFAULT_MESSAGING_AGENT_NAME,
    instructions: DEFAULT_MESSAGING_AGENT_INSTRUCTIONS,
  };
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

function parseTextCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
}

function parseTextCommandArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return [];
  }

  return trimmed.slice(1).split(/\s+/).slice(1).filter(Boolean);
}

function parseMentionCommand(
  text: string,
): { command: string; args: string[] } | undefined {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  // Keep mention commands deliberately unambiguous. A bare known verb such
  // as `@bot new` is a convenient control shortcut, but addressed prose such
  // as `@bot new phone who dis?` belongs to the bound/default Agent. Commands
  // with arguments remain available through their explicit slash form.
  if (tokens.length !== 1) {
    return undefined;
  }
  const command = matchMessagingCommandVerb(tokens[0] ?? "");
  return command ? { command, args: [] } : undefined;
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

function bindingWithoutPendingSkillSelection(
  binding: MessagingBindingRecord,
): MessagingBindingRecord {
  const { pendingSkillSelection: _pendingSkillSelection, ...rest } = binding;
  return rest;
}

function isToolsFallbackText(text: string): boolean {
  return text.trim().toLowerCase() === "tools";
}

function isStreamFallbackText(text: string): boolean {
  return text.trim().toLowerCase() === "stream";
}

function readBindingTarget(
  event: MessagingInboundCallbackEvent,
): {
  backend: AppServerBackendKind;
  federatedThread?: FederatedThreadRef;
  threadId: ThreadIdentifier;
} | undefined {
  const fromValue = readBindingTargetFromValue(event.value);
  if (fromValue) {
    return fromValue;
  }

  const actionId = event.actionId ?? event.interaction.id;
  const match = /^bind:([^:]+):(.+)$/.exec(actionId);
  if (!match) {
    return undefined;
  }
  const backend = match[1]!;
  if (!isAppServerBackendKind(backend)) {
    return undefined;
  }

  return {
    backend,
    threadId: match[2]!,
  };
}

function readBindingTargetFromValue(
  value: MessagingJsonValue | undefined,
): {
  backend: AppServerBackendKind;
  federatedThread?: FederatedThreadRef;
  threadId: ThreadIdentifier;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const backend = value.backend;
  const federationInstanceId = value.federationInstanceId;
  const threadId = value.threadId;
  if (typeof backend === "string" && isAppServerBackendKind(backend) && typeof threadId === "string") {
    return {
      backend,
      ...(typeof federationInstanceId === "string"
        ? {
            federatedThread: buildFederatedThreadRef({
              backend,
              instanceId: federationInstanceId,
              threadId,
            }),
          }
        : {}),
      threadId,
    };
  }

  return undefined;
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

function readStringValue(
  value: MessagingJsonValue | undefined,
  key: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result = value[key];
  return typeof result === "string" ? result : undefined;
}

function questionnaireAnswerValue(
  answer: MessagingQuestionnaireAnswer | null | undefined,
): string[] {
  const value = answer?.value.trim();
  return value ? [value] : [];
}

function readNullableStringValue(
  value: MessagingJsonValue | undefined,
  key: string,
): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result = value[key];
  if (result === null) {
    return null;
  }
  return typeof result === "string" ? result : undefined;
}

function readThreadExecutionModeValue(
  value: MessagingJsonValue | undefined,
): ThreadExecutionMode | undefined {
  const executionMode = readStringValue(value, "executionMode");
  return executionMode === "default" || executionMode === "full-access"
    ? executionMode
    : undefined;
}

function readMessagingToolUpdateModeValue(
  value: MessagingJsonValue | undefined,
): MessagingToolUpdateMode | undefined {
  const toolUpdateMode = readStringValue(value, "toolUpdateMode");
  return (
    toolUpdateMode === "show_none" ||
      toolUpdateMode === "show_less" ||
      toolUpdateMode === "show_some" ||
      toolUpdateMode === "show_more" ||
      toolUpdateMode === "show_all"
  )
    ? toolUpdateMode
    : undefined;
}

function readAcpRuntimeOptionSource(
  value: MessagingJsonValue | undefined,
): BackendAcpRuntimeOptionSource | undefined {
  const source = readStringValue(value, "source");
  return source === "mode" || source === "configOption" || source === "model"
    ? source
    : undefined;
}

function bindingWithInboundRoutingState(
  binding: MessagingBindingRecord | undefined,
  routingState: MessagingAdapterState | undefined,
): MessagingBindingRecord | undefined {
  // Metadata persistence is intentionally off-path, but this event's delivery
  // state is already authoritative for replies and typing activity on the same
  // route. Use it immediately without waiting for the merge-safe store update.
  return binding && routingState
    ? { ...binding, routingState }
    : binding;
}

function messageOriginForInboundEvent(
  event: MessagingInboundEvent | undefined,
): AppServerThreadMessageOrigin {
  if (!event) {
    return { kind: "messaging" };
  }

  const conversation = event.channel.conversation;
  return {
    kind: "messaging",
    messaging: {
      platform: event.channel.channel,
      ...(event.sourceUrl ? { sourceUrl: event.sourceUrl } : {}),
      surface: {
        id: conversation.id,
        kind: conversation.kind,
        ...(conversation.title ? { title: conversation.title } : {}),
        ...(conversation.parentTitle
          ? { parentTitle: conversation.parentTitle }
          : {}),
        ...(conversation.ancestorTitle
          ? { ancestorTitle: conversation.ancestorTitle }
          : {}),
      },
      actor: {
        platformUserId: event.actor.platformUserId,
        ...(event.actor.displayName
          ? { displayName: event.actor.displayName }
          : {}),
        ...(event.actor.phoneNumber
          ? { phoneNumber: event.actor.phoneNumber }
          : {}),
        ...(event.actor.username ? { username: event.actor.username } : {}),
      },
    },
  };
}

function requestsExplicitPrivateResponse(
  event: MessagingInboundEvent | MessagingTurnInputEvent,
): boolean {
  if (!("text" in event) || typeof event.text !== "string") {
    return false;
  }
  const text = event.text.trim();
  if (!text) {
    return false;
  }
  const request = EXPLICIT_PRIVATE_RESPONSE_REQUEST_PATTERN.exec(text);
  if (!request) {
    return false;
  }
  const prefix = text.slice(0, request.index);
  const clauseStart = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf(","),
    prefix.lastIndexOf("\n"),
  );
  return !NEGATED_PRIVATE_RESPONSE_PREFIX_PATTERN.test(
    prefix.slice(clauseStart + 1),
  );
}

function describeConversation(
  conversation: MessagingBindingRecord["channel"]["conversation"],
): string {
  const pieces = [
    conversation.ancestorTitle,
    conversation.parentTitle,
    conversation.title,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.length > 0 ? pieces.join(" / ") : conversation.id;
}
