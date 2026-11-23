import fs from "node:fs/promises";
import path from "node:path";
import type { Profiler } from "node:inspector";
import type { ProcessMetric } from "electron";
import type {
  HotCpuProfileCapturedEvent,
  HotCpuProfileHeapSnapshotArtifact,
  HotCpuRuleMatch,
} from "../../../shared/hot-cpu-profile";
import type { HotCpuProfileConfig } from "../../diagnostics/hot-cpu-profile-config";
import type { HotCpuProfileSession } from "../../diagnostics/hot-cpu-profile-session";
import type { AppCpuEstimate, AppMetricsReading } from "./app-metrics";
import { HotCpuRuleEvaluator, isCpuSampleInterval, type CpuInterval } from "../../diagnostics/hot-cpu-rule-evaluator";
import type { ChromiumTrace, TraceCapture } from "../../diagnostics/chromium-trace";
import { getMainLogger } from "../../log";
import { joinCpuProfiles } from "../../diagnostics/cpu-profile-history";
import { acquireDebuggerLease, type DebuggerLease } from "../../diagnostics/debugger-lease";

// Rotate only after evaluating the CPU sample, and retain the last complete
// window as well as the live one. A burst across a rotation stays available.
const RECORDING_WINDOW_MS = 30_000;

type Logger = Pick<Console, "info" | "warn" | "error">;
import type { HotCpuTarget } from "../../diagnostics/hot-cpu-target";
export type { HotCpuTarget } from "../../diagnostics/hot-cpu-target";


type CpuUsageReading = {
  cpuPercent: number;
  electronCpuPercent: number;
  cumulativeCpuDeltaSeconds?: number;
  recorderRotationCpuSeconds?: number;
  interval?: CpuInterval;
  wallDeltaSeconds?: number;
};

type ActiveProfileTrigger = Pick<
  HotCpuProfileCapturedEvent,
  | "matchedRules"
  | "triggerConsecutiveSamples"
  | "triggerCpuPercent"
  | "triggerMode"
  | "triggerThresholdPercent"
>;
type ProfileTriggerTime = { capturedAt: string; monotonicMs: number };
type ProfileCommandTime = { requestedAtMs: number; acknowledgedAtMs: number };
type ActiveChromiumTrace = { path: string; triggeredAt: string; result: Promise<TraceCapture> };

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactFilename(filePath: string): string {
  return path.basename(filePath);
}

function capturedProfileTiming(
  profile: Profiler.Profile,
  trigger: ProfileTriggerTime | undefined,
  start: ProfileCommandTime,
  stop: ProfileCommandTime,
): Record<string, unknown> {
  if (!trigger) return {};
  const triggeredAt = trigger.capturedAt;
  const profileDurationMs = (profile.endTime - profile.startTime) / 1_000;
  if (!Number.isFinite(profileDurationMs) || profileDurationMs < 0) return { triggeredAt };

  // V8 and the app can use different monotonic clock origins. Use V8's
  // elapsed recording time to narrow the app's start-command bounds.
  const earliestStartMs = Math.max(start.requestedAtMs, stop.requestedAtMs - profileDurationMs);
  const latestStartMs = Math.min(start.acknowledgedAtMs, stop.acknowledgedAtMs - profileDurationMs);
  if (earliestStartMs > latestStartMs) {
    // The clocks may account for suspend differently. Keep the raw duration
    // without mapping it to the app's trigger timestamp.
    return { triggeredAt, profileDurationMs };
  }
  const recordingStartMs = (earliestStartMs + latestStartMs) / 2;
  const preTriggerDurationMs = trigger.monotonicMs - recordingStartMs;
  return {
    triggeredAt,
    profileDurationMs,
    recordingStartedAt: new Date(Date.parse(triggeredAt) - preTriggerDurationMs).toISOString(),
    preTriggerDurationMs,
    recordingStartUncertaintyMs: Math.max(
      recordingStartMs - start.requestedAtMs,
      start.acknowledgedAtMs - recordingStartMs,
    ),
  };
}

