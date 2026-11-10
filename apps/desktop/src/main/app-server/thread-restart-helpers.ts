import type { StoredRestartContinuation } from "../storage/desktop-runtime-storage";
import {
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueOrigin,
} from "@pwragent/owner-core/thread-turn-queue";



/** Steered into each running turn as a quiet restart begins. */
export const QUIET_RESTART_STEER_TEXT = [
  "PwrAgent is restarting now, for example to install an update.",
  "Stop at the next safe point: do not start new commands or edits.",
  "Running commands and environment actions are being terminated, and this turn will be interrupted in a few seconds.",
  "After the restart, PwrAgent will send you a message to continue this work.",
].join(" ");

/** The continuation each stopped thread receives after the restart. */
export function buildRestartContinuationText(stoppedAt: number): string {
  return [
    `PwrAgent restarted. Your previous turn was stopped at ${new Date(stoppedAt).toISOString()} so the app could restart.`,
    "Commands and environment actions that were running then were terminated.",
    "Check the state of your work, such as processes, partial edits, and build or test output, and continue where you left off.",
    "If the task was already complete, reply with a short summary instead.",
  ].join(" ");
}

/** A queued message as a quiet restart saves it. */
export function storedRestartQueuedEntry(entry: ThreadTurnQueueEntry, position: number): StoredRestartContinuation {
  return {
    id: entry.id,
    backend: entry.backend,
    threadId: entry.threadId,
    kind: "queued",
    input: entry.input,
    ...(entry.messageOrigin ? { messageOrigin: entry.messageOrigin } : {}),
    createdAt: entry.createdAt,
    queued: {
      origin: entry.origin,
      ...(entry.delivery ? { delivery: entry.delivery } : {}),
      ...(entry.agentMessages ? { agentMessages: entry.agentMessages } : {}),
      ...(entry.agentMessageOrigins ? { agentMessageOrigins: entry.agentMessageOrigins } : {}),
      ...(entry.executionMode ? { executionMode: entry.executionMode } : {}),
      ...(entry.approvalPolicy ? { approvalPolicy: entry.approvalPolicy } : {}),
      ...(entry.sandbox ? { sandbox: entry.sandbox } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.collaborationMode ? { collaborationMode: entry.collaborationMode } : {}),
      ...(entry.serviceTier ? { serviceTier: entry.serviceTier } : {}),
      ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      ...(entry.fastMode !== undefined ? { fastMode: entry.fastMode } : {}),
      ...(entry.automationRunId ? { automationRunId: entry.automationRunId } : {}),
      ...(entry.automationName ? { automationName: entry.automationName } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      // A held message waited on the operator; it must not send itself.
      ...(entry.paused || entry.manualReleaseRequired ? { paused: true as const } : {}),
      position,
    },
  };
}

/** A saved queued message back as a queue entry. */
export function restartQueuedEntry(
  stored: StoredRestartContinuation,
): Omit<ThreadTurnQueueEntry, "restartContinuation" | "pauseRevision"> {
  const { origin, paused, position: _position, ...settings } = stored.queued ?? {};
  return {
    ...settings,
    id: stored.id,
    backend: stored.backend,
    threadId: stored.threadId,
    origin: origin && THREAD_TURN_QUEUE_ORIGINS.includes(origin) ? origin : "manual",
    input: stored.input,
    ...(stored.messageOrigin ? { messageOrigin: stored.messageOrigin } : {}),
    createdAt: stored.createdAt,
    ...(paused ? { paused: true } : {}),
  };
}

/** How long one quiet-restart steer may take before the quit moves on. */
export const QUIET_RESTART_STEER_TIMEOUT_MS = 5_000;
/**
 * Continuation dispatch starts once providers have refreshed. If that never
 * happens, it starts after this long anyway, so the gate cannot stay shut.
 */
export const RESTART_DISPATCH_FALLBACK_MS = 120_000;

export const THREAD_TURN_QUEUE_ORIGINS: readonly string[] = ["manual", "automation", "messaging", "scheduled"] satisfies ThreadTurnQueueOrigin[];
