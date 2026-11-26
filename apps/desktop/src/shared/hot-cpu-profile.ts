import { HOT_CPU_RULE_LABELS, type EffectiveHotCpuRule } from "@pwragent/shared/hot-cpu-rules";
import type { AppBuildMetadata } from "./app-metadata";
import { buildAppIdentityDiagnosticsLines } from "./local-diagnostics-info";

export type HotCpuProfileTriggerMode = "spike" | "sustained" | "slowburn";

export type HotCpuProfileHeapSnapshotArtifact = {
  filename: string;
  path: string;
  phase: string;
};

export type HotCpuRuleMatch = EffectiveHotCpuRule & {
  intervalMs: number;
  measuredDurationMs: number;
  triggerCpuPercent: number;
  peakCpuPercent: number;
  minimumCpuPercent: number;
  usedElectronInterval: boolean;
};

export type HotCpuProfileCapturedEvent = {
  /** Host running the local Electron process that produced this capture. */
  sourceHostname?: string;
  /** Startup identity of the local app that produced this capture. */
  appBuildMetadata?: AppBuildMetadata;
  target?: "main" | "renderer";
  capturedAt: string;
  /** Present on the final capture of a batch that can be rearmed. */
  captureLimit?: number;
  chromiumTracePath?: string;
  heapSnapshotArtifacts?: HotCpuProfileHeapSnapshotArtifact[];
  profileFilename: string;
  profilePath: string;
  sessionDirectory: string;
  sessionDirectoryName: string;
  triggerConsecutiveSamples: number;
  triggerCpuPercent: number;
  triggerMode: HotCpuProfileTriggerMode;
  matchedRules?: HotCpuRuleMatch[];
  triggerThresholdPercent: number;
};

export type HotCpuPostCapEvent = {
  captureCount: number;
  capturedAt: string;
  sessionId: string;
  target: "main" | "renderer";
};

export type RearmHotCpuProfileRequest = Pick<
  HotCpuProfileCapturedEvent,
  "sessionDirectoryName" | "profileFilename"
>;

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatHotCpuProfileTriggerMode(
  mode: HotCpuProfileTriggerMode,
): string {
  return HOT_CPU_RULE_LABELS[mode];
}

export function formatHotCpuProfileTriggerSummary(
  event: Pick<
    HotCpuProfileCapturedEvent,
    | "matchedRules"
    | "triggerConsecutiveSamples"
    | "triggerCpuPercent"
    | "triggerMode"
    | "triggerThresholdPercent"
  >,
): string {
  if (event.matchedRules?.length) {
    const matches = event.matchedRules.map((match) => {
      const count = match.sampleCount === 1 ? "1 sample" : `${match.sampleCount} samples`;
      return `${HOT_CPU_RULE_LABELS[match.id]} (${formatPercent(match.thresholdPercent)}% threshold over ${match.durationMs / 1_000} s, ${count}. Measured ${formatPercent(match.triggerCpuPercent)}% at trigger, ${formatPercent(match.peakCpuPercent)}% peak)`;
    });
    return matches.join(" and ") + (event.matchedRules.some((match) => match.usedElectronInterval)
      ? " (includes Electron’s interval estimate)"
      : "");
  }
  const sampleLabel =
    event.triggerConsecutiveSamples === 1
      ? "1 sample"
      : `${event.triggerConsecutiveSamples} consecutive samples`;
  return [
    `${formatHotCpuProfileTriggerMode(event.triggerMode)} (`,
    `${sampleLabel} >= ${formatPercent(event.triggerThresholdPercent)}%; `,
    `trigger sample ${formatPercent(event.triggerCpuPercent)}%)`,
  ].join("");
}

export function buildHotCpuProfileHandoffMessage(
  event: HotCpuProfileCapturedEvent,
): string {
  const heapSnapshotArtifacts = event.heapSnapshotArtifacts ?? [];
  const heapSnapshotLines =
    heapSnapshotArtifacts.length > 0
      ? [
          `Heap snapshots captured: ${heapSnapshotArtifacts.length}`,
          ...heapSnapshotArtifacts.flatMap((artifact) => [
            `Heap snapshot ${artifact.phase} basename: ${artifact.filename}`,
            `Heap snapshot ${artifact.phase} path: ${artifact.path}`,
          ]),
        ]
      : [];

  return [
    `PwrAgent captured a ${event.target ?? "renderer"} CPU profile.`,
    `Source: Local app${event.sourceHostname ? ` on ${event.sourceHostname}` : ""}`,
    `Captured at: ${event.capturedAt}`,
    ...buildAppIdentityDiagnosticsLines(event.appBuildMetadata ?? {}),
    `Trigger: ${formatHotCpuProfileTriggerSummary(event)}`,
    `Session basename: ${event.sessionDirectoryName}`,
    `Session directory path: ${event.sessionDirectory}`,
    `CPU profile basename: ${event.profileFilename}`,
    `CPU profile path: ${event.profilePath}`,
    ...(event.chromiumTracePath ? [`Chromium trace path: ${event.chromiumTracePath}`] : []),
    ...heapSnapshotLines,
    "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots.",
  ].join("\n");
}
