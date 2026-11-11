import type { ThreadSubAgentSummary } from "./contracts/navigation";
import type { AppServerThreadSubAgentCallDetail } from "./contracts/normalized-app-server";

export type SubAgentLens = "harness" | "token-miser" | "pwragent";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A short handle for a sub-agent's thread id, for labels that have no name.
 * Codex thread ids are UUIDv7: the leading characters are a millisecond
 * timestamp that changes only every ~65 seconds, so workers started together
 * share an 8-character prefix. The trailing characters are random.
 */
export function shortSubAgentThreadId(threadId: string): string {
  if (UUID_PATTERN.test(threadId)) {
    return threadId.slice(-8);
  }
  return threadId.length > 8 ? threadId.slice(0, 8) : threadId;
}

export function isCodexNativeSubAgent(subAgent: Pick<ThreadSubAgentSummary, "monitorId">): boolean {
  return subAgent.monitorId.startsWith("codex-native:");
}

/** A sub-agent Claude Code runs with its Agent tool; the id after it is the task id. */
export const CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX = "claude-native:";

export function isClaudeNativeSubAgent(subAgent: Pick<ThreadSubAgentSummary, "monitorId">): boolean {
  return subAgent.monitorId.startsWith(CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX);
}

const CLAUDE_SUBAGENT_TRANSCRIPT_THREAD_ID_PREFIX = "claude-subagent:";
/** Claude's task ids are alphanumeric. Claude Code names the sub-agent's file after one. */
const CLAUDE_TASK_ID = /^[A-Za-z0-9_-]+$/u;

/**
 * The id a Claude sub-agent's transcript is read by. A Claude sub-agent is a
 * task in its parent's session, not a thread, so the id names both. It goes
 * through `readThread` unchanged, which lets a peer answer it too.
 */
export function claudeSubAgentTranscriptThreadId(parentThreadId: string, taskId: string): string {
  return `${CLAUDE_SUBAGENT_TRANSCRIPT_THREAD_ID_PREFIX}${parentThreadId}:${taskId}`;
}

/** The transcript id for a Claude sub-agent's card or tray row, keyed by its monitor id. */
export function claudeSubAgentTranscriptThreadIdForMonitor(
  monitorId: string,
  parentThreadId: string,
): string | undefined {
  if (!monitorId.startsWith(CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX)) return undefined;
  const taskId = monitorId.slice(CLAUDE_NATIVE_SUBAGENT_MONITOR_ID_PREFIX.length);
  return taskId && parentThreadId ? claudeSubAgentTranscriptThreadId(parentThreadId, taskId) : undefined;
}

export function parseClaudeSubAgentTranscriptThreadId(
  threadId: string,
): { parentThreadId: string; taskId: string } | undefined {
  if (!threadId.startsWith(CLAUDE_SUBAGENT_TRANSCRIPT_THREAD_ID_PREFIX)) return undefined;
  const rest = threadId.slice(CLAUDE_SUBAGENT_TRANSCRIPT_THREAD_ID_PREFIX.length);
  // A task id has no colon; the parent's id comes first.
  const split = rest.lastIndexOf(":");
  const parentThreadId = rest.slice(0, split);
  const taskId = rest.slice(split + 1);
  // The task id becomes part of a file name, so a path never passes as one.
  return split > 0 && CLAUDE_TASK_ID.test(taskId) ? { parentThreadId, taskId } : undefined;
}

/** A worker the agent harness itself started, rather than PwrAgent. */
export function isHarnessSubAgent(subAgent: Pick<ThreadSubAgentSummary, "monitorId">): boolean {
  return isCodexNativeSubAgent(subAgent) || isClaudeNativeSubAgent(subAgent);
}

/**
 * Whether a running card can be stopped: a thread turn to interrupt, or a
 * Claude task, which Claude stops by its id. A Claude sub-agent has no thread.
 */
