export type HotCpuProfileTriggerMode = "spike" | "sustained" | "slowburn";

export type HotCpuProfileHeapSnapshotArtifact = {
  filename: string;
  path: string;
  phase: string;
};

export type HotCpuProfileCapturedEvent = {
  capturedAt: string;
  heapSnapshotArtifacts?: HotCpuProfileHeapSnapshotArtifact[];
  profileFilename: string;
  profilePath: string;
  sessionDirectory: string;
  sessionDirectoryName: string;
  triggerConsecutiveSamples: number;
  triggerCpuPercent: number;
  triggerMode: HotCpuProfileTriggerMode;
  triggerThresholdPercent: number;
};

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatHotCpuProfileTriggerMode(
  mode: HotCpuProfileTriggerMode,
): string {
  switch (mode) {
    case "spike":
      return "Spike";
    case "sustained":
      return "Sustained";
    case "slowburn":
      return "Slowburn";
  }
}

export function formatHotCpuProfileTriggerSummary(
  event: Pick<
    HotCpuProfileCapturedEvent,
    | "triggerConsecutiveSamples"
    | "triggerCpuPercent"
    | "triggerMode"
    | "triggerThresholdPercent"
  >,
): string {
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
    "PwrAgent captured a renderer CPU profile.",
    `Trigger: ${formatHotCpuProfileTriggerSummary(event)}`,
    `Session basename: ${event.sessionDirectoryName}`,
    `Session directory path: ${event.sessionDirectory}`,
    `CPU profile basename: ${event.profileFilename}`,
    `CPU profile path: ${event.profilePath}`,
    ...heapSnapshotLines,
    "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots.",
  ].join("\n");
}
