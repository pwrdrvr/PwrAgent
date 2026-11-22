import fs from "node:fs/promises";
import { TRACE_CATEGORIES } from "./chromium-trace-filter";
import { onChromiumTraceReleased, tryAcquireChromiumTrace } from "./chromium-trace-lease";

const TRACE_BUFFER_KB = 32 * 1024;
const START_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 4_000;

export type ChromiumTraceConfig = {
  recordMode: "recordContinuously" | "recordUntilFull";
  traceBufferSizeInKb: number;
  includedCategories: string[];
  excludedCategories: string[];
};

export type ChromiumTraceChunk = { data: string; base64Encoded?: boolean };

export type ChromiumTraceSession = {
  start: (config: ChromiumTraceConfig) => Promise<void>;
  read: (signal: AbortSignal) => AsyncIterable<ChromiumTraceChunk>;
  dispose: () => void;
};

export type PublishChromiumTrace = (
  chunks: AsyncIterable<ChromiumTraceChunk>, pendingPath: string, signal: AbortSignal,
) => Promise<void>;

type TraceCapture =
  | { status: "written"; recordingStartedAtMs: number; recordingStoppedAtMs: number }
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" }
  | { status: "failed" };

type TraceOptions = {
  wallNow?: () => number;
  monotonicNow?: () => number;
  bufferSizeKb?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
};

type ActiveRecording = {
  session: ChromiumTraceSession;
  release: () => void;
  wallMs: number;
  monotonicMs: number;
};

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Chromium tracing timed out");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Chromium allows one owned trace. Keep it armed while a renderer can still
 * capture, including while it is flushing its final CPU profile. */
export class ChromiumTrace {
  private readonly renderers = new Set<object>();
  private queue: Promise<unknown> = Promise.resolve();
  private recording: ActiveRecording | undefined;
  private unsubscribeNative: (() => void) | undefined;
  private readonly onNativeReleased = () => { void this.enqueue(() => this.reconcile()); };

  constructor(
    private readonly createSession: () => ChromiumTraceSession,
    private readonly publish: PublishChromiumTrace,
    private readonly warn: (message: string) => void,
    private readonly options: TraceOptions = {},
  ) {}

  arm(renderer: object): Promise<void> {
    this.renderers.add(renderer);
    return this.enqueue(() => this.reconcile());
  }

  release(renderer: object): Promise<void> {
    if (!this.renderers.delete(renderer)) return Promise.resolve();
    return this.enqueue(() => this.reconcile());
  }

  capture(renderer: object, filePath: string, triggerMonotonicMs: number): Promise<TraceCapture> {
    return this.enqueue(async () => {
      const recording = this.recording;
      if (!this.renderers.has(renderer) || !recording) {
        return { status: "skipped", reason: "not-recording" };
      }
      if (triggerMonotonicMs <= recording.monotonicMs) {
        return { status: "skipped", reason: "trigger-predates-recording" };
      }
      const recordingStoppedAtMs = this.options.wallNow?.() ?? Date.now();
      const pendingPath = `${filePath}.tmp`;
      try {
        await withDeadline(
          (signal) => this.publish(recording.session.read(signal), pendingPath, signal),
          this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
        );
        await fs.rename(pendingPath, filePath);
        return { status: "written", recordingStartedAtMs: recording.wallMs, recordingStoppedAtMs };
      } catch {
        // Protocol and parse errors can contain private input.
        this.warn("Could not save Chromium trace");
        return { status: "failed" };
      } finally {
        this.discard();
        await fs.rm(pendingPath, { force: true }).catch(() => {
          this.warn("Could not remove pending Chromium trace");
        });
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async reconcile(): Promise<void> {
    this.unsubscribeNative?.();
    this.unsubscribeNative = undefined;
    if (this.renderers.size === 0) {
      this.discard();
      return;
    }
    if (this.recording) return;

    const release = tryAcquireChromiumTrace();
    if (!release) {
      this.unsubscribeNative = onChromiumTraceReleased(this.onNativeReleased);
      return;
    }
    let session: ChromiumTraceSession | undefined;
    try {
      const owned = this.createSession();
      session = owned;
      await withDeadline(() => owned.start({
        recordMode: "recordContinuously",
        traceBufferSizeInKb: this.options.bufferSizeKb ?? TRACE_BUFFER_KB,
        includedCategories: [...TRACE_CATEGORIES],
        excludedCategories: ["*"],
      }), this.options.startTimeoutMs ?? START_TIMEOUT_MS);
      this.recording = {
        session: owned, release,
        wallMs: this.options.wallNow?.() ?? Date.now(),
        monotonicMs: this.options.monotonicNow?.() ?? performance.now(),
      };
    } catch {
      this.dispose(session, release);
      this.warn("Could not arm Chromium trace");
    }
  }

  private discard(): void {
    const recording = this.recording;
    this.recording = undefined;
    if (recording) this.dispose(recording.session, recording.release);
  }

  private dispose(session: ChromiumTraceSession | undefined, release: () => void): void {
    try {
      session?.dispose();
    } catch {
      this.warn("Could not dispose Chromium trace session");
    } finally {
      release();
    }
  }
}