export class HotCpuProfiler {
  private readonly detachListener = (_event: unknown, reason: string) => {
    this.target.debugger.off?.("detach", this.detachListener);
    this.debuggerLease = undefined;
    this.recording = false;
    this.previousRecording = null;
    void this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "debugger-detached",
      detail: { reason },
    });
    this.logger.warn("[pwragent:hot-cpu] target debugger detached", {
      reason,
      target: this.session.target ?? "renderer",
      sessionDirectory: this.session.directoryPath,
    });
  };

  private config: Extract<HotCpuProfileConfig, { enabled: true }>;
  private readonly chromiumTrace?: ChromiumTrace;
  private readonly getAppMetrics: () => ProcessMetric[] | AppMetricsReading;
  private readonly sampleNow: () => number;
  private evaluator: HotCpuRuleEvaluator;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly onHeapSnapshotLimitReached?: () => void | Promise<void>;
  private readonly onSampleCaptured?: () => void;
  private readonly onProfileWritten?: (
    event: HotCpuProfileCapturedEvent,
  ) => void | Promise<void>;
  private readonly session: HotCpuProfileSession;
  private readonly target: HotCpuTarget;

  private startPromise: Promise<void> | null = null;
  private recording = false;
  private recordingStart: ProfileCommandTime = { requestedAtMs: 0, acknowledgedAtMs: 0 };
  private previousRecording: { profile: Profiler.Profile; start: ProfileCommandTime } | null = null;
  private ruleRevision = 0;
  private hasSampled = false;
  private debuggerLease: DebuggerLease | undefined;
  private heapSnapshotLimitReached = false;
  private heapSnapshotsCaptured = 0;
  private heapSnapshotMidTimer: ReturnType<typeof setTimeout> | null = null;
  private captureSamplePromise: Promise<void> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProfileAtMs: number | null = null;
  private previousMetric?: {
    pid: number;
    creationTime: number;
    atMs: number;
    cumulative?: number;
    estimate?: AppCpuEstimate;
  };
  private recorderRotationCpuMicros = 0;
  private profileDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private profileCount = 0;
  private shutdownPromise: Promise<void> | null = null;
  private stopProfilePromise: Promise<void> | null = null;
  private profiling = false;
  private samplingPausedForProfile = false;
  private activeProfileTrigger: ActiveProfileTrigger | null = null;
  private activeProfileTime: ProfileTriggerTime | undefined;
  private activeChromiumTrace: ActiveChromiumTrace | undefined;
  private activeProfileHeapSnapshots: HotCpuProfileHeapSnapshotArtifact[] = [];
  private activeProfileHeapSnapshotCaptures = new Set<Promise<void>>();
  private stopped = false;
  private listingDiagnosticsEnabled = false;

  constructor(options: {
    config: Extract<HotCpuProfileConfig, { enabled: true }>;
    chromiumTrace?: ChromiumTrace;
    getAppMetrics: () => ProcessMetric[] | AppMetricsReading;
    sampleNow?: () => number;
    session: HotCpuProfileSession;
    target: HotCpuTarget;
    logger?: Logger;
    now?: () => Date;
    onHeapSnapshotLimitReached?: () => void | Promise<void>;
    onProfileWritten?: (event: HotCpuProfileCapturedEvent) => void | Promise<void>;
    /**
     * Fires once per completed sampling iteration, after the sample has been
     * written and any profile it triggered has started.
     *
     * The loop is a self-rescheduling timer whose body awaits real disk
     * writes, so it publishes no progress an observer can wait on. Without
     * this, a test can only poll on a wall-clock budget and hope the machine
     * is fast enough — which is exactly how this suite flaked on loaded CI
     * while passing locally. Unused in production.
     */
    onSampleCaptured?: () => void;
  }) {
    this.config = options.config;
    this.evaluator = new HotCpuRuleEvaluator(options.config.rules, options.config.intervalMs);
    this.sampleNow = options.sampleNow ?? (() => performance.now());
    this.chromiumTrace = options.chromiumTrace;
    this.getAppMetrics = options.getAppMetrics;
    this.logger = options.logger ?? getMainLogger("pwragent:hot-cpu");
    this.now = options.now ?? (() => new Date());
    this.onHeapSnapshotLimitReached = options.onHeapSnapshotLimitReached;
    this.onProfileWritten = options.onProfileWritten;
    this.onSampleCaptured = options.onSampleCaptured;
    this.session = options.session;
    this.target = options.target;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.startPromise ??= this.startInner();
    await this.startPromise;
  }

  get hasActiveProfile(): boolean {
    return this.profiling || this.stopProfilePromise !== null;
  }

  async rearmListingDiagnostics(): Promise<void> {
    if (!this.startPromise || this.stopped) return;
    await this.startPromise;
    // The new document has its own ring even though the monitor survived.
    if (!this.stopped) await this.setListingDiagnosticsEnabled(true, true);
  }

  updateRules(config: Extract<HotCpuProfileConfig, { enabled: true }>): void {
    if (this.stopped || (this.config.intervalMs === config.intervalMs
      && JSON.stringify(this.config.rules) === JSON.stringify(config.rules))) return;
    this.config = config;
    this.ruleRevision += 1;
    this.resetSampleBaseline();
    this.evaluator = new HotCpuRuleEvaluator(config.rules, config.intervalMs);
    if (this.hasSampled && this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.scheduleNextSample();
    }
    void this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "rules-updated",
      detail: { intervalMs: config.intervalMs, rules: config.rules },
    }).catch((error: unknown) => this.logger.warn("[pwragent:hot-cpu] failed to record rule update", error));
  }

  private async startInner(): Promise<void> {
    const startedAt = this.now();
    await this.session.appendEvent({
      capturedAt: startedAt.toISOString(),
      type: "monitor-started",
      detail: {
        intervalMs: this.config.intervalMs,
        startDelayMs: this.config.startDelayMs,
        rules: this.config.rules,
        triggerMode: this.config.triggerMode,
        thresholdPercent: this.config.thresholdPercent,
        slowburnThresholdPercent: this.config.slowburnThresholdPercent,
        consecutiveSamples: this.config.consecutiveSamples,
        profileDurationMs: this.config.profileDurationMs,
        captureHeapSnapshot: this.config.captureHeapSnapshot,
        heapSnapshotLimit: this.config.heapSnapshotLimit,
        recordingWindowMs: this.recordingWindowMs(),
        cpuProfileSamplingIntervalUs: this.target.cpuProfileSamplingIntervalUs,
      },
    });
    await this.ensureRecording(startedAt.getTime());
    if (!this.stopped) await this.chromiumTrace?.arm(this);
    await this.setListingDiagnosticsEnabled(true);
    this.logger.info("[pwragent:hot-cpu] monitoring started", {
      target: this.session.target ?? "renderer",
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
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.stopped = true;
    this.shutdownPromise = this.stopInner(reason).finally(async () => {
      await this.chromiumTrace?.release(this);
      await this.setListingDiagnosticsEnabled(false);
    });
    await this.shutdownPromise;
  }

  private async setListingDiagnosticsEnabled(enabled: boolean, rearm = false): Promise<void> {
    if (!rearm && this.listingDiagnosticsEnabled === enabled) return;
    this.listingDiagnosticsEnabled = enabled;
    try {
      await this.target.setListingDiagnosticsEnabled?.(enabled);
    } catch {
      // Optional diagnostics cannot prevent monitor startup or shutdown.
      this.logger.warn("[pwragent:hot-cpu] listing diagnostics state unavailable");
    }
  }

  private async stopInner(reason: string): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();

    // Stop an already-started profile in parallel with its owning sample so a
    // blocked heap snapshot cannot deadlock shutdown. Recheck after the sample
    // settles in case it crossed into profiling while shutdown was starting.
    const captureSamplePromise = this.captureSamplePromise;
    const activeProfileStop = this.hasActiveProfile ? this.stopProfile(reason) : null;
    await Promise.all([captureSamplePromise, activeProfileStop]);

    if (this.hasActiveProfile) {
      await this.stopProfile(reason);
    }

    // An armed recorder without a trigger is discarded, never published.
    await this.discardRecording();
    await this.setListingDiagnosticsEnabled(false);
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

    this.intervalTimer = setTimeout(() => {
      const captureSamplePromise = this.captureSample();
      this.captureSamplePromise = captureSamplePromise;
      void captureSamplePromise.then(
        () => {
          if (this.captureSamplePromise === captureSamplePromise) {
            this.captureSamplePromise = null;
          }
        },
        (error) => {
          if (this.captureSamplePromise === captureSamplePromise) {
            this.captureSamplePromise = null;
          }
          this.logger.error("[pwragent:hot-cpu] sample task failed", error);
        },
      );
    }, delayMs);
  }

  private async captureSample(): Promise<void> {
    this.intervalTimer = null;

    if (this.stopped || this.isTargetDestroyed()) {
      return;
    }

    const capturedAtDate = this.now();
    const capturedAt = capturedAtDate.toISOString();
    const capturedAtMs = capturedAtDate.getTime();
    const revision = this.ruleRevision;
    this.hasSampled = true;
    try {
      const pid = this.target.getOSProcessId();
      const reading = this.getAppMetrics();
      const capturedAtMonotonicMs = Array.isArray(reading) ? this.sampleNow() : reading.capturedAtMs;
      const metrics = Array.isArray(reading) ? reading : reading.metrics;
      const metric = metrics.find((candidate) => candidate.pid === pid);
      if (!metric) {
        this.resetSampleBaseline();
        await this.session.appendEvent({
          capturedAt,
          type: "sample-skipped",
          detail: { reason: "metric-not-found", pid },
        });
        await this.maintainRecording(capturedAtMs);
        return;
      }

      const cumulativeCpuSeconds = metric.cpu.cumulativeCPUUsage;
      const cpuUsage = this.calculateCpuUsage(
        metric,
        capturedAtMonotonicMs,
        Array.isArray(reading) ? undefined : reading.cpuEstimates.get(pid),
        Array.isArray(reading),
      );
      const matches = this.evaluator.observe(cpuUsage.interval);

      await this.session.appendSample({
        capturedAt,
        pid,
        cpuPercent: cpuUsage.cpuPercent,
        cpuMeasurementSource: cpuUsage.interval?.source ?? "baseline",
        ...this.target.readHeapUsage?.(),
        electronCpuPercent: cpuUsage.electronCpuPercent,
        ...(cpuUsage.cumulativeCpuDeltaSeconds !== undefined
          ? { cumulativeCpuDeltaSeconds: cpuUsage.cumulativeCpuDeltaSeconds }
          : {}),
        ...(cumulativeCpuSeconds !== undefined
          ? { cumulativeCpuSeconds }
          : {}),
        ...(cpuUsage.recorderRotationCpuSeconds !== undefined
          ? { recorderRotationCpuSeconds: cpuUsage.recorderRotationCpuSeconds }
          : {}),
        ...(cpuUsage.wallDeltaSeconds !== undefined
          ? { wallDeltaSeconds: cpuUsage.wallDeltaSeconds }
          : {}),
        idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
        workingSetSize: metric.memory.workingSetSize,
        peakWorkingSetSize: metric.memory.peakWorkingSetSize,
        consecutiveHotSamples: this.evaluator.hotSampleCount(this.config.triggerMode),
      });

      if (revision === this.ruleRevision && matches.length > 0 && this.shouldStartProfile(capturedAtMs)) {
        await this.startProfile({
          capturedAt,
          capturedAtMonotonicMs,
          matches,
          pid,
        });
      } else if (!this.stopped && this.profileCount < this.config.maxProfiles) {
        await this.maintainRecording(capturedAtMs);
      }
    } catch (error) {
      this.resetSampleBaseline();
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
      // After rescheduling, so an observer woken here already sees the next
      // timer armed and can assert on timer state without a second wait.
      this.onSampleCaptured?.();
    }
  }

  private resetSampleBaseline(): void {
    this.previousMetric = undefined;
    this.recorderRotationCpuMicros = 0;
    this.evaluator.reset();
  }

  private calculateCpuUsage(
    metric: ProcessMetric,
    atMs: number,
    estimate: AppCpuEstimate | undefined,
    dedicatedReader: boolean,
  ): CpuUsageReading {
    const { cumulativeCPUUsage, percentCPUUsage } = metric.cpu;
    const cumulative = Number.isFinite(cumulativeCPUUsage) ? cumulativeCPUUsage : undefined;
    const previous = this.previousMetric;
    this.previousMetric = { pid: metric.pid, creationTime: metric.creationTime, atMs, cumulative, estimate };
    const recorderRotationCpuSeconds = this.recorderRotationCpuMicros / 1_000_000;
    this.recorderRotationCpuMicros = 0;
    const baseline = { cpuPercent: percentCPUUsage, electronCpuPercent: percentCPUUsage };
    if (previous?.pid !== metric.pid || previous.creationTime !== metric.creationTime) return baseline;
    const elapsedMs = atMs - previous.atMs;
    if (!isCpuSampleInterval(elapsedMs, this.config.intervalMs)) return baseline;
    const wallDeltaSeconds = elapsedMs / 1_000;
    if (cumulative === undefined && previous.cumulative === undefined) {
      const prior = previous.estimate;
      // Only a dedicated reader owns the raw interval. The shared reader
      // can reconstruct the whole interval from a continuous estimate.
      const cpuPercent = dedicatedReader ? percentCPUUsage
        : estimate && prior?.generation === estimate.generation
          ? (estimate.cpuMs - prior.cpuMs) / elapsedMs * 100
          : undefined;
      if (cpuPercent === undefined || !Number.isFinite(cpuPercent) || cpuPercent < 0) return baseline;
      return {
        ...baseline,
        cpuPercent,
        wallDeltaSeconds,
        interval: { cpuPercent, elapsedMs, source: "electron-interval" },
      };
    }
    if (cumulative === undefined || previous.cumulative === undefined || cumulative < previous.cumulative) {
      return baseline;
    }
    const cumulativeCpuDeltaSeconds = cumulative - previous.cumulative;
    // The process counter and thread counter can have different granularity.
    const applicationCpuDeltaSeconds = Math.max(0, cumulativeCpuDeltaSeconds - recorderRotationCpuSeconds);
    const cpuPercent = (applicationCpuDeltaSeconds / wallDeltaSeconds) * 100;
    return {
      cpuPercent,
      electronCpuPercent: percentCPUUsage,
      cumulativeCpuDeltaSeconds,
      recorderRotationCpuSeconds: recorderRotationCpuSeconds || undefined,
      wallDeltaSeconds,
      interval: { cpuPercent, elapsedMs, source: "cumulative" },
    };
  }

  private shouldStartProfile(atMs: number): boolean {
    return !this.stopped && !this.hasActiveProfile
      && this.profileCount < this.config.maxProfiles
      && (this.lastProfileAtMs === null || atMs - this.lastProfileAtMs >= this.config.cooldownMs);
  }

  private recordingWindowMs(): number {
    return Math.max(RECORDING_WINDOW_MS, ...this.config.rules.map((rule) =>
      Math.max(rule.durationMs, rule.sampleCount * this.config.intervalMs)));
  }

  private async maintainRecording(startedAtMs: number): Promise<void> {
    await this.ensureRecording(startedAtMs);
    if (
      this.recording
      && performance.now() - this.recordingStart.acknowledgedAtMs >= this.recordingWindowMs()
    ) {
      await this.rotateRecording();
    }
  }

  private async ensureRecording(startedAtMs: number): Promise<void> {
    if (
      this.stopped
      || this.recording
      || this.isTargetDestroyed()
      || this.target.isDevToolsOpened?.()
      || this.profileCount >= this.config.maxProfiles
    ) return;
    try {
      if (!this.debuggerLease) {
        this.debuggerLease = acquireDebuggerLease(this.target.debugger, "Profiler");
        this.target.debugger.on("detach", this.detachListener);
      }
      await this.target.debugger.sendCommand("Profiler.enable");
      if (this.stopped) return;
      const interval = this.target.cpuProfileSamplingIntervalUs;
      if (interval !== undefined) {
        await this.target.debugger.sendCommand("Profiler.setSamplingInterval", { interval });
        if (this.stopped) return;
      }
      await this.startRecording();
    } catch (error) {
      this.recording = false;
      this.previousRecording = null;
      this.detachDebugger();
      await this.session.appendEvent({
        capturedAt: new Date(startedAtMs).toISOString(),
        type: "recorder-start-failed",
        detail: { error: serializeError(error) },
      });
    }
  }

  private sendRecordingCommand(method: "Profiler.start" | "Profiler.stop", rotating: boolean): Promise<unknown> {
    const readCpuMicros = this.target.readProfilerThreadCpuMicros;
    if (!rotating || !readCpuMicros) return this.target.debugger.sendCommand(method);

    // Session.post dispatches and decodes the response inline. Measure only
    // that thread and end the measurement before yielding to other JS work.
    const before = this.tryReadThreadCpuMicros(readCpuMicros);
    if (before === undefined) return this.target.debugger.sendCommand(method);
    try {
      return this.target.debugger.sendCommand(method);
    } finally {
      const after = this.tryReadThreadCpuMicros(readCpuMicros);
      if (after !== undefined) {
        // Windows libuv's thread CPU counter can wrap at 24 CPU-hours.
        this.recorderRotationCpuMicros += Math.max(0, after - before);
      }
    }
  }

  private tryReadThreadCpuMicros(readCpuMicros: () => number): number | undefined {
    try {
      return readCpuMicros();
    } catch {
      // An unavailable OS counter should only affect sample accounting.
      return undefined;
    }
  }

  private async startRecording(rotating = false): Promise<void> {
    const requestedAtMs = performance.now();
    await this.sendRecordingCommand("Profiler.start", rotating);
    if (!this.debuggerLease?.valid || this.isTargetDestroyed()) throw new Error("CPU recorder target lost");
    this.recording = true;
    this.recordingStart = { requestedAtMs, acknowledgedAtMs: performance.now() };
  }

  private async finishRecording(rotating = false): Promise<Profiler.Profile> {
    if (!this.recording) throw new Error("CPU recorder is not armed");
    const result = await this.sendRecordingCommand("Profiler.stop", rotating) as {
      profile: Profiler.Profile;
    };
    this.recording = false;
    return result.profile;
  }

  private async rotateRecording(): Promise<void> {
    try {
      const profile = await this.finishRecording(true);
      this.previousRecording = { profile, start: this.recordingStart };
      if (this.stopped) return;
      await this.startRecording(true);
    } catch (error) {
      this.recording = false;
      this.previousRecording = null;
      this.detachDebugger();
      throw error;
    }
  }

  private async discardRecording(): Promise<void> {
    try {
      if (this.recording && !this.isTargetDestroyed()) await this.finishRecording();
    } catch (error) {
      this.logger.warn("[pwragent:hot-cpu] recorder cleanup failed", error);
    } finally {
      this.recording = false;
      this.previousRecording = null;
    }
  }

  private async startProfile(options: {
    capturedAt: string;
    capturedAtMonotonicMs: number;
    matches: HotCpuRuleMatch[];
    pid: number;
  }): Promise<void> {
    if (this.stopped) {
      return;
    }

    const [primary] = options.matches;
    if (!this.recording) {
      // A debugger conflict may have prevented arming. Do not describe a
      // newly started recording as if it had captured this hot interval.
      await this.session.appendEvent({
        capturedAt: options.capturedAt,
        type: "profile-skipped",
        detail: {
          reason: !this.isTargetDestroyed() && this.target.debugger.isAttached()
            ? "debugger-already-attached"
            : "recorder-not-armed",
          cpuPercent: primary.triggerCpuPercent,
          pid: options.pid,
        },
      });
      await this.ensureRecording(Date.parse(options.capturedAt));
      return;
    }

    try {
      this.profiling = true;
      if (this.stopped) {
        return;
      }
      this.activeProfileHeapSnapshots = [];
      this.activeProfileTime = { capturedAt: options.capturedAt, monotonicMs: options.capturedAtMonotonicMs };
      this.activeProfileTrigger = {
        matchedRules: options.matches,
        triggerConsecutiveSamples: primary.sampleCount,
        triggerCpuPercent: primary.triggerCpuPercent,
        triggerMode: primary.id,
        triggerThresholdPercent: primary.thresholdPercent,
      };
      this.profileCount += 1;
      const index = this.profileCount;
      // Stop the rolling trace while it still contains the interval that
      // tripped the CPU rule. V8 continues recording its own post-trigger tail.
      this.activeChromiumTrace = this.captureChromiumTrace(index, this.activeProfileTime);
      this.lastProfileAtMs = Date.parse(options.capturedAt);
      await this.session.appendEvent({
        capturedAt: options.capturedAt,
        type: "profile-started",
        detail: {
          index,
          cpuPercent: primary.triggerCpuPercent,
          ...this.activeProfileTrigger,
          pid: options.pid,
          durationMs: this.config.profileDurationMs,
        },
      });
      this.logger.warn("[pwragent:hot-cpu] CPU profile started", {
        cpuPercent: primary.triggerCpuPercent,
        matchedRules: options.matches,
        pid: options.pid,
        target: this.session.target ?? "renderer",
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
      await this.discardChromiumTrace(this.activeChromiumTrace);
      this.activeChromiumTrace = undefined;
      this.activeProfileTrigger = null;
      this.activeProfileTime = undefined;
      this.profiling = false;
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-start-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("[pwragent:hot-cpu] CPU profile failed to start", error);
      await this.discardRecording();
      this.detachDebugger();
      if (this.profileCount >= this.config.maxProfiles) await this.chromiumTrace?.release(this);
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

  private async writeDiagnostics(profilePath: string): Promise<void> {
    if (!this.target.readDiagnostics) return;
    const diagnosticsPath = profilePath.replace(/\.cpuprofile$/, ".diagnostics.json");
    try {
      await fs.writeFile(
        diagnosticsPath,
        `${JSON.stringify(await this.target.readDiagnostics())}\n`,
        "utf8",
      );
      await this.session.registerArtifact(artifactFilename(diagnosticsPath));
    } catch (error) {
      // Auxiliary accounting must never prevent delivery of the CPU profile.
      this.logger.warn("[pwragent:hot-cpu] auxiliary diagnostics failed", error);
    }
  }

  private captureChromiumTrace(index: number, trigger: ProfileTriggerTime): ActiveChromiumTrace | undefined {
    if (!this.chromiumTrace) return;
    const tracePath = this.session.createProfilePath(index).replace(/\.cpuprofile$/, ".trace.json");
    const result = this.chromiumTrace.capture(this, tracePath, trigger.monotonicMs).catch((): TraceCapture => ({
      status: "failed", phase: "publish", category: "io",
    }));
    return { path: tracePath, triggeredAt: trigger.capturedAt, result };
  }

  private async discardChromiumTrace(trace: ActiveChromiumTrace | undefined): Promise<void> {
    if (trace && (await trace.result).status === "written") {
      await fs.rm(trace.path, { force: true }).catch(() => {
        this.logger.warn("[pwragent:hot-cpu] Could not remove unregistered Chromium trace");
      });
    }
  }

  private async writeChromiumTrace(trace: ActiveChromiumTrace | undefined): Promise<string | undefined> {
    if (!trace) return;
    const filename = artifactFilename(trace.path);
    const result = await trace.result;
    try {
      if (result.status === "written") await this.session.registerArtifact(filename);
    } catch {
      await this.discardChromiumTrace(trace);
      this.logger.warn("[pwragent:hot-cpu] Chromium trace registration failed");
      return;
    }
    try {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: `chromium-trace-${result.status}`,
        detail: { filename, triggeredAt: trace.triggeredAt, ...result },
      });
    } catch {
      this.logger.warn("[pwragent:hot-cpu] Chromium trace bookkeeping failed");
    }
    return result.status === "written" ? trace.path : undefined;
  }

  private async stopProfileInner(reason: string): Promise<void> {
    this.profiling = false;
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();
    const index = this.profileCount;
    const trace = this.activeChromiumTrace;
    let profileRegistered = false;
    const profilePath = this.session.createProfilePath(index);
    const profileFilename = artifactFilename(profilePath);
    const activeProfileTrigger =
      this.activeProfileTrigger ?? {
        triggerConsecutiveSamples: this.config.rules[0].sampleCount,
        triggerCpuPercent: 0,
        triggerMode: this.config.triggerMode,
        triggerThresholdPercent: this.config.rules[0].thresholdPercent,
      };

    try {
      const requestedAtMs = performance.now();
      const current = await this.finishRecording();
      const stop = { requestedAtMs, acknowledgedAtMs: performance.now() };
      const profile = joinCpuProfiles(this.previousRecording
        ? [this.previousRecording.profile, current]
        : [current]);
      const timing = capturedProfileTiming(
        profile,
        this.activeProfileTime,
        this.previousRecording?.start ?? this.recordingStart,
        stop,
      );
      await fs.writeFile(
        profilePath,
        `${JSON.stringify(profile)}\n`,
        "utf8",
      );
      await this.session.registerArtifact(profileFilename);
      profileRegistered = true;
      const chromiumTracePath = await this.writeChromiumTrace(trace);
      await this.writeDiagnostics(profilePath);
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-written",
        detail: {
          filename: profileFilename,
          reason,
          ...activeProfileTrigger,
          ...timing,
        },
      });

      if (
        !this.stopped &&
        this.config.captureHeapSnapshot &&
        this.target.takeHeapSnapshot
      ) {
        await this.drainActiveHeapSnapshotCaptures();
        await this.captureHeapSnapshot(index, "stop");
      }
      await this.drainActiveHeapSnapshotCaptures();
      await this.onProfileWritten?.({
        capturedAt: this.now().toISOString(),
        ...(chromiumTracePath ? { chromiumTracePath } : {}),
        heapSnapshotArtifacts: [...this.activeProfileHeapSnapshots],
        profileFilename,
        profilePath,
        target: this.session.target ?? "renderer",
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
      if (!profileRegistered) await this.discardChromiumTrace(trace);
      this.activeProfileTrigger = null;
      this.activeProfileTime = undefined;
      this.activeChromiumTrace = undefined;
      this.activeProfileHeapSnapshots = [];
      this.activeProfileHeapSnapshotCaptures.clear();
      this.previousRecording = null;
      this.recording = false;
      this.detachDebugger();
      if (!this.stopped && this.profileCount < this.config.maxProfiles) {
        await this.chromiumTrace?.arm(this);
      } else {
        await this.chromiumTrace?.release(this);
      }
      await this.ensureRecording(this.now().getTime());
      this.resumeSamplingAfterProfile();
    }
  }

  private resumeSamplingAfterProfile(): void {
    if (!this.samplingPausedForProfile) {
      return;
    }

    this.samplingPausedForProfile = false;
    this.resetSampleBaseline();
    if (this.stopped || this.intervalTimer || this.isTargetDestroyed()) {
      return;
    }

    this.scheduleNextSample();
  }

  private async captureHeapSnapshot(index: number, phase: string): Promise<void> {
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
      !this.config.captureHeapSnapshot ||
      !this.target.takeHeapSnapshot ||
      this.config.heapSnapshotLimit < 3 ||
      this.heapSnapshotLimitReached
    ) {
      return;
    }

    this.clearHeapSnapshotMidTimer();
    this.heapSnapshotMidTimer = setTimeout(() => {
      this.heapSnapshotMidTimer = null;
      void this.captureHeapSnapshot(index, "mid");
    }, Math.max(1, Math.floor(this.config.profileDurationMs / 2)));
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
        target: this.session.target ?? "renderer",
        sessionDirectory: this.session.directoryPath,
      });
    }
  }

  private detachDebugger(): void {
    try {
      this.target.debugger.off?.("detach", this.detachListener);
      this.debuggerLease?.release(this.isTargetDestroyed());
    } catch (error) {
      this.logger.warn("[pwragent:hot-cpu] target debugger detach failed", {
        error: serializeError(error),
        target: this.session.target ?? "renderer",
        sessionDirectory: this.session.directoryPath,
      });
    } finally {
      this.debuggerLease = undefined;
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
