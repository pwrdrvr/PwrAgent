import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HeapMonitorConfig } from "./heap-monitor-config";

export type HeapSessionSample = {
  source: "renderer" | "main";
  capturedAt: string;
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
  rss?: number;
  external?: number;
  arrayBuffers?: number;
  heapSizeLimit?: number;
  totalPhysicalSize?: number;
  totalAvailableSize?: number;
  mallocedMemory?: number;
  peakMallocedMemory?: number;
  isBaseline: boolean;
  deltaBytes: number | null;
};

export type HeapSessionEvent = {
  source: "renderer" | "main";
  capturedAt: string;
  type: string;
  detail?: Record<string, unknown>;
};

export type HeapSessionVersions = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
};

type HeapSessionManifest = {
  id: string;
  directoryName: string;
  createdAt: string;
  outputRoot: string;
  snapshotFiles: string[];
  config: {
    intervalMs: number;
    settleDelayMs: number;
    deltaThresholdBytes: number;
    snapshotCooldownMs: number;
    maxSnapshots: number;
  };
  versions: HeapSessionVersions;
};

export type HeapSession = {
  id: string;
  directoryName: string;
  directoryPath: string;
  samplesPath: string;
  eventsPath: string;
  appendSample: (sample: HeapSessionSample) => Promise<void>;
  appendEvent: (event: HeapSessionEvent) => Promise<void>;
  registerSnapshotFile: (filename: string) => Promise<void>;
};

export type HeapSessionCreateResult =
  | { ok: true; session: HeapSession }
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
  return `heap-${formatSessionPrefix(createdAt)}-${sessionId}`;
}

function serializeNdjsonRecord(record: HeapSessionSample | HeapSessionEvent): string {
  return `${JSON.stringify(record)}\n`;
}

async function writeManifest(
  manifestPath: string,
  manifest: HeapSessionManifest,
): Promise<void> {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function createHeapSession(options: {
  config: Extract<HeapMonitorConfig, { enabled: true }>;
  createdAt?: Date;
  sessionId?: string;
  versions: HeapSessionVersions;
}): Promise<HeapSessionCreateResult> {
  const createdAt = options.createdAt ?? new Date();
  const sessionId = options.sessionId ?? randomBytes(3).toString("hex");
  const directoryName = createSessionDirectoryName(createdAt, sessionId);
  const directoryPath = path.join(options.config.outputRoot, directoryName);
  const manifestPath = path.join(directoryPath, "session.json");
  const samplesPath = path.join(directoryPath, "samples.ndjson");
  const eventsPath = path.join(directoryPath, "events.ndjson");

  const manifest: HeapSessionManifest = {
    id: sessionId,
    directoryName,
    createdAt: createdAt.toISOString(),
    outputRoot: options.config.outputRoot,
    snapshotFiles: [],
    config: {
      intervalMs: options.config.intervalMs,
      settleDelayMs: options.config.settleDelayMs,
      deltaThresholdBytes: options.config.deltaThresholdBytes,
      snapshotCooldownMs: options.config.snapshotCooldownMs,
      maxSnapshots: options.config.maxSnapshots,
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
      message: `Unable to create heap diagnostics session in ${options.config.outputRoot}: ${reason}`,
      cause: error,
    };
  }

  async function appendRecord(
    targetPath: string,
    record: HeapSessionSample | HeapSessionEvent,
  ): Promise<void> {
    await fs.appendFile(targetPath, serializeNdjsonRecord(record), "utf8");
  }

  return {
    ok: true,
    session: {
      id: sessionId,
      directoryName,
      directoryPath,
      samplesPath,
      eventsPath,
      appendSample: async (sample) => {
        await appendRecord(samplesPath, sample);
      },
      appendEvent: async (event) => {
        await appendRecord(eventsPath, event);
      },
      registerSnapshotFile: async (filename) => {
        manifest.snapshotFiles.push(filename);
        await writeManifest(manifestPath, manifest);
      },
    },
  };
}
