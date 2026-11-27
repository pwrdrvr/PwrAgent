import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ManagedRuntimeProgressReporter } from "../managed-runtime-progress";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extract } from "tar";
import { getMainLogger } from "../log.js";
import {
  compareAntigravityVersions,
  type AntigravityReleaseStatus,
} from "../../shared/antigravity-setup.js";
import { ANTIGRAVITY_ACP_STRATEGY } from "./acp-local-strategies.js";
import { readAcpClientInfo } from "./acp-client-info.js";
import { AcpStdioJsonRpcTransport } from "./acp-stdio-transport.js";
import {
  ANTIGRAVITY_ACTIVE_LINK,
  isAntigravityVersion,
  managedAntigravityRoot,
  MANAGED_ANTIGRAVITY_ENV,
  pruneAntigravityRuntime,
  readActiveAntigravityRuntime,
  type ManagedAntigravityRuntime,
  withAntigravityRuntimeLock,
} from "./antigravity-runtime-retention.js";

export {
  isManagedAntigravityCommand,
  type ManagedAntigravityRuntime,
  MANAGED_ANTIGRAVITY_ENV,
  resolveAntigravityCommandPath,
} from "./antigravity-runtime-retention.js";

// Google's documented Unix bootstrapper (antigravity.google/cli/install.sh)
// uses this manifest and verifies the archive's SHA-512 before extracting.
const MANIFEST_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json";
const ARCHIVE_BASE = "https://storage.googleapis.com/antigravity-public/antigravity-cli";
const ARCHIVE_ENTRY = "antigravity";
const MAX_MANIFEST_BYTES = 8 * 1024;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const VALIDATION_TIMEOUT_MS = 90_000;
const log = getMainLogger("pwragent:antigravity-managed-runtime");

export type ManagedAntigravityStatus =
  | { status: "unsupported" | "not-installed" }
  | { status: "installed"; runtime: ManagedAntigravityRuntime };

type RuntimeLocation = {
  rootDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};

type InstallOptions = RuntimeLocation & {
  signal?: AbortSignal;
  progress?: ManagedRuntimeProgressReporter;
  /** Test seams. Production uses the official release feed and ACP stdio. */
  fetch?: typeof globalThis.fetch;
  verify?: typeof verifyRuntime;
};

type Release = { version: string; url: string; sha512: string };

const activeInstalls = new Set<string>();

function managedRoot(options?: RuntimeLocation): string {
  return path.resolve(options?.rootDir ?? managedAntigravityRoot());
}

function supportsManagedInstall(options?: RuntimeLocation): boolean {
  return (options?.platform ?? process.platform) === "darwin"
    && (options?.arch ?? process.arch) === "arm64";
}

/** Read the installed runtime without launching it or contacting Google. */
export async function readManagedAntigravityStatus(
  options?: RuntimeLocation,
): Promise<ManagedAntigravityStatus> {
  if (!supportsManagedInstall(options)) return { status: "unsupported" };
  const runtime = await readActiveAntigravityRuntime(managedRoot(options));
  return runtime ? { status: "installed", runtime } : { status: "not-installed" };
}

export type AntigravityReleaseCheck = AntigravityReleaseStatus;

type ReleaseCheckOptions = RuntimeLocation & {
  /** Reuse a check answered within this many milliseconds. `0` always asks. */
  maxAgeMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
};

const releaseChecks = new Map<string, AntigravityReleaseCheck>();
const pendingReleaseChecks = new Map<string, Promise<AntigravityReleaseCheck>>();

/** Forget cached release checks. Test seam. */
export function resetAntigravityReleaseChecks(): void {
  releaseChecks.clear();
  pendingReleaseChecks.clear();
}

/**
 * Read the version Google's release manifest currently serves, without
 * downloading or launching anything. The managed runtime runs with the CLI's
 * own updater disabled, so this is the only way it learns about a release.
 * A check answered within `maxAgeMs` is reused, and concurrent callers share
 * one request.
 */
export async function checkLatestAntigravityRelease(
  options: ReleaseCheckOptions = {},
): Promise<AntigravityReleaseCheck> {
  if (!supportsManagedInstall(options)) {
    throw new Error("Managed Antigravity installation requires macOS on Apple Silicon.");
  }
  const key = managedRoot(options);
  const now = options.now ?? Date.now;
  const cached = releaseChecks.get(key);
  if (cached && now() - cached.checkedAt < (options.maxAgeMs ?? 0)) return cached;
  let check = pendingReleaseChecks.get(key);
  if (!check) {
    // The shared request runs on its own timeout, not on any one caller's
    // signal: a caller that gives up must not fail the others joined to it.
    check = (async () => {
      const release = await fetchRelease(
        AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
        options.fetch ?? globalThis.fetch,
      );
      const result = { latestVersion: release.version, checkedAt: now() };
      releaseChecks.set(key, result);
      return result;
    })().finally(() => {
      pendingReleaseChecks.delete(key);
    });
    pendingReleaseChecks.set(key, check);
  }
  return await abortable(check, options.signal);
}

