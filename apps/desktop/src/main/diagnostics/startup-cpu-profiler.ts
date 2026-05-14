import { app, type BrowserWindow } from "electron";
import path from "node:path";
import { getMainLogger } from "../log";
import { analyzeStartupCpuProfileSession } from "./startup-cpu-analysis";
import {
  MainProcessCpuProfiler,
} from "./main-process-cpu-profiler";
import {
  RendererStartupCpuProfiler,
} from "./renderer-startup-cpu-profiler";
import {
  createStartupCpuProfileSession,
  type StartupCpuProfileSession,
  type StartupCpuProfileSessionCreateResult,
} from "./startup-cpu-profile-session";
import {
  resolveStartupCpuProfileConfig,
  type StartupCpuProfileConfig,
} from "./startup-cpu-profile-config";

type Logger = Pick<Console, "info" | "warn" | "error">;

type MainProfiler = {
  start: () => Promise<boolean>;
  stop: (reason?: string) => Promise<boolean>;
};

type RendererProfiler = {
  start: () => Promise<boolean>;
  stop: (reason?: string) => Promise<boolean>;
};

type WindowTarget = Pick<BrowserWindow, "on" | "webContents">;

type EnabledStartupCpuProfileConfig = Extract<StartupCpuProfileConfig, { enabled: true }>;

type CreateStartupCpuProfileSession = (options: {
  config: EnabledStartupCpuProfileConfig;
  createdAt?: Date;
  sessionId?: string;
  versions: {
    appVersion: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion: string;
  };
}) => Promise<StartupCpuProfileSessionCreateResult>;

type CreateMainProfiler = (session: StartupCpuProfileSession) => MainProfiler;

type CreateRendererProfiler = (
  session: StartupCpuProfileSession,
  target: WindowTarget["webContents"],
) => RendererProfiler;

type AnalyzeStartupCpuProfileSession = (options: {
  sessionDirectoryPath: string;
  repoRoot: string;
  analysisPath: string;
  summaryPath: string;
}) => Promise<unknown>;

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function resolveRepoRoot(): string {
  return path.resolve(app.getAppPath(), "../..");
}

export class StartupCpuProfiler {
  private readonly config: StartupCpuProfileConfig;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly createSession: CreateStartupCpuProfileSession;
  private readonly createMainProfiler: CreateMainProfiler;
  private readonly createRendererProfiler: CreateRendererProfiler;
  private readonly analyzeSession: AnalyzeStartupCpuProfileSession;

  private session?: StartupCpuProfileSession;
  private mainProfiler?: MainProfiler;
  private rendererProfiler?: RendererProfiler;
  private attachedWindow = false;
  private postLoadStopTimer?: ReturnType<typeof setTimeout>;
  private hardTimeoutTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(options?: {
    config?: StartupCpuProfileConfig;
    logger?: Logger;
    now?: () => Date;
    createSession?: CreateStartupCpuProfileSession;
    createMainProfiler?: CreateMainProfiler;
    createRendererProfiler?: CreateRendererProfiler;
    analyzeSession?: AnalyzeStartupCpuProfileSession;
  }) {
    this.config =
      options?.config
      ?? resolveStartupCpuProfileConfig({
        repoRoot: resolveRepoRoot(),
      });
    this.logger = options?.logger ?? getMainLogger("pwragent:startup-cpu");
    this.now = options?.now ?? (() => new Date());
    this.createSession = options?.createSession ?? createStartupCpuProfileSession;
    this.createMainProfiler =
      options?.createMainProfiler
      ?? ((session) =>
        new MainProcessCpuProfiler({
          session,
        }));
    this.createRendererProfiler =
      options?.createRendererProfiler
      ?? ((session, target) =>
        new RendererStartupCpuProfiler({
          session,
          target,
        }));
    this.analyzeSession =
      options?.analyzeSession
      ?? analyzeStartupCpuProfileSession;
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.session) {
      return;
    }

