import fs from "node:fs/promises";
import path from "node:path";
import type { ProcessMetric } from "electron";
import type { HotCpuProfileConfig } from "./hot-cpu-profile-config";
import type { HotCpuProfileSession } from "./hot-cpu-profile-session";
import { getMainLogger } from "../log";

const CHROME_DEBUGGER_PROTOCOL_VERSION = "1.3";

type Logger = Pick<Console, "info" | "warn" | "error">;

type RendererDebugger = {
  attach: (version: string) => void;
  detach: () => void;
  isAttached: () => boolean;
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
  off?: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
};

type RendererHotCpuTarget = {
  debugger: RendererDebugger;
  getOSProcessId: () => number;
  isDestroyed?: () => boolean;
  takeHeapSnapshot?: (filePath: string) => Promise<void>;
};

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
  private readonly session: HotCpuProfileSession;
  private readonly target: RendererHotCpuTarget;

  private consecutiveHotSamples = 0;
  private debuggerAttached = false;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProfileAtMs: number | null = null;
  private profileDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private profileCount = 0;
  private profiling = false;
  private stopped = false;

  constructor(options: {
    config: Extract<HotCpuProfileConfig, { enabled: true }>;
    getAppMetrics: () => ProcessMetric[];
    session: HotCpuProfileSession;
    target: RendererHotCpuTarget;
    logger?: Logger;
    now?: () => Date;
  }) {
    this.config = options.config;
    this.getAppMetrics = options.getAppMetrics;
    this.logger = options.logger ?? getMainLogger("pwragent:hot-cpu");
    this.now = options.now ?? (() => new Date());
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
        thresholdPercent: this.config.thresholdPercent,
        consecutiveSamples: this.config.consecutiveSamples,
        profileDurationMs: this.config.profileDurationMs,
      },
    });
    this.logger.info("[pwragent:hot-cpu] monitoring started", {
      sessionDirectory: this.session.directoryPath,
      thresholdPercent: this.config.thresholdPercent,
      profileDurationMs: this.config.profileDurationMs,
    });
    this.scheduleNextSample();
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

    if (this.profiling) {
      await this.stopProfile(reason);
    }

    this.detachDebugger();
    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "monitor-stopped",
      detail: { reason },
    });
  }

  private scheduleNextSample(): void {
    if (this.stopped) {
      return;
    }

    this.intervalTimer = setTimeout(() => this.captureSample(), this.config.intervalMs);
  }

  private async captureSample(): Promise<void> {
    this.intervalTimer = null;

    if (this.stopped || this.isTargetDestroyed()) {
      return;
    }

    const capturedAt = this.now().toISOString();
    try {
      const pid = this.target.getOSProcessId();
      const metric = this.getAppMetrics().find((candidate) => candidate.pid === pid);
      if (!metric) {
        await this.session.appendEvent({
          capturedAt,
          type: "sample-skipped",
          detail: { reason: "metric-not-found", pid },
        });
        this.scheduleNextSample();
        return;
      }

      const cpuPercent = metric.cpu.percentCPUUsage;
      this.consecutiveHotSamples =
        cpuPercent >= this.config.thresholdPercent
          ? this.consecutiveHotSamples + 1
          : 0;

      await this.session.appendSample({
        capturedAt,
        pid,
        cpuPercent,
        cumulativeCpuSeconds: metric.cpu.cumulativeCPUUsage,
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
      this.scheduleNextSample();
    }
  }

  private shouldStartProfile(cpuPercent: number, capturedAt: string): boolean {
    if (this.profiling || cpuPercent < this.config.thresholdPercent) {
      return false;
    }

    if (this.consecutiveHotSamples < this.config.consecutiveSamples) {
      return false;
    }

    if (this.profileCount >= this.config.maxProfiles) {
      return false;
    }

    const capturedAtMs = Date.parse(capturedAt);
    return (
      this.lastProfileAtMs === null ||
      capturedAtMs - this.lastProfileAtMs >= this.config.cooldownMs
    );
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
      this.profileCount += 1;
      this.lastProfileAtMs = Date.parse(options.capturedAt);
      await this.session.appendEvent({
        capturedAt: options.capturedAt,
        type: "profile-started",
        detail: {
          index: this.profileCount,
          cpuPercent: options.cpuPercent,
          pid: options.pid,
          durationMs: this.config.profileDurationMs,
        },
      });
      this.logger.warn("[pwragent:hot-cpu] CPU profile started", {
        cpuPercent: options.cpuPercent,
        pid: options.pid,
        sessionDirectory: this.session.directoryPath,
      });

      this.profileDurationTimer = setTimeout(
        () => this.stopProfile("duration-elapsed"),
        this.config.profileDurationMs,
      );
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-start-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("[pwragent:hot-cpu] CPU profile failed to start", error);
      this.detachDebugger();
    }
  }

  private async stopProfile(reason: string): Promise<void> {
    if (!this.profiling) {
      return;
    }

    this.profiling = false;
    this.clearProfileDurationTimer();
    const index = this.profileCount;
    const profilePath = this.session.createProfilePath(index);
    const profileFilename = artifactFilename(profilePath);

    try {
      const result = (await this.target.debugger.sendCommand("Profiler.stop")) as {
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

      if (this.config.captureHeapSnapshot && this.target.takeHeapSnapshot) {
        await this.captureHeapSnapshot(index);
      }
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
      this.detachDebugger();
    }
  }

  private async captureHeapSnapshot(index: number): Promise<void> {
    if (!this.target.takeHeapSnapshot) {
      return;
    }

    const snapshotPath = this.session.createHeapSnapshotPath(index);
    const snapshotFilename = artifactFilename(snapshotPath);
    try {
      await this.target.takeHeapSnapshot(snapshotPath);
      await this.session.registerArtifact(snapshotFilename);
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-written",
        detail: { filename: snapshotFilename },
      });
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-failed",
        detail: {
          filename: snapshotFilename,
          error: serializeError(error),
        },
      });
      this.logger.error("[pwragent:hot-cpu] heap snapshot failed", error);
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
}
