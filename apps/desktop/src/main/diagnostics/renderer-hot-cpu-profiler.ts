import fs from "node:fs/promises";
import path from "node:path";
import type { ProcessMetric } from "electron";
import type {
  HotCpuProfileCapturedEvent,
  HotCpuProfileHeapSnapshotArtifact,
} from "../../shared/hot-cpu-profile";
import type { HotCpuProfileConfig } from "./hot-cpu-profile-config";
import type { HotCpuProfileSession } from "./hot-cpu-profile-session";
import { getMainLogger } from "../log";

const CHROME_DEBUGGER_PROTOCOL_VERSION = "1.3";

type Logger = Pick<Console, "info" | "warn" | "error">;

type RendererDebugger = {
  attach: (version: string) => void;
  detach: () => void;
  isAttached: () => boolean;
  sendCommand: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  on: (
    event: "detach",
    listener: (event: unknown, reason: string) => void,
  ) => void;
  off?: (
    event: "detach",
    listener: (event: unknown, reason: string) => void,
  ) => void;
};

type RendererHotCpuTarget = {
  debugger: RendererDebugger;
  getOSProcessId: () => number;
  isDestroyed?: () => boolean;
  takeHeapSnapshot?: (filePath: string) => Promise<void>;
};

type CpuUsageReading = {
  cpuPercent: number;
  electronCpuPercent: number;
  cumulativeCpuDeltaSeconds?: number;
  wallDeltaSeconds?: number;
};

type ActiveProfileTrigger = Pick<
  HotCpuProfileCapturedEvent,
  | "triggerConsecutiveSamples"
  | "triggerCpuPercent"
  | "triggerMode"
  | "triggerThresholdPercent"
>;

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactFilename(filePath: string): string {
  return path.basename(filePath);
}

