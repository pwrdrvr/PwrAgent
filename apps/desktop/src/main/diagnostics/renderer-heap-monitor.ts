import path from "node:path";
import type { HeapMonitorConfig } from "./heap-monitor-config";
import type { HeapSession, HeapSessionEvent, HeapSessionSample } from "./heap-session";
import { getMainLogger } from "../log";

const CHROME_DEBUGGER_PROTOCOL_VERSION = "1.3";
const defaultHeapLogger = getMainLogger("pwragent:heap");

type RendererHeapUsage = {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
};

type RendererHeapDebugger = {
  attach: (version: string) => void;
  detach: () => void;
  isAttached: () => boolean;
  sendCommand: (method: string) => Promise<RendererHeapUsage>;
  on: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
  off?: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
};

type RendererHeapTarget = {
  debugger: RendererHeapDebugger;
  takeHeapSnapshot: (filePath: string) => Promise<void>;
  isDestroyed?: () => boolean;
};

type Logger = Pick<Console, "info" | "warn" | "error">;

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createSnapshotFilename(index: number): string {
  return `heap-${String(index).padStart(4, "0")}.heapsnapshot`;
}

export class RendererHeapMonitor {
  private readonly detachListener = (_event: unknown, reason: string) => {
    this.debuggerAttached = false;
    this.pauseSampling();
    void this.appendEvent({
      source: "renderer",
      capturedAt: this.now().toISOString(),
      type: "debugger-detached",
      detail: { reason },
    });
    this.logger.warn("[pwragent:heap] debugger detached", {
      reason,
      sessionDirectory: this.session.directoryPath,
    });
  };

  private readonly config: Extract<HeapMonitorConfig, { enabled: true }>;
  private readonly logger: Logger;
  private readonly session: HeapSession;
  private readonly target: RendererHeapTarget;
  private readonly now: () => Date;

  private previousSample: HeapSessionSample | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private paused = false;
  private debuggerAttached = false;
  private snapshotInFlight = false;
  private snapshotCount = 0;
  private lastSnapshotAtMs: number | null = null;

