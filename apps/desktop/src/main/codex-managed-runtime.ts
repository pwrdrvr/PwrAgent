import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { getMainLogger } from "./log.js";
import { verifyMatchingPlatformSignature } from "./managed-runtime-signature.js";
import { resolvePwragentRoot } from "./profile.js";

const execFile = promisify(execFileCallback);
const managedCodexLog = getMainLogger("pwragent:codex-managed-runtime");

export const MANAGED_CODEX_REPOSITORY = "pwrdrvr/codex";
export const MANAGED_CODEX_RELEASES_URL =
  `https://api.github.com/repos/${MANAGED_CODEX_REPOSITORY}/releases?per_page=20`;
export const MANAGED_CODEX_RELEASES_FEED_URL =
  `https://github.com/${MANAGED_CODEX_REPOSITORY}/releases.atom`;
// The capability probe remains authoritative. This floor only prevents a
// pre-integration downstream tag from becoming a download candidate.
export const MANAGED_CODEX_MINIMUM_SIGNED_TAG =
  "pwragent-v0.146.0-pwragent.1";
export const MANAGED_CODEX_CHECK_TTL_MS = 24 * 60 * 60_000;
const MANAGED_CODEX_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MANAGED_CODEX_FETCH_TIMEOUT_MS = 5 * 60_000;
const MANAGED_CODEX_METADATA_VERSION = 1;

export type ManagedCodexCheckMode = "once-per-process" | "ttl" | "force";

type GithubReleaseAsset = {
  browser_download_url?: unknown;
  digest?: unknown;
  name?: unknown;
  size?: unknown;
};

type GithubRelease = {
  assets?: unknown;
  draft?: unknown;
  published_at?: unknown;
  tag_name?: unknown;
};

export type ManagedCodexRelease = {
  archive: {
    digest?: string;
    name: string;
    size?: number;
    url: string;
  };
  checksum: {
    name: string;
    url: string;
  };
  publishedAt?: string;
  tag: string;
};

export type ManagedCodexMetadata = {
  asset: string;
  checkedAt: number;
  installedAt: number;
  repository: string;
  schemaVersion: number;
  sha256: string;
  tag: string;
  version: string;
};

export type ManagedCodexRuntime = {
  appServerCommand: string;
  codeModeHostCommand: string;
  command: string;
  metadata: ManagedCodexMetadata;
};

