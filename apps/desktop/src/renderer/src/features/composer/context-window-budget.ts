import {
  effectiveAutoCompactionRules,
  resolveAutoCompactionThreshold,
  type DesktopAutoCompactionRule,
} from "@pwragent/shared/auto-compaction";
import type { AppServerNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";

export type ThreadAutoCompactionStatus = Extract<
  AppServerNotification,
  { method: "thread/autoCompaction/updated" }
>["params"];

/** What the moon and its card add when a rule sets a context budget. */
export type ContextWindowBudget = {
  /** The window the provider reported. */
  reportedContextWindow: number;
  /** The smaller of the rule's budget and the reported window. */
  effectiveContextWindow: number;
  compactAtPercent: number;
  triggerTokens: number;
  /** Tokens left before PwrAgent compacts; 0 once past the trigger. */
  tokensToTrigger: number;
};

/**
 * Measures the fill against the thread's auto-compaction budget. The moon,
 * its percent and the card all read the effective window, so a Gemini 4 Neon
 * thread at 400k of a 1M report reads 78% of its 512k budget. Without a
 * matching rule the reading is unchanged and no budget is returned.
 */
export function applyContextWindowBudget(params: {
  contextWindow: ThreadContextWindowState;
  savedRules: readonly DesktopAutoCompactionRule[] | undefined;
  backend?: string;
  model?: string;
}): { contextWindow: ThreadContextWindowState; budget?: ContextWindowBudget } {
  const { contextWindow } = params;
  if (!params.backend) return { contextWindow };
  const threshold = resolveAutoCompactionThreshold({
    rules: effectiveAutoCompactionRules(params.savedRules ?? []),
    backend: params.backend,
    model: params.model,
    reportedContextWindow: contextWindow.modelContextWindow,
  });
  if (!threshold) return { contextWindow };
  const effective = threshold.effectiveContextWindow;
  const used = contextWindow.totalTokens;
  const remainingTokens = Math.max(0, effective - used);
  return {
    contextWindow: {
      ...contextWindow,
      modelContextWindow: effective,
      usedPercent: Math.max(0, Math.min(100, (used / effective) * 100)),
      remainingTokens,
      remainingPercent: Math.max(0, Math.min(100, (remainingTokens / effective) * 100)),
    },
    budget: {
      reportedContextWindow: threshold.reportedContextWindow,
      effectiveContextWindow: effective,
      compactAtPercent: threshold.compactAtPercent,
      triggerTokens: threshold.triggerTokens,
      tokensToTrigger: Math.max(0, threshold.triggerTokens - used),
    },
  };
}

/** The status line the card shows for the owner's compaction phase, if any. */
export function autoCompactionStatusLine(
  status: ThreadAutoCompactionStatus | undefined,
  formatTokens: (value: number) => string,
): string | undefined {
  if (!status) return undefined;
  const at = status.dispatchedAtTokens !== undefined ? ` at ${formatTokens(status.dispatchedAtTokens)}` : "";
  switch (status.phase) {
    case "steering":
    case "compacting":
      return status.via === "steer"
        ? `Compacting. PwrAgent steered /compact into this turn${at}.`
        : `Compacting. PwrAgent sent /compact${at}.`;
    case "starting":
      return `Compacting. PwrAgent is sending /compact${at}.`;
    case "due":
      return "Past the compaction point. PwrAgent compacts when this turn ends.";
    case "resume":
      return "Compacted. PwrAgent asks the agent to continue when this turn ends.";
    case "held":
      if (status.heldReason === "unsupported") return "This agent has no /compact command, so PwrAgent cannot compact it.";
      if (status.heldReason === "refused") return "The agent refused /compact. PwrAgent will not try again until the context drops.";
      return status.triggerTokens !== undefined
        ? `Compaction ran but the context stayed above ${formatTokens(status.triggerTokens)}. PwrAgent will not compact again until it drops.`
        : "Compaction ran but the context stayed high. PwrAgent will not compact again until it drops.";
    default:
      return undefined;
  }
}

/** Phases where PwrAgent's own compaction is open. */
export function isAutoCompactionActive(status: ThreadAutoCompactionStatus | undefined): boolean {
  return status?.phase === "steering" || status?.phase === "starting" || status?.phase === "compacting";
}
