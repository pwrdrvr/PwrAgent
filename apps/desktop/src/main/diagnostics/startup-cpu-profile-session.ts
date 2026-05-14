import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StartupCpuProfileConfig } from "./startup-cpu-profile-config";

export type StartupCpuProfileSessionEvent = {
  source: "main" | "renderer";
  capturedAt: string;
  type: string;
  detail?: Record<string, unknown>;
};

export type StartupCpuProfileVersions = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
};

type StartupCpuProfileManifest = {
  id: string;
  directoryName: string;
  createdAt: string;
  outputRoot: string;
  status: "running" | "completed" | "partial" | "failed";
  completedAt: string | null;
  mainProfile: {
    filename: string;
    capturedAt: string | null;
  };
  rendererProfile: {
    filename: string;
    capturedAt: string | null;
  };
  analysis: {
    jsonFilename: string;
    summaryFilename: string;
    generatedAt: string | null;
  };
  config: {
    postLoadDurationMs: number;
    hardTimeoutMs: number;
  };
  versions: StartupCpuProfileVersions;
};

export type StartupCpuProfileSession = {
  id: string;
  directoryName: string;
  directoryPath: string;
  manifestPath: string;
  eventsPath: string;
  mainProfilePath: string;
  rendererProfilePath: string;
  analysisPath: string;
  summaryPath: string;
  appendEvent: (event: StartupCpuProfileSessionEvent) => Promise<void>;
  markProfileCaptured: (
    process: "main" | "renderer",
    capturedAt: string,
  ) => Promise<void>;
  markAnalysisGenerated: (generatedAt: string) => Promise<void>;
  complete: (params: {
    status: "completed" | "partial" | "failed";
    completedAt: string;
  }) => Promise<void>;
};

export type StartupCpuProfileSessionCreateResult =
  | { ok: true; session: StartupCpuProfileSession }
  | { ok: false; code: "SESSION_CREATE_FAILED"; message: string; cause: unknown };

function formatSessionPrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

function createSessionDirectoryName(createdAt: Date, sessionId: string): string {
  return `startup-cpu-${formatSessionPrefix(createdAt)}-${sessionId}`;
}

function serializeNdjsonRecord(record: StartupCpuProfileSessionEvent): string {
  return `${JSON.stringify(record)}\n`;
}

async function writeManifest(
  manifestPath: string,
  manifest: StartupCpuProfileManifest,
): Promise<void> {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function createStartupCpuProfileSession(options: {
  config: Extract<StartupCpuProfileConfig, { enabled: true }>;
  createdAt?: Date;
  sessionId?: string;
  versions: StartupCpuProfileVersions;
}): Promise<StartupCpuProfileSessionCreateResult> {
  const createdAt = options.createdAt ?? new Date();
  const sessionId = options.sessionId ?? randomBytes(3).toString("hex");
  const directoryName = createSessionDirectoryName(createdAt, sessionId);
  const directoryPath = path.join(options.config.outputRoot, directoryName);
  const manifestPath = path.join(directoryPath, "session.json");
  const eventsPath = path.join(directoryPath, "events.ndjson");
  const mainProfilePath = path.join(directoryPath, "main.cpuprofile");
  const rendererProfilePath = path.join(directoryPath, "renderer.cpuprofile");
  const analysisPath = path.join(directoryPath, "analysis.json");
  const summaryPath = path.join(directoryPath, "summary.md");

  const manifest: StartupCpuProfileManifest = {
    id: sessionId,
    directoryName,
    createdAt: createdAt.toISOString(),
    outputRoot: options.config.outputRoot,
    status: "running",
    completedAt: null,
    mainProfile: {
      filename: path.basename(mainProfilePath),
      capturedAt: null,
    },
    rendererProfile: {
      filename: path.basename(rendererProfilePath),
      capturedAt: null,
    },
    analysis: {
      jsonFilename: path.basename(analysisPath),
      summaryFilename: path.basename(summaryPath),
      generatedAt: null,
    },
    config: {
      postLoadDurationMs: options.config.postLoadDurationMs,
      hardTimeoutMs: options.config.hardTimeoutMs,
    },
    versions: options.versions,
  };

  try {
    await fs.mkdir(options.config.outputRoot, { recursive: true });
    await fs.mkdir(directoryPath);
    await writeManifest(manifestPath, manifest);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "SESSION_CREATE_FAILED",
      message: `Unable to create startup CPU profiling session in ${options.config.outputRoot}: ${reason}`,
      cause: error,
    };
  }

  let manifestWriteQueue = Promise.resolve();

  async function updateManifest(
    mutator: (current: StartupCpuProfileManifest) => void,
  ): Promise<void> {
    manifestWriteQueue = manifestWriteQueue.then(async () => {
      mutator(manifest);
      await writeManifest(manifestPath, manifest);
    });
    await manifestWriteQueue;
  }

  return {
    ok: true,
    session: {
      id: sessionId,
      directoryName,
      directoryPath,
      manifestPath,
      eventsPath,
      mainProfilePath,
      rendererProfilePath,
      analysisPath,
      summaryPath,
      appendEvent: async (event) => {
        await fs.appendFile(eventsPath, serializeNdjsonRecord(event), "utf8");
      },
      markProfileCaptured: async (process, capturedAtValue) => {
        await updateManifest((current) => {
          if (process === "main") {
            current.mainProfile.capturedAt = capturedAtValue;
          } else {
            current.rendererProfile.capturedAt = capturedAtValue;
          }
        });
      },
      markAnalysisGenerated: async (generatedAt) => {
        await updateManifest((current) => {
          current.analysis.generatedAt = generatedAt;
        });
      },
      complete: async ({ status, completedAt: completedAtValue }) => {
        await updateManifest((current) => {
          current.status = status;
          current.completedAt = completedAtValue;
        });
      },
    },
  };
}
