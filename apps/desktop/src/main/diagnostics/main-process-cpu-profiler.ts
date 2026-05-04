import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import type { StartupCpuProfileSession } from "./startup-cpu-profile-session";
import { getMainLogger } from "../log";

type Logger = Pick<Console, "info" | "warn" | "error">;

type InspectorProfilerSession = {
  connect: () => void;
  disconnect: () => void;
  post: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

function createInspectorProfilerSession(): InspectorProfilerSession {
  return new Session();
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export class MainProcessCpuProfiler {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly profilerSession: InspectorProfilerSession;
  private readonly session: StartupCpuProfileSession;

  private connected = false;
  private profiling = false;
  private stopCompleted = false;

  constructor(options: {
    session: StartupCpuProfileSession;
    logger?: Logger;
    now?: () => Date;
    profilerSession?: InspectorProfilerSession;
  }) {
    this.logger = options.logger ?? getMainLogger("pwragent:startup-cpu");
    this.now = options.now ?? (() => new Date());
    this.profilerSession =
      options.profilerSession ?? createInspectorProfilerSession();
    this.session = options.session;
  }

  async start(): Promise<boolean> {
    if (this.profiling) {
      return true;
    }

    try {
      this.profilerSession.connect();
      this.connected = true;
      await this.profilerSession.post("Profiler.enable");
      await this.profilerSession.post("Profiler.start");
      this.profiling = true;
      await this.session.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "profiler-started",
        detail: {
          filename: "main.cpuprofile",
        },
      });
      return true;
    } catch (error) {
      await this.session.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "profiler-start-failed",
        detail: {
          error: serializeError(error),
        },
      });
      this.logger.error("main startup CPU profiler failed to start", error);
      this.disconnect();
      return false;
    }
  }

  async stop(reason = "stopped"): Promise<boolean> {
    if (this.stopCompleted) {
      return false;
    }

    this.stopCompleted = true;

    if (!this.profiling) {
      this.disconnect();
      return false;
    }

    try {
      const result = (await this.profilerSession.post("Profiler.stop")) as {
        profile?: unknown;
      };
      await fs.writeFile(
        this.session.mainProfilePath,
        `${JSON.stringify(result.profile ?? {}, null, 2)}\n`,
        "utf8",
      );
      const capturedAt = this.now().toISOString();
      await this.session.markProfileCaptured("main", capturedAt);
      await this.session.appendEvent({
        source: "main",
        capturedAt,
        type: "profile-written",
        detail: {
          filename: "main.cpuprofile",
          reason,
        },
      });
      return true;
    } catch (error) {
      await this.session.appendEvent({
        source: "main",
        capturedAt: this.now().toISOString(),
        type: "profiler-stop-failed",
        detail: {
          error: serializeError(error),
          reason,
        },
      });
      this.logger.error("main startup CPU profiler failed to stop", error);
      return false;
    } finally {
      this.profiling = false;
      this.disconnect();
    }
  }

  private disconnect(): void {
    if (!this.connected) {
      return;
    }

    this.profilerSession.disconnect();
    this.connected = false;
  }
}
