import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { extract } from "tar";
import {
  CODEX_MINIMUM_RECOMMENDED_VERSION,
  isCodexVersionBelowMinimum,
  parseCodexVersionCore,
} from "@pwragent/shared/codex-version";
import type { DesktopCodexDiscoverySnapshot } from "@pwragent/shared/contracts/settings";
import { managedCodexRoot, type CodexBuildChannelOptions } from "./codex-build-channel.js";
import { hasActiveRuntimeMarker, isProcessAlive } from "./codex-managed-runtime.js";
import { getMainLogger } from "./log.js";
import {
  createManagedRuntimeProgressReporter,
  type ManagedRuntimeProgressReporter,
} from "./managed-runtime-progress.js";

// OpenAI's own Codex, installed and kept current by PwrAgent for an operator
// who has none. The source is the one OpenAI's installer and T3 Code use: npm
// names the latest stable release, and that release's GitHub assets carry the
// per-target package and its SHA-256. Every version lives in its own directory
// under the PwrAgent root, outside the app bundle and outside OpenAI's own
// installer layout, so an app update never removes it and a running app server
// never has its binary replaced underneath it.

const execFile = promisify(execFileCallback);
const log = getMainLogger("pwragent:codex-openai-runtime");

export const OPENAI_CODEX_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
export const OPENAI_CODEX_RELEASE_BASE_URL = "https://github.com/openai/codex/releases/download";
export const OPENAI_CODEX_CHECKSUMS_NAME = "codex-package_SHA256SUMS";
export const OPENAI_CODEX_CHECK_TTL_MS = 24 * 60 * 60_000;
const OPENAI_CODEX_RETRY_BACKOFF_MS = 60 * 60_000;
// OpenAI publishes no archive size; current packages are 160-250 MB.
const OPENAI_CODEX_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const OPENAI_CODEX_MAX_METADATA_BYTES = 256 * 1024;
const OPENAI_CODEX_MAX_ARCHIVE_ENTRIES = 10_000;
const OPENAI_CODEX_LOOKUP_TIMEOUT_MS = 30_000;
const OPENAI_CODEX_DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
// Windows Defender scans a fresh 400 MB executable before its first start.
const OPENAI_CODEX_VERSION_PROBE_TIMEOUT_MS = 90_000;
const OPENAI_CODEX_STALE_STAGING_MS = 24 * 60 * 60_000;
const OPENAI_CODEX_METADATA_NAME = "openai-release.json";
const OPENAI_CODEX_INSTALL_RECORD_NAME = ".pwragent-install.json";
const OPENAI_CODEX_SCHEMA_VERSION = 1;
const STABLE_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/u;

/**
 * `read` reports the installed copy with no side effects; `ttl` also marks it
 * in use, prunes others, and starts a daily background check; `force` checks
 * OpenAI now and installs the latest eligible release.
 */
export type OpenAiCodexCheckMode = "read" | "ttl" | "force";

export type OpenAiCodexRelease = {
  version: string;
  target: string;
  archiveName: string;
  url: string;
  sha256: string;
};

export type OpenAiCodexMetadata = {
  schemaVersion: typeof OPENAI_CODEX_SCHEMA_VERSION;
  version: string;
  target: string;
  sha256: string;
  installedAt: number;
  checkedAt: number;
  /** Newest stable version the last check saw. */
  latestVersion?: string;
};

export type OpenAiCodexRuntime = {
  command: string;
  version: string;
  versionRoot: string;
  metadata: OpenAiCodexMetadata;
};

type RuntimeLocation = {
  rootDir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
};

export type OpenAiCodexRuntimeOptions = RuntimeLocation & {
  checkMode?: OpenAiCodexCheckMode;
  signal?: AbortSignal;
  now?: () => number;
  /** Test seams. Production uses the network, `codex --version`, and live pids. */
  fetch?: typeof globalThis.fetch;
  probeVersion?: (command: string) => Promise<string>;
  isProcessAlive?: (pid: number) => boolean;
  progress?: ManagedRuntimeProgressReporter;
};

const activeChecks = new Map<string, Promise<OpenAiCodexRuntime | undefined>>();
const retryChecksAfter = new Map<string, number>();

