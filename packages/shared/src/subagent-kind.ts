import type { ThreadSubAgentSummary } from "./contracts/navigation";

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
 * is intentionally provider-neutral even though Codex is the only harness
 * that projects native workers today.
 */
export function subAgentLens(subAgent: ThreadSubAgentSummary): SubAgentLens {
  if (isTokenMiserSubAgent(subAgent)) {
    return "token-miser";
  }
  if (isCodexNativeSubAgent(subAgent)) {
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
