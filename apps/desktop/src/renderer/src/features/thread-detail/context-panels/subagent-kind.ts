import type { ThreadSubAgentSummary } from "@pwragent/shared";

export function isCodexNativeSubAgent(
  subAgent: ThreadSubAgentSummary,
): boolean {
  return subAgent.monitorId.startsWith("codex-native:");
}

export function isSystemTitleHelperSubAgent(
  subAgent: ThreadSubAgentSummary,
): boolean {
  return subAgent.monitorId.startsWith("system:title-helper:");
}

export function subAgentOriginLabel(
  subAgent: ThreadSubAgentSummary,
): string | undefined {
  if (isSystemTitleHelperSubAgent(subAgent)) {
    return "PwrAgent system helper";
  }
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
  if (isSystemTitleHelperSubAgent(subAgent)) {
    return "System";
  }
  if (isCodexNativeSubAgent(subAgent)) {
    return "Codex";
  }
  if (subAgent.monitorId.startsWith("review:")) {
    return "Review";
  }
  return "Monitor";
}
