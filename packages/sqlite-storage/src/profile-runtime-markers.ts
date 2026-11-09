import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeProfileName } from "@pwragent/shared";

const PROFILE_RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;
export const PROFILE_RUNTIME_HEARTBEAT_TTL_MS = 45_000;
const PROFILE_RUNTIME_IDENTITY_PREFIX = "runtime-v2-";

export type ProfileRuntimeHeartbeat = {
  markerPath: string;
  /**
   * Stop rewriting the marker but leave it on disk. Each refresh is a
   * synchronous main-thread write; once shutdown has released the runtime,
   * a slow disk turns one into a stalled quit.
   */
  stopRefreshing: () => void;
  stop: () => void;
};

export type ProfileRuntimeMarker = {
  instanceId: string;
  processId: number;
  profileName: string;
  startedAt: number;
  heartbeatAt: number;
};

export type ProfileRuntimeIdentity = Pick<
  ProfileRuntimeMarker,
  "instanceId" | "processId" | "startedAt"
>;

let processRuntimeIdentity: Omit<ProfileRuntimeIdentity, "processId"> | undefined;

export function getProcessRuntimeIdentity(): Omit<ProfileRuntimeIdentity, "processId"> {
  if (!processRuntimeIdentity) {
    processRuntimeIdentity = {
      instanceId: `${PROFILE_RUNTIME_IDENTITY_PREFIX}${randomUUID()}`,
      startedAt: Date.now(),
    };
  }
  return processRuntimeIdentity;
}

export function startProfileRuntimeHeartbeat(
  profileName: string,
  options: {
    markerDir: string;
    instanceId?: string;
    intervalMs?: number;
    now?: () => number;
    processId?: number;
    startedAt?: number;
  },
): ProfileRuntimeHeartbeat {
  const normalizedProfileName = normalizeProfileName(profileName);
  if (!normalizedProfileName) {
    throw new Error(`Profile name "${profileName}" must contain at least one letter or number.`);
  }
  const now = options?.now ?? Date.now;
  const processId = options?.processId ?? process.pid;
  const marker: ProfileRuntimeMarker = {
    instanceId: options?.instanceId ?? randomUUID(),
    processId,
    profileName: normalizedProfileName,
    startedAt: options?.startedAt ?? now(),
    heartbeatAt: now(),
  };
  const markerDir = options.markerDir;
  fs.mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, `${processId}-${marker.instanceId}.json`);
  const intervalRef: { current?: ReturnType<typeof setInterval> } = {};
  const writeMarker = (): void => {
    marker.heartbeatAt = now();
    try {
      writeJsonAtomic(markerPath, marker);
    } catch (error) {
      // The marker directory can vanish underneath us if the
      // profile is deleted, the `~/.pwragent` root is rm-rf'd
      // (E2E test cleanup; user moves their data dir; etc).
      // ENOENT here is recoverable: stop the interval rather than
      // throw an uncaught exception that pops a fatal Electron
      // error dialog. Re-creating the dir + retrying would just
      // race the deleter; let the heartbeat die quietly.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }
      throw error;
    }
  };
  writeMarker();
  const interval = setInterval(
    writeMarker,
    options?.intervalMs ?? PROFILE_RUNTIME_HEARTBEAT_INTERVAL_MS,
  );
  intervalRef.current = interval;
  if (interval.unref) interval.unref();

  return {
    markerPath,
    stopRefreshing: () => clearInterval(interval),
    stop: () => {
      if (interval) clearInterval(interval);
      try {
        fs.rmSync(markerPath, { force: true });
      } catch {
        // Heartbeat dir already cleaned up — see comment above.
      }
    },
  };
}

export function findLiveProfileRuntimeMarkers(
  profileName: string,
  options: { markerDir: string; now?: number },
): ProfileRuntimeMarker[] {
  const normalizedProfileName = normalizeProfileName(profileName);
  if (!normalizedProfileName) {
    return [];
  }
  const markerDir = options.markerDir;
  if (!fs.existsSync(markerDir)) {
    return [];
  }
  const now = options?.now ?? Date.now();
  const markers: ProfileRuntimeMarker[] = [];
  for (const entry of fs.readdirSync(markerDir)) {
    const markerPath = path.join(markerDir, entry);
    const marker = readProfileRuntimeMarker(markerPath);
    if (!marker || marker.profileName !== normalizedProfileName) {
      continue;
    }
    if (now - marker.heartbeatAt > PROFILE_RUNTIME_HEARTBEAT_TTL_MS) {
      fs.rmSync(markerPath, { force: true });
      continue;
    }
    if (!isProcessAlive(marker.processId)) {
      fs.rmSync(markerPath, { force: true });
      continue;
    }
    markers.push(marker);
  }
  return markers;
}

export function isProfileRuntimeIdentityLive(
  profileName: string,
  identity: ProfileRuntimeIdentity,
  options: { markerDir: string; now?: number },
): boolean {
  const markers = findLiveProfileRuntimeMarkers(profileName, options);
  if (!identity.instanceId.startsWith(PROFILE_RUNTIME_IDENTITY_PREFIX)) {
    // Runtime rows written before identity-aware leases used an unrelated
    // random ID for the profile marker. A fresh PwrAgent marker at the same
    // PID remains a bounded compatibility signal: after a crash it expires
    // even if the OS has already reassigned that PID to another process.
    return markers.some((marker) => marker.processId === identity.processId);
  }
  return markers.some(
    (marker) =>
      marker.instanceId === identity.instanceId
      && marker.processId === identity.processId
      && marker.startedAt === identity.startedAt,
  );
}

function readProfileRuntimeMarker(markerPath: string): ProfileRuntimeMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<ProfileRuntimeMarker>;
    if (
      typeof parsed.instanceId === "string"
      && typeof parsed.processId === "number"
      && typeof parsed.profileName === "string"
      && typeof parsed.startedAt === "number"
      && typeof parsed.heartbeatAt === "number"
    ) {
      return parsed as ProfileRuntimeMarker;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function isProcessAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

