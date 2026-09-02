import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { AcpAgentUpdateStatus } from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import type { AcpInstalledAgentRecord } from "./acp-registry-types.js";

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

/**
 * Whether this record's active runtime is a PwrAgent-supplied Grok build
 * (managed download or app bundle). Discovery stamps `GROK_INSTALLER=pwragent`
 * on the launch descriptor when the resolved active command is one of those,
 * and that stamp is the single marker every update-status path keys on: the
 * vendor updater follows a different channel, so its result must never run
 * against, decorate, or survive on a PwrAgent-owned runtime.
 */
export function isPwrAgentOwnedGrokRuntime(
  record: Pick<AcpInstalledAgentRecord, "launchDescriptor">,
): boolean {
  return record.launchDescriptor?.env?.GROK_INSTALLER === "pwragent";
}

/**
 * Whether the vendor Grok update check should be armed at all.
 *
 * E2E and the screenshot capture pipelines launch with NODE_ENV=production,
 * which otherwise runs this check against whatever Grok build happens to sit
 * on the host. A host one release behind then produces an `available` status,
 * and the notice it feeds is durable (`autoDismiss: false`), so it paints
 * "Grok update available" over the capture. On 2026-09-01 that put the toast
 * into 8 of the 21 docs-site PNGs; which 8 was a race between the notice's
 * async refresh and each native window grab, so consecutive frames of one
 * flow disagreed.
 *
 * `auto-updater.ts` already suppresses PwrAgent's own update check under the
 * same predicate, for the same reason — a background check must not make the
 * UI depend on what happens to be published. This is that rule for the vendor
 * CLI check.
 *
 * Only the default wiring is gated. A test that wants the check still passes
 * `checkGrokCliUpdate` explicitly through `AcpBackendAdapterOptions`.
 */
export function grokUpdateChecksDisabled(params: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  return env.PWRAGENT_E2E === "1" && !params.isPackaged;
}

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
    env: buildPwrAgentChildProcessEnv(process.env, { NO_COLOR: "1" }),
    maxBuffer: GROK_UPDATE_CHECK_MAX_BUFFER_BYTES,
    timeout: GROK_UPDATE_CHECK_TIMEOUT_MS,
  });
}