type ManagedCodexRuntimeOptions = {
  applicationCommand?: string;
  arch?: NodeJS.Architecture;
  checkMode?: ManagedCodexCheckMode;
  extractArchive?: (archivePath: string, targetDir: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  platform?: NodeJS.Platform;
  probeVersion?: (command: string) => Promise<string>;
  requirePlatformSignature?: boolean;
  rootDir?: string;
  verifyPlatformSignature?: (
    command: string,
    applicationCommand: string,
    platform: NodeJS.Platform,
  ) => Promise<void>;
};

type BundleValidationOptions = {
  applicationCommand: string;
  platform: NodeJS.Platform;
  probeVersion?: ManagedCodexRuntimeOptions["probeVersion"];
  requirePlatformSignature: boolean;
  tag: string;
  verifyPlatformSignature?: ManagedCodexRuntimeOptions["verifyPlatformSignature"];
};

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const processChecks = new Set<string>();
const activeChecks = new Map<string, Promise<ManagedCodexRuntime>>();
const markedRuntimeCommands = new Map<string, string>();

/**
 * Resolve a verified PwrAgent Codex distribution, installing or updating it
 * when the selected check policy requires. A verified cache is the offline
 * fallback; the first install fails instead of selecting an arbitrary Codex.
 */
export async function ensureManagedCodexRuntime(
  options: ManagedCodexRuntimeOptions = {},
): Promise<ManagedCodexRuntime> {
  const rootDir = options.rootDir ?? path.join(
    resolvePwragentRoot(),
    "agents",
    "codex",
  );
  const existing = activeChecks.get(rootDir);
  if (existing) {
    return await existing;
  }
  const check = ensureManagedCodexRuntimeInner(rootDir, options)
    .finally(() => {
      if (activeChecks.get(rootDir) === check) {
        activeChecks.delete(rootDir);
      }
    });
  activeChecks.set(rootDir, check);
  return await check;
}

async function ensureManagedCodexRuntimeInner(
  rootDir: string,
  options: ManagedCodexRuntimeOptions,
): Promise<ManagedCodexRuntime> {
  const now = options.now?.() ?? Date.now();
  const cached = await readCachedRuntime(rootDir, options);
  const checkMode = options.checkMode ?? "ttl";
  if (
    (checkMode === "once-per-process" && processChecks.has(rootDir))
    || (
      checkMode === "ttl"
      && cached
      && now - cached.metadata.checkedAt < MANAGED_CODEX_CHECK_TTL_MS
    )
  ) {
    if (!cached) {
      throw new Error("No verified managed Codex runtime is installed.");
    }
    return await activateRuntime(rootDir, cached, options);
  }

  processChecks.add(rootDir);
  try {
    const release = await fetchLatestCompatibleRelease(options);
    if (!release) {
      throw new Error("No compatible complete PwrAgent Codex release was found.");
    }
    if (cached?.metadata.tag === release.tag) {
      const metadata = { ...cached.metadata, checkedAt: now };
      await writeMetadata(rootDir, metadata);
      return await activateRuntime(
        rootDir,
        { ...cached, metadata },
        options,
      );
    }
    const runtime = await installRelease(rootDir, release, now, options);
    managedCodexLog.info("managed_codex_runtime_installed", {
      asset: runtime.metadata.asset,
      command: runtime.command,
      tag: runtime.metadata.tag,
    });
    return await activateRuntime(rootDir, runtime, options);
  } catch (error) {
    managedCodexLog.warn("managed_codex_runtime_update_failed", {
      error: error instanceof Error ? error.message : String(error),
      usingCachedTag: cached?.metadata.tag,
    });
    if (cached) {
      return await activateRuntime(rootDir, cached, options);
    }
    throw error;
  }
}

async function fetchLatestCompatibleRelease(
  options: ManagedCodexRuntimeOptions,
): Promise<ManagedCodexRelease | undefined> {
  const assetPlatform = managedCodexAssetPlatform(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  if (!assetPlatform) {
    return undefined;
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(MANAGED_CODEX_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "PwrAgent-managed-codex-runtime",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(MANAGED_CODEX_FETCH_TIMEOUT_MS),
  });
  if (response.ok) {
    const releases = await response.json();
    if (!Array.isArray(releases)) {
      throw new Error("GitHub release check returned an invalid response.");
    }
    return selectManagedCodexRelease(releases, assetPlatform);
  }
  if (response.status !== 403 && response.status !== 429) {
    throw new Error(
      `GitHub release check failed with HTTP ${response.status}.`,
    );
  }

  const feedResponse = await fetchImpl(MANAGED_CODEX_RELEASES_FEED_URL, {
    headers: { "User-Agent": "PwrAgent-managed-codex-runtime" },
    signal: AbortSignal.timeout(MANAGED_CODEX_FETCH_TIMEOUT_MS),
  });
  if (!feedResponse.ok) {
    throw new Error(
      `GitHub release feed failed with HTTP ${feedResponse.status} after API HTTP ${response.status}.`,
    );
  }
  return selectManagedCodexReleaseFromFeed(
    await feedResponse.text(),
    assetPlatform,
  );
}

export function selectManagedCodexRelease(
  releases: GithubRelease[],
  assetPlatform: string,
): ManagedCodexRelease | undefined {
  for (const release of releases) {
    const tag = typeof release.tag_name === "string"
      ? release.tag_name.trim()
      : "";
    if (
      release.draft === true
      || !isManagedCodexTagEligible(tag)
      || !Array.isArray(release.assets)
    ) {
      continue;
    }
    const assets = release.assets as GithubReleaseAsset[];
    const checksum = normalizedAsset(
      assets.find((asset) => asset.name === "SHA256SUMS"),
    );
    const archive = normalizedAsset(
      assets.find((asset) =>
        typeof asset.name === "string"
        && asset.name === managedCodexArchiveName(tag, assetPlatform),
      ),
    );
    if (!checksum || !archive) {
      continue;
    }
    return {
      archive,
      checksum,
      ...(typeof release.published_at === "string"
        ? { publishedAt: release.published_at }
        : {}),
      tag,
    };
  }
  return undefined;
}

export function selectManagedCodexReleaseFromFeed(
  feed: string,
  assetPlatform: string,
): ManagedCodexRelease | undefined {
  const linkPattern = new RegExp(
    `https://github\\.com/${MANAGED_CODEX_REPOSITORY}/releases/tag/`
      + "(pwragent-v[0-9A-Za-z][0-9A-Za-z.+-]*)",
    "gu",
  );
  for (const match of feed.matchAll(linkPattern)) {
    const tag = match[1];
    if (!isManagedCodexTagEligible(tag)) {
      continue;
    }
    const assetName = managedCodexArchiveName(tag, assetPlatform);
    const releaseBase =
      `https://github.com/${MANAGED_CODEX_REPOSITORY}/releases/download/${tag}`;
    return {
      archive: {
        name: assetName,
        url: `${releaseBase}/${assetName}`,
      },
      checksum: {
        name: "SHA256SUMS",
        url: `${releaseBase}/SHA256SUMS`,
      },
      tag,
    };
  }
  return undefined;
}

export function isManagedCodexTagEligible(tag: string): boolean {
  if (!isManagedCodexTag(tag)) {
    return false;
  }
  const candidate = parseManagedCodexSemver(tag);
  const minimum = parseManagedCodexSemver(MANAGED_CODEX_MINIMUM_SIGNED_TAG);
  return Boolean(
    candidate
    && minimum
    && compareParsedSemver(candidate, minimum) >= 0,
  );
}

function isManagedCodexTag(tag: string): boolean {
  return (
    /-pwragent\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z.-]+)?$/u.test(tag)
    && parseManagedCodexSemver(tag) !== undefined
  );
}

