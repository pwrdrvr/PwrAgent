import type {
  ManagedRuntimeId,
  ManagedRuntimeInstallPhase,
  ManagedRuntimeProgress,
} from "../shared/managed-runtime-progress";

// Latest progress per runtime, held in memory only. Settings can open in the
// middle of a download, so a subscriber needs the current state as well as
// the events that follow it. Nothing here is persisted: a restart interrupts
// the download and the next check starts over.

type ProgressListener = (event: ManagedRuntimeProgress) => void;
type ProgressInput = Omit<ManagedRuntimeProgress, "updatedAt" | "runtime">;

const latest = new Map<ManagedRuntimeId, ManagedRuntimeProgress>();
const listeners = new Set<ProgressListener>();

/** The byte meter updates a few times a second, not once per network chunk. */
const DOWNLOAD_REPORT_INTERVAL_MS = 250;
/** Weight of the newest sample in the smoothed rate. */
const RATE_SMOOTHING = 0.3;

export function readManagedRuntimeProgress(): ManagedRuntimeProgress[] {
  return [...latest.values()];
}

export function subscribeManagedRuntimeProgress(
  listener: ProgressListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(
  runtime: ManagedRuntimeId,
  input: ProgressInput,
  now: number,
): void {
  const event: ManagedRuntimeProgress = { runtime, ...input, updatedAt: now };
  if (input.phase === "idle") {
    latest.delete(runtime);
  } else {
    latest.set(runtime, event);
  }
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must not fail an install.
    }
  }
}

export type ManagedRuntimeProgressReporter = {
  checking(): void;
  /** Begin the download phase; returns the meter the archive stream feeds. */
  downloading(tag: string, totalBytes?: number): (chunkBytes: number) => void;
  verifying(tag: string): void;
  unpacking(tag: string): void;
  activating(tag: string): void;
  ready(tag: string): void;
  /** Clears the strip. Also the answer for an abort the operator asked for. */
  idle(): void;
  failed(error: unknown, options?: { tag?: string; fallbackTag?: string }): void;
};

/**
 * A reporter for one runtime's install. It remembers the phase it last
 * reported so `failed` can name the step that stopped, which the caller's
 * catch block otherwise cannot know.
 */
export function createManagedRuntimeProgressReporter(
  runtime: ManagedRuntimeId,
  now: () => number = Date.now,
): ManagedRuntimeProgressReporter {
  let phase: ManagedRuntimeInstallPhase | "checking" = "checking";
  const step = (
    next: ManagedRuntimeInstallPhase,
    tag: string,
  ): void => {
    phase = next;
    publish(runtime, { phase: next, tag }, now());
  };
  return {
    checking() {
      phase = "checking";
      publish(runtime, { phase: "checking" }, now());
    },
    downloading(tag, totalBytes) {
      phase = "downloading";
      const startedAt = now();
      let received = 0;
      let lastReportAt = startedAt;
      let lastReportBytes = 0;
      let rate: number | undefined;
      const report = (at: number): void => {
        publish(
          runtime,
          {
            phase: "downloading",
            tag,
            receivedBytes: received,
            ...(totalBytes !== undefined ? { totalBytes } : {}),
            ...(rate !== undefined ? { bytesPerSecond: rate } : {}),
          },
          at,
        );
      };
      report(startedAt);
      return (chunkBytes) => {
        received += chunkBytes;
        const at = now();
        if (at - lastReportAt < DOWNLOAD_REPORT_INTERVAL_MS) return;
        const sample = (received - lastReportBytes) / ((at - lastReportAt) / 1000);
        rate = rate === undefined
          ? sample
          : rate * (1 - RATE_SMOOTHING) + sample * RATE_SMOOTHING;
        lastReportAt = at;
        lastReportBytes = received;
        report(at);
      };
    },
    verifying: (tag) => step("verifying", tag),
    unpacking: (tag) => step("unpacking", tag),
    activating: (tag) => step("activating", tag),
    ready(tag) {
      publish(runtime, { phase: "ready", tag }, now());
    },
    idle() {
      publish(runtime, { phase: "idle" }, now());
    },
    failed(error, options = {}) {
      publish(
        runtime,
        {
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
          failedPhase: phase,
          ...(options.tag ? { tag: options.tag } : {}),
          ...(options.fallbackTag ? { fallbackTag: options.fallbackTag } : {}),
        },
        now(),
      );
    },
  };
}
