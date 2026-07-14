import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import type { WebContents } from "electron";
import type {
  CaptureHeapSnapshotRequest,
  CaptureHeapSnapshotResult,
  HeapSnapshotArtifact,
  HeapSnapshotTarget,
} from "../../shared/heap-snapshot";
import { getMainLogger } from "../log";

const logger = getMainLogger("pwragent:heap-snapshot");

/** Matches the `hot-cpu-YYYY-MM-DD-HHmm-xxxxxx` convention next door. */
function formatSessionPrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function statBytes(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

export type CaptureHeapSnapshotOptions = CaptureHeapSnapshotRequest & {
  outputRoot: string;
  /** The window that asked; omit to capture main only. */
  target?: HeapSnapshotTarget;
  webContents?: WebContents;
  createdAt?: Date;
  sessionId?: string;
};

/**
 * Write heap snapshots for the requested processes into a fresh session
 * directory. A failure on one target does not abandon the other — a partial
 * capture is still worth having, so failures are reported alongside whatever
 * did get written.
 */
export async function captureHeapSnapshot(
  options: CaptureHeapSnapshotOptions,
): Promise<CaptureHeapSnapshotResult> {
  const createdAt = options.createdAt ?? new Date();
  const sessionId = options.sessionId ?? randomBytes(3).toString("hex");
  const sessionDirectoryName = `heap-${formatSessionPrefix(createdAt)}-${sessionId}`;
  const sessionDirectory = path.join(options.outputRoot, sessionDirectoryName);
  const target: HeapSnapshotTarget = options.target ?? "both";
  const artifacts: HeapSnapshotArtifact[] = [];
  const errors: string[] = [];

  await fs.mkdir(sessionDirectory, { recursive: true });

  if (target === "main" || target === "both") {
    const filename = "main.heapsnapshot";
    const filePath = path.join(sessionDirectory, filename);
    try {
      // Synchronous and stop-the-world; that is the only API V8 gives us for
      // the main process, and a manual capture is an explicit operator action.
      v8.writeHeapSnapshot(filePath);
      artifacts.push({
        process: "main",
        filename,
        path: filePath,
        bytes: await statBytes(filePath),
      });
    } catch (error) {
      errors.push(`main: ${errorMessage(error)}`);
      logger.warn("main-heap-snapshot-failed", { error: errorMessage(error) });
    }
  }

  if (target === "renderer" || target === "both") {
    const filename = "renderer.heapsnapshot";
    const filePath = path.join(sessionDirectory, filename);
    if (!options.webContents || options.webContents.isDestroyed()) {
      errors.push("renderer: no live window to capture");
    } else {
      try {
        await options.webContents.takeHeapSnapshot(filePath);
        artifacts.push({
          process: "renderer",
          filename,
          path: filePath,
          bytes: await statBytes(filePath),
        });
      } catch (error) {
        errors.push(`renderer: ${errorMessage(error)}`);
        logger.warn("renderer-heap-snapshot-failed", {
          error: errorMessage(error),
        });
      }
    }
  }

  const result: CaptureHeapSnapshotResult = {
    capturedAt: createdAt.toISOString(),
    sessionDirectory,
    sessionDirectoryName,
    artifacts,
    errors,
  };
  logger.info("captured", {
    artifacts: artifacts.map((artifact) => artifact.filename),
    errors,
    sessionDirectory,
  });
  return result;
}
