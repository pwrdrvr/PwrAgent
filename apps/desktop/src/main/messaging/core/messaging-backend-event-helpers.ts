import { finalTurnOutputText } from "@pwragent/shared/turn-output";
import { buildFederatedThreadRef, federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { parseCodexTurnErrorMessage } from "@pwragent/shared/codex-turn-error";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  ThreadIncomingWorkSummary,
  AppServerBackendKind,
  AppServerThreadPlanEntry,
  AppServerThreadReviewEntry,
  AppServerThreadMessageOrigin,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AutomationRunOutputDecision } from "@pwragent/shared/contracts/automations";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { ScheduledThreadAction } from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { MessagingRequestSource } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingActiveTurnSummary, MessagingDeliveryControl, MessagingDeliveryResult, MessagingInboundEvent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { planEntryFromUpdate } from "./messaging-artifact-renderer.js";
import { normalizeReviewOutputRecord } from "../../../shared/review-command.js";
import type { MessagingToolActivity } from "./messaging-tool-activity.js";

export const TYPING_ACTIVITY_REFRESH_MS = 10_000;

// Discrete item lifecycle events are cheap provider lease renewals, not
// visible message sends. Let them through a little sooner than noisy deltas.
export const TYPING_ACTIVITY_CONTINUATION_REFRESH_MS = 9_000;

// Upper bound on retained automation start/final delivery-dedup keys. Each entry
// embeds the full rendered message text and is only consulted while a run's
// terminal events are in flight; oldest-first eviction reclaims keys for runs
// that completed long ago so a long-lived controller does not grow without
// bound (one entry per automation run).
export const MAX_DELIVERED_AUTOMATION_KEYS = 1_000;

export const MAX_TRACKED_REVIEW_TURNS = 1_000;

export const MAX_TRACKED_TURN_PROSE = 256;

export type AssistantStreamDelta = {
  delta: string;
  itemId: string;
  streamKey: string;
  threadId: ThreadIdentifier;
  turnId: string;
};

export type AssistantMessageDeliveryIdentity = {
  itemId?: string;
  threadId?: string;
  turnId?: string;
};

export type ActiveAgentMessagingOrigin = {
  source?: MessagingRequestSource;
  binding?: MessagingBindingRecord;
  deliveryBinding?: MessagingBindingRecord;
  event: MessagingInboundEvent;
  privateReplyContinuationBindingId?: string;
  privateResponseRequested?: boolean;
  reportedStartFailureText?: string;
};

export function federationTargetForBinding(
  binding: MessagingBindingRecord,
): FederationTarget | undefined {
  return binding.federatedThread?.target.scope === "remote"
    ? binding.federatedThread.target
    : undefined;
}

