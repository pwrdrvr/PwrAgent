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
 * A heap snapshot is a byte-for-byte dump of everything the process is holding,
 * and the main process holds decrypted secrets: the xAI API key and every
 * messaging bot token are live strings there the moment `safeStorage` unseals
 * them. `strings main.heapsnapshot | grep -i xai` recovers the key.
 *
 * That makes a snapshot path something you must never hand to anyone casually —
 * not a bug report, not an issue, not a coding-agent session. Every surface that
 * mentions these files says so, because the natural instinct with a diagnostic
 * artifact is to paste the path at whoever is helping you.
 */
export const HEAP_SNAPSHOT_SECRET_WARNING =
  "Contains decrypted secrets (API keys, bot tokens) held in memory. Do not attach it to a bug report or share it with an agent.";

/**
 * The text the result toast copies. Deliberately leads with the warning: this
 * string exists to be pasted somewhere, so the caution has to travel with it.
 */
export function buildHeapSnapshotHandoffMessage(
  result: CaptureHeapSnapshotResult,
): string {
  const lines = [
    "PwrAgent captured a heap snapshot.",
    `WARNING: ${HEAP_SNAPSHOT_SECRET_WARNING}`,
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
