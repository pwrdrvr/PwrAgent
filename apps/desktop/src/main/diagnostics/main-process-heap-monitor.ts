import path from "node:path";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
import type { HeapMonitorConfig } from "./heap-monitor-config";
import type { HeapSession, HeapSessionEvent, HeapSessionSample } from "./heap-session";
import { getMainLogger } from "../log";

const defaultHeapLogger = getMainLogger("pwragent:heap");

type Logger = Pick<Console, "info" | "warn" | "error">;

type MainProcessHeapReading = {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  heapSizeLimit: number;
  totalPhysicalSize: number;
  totalAvailableSize: number;
  mallocedMemory: number;
  peakMallocedMemory: number;
};

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createSnapshotFilename(index: number): string {
  return `main-heap-${String(index).padStart(4, "0")}.heapsnapshot`;
}

function readMainProcessHeap(): MainProcessHeapReading {
  const memoryUsage = process.memoryUsage();
  const heapStatistics = getHeapStatistics();

  return {
    heapUsed: memoryUsage.heapUsed,
    heapTotal: memoryUsage.heapTotal,
    rss: memoryUsage.rss,
    external: memoryUsage.external,
    arrayBuffers: memoryUsage.arrayBuffers,
    heapSizeLimit: heapStatistics.heap_size_limit,
    totalPhysicalSize: heapStatistics.total_physical_size,
    totalAvailableSize: heapStatistics.total_available_size,
    mallocedMemory: heapStatistics.malloced_memory,
    peakMallocedMemory: heapStatistics.peak_malloced_memory,
  };
}

export class MainProcessHeapMonitor {
  private readonly config: Extract<HeapMonitorConfig, { enabled: true }>;
  private readonly logger: Logger;
  private readonly session: HeapSession;
  private readonly now: () => Date;
  private readonly readHeap: () => MainProcessHeapReading;
  private readonly writeSnapshot: (filePath: string) => string;

  private previousSample: HeapSessionSample | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private paused = false;
  private snapshotInFlight = false;
  private snapshotCount = 0;
  private lastSnapshotAtMs: number | null = null;

  constructor(options: {
    session: HeapSession;
    config: Extract<HeapMonitorConfig, { enabled: true }>;
    logger?: Logger;
    now?: () => Date;
    readHeap?: () => MainProcessHeapReading;
    writeSnapshot?: (filePath: string) => string;
  }) {
    this.config = options.config;
    this.logger = options.logger ?? defaultHeapLogger;
    this.session = options.session;
    this.now = options.now ?? (() => new Date());
    this.readHeap = options.readHeap ?? readMainProcessHeap;
    this.writeSnapshot = options.writeSnapshot ?? writeHeapSnapshot;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      await this.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "monitor-started",
        detail: {
          sessionDirectory: this.session.directoryPath,
          intervalMs: this.config.intervalMs,
          settleDelayMs: this.config.settleDelayMs,
          deltaThresholdBytes: this.config.deltaThresholdBytes,
        },
      });
      this.logger.info("main monitoring started", {
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
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "monitor-start-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("main monitoring failed to start", error);
      this.pauseSampling();
    }
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.pauseSampling();

    await this.appendEvent({
      source: "main",
      capturedAt: this.now().toISOString(),
      type: "monitor-stopped",
      detail: { reason },
    });
    this.logger.info("main monitoring stopped", {
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
      const reading = this.readHeap();
      const previousUsedSize = this.previousSample?.usedSize ?? null;
      const deltaBytes = previousUsedSize === null ? null : reading.heapUsed - previousUsedSize;
      const isBaseline = forceBaseline || this.previousSample === null;
      const sample: HeapSessionSample = {
        source: "main",
        capturedAt,
        usedSize: reading.heapUsed,
        totalSize: reading.heapTotal,
        rss: reading.rss,
        external: reading.external,
        arrayBuffers: reading.arrayBuffers,
        heapSizeLimit: reading.heapSizeLimit,
        totalPhysicalSize: reading.totalPhysicalSize,
        totalAvailableSize: reading.totalAvailableSize,
        mallocedMemory: reading.mallocedMemory,
        peakMallocedMemory: reading.peakMallocedMemory,
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
        source: "main",
        capturedAt,
        type: "sample-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("main heap sample failed", error);
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
      source: "main",
      capturedAt: options.capturedAt,
      type: "snapshot-triggered",
      detail: {
        filename: options.filename,
        deltaBytes: options.deltaBytes,
      },
    });
    this.logger.warn("capturing main heap snapshot", {
      filename: options.filename,
      deltaBytes: options.deltaBytes,
      sessionDirectory: this.session.directoryPath,
    });

    try {
      const writtenPath = await Promise.resolve(this.writeSnapshot(options.filePath));
      const writtenFilename = path.basename(writtenPath);
      this.snapshotCount += 1;
      this.lastSnapshotAtMs = Date.parse(options.capturedAt);
      await this.session.registerSnapshotFile(writtenFilename);
      await this.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "snapshot-completed",
        detail: {
          filename: writtenFilename,
        },
      });
    } catch (error) {
      await this.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "snapshot-failed",
        detail: {
          filename: options.filename,
          error: serializeError(error),
        },
      });
      this.logger.error("main heap snapshot failed", error);
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
      source: "main",
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

  private async appendEvent(event: HeapSessionEvent): Promise<void> {
    await this.session.appendEvent(event);
  }
}
