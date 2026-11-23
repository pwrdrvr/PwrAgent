import type { EffectiveHotCpuRule } from "@pwragent/shared/hot-cpu-rules";
import type { HotCpuRuleMatch } from "../../shared/hot-cpu-profile";

export type CpuInterval = {
  elapsedMs: number;
  cpuPercent: number;
  source: "cumulative" | "electron-interval";
};

export function isCpuSampleInterval(elapsedMs: number, cadenceMs: number): boolean {
  return elapsedMs > 0 && elapsedMs <= 1.5 * cadenceMs;
}

export class HotCpuRuleEvaluator {
  private readonly streaks = new Map<EffectiveHotCpuRule["id"], { count: number; window: CpuInterval[] }>();

  constructor(private readonly rules: readonly EffectiveHotCpuRule[], private readonly cadenceMs: number) {}

  reset(): void {
    this.streaks.clear();
  }

  hotSampleCount(id: EffectiveHotCpuRule["id"]): number {
    return this.streaks.get(id)?.count ?? 0;
  }

  observe(interval?: CpuInterval): HotCpuRuleMatch[] {
    if (!interval || !isCpuSampleInterval(interval.elapsedMs, this.cadenceMs)) {
      this.reset();
      return [];
    }
    const matches: HotCpuRuleMatch[] = [];
    for (const rule of this.rules) {
      if (!(interval.cpuPercent >= rule.thresholdPercent)) {
        this.streaks.delete(rule.id);
        continue;
      }
      const streak = this.streaks.get(rule.id) ?? { count: 0, window: [] };
      this.streaks.set(rule.id, streak);
      streak.count += 1;
      streak.window.push(interval);
      if (streak.window.length > rule.sampleCount) streak.window.shift();
      if (streak.window.length < rule.sampleCount) continue;

      let measuredDurationMs = 0;
      let peakCpuPercent = 0;
      let minimumCpuPercent = Number.POSITIVE_INFINITY;
      let usedElectronInterval = false;
      for (const sample of streak.window) {
        measuredDurationMs += sample.elapsedMs;
        peakCpuPercent = Math.max(peakCpuPercent, sample.cpuPercent);
        minimumCpuPercent = Math.min(minimumCpuPercent, sample.cpuPercent);
        usedElectronInterval ||= sample.source === "electron-interval";
      }
      // Allow bounded timer precision/rounding error across the entire
      // window. Early samples cannot each contribute unobserved time.
      const toleranceMs = Math.min(50, this.cadenceMs * 0.05);
      if (measuredDurationMs + toleranceMs < rule.durationMs) continue;
      matches.push({
        ...rule,
        intervalMs: this.cadenceMs,
        measuredDurationMs,
        triggerCpuPercent: interval.cpuPercent,
        peakCpuPercent,
        minimumCpuPercent,
        usedElectronInterval,
      });
    }
    return matches;
  }
}
