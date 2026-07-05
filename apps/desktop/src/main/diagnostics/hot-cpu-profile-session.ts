import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HotCpuProfileConfig } from "./hot-cpu-profile-config";

export type HotCpuProfileSample = {
  capturedAt: string;
  pid: number;
  cpuPercent: number;
  electronCpuPercent?: number;
  cumulativeCpuDeltaSeconds?: number;
  cumulativeCpuSeconds?: number;
  wallDeltaSeconds?: number;
  idleWakeupsPerSecond?: number;
  workingSetSize?: number;
  peakWorkingSetSize?: number;
  consecutiveHotSamples: number;
};

export type HotCpuProfileEvent = {
  capturedAt: string;
  type: string;
  detail?: Record<string, unknown>;
};

export type HotCpuProfileSession = {
  id: string;
  directoryName: string;
  directoryPath: string;
  samplesPath: string;
  eventsPath: string;
  appendSample: (sample: HotCpuProfileSample) => Promise<void>;
  appendEvent: (event: HotCpuProfileEvent) => Promise<void>;
  createProfilePath: (index: number) => string;
  createHeapSnapshotPath: (index: number, phase: string) => string;
  registerArtifact: (filename: string) => Promise<void>;
};

export type HotCpuProfileSessionCreateResult =
  | { ok: true; session: HotCpuProfileSession }
  | {
      ok: false;
      code: "SESSION_CREATE_FAILED";
      message: string;
      cause: unknown;
    };

type HotCpuProfileSessionManifest = {
  id: string;
  directoryName: string;
  createdAt: string;
  outputRoot: string;
  artifacts: string[];
  config: {
    startDelayMs: number;
    triggerMode: string;
    intervalMs: number;
    thresholdPercent: number;
    slowburnThresholdPercent: number;
    consecutiveSamples: number;
    profileDurationMs: number;
    cooldownMs: number;
    maxProfiles: number;
    captureHeapSnapshot: boolean;
    heapSnapshotLimit: number;
  };
  versions: {
    appVersion: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion: string;
  };
};

function formatSessionPrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

function serializeNdjsonRecord(
  record: HotCpuProfileSample | HotCpuProfileEvent,
): string {
  return `${JSON.stringify(record)}\n`;
}

async function writeManifest(
  manifestPath: string,
  manifest: HotCpuProfileSessionManifest,
): Promise<void> {
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export async function createHotCpuProfileSession(options: {
  config: Extract<HotCpuProfileConfig, { enabled: true }>;
  createdAt?: Date;
  sessionId?: string;
  versions: HotCpuProfileSessionManifest["versions"];
}): Promise<HotCpuProfileSessionCreateResult> {
  const createdAt = options.createdAt ?? new Date();
  const sessionId = options.sessionId ?? randomBytes(3).toString("hex");
  const directoryName = `hot-cpu-${formatSessionPrefix(createdAt)}-${sessionId}`;
  const directoryPath = path.join(options.config.outputRoot, directoryName);
  const manifestPath = path.join(directoryPath, "session.json");
  const samplesPath = path.join(directoryPath, "samples.ndjson");
  const eventsPath = path.join(directoryPath, "events.ndjson");
  const artifacts: string[] = [];

  const manifest: HotCpuProfileSessionManifest = {
    id: sessionId,
    directoryName,
    createdAt: createdAt.toISOString(),
    outputRoot: options.config.outputRoot,
    artifacts,
    config: {
      startDelayMs: options.config.startDelayMs,
      triggerMode: options.config.triggerMode,
      intervalMs: options.config.intervalMs,
      thresholdPercent: options.config.thresholdPercent,
      slowburnThresholdPercent: options.config.slowburnThresholdPercent,
      consecutiveSamples: options.config.consecutiveSamples,
      profileDurationMs: options.config.profileDurationMs,
      cooldownMs: options.config.cooldownMs,
      maxProfiles: options.config.maxProfiles,
      captureHeapSnapshot: options.config.captureHeapSnapshot,
      heapSnapshotLimit: options.config.heapSnapshotLimit,
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
      message: `Unable to create hot CPU diagnostics session in ${options.config.outputRoot}: ${reason}`,
      cause: error,
    };
  }

  async function appendRecord(
    targetPath: string,
    record: HotCpuProfileSample | HotCpuProfileEvent,
  ): Promise<void> {
    await fs.appendFile(targetPath, serializeNdjsonRecord(record), "utf8");
  }

  async function registerArtifact(filename: string): Promise<void> {
    artifacts.push(filename);
    await writeManifest(manifestPath, manifest);
  }

  return {
    ok: true,
    session: {
      id: sessionId,
      directoryName,
      directoryPath,
      samplesPath,
      eventsPath,
      appendSample: async (sample) => appendRecord(samplesPath, sample),
      appendEvent: async (event) => appendRecord(eventsPath, event),
      createProfilePath: (index) =>
        path.join(
          directoryPath,
          `renderer-hot-${String(index).padStart(4, "0")}.cpuprofile`,
        ),
      createHeapSnapshotPath: (index, phase) =>
        path.join(
          directoryPath,
          `renderer-hot-${String(index).padStart(4, "0")}-${phase}.heapsnapshot`,
        ),
      registerArtifact,
    },
  };
}
