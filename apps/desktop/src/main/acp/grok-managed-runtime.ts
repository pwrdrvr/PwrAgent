import { createHash } from "node:crypto";
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
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolvePwragentRoot } from "../profile.js";
import { getMainLogger } from "../log.js";

const execFile = promisify(execFileCallback);
const managedGrokLog = getMainLogger("pwragent:grok-managed-runtime");

export const MANAGED_GROK_REPOSITORY = "pwrdrvr/grok-build";
export const MANAGED_GROK_RELEASES_URL =
  `https://api.github.com/repos/${MANAGED_GROK_REPOSITORY}/releases?per_page=20`;
export const MANAGED_GROK_RELEASES_FEED_URL =
  `https://github.com/${MANAGED_GROK_REPOSITORY}/releases.atom`;
export const MANAGED_GROK_MINIMUM_SIGNED_TAG =
  "pwragent-v1.0.4-pwragent.2";
export const MANAGED_GROK_CHECK_TTL_MS = 24 * 60 * 60_000;
const MANAGED_GROK_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MANAGED_GROK_FETCH_TIMEOUT_MS = 5 * 60_000;
const MANAGED_GROK_METADATA_VERSION = 1;

export type ManagedGrokCheckMode = "once-per-process" | "ttl" | "force";

type GithubReleaseAsset = {
  browser_download_url?: unknown;
  digest?: unknown;
  name?: unknown;
  size?: unknown;
};

type GithubRelease = {
  assets?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  tag_name?: unknown;
};

