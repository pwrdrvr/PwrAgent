import type {
  AutomationBacklogPolicy,
  AutomationRunStatus,
  AutomationScheduleDefinition,
  AutomationStatus,
} from "@pwragent/shared";
import { formatUsd } from "../thread-detail/context-panels/subagent-format";

export function formatAutomationTimestamp(timestamp: number | undefined): string {
  if (!timestamp) {
    return "Not scheduled";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function formatAutomationRelative(timestamp: number | undefined): string {
  if (!timestamp) {
    return "never";
  }

  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  const suffix = deltaSeconds >= 0 ? "from now" : "ago";
  if (absoluteSeconds < 60) {
    return deltaSeconds >= 0 ? "now" : "just now";
  }
  const minutes = Math.round(absoluteSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${suffix}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${suffix}`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

export function formatBacklogPolicy(policy: AutomationBacklogPolicy): string {
  return policy === "coalesce" ? "Coalesce missed runs" : "Drop missed runs";
}

export function formatAutomationStatus(status: AutomationStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatRunStatus(status: AutomationRunStatus): string {
  return status.replace("_", " ");
}

export function formatScheduleKind(schedule: AutomationScheduleDefinition): string {
  if (schedule.kind === "interval") {
    return "Interval";
  }
  if (schedule.kind === "weekdays") {
    return "Weekdays";
  }
  return "Weekly";
}

/**
 * One-line run cost/usage summary: "$0.38 · 6.4k in · 1.2k out". Cost is the
 * list price frozen at run time (micros), rendered with the same sub-ten-cent
 * extra decimal the sub-agent cost line uses. Returns undefined when the run
 * has no recorded usage, so callers can omit the line entirely.
 */
export function formatAutomationRunUsage(
  usage:
    | {
        uncachedInputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
        totalCostMicros?: number;
      }
    | undefined,
): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (typeof usage.totalCostMicros === "number") {
    parts.push(formatUsd(usage.totalCostMicros / 1_000_000));
  }
  const inputTokens =
    (usage.uncachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
  if (inputTokens > 0) parts.push(`${formatTokenCount(inputTokens)} in`);
  if (usage.outputTokens !== undefined && usage.outputTokens > 0) {
    parts.push(`${formatTokenCount(usage.outputTokens)} out`);
  }
  return parts.length > 0 ? parts.join(" \u00b7 ") : undefined;
}

/**
 * "gpt-5.6-sol · high" for a run's runtime line, mirroring the sub-agent
 * card's model line. Undefined when the run recorded neither, so the caller
 * omits the element instead of rendering an empty separator.
 */
export function formatAutomationRunRuntime(
  usage: { model?: string; reasoningEffort?: string } | undefined,
): string | undefined {
  const parts = [usage?.model, usage?.reasoningEffort].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Working directory shortened to its last two segments ("…/pwrdrvr/search").
 * A table cell can only show so much, and CSS truncation would drop the tail
 * — which is the half that says which repo this is. Callers keep the full
 * path in a title attribute.
 */
export function formatWorkspacePathLabel(cwd: string): string {
  const segments = cwd.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 2) return cwd;
  return `…/${segments.slice(-2).join("/")}`;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatCostTodayMicros(micros: number | undefined): string | undefined {
  if (micros === undefined) return undefined;
  return `${formatUsd(micros / 1_000_000)} today`;
}