  constructor(options: {
    target: RendererHeapTarget;
    session: HeapSession;
    config: Extract<HeapMonitorConfig, { enabled: true }>;
    logger?: Logger;
    now?: () => Date;
  }) {
    this.config = options.config;
    this.logger = options.logger ?? defaultHeapLogger;
    this.session = options.session;
    this.target = options.target;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      if (!this.target.debugger.isAttached()) {
        this.target.debugger.attach(CHROME_DEBUGGER_PROTOCOL_VERSION);
      }
      this.debuggerAttached = true;
      this.target.debugger.on("detach", this.detachListener);
      await this.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "monitor-started",
        detail: {
          sessionDirectory: this.session.directoryPath,
          intervalMs: this.config.intervalMs,
          deltaThresholdBytes: this.config.deltaThresholdBytes,
        },
      });
      this.logger.info("[pwragent:heap] monitoring started", {
        sessionDirectory: this.session.directoryPath,
        intervalMs: this.config.intervalMs,
        settleDelayMs: this.config.settleDelayMs,
        deltaThresholdBytes: this.config.deltaThresholdBytes,
      });

      if (this.config.settleDelayMs === 0) {
        await this.beginMonitoring();
        return;
      }

      this.settleTimer = setTimeout(() => {
        void this.beginMonitoring();
      }, this.config.settleDelayMs);
    } catch (error) {
      await this.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "monitor-start-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("[pwragent:heap] monitoring failed to start", error);
      this.pauseSampling();
    }
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.pauseSampling();
    const targetDestroyed = this.isTargetDestroyed();
    if (!targetDestroyed) {
      try {
        if (this.target.debugger.off) {
          this.target.debugger.off("detach", this.detachListener);
        }
        if (this.debuggerAttached && this.target.debugger.isAttached()) {
          this.target.debugger.detach();
        }
      } catch (error) {
        if (!this.isDestroyedError(error)) {
          throw error;
        }

        this.logger.warn("[pwragent:heap] renderer target destroyed during stop", {
          reason,
          sessionDirectory: this.session.directoryPath,
        });
      }
    }
    this.debuggerAttached = false;

    await this.appendEvent({
      source: "renderer",
      capturedAt: this.now().toISOString(),
      type: "monitor-stopped",
      detail: { reason },
    });
    this.logger.info("[pwragent:heap] monitoring stopped", {
      reason,
      sessionDirectory: this.session.directoryPath,
    });
  }

  private async beginMonitoring(): Promise<void> {
    if (this.stopped || this.paused) {
      return;
    }

    this.settleTimer = null;
    await this.captureSample(true);
    this.scheduleNextSample();
  }

  private scheduleNextSample(): void {
    if (this.stopped || this.paused) {
      return;
    }

    this.intervalTimer = setTimeout(() => {
      void this.runScheduledSample();
    }, this.config.intervalMs);
  }

  private async runScheduledSample(): Promise<void> {
    this.intervalTimer = null;

    if (this.stopped || this.paused) {
      return;
    }

    await this.captureSample(false);
    this.scheduleNextSample();
  }

  private async captureSample(forceBaseline: boolean): Promise<void> {
    const capturedAt = this.now().toISOString();

    try {
      const heapUsage = await this.target.debugger.sendCommand("Runtime.getHeapUsage");
      const previousUsedSize = this.previousSample?.usedSize ?? null;
      const deltaBytes =
        previousUsedSize === null ? null : heapUsage.usedSize - previousUsedSize;
      const isBaseline = forceBaseline || this.previousSample === null;
      const sample: HeapSessionSample = {
        source: "renderer",
        capturedAt,
        usedSize: heapUsage.usedSize,
        totalSize: heapUsage.totalSize,
        embedderHeapUsedSize: heapUsage.embedderHeapUsedSize,
        backingStorageSize: heapUsage.backingStorageSize,
        isBaseline,
        deltaBytes,
      };

      await this.session.appendSample(sample);
      this.previousSample = sample;

      if (
        !isBaseline &&
        deltaBytes !== null &&
        deltaBytes >= this.config.deltaThresholdBytes
      ) {
        await this.handleThresholdCrossing(sample, deltaBytes);
      }
    } catch (error) {
      await this.appendEvent({
        source: "renderer",
        capturedAt,
        type: "sample-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("[pwragent:heap] heap sample failed", error);
    }
  }

  private async handleThresholdCrossing(
    sample: HeapSessionSample,
    deltaBytes: number,
  ): Promise<void> {
    if (this.snapshotInFlight) {
      await this.logSnapshotSkip("in-flight", deltaBytes, sample.capturedAt);
      return;
    }

    if (this.snapshotCount >= this.config.maxSnapshots) {
      await this.logSnapshotSkip("max-snapshots", deltaBytes, sample.capturedAt);
      return;
    }

    const nowMs = Date.parse(sample.capturedAt);
    if (
      this.lastSnapshotAtMs !== null &&
      nowMs - this.lastSnapshotAtMs < this.config.snapshotCooldownMs
    ) {
      await this.logSnapshotSkip("cooldown", deltaBytes, sample.capturedAt);
      return;
    }

    const snapshotIndex = this.snapshotCount + 1;
    const filename = createSnapshotFilename(snapshotIndex);
    const filePath = path.join(this.session.directoryPath, filename);
    this.snapshotInFlight = true;
    void this.captureSnapshot({
      capturedAt: sample.capturedAt,
      deltaBytes,
      filename,
      filePath,
    });
  }

  private async captureSnapshot(options: {
    capturedAt: string;
    deltaBytes: number;
    filename: string;
    filePath: string;
  }): Promise<void> {
    await this.appendEvent({
      source: "renderer",
      capturedAt: options.capturedAt,
      type: "snapshot-triggered",
      detail: {
        filename: options.filename,
        deltaBytes: options.deltaBytes,
      },
    });
    this.logger.warn("[pwragent:heap] capturing heap snapshot", {
      filename: options.filename,
      deltaBytes: options.deltaBytes,
      sessionDirectory: this.session.directoryPath,
    });

    try {
      await this.target.takeHeapSnapshot(options.filePath);
      this.snapshotCount += 1;
      this.lastSnapshotAtMs = Date.parse(options.capturedAt);
      await this.session.registerSnapshotFile(options.filename);
      await this.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "snapshot-completed",
        detail: {
          filename: options.filename,
        },
      });
    } catch (error) {
      await this.appendEvent({
        source: "renderer",
        capturedAt: this.now().toISOString(),
        type: "snapshot-failed",
        detail: {
          filename: options.filename,
          error: serializeError(error),
        },
      });
      this.logger.error("[pwragent:heap] heap snapshot failed", error);
    } finally {
      this.snapshotInFlight = false;
    }
  }

  private async logSnapshotSkip(
    reason: "cooldown" | "in-flight" | "max-snapshots",
    deltaBytes: number,
    capturedAt: string,
  ): Promise<void> {
    await this.appendEvent({
      source: "renderer",
      capturedAt,
      type: "snapshot-skipped",
      detail: {
        reason,
        deltaBytes,
      },
    });
  }

  private pauseSampling(): void {
    this.paused = true;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private isTargetDestroyed(): boolean {
    return typeof this.target.isDestroyed === "function" && this.target.isDestroyed();
  }

  private isDestroyedError(error: unknown): boolean {
    return serializeError(error).includes("Object has been destroyed");
  }

  private async appendEvent(event: HeapSessionEvent): Promise<void> {
    await this.session.appendEvent(event);
  }
}