type ManagedGrokRelease = {
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

type ManagedGrokMetadata = {
  asset: string;
  checkedAt: number;
  installedAt: number;
  repository: string;
  schemaVersion: number;
  sha256: string;
  tag: string;
};

export type ManagedGrokRuntime = {
  command: string;
  metadata: ManagedGrokMetadata;
};

type ManagedGrokRuntimeOptions = {
  applicationCommand?: string;
  arch?: NodeJS.Architecture;
  checkMode?: ManagedGrokCheckMode;
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
  probeVersion?: (command: string) => Promise<string>;
  requirePlatformSignature: boolean;
  verifyPlatformSignature?: ManagedGrokRuntimeOptions["verifyPlatformSignature"];
};

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const processChecks = new Set<string>();
const activeChecks = new Map<string, Promise<ManagedGrokRuntime | undefined>>();
const markedRuntimeCommands = new Map<string, string>();

export async function ensureManagedGrokRuntime(
  options: ManagedGrokRuntimeOptions = {},
): Promise<ManagedGrokRuntime | undefined> {
  const rootDir = options.rootDir ?? path.join(
    resolvePwragentRoot(),
    "agents",
    "grok",
  );
  const existing = activeChecks.get(rootDir);
  if (existing) {
    return await existing;
  }
  const check = ensureManagedGrokRuntimeInner(rootDir, options)
    .finally(() => {
      if (activeChecks.get(rootDir) === check) {
        activeChecks.delete(rootDir);
      }
    });
  activeChecks.set(rootDir, check);
  return await check;
}

async function ensureManagedGrokRuntimeInner(
  rootDir: string,
  options: ManagedGrokRuntimeOptions,
): Promise<ManagedGrokRuntime | undefined> {
  const now = options.now?.() ?? Date.now();
  const cached = await readCachedRuntime(rootDir, options);
  const checkMode = options.checkMode ?? "ttl";
  if (
    (checkMode === "once-per-process" && processChecks.has(rootDir))
    || (
      checkMode === "ttl"
      && cached
      && now - cached.metadata.checkedAt < MANAGED_GROK_CHECK_TTL_MS
    )
  ) {
    return cached
      ? await activateRuntime(rootDir, cached, options)
      : undefined;
  }

  processChecks.add(rootDir);
  try {
    const release = await fetchLatestCompatibleRelease(options);
    if (!release) {
      throw new Error("No compatible complete PwrAgent Grok release was found");
    }
    if (cached?.metadata.tag === release.tag) {
      const metadata = { ...cached.metadata, checkedAt: now };
      await writeMetadata(rootDir, metadata);
      return await activateRuntime(
        rootDir,
        { command: cached.command, metadata },
        options,
      );
    }
    const runtime = await installRelease(rootDir, release, now, options);
    managedGrokLog.info("managed_grok_runtime_installed", {
      asset: runtime.metadata.asset,
      command: runtime.command,
      tag: runtime.metadata.tag,
    });
    return await activateRuntime(rootDir, runtime, options);
  } catch (error) {
    managedGrokLog.warn("managed_grok_runtime_update_failed", {
      error: error instanceof Error ? error.message : String(error),
      usingCachedTag: cached?.metadata.tag,
    });
    return cached
      ? await activateRuntime(rootDir, cached, options)
      : undefined;
  }
}

async function fetchLatestCompatibleRelease(
  options: ManagedGrokRuntimeOptions,
): Promise<ManagedGrokRelease | undefined> {
  const assetPlatform = managedGrokAssetPlatform(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  if (!assetPlatform) {
    return undefined;
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(MANAGED_GROK_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "PwrAgent-managed-grok-runtime",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(MANAGED_GROK_FETCH_TIMEOUT_MS),
  });
  if (response.ok) {
    const releases = await response.json();
    if (!Array.isArray(releases)) {
      throw new Error("GitHub release check returned an invalid response");
    }
    return selectManagedGrokRelease(releases, assetPlatform);
  }
  if (response.status !== 403 && response.status !== 429) {
    throw new Error(`GitHub release check failed with HTTP ${response.status}`);
  }

  // The unauthenticated REST budget is shared by public-IP address and is easy
  // for a busy office or CI fleet to exhaust. GitHub's public Atom feed carries
  // the same ordered release tags without requiring an API token.
  const feedResponse = await fetchImpl(MANAGED_GROK_RELEASES_FEED_URL, {
    headers: { "User-Agent": "PwrAgent-managed-grok-runtime" },
    signal: AbortSignal.timeout(MANAGED_GROK_FETCH_TIMEOUT_MS),
  });
  if (!feedResponse.ok) {
    throw new Error(
      `GitHub release feed failed with HTTP ${feedResponse.status} after API HTTP ${response.status}`,
    );
  }
  return selectManagedGrokReleaseFromFeed(
    await feedResponse.text(),
    assetPlatform,
  );
}

export function selectManagedGrokRelease(
  releases: GithubRelease[],
  assetPlatform: string,
): ManagedGrokRelease | undefined {
  for (const release of releases) {
    const tag = typeof release.tag_name === "string"
      ? release.tag_name.trim()
      : "";
    if (
      release.draft === true
      || !isManagedGrokTagEligible(tag)
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
        && asset.name === managedGrokArchiveName(tag, assetPlatform),
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

export function selectManagedGrokReleaseFromFeed(
  feed: string,
  assetPlatform: string,
): ManagedGrokRelease | undefined {
  const linkPattern = new RegExp(
    `https://github\\.com/${MANAGED_GROK_REPOSITORY}/releases/tag/`
      + "(pwragent-v[0-9A-Za-z][0-9A-Za-z.+-]*)",
    "gu",
  );
  for (const match of feed.matchAll(linkPattern)) {
    const tag = match[1];
    if (!isManagedGrokTagEligible(tag)) {
      continue;
    }
    const assetName = managedGrokArchiveName(tag, assetPlatform);
    const releaseBase =
      `https://github.com/${MANAGED_GROK_REPOSITORY}/releases/download/${tag}`;
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

export function isManagedGrokTagEligible(tag: string): boolean {
  if (!isManagedGrokTag(tag)) {
    return false;
  }
  const candidate = parseManagedGrokSemver(tag);
  const minimum = parseManagedGrokSemver(MANAGED_GROK_MINIMUM_SIGNED_TAG);
  return Boolean(
    candidate
    && minimum
    && compareParsedSemver(candidate, minimum) >= 0,
  );
}

function isManagedGrokTag(tag: string): boolean {
  return (
    /-pwragent\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z.-]+)?$/u.test(tag)
    && parseManagedGrokSemver(tag) !== undefined
  );
}

function managedGrokArchiveName(tag: string, assetPlatform: string): string {
  const version = tag.slice("pwragent-v".length);
  const extension = assetPlatform === "windows-x86_64" ? "zip" : "tar.gz";
  return `pwragent-grok-${version}-${assetPlatform}.${extension}`;
}

function parseManagedGrokSemver(tag: string): ParsedSemver | undefined {
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
      && /^0[0-9]+$/u.test(part)
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
): ManagedGrokRelease["archive"] | undefined {
  if (
    !asset
    || typeof asset.name !== "string"
    || path.basename(asset.name) !== asset.name
    || typeof asset.browser_download_url !== "string"
    || !asset.browser_download_url.startsWith(
      `https://github.com/${MANAGED_GROK_REPOSITORY}/releases/download/`,
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
  release: ManagedGrokRelease,
  now: number,
  options: ManagedGrokRuntimeOptions,
): Promise<ManagedGrokRuntime> {
  await mkdir(rootDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(rootDir, ".install-"));
  try {
    const archivePath = path.join(stagingRoot, release.archive.name);
    const checksumPath = path.join(stagingRoot, release.checksum.name);
    // Fetch the tiny publication marker first. An in-progress release can
    // expose its tag before every asset is ready; do not start a 50–130 MB
    // archive download until SHA256SUMS proves the release is complete.
    await downloadFile(release.checksum.url, checksumPath, options.fetch);
    await downloadFile(release.archive.url, archivePath, options.fetch);
    const checksumText = await readFile(checksumPath, "utf8");
    const expected = expectedChecksum(checksumText, release.archive.name);
    if (release.archive.digest && release.archive.digest !== expected) {
      throw new Error(
        `Release digest disagrees with SHA256SUMS for ${release.archive.name}`,
      );
    }
    const actual = await sha256(archivePath);
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${release.archive.name}: expected ${expected}, got ${actual}`,
      );
    }

    const extractedRoot = path.join(stagingRoot, "extracted");
    await mkdir(extractedRoot);
    await (options.extractArchive ?? extractArchive)(archivePath, extractedRoot);
    const validationOptions = bundleValidationOptions(options);
    const command = await validateExtractedBundle(
      extractedRoot,
      validationOptions,
    );
    const versionRoot = path.join(rootDir, "versions", release.tag);
    await mkdir(path.dirname(versionRoot), { recursive: true });
    const installedCommand = await activateExtractedVersion(
      extractedRoot,
      versionRoot,
      path.basename(command),
      validationOptions,
    );
    const metadata: ManagedGrokMetadata = {
      asset: release.archive.name,
      checkedAt: now,
      installedAt: now,
      repository: MANAGED_GROK_REPOSITORY,
      schemaVersion: MANAGED_GROK_METADATA_VERSION,
      sha256: actual,
      tag: release.tag,
    };
    await writeMetadata(rootDir, metadata);
    return { command: installedCommand, metadata };
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

async function activateExtractedVersion(
  extractedRoot: string,
  versionRoot: string,
  executable: string,
  validationOptions: BundleValidationOptions,
): Promise<string> {
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
      // Another PwrAgent process may have completed the same immutable-tag
      // install after our initial check. Accept it only after full validation.
      if (existsSync(versionRoot)) {
        try {
          return await validateExtractedBundle(versionRoot, validationOptions);
        } catch {
          // Fall through and restore the displaced directory when possible.
        }
      }
      if (displaced && !existsSync(versionRoot)) {
        await rename(displacedRoot, versionRoot);
        displaced = false;
      }
      throw error;
    }
    return path.join(versionRoot, executable);
  } finally {
    if (displaced) {
      try {
        await rm(displacedRoot, { force: true, recursive: true });
      } catch (error) {
        managedGrokLog.warn("managed_grok_displaced_version_cleanup_failed", {
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
    headers: { "User-Agent": "PwrAgent-managed-grok-runtime" },
    redirect: "follow",
    signal: AbortSignal.timeout(MANAGED_GROK_FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status} for ${url}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength)
    && contentLength > MANAGED_GROK_MAX_ARCHIVE_BYTES
  ) {
    throw new Error(`Download exceeds the managed Grok size limit: ${url}`);
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MANAGED_GROK_MAX_ARCHIVE_BYTES) {
        callback(new Error(`Download exceeds the managed Grok size limit: ${url}`));
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
    timeout: MANAGED_GROK_FETCH_TIMEOUT_MS,
  });
}

async function validateExtractedBundle(
  directory: string,
  options: BundleValidationOptions,
): Promise<string> {
  const executable = options.platform === "win32" ? "grok.exe" : "grok";
  const command = path.join(directory, executable);
  const requiredFiles = [
    command,
    path.join(directory, "LICENSE"),
    path.join(directory, "THIRD-PARTY-NOTICES"),
    path.join(directory, "SOURCE_REV"),
    path.join(directory, "PWRAGENT-BUILD.txt"),
  ];
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
      throw new Error(`Managed Grok bundle entry is not a file: ${requiredFile}`);
    }
  }
  if (options.platform !== "win32") {
    await chmod(command, 0o755);
  }
  if (
    options.requirePlatformSignature
    && (options.platform === "darwin" || options.platform === "win32")
  ) {
    await (
      options.verifyPlatformSignature ?? verifyMatchingPlatformSignature
    )(
      command,
      options.applicationCommand,
      options.platform,
    );
  }
  const versionOutput = options.probeVersion
    ? await options.probeVersion(command)
    : await readVersionOutput(command);
  if (!/\bgrok\b/iu.test(versionOutput)) {
    throw new Error("Managed Grok executable returned an invalid version banner");
  }
  return command;
}

async function verifyMatchingPlatformSignature(
  command: string,
  applicationCommand: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "darwin") {
    await execFile("codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      applicationCommand,
    ]);
    const applicationSignature = await execFile("codesign", [
      "--display",
      "--verbose=4",
      applicationCommand,
    ]);
    const signatureDetails =
      `${applicationSignature.stdout ?? ""}\n${applicationSignature.stderr ?? ""}`;
    const teamIdentifier = /^TeamIdentifier=([A-Z0-9]+)$/mu.exec(
      signatureDetails,
    )?.[1];
    if (!teamIdentifier) {
      throw new Error("Signed PwrAgent executable has no Apple team identifier");
    }
    await execFile("codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      "--test-requirement",
      `=anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`,
      command,
    ]);
    return;
  }

  if (platform === "win32") {
    await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$application = Get-AuthenticodeSignature -LiteralPath $args[0]",
        "$runtime = Get-AuthenticodeSignature -LiteralPath $args[1]",
        "if ($application.Status -ne 'Valid' -or $runtime.Status -ne 'Valid') { exit 1 }",
        "if ($null -eq $application.SignerCertificate -or $null -eq $runtime.SignerCertificate) { exit 1 }",
        "if ($runtime.SignerCertificate.Subject -cne $application.SignerCertificate.Subject) { exit 1 }",
        "if ($runtime.SignerCertificate.Issuer -cne $application.SignerCertificate.Issuer) { exit 1 }",
      ].join("; "),
      applicationCommand,
      command,
    ]);
  }
}

function bundleValidationOptions(
  options: ManagedGrokRuntimeOptions,
): BundleValidationOptions {
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
  const version = await execFile(command, ["--version"], {
    timeout: 20_000,
  });
  return `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
}

function expectedChecksum(checksumText: string, assetName: string): string {
  for (const line of checksumText.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`SHA256SUMS does not contain ${assetName}`);
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
  options: ManagedGrokRuntimeOptions,
): Promise<ManagedGrokRuntime | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(path.join(rootDir, "managed-release.json"), "utf8"),
    ) as Partial<ManagedGrokMetadata>;
    if (
      metadata.schemaVersion !== MANAGED_GROK_METADATA_VERSION
      || metadata.repository !== MANAGED_GROK_REPOSITORY
      || typeof metadata.tag !== "string"
      || !isManagedGrokTagEligible(metadata.tag)
      || typeof metadata.asset !== "string"
      || typeof metadata.sha256 !== "string"
      || typeof metadata.checkedAt !== "number"
      || typeof metadata.installedAt !== "number"
    ) {
      return undefined;
    }
    const assetPlatform = managedGrokAssetPlatform(
      options.platform ?? process.platform,
      options.arch ?? process.arch,
    );
    if (
      !assetPlatform
      || metadata.asset !== managedGrokArchiveName(metadata.tag, assetPlatform)
    ) {
      return undefined;
    }
    const versionRoot = path.join(rootDir, "versions", metadata.tag);
    const command = await validateExtractedBundle(
      versionRoot,
      bundleValidationOptions(options),
    );
    return { command, metadata: metadata as ManagedGrokMetadata };
  } catch {
    return undefined;
  }
}

async function activateRuntime(
  rootDir: string,
  runtime: ManagedGrokRuntime,
  options: ManagedGrokRuntimeOptions,
): Promise<ManagedGrokRuntime> {
  try {
    await markRuntimeInUse(rootDir, runtime.command);
    await pruneSupersededVersions(
      rootDir,
      runtime.metadata.tag,
      options.isProcessAlive ?? isProcessAlive,
    );
  } catch (error) {
    // Installation and signature validation have already succeeded. Marker or
    // pruning failures must not turn an otherwise usable runtime into an
    // outage; a later activation gets another cleanup opportunity.
    managedGrokLog.warn("managed_grok_runtime_prune_failed", {
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
      && isManagedGrokTag(entry.name),
    )
    .sort((left, right) => {
      const leftVersion = parseManagedGrokSemver(left.name);
      const rightVersion = parseManagedGrokSemver(right.name);
      if (!leftVersion || !rightVersion) {
        return 0;
      }
      return compareParsedSemver(rightVersion, leftVersion);
    });

  // Keep one pre-marker generation for rolling-upgrade compatibility. Any
  // additional version is retained only while another live PwrAgent process
  // has marked that exact command as selected.
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
      managedGrokLog.warn("managed_grok_runtime_version_prune_failed", {
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
  return (
    error instanceof Error
    && "code" in error
    && error.code === code
  );
}

async function writeMetadata(
  rootDir: string,
  metadata: ManagedGrokMetadata,
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

export function managedGrokAssetPlatform(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return "macos-universal";
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