/** Forget in-memory check state. Test seam. */
export function resetOpenAiCodexRuntimeChecks(): void {
  activeChecks.clear();
  retryChecksAfter.clear();
}

/** `agents/codex/openai` under the PwrAgent root. */
export function openAiCodexRoot(options?: CodexBuildChannelOptions): string {
  return path.join(managedCodexRoot(options), "openai");
}

/** OpenAI's release target for this machine, or `undefined` when it publishes none. */
export function openAiCodexTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture | string,
): string | undefined {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (!cpu) return undefined;
  switch (platform) {
    case "darwin":
      return `${cpu}-apple-darwin`;
    case "linux":
      return `${cpu}-unknown-linux-musl`;
    case "win32":
      return `${cpu}-pc-windows-msvc`;
    default:
      return undefined;
  }
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "codex.exe" : "codex";
}

function rootFor(options: RuntimeLocation | undefined): string {
  return path.resolve(options?.rootDir ?? openAiCodexRoot());
}

function isStableVersion(value: unknown): value is string {
  return typeof value === "string" && STABLE_VERSION.test(value);
}

/** Orders two stable versions; `undefined` sorts below every version. */
export function compareOpenAiCodexVersions(
  left: string | undefined,
  right: string | undefined,
): number {
  const a = parseCodexVersionCore(left);
  const b = parseCodexVersionCore(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = a[index]! - b[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

/** A stable release new enough for the models PwrAgent offers. */
export function isOpenAiCodexReleaseEligible(version: string | undefined): boolean {
  return isStableVersion(version) && !isCodexVersionBelowMinimum(version);
}

/**
 * Whether a check that found `latest` should install it. Never downgrades and
 * never installs a release below the recommended minimum: an installed build
 * that works is better than one PwrAgent would have to warn about.
 */
export function planOpenAiCodexUpdate(params: {
  installed: string | undefined;
  latest: string | undefined;
}): "install" | "keep" {
  if (!isOpenAiCodexReleaseEligible(params.latest)) return "keep";
  if (!isStableVersion(params.installed)) return "install";
  return compareOpenAiCodexVersions(params.latest, params.installed) > 0 ? "install" : "keep";
}

/**
 * Version directories that can be removed: every well-formed version except the
 * current one and those a live PwrAgent process still marks as in use. Names
 * that are not versions (staging directories, anything a person put there) are
 * never touched here.
 */
export function selectPrunableOpenAiCodexVersions(params: {
  entries: readonly string[];
  current: string;
  inUse: ReadonlySet<string>;
}): string[] {
  return params.entries.filter((name) =>
    isStableVersion(name) && name !== params.current && !params.inUse.has(name));
}

/**
 * The version of the PwrAgent-installed OpenAI Codex that `command` runs, or
 * `undefined` when the command is anything else. Decided from the path, the
 * same way `managedCodexTagForCommand` recognizes PwrAgent's own build.
 */
export function openAiCodexVersionForCommand(
  command: string | undefined,
  options?: RuntimeLocation,
): string | undefined {
  if (!command) return undefined;
  const relative = path.relative(
    path.join(rootFor(options), "versions"),
    path.resolve(command),
  );
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const [version, bin, name, ...rest] = relative.split(path.sep);
  return isStableVersion(version)
    && bin === "bin"
    && (name === "codex" || name === "codex.exe")
    && rest.length === 0
    ? version
    : undefined;
}

/**
 * Discovery's selection, with the PwrAgent-installed OpenAI Codex filling in
 * when nothing better was found. An operator's explicit command (environment
 * or Settings) always wins, as does a user-installed Codex new enough for the
 * newest models. The install takes over only when no Codex was selected, or
 * the one selected is older than the recommended minimum: that is the case
 * Get started offers the install for.
 */
export function applyOpenAiCodexFallback(
  snapshot: DesktopCodexDiscoverySnapshot,
  runtime: Pick<OpenAiCodexRuntime, "command" | "version"> | undefined,
): DesktopCodexDiscoverySnapshot {
  if (!runtime) return snapshot;
  const selected = snapshot.candidates.find((candidate) => candidate.selected);
  if (
    selected
    && (
      selected.command === runtime.command
      || selected.source === "env"
      || selected.source === "config"
      || !isCodexVersionBelowMinimum(selected.version)
    )
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    candidates: [
      ...snapshot.candidates
        .filter((candidate) => candidate.command !== runtime.command)
        .map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate),
      {
        command: runtime.command,
        source: "application",
        executable: true,
        selected: true,
        version: runtime.version,
      },
    ],
    selectedCommand: runtime.command,
    selectedSource: "application",
  };
}

/**
 * Resolve the installed OpenAI Codex, checking OpenAI for a newer release as
 * `checkMode` asks. `ttl` never installs a first copy and never waits on the
 * network: it answers with the installed copy and starts a background check
 * once a day. `force` checks now and installs the latest eligible release.
 */
export async function ensureOpenAiCodexRuntime(
  options: OpenAiCodexRuntimeOptions = {},
): Promise<OpenAiCodexRuntime | undefined> {
  const root = rootFor(options);
  if (options.checkMode === "read") return await readInstalledOpenAiCodexRuntime(options);
  if ((options.checkMode ?? "ttl") === "ttl") {
    const cached = await readInstalledOpenAiCodexRuntime(options);
    if (!cached) return undefined;
    const now = options.now?.() ?? Date.now();
    // A PwrAgent update can raise the minimum under an installed copy; that
    // copy is due for a check now, not when its day runs out.
    if (
      (
        now - cached.metadata.checkedAt >= OPENAI_CODEX_CHECK_TTL_MS
        || !isOpenAiCodexReleaseEligible(cached.version)
      )
      && now >= (retryChecksAfter.get(root) ?? 0)
      && !activeChecks.has(root)
    ) {
      void checkOpenAiCodex(root, { ...options, checkMode: "force" }).catch((error: unknown) => {
        log.warn("openai_codex_background_update_failed", {
          error: error instanceof Error ? error.message : String(error),
          usingVersion: cached.version,
        });
      });
    }
    return await activateRuntime(root, cached, options);
  }
  return await checkOpenAiCodex(root, options);
}

function checkOpenAiCodex(
  root: string,
  options: OpenAiCodexRuntimeOptions,
): Promise<OpenAiCodexRuntime | undefined> {
  const existing = activeChecks.get(root);
  if (existing) return existing;
  const check = runCheck(root, options).finally(() => {
    if (activeChecks.get(root) === check) activeChecks.delete(root);
  });
  activeChecks.set(root, check);
  return check;
}

async function runCheck(
  root: string,
  options: OpenAiCodexRuntimeOptions,
): Promise<OpenAiCodexRuntime> {
  const now = options.now?.() ?? Date.now();
  const progress = options.progress ?? createManagedRuntimeProgressReporter("openai-codex");
  progress.checking();
  const cached = await readInstalledOpenAiCodexRuntime(options);
  try {
    const release = await fetchLatestOpenAiCodexRelease(options);
    if (planOpenAiCodexUpdate({ installed: cached?.version, latest: release.version }) === "keep") {
      if (!cached) {
        throw new Error(
          `OpenAI's latest Codex (${release.version}) is older than ${CODEX_MINIMUM_RECOMMENDED_VERSION}, so PwrAgent did not install it.`,
        );
      }
      const metadata = { ...cached.metadata, checkedAt: now, latestVersion: release.version };
      await writeMetadata(root, metadata);
      retryChecksAfter.delete(root);
      progress.idle();
      return await activateRuntime(root, { ...cached, metadata }, options);
    }
    const runtime = await installRelease(root, release, now, options, progress);
    retryChecksAfter.delete(root);
    log.info("openai_codex_runtime_installed", { version: runtime.version, target: release.target });
    const active = await activateRuntime(root, runtime, options);
    progress.ready(runtime.version);
    return active;
  } catch (error) {
    log.warn("openai_codex_runtime_update_failed", {
      error: error instanceof Error ? error.message : String(error),
      usingVersion: cached?.version,
    });
    if (options.signal?.aborted) {
      progress.idle();
    } else {
      progress.failed(error, cached ? { fallbackTag: cached.version } : {});
    }
    if (cached) {
      if (!options.signal?.aborted) {
        retryChecksAfter.set(root, now + OPENAI_CODEX_RETRY_BACKOFF_MS);
      }
      return await activateRuntime(root, cached, options);
    }
    throw error;
  }
}

/** The latest stable release OpenAI publishes for this machine, with its SHA-256. */
export async function fetchLatestOpenAiCodexRelease(
  options: Pick<OpenAiCodexRuntimeOptions, "platform" | "arch" | "fetch" | "signal"> = {},
): Promise<OpenAiCodexRelease> {
  const target = openAiCodexTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  if (!target) throw new Error("OpenAI does not publish Codex for this platform.");
  const signal = withTimeout(options.signal, OPENAI_CODEX_LOOKUP_TIMEOUT_MS);
  const latest = parseJson(
    await fetchSmallText(OPENAI_CODEX_LATEST_URL, options.fetch, signal),
    "npm @openai/codex latest",
  );
  const version = latest.version;
  if (latest.name !== "@openai/codex" || !isStableVersion(version)) {
    throw new Error("npm did not report a stable @openai/codex release.");
  }
  const releaseUrl = `${OPENAI_CODEX_RELEASE_BASE_URL}/rust-v${version}`;
  const checksums = parseChecksums(
    await fetchSmallText(`${releaseUrl}/${OPENAI_CODEX_CHECKSUMS_NAME}`, options.fetch, signal),
  );
  const archiveName = `codex-package-${target}.tar.gz`;
  const sha256 = checksums.get(archiveName);
  if (!sha256) {
    throw new Error(`OpenAI's Codex ${version} release has no ${archiveName}.`);
  }
  return { version, target, archiveName, url: `${releaseUrl}/${archiveName}`, sha256 };
}

/** `<sha256>  <name>` lines, as `sha256sum` writes them. */
export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/u.exec(line.trim());
    if (match) checksums.set(match[2]!, match[1]!.toLowerCase());
  }
  return checksums;
}

