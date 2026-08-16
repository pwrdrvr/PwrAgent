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
  readFile,
  realpath,
  rename,
  rm,
  stat,
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
  arch?: NodeJS.Architecture;
  checkMode?: ManagedGrokCheckMode;
  extractArchive?: (archivePath: string, targetDir: string) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  platform?: NodeJS.Platform;
  requirePlatformSignature?: boolean;
  rootDir?: string;
};

const processChecks = new Set<string>();
const activeChecks = new Map<string, Promise<ManagedGrokRuntime | undefined>>();

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
  const cached = await readCachedRuntime(rootDir, options.platform);
  const checkMode = options.checkMode ?? "ttl";
  if (
    (checkMode === "once-per-process" && processChecks.has(rootDir))
    || (
      checkMode === "ttl"
      && cached
      && now - cached.metadata.checkedAt < MANAGED_GROK_CHECK_TTL_MS
    )
  ) {
    return cached;
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
      return { command: cached.command, metadata };
    }
    const runtime = await installRelease(rootDir, release, now, options);
    managedGrokLog.info("managed_grok_runtime_installed", {
      asset: runtime.metadata.asset,
      command: runtime.command,
      tag: runtime.metadata.tag,
    });
    return runtime;
  } catch (error) {
    managedGrokLog.warn("managed_grok_runtime_update_failed", {
      error: error instanceof Error ? error.message : String(error),
      usingCachedTag: cached?.metadata.tag,
    });
    return cached;
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
      || !/^pwragent-v[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(tag)
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
        && asset.name.startsWith("pwragent-grok-")
        && asset.name.includes(`-${assetPlatform}.`),
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
    const version = tag.slice("pwragent-v".length);
    const extension = assetPlatform === "windows-x86_64" ? "zip" : "tar.gz";
    const assetName = `pwragent-grok-${version}-${assetPlatform}.${extension}`;
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
    const command = await validateExtractedBundle(
      extractedRoot,
      options.platform ?? process.platform,
      options.requirePlatformSignature === true,
    );
    const versionRoot = path.join(rootDir, "versions", release.tag);
    await mkdir(path.dirname(versionRoot), { recursive: true });
    if (!existsSync(versionRoot)) {
      try {
        await rename(extractedRoot, versionRoot);
      } catch (error) {
        if (!existsSync(versionRoot)) {
          throw error;
        }
      }
    }
    const installedCommand = path.join(versionRoot, path.basename(command));
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
  platform: NodeJS.Platform,
  requirePlatformSignature: boolean,
): Promise<string> {
  const executable = platform === "win32" ? "grok.exe" : "grok";
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
  if (platform !== "win32") {
    await chmod(command, 0o755);
  }
  if (requirePlatformSignature && platform === "darwin") {
    await execFile("codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      "--test-requirement",
      '=anchor apple generic and certificate leaf[subject.OU] = "T44CNHC4UH"',
      command,
    ]);
  }
  if (requirePlatformSignature && platform === "win32") {
    await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
        "if ($signature.Status -ne 'Valid') { exit 1 }",
        "if ($signature.SignerCertificate.Subject -notmatch 'PwrDrvr LLC') { exit 1 }",
      ].join("; "),
      command,
    ]);
  }
  const version = await execFile(command, ["--version"], {
    timeout: 20_000,
  });
  const versionOutput = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  if (!/\bgrok\b/iu.test(versionOutput)) {
    throw new Error("Managed Grok executable returned an invalid version banner");
  }
  return command;
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
  platform: NodeJS.Platform = process.platform,
): Promise<ManagedGrokRuntime | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(path.join(rootDir, "managed-release.json"), "utf8"),
    ) as Partial<ManagedGrokMetadata>;
    if (
      metadata.schemaVersion !== MANAGED_GROK_METADATA_VERSION
      || metadata.repository !== MANAGED_GROK_REPOSITORY
      || typeof metadata.tag !== "string"
      || !/^pwragent-v[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(metadata.tag)
      || typeof metadata.asset !== "string"
      || typeof metadata.sha256 !== "string"
      || typeof metadata.checkedAt !== "number"
      || typeof metadata.installedAt !== "number"
    ) {
      return undefined;
    }
    const executable = platform === "win32" ? "grok.exe" : "grok";
    const command = path.join(rootDir, "versions", metadata.tag, executable);
    const commandStat = await stat(command);
    if (!commandStat.isFile()) {
      return undefined;
    }
    return { command, metadata: metadata as ManagedGrokMetadata };
  } catch {
    return undefined;
  }
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