function managedCodexArchiveName(tag: string, assetPlatform: string): string {
  const version = tag.slice("pwragent-v".length);
  const extension = assetPlatform === "windows-x86_64" ? "zip" : "tar.gz";
  return `pwragent-codex-${version}-${assetPlatform}.${extension}`;
}

function parseManagedCodexSemver(tag: string): ParsedSemver | undefined {
  const match = /^pwragent-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
    tag,
  );
  if (!match) {
    return undefined;
  }
  const core = match.slice(1, 4).map((part) => Number(part));
  if (core.some((part) => !Number.isSafeInteger(part))) {
    return undefined;
  }
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some((part) =>
      /^[0-9]+$/u.test(part)
      && /^0[0-9]+$/u.test(part),
    )
  ) {
    return undefined;
  }
  return {
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease,
  };
}

function compareParsedSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^[0-9]+$/u.test(leftPart);
    const rightNumeric = /^[0-9]+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function normalizedAsset(
  asset: GithubReleaseAsset | undefined,
): ManagedCodexRelease["archive"] | undefined {
  if (
    !asset
    || typeof asset.name !== "string"
    || path.basename(asset.name) !== asset.name
    || typeof asset.browser_download_url !== "string"
    || !asset.browser_download_url.startsWith(
      `https://github.com/${MANAGED_CODEX_REPOSITORY}/releases/download/`,
    )
  ) {
    return undefined;
  }
  const digest = typeof asset.digest === "string"
    && /^sha256:[0-9a-f]{64}$/iu.test(asset.digest)
      ? asset.digest.slice("sha256:".length).toLowerCase()
      : undefined;
  return {
    name: asset.name,
    url: asset.browser_download_url,
    ...(digest ? { digest } : {}),
    ...(typeof asset.size === "number" ? { size: asset.size } : {}),
  };
}

