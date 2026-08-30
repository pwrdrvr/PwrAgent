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
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { verify as verifySigstore } from "sigstore";
import type { Bundle as SigstoreBundle } from "sigstore";
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
  "pwragent-v0.149.0-pwragent.1";
export const MANAGED_CODEX_CHECK_TTL_MS = 24 * 60 * 60_000;
export const MANAGED_CODEX_UPDATE_MANIFEST_NAME =
  "pwragent-codex-update-v1.json";
export const MANAGED_CODEX_UPDATE_SIGNATURE_NAME =
  "pwragent-codex-update-v1.json.sigstore.json";
export const MANAGED_CODEX_PUBLICATION_MARKER_NAME =
  "pwragent-codex-publication-complete-v1.json";
// The manifest describes every published target, so this limit must cover the
// largest sibling artifact even when the current machine downloads a smaller
// archive. Rust Linux bundles currently exceed 512 MiB because they carry the
// sandbox companion binaries alongside Codex.
const MANAGED_CODEX_MAX_ARCHIVE_BYTES = 768 * 1024 * 1024;
const MANAGED_CODEX_FETCH_TIMEOUT_MS = 5 * 60_000;
const MANAGED_CODEX_RETRY_BACKOFF_MS = 60 * 60_000;
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
  completion: {
    name: string;
    url: string;
  };
  manifest: {
    name: string;
    url: string;
  };
  signature: {
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
  extractArchive?: (
    archivePath: string,
    targetDir: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  platform?: NodeJS.Platform;
  probeVersion?: (command: string) => Promise<string>;
  requirePlatformSignature?: boolean;
  rootDir?: string;
  signal?: AbortSignal;
  verifySigstoreBundle?: typeof verifyManagedCodexSigstoreBundle;
  verifyPlatformSignature?: (
    command: string,
    applicationCommand: string,
    platform: NodeJS.Platform,
  ) => Promise<void>;
  waitForUpdate?: boolean;
};

type ManagedCodexManifestArtifact = {
  arch: string;
  archiveType: string;
  file: string;
  os: string;
  platform: string;
  sha256: string;
  size: number;
  target: string;
};

type ManagedCodexUpdateManifest = {
  artifacts: ManagedCodexManifestArtifact[];
  sourceCommit: string;
};

type ManagedCodexSigstoreVerification = {
  bundlePath: string;
  expectedSubjects: Record<string, string>;
  sourceCommit: string;
  tag: string;
  tufCachePath: string;
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
const retryChecksAfter = new Map<string, number>();
const markedRuntimeCommands = new Map<string, string>();
const MANAGED_CODEX_ARTIFACT_TARGETS = [
  {
    arch: "arm64",
    archiveType: "tar.gz",
    os: "darwin",
    platform: "macos-aarch64",
    target: "aarch64-apple-darwin",
  },
  {
    arch: "x64",
    archiveType: "tar.gz",
    os: "darwin",
    platform: "macos-x86_64",
    target: "x86_64-apple-darwin",
  },
  {
    arch: "arm64",
    archiveType: "tar.gz",
    os: "linux",
    platform: "linux-aarch64",
    target: "aarch64-unknown-linux-gnu",
  },
  {
    arch: "x64",
    archiveType: "tar.gz",
    os: "linux",
    platform: "linux-x86_64",
    target: "x86_64-unknown-linux-gnu",
  },
  {
    arch: "x64",
    archiveType: "zip",
    os: "win32",
    platform: "windows-x86_64",
    target: "x86_64-pc-windows-msvc",
  },
] as const;

/**
 * Resolve a verified PwrAgent Codex distribution, installing or updating it
 * when the selected check policy requires. TTL callers receive a verified
 * cache immediately while its refresh runs in the background; the watcher can
 * opt into awaiting that refresh. A first install still fails instead of
 * selecting an arbitrary Codex.
 */
export async function ensureManagedCodexRuntime(
  options: ManagedCodexRuntimeOptions = {},
): Promise<ManagedCodexRuntime> {
  const rootDir = options.rootDir ?? path.join(
    resolvePwragentRoot(),
    "agents",
    "codex",
  );
  const checkMode = options.checkMode ?? "ttl";
  if (checkMode === "ttl" && !options.waitForUpdate) {
    const cached = await readCachedRuntime(rootDir, options);
    if (cached) {
      const now = options.now?.() ?? Date.now();
      if (
        now - cached.metadata.checkedAt >= MANAGED_CODEX_CHECK_TTL_MS
        && now >= (retryChecksAfter.get(rootDir) ?? 0)
      ) {
        void ensureManagedCodexRuntime({
          ...options,
          waitForUpdate: true,
        }).catch((error) => {
          managedCodexLog.warn("managed_codex_background_update_failed", {
            error: error instanceof Error ? error.message : String(error),
            usingCachedTag: cached.metadata.tag,
          });
        });
      }
      return await activateRuntime(rootDir, cached, options);
    }
  }
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
      retryChecksAfter.delete(rootDir);
      return await activateRuntime(
        rootDir,
        { ...cached, metadata },
        options,
      );
    }
    const runtime = await installRelease(rootDir, release, now, options);
    retryChecksAfter.delete(rootDir);
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
      if (!options.signal?.aborted) {
        retryChecksAfter.set(rootDir, now + MANAGED_CODEX_RETRY_BACKOFF_MS);
      }
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
    signal: managedCodexFetchSignal(options.signal),
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
    signal: managedCodexFetchSignal(options.signal),
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
    const completion = normalizedAsset(
      assets.find((asset) =>
        asset.name === MANAGED_CODEX_PUBLICATION_MARKER_NAME
      ),
    );
    const manifest = normalizedAsset(
      assets.find((asset) => asset.name === MANAGED_CODEX_UPDATE_MANIFEST_NAME),
    );
    const signature = normalizedAsset(
      assets.find((asset) => asset.name === MANAGED_CODEX_UPDATE_SIGNATURE_NAME),
    );
    const archive = normalizedAsset(
      assets.find((asset) =>
        typeof asset.name === "string"
        && asset.name === managedCodexArchiveName(tag, assetPlatform),
      ),
    );
    if (!checksum || !archive || !completion || !manifest || !signature) {
      continue;
    }
    return {
      archive,
      checksum,
      completion,
      manifest,
      signature,
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
      completion: {
        name: MANAGED_CODEX_PUBLICATION_MARKER_NAME,
        url: `${releaseBase}/${MANAGED_CODEX_PUBLICATION_MARKER_NAME}`,
      },
      manifest: {
        name: MANAGED_CODEX_UPDATE_MANIFEST_NAME,
        url: `${releaseBase}/${MANAGED_CODEX_UPDATE_MANIFEST_NAME}`,
      },
      signature: {
        name: MANAGED_CODEX_UPDATE_SIGNATURE_NAME,
        url: `${releaseBase}/${MANAGED_CODEX_UPDATE_SIGNATURE_NAME}`,
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
  options.signal?.throwIfAborted();
  await mkdir(rootDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(rootDir, ".install-"));
  try {
    const archivePath = path.join(stagingRoot, release.archive.name);
    const checksumPath = path.join(stagingRoot, release.checksum.name);
    const completionPath = path.join(stagingRoot, release.completion.name);
    const manifestPath = path.join(stagingRoot, release.manifest.name);
    const signaturePath = path.join(stagingRoot, release.signature.name);
    // The publisher uploads this marker last. Fetch it first so an Atom feed
    // entry cannot expose a partially uploaded release as installable.
    await downloadFile(
      release.completion.url,
      completionPath,
      options.fetch,
      options.signal,
    );
    await downloadFile(
      release.manifest.url,
      manifestPath,
      options.fetch,
      options.signal,
    );
    await downloadFile(
      release.signature.url,
      signaturePath,
      options.fetch,
      options.signal,
    );
    await downloadFile(
      release.checksum.url,
      checksumPath,
      options.fetch,
      options.signal,
    );
    await downloadFile(
      release.archive.url,
      archivePath,
      options.fetch,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const completionBytes = await readFile(completionPath);
    const manifestBytes = await readFile(manifestPath);
    const publication = parseManagedCodexPublicationMarker(
      completionBytes,
      release.tag,
    );
    const manifestDigest = sha256Bytes(manifestBytes);
    if (publication.manifestSha256 !== manifestDigest) {
      throw new Error(
        `Managed Codex manifest digest mismatch: expected ${publication.manifestSha256}, got ${manifestDigest}.`,
      );
    }
    const manifest = parseManagedCodexUpdateManifest(
      manifestBytes,
      release.tag,
    );
    if (publication.sourceCommit !== manifest.sourceCommit) {
      throw new Error(
        "Managed Codex publication source commit disagrees with the update manifest.",
      );
    }
    const manifestArtifact = manifest.artifacts.find(
      (artifact) => artifact.file === release.archive.name,
    );
    if (!manifestArtifact) {
      throw new Error(
        `Managed Codex manifest does not contain ${release.archive.name}.`,
      );
    }
    const checksumText = await readFile(checksumPath, "utf8");
    const expected = expectedChecksum(checksumText, release.archive.name);
    if (manifestArtifact.sha256 !== expected) {
      throw new Error(
        `Managed Codex manifest digest disagrees with SHA256SUMS for ${release.archive.name}.`,
      );
    }
    if (release.archive.digest && release.archive.digest !== expected) {
      throw new Error(
        `Release digest disagrees with SHA256SUMS for ${release.archive.name}.`,
      );
    }
    const actual = await sha256(archivePath, options.signal);
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${release.archive.name}: expected ${expected}, got ${actual}.`,
      );
    }
    const archiveEntry = await stat(archivePath);
    if (archiveEntry.size !== manifestArtifact.size) {
      throw new Error(
        `Managed Codex archive size mismatch for ${release.archive.name}: expected ${manifestArtifact.size}, got ${archiveEntry.size}.`,
      );
    }
    if (
      release.archive.size !== undefined
      && release.archive.size !== manifestArtifact.size
    ) {
      throw new Error(
        `GitHub release size disagrees with the managed Codex manifest for ${release.archive.name}.`,
      );
    }
    const expectedSubjects = Object.fromEntries([
      ...manifest.artifacts.map((artifact) => [
        artifact.file,
        artifact.sha256,
      ]),
      [release.checksum.name, await sha256(checksumPath, options.signal)],
      [release.manifest.name, manifestDigest],
    ]);
    await (
      options.verifySigstoreBundle ?? verifyManagedCodexSigstoreBundle
    )({
      bundlePath: signaturePath,
      expectedSubjects,
      sourceCommit: manifest.sourceCommit,
      tag: release.tag,
      tufCachePath: path.join(rootDir, "tuf"),
    });
    options.signal?.throwIfAborted();

    const extractedRoot = path.join(stagingRoot, "extracted");
    await mkdir(extractedRoot);
    await (options.extractArchive ?? extractArchive)(
      archivePath,
      extractedRoot,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const validationOptions = {
      ...bundleValidationOptions(options),
      tag: release.tag,
    };
    const staged = await validateExtractedBundle(
      extractedRoot,
      validationOptions,
    );
    options.signal?.throwIfAborted();
    const versionRoot = path.join(rootDir, "versions", release.tag);
    await mkdir(path.dirname(versionRoot), { recursive: true });
    await activateExtractedVersion(
      extractedRoot,
      versionRoot,
      validationOptions,
    );
    options.signal?.throwIfAborted();
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

function parseManagedCodexPublicationMarker(
  bytes: Buffer,
  tag: string,
): { manifestSha256: string; sourceCommit: string } {
  const marker = parseJsonObject(bytes, "managed Codex publication marker");
  requireExactKeys(marker, [
    "complete",
    "manifest",
    "product",
    "releaseTag",
    "schemaVersion",
    "sourceCommit",
    "version",
  ], "managed Codex publication marker");
  if (
    marker.complete !== true
    || marker.product !== "pwragent-codex"
    || marker.releaseTag !== tag
    || marker.schemaVersion !== 1
    || marker.version !== versionForTag(tag)
    || typeof marker.sourceCommit !== "string"
    || !/^[0-9a-f]{40}$/u.test(marker.sourceCommit)
  ) {
    throw new Error("Managed Codex publication marker is invalid.");
  }
  const manifest = requireJsonObject(
    marker.manifest,
    "managed Codex publication manifest reference",
  );
  requireExactKeys(manifest, [
    "file",
    "sha256",
    "signatureBundle",
    "signatureFormat",
  ], "managed Codex publication manifest reference");
  if (
    manifest.file !== MANAGED_CODEX_UPDATE_MANIFEST_NAME
    || manifest.signatureBundle !== MANAGED_CODEX_UPDATE_SIGNATURE_NAME
    || manifest.signatureFormat !== "sigstore-bundle-v0.3"
    || typeof manifest.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
  ) {
    throw new Error(
      "Managed Codex publication marker has an invalid manifest reference.",
    );
  }
  return {
    manifestSha256: manifest.sha256,
    sourceCommit: marker.sourceCommit,
  };
}

function parseManagedCodexUpdateManifest(
  bytes: Buffer,
  tag: string,
): ManagedCodexUpdateManifest {
  const manifest = parseJsonObject(bytes, "managed Codex update manifest");
  requireExactKeys(manifest, [
    "artifacts",
    "capabilities",
    "product",
    "releaseTag",
    "schemaVersion",
    "source",
    "version",
  ], "managed Codex update manifest");
  if (
    manifest.product !== "pwragent-codex"
    || manifest.releaseTag !== tag
    || manifest.schemaVersion !== 1
    || manifest.version !== versionForTag(tag)
  ) {
    throw new Error("Managed Codex update manifest identity is invalid.");
  }
  const source = requireJsonObject(
    manifest.source,
    "managed Codex update manifest source",
  );
  requireExactKeys(source, ["commit", "repository"], "managed Codex source");
  if (
    source.repository !== MANAGED_CODEX_REPOSITORY
    || typeof source.commit !== "string"
    || !/^[0-9a-f]{40}$/u.test(source.commit)
  ) {
    throw new Error("Managed Codex update manifest source is invalid.");
  }

  const capabilities = requireJsonObject(
    manifest.capabilities,
    "managed Codex update manifest capabilities",
  );
  requireExactKeys(capabilities, [
    "codeModeOutputReducer",
    "pwrdrvrTokenMiser",
  ], "managed Codex capabilities");
  const reducer = requireJsonObject(
    capabilities.codeModeOutputReducer,
    "managed Codex output reducer capability",
  );
  requireExactKeys(reducer, [
    "intentContextVersion",
    "protocolVersion",
  ], "managed Codex output reducer capability");
  const tokenMiser = requireJsonObject(
    capabilities.pwrdrvrTokenMiser,
    "managed Codex Token Miser capability",
  );
  requireExactKeys(tokenMiser, ["identity", "version"],
    "managed Codex Token Miser capability");
  if (
    reducer.protocolVersion !== 1
    || reducer.intentContextVersion !== 1
    || tokenMiser.identity !== "pwrdrvr.pwragent.token-miser"
    || tokenMiser.version !== 1
  ) {
    throw new Error("Managed Codex update manifest capabilities are invalid.");
  }

  if (
    !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length !== MANAGED_CODEX_ARTIFACT_TARGETS.length
  ) {
    throw new Error(
      "Managed Codex update manifest must contain exactly five artifacts.",
    );
  }
  const version = versionForTag(tag);
  const targetsByPlatform = new Map<
    string,
    (typeof MANAGED_CODEX_ARTIFACT_TARGETS)[number]
  >(
    MANAGED_CODEX_ARTIFACT_TARGETS.map((target) => [target.platform, target]),
  );
  const seenPlatforms = new Set<string>();
  const artifacts = manifest.artifacts.map((value, index) => {
    const artifact = requireJsonObject(
      value,
      `managed Codex artifact ${index + 1}`,
    );
    requireExactKeys(artifact, [
      "arch",
      "archiveType",
      "file",
      "os",
      "platform",
      "sha256",
      "size",
      "target",
    ], `managed Codex artifact ${index + 1}`);
    const target = typeof artifact.platform === "string"
      ? targetsByPlatform.get(artifact.platform)
      : undefined;
    const size = typeof artifact.size === "number"
      ? artifact.size
      : Number.NaN;
    if (
      !target
      || seenPlatforms.has(target.platform)
      || artifact.arch !== target.arch
      || artifact.archiveType !== target.archiveType
      || artifact.os !== target.os
      || artifact.target !== target.target
      || artifact.file !==
        `pwragent-codex-${version}-${target.platform}.${target.archiveType}`
      || typeof artifact.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(artifact.sha256)
      || !Number.isSafeInteger(size)
      || size <= 0
      || size > MANAGED_CODEX_MAX_ARCHIVE_BYTES
    ) {
      throw new Error(
        `Managed Codex update manifest artifact ${index + 1} is invalid.`,
      );
    }
    seenPlatforms.add(target.platform);
    return {
      arch: target.arch,
      archiveType: target.archiveType,
      file: artifact.file,
      os: target.os,
      platform: target.platform,
      sha256: artifact.sha256,
      size,
      target: target.target,
    } satisfies ManagedCodexManifestArtifact;
  });
  if (seenPlatforms.size !== MANAGED_CODEX_ARTIFACT_TARGETS.length) {
    throw new Error(
      "Managed Codex update manifest does not cover every required platform.",
    );
  }
  return { artifacts, sourceCommit: source.commit };
}

async function verifyManagedCodexSigstoreBundle(
  params: ManagedCodexSigstoreVerification,
): Promise<void> {
  const bundle = parseJsonObject(
    await readFile(params.bundlePath),
    "managed Codex Sigstore bundle",
  );
  if (
    bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json"
    || "messageSignature" in bundle
    || !("dsseEnvelope" in bundle)
  ) {
    throw new Error(
      "Managed Codex signature must be a Sigstore v0.3 DSSE bundle.",
    );
  }
  const workflowIdentity =
    `https://github.com/${MANAGED_CODEX_REPOSITORY}/.github/workflows/`
    + `pwragent-release.yml@refs/tags/${params.tag}`;
  await mkdir(params.tufCachePath, { recursive: true });
  await verifySigstore(bundle as SigstoreBundle, {
    certificateIdentityURI: `^${escapeRegularExpression(workflowIdentity)}$`,
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateOIDs: {
      // sigstore-js 5 compares policy bytes directly. Fulcio's newer v2
      // extensions wrap these values as DER UTF8String values, while the
      // parallel v1 extensions contain the raw bytes that the verifier API
      // accepts. Pin the same GitHub claims through their v1 OIDs.
      "1.3.6.1.4.1.57264.1.2": "push",
      "1.3.6.1.4.1.57264.1.3": params.sourceCommit,
      "1.3.6.1.4.1.57264.1.5": MANAGED_CODEX_REPOSITORY,
      "1.3.6.1.4.1.57264.1.6": `refs/tags/${params.tag}`,
    },
    ctLogThreshold: 1,
    tlogThreshold: 1,
    tufCachePath: params.tufCachePath,
  });

  const envelope = requireJsonObject(
    bundle.dsseEnvelope,
    "managed Codex Sigstore DSSE envelope",
  );
  if (
    envelope.payloadType !== "application/vnd.in-toto+json"
    || typeof envelope.payload !== "string"
  ) {
    throw new Error("Managed Codex Sigstore DSSE envelope is invalid.");
  }
  const statement = parseJsonObject(
    Buffer.from(envelope.payload, "base64"),
    "managed Codex provenance statement",
  );
  requireExactKeys(statement, [
    "_type",
    "predicate",
    "predicateType",
    "subject",
  ], "managed Codex provenance statement");
  if (
    statement._type !== "https://in-toto.io/Statement/v1"
    || statement.predicateType !== "https://slsa.dev/provenance/v1"
  ) {
    throw new Error("Managed Codex provenance statement type is invalid.");
  }
  requireJsonObject(statement.predicate, "managed Codex provenance predicate");
  const expectedNames = Object.keys(params.expectedSubjects).sort();
  if (
    !Array.isArray(statement.subject)
    || statement.subject.length !== expectedNames.length
  ) {
    throw new Error("Managed Codex provenance subjects are incomplete.");
  }
  const actualSubjects = new Map<string, string>();
  for (const value of statement.subject) {
    const subject = requireJsonObject(value, "managed Codex provenance subject");
    requireExactKeys(subject, ["digest", "name"],
      "managed Codex provenance subject");
    const digest = requireJsonObject(
      subject.digest,
      "managed Codex provenance subject digest",
    );
    requireExactKeys(digest, ["sha256"],
      "managed Codex provenance subject digest");
    if (
      typeof subject.name !== "string"
      || path.basename(subject.name) !== subject.name
      || typeof digest.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(digest.sha256)
      || actualSubjects.has(subject.name)
    ) {
      throw new Error("Managed Codex provenance subject is invalid.");
    }
    actualSubjects.set(subject.name, digest.sha256);
  }
  for (const name of expectedNames) {
    if (actualSubjects.get(name) !== params.expectedSubjects[name]) {
      throw new Error(`Managed Codex provenance digest mismatch for ${name}.`);
    }
  }
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    return requireJsonObject(JSON.parse(bytes.toString("utf8")), label);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} is not valid JSON.`, { cause: error });
    }
    throw error;
  }
}

function requireJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an unsupported schema.`);
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadFile(
  url: string,
  targetPath: string,
  fetchOverride: typeof globalThis.fetch | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const fetchSignal = managedCodexFetchSignal(signal);
  const response = await (fetchOverride ?? globalThis.fetch)(url, {
    headers: { "User-Agent": "PwrAgent-managed-codex-runtime" },
    redirect: "follow",
    signal: fetchSignal,
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
  await pipeline(
    body,
    limiter,
    createWriteStream(targetPath, { flags: "wx" }),
    { signal: fetchSignal },
  );
}

async function extractArchive(
  archivePath: string,
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  await execFile(tar, ["-xf", archivePath, "-C", targetDir], {
    signal,
    timeout: MANAGED_CODEX_FETCH_TIMEOUT_MS,
  });
}

function managedCodexFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(MANAGED_CODEX_FETCH_TIMEOUT_MS);
  return signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
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

async function sha256(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    signal?.throwIfAborted();
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
      && (pid === process.pid || processAlive(pid))
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