/** Settle with `promise`, or reject as soon as `signal` aborts. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function fetchRelease(signal: AbortSignal, fetchImpl: typeof globalThis.fetch): Promise<Release> {
  const chunks: Buffer[] = [];
  for await (const chunk of fetchBody(MANIFEST_URL, MAX_MANIFEST_BYTES, signal, fetchImpl)) chunks.push(chunk);
  return parseRelease(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

/** Explicitly install or reinstall Google's current release. The active link
 * changes only after checksum, extraction and ACP initialization succeed. */
export async function installManagedAntigravityRuntime(
  options: InstallOptions = {},
): Promise<ManagedAntigravityRuntime> {
  if (!supportsManagedInstall(options)) {
    throw new Error("Managed Antigravity installation requires macOS on Apple Silicon.");
  }
  options.signal?.throwIfAborted();
  const root = managedRoot(options);
  if (activeInstalls.has(root)) throw new Error("Antigravity installation is already in progress.");
  activeInstalls.add(root);
  try {
    return await installRelease(root, options);
  } finally {
    activeInstalls.delete(root);
  }
}

async function installRelease(root: string, options: InstallOptions): Promise<ManagedAntigravityRuntime> {
  options.progress?.checking();
  const previous = await readActiveAntigravityRuntime(root);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const downloadTimeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const downloadSignal = options.signal
    ? AbortSignal.any([options.signal, downloadTimeout])
    : downloadTimeout;
  const release = await fetchRelease(downloadSignal, fetchImpl);
  releaseChecks.set(root, { latestVersion: release.version, checkedAt: Date.now() });

  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error("Invalid managed Antigravity directory.");
  const staging = await mkdtemp(path.join(root, `.install-${process.pid}-`));
  try {
    const archive = path.join(staging, "release.tar.gz");
    await downloadArchive(release, archive, downloadSignal, fetchImpl, options.progress);
    options.progress?.unpacking(release.version);
    const command = await extractBinary(archive, staging);
    const verify = options.verify ?? verifyRuntime;
    options.signal?.throwIfAborted();
    options.progress?.activating(release.version);
    await verify(command, release.version, staging, options.signal);
    options.signal?.throwIfAborted();
    return await activateRelease(root, staging, command, release, previous?.command, options.signal);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      log.warn("Could not clean up an Antigravity installation staging directory");
    });
  }
}

function parseRelease(value: unknown): Release {
  const { version, url, sha512 } = (value ?? {}) as Partial<Record<keyof Release, unknown>>;
  if (typeof version !== "string" || !isAntigravityVersion(version)
    || typeof sha512 !== "string" || sha512.length !== 128 || !/^[a-f0-9]+$/i.test(sha512)
    || typeof url !== "string" || url !== url.trim()) {
    throw new Error("Invalid Google Antigravity release manifest.");
  }
  const prefix = `${ARCHIVE_BASE}/${version}-`;
  if (!url.startsWith(prefix) || !/^\d+\/darwin-arm\/cli_mac_arm64\.tar\.gz$/.test(url.slice(prefix.length))) {
    throw new Error("Unexpected archive URL in the Google Antigravity release manifest.");
  }
  return { version, url, sha512: sha512.toLowerCase() };
}

async function* fetchBody(
  url: string,
  byteLimit: number,
  signal: AbortSignal,
  fetchRelease: typeof globalThis.fetch,
): AsyncGenerator<Buffer> {
  const response = await fetchRelease(url, { redirect: "error", signal });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > byteLimit) {
    await response.body?.cancel();
    throw new Error(`Antigravity release download failed or exceeded its size limit (HTTP ${response.status}).`);
  }
  const body = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>, { signal });
  let bytesRead = 0;
  for await (const chunk of body) {
    bytesRead += chunk.length;
    if (bytesRead > byteLimit) throw new Error("Antigravity release download exceeded its size limit.");
    yield chunk;
  }
}