async function installRelease(
  rootDir: string,
  release: ManagedCodexRelease,
  now: number,
  options: ManagedCodexRuntimeOptions,
): Promise<ManagedCodexRuntime> {
  await mkdir(rootDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(rootDir, ".install-"));
  try {
    const archivePath = path.join(stagingRoot, release.archive.name);
    const checksumPath = path.join(stagingRoot, release.checksum.name);
    await downloadFile(release.checksum.url, checksumPath, options.fetch);
    await downloadFile(release.archive.url, archivePath, options.fetch);
    const checksumText = await readFile(checksumPath, "utf8");
    const expected = expectedChecksum(checksumText, release.archive.name);
    if (release.archive.digest && release.archive.digest !== expected) {
      throw new Error(
        `Release digest disagrees with SHA256SUMS for ${release.archive.name}.`,
      );
    }
    const actual = await sha256(archivePath);
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${release.archive.name}: expected ${expected}, got ${actual}.`,
      );
    }

    const extractedRoot = path.join(stagingRoot, "extracted");
    await mkdir(extractedRoot);
    await (options.extractArchive ?? extractArchive)(archivePath, extractedRoot);
    const validationOptions = {
      ...bundleValidationOptions(options),
      tag: release.tag,
    };
    const staged = await validateExtractedBundle(
      extractedRoot,
      validationOptions,
    );
    const versionRoot = path.join(rootDir, "versions", release.tag);
    await mkdir(path.dirname(versionRoot), { recursive: true });
    await activateExtractedVersion(
      extractedRoot,
      versionRoot,
      validationOptions,
    );
    const version = versionForTag(release.tag);
    const metadata: ManagedCodexMetadata = {
      asset: release.archive.name,
      checkedAt: now,
      installedAt: now,
      repository: MANAGED_CODEX_REPOSITORY,
      schemaVersion: MANAGED_CODEX_METADATA_VERSION,
      sha256: actual,
      tag: release.tag,
      version,
    };
    await writeMetadata(rootDir, metadata);
    return runtimeAtRoot(versionRoot, metadata, staged.platform);
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

async function activateExtractedVersion(
  extractedRoot: string,
  versionRoot: string,
  validationOptions: BundleValidationOptions,
): Promise<void> {
  const displacedRoot = `${versionRoot}.replaced-${process.pid}-${Date.now()}`;
  let displaced = false;
  try {
    try {
      await rename(versionRoot, displacedRoot);
      displaced = true;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
    try {
      await rename(extractedRoot, versionRoot);
    } catch (error) {
      if (existsSync(versionRoot)) {
        try {
          await validateExtractedBundle(versionRoot, validationOptions);
          return;
        } catch {
          // Restore the displaced directory below when possible.
        }
      }
      if (displaced && !existsSync(versionRoot)) {
        await rename(displacedRoot, versionRoot);
        displaced = false;
      }
      throw error;
    }
  } finally {
    if (displaced) {
      try {
        await rm(displacedRoot, { force: true, recursive: true });
      } catch (error) {
        managedCodexLog.warn("managed_codex_displaced_cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
          displacedRoot,
        });
      }
    }
  }
}

async function downloadFile(
  url: string,
  targetPath: string,
  fetchOverride: typeof globalThis.fetch | undefined,
): Promise<void> {
  const response = await (fetchOverride ?? globalThis.fetch)(url, {
    headers: { "User-Agent": "PwrAgent-managed-codex-runtime" },
    redirect: "follow",
    signal: AbortSignal.timeout(MANAGED_CODEX_FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status} for ${url}.`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength)
    && contentLength > MANAGED_CODEX_MAX_ARCHIVE_BYTES
  ) {
    throw new Error(`Download exceeds the managed Codex size limit: ${url}.`);
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MANAGED_CODEX_MAX_ARCHIVE_BYTES) {
        callback(
          new Error(`Download exceeds the managed Codex size limit: ${url}.`),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  const body = Readable.fromWeb(
    response.body as unknown as NodeReadableStream<Uint8Array>,
  );
  await pipeline(body, limiter, createWriteStream(targetPath, { flags: "wx" }));
}

async function extractArchive(
  archivePath: string,
  targetDir: string,
): Promise<void> {
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  await execFile(tar, ["-xf", archivePath, "-C", targetDir], {
    timeout: MANAGED_CODEX_FETCH_TIMEOUT_MS,
  });
}

async function validateExtractedBundle(
  directory: string,
  options: BundleValidationOptions,
): Promise<{ platform: NodeJS.Platform }> {
  const executableNames = managedCodexExecutableNames(options.platform);
  const requiredFiles = [
    ...executableNames,
    "LICENSE",
    "NOTICE",
    "PWRAGENT-BUILD.txt",
  ].map((entry) => path.join(directory, entry));
  const realDirectory = await realpath(directory);
  for (const requiredFile of requiredFiles) {
    const entry = await lstat(requiredFile);
    const realFile = await realpath(requiredFile);
    if (
      !entry.isFile()
      || (
        realFile !== realDirectory
        && !realFile.startsWith(`${realDirectory}${path.sep}`)
      )
    ) {
      throw new Error(
        `Managed Codex bundle entry is not a file: ${requiredFile}.`,
      );
    }
  }

  const executablePaths = executableNames.map((entry) =>
    path.join(directory, entry),
  );
  if (options.platform !== "win32") {
    await Promise.all(executablePaths.map(async (command) =>
      await chmod(command, 0o755),
    ));
  }
  if (
    options.requirePlatformSignature
    && (options.platform === "darwin" || options.platform === "win32")
  ) {
    const verify = options.verifyPlatformSignature
      ?? verifyMatchingPlatformSignature;
    for (const command of executablePaths) {
      await verify(command, options.applicationCommand, options.platform);
    }
  }

  const expectedVersion = versionForTag(options.tag);
  const banners = expectedCodexVersionBanners(options.platform, expectedVersion);
  for (const [name, banner] of banners) {
    const command = path.join(directory, name);
    const output = options.probeVersion
      ? await options.probeVersion(command)
      : await readVersionOutput(command);
    if (output.trim() !== banner) {
      throw new Error(
        `Managed Codex executable ${name} reported ${JSON.stringify(output.trim())}; expected ${JSON.stringify(banner)}.`,
      );
    }
  }
  return { platform: options.platform };
}

function managedCodexExecutableNames(platform: NodeJS.Platform): string[] {
  const suffix = platform === "win32" ? ".exe" : "";
  return [
    `codex${suffix}`,
    `codex-app-server${suffix}`,
    `codex-code-mode-host${suffix}`,
    ...(platform === "win32"
      ? ["codex-windows-sandbox-setup.exe", "codex-command-runner.exe"]
      : []),
  ];
}

function expectedCodexVersionBanners(
  platform: NodeJS.Platform,
  version: string,
): Array<[string, string]> {
  const suffix = platform === "win32" ? ".exe" : "";
  return [
    [`codex${suffix}`, `codex-cli ${version}`],
    [`codex-app-server${suffix}`, `codex-app-server ${version}`],
    [`codex-code-mode-host${suffix}`, `codex-code-mode-host ${version}`],
  ];
}

function runtimeAtRoot(
  versionRoot: string,
  metadata: ManagedCodexMetadata,
  platform: NodeJS.Platform,
): ManagedCodexRuntime {
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    appServerCommand: path.join(versionRoot, `codex-app-server${suffix}`),
    codeModeHostCommand: path.join(
      versionRoot,
      `codex-code-mode-host${suffix}`,
    ),
    command: path.join(versionRoot, `codex${suffix}`),
    metadata,
  };
}

