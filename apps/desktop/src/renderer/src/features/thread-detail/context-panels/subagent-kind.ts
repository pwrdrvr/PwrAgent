import type { ThreadSubAgentSummary } from "@pwragent/shared";

export function isCodexNativeSubAgent(subAgent: ThreadSubAgentSummary): boolean {
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

export function subAgentPricingUsageTitle(
  subAgent: ThreadSubAgentSummary,
): string {
  if (isSystemTitleHelperSubAgent(subAgent)) {
    return "Thread naming";
  }
  if (isCodexNativeSubAgent(subAgent)) {
    return "Codex sub-agent usage";
  }
  if (subAgent.monitorId.startsWith("review:")) {
    return "Review usage";
  }
  return "Monitor usage";
}