export class RendererHotCpuProfiler {
  private readonly detachListener = (_event: unknown, reason: string) => {
    this.debuggerAttached = false;
    void this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "debugger-detached",
      detail: { reason },
    });
    this.logger.warn("[pwragent:hot-cpu] renderer debugger detached", {
      reason,
      sessionDirectory: this.session.directoryPath,
    });
  };

  private readonly config: Extract<HotCpuProfileConfig, { enabled: true }>;
  private readonly getAppMetrics: () => ProcessMetric[];
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly onHeapSnapshotLimitReached?: () => void | Promise<void>;
  private readonly onProfileWritten?: (
    event: HotCpuProfileCapturedEvent,
  ) => void | Promise<void>;
  private readonly session: HotCpuProfileSession;
  private readonly target: RendererHotCpuTarget;

  private consecutiveHotSamples = 0;
  private debuggerAttached = false;
  private heapSnapshotLimitReached = false;
  private heapSnapshotsCaptured = 0;
  private heapSnapshotMidTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProfileAtMs: number | null = null;
  private previousCumulativeCpuSeconds: number | null = null;
  private previousSampleAtMs: number | null = null;
  private profileDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private profileCount = 0;
  private stopProfilePromise: Promise<void> | null = null;
  private profiling = false;
  private samplingPausedForProfile = false;
  private activeProfileTrigger: ActiveProfileTrigger | null = null;
  private activeProfileHeapSnapshots: HotCpuProfileHeapSnapshotArtifact[] = [];
  private activeProfileHeapSnapshotCaptures = new Set<Promise<void>>();
  private stopped = false;

  constructor(options: {
    config: Extract<HotCpuProfileConfig, { enabled: true }>;
    getAppMetrics: () => ProcessMetric[];
    session: HotCpuProfileSession;
    target: RendererHotCpuTarget;
    logger?: Logger;
    now?: () => Date;
    onHeapSnapshotLimitReached?: () => void | Promise<void>;
    onProfileWritten?: (
      event: HotCpuProfileCapturedEvent,
    ) => void | Promise<void>;
  }) {
    this.config = options.config;
    this.getAppMetrics = options.getAppMetrics;
    this.logger = options.logger ?? getMainLogger("pwragent:hot-cpu");
    this.now = options.now ?? (() => new Date());
    this.onHeapSnapshotLimitReached = options.onHeapSnapshotLimitReached;
    this.onProfileWritten = options.onProfileWritten;
    this.session = options.session;
    this.target = options.target;
  }

  async start(): Promise<void> {
    if (this.stopped || this.intervalTimer) {
      return;
    }

    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "monitor-started",
      detail: {
        intervalMs: this.config.intervalMs,
        startDelayMs: this.config.startDelayMs,
        triggerMode: this.config.triggerMode,
        thresholdPercent: this.config.thresholdPercent,
        slowburnThresholdPercent: this.config.slowburnThresholdPercent,
        consecutiveSamples: this.config.consecutiveSamples,
        profileDurationMs: this.config.profileDurationMs,
        captureHeapSnapshot: this.config.captureHeapSnapshot,
        heapSnapshotLimit: this.config.heapSnapshotLimit,
      },
    });
    this.logger.info("[pwragent:hot-cpu] monitoring started", {
      sessionDirectory: this.session.directoryPath,
      startDelayMs: this.config.startDelayMs,
      triggerMode: this.config.triggerMode,
      thresholdPercent: this.config.thresholdPercent,
      slowburnThresholdPercent: this.config.slowburnThresholdPercent,
      profileDurationMs: this.config.profileDurationMs,
    });
    this.scheduleNextSample(this.config.startDelayMs);
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();

    if (this.profiling || this.stopProfilePromise) {
      await this.stopProfile(reason);
    }

    this.detachDebugger();
    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "monitor-stopped",
      detail: { reason },
    });
  }

  private scheduleNextSample(delayMs = this.config.intervalMs): void {
    if (this.stopped) {
      return;
    }

    this.intervalTimer = setTimeout(() => this.captureSample(), delayMs);
  }

  private async captureSample(): Promise<void> {
    this.intervalTimer = null;

    if (this.stopped || this.isTargetDestroyed()) {
      return;
    }

    const capturedAtDate = this.now();
    const capturedAt = capturedAtDate.toISOString();
    const capturedAtMs = capturedAtDate.getTime();
    try {
      const pid = this.target.getOSProcessId();
      const metric = this.getAppMetrics().find(
        (candidate) => candidate.pid === pid,
      );
      if (!metric) {
        await this.session.appendEvent({
          capturedAt,
          type: "sample-skipped",
          detail: { reason: "metric-not-found", pid },
        });
        this.scheduleNextSample();
        return;
      }

      const cumulativeCpuSeconds = metric.cpu.cumulativeCPUUsage;
      const cpuUsage = this.calculateCpuUsage({
        capturedAtMs,
        cumulativeCpuSeconds,
        electronCpuPercent: metric.cpu.percentCPUUsage,
      });
      const cpuPercent = cpuUsage.cpuPercent;
      const triggerThresholdPercent = this.triggerThresholdPercent();
      this.consecutiveHotSamples =
        cpuPercent >= triggerThresholdPercent
          ? this.consecutiveHotSamples + 1
          : 0;

      await this.session.appendSample({
        capturedAt,
        pid,
        cpuPercent,
        electronCpuPercent: cpuUsage.electronCpuPercent,
        ...(cpuUsage.cumulativeCpuDeltaSeconds !== undefined
          ? { cumulativeCpuDeltaSeconds: cpuUsage.cumulativeCpuDeltaSeconds }
          : {}),
        ...(cumulativeCpuSeconds !== undefined ? { cumulativeCpuSeconds } : {}),
        ...(cpuUsage.wallDeltaSeconds !== undefined
          ? { wallDeltaSeconds: cpuUsage.wallDeltaSeconds }
          : {}),
        idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
        workingSetSize: metric.memory.workingSetSize,
        peakWorkingSetSize: metric.memory.peakWorkingSetSize,
        consecutiveHotSamples: this.consecutiveHotSamples,
      });

      if (this.shouldStartProfile(cpuPercent, capturedAt)) {
        await this.startProfile({
          capturedAt,
          cpuPercent,
          pid,
        });
      }
    } catch (error) {
      await this.session.appendEvent({
        capturedAt,
        type: "sample-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("[pwragent:hot-cpu] sample failed", error);
    } finally {
      if (!this.profiling) {
        this.scheduleNextSample();
      } else {
        this.samplingPausedForProfile = true;
      }
    }
  }

  private calculateCpuUsage(options: {
    capturedAtMs: number;
    cumulativeCpuSeconds?: number;
    electronCpuPercent: number;
  }): CpuUsageReading {
    if (options.cumulativeCpuSeconds === undefined) {
      this.previousCumulativeCpuSeconds = null;
      this.previousSampleAtMs = null;
      return {
        cpuPercent: options.electronCpuPercent,
        electronCpuPercent: options.electronCpuPercent,
      };
    }

    const previousCumulativeCpuSeconds = this.previousCumulativeCpuSeconds;
    const previousSampleAtMs = this.previousSampleAtMs;
    this.previousCumulativeCpuSeconds = options.cumulativeCpuSeconds;
    this.previousSampleAtMs = options.capturedAtMs;

    if (previousCumulativeCpuSeconds === null || previousSampleAtMs === null) {
      return {
        cpuPercent: options.electronCpuPercent,
        electronCpuPercent: options.electronCpuPercent,
      };
    }

    const cumulativeCpuDeltaSeconds =
      options.cumulativeCpuSeconds - previousCumulativeCpuSeconds;
    const wallDeltaSeconds =
      (options.capturedAtMs - previousSampleAtMs) / 1_000;
    if (cumulativeCpuDeltaSeconds < 0 || wallDeltaSeconds <= 0) {
      return {
        cpuPercent: options.electronCpuPercent,
        electronCpuPercent: options.electronCpuPercent,
      };
    }

    return {
      cpuPercent: (cumulativeCpuDeltaSeconds / wallDeltaSeconds) * 100,
      electronCpuPercent: options.electronCpuPercent,
      cumulativeCpuDeltaSeconds,
      wallDeltaSeconds,
    };
  }

  private shouldStartProfile(cpuPercent: number, capturedAt: string): boolean {
    if (this.profiling || cpuPercent < this.triggerThresholdPercent()) {
      return false;
    }

    if (this.consecutiveHotSamples < this.triggerConsecutiveSamples()) {
      return false;
    }

    if (this.profileCount >= this.config.maxProfiles) {
      return false;
    }

    const capturedAtMs = Date.parse(capturedAt);
    return (
      this.lastProfileAtMs === null
      || capturedAtMs - this.lastProfileAtMs >= this.config.cooldownMs
    );
  }

  private triggerThresholdPercent(): number {
    return this.config.triggerMode === "slowburn"
      ? this.config.slowburnThresholdPercent
      : this.config.thresholdPercent;
  }

  private triggerConsecutiveSamples(): number {
    return this.config.triggerMode === "spike"
      ? 1
      : this.config.consecutiveSamples;
  }

  private async startProfile(options: {
    capturedAt: string;
    cpuPercent: number;
    pid: number;
  }): Promise<void> {
    if (this.target.debugger.isAttached()) {
      await this.session.appendEvent({
        capturedAt: options.capturedAt,
        type: "profile-skipped",
        detail: {
          reason: "debugger-already-attached",
          cpuPercent: options.cpuPercent,
          pid: options.pid,
        },
      });
      return;
    }

    try {
      this.target.debugger.attach(CHROME_DEBUGGER_PROTOCOL_VERSION);
      this.debuggerAttached = true;
      this.target.debugger.on("detach", this.detachListener);
      await this.target.debugger.sendCommand("Profiler.enable");
      await this.target.debugger.sendCommand("Profiler.start");
      this.profiling = true;
      this.activeProfileHeapSnapshots = [];
      this.activeProfileTrigger = {
        triggerConsecutiveSamples: this.triggerConsecutiveSamples(),
        triggerCpuPercent: options.cpuPercent,
        triggerMode: this.config.triggerMode,
        triggerThresholdPercent: this.triggerThresholdPercent(),
      };
      this.profileCount += 1;
      const index = this.profileCount;
      this.lastProfileAtMs = Date.parse(options.capturedAt);
      await this.session.appendEvent({
        capturedAt: options.capturedAt,
        type: "profile-started",
        detail: {
          index,
          cpuPercent: options.cpuPercent,
          triggerMode: this.config.triggerMode,
          triggerThresholdPercent: this.triggerThresholdPercent(),
          triggerConsecutiveSamples: this.triggerConsecutiveSamples(),
          pid: options.pid,
          durationMs: this.config.profileDurationMs,
        },
      });
      this.logger.warn("[pwragent:hot-cpu] CPU profile started", {
        cpuPercent: options.cpuPercent,
        pid: options.pid,
        sessionDirectory: this.session.directoryPath,
      });

      if (this.config.captureHeapSnapshot && this.target.takeHeapSnapshot) {
        await this.captureHeapSnapshot(index, "start");
        if (this.stopped || !this.profiling) {
          return;
        }
        this.scheduleMidProfileHeapSnapshot(index);
      }

      if (this.stopped || !this.profiling) {
        return;
      }
      this.profileDurationTimer = setTimeout(
        () => this.stopProfile("duration-elapsed"),
        this.config.profileDurationMs,
      );
    } catch (error) {
      this.activeProfileTrigger = null;
      this.profiling = false;
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-start-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error(
        "[pwragent:hot-cpu] CPU profile failed to start",
        error,
      );
      this.detachDebugger();
    }
  }

  private async stopProfile(reason: string): Promise<void> {
    if (this.stopProfilePromise) {
      await this.stopProfilePromise;
      return;
    }

    if (!this.profiling) {
      return;
    }

    this.stopProfilePromise = this.stopProfileInner(reason);
    try {
      await this.stopProfilePromise;
    } finally {
      this.stopProfilePromise = null;
    }
  }

  private async stopProfileInner(reason: string): Promise<void> {
    this.profiling = false;
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();
    const index = this.profileCount;
    const profilePath = this.session.createProfilePath(index);
    const profileFilename = artifactFilename(profilePath);
    const activeProfileTrigger = this.activeProfileTrigger ?? {
      triggerConsecutiveSamples: this.triggerConsecutiveSamples(),
      triggerCpuPercent: 0,
      triggerMode: this.config.triggerMode,
      triggerThresholdPercent: this.triggerThresholdPercent(),
    };

    try {
      const result = (await this.target.debugger.sendCommand(
        "Profiler.stop",
      )) as {
        profile?: unknown;
      };
      await fs.writeFile(
        profilePath,
        `${JSON.stringify(result.profile ?? {}, null, 2)}\n`,
        "utf8",
      );
      await this.session.registerArtifact(profileFilename);
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-written",
        detail: {
          filename: profileFilename,
          reason,
        },
      });

      if (
        !this.stopped
        && this.config.captureHeapSnapshot
        && this.target.takeHeapSnapshot
      ) {
        await this.drainActiveHeapSnapshotCaptures();
        await this.captureHeapSnapshot(index, "stop");
      }
      await this.drainActiveHeapSnapshotCaptures();
      await this.onProfileWritten?.({
        capturedAt: this.now().toISOString(),
        heapSnapshotArtifacts: [...this.activeProfileHeapSnapshots],
        profileFilename,
        profilePath,
        sessionDirectory: this.session.directoryPath,
        sessionDirectoryName: this.session.directoryName,
        ...activeProfileTrigger,
      });
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-stop-failed",
        detail: {
          filename: profileFilename,
          reason,
          error: serializeError(error),
        },
      });
      this.logger.error("[pwragent:hot-cpu] CPU profile failed to stop", error);
    } finally {
      this.activeProfileTrigger = null;
      this.activeProfileHeapSnapshots = [];
      this.activeProfileHeapSnapshotCaptures.clear();
      this.detachDebugger();
      this.resumeSamplingAfterProfile();
    }
  }

  private resumeSamplingAfterProfile(): void {
    if (!this.samplingPausedForProfile) {
      return;
    }

    this.samplingPausedForProfile = false;
    this.previousCumulativeCpuSeconds = null;
    this.previousSampleAtMs = null;
    if (this.stopped || this.intervalTimer || this.isTargetDestroyed()) {
      return;
    }

    this.scheduleNextSample();
  }

  private async captureHeapSnapshot(
    index: number,
    phase: string,
  ): Promise<void> {
    const capture = this.writeHeapSnapshot(index, phase);
    if (index === this.profileCount) {
      this.activeProfileHeapSnapshotCaptures.add(capture);
    }

    try {
      await capture;
    } finally {
      this.activeProfileHeapSnapshotCaptures.delete(capture);
    }
  }

  private async writeHeapSnapshot(index: number, phase: string): Promise<void> {
    if (!this.target.takeHeapSnapshot) {
      return;
    }

    if (this.heapSnapshotsCaptured >= this.config.heapSnapshotLimit) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-skipped",
        detail: {
          index,
          phase,
          reason: "limit-reached",
          limit: this.config.heapSnapshotLimit,
        },
      });
      await this.notifyHeapSnapshotLimitReached();
      return;
    }

    const snapshotNumber = this.heapSnapshotsCaptured + 1;
    this.heapSnapshotsCaptured = snapshotNumber;
    const snapshotPath = this.session.createHeapSnapshotPath(index, phase);
    const snapshotFilename = artifactFilename(snapshotPath);
    try {
      await this.target.takeHeapSnapshot(snapshotPath);
      await this.session.registerArtifact(snapshotFilename);
      if (index === this.profileCount) {
        this.activeProfileHeapSnapshots.push({
          filename: snapshotFilename,
          path: snapshotPath,
          phase,
        });
      }
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-written",
        detail: {
          filename: snapshotFilename,
          index,
          phase,
          snapshotNumber,
          limit: this.config.heapSnapshotLimit,
        },
      });
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-failed",
        detail: {
          filename: snapshotFilename,
          index,
          phase,
          snapshotNumber,
          limit: this.config.heapSnapshotLimit,
          error: serializeError(error),
        },
      });
      this.logger.error("[pwragent:hot-cpu] heap snapshot failed", error);
    } finally {
      if (this.heapSnapshotsCaptured >= this.config.heapSnapshotLimit) {
        await this.notifyHeapSnapshotLimitReached();
      }
    }
  }

  private async drainActiveHeapSnapshotCaptures(): Promise<void> {
    while (this.activeProfileHeapSnapshotCaptures.size > 0) {
      await Promise.all([...this.activeProfileHeapSnapshotCaptures]);
    }
  }

  private scheduleMidProfileHeapSnapshot(index: number): void {
    if (
      !this.config.captureHeapSnapshot
      || !this.target.takeHeapSnapshot
      || this.config.heapSnapshotLimit < 3
      || this.heapSnapshotLimitReached
    ) {
      return;
    }

    this.clearHeapSnapshotMidTimer();
    this.heapSnapshotMidTimer = setTimeout(
      () => {
        this.heapSnapshotMidTimer = null;
        void this.captureHeapSnapshot(index, "mid");
      },
      Math.max(1, Math.floor(this.config.profileDurationMs / 2)),
    );
  }

  private async notifyHeapSnapshotLimitReached(): Promise<void> {
    if (this.heapSnapshotLimitReached) {
      return;
    }

    this.heapSnapshotLimitReached = true;
    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "heap-snapshot-limit-reached",
      detail: {
        captured: this.heapSnapshotsCaptured,
        limit: this.config.heapSnapshotLimit,
      },
    });

    try {
      await this.onHeapSnapshotLimitReached?.();
    } catch (error) {
      this.logger.warn("[pwragent:hot-cpu] heap snapshot auto-disable failed", {
        error: serializeError(error),
        sessionDirectory: this.session.directoryPath,
      });
    }
  }

  private detachDebugger(): void {
    if (this.isTargetDestroyed()) {
      this.debuggerAttached = false;
      return;
    }

    try {
      if (this.target.debugger.off) {
        this.target.debugger.off("detach", this.detachListener);
      }

      if (!this.debuggerAttached || !this.target.debugger.isAttached()) {
        return;
      }

      this.target.debugger.detach();
      this.debuggerAttached = false;
    } catch (error) {
      this.debuggerAttached = false;
      this.logger.warn("[pwragent:hot-cpu] renderer debugger detach failed", {
        error: serializeError(error),
        sessionDirectory: this.session.directoryPath,
      });
    }
  }

  private isTargetDestroyed(): boolean {
    return Boolean(this.target.isDestroyed?.());
  }

  private clearProfileDurationTimer(): void {
    if (!this.profileDurationTimer) {
      return;
    }

    clearTimeout(this.profileDurationTimer);
    this.profileDurationTimer = null;
  }

  private clearHeapSnapshotMidTimer(): void {
    if (!this.heapSnapshotMidTimer) {
      return;
    }

    clearTimeout(this.heapSnapshotMidTimer);
    this.heapSnapshotMidTimer = null;
  }
}