    const created = await this.createSession({
      config: this.config,
      versions: {
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? "unknown",
        chromeVersion: process.versions.chrome ?? "unknown",
        nodeVersion: process.versions.node,
      },
    });

    if (!created.ok) {
      this.logger.error("startup CPU profiling session creation failed", {
        message: created.message,
      });
      return;
    }

    this.session = created.session;
    this.mainProfiler = this.createMainProfiler(created.session);
    await created.session.appendEvent({
      source: "main",
      capturedAt: this.now().toISOString(),
      type: "controller-started",
      detail: {
        sessionDirectory: created.session.directoryPath,
      },
    });
    this.logger.info("startup CPU profiling session directory", {
      sessionDirectory: created.session.directoryPath,
    });
    await this.mainProfiler.start();

    this.hardTimeoutTimer = setTimeout(() => {
      void this.stop("hard-timeout");
    }, this.config.hardTimeoutMs);
  }

  attachWindow(window: WindowTarget): void {
    const config = this.config;
    if (!config.enabled || !this.session || this.attachedWindow || this.stopped) {
      return;
    }

    this.attachedWindow = true;
    this.rendererProfiler = this.createRendererProfiler(this.session, window.webContents);
    void this.rendererProfiler.start();

    window.webContents.on("did-finish-load", () => {
      if (this.stopped) {
        return;
      }

      const scheduleStop = () => {
        void this.stop("startup-window-complete");
      };

      if (config.postLoadDurationMs === 0) {
        scheduleStop();
        return;
      }

      this.clearPostLoadTimer();
      this.postLoadStopTimer = setTimeout(scheduleStop, config.postLoadDurationMs);
    });

    window.webContents.on("did-fail-load", () => {
      void this.stop("did-fail-load");
    });

    window.webContents.on("render-process-gone", () => {
      void this.stop("render-process-gone");
    });

    window.on("closed", () => {
      void this.stop("window-closed");
    });
  }

  async stop(reason = "stopped"): Promise<void> {
    if (!this.config.enabled || this.stopped || !this.session) {
      return;
    }

    this.stopped = true;
    this.clearTimers();

    const stopResults = await Promise.allSettled([
      this.mainProfiler?.stop(reason) ?? Promise.resolve(false),
      this.rendererProfiler?.stop(reason) ?? Promise.resolve(false),
    ]);

    const mainCaptured =
      stopResults[0]?.status === "fulfilled" ? stopResults[0].value : false;
    const rendererCaptured =
      stopResults[1]?.status === "fulfilled" ? stopResults[1].value : false;
    const status = mainCaptured && rendererCaptured
      ? "completed"
      : mainCaptured || rendererCaptured
        ? "partial"
        : "failed";

    try {
      if (mainCaptured || rendererCaptured) {
        await this.analyzeSession({
          sessionDirectoryPath: this.session.directoryPath,
          repoRoot: this.config.repoRoot,
          analysisPath: this.session.analysisPath,
          summaryPath: this.session.summaryPath,
        });
        await this.session.markAnalysisGenerated(this.now().toISOString());
      }
    } catch (error) {
      await this.session.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "analysis-failed",
        detail: {
          error: serializeError(error),
        },
      });
      this.logger.error("startup CPU analysis failed", error);
    }

    await this.session.complete({
      status,
      completedAt: this.now().toISOString(),
    });
    await this.session.appendEvent({
      source: "main",
      capturedAt: this.now().toISOString(),
      type: "controller-stopped",
      detail: {
        reason,
        status,
      },
    });

    if (this.config.quitOnComplete) {
      app.quit();
    }
  }

  private clearPostLoadTimer(): void {
    if (!this.postLoadStopTimer) {
      return;
    }

    clearTimeout(this.postLoadStopTimer);
    this.postLoadStopTimer = undefined;
  }

  private clearTimers(): void {
    this.clearPostLoadTimer();
    if (this.hardTimeoutTimer) {
      clearTimeout(this.hardTimeoutTimer);
      this.hardTimeoutTimer = undefined;
    }
  }
}
