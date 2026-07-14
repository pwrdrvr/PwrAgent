/**
 * On-demand heap snapshots.
 *
 * The hot-CPU profiler can already emit heap snapshots, but only as a side
 * effect of a CPU spike — useless when you want to inspect a process that is
 * sitting idle holding onto something it shouldn't (the case that motivated
 * this: ten PTYs alive in the main process with nothing in the UI referencing
 * them). This captures both processes on request instead.
 *
 * Both processes matter: renderer-side leaks show up in the renderer snapshot,
 * but anything owned by main — terminal sessions, detached child processes,
 * backend registries — is only visible in the main-process snapshot.
 */

export type HeapSnapshotTarget = "main" | "renderer" | "both";

export type CaptureHeapSnapshotRequest = {
  /** Countdown before capture, so an operator can set up the scenario first. */
  delayMs?: number;
  target?: HeapSnapshotTarget;
};

export type HeapSnapshotArtifact = {
  process: "main" | "renderer";
  filename: string;
  path: string;
  bytes: number;
};

export type CaptureHeapSnapshotResult = {
  capturedAt: string;
  sessionDirectory: string;
  sessionDirectoryName: string;
  artifacts: HeapSnapshotArtifact[];
  /** Per-target failures; a partial capture still returns its artifacts. */
  errors: string[];
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${megabytes.toFixed(1)} MB`;
}

/**
 * The text the result toast copies. Written to be pasted straight into a bug
 * report or an agent session — absolute paths, no "see above".
 */
export function buildHeapSnapshotHandoffMessage(
  result: CaptureHeapSnapshotResult,
): string {
  const lines = [
    "PwrAgent captured a heap snapshot.",
    `Session basename: ${result.sessionDirectoryName}`,
    `Session directory path: ${result.sessionDirectory}`,
  ];
  for (const artifact of result.artifacts) {
    lines.push(
      `${artifact.process} heap snapshot path: ${artifact.path} (${formatBytes(
        artifact.bytes,
      )})`,
    );
  }
  for (const error of result.errors) {
    lines.push(`Capture error: ${error}`);
  }
  lines.push(
    "Open a .heapsnapshot in Chrome DevTools → Memory → Load to inspect retained objects.",
  );
  return lines.join("\n");
}

export function describeHeapSnapshotResult(
  result: CaptureHeapSnapshotResult,
): string {
  const captured = result.artifacts
    .map((artifact) => `${artifact.process} (${formatBytes(artifact.bytes)})`)
    .join(", ");
  if (result.artifacts.length === 0) {
    return "No heap snapshot was captured.";
  }
  return `Captured ${captured} in ${result.sessionDirectoryName}.`;
}