/**
 * The installed release the metadata names, after checking its directory still
 * holds that release's package. Never launches it and never contacts OpenAI.
 */
export async function readInstalledOpenAiCodexRuntime(
  options: RuntimeLocation = {},
): Promise<OpenAiCodexRuntime | undefined> {
  const root = rootFor(options);
  const platform = options.platform ?? process.platform;
  const target = openAiCodexTarget(platform, options.arch ?? process.arch);
  if (!target) return undefined;
  try {
    const metadata = parseJson(
      await readFile(path.join(root, OPENAI_CODEX_METADATA_NAME), "utf8"),
      "OpenAI Codex metadata",
    );
    if (
      metadata.schemaVersion !== OPENAI_CODEX_SCHEMA_VERSION
      || !isStableVersion(metadata.version)
      || metadata.target !== target
      || typeof metadata.sha256 !== "string"
      || typeof metadata.installedAt !== "number"
      || typeof metadata.checkedAt !== "number"
    ) {
      return undefined;
    }
    const versionRoot = path.join(root, "versions", metadata.version);
    await validateInstalledVersion(versionRoot, {
      version: metadata.version,
      target,
      sha256: metadata.sha256,
      platform,
    });
    return {
      command: path.join(versionRoot, "bin", executableName(platform)),
      version: metadata.version,
      versionRoot,
      metadata: {
        schemaVersion: OPENAI_CODEX_SCHEMA_VERSION,
        version: metadata.version,
        target,
        sha256: metadata.sha256,
        installedAt: metadata.installedAt,
        checkedAt: metadata.checkedAt,
        ...(isStableVersion(metadata.latestVersion) ? { latestVersion: metadata.latestVersion } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Keep a previously selected OpenAI Codex from being pruned by this or another
 * PwrAgent process while this one may launch it. A command outside the install
 * root is not ours and is left alone.
 */
export async function retainOpenAiCodexCommand(
  command: string,
  options: RuntimeLocation = {},
): Promise<void> {
  const version = openAiCodexVersionForCommand(command, options);
  if (!version) return;
  const platform = options.platform ?? process.platform;
  const target = openAiCodexTarget(platform, options.arch ?? process.arch);
  const versionRoot = path.join(rootFor(options), "versions", version);
  const record = parseJson(
    await readFile(path.join(versionRoot, OPENAI_CODEX_INSTALL_RECORD_NAME), "utf8"),
    "OpenAI Codex install record",
  );
  if (!target || typeof record.sha256 !== "string") {
    throw new Error("Cached OpenAI Codex selection is no longer valid");
  }
  await validateInstalledVersion(versionRoot, { version, target, sha256: record.sha256, platform });
  await markInUse(versionRoot);
}

async function validateInstalledVersion(
  versionRoot: string,
  expected: { version: string; target: string; sha256: string; platform: NodeJS.Platform },
): Promise<void> {
  const record = parseJson(
    await readFile(path.join(versionRoot, OPENAI_CODEX_INSTALL_RECORD_NAME), "utf8"),
    "OpenAI Codex install record",
  );
  if (
    record.version !== expected.version
    || record.target !== expected.target
    || record.sha256 !== expected.sha256
  ) {
    throw new Error("The OpenAI Codex install record does not match its release.");
  }
  await validatePackageLayout(versionRoot, expected);
}

/**
 * The package's own manifest must name the release that was asked for, and
 * the files Codex needs at runtime must be regular files inside it.
 */
async function validatePackageLayout(
  directory: string,
  expected: { version: string; target: string; platform: NodeJS.Platform },
): Promise<void> {
  const manifest = parseJson(
    await readFile(path.join(directory, "codex-package.json"), "utf8"),
    "codex-package.json",
  );
  const suffix = expected.platform === "win32" ? ".exe" : "";
  if (
    manifest.layoutVersion !== 1
    || manifest.version !== expected.version
    || manifest.target !== expected.target
    || manifest.entrypoint !== `bin/codex${suffix}`
  ) {
    throw new Error("The Codex package does not match the expected OpenAI release.");
  }
  for (const relative of [`bin/codex${suffix}`, `codex-path/rg${suffix}`]) {
    const entry = await lstat(path.join(directory, relative)).catch(() => undefined);
    if (
      !entry
      || !entry.isFile()
      || entry.size === 0
      || (expected.platform !== "win32" && (entry.mode & 0o111) === 0)
    ) {
      throw new Error(`The Codex package is incomplete: ${relative}.`);
    }
  }
}

async function installRelease(
  root: string,
  release: OpenAiCodexRelease,
  now: number,
  options: OpenAiCodexRuntimeOptions,
  progress: ManagedRuntimeProgressReporter,
): Promise<OpenAiCodexRuntime> {
  options.signal?.throwIfAborted();
  const platform = options.platform ?? process.platform;
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, ".install-"));
  try {
    const archive = path.join(staging, release.archiveName);
    const actual = await downloadArchive(release, archive, options, progress);
    progress.verifying(release.version);
    if (actual !== release.sha256) {
      throw new Error(
        `Checksum mismatch for ${release.archiveName}: OpenAI published ${release.sha256}, the download was ${actual}. Nothing was installed.`,
      );
    }
    options.signal?.throwIfAborted();
    progress.unpacking(release.version);
    const unpacked = path.join(staging, "package");
    await mkdir(unpacked);
    await extractPackage(archive, unpacked);
    await validatePackageLayout(unpacked, { ...release, platform });
    options.signal?.throwIfAborted();
    progress.activating(release.version);
    const command = path.join(unpacked, "bin", executableName(platform));
    const output = (await (options.probeVersion ?? readVersionOutput)(command)).trim();
    if (output !== `codex-cli ${release.version}`) {
      throw new Error(
        `The downloaded Codex reported ${JSON.stringify(output)}; expected "codex-cli ${release.version}".`,
      );
    }
    await writeFile(
      path.join(unpacked, OPENAI_CODEX_INSTALL_RECORD_NAME),
      `${JSON.stringify({ version: release.version, target: release.target, sha256: release.sha256 }, null, 2)}\n`,
      { flag: "wx" },
    );
    options.signal?.throwIfAborted();
    const versionRoot = path.join(root, "versions", release.version);
    await publishVersion(unpacked, versionRoot, release, options);
    const metadata: OpenAiCodexMetadata = {
      schemaVersion: OPENAI_CODEX_SCHEMA_VERSION,
      version: release.version,
      target: release.target,
      sha256: release.sha256,
      installedAt: now,
      checkedAt: now,
      latestVersion: release.version,
    };
    await writeMetadata(root, metadata);
    return {
      command: path.join(versionRoot, "bin", executableName(platform)),
      version: release.version,
      versionRoot,
      metadata,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      log.warn("Could not clean up an OpenAI Codex staging directory");
    });
  }
}

/**
 * Move a verified package to its version directory. A directory already there
 * for the same release is kept as it is: another process may be running it.
 * One that fails validation is replaced only when no live process uses it.
 */
async function publishVersion(
  unpacked: string,
  versionRoot: string,
  release: OpenAiCodexRelease,
  options: OpenAiCodexRuntimeOptions,
): Promise<void> {
  const platform = options.platform ?? process.platform;
  await mkdir(path.dirname(versionRoot), { recursive: true });
  try {
    await validateInstalledVersion(versionRoot, { ...release, platform });
    return;
  } catch {
    // Missing or not this release: replace it below if nobody runs it.
  }
  if (await pathExists(versionRoot)) {
    if (await hasActiveRuntimeMarker(versionRoot, options.isProcessAlive ?? isProcessAlive)) {
      throw new Error(
        `Codex ${release.version} is already installed but does not match OpenAI's release, and a running PwrAgent still uses it. Quit PwrAgent and try again.`,
      );
    }
    await rm(versionRoot, { recursive: true, force: true });
  }
  try {
    await renameWithRetry(unpacked, versionRoot, platform);
  } catch (error) {
    // Another PwrAgent sharing this root may have published the same release
    // between the check above and the rename. Its copy is as good as ours.
    try {
      await validateInstalledVersion(versionRoot, { ...release, platform });
      return;
    } catch {
      throw error;
    }
  }
}

async function renameWithRetry(
  from: string,
  to: string,
  platform: NodeJS.Platform,
): Promise<void> {
  // Defender or process rundown can hold codex.exe briefly after --version exits.
  const attempts = platform === "win32" ? 20 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (attempt >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function downloadArchive(
  release: OpenAiCodexRelease,
  archive: string,
  options: OpenAiCodexRuntimeOptions,
  progress: ManagedRuntimeProgressReporter,
): Promise<string> {
  const signal = withTimeout(options.signal, OPENAI_CODEX_DOWNLOAD_TIMEOUT_MS);
  const response = await (options.fetch ?? globalThis.fetch)(release.url, {
    headers: { "User-Agent": "PwrAgent-openai-codex-install" },
    redirect: "follow",
    signal,
  });
  const contentLength = Number(response.headers.get("content-length"));
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Download failed with HTTP ${response.status} for ${release.url}.`);
  }
  if (Number.isFinite(contentLength) && contentLength > OPENAI_CODEX_MAX_ARCHIVE_BYTES) {
    await response.body.cancel();
    throw new Error("The Codex download is larger than PwrAgent allows.");
  }
  const onBytes = progress.downloading(
    release.version,
    Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined,
  );
  const hash = createHash("sha256");
  let received = 0;
  const body = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>, { signal });
  await pipeline(
    body,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > OPENAI_CODEX_MAX_ARCHIVE_BYTES) {
          throw new Error("The Codex download is larger than PwrAgent allows.");
        }
        hash.update(chunk);
        onBytes(chunk.length);
        yield chunk;
      }
    },
    createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  return hash.digest("hex");
}

/**
 * Unpack only regular files and directories at safe relative paths. `tar`
 * already refuses absolute and `..` paths; links and devices are refused here
 * so nothing in the package can point outside it.
 */
async function extractPackage(archive: string, directory: string): Promise<void> {
  let entries = 0;
  let unsafe: string | undefined;
  await extract({
    file: archive,
    cwd: directory,
    strict: true,
    preserveOwner: false,
    filter: (name, entry) => {
      entries += 1;
      const type = "type" in entry ? entry.type : undefined;
      const parts = name.replace(/\/$/u, "").split("/");
      if (
        entries > OPENAI_CODEX_MAX_ARCHIVE_ENTRIES
        || (type !== "File" && type !== "Directory")
        || name.startsWith("/")
        || name.includes("\\")
        || parts.some((part) => part === "" || part === "." || part === ".." || part.includes(":"))
      ) {
        unsafe ??= name;
        return false;
      }
      return true;
    },
  });
  if (unsafe !== undefined) {
    throw new Error(`The Codex archive contains an unsafe entry: ${JSON.stringify(unsafe)}.`);
  }
}

async function readVersionOutput(command: string): Promise<string> {
  const { stdout, stderr } = await execFile(command, ["--version"], {
    timeout: OPENAI_CODEX_VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout || stderr || "";
}

async function activateRuntime(
  root: string,
  runtime: OpenAiCodexRuntime,
  options: OpenAiCodexRuntimeOptions,
): Promise<OpenAiCodexRuntime> {
  try {
    await markInUse(runtime.versionRoot);
    await pruneVersions(root, runtime.version, options.isProcessAlive ?? isProcessAlive);
    await pruneStaleStaging(root, options.now?.() ?? Date.now());
  } catch (error) {
    log.warn("openai_codex_runtime_prune_failed", {
      error: error instanceof Error ? error.message : String(error),
      version: runtime.version,
    });
  }
  return runtime;
}

async function markInUse(versionRoot: string): Promise<void> {
  const marker = path.join(versionRoot, `.pwragent-use-${process.pid}`);
  if (await pathExists(marker)) return;
  await writeFile(marker, `${Date.now()}\n`);
}

async function pruneVersions(
  root: string,
  current: string,
  processAlive: (pid: number) => boolean,
): Promise<void> {
  const versionsRoot = path.join(root, "versions");
  const entries = (await readdir(versionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const inUse = new Set<string>();
  for (const name of entries) {
    if (name === current || !isStableVersion(name)) continue;
    if (await hasActiveRuntimeMarker(path.join(versionsRoot, name), processAlive)) inUse.add(name);
  }
  for (const name of selectPrunableOpenAiCodexVersions({ entries, current, inUse })) {
    await rm(path.join(versionsRoot, name), { recursive: true, force: true }).catch((error: unknown) => {
      log.warn("openai_codex_version_prune_failed", {
        error: error instanceof Error ? error.message : String(error),
        version: name,
      });
    });
  }
}

/** A staging directory left by a crashed or killed install. */
async function pruneStaleStaging(root: string, now: number): Promise<void> {
  for (const name of await readdir(root)) {
    if (!name.startsWith(".install-")) continue;
    const entry = await stat(path.join(root, name)).catch(() => undefined);
    if (entry && now - entry.mtimeMs >= OPENAI_CODEX_STALE_STAGING_MS) {
      await rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function writeMetadata(root: string, metadata: OpenAiCodexMetadata): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = path.join(root, `.${OPENAI_CODEX_METADATA_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path.join(root, OPENAI_CODEX_METADATA_NAME));
}

async function fetchSmallText(
  url: string,
  fetchOverride: typeof globalThis.fetch | undefined,
  signal: AbortSignal,
): Promise<string> {
  const response = await (fetchOverride ?? globalThis.fetch)(url, {
    headers: { "User-Agent": "PwrAgent-openai-codex-install" },
    redirect: "follow",
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Request failed with HTTP ${response.status} for ${url}.`);
  }
  const tooLarge = () => new Error(`Response from ${url} is larger than PwrAgent allows.`);
  if (Number(response.headers.get("content-length")) > OPENAI_CODEX_MAX_METADATA_BYTES) {
    await response.body.cancel();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of Readable.fromWeb(
    response.body as unknown as NodeReadableStream<Uint8Array>,
    { signal },
  )) {
    received += chunk.length;
    if (received > OPENAI_CODEX_MAX_METADATA_BYTES) throw tooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
