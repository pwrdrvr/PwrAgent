import { join } from "node:path";
import { ipcMain, type WebContents } from "electron";
import {
  DIAGNOSTICS_CAPTURE_HEAP_SNAPSHOT_CHANNEL,
  DIAGNOSTICS_HEAP_SNAPSHOT_CAPTURED_EVENT_CHANNEL,
} from "../../shared/ipc";
import type {
  CaptureHeapSnapshotRequest,
  CaptureHeapSnapshotResult,
} from "../../shared/heap-snapshot";
import { captureHeapSnapshot } from "../diagnostics/manual-heap-snapshot";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { subscribersForChannel } from "../window-channels";

const logger = getMainLogger("pwragent:diagnostics-ipc");

/** Long enough to stage a scenario, short enough that nobody forgets it is armed. */
const MAX_CAPTURE_DELAY_MS = 60_000;

let pendingCapture: NodeJS.Timeout | undefined;

export type ScheduleHeapSnapshotResponse = {
  /** Wall-clock ms until the capture runs; 0 means it already started. */
  delayMs: number;
};

function resolveDiagnosticsOutputRoot(): string {
  return resolveActiveProfilePath(join("state", "diagnostics"));
}

function broadcastCaptured(result: CaptureHeapSnapshotResult): void {
  for (const webContents of subscribersForChannel(
    DIAGNOSTICS_HEAP_SNAPSHOT_CAPTURED_EVENT_CHANNEL,
  )) {
    webContents.send(DIAGNOSTICS_HEAP_SNAPSHOT_CAPTURED_EVENT_CHANNEL, result);
  }
}

/**
 * The delay lives here, not in the renderer, so the capture survives the
 * operator navigating away from Settings (or closing it entirely) to stage
 * whatever they wanted to snapshot. The result comes back as a broadcast.
 */
async function runCapture(
  request: CaptureHeapSnapshotRequest,
  webContents: WebContents,
): Promise<void> {
  try {
    const result = await captureHeapSnapshot({
      outputRoot: resolveDiagnosticsOutputRoot(),
      target: request.target ?? "both",
      webContents,
    });
    broadcastCaptured(result);
  } catch (error) {
    logger.error("heap-snapshot-capture-failed", error);
    broadcastCaptured({
      capturedAt: new Date().toISOString(),
      sessionDirectory: "",
      sessionDirectoryName: "",
      artifacts: [],
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export function registerDiagnosticsIpcHandlers(): void {
  ipcMain.removeHandler(DIAGNOSTICS_CAPTURE_HEAP_SNAPSHOT_CHANNEL);
  ipcMain.handle(
    DIAGNOSTICS_CAPTURE_HEAP_SNAPSHOT_CHANNEL,
    (
      event,
      request: CaptureHeapSnapshotRequest = {},
    ): ScheduleHeapSnapshotResponse => {
      const delayMs = Math.min(
        MAX_CAPTURE_DELAY_MS,
        Math.max(0, Math.round(request.delayMs ?? 0)),
      );
      // A second request supersedes an armed one rather than stacking captures.
      if (pendingCapture) {
        clearTimeout(pendingCapture);
        pendingCapture = undefined;
      }
      const sender = event.sender;
      if (delayMs === 0) {
        void runCapture(request, sender);
        return { delayMs: 0 };
      }
      pendingCapture = setTimeout(() => {
        pendingCapture = undefined;
        void runCapture(request, sender);
      }, delayMs);
      return { delayMs };
    },
  );
}

export function disposeDiagnosticsIpcHandlers(): void {
  ipcMain.removeHandler(DIAGNOSTICS_CAPTURE_HEAP_SNAPSHOT_CHANNEL);
  if (pendingCapture) {
    clearTimeout(pendingCapture);
    pendingCapture = undefined;
  }
}
