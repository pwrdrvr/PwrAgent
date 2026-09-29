import type { ThreadUsageLineRecord, UsageActivityRollup } from "@pwragent/shared";
import { usageRollupLabel } from "./usage-activity-presentation";
import type { UsageGroup } from "./usage-activity-summary";

export type UsageSignal = { label: string; title: string; warning: boolean };

/** Three or more requests that missed the cache point at a lost prefix. */
const COLD_REPLAY_WARNING = 3;
const CONTEXT_WARNING = 0.9;
const CONTEXT_NOTE = 0.75;

function contextSignal(share: number | undefined): UsageSignal | undefined {
  if (share === undefined || share < CONTEXT_NOTE) return undefined;
  return { label: `Context ${Math.round(share * 100)}%`, warning: share >= CONTEXT_WARNING,
    title: "Largest observed request context, as a share of the model's context window" };
}

function coldSignal(count: number | undefined): UsageSignal | undefined {
  if (!count) return undefined;
  return { label: `${count} cold ${count === 1 ? "replay" : "replays"}`, warning: count >= COLD_REPLAY_WARNING,
    title: "Model requests whose input was mostly not served from cache" };
}

// Absent fields mean "not observed", so they produce no chip rather than a zero.
export function groupSignals(group: UsageGroup): UsageSignal[] {
  return [
    coldSignal(group.coldReplays),
    contextSignal(group.peakContextShare),
    group.fastMode ? { label: "Fast mode", warning: false, title: "At least one turn ran in fast mode" } : undefined,
    group.helperThreads ? { label: `${group.helperThreads} ${group.helperThreads === 1 ? "helper" : "helpers"}`, warning: false,
      title: "Helper threads whose spend is included in this row" } : undefined,
  ].filter((signal): signal is UsageSignal => signal !== undefined);
}

export function turnSignals(line: ThreadUsageLineRecord, helper?: string, rollup?: UsageActivityRollup): UsageSignal[] {
  return [
    rollup ? { label: usageRollupLabel(rollup), warning: false, title: "Background helper runs for this thread, summed" } : undefined,
    helper ? { label: `Helper · ${helper}`, warning: false, title: "A helper thread's turn, counted in this thread" } : undefined,
    coldSignal(line.observedColdReplayCount),
    contextSignal(line.peakContextTokens !== undefined && line.modelContextWindow
      ? line.peakContextTokens / line.modelContextWindow : undefined),
    line.fastMode ? { label: "Fast mode", warning: false, title: "This turn ran in fast mode" } : undefined,
  ].filter((signal): signal is UsageSignal => signal !== undefined);
}

export function UsageSignals({ signals }: { signals: UsageSignal[] }) {
  return <span className="usage-signals">{signals.map((signal) =>
    <span key={signal.label} className={`usage-signal${signal.warning ? " is-warning" : ""}`} title={signal.title}>{signal.label}</span>)}</span>;
}