export function hasStoppableSubAgentRun(
  subAgent: Pick<ThreadSubAgentSummary, "monitorId" | "monitorThreadId" | "monitorTurnId">,
): boolean {
  return (Boolean(subAgent.monitorThreadId) && Boolean(subAgent.monitorTurnId))
    || isClaudeNativeSubAgent(subAgent);
}

/** Execution thread IDs also exist for ephemeral workers; they do not imply a reloadable transcript. */
export function hasDurableSubAgentTranscript(
  subAgent: Pick<AppServerThreadSubAgentCallDetail, "backend" | "origin">,
): boolean {
  return subAgent.backend !== "codex" || subAgent.origin === "codex-native";
}

export function isSystemTitleHelperSubAgent(
  subAgent: Pick<ThreadSubAgentSummary, "monitorId">,
): boolean {
  return subAgent.monitorId.startsWith("system:title-helper:");
}

/** The per-thread row that names long queued messages. */
export function isSystemQueuedMessageTitleHelperSubAgent(
  subAgent: Pick<ThreadSubAgentSummary, "monitorId">,
): boolean {
  return subAgent.monitorId.startsWith("system:queued-message-titles:");
}

export function isTokenMiserSubAgent(
  subAgent: Pick<ThreadSubAgentSummary, "monitorId">,
): boolean {
  return subAgent.monitorId.startsWith("system:token-miser:");
}

/**
 * Groups sub-agents by the system that owns their lifecycle. The harness lens
 * holds the workers Codex and Claude Code start on their own.
 */
export function subAgentLens(subAgent: ThreadSubAgentSummary): SubAgentLens {
  if (isTokenMiserSubAgent(subAgent)) {
    return "token-miser";
  }
  if (isHarnessSubAgent(subAgent)) {
    return "harness";
  }
  return "pwragent";
}

export function subAgentOriginLabel(
  subAgent: ThreadSubAgentSummary,
): string | undefined {
  if (
    isSystemTitleHelperSubAgent(subAgent)
    || isSystemQueuedMessageTitleHelperSubAgent(subAgent)
  ) {
    return "PwrAgent system helper";
  }
  if (isTokenMiserSubAgent(subAgent)) {
    return "PwrAgent Token Miser gate";
  }
  if (isCodexNativeSubAgent(subAgent)) {
    return "Codex";
  }
  if (subAgent.monitorId.startsWith("review:")) {
    return "PwrAgent code review";
  }
  return "PwrAgent task monitor";
}

export function subAgentOriginSentence(
  subAgent: ThreadSubAgentSummary,
): string | undefined {
  const label = subAgentOriginLabel(subAgent);
  return label ? `Spawned by ${label}.` : undefined;
}

export function subAgentUsageLabel(subAgent: ThreadSubAgentSummary): string {
  if (
    isSystemTitleHelperSubAgent(subAgent)
    || isSystemQueuedMessageTitleHelperSubAgent(subAgent)
  ) {
    return "System";
  }
  if (isTokenMiserSubAgent(subAgent)) {
    return "Gate";
  }
  if (isCodexNativeSubAgent(subAgent)) {
    return "Codex";
  }
  if (subAgent.monitorId.startsWith("review:")) {
    return "Review";
  }
  return "Monitor";
}

export function subAgentPricingUsageTitle(
  subAgent: Pick<ThreadSubAgentSummary, "monitorId">,
): string {
  if (isSystemTitleHelperSubAgent(subAgent)) {
    return "Thread naming";
  }
  if (isSystemQueuedMessageTitleHelperSubAgent(subAgent)) {
    return "Queued message titles";
  }
  if (isTokenMiserSubAgent(subAgent)) {
    return "Token Miser gate";
  }
  if (isCodexNativeSubAgent(subAgent)) {
    return "Codex sub-agent usage";
  }
  if (subAgent.monitorId.startsWith("review:")) {
    return "Review usage";
  }
  return "Monitor usage";
}