function bundleValidationOptions(
  options: ManagedCodexRuntimeOptions,
): Omit<BundleValidationOptions, "tag"> {
  return {
    applicationCommand: options.applicationCommand ?? process.execPath,
    platform: options.platform ?? process.platform,
    ...(options.probeVersion ? { probeVersion: options.probeVersion } : {}),
    requirePlatformSignature: options.requirePlatformSignature === true,
    ...(options.verifyPlatformSignature
      ? { verifyPlatformSignature: options.verifyPlatformSignature }
      : {}),
  };
}

async function readVersionOutput(command: string): Promise<string> {
  const version = await execFile(command, ["--version"], { timeout: 20_000 });
  return `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
}

function expectedChecksum(checksumText: string, assetName: string): string {
  for (const line of checksumText.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`SHA256SUMS does not contain ${assetName}.`);
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function readCachedRuntime(
  rootDir: string,
  options: ManagedCodexRuntimeOptions,
): Promise<ManagedCodexRuntime | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(path.join(rootDir, "managed-release.json"), "utf8"),
    ) as Partial<ManagedCodexMetadata>;
    if (
      metadata.schemaVersion !== MANAGED_CODEX_METADATA_VERSION
      || metadata.repository !== MANAGED_CODEX_REPOSITORY
      || typeof metadata.tag !== "string"
      || !isManagedCodexTagEligible(metadata.tag)
      || typeof metadata.asset !== "string"
      || typeof metadata.sha256 !== "string"
      || typeof metadata.checkedAt !== "number"
      || typeof metadata.installedAt !== "number"
      || metadata.version !== versionForTag(metadata.tag)
    ) {
      return undefined;
    }
    const platform = options.platform ?? process.platform;
    const assetPlatform = managedCodexAssetPlatform(
      platform,
      options.arch ?? process.arch,
    );
    if (
      !assetPlatform
      || metadata.asset !== managedCodexArchiveName(metadata.tag, assetPlatform)
    ) {
      return undefined;
    }
    const versionRoot = path.join(rootDir, "versions", metadata.tag);
    await validateExtractedBundle(versionRoot, {
      ...bundleValidationOptions(options),
      tag: metadata.tag,
    });
    return runtimeAtRoot(
      versionRoot,
      metadata as ManagedCodexMetadata,
      platform,
    );
  } catch {
    return undefined;
  }
}

async function activateRuntime(
  rootDir: string,
  runtime: ManagedCodexRuntime,
  options: ManagedCodexRuntimeOptions,
): Promise<ManagedCodexRuntime> {
  try {
    await markRuntimeInUse(rootDir, runtime.command);
    await pruneSupersededVersions(
      rootDir,
      runtime.metadata.tag,
      options.isProcessAlive ?? isProcessAlive,
    );
  } catch (error) {
    managedCodexLog.warn("managed_codex_runtime_prune_failed", {
      error: error instanceof Error ? error.message : String(error),
      tag: runtime.metadata.tag,
    });
  }
  return runtime;
}

async function markRuntimeInUse(
  rootDir: string,
  command: string,
): Promise<void> {
  const markerPath = path.join(
    path.dirname(command),
    `.pwragent-use-${process.pid}`,
  );
  if (
    markedRuntimeCommands.get(rootDir) === command
    && existsSync(markerPath)
  ) {
    return;
  }
  await writeFile(markerPath, `${Date.now()}\n`);
  markedRuntimeCommands.set(rootDir, command);
}

async function pruneSupersededVersions(
  rootDir: string,
  currentTag: string,
  processAlive: (pid: number) => boolean,
): Promise<void> {
  const versionsRoot = path.join(rootDir, "versions");
  const entries = await readdir(versionsRoot, { withFileTypes: true });
  const superseded = entries
    .filter((entry) =>
      entry.isDirectory()
      && entry.name !== currentTag
      && isManagedCodexTag(entry.name),
    )
    .sort((left, right) => {
      const leftVersion = parseManagedCodexSemver(left.name);
      const rightVersion = parseManagedCodexSemver(right.name);
      if (!leftVersion || !rightVersion) {
        return 0;
      }
      return compareParsedSemver(rightVersion, leftVersion);
    });
  const compatibilityTag = superseded[0]?.name;
  for (const entry of superseded) {
    const versionRoot = path.join(versionsRoot, entry.name);
    const active = await hasActiveRuntimeMarker(versionRoot, processAlive);
    if (active || entry.name === compatibilityTag) {
      continue;
    }
    try {
      await rm(versionRoot, { force: true, recursive: true });
    } catch (error) {
      managedCodexLog.warn("managed_codex_version_prune_failed", {
        error: error instanceof Error ? error.message : String(error),
        tag: entry.name,
      });
    }
  }
}

async function hasActiveRuntimeMarker(
  versionRoot: string,
  processAlive: (pid: number) => boolean,
): Promise<boolean> {
  const entries = await readdir(versionRoot, { withFileTypes: true });
  let active = false;
  for (const entry of entries) {
    const match = entry.isFile()
      ? /^\.pwragent-use-([1-9][0-9]*)$/u.exec(entry.name)
      : undefined;
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (
      Number.isSafeInteger(pid)
      && pid !== process.pid
      && processAlive(pid)
    ) {
      active = true;
      continue;
    }
    await rm(path.join(versionRoot, entry.name), { force: true });
  }
  return active;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFileSystemError(error, "EPERM");
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function writeMetadata(
  rootDir: string,
  metadata: ManagedCodexMetadata,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  const temporaryPath = path.join(
    rootDir,
    `.managed-release-${process.pid}-${Date.now()}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporaryPath, path.join(rootDir, "managed-release.json"));
}

function versionForTag(tag: string): string {
  return tag.slice("pwragent-v".length);
}

export function managedCodexAssetPlatform(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | undefined {
  if (platform === "darwin" && arch === "arm64") {
    return "macos-aarch64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "macos-x86_64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x86_64";
  }
  if (platform === "linux" && arch === "arm64") {
    return "linux-aarch64";
  }
  if (platform === "win32" && arch === "x64") {
    return "windows-x86_64";
  }
  return undefined;
}