export function bindingMatchesFederationTarget(
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

export type MessagingControllerLogger = {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
};

export type MessagingDeliveryGuard = MessagingDeliveryControl & {
  onCancelledDelivery?: (result: MessagingDeliveryResult) => Promise<void>;
  whenCancelled?: Promise<void>;
};

export type MessagingCancellationSignal = MessagingDeliveryGuard & {
  cancel: () => void;
};

/** A turn can cancel writes already waiting in a provider's request queue. */
export function createMessagingTurnCancellation(
  isTerminalPrivateResponse: () => boolean,
): MessagingCancellationSignal {
  const abort = new AbortController();
  const cancelled = Promise.withResolvers<void>();
  const cancel = () => {
    abort.abort();
    cancelled.resolve();
  };
  if (isTerminalPrivateResponse()) cancel();
  return {
    cancel,
    isCancelled: () => abort.signal.aborted || isTerminalPrivateResponse(),
    whenCancelled: cancelled.promise,
    signal: abort.signal,
  };
}

/**
 * Narrow an `AppServerNotification` to the `thread/executionMode/queued`
 * variant and return its strongly-typed params. The shared union is
 * tricky to narrow because `AppServerPendingRequestNotification` widens
 * `method: string`, so we look at the params shape too.
 */
export function readExecutionModeQueuedParams(
  notification: AgentEvent["notification"],
):
  | {
      threadId: ThreadIdentifier;
      queuedExecutionMode: ThreadExecutionMode;
      queuedNativeMode?: string;
      queuedAt: number;
      fromLabel?: string;
      toLabel?: string;
    }
  | undefined {
  if (notification.method !== "thread/executionMode/queued") {
    return undefined;
  }
  const params = notification.params as {
    threadId?: unknown;
    queuedExecutionMode?: unknown;
    queuedNativeMode?: unknown;
    queuedAt?: unknown;
    fromLabel?: unknown;
    toLabel?: unknown;
  };
  if (
    typeof params.threadId === "string" &&
    (params.queuedExecutionMode === "default" || params.queuedExecutionMode === "auto" || params.queuedExecutionMode === "full-access") &&
    typeof params.queuedAt === "number"
  ) {
    return {
      threadId: params.threadId,
      queuedExecutionMode: params.queuedExecutionMode,
      ...(typeof params.queuedNativeMode === "string" ? { queuedNativeMode: params.queuedNativeMode } : {}),
      queuedAt: params.queuedAt,
      ...(typeof params.fromLabel === "string" ? { fromLabel: params.fromLabel } : {}),
      ...(typeof params.toLabel === "string" ? { toLabel: params.toLabel } : {}),
    };
  }
  return undefined;
}

export function readExecutionModeQueueClearedParams(
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

export function threadIdForBackendEvent(event: AgentEvent): ThreadIdentifier | undefined {
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

export function scheduledActionForBackendEvent(
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

export function bindingMatchesScheduledActionOrigin(
  binding: MessagingBindingRecord,
  action: ScheduledThreadAction,
): boolean {
  const origin = action.turn?.messageOrigin?.messaging;
  if (!origin) return true;
  return binding.channel.channel === origin.platform
    && binding.channel.conversation.id === origin.surface.id;
}

export function reviewStartOutcomeForBackendEvent(
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

export function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function planEntryForBackendEvent(
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

export function reviewArtifactForBackendEvent(
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

export function normalizeStructuredReviewOutput(
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

export function isPlanStepStatus(value: unknown): value is AppServerThreadPlanEntry["steps"][number]["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

export function normalizeReviewItemType(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isReviewTurnMarkerEvent(event: AgentEvent): boolean {
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

export function artifactTurnKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

/** The backend item an `item/started` or `item/completed` event names. */
export function assistantItemIdForBackendEvent(event: AgentEvent): string | undefined {
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

export function turnIdForBackendEvent(event: AgentEvent): string | undefined {
  const params = event.notification.params as {
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.turnId === "string") {
    return params.turnId;
  }
  return typeof params.turn?.id === "string" ? params.turn.id : undefined;
}

export function agentMessagingTurnKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

export function threadKeyForBackendEvent(
  event: AgentEvent,
  threadId: ThreadIdentifier,
): string {
  return event.federationTarget?.scope === "remote"
    ? federatedThreadIdentityKey(
        buildFederatedThreadRef({
          backend: event.backend,
          instanceId: event.federationTarget.instanceId,
          threadId,
        }),
      )
    : buildThreadIdentityKey(event.backend, threadId);
}

export function turnQueueUpdateForBackendEvent(event: AgentEvent): {
  messageOrigin?: AppServerThreadMessageOrigin;
  incomingWork?: ThreadIncomingWorkSummary;
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
    messageOrigin?: AppServerThreadMessageOrigin;
    incomingWork?: ThreadIncomingWorkSummary;
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
    messageOrigin: params.messageOrigin,
    incomingWork: params.incomingWork,
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

export function automationRunUpdateForBackendEvent(event: AgentEvent): {
  automationName?: string;
  errorMessage?: string;
  failureReason?: string;
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
    automationName?: unknown;
    errorMessage?: unknown;
    failureReason?: unknown;
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
    automationName: typeof params.automationName === "string"
      ? params.automationName
      : undefined,
    errorMessage: typeof params.errorMessage === "string" ? params.errorMessage : undefined,
    failureReason: typeof params.failureReason === "string"
      ? params.failureReason
      : undefined,
    finalText: typeof params.finalText === "string" ? params.finalText : undefined,
    outputDecision: isAutomationRunOutputDecision(params.outputDecision)
      ? params.outputDecision
      : undefined,
    runId: params.runId,
    status: params.status,
    suppressBindingBroadcast: params.suppressBindingBroadcast === true,
  };
}

export function isAutomationRunOutputDecision(
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
export function isNonFinalAssistantTextForBackendEvent(event: AgentEvent): boolean {
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

/** An `agentMessage` completion with no phase, which may be a progress note. */
export function isUnphasedAssistantMessageEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "item/completed") {
    return false;
  }
  const item = (event.notification.params as {
    item?: { phase?: unknown; type?: unknown };
  }).item;
  return item?.type === "agentMessage" && typeof item.phase !== "string";
}

export function isFinalAssistantImageResolutionEvent(event: AgentEvent): boolean {
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

export function taskMonitorItemData(item: unknown): Record<string, unknown> | undefined {
  const data = asPlainRecord(asPlainRecord(item)?.data);
  return data?.source === "pwragent_task_monitor" ? data : undefined;
}

export type MessagingTaskMonitorLifecycle = {
  activity: MessagingToolActivity;
  monitorId: string;
  parentTurnId?: string;
};

export function taskMonitorLifecycleActivityForBackendEvent(
  event: AgentEvent,
): MessagingTaskMonitorLifecycle | undefined {
  if (event.notification.method !== "item/completed") {
    return undefined;
  }
  const item = asPlainRecord((event.notification.params as { item?: unknown }).item);
  const data = taskMonitorItemData(item);
  if (!item || !data || typeof data.monitorId !== "string") {
    return undefined;
  }
  const created = item.type === "taskMonitorCreated";
  const completed = item.type === "taskMonitorCompletion"
    && (data.outcome === "success" || data.outcome === "failure");
  if (!created && !completed) {
    return undefined;
  }
  const task = typeof data.task === "string" ? data.task : "Job";
  const phase = created ? "Created" : data.outcome === "failure" ? "Failed" : "Succeeded";
  return {
    monitorId: data.monitorId,
    ...(typeof data.parentTurnId === "string" ? { parentTurnId: data.parentTurnId } : {}),
    activity: {
      // Dedup lifecycle replays independently of timestamped backend item ids.
      id: `monitor:${data.monitorId}:${phase}`,
      kind: "tool",
      status: data.outcome === "failure" ? "failed" : "completed",
      title: `Monitor · ${task} · ${phase}`,
    },
  };
}

export function isPrivateTaskMonitorEvent(event: AgentEvent): boolean {
  if (taskMonitorLifecycleActivityForBackendEvent(event)) {
    return false;
  }
  const params = event.notification.params as { item?: unknown };
  return Boolean(
    taskMonitorItemData(params.item)
    || turnIdForBackendEvent(event)?.startsWith("monitor:"),
  );
}

export function isTerminalTurnLifecycle(
  lifecycle: MessagingActiveTurnSummary | undefined,
): boolean {
  return Boolean(
    lifecycle &&
      ["completed", "failed", "interrupted"].includes(lifecycle.status),
  );
}

export function rememberBoundedKey(
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

export function isSameActiveTurnState(
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

export function isThreadNameUpdatedEvent(event: AgentEvent): boolean {
  return event.notification.method === "thread/name/updated";
}

export function shouldRenderStatusForTurnStateChange(
  event: AgentEvent,
  lifecycle: MessagingActiveTurnSummary | undefined,
): boolean {
  if (event.notification.method === "thread/status/changed") {
    return false;
  }
  return Boolean(lifecycle && ["failed", "interrupted"].includes(lifecycle.status));
}

/**
 * The questions a Codex `request_user_input_async` message asked. The reply
 * names each question by this item id, so a message without one cannot be
 * answered and stays ordinary assistant text.
 */
export function assistantTextForBackendEvent(event: AgentEvent): string | undefined {
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
    // Claude reports each assistant message of the turn as its own part, and
    // each one already arrived through item/completed. The answer is the last.
    const params = event.notification.params as { turn?: { output?: unknown } };
    return finalTurnOutputText(params.turn?.output);
  }

  return undefined;
}

/**
 * The user-facing error text for a failed terminal turn, or undefined when the
 * event is not a turn failure. Codex turn failures are normalized to
 * `turn/failed` at the adapter boundary, so keying on that single method covers
 * both Codex and synthetic (start-failure / ACP) failures. The message is run
 * through {@link parseCodexTurnErrorMessage} to unwrap provider JSON envelopes;
 * the parse is idempotent for already-clean messages.
 */
export function errorTextForBackendEvent(event: AgentEvent): string | undefined {
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

export function assistantDeltaForBackendEvent(
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
  // Interim prose is delivered at item completion through Working Updates.
  // Never accumulate it in the answer stream or a terminal fallback can post it.
  if (
    params.phase === "commentary"
    || params.phase === "partial"
    || params.phase === "partial_answer"
  ) {
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

export function assistantStreamKey(params: {
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

export function isThreadStatusIdleEvent(event: AgentEvent): boolean {
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

export function isTurnWorkActivityEvent(
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

export function typingActivityRefreshMsForBackendEvent(event: AgentEvent): number {
  const method = event.notification.method;
  return method.startsWith("item/") && !isHighFrequencyItemActivityEvent(method)
    ? TYPING_ACTIVITY_CONTINUATION_REFRESH_MS
    : TYPING_ACTIVITY_REFRESH_MS;
}

export function isHighFrequencyItemActivityEvent(method: string): boolean {
  return (
    method.endsWith("/delta") ||
    method.endsWith("Delta") ||
    method.endsWith("/progress")
  );
}

export function turnLifecycleForBackendEvent(
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
      // Codex answers turn/interrupt with turn/completed, status
      // interrupted: the turn stopped, it did not finish.
      return {
        turnId,
        status: params.turn?.status === "interrupted" ? "interrupted" : "completed",
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

export type TurnLifecycleParams = {
  turnId?: string | null;
  turn?: {
    id?: string | null;
    startedAt?: number | null;
    status?: string | null;
  };
};

export function messagingSurfaceKey(surface: MessagingSurfaceRef): string {
  return `${surface.channel}\0${surface.id}`;
}
