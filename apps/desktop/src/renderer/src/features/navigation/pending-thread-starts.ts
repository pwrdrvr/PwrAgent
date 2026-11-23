import { federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type {
  AppServerBackendKind,
  AppServerPendingThreadStartReport,
  AppServerPendingThreadStart,
} from "@pwragent/shared/contracts/normalized-app-server";
import { applyLaunchpadEnvironmentSetupProgress, type LaunchpadEnvironmentSetupProgress } from "../../lib/launchpad-setup-progress";
import type { PendingLaunchpadCreation } from "../../lib/useThreadNavigation";

/**
 * Starts the owner reports with `thread/start/pending`: a to-do card's thread
 * while its worktree and environment setup run. The list draws each one as a
 * starting row in the slot its thread will take, and the thread's own row
 * takes over the slot once it renders (`selectUnlandedStartingThreads`).
 *
 * Only this machine's starts arrive here. A launchpad draws its own starting
 * row and does not report one.
 */
export type PendingThreadStart = {
  start: AppServerPendingThreadStart;
  /** The thread, once the owner reports it landed. */
  createdThreadId?: string;
  /** The owner finished the start. A landed start stays until its row is read. */
  ended?: boolean;
  setupProgress?: LaunchpadEnvironmentSetupProgress;
};

export type PendingThreadStartReport = AppServerPendingThreadStartReport;

const SELECTION_PREFIX = "pending-thread-start:";

export function pendingThreadStartSelectionKey(startId: string): string {
  return `${SELECTION_PREFIX}${startId}`;
}

export function isPendingThreadStartSelectionKey(selectionKey: string | undefined): boolean {
  return selectionKey?.startsWith(SELECTION_PREFIX) === true;
}

/**
 * The starts after one report. `retired` holds the starts already gone, so a
 * report that arrives after its start ended never draws the row again.
 */
export function applyPendingThreadStartReport(
  starts: readonly PendingThreadStart[],
  report: PendingThreadStartReport,
  retired: { has: (startId: string) => boolean },
): readonly PendingThreadStart[] {
  const { start, phase, createdThreadId } = report;
  if (retired.has(start.startId)) return starts;
  const index = starts.findIndex((entry) => entry.start.startId === start.startId);
  const current = index >= 0 ? starts[index] : undefined;
  if (current?.ended) return starts;
  const landedThreadId = current?.createdThreadId ?? createdThreadId;
  if (phase === "ended" && !landedThreadId) {
    // Nothing was created: the row goes at once.
    return index >= 0 ? starts.filter((_, at) => at !== index) : starts;
  }
  const setupProgress = report.setupProgress
    ? applyLaunchpadEnvironmentSetupProgress(current?.setupProgress, report.setupProgress)
    : current?.setupProgress;
  const next: PendingThreadStart = {
    start: current?.start ?? start,
    ...(setupProgress ? { setupProgress } : {}),
    ...(landedThreadId ? { createdThreadId: landedThreadId } : {}),
    ...(phase === "ended" ? { ended: true } : {}),
  };
  if (index < 0) return [...starts, next];
  return starts.map((entry, at) => (at === index ? next : entry));
}

/** Removes a start whose thread row has been read since it ended. */
export function retirePendingThreadStart(
  starts: readonly PendingThreadStart[],
  startId: string,
): readonly PendingThreadStart[] {
  return starts.some((entry) => entry.start.startId === startId)
    ? starts.filter((entry) => entry.start.startId !== startId)
    : starts;
}

/** A thread's row key, as `threadSummaryIdentityKey` spells it in this machine's list. */
function threadKeyOnThisMachine(
  backend: AppServerBackendKind,
  threadId: string,
  instanceId: string | undefined,
  localInstanceId: string | undefined,
): string {
  return instanceId && instanceId !== localInstanceId
    ? federatedThreadIdentityKey({ backend, target: { scope: "remote", instanceId }, threadId })
    : buildThreadIdentityKey(backend, threadId);
}

function pathLabel(path: string | undefined): string {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/**
 * The starting rows for this machine's list. Each carries the keys a list
 * files a starting row by: its project, the parent whose tray it lands in,
 * and its thread once landed.
 */
export function pendingThreadStartRows(
  starts: readonly PendingThreadStart[],
  localInstanceId: string | undefined,
): PendingLaunchpadCreation[] {
  return starts.map(({ start, createdThreadId, setupProgress }) => {
    const directoryPath = start.cwd?.trim() || undefined;
    const directoryKey = start.directoryKey ?? (directoryPath ? `directory:${directoryPath}` : "");
    const directoryLabel = start.directoryLabel || pathLabel(directoryPath) || "No project";
    const selectionKey = pendingThreadStartSelectionKey(start.startId);
    return {
      operationId: start.startId,
      submittedAt: start.submittedAt,
      selectionKey,
      directoryKey,
      directoryLabel,
      setupProgressKey: start.startId,
      ...(setupProgress ? { setupProgress } : {}),
      launchpad: {
        backend: start.backend,
        // Not shown on a starting row; the thread's own row shows its access.
        executionMode: "default",
        directoryKey,
        directoryKind: "directory",
        directoryLabel,
        ...(directoryPath ? { directoryPath } : {}),
        ...(start.model ? { model: start.model } : {}),
        prompt: "",
        workMode: start.workMode ?? "local",
        createdAt: start.submittedAt,
        updatedAt: start.submittedAt,
      },
      ...(start.parentThreadId
        ? {
            parentThreadKey: threadKeyOnThisMachine(
              start.parentThreadBackend ?? start.backend,
              start.parentThreadId,
              start.parentThreadInstanceId,
              localInstanceId,
            ),
          }
        : {}),
      ...(createdThreadId
        ? { threadKey: buildThreadIdentityKey(start.backend, createdThreadId) }
        : {}),
      selectable: Boolean(createdThreadId || start.progressThread || start.prompt !== undefined),
      title: start.title,
      input: start.prompt === undefined ? [] : [{ type: "text", text: start.prompt }],
    };
  });
}

/**
 * The thread a starting row opens: its own thread once landed, else the
 * thread whose view reports the start (a to-do card's tray). Undefined when
 * there is neither, and the row stays where it is.
 */
export function pendingThreadStartOpenTarget(
  starts: readonly PendingThreadStart[],
  selectionKey: string,
): { backend: AppServerBackendKind; threadId: string } | undefined {
  const entry = starts.find(({ start }) => pendingThreadStartSelectionKey(start.startId) === selectionKey);
  if (!entry) return undefined;
  if (entry.createdThreadId) return { backend: entry.start.backend, threadId: entry.createdThreadId };
  return entry.start.progressThread;
}