async function downloadArchive(
  release: Release,
  archive: string,
  signal: AbortSignal,
  fetchRelease: typeof globalThis.fetch,
  progress?: ManagedRuntimeProgressReporter,
): Promise<void> {
  const hash = createHash("sha512");
  const reportBytes = progress?.downloading(release.version);
  const source = fetchBody(release.url, MAX_RUNTIME_BYTES, signal, fetchRelease);
  await pipeline(source, async function* (chunks) {
    for await (const chunk of chunks) {
      hash.update(chunk);
      reportBytes?.(chunk.length);
      yield chunk;
    }
  }, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
  progress?.verifying(release.version);
  if (hash.digest("hex") !== release.sha512) {
    throw new Error("Google Antigravity archive SHA-512 does not match the release manifest.");
  }
}

async function extractBinary(archive: string, staging: string): Promise<string> {
  let entries = 0;
  let validEntry = false;
  await extract({
    file: archive,
    cwd: staging,
    preserveOwner: false,
    strict: true,
    filter: (name, entry) => {
      entries += 1;
      if (entries !== 1) return false;
      validEntry = name === ARCHIVE_ENTRY && "type" in entry && entry.type === "File"
        && entry.size > 0 && entry.size <= MAX_RUNTIME_BYTES;
      return validEntry;
    },
  });
  if (entries !== 1 || !validEntry) throw new Error("Unexpected Google Antigravity archive layout.");
  const candidate = path.join(staging, ARCHIVE_ENTRY);
  const command = path.join(staging, "agy");
  await chmod(candidate, 0o700);
  await rename(candidate, command);
  return command;
}

async function verifyRuntime(
  command: string,
  version: string,
  staging: string,
  signal?: AbortSignal,
): Promise<void> {
  const scratch = path.join(staging, "verify");
  await mkdir(scratch);
  signal?.throwIfAborted();
  const transport = new AcpStdioJsonRpcTransport({
    launchDescriptor: {
      backendId: "acp:antigravity",
      registryId: "antigravity",
      distributionKind: "local",
      command,
      args: [...ANTIGRAVITY_ACP_STRATEGY.spawn.args, "--gemini-dir", scratch],
      cwd: scratch,
      env: { ...MANAGED_ANTIGRAVITY_ENV },
    },
    // ACP initialize validates the runtime without opening an authenticated
    // session. Give the process a fresh home and force CLI file storage.
    baseEnv: {
      HOME: scratch,
      GEMINI_HOME: scratch,
      TMPDIR: scratch,
      PATH: "/usr/bin:/bin",
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
    },
    requestTimeoutMs: VALIDATION_TIMEOUT_MS,
  });
  const abort = () => { void transport.close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: readAcpClientInfo(),
    }) as { protocolVersion?: unknown; agentInfo?: { name?: unknown; version?: unknown } } | null;
    if (result?.protocolVersion !== 1
      || result.agentInfo?.name !== "Antigravity ACP Server"
      || result.agentInfo.version !== version) {
      throw new Error("The downloaded CLI did not initialize as the expected Antigravity ACP release.");
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await transport.close();
  }
}

async function activateRelease(
  root: string,
  staging: string,
  command: string,
  release: Release,
  previousCommand: string | undefined,
  signal?: AbortSignal,
): Promise<ManagedAntigravityRuntime> {
  return await withAntigravityRuntimeLock(root, async (assertLocked) => {
    const assertCanPublish = () => {
      signal?.throwIfAborted();
      assertLocked();
    };
    const active = await readActiveAntigravityRuntime(root);
    assertCanPublish();
    const runtime = active && keepActiveRuntime(active, release.version, previousCommand)
      ? active
      : await publishRelease(root, staging, command, release, assertCanPublish);
    // A verified release is already active. Cleanup is best effort.
    await pruneAntigravityRuntime(root, runtime.command, active?.command, assertLocked).catch((error) => {
      log.warn("Could not prune the Antigravity runtime", { error: String(error) });
    });
    return runtime;
  });
}

function keepActiveRuntime(
  active: ManagedAntigravityRuntime,
  version: string,
  previousCommand: string | undefined,
): boolean {
  const comparison = compareAntigravityVersions(active.version, version);
  if (comparison !== 0) return comparison > 0;
  // Google can rebuild a version with a different digest. A concurrent
  // activation wins that tie. An explicit reinstall can still replace it
  // after reading the current active build on the next attempt.
  return active.command !== previousCommand;
}

async function publishRelease(
  root: string,
  staging: string,
  command: string,
  release: Release,
  assertCanPublish: () => void,
): Promise<ManagedAntigravityRuntime> {
  const relative = path.join("versions", `${release.version}-${release.sha512}`, "agy");
  const installedCommand = path.join(root, relative);
  const versionDir = path.dirname(installedCommand);
  const versions = path.dirname(versionDir);
  for (const dir of [versions, versionDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await lstat(dir)).isDirectory()) throw new Error("Invalid managed Antigravity version directory.");
  }
  const stagedLink = path.join(staging, ANTIGRAVITY_ACTIVE_LINK);
  await symlink(relative, stagedLink);
  assertCanPublish();
  // A reinstall of the same digest atomically replaces the same verified
  // executable. Other releases keep their paths for existing selections.
  await rename(command, installedCommand);
  assertCanPublish();
  await rename(stagedLink, path.join(root, ANTIGRAVITY_ACTIVE_LINK));
  return { command: installedCommand, version: release.version };
}
