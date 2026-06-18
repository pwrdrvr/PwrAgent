import type { ThreadSubAgentSummary } from "@pwragent/shared";

export function isCodexNativeSubAgent(subAgent: ThreadSubAgentSummary): boolean {
  return subAgent.monitorId.startsWith("codex-native:");
}

export function subAgentOriginLabel(
  subAgent: ThreadSubAgentSummary,
): string | undefined {
  if (isCodexNativeSubAgent(subAgent)) {
    return "Codex native spawnAgent";
  }
  return undefined;
}

export function subAgentOriginSentence(
  subAgent: ThreadSubAgentSummary,
): string | undefined {
  const label = subAgentOriginLabel(subAgent);
  return label ? `Spawned by ${label}.` : undefined;
}

export function subAgentUsageLabel(subAgent: ThreadSubAgentSummary): string {
  if (isCodexNativeSubAgent(subAgent)) {
    return "Codex";
  }
  if (subAgent.monitorId.startsWith("review:")) {
    return "Review";
  }
  return "Monitor";
}
