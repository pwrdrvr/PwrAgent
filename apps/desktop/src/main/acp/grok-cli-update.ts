import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { AcpAgentUpdateStatus } from "@pwragent/shared";

const execFile = promisify(execFileCallback);

export const GROK_UPDATE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const GROK_UPDATE_FAILURE_TTL_MS = 60 * 60_000;
const GROK_UPDATE_CHECK_TIMEOUT_MS = 20_000;
const GROK_UPDATE_CHECK_MAX_BUFFER_BYTES = 64 * 1024;

type GrokUpdateCheckJson = {
  currentVersion?: unknown;
  latestVersion?: unknown;
  updateAvailable?: unknown;
  installer?: unknown;
  channel?: unknown;
  autoUpdate?: unknown;
  error?: unknown;
};

export type GrokCliUpdateProbe = (
  command: string,
) => Promise<{ stdout?: string; stderr?: string }>;

export function shouldCheckGrokCliUpdate(params: {
  command: string;
  installedVersion?: string;
  now: number;
  previous?: AcpAgentUpdateStatus;
  previousCommand?: string;
}): boolean {
  if (!params.previous) return true;
  if (params.previousCommand !== params.command) return true;
  if (
    params.installedVersion
    && params.installedVersion !== params.previous.currentVersion
  ) {
    return true;
  }
  const ttl =
    params.previous.status === "failed"
    || params.previous.error
      ? GROK_UPDATE_FAILURE_TTL_MS
      : GROK_UPDATE_SUCCESS_TTL_MS;
  return params.now - params.previous.checkedAt >= ttl;
}

export async function checkGrokCliUpdate(
  command: string,
  options: {
    now?: () => number;
    installedVersion?: string;
    previous?: AcpAgentUpdateStatus;
    probe?: GrokCliUpdateProbe;
  } = {},
): Promise<AcpAgentUpdateStatus> {
  const now = options.now?.() ?? Date.now();
  const probe = options.probe ?? defaultProbe;
  try {
    const result = await probe(command);
    const parsed = parseCheckOutput(result.stdout ?? "");
    const update: AcpAgentUpdateStatus = {
      status: parsed.updateAvailable ? "available" : "up-to-date",
      checkedAt: now,
      currentVersion: parsed.currentVersion,
      ...(parsed.latestVersion ? { latestVersion: parsed.latestVersion } : {}),
      ...(parsed.channel ? { channel: parsed.channel } : {}),
      ...(parsed.installer ? { installer: parsed.installer } : {}),
      ...(parsed.autoUpdate !== undefined
        ? { autoUpdate: parsed.autoUpdate }
        : {}),
    };
    return preserveGrokUpdateAcknowledgement(options.previous, update);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.previous && options.previous.status !== "failed") {
      return {
        ...options.previous,
        checkedAt: now,
        error: message,
      };
    }
    return {
      status: "failed",
      checkedAt: now,
      currentVersion:
        options.previous?.currentVersion ?? options.installedVersion ?? "unknown",
      error: message,
    };
  }
}

function parseCheckOutput(output: string): {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  installer?: string;
  channel?: string;
  autoUpdate?: boolean;
} {
  let value: GrokUpdateCheckJson;
  try {
    value = JSON.parse(output.trim()) as GrokUpdateCheckJson;
  } catch {
    throw new Error("Grok update check returned invalid JSON");
  }
  if (typeof value.currentVersion !== "string" || !value.currentVersion.trim()) {
    throw new Error("Grok update check omitted currentVersion");
  }
  if (typeof value.updateAvailable !== "boolean") {
    throw new Error("Grok update check omitted updateAvailable");
  }
  if (typeof value.error === "string" && value.error.trim()) {
    throw new Error(value.error.trim());
  }
  if (
    value.updateAvailable
    && (typeof value.latestVersion !== "string" || !value.latestVersion.trim())
  ) {
    throw new Error("Grok update check omitted latestVersion");
  }
  return {
    currentVersion: value.currentVersion.trim(),
    updateAvailable: value.updateAvailable,
    ...(typeof value.latestVersion === "string" && value.latestVersion.trim()
      ? { latestVersion: value.latestVersion.trim() }
      : {}),
    ...(typeof value.installer === "string" && value.installer.trim()
      ? { installer: value.installer.trim() }
      : {}),
    ...(typeof value.channel === "string" && value.channel.trim()
      ? { channel: value.channel.trim() }
      : {}),
    ...(typeof value.autoUpdate === "boolean"
      ? { autoUpdate: value.autoUpdate }
      : {}),
  };
}

export function preserveGrokUpdateAcknowledgement(
  previous: AcpAgentUpdateStatus | undefined,
  next: AcpAgentUpdateStatus,
): AcpAgentUpdateStatus {
  if (
    next.status !== "available"
    || !previous
    || previous.latestVersion !== next.latestVersion
  ) {
    return next;
  }
  return {
    ...next,
    ...(previous.dismissedAt !== undefined
      ? { dismissedAt: previous.dismissedAt }
      : {}),
    ...(previous.snoozedUntil !== undefined
      ? { snoozedUntil: previous.snoozedUntil }
      : {}),
  };
}

async function defaultProbe(
  command: string,
): Promise<{ stdout?: string; stderr?: string }> {
  return await execFile(command, ["update", "--check", "--json"], {
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: GROK_UPDATE_CHECK_MAX_BUFFER_BYTES,
    timeout: GROK_UPDATE_CHECK_TIMEOUT_MS,
  });
}
