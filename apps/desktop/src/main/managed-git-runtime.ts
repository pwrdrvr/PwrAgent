// PwrDrvr Git releases the operator downloads after PwrAgent shipped.
//
// The lifecycle follows the managed Codex and Grok runtimes (one release
// cache, one progress strip, verify before anything is used), with three
// differences that come from what Git is:
//
// - The payload is a whole runtime (git, every helper, templates, Git LFS,
//   the system config and, on Linux, the CA bundle), so it is checked against
//   the release's sealed inventory, not one executable's banner.
// - Installing never switches Git. The operator chooses a downloaded release
//   with an explicit Use, can roll back, and every Git command keeps the
//   executable it started with.
// - Each release keeps its own immutable directory. Nothing is rewritten in
//   place, so a command running from one release is never pulled out from
//   under it by the next.
//
// Layout under `managedGitRoot()`:
//   managed-release.json            last release check, both tracks (reporting only)
//   releases/<tag>/                 that release's verified catalog + SHA256SUMS
//   archives/<sha256>.tar.gz        downloaded archives, reused offline
//   versions/<generation>/<key>/    the unmodified payload
//   versions/<generation>/catalog.json, installed.json

import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { lock } from "proper-lockfile";
import { DESKTOP_UPDATE_CHANNELS, type DesktopUpdateChannel } from "@pwragent/shared";
import bundledCatalog from "../../custom-git-runtime.json";
import {
  fetchGitHubReleaseMetadata,
  ReleaseCheckDeferredError,
} from "./github-release-cache";
import { getMainLogger } from "./log";
import { managedGitRoot } from "./managed-git-paths";
import {
  createManagedRuntimeProgressReporter,
  type ManagedRuntimeProgressReporter,
} from "./managed-runtime-progress";
import {
  agreedSha256,
  checksumFor,
  compareManagedGitVersions,
  MANAGED_GIT_GENERATION_PATTERN,
  MANAGED_GIT_REPOSITORY,
  ManagedGitNeedsAppUpdateError,
  ManagedGitTrustError,
  managedGitArchiveName,
  managedGitGenerationId,
  managedGitPlatformKey,
  parseCustomGitCatalog,
  parseManagedGitVersion,
  runCommand,
  selectManagedGitReleases,
  sha256Bytes,
  sha256File,
  unsafeArchiveMember,
  verifyManagedGitPayload,
  type CustomGitPin,
  type ManagedGitPlatformKey,
  type ManagedGitRelease,
  type VerifyManagedGitOptions,
} from "./managed-git-verify";

const log = getMainLogger("pwragent:managed-git-runtime");

export const MANAGED_GIT_RELEASES_URL =
  `https://api.github.com/repos/${MANAGED_GIT_REPOSITORY}/releases?per_page=30`;
/** An automatic check (Settings opening) asks GitHub at most this often. */
export const MANAGED_GIT_CHECK_TTL_MS = 6 * 60 * 60_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Releases newer than the bundle whose catalogs one check may read. */
const MAX_RELEASES_PER_CHECK = 3;
const STATE_VERSION = 1;
/**
 * The check file's own version. Version 1 knew one list with no promotion
 * in it, so it answers for neither track: it is dropped and the next check
 * refills it.
 */
const CHECK_STATE_VERSION = 2;
const USER_AGENT = "PwrAgent-managed-git-runtime";

/** The catalog this build shipped: its verifier contract and bundled version. */
export const BUNDLED_GIT_VERSION: string = bundledCatalog.version;
export const BUNDLED_GIT_CONSUMER_SHA256: string = bundledCatalog.consumer_sha256;

export type ManagedGitAvailable = {
  tag: string;
  version: string;
  generation: string;
  archiveName: string;
  archiveSha256: string;
  archiveBytes?: number;
  publishedAt?: string;
};

/** What one build track offered at the last check. */
export type ManagedGitTrackAnswer = {
  /** Newest release on the track this build can install, newer than the bundle. */
  available?: ManagedGitAvailable;
  /** A newer release on the track whose catalog needs a newer PwrAgent. */
  needsAppUpdate?: { version: string };
  /** Why the track offers nothing, when releases were listed but none was usable. */
  error?: string;
};

/** Every check answers both tracks, so switching tracks needs no network. */
export type ManagedGitCheck = {
  schemaVersion: number;
  platformKey: ManagedGitPlatformKey;
  checkedAt: number;
  tracks: Record<DesktopUpdateChannel, ManagedGitTrackAnswer>;
  /** The whole check failed (offline, GitHub refused); the answers are the last good ones. */
  error?: string;
};

export type ManagedGitInstalled = {
  schemaVersion: number;
  generation: string;
  tag: string;
  version: string;
  sourceRevision: string;
  platformKey: ManagedGitPlatformKey;
  archiveSha256: string;
  inventorySha256: string;
  lfsVersion?: string;
  installedAt: number;
};

export type ManagedGitGenerationInfo = ManagedGitInstalled & {
  root: string;
  executable: string;
};

export type ManagedGitOptions = {
  rootDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  /** Release list request; defaults to the shared budgeted release cache. */
  fetchReleases?: (url: string, init: RequestInit, options: { manual: boolean }) => Promise<Response>;
  /** Downloads of release assets (catalog, checksums, archive). */
  fetch?: typeof globalThis.fetch;
  verify?: Omit<VerifyManagedGitOptions, "signal">;
  consumerSha256?: string;
  bundledVersion?: string;
  isProcessAlive?: (pid: number) => boolean;
  progress?: ManagedRuntimeProgressReporter;
};

export class ManagedGitBusyError extends Error {
  constructor(message = "Another PwrAgent window is installing PwrDrvr Git.") {
    super(message);
    this.name = "ManagedGitBusyError";
  }
}

export class ManagedGitUnavailableError extends Error {
  constructor(readonly generation: string, reason: string) {
    super(`PwrDrvr Git ${generation} cannot be used: ${reason}`);
    this.name = "ManagedGitUnavailableError";
  }
}

function settings(options: ManagedGitOptions) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return {
    rootDir: options.rootDir ?? managedGitRoot(),
    platform,
    arch,
    key: managedGitPlatformKey(platform, arch),
    now: options.now ?? Date.now,
    consumerSha256: options.consumerSha256 ?? BUNDLED_GIT_CONSUMER_SHA256,
    bundledVersion: options.bundledVersion ?? BUNDLED_GIT_VERSION,
  };
}

export function managedGitSupported(options: ManagedGitOptions = {}): boolean {
  return settings(options).key !== undefined;
}

// ---------------------------------------------------------------------------
// Release check

/** The last check, as recorded on disk. Reporting only: never chooses a Git. */
export async function readManagedGitCheck(
  options: ManagedGitOptions = {},
): Promise<ManagedGitCheck | undefined> {
  const { rootDir, key } = settings(options);
  try {
    const check = JSON.parse(
      await readFile(path.join(rootDir, "managed-release.json"), "utf8"),
    ) as ManagedGitCheck;
    if (
      check?.schemaVersion !== CHECK_STATE_VERSION
      || check.platformKey !== key
      || typeof check.checkedAt !== "number"
      || !DESKTOP_UPDATE_CHANNELS.every((track) => typeof check.tracks?.[track] === "object" && check.tracks[track] !== null)
    ) return undefined;
    return check;
  } catch {
    return undefined;
  }
}

async function writeBytesAtomic(file: string, bytes: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, file);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeBytesAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function downloadBytes(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_METADATA_BYTES) {
    await response.body?.cancel();
    throw new ManagedGitTrustError(`Release file is too large: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_METADATA_BYTES) throw new ManagedGitTrustError(`Release file is too large: ${url}`);
  return bytes;
}

type VerifiedRelease = {
  release: ManagedGitRelease;
  pin: CustomGitPin;
  catalogBytes: Buffer;
  sums: string;
  available: ManagedGitAvailable;
};

/**
 * Read one release's catalog and checksums and decide whether this build can
 * install it. Every hash the release states must agree before anything is
 * trusted: the catalog against SHA256SUMS and GitHub's digest, then the
 * archive against all three.
 */
async function verifyReleaseMetadata(
  release: ManagedGitRelease,
  options: ManagedGitOptions,
  signal: AbortSignal | undefined,
): Promise<VerifiedRelease> {
  const s = settings(options);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sums = (await downloadBytes(release.checksums.url, fetchImpl, signal)).toString("utf8");
  const catalogBytes = await downloadBytes(release.catalog.url, fetchImpl, signal);
  return verifiedFromBytes(release, catalogBytes, sums, s);
}

function verifiedFromBytes(
  release: ManagedGitRelease,
  catalogBytes: Buffer,
  sums: string,
  s: ReturnType<typeof settings>,
): VerifiedRelease {
  const catalogSha = agreedSha256("runtime-manifest.json", sums, {
    githubDigest: release.catalog.sha256,
  });
  if (sha256Bytes(catalogBytes) !== catalogSha) {
    throw new ManagedGitTrustError("The downloaded catalog does not match SHA256SUMS.");
  }
  const pin = parseCustomGitCatalog(catalogBytes, {
    platform: s.platform,
    arch: s.arch,
    consumerSha256: s.consumerSha256,
    expectedVersion: release.version,
  });
  const archiveName = managedGitArchiveName(pin);
  const archive = release.assets.find((asset) => asset.name === archiveName);
  if (!archive || archive.url !== pin.asset.url) {
    throw new ManagedGitTrustError(`The release has no ${archiveName}.`);
  }
  const archiveSha256 = agreedSha256(archiveName, sums, {
    catalog: pin.asset.sha256,
    githubDigest: archive.sha256,
  });
  return {
    release,
    pin,
    catalogBytes,
    sums,
    available: {
      tag: release.tag,
      version: release.version,
      generation: managedGitGenerationId(pin),
      archiveName,
      archiveSha256,
      ...(archive.size !== undefined ? { archiveBytes: archive.size } : {}),
      ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
    },
  };
}

async function fetchReleaseList(
  options: ManagedGitOptions,
  manual: boolean,
  signal?: AbortSignal,
): Promise<ManagedGitRelease[]> {
  const s = settings(options);
  const init: RequestInit = {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(signal ? { signal } : {}),
  };
  const response = await (options.fetchReleases
    ?? ((url, request, { manual: isManual }) =>
      fetchGitHubReleaseMetadata(url, request, { manual: isManual, ttlMs: MANAGED_GIT_CHECK_TTL_MS })))(
    MANAGED_GIT_RELEASES_URL,
    init,
    { manual },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 403 || response.status === 429
        ? "GitHub's rate limit was reached. Try again later."
        : `GitHub release check failed with HTTP ${response.status}.`,
    );
  }
  return selectManagedGitReleases(await response.json(), s.bundledVersion);
}

function emptyTracks(): Record<DesktopUpdateChannel, ManagedGitTrackAnswer> {
  return { latest: {}, prerelease: {} };
}

/**
 * Ask GitHub for releases newer than the bundled runtime and record, for
 * each track, the newest one this build can install: Prerelease takes the
 * newest release, Latest the newest promoted one. Releases are walked newest
 * by version first, and one is fetched only while a track it belongs to
 * still has no answer, so older prereleases are never read while looking
 * for a promoted build. Downloads nothing but the small catalog and checksum
 * files of at most three releases.
 */
export async function checkManagedGitReleases(
  options: ManagedGitOptions & { manual: boolean; signal?: AbortSignal },
): Promise<ManagedGitCheck | undefined> {
  const s = settings(options);
  if (!s.key) return undefined;
  const previous = await readManagedGitCheck(options);
  let result: ManagedGitCheck;
  try {
    const releases = await fetchReleaseList(options, options.manual, options.signal);
    const tracks = emptyTracks();
    result = { schemaVersion: CHECK_STATE_VERSION, platformKey: s.key, checkedAt: s.now(), tracks };
    let fetched = 0;
    for (const release of releases) {
      const open = DESKTOP_UPDATE_CHANNELS.filter(
        (track) => !tracks[track].available && (track === "prerelease" || release.promoted),
      );
      if (open.length === 0) continue;
      if (fetched >= MAX_RELEASES_PER_CHECK) break;
      fetched += 1;
      try {
        const verified = await verifyReleaseMetadata(release, options, options.signal);
        await saveReleaseFiles(s.rootDir, verified);
        for (const track of open) tracks[track].available = verified.available;
      } catch (error) {
        if (error instanceof ManagedGitNeedsAppUpdateError) {
          for (const track of open) tracks[track].needsAppUpdate ??= { version: error.version };
          continue;
        }
        if (!(error instanceof ManagedGitTrustError)) throw error;
        for (const track of open) tracks[track].error ??= `${release.tag}: ${error.message}`;
        log.warn("managed_git_release_rejected", { tag: release.tag, error: error.message });
      }
      if (tracks.latest.available) break;
    }
  } catch (error) {
    if (error instanceof ReleaseCheckDeferredError && previous && !options.manual) return previous;
    result = {
      ...(previous ?? { schemaVersion: CHECK_STATE_VERSION, platformKey: s.key, checkedAt: s.now(), tracks: emptyTracks() }),
      error: describeCheckError(error),
    };
  }
  try {
    await writeJsonAtomic(path.join(s.rootDir, "managed-release.json"), result);
  } catch (error) {
    log.warn("managed_git_check_write_failed", { error: String(error) });
  }
  return result;
}

function describeCheckError(error: unknown): string {
  if (error instanceof ReleaseCheckDeferredError) {
    return error.reason === "rate-limit"
      ? "GitHub's rate limit was reached. Try again later."
      : "A release check ran recently. Try again shortly.";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/u.test(`${error.message} ${String(error.cause)}`))) {
    return "GitHub could not be reached.";
  }
  return error instanceof Error ? error.message : String(error);
}

async function saveReleaseFiles(rootDir: string, verified: VerifiedRelease): Promise<void> {
  const directory = path.join(rootDir, "releases", verified.release.tag);
  await mkdir(directory, { recursive: true });
  await writeBytesAtomic(path.join(directory, "runtime-manifest.json"), verified.catalogBytes);
  await writeBytesAtomic(path.join(directory, "SHA256SUMS"), verified.sums);
  await writeJsonAtomic(path.join(directory, "release.json"), {
    tag: verified.release.tag,
    version: verified.release.version,
    promoted: verified.release.promoted,
    ...(verified.release.publishedAt ? { publishedAt: verified.release.publishedAt } : {}),
    catalog: verified.release.catalog,
    checksums: verified.release.checksums,
    assets: verified.release.assets,
  });
}

/** A release checked earlier, re-verified from its saved files. Offline-safe. */
async function readSavedRelease(
  tag: string,
  options: ManagedGitOptions,
): Promise<VerifiedRelease | undefined> {
  const s = settings(options);
  const directory = path.join(s.rootDir, "releases", tag);
  try {
    const release = JSON.parse(await readFile(path.join(directory, "release.json"), "utf8")) as ManagedGitRelease;
    if (release.tag !== tag) return undefined;
    return verifiedFromBytes(
      release,
      await readFile(path.join(directory, "runtime-manifest.json")),
      await readFile(path.join(directory, "SHA256SUMS"), "utf8"),
      s,
    );
  } catch (error) {
    if (error instanceof ManagedGitTrustError) throw error;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Install

/**
 * One writer at a time across windows: installs, removals and prunes all
 * rename into or out of versions/.
 */
async function lockManagedGitRoot(rootDir: string): Promise<() => Promise<void>> {
  await mkdir(rootDir, { recursive: true });
  try {
    return await lock(path.join(rootDir, "install"), {
      realpath: false, retries: 0, stale: 60_000, update: 10_000,
      onCompromised: (error) => log.warn("managed_git_install_lock_compromised", { error: String(error) }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ManagedGitBusyError();
    throw error;
  }
}

const activeInstalls = new Map<string, {
  tag: string;
  controller: AbortController;
  promise: Promise<ManagedGitGenerationInfo>;
}>();

export function managedGitInstallInProgress(options: ManagedGitOptions = {}): string | undefined {
  return activeInstalls.get(settings(options).rootDir)?.tag;
}

/** Stops this window's install. Partial files are removed; nothing switches. */
export function cancelManagedGitInstall(options: ManagedGitOptions = {}): boolean {
  const active = activeInstalls.get(settings(options).rootDir);
  if (!active) return false;
  active.controller.abort(new DOMException("The download was cancelled.", "AbortError"));
  return true;
}

/**
 * Download, verify and unpack one release. Explicit only, and it never
 * changes which Git runs: the operator chooses the result with Use.
 */
export async function installManagedGit(
  options: ManagedGitOptions & { tag: string; signal?: AbortSignal },
): Promise<ManagedGitGenerationInfo> {
  const s = settings(options);
  // The tag comes from the renderer and names a directory under releases/.
  if (!options.tag.startsWith("v") || !parseManagedGitVersion(options.tag)) {
    throw new Error(`Not a PwrDrvr Git release: ${options.tag}`);
  }
  const running = activeInstalls.get(s.rootDir);
  if (running) {
    if (running.tag === options.tag) return await running.promise;
    throw new ManagedGitBusyError(`PwrDrvr Git ${running.tag.slice(1)} is already downloading.`);
  }
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const promise = installInner({ ...options, signal });
  const entry = { tag: options.tag, controller, promise };
  activeInstalls.set(s.rootDir, entry);
  try {
    return await promise;
  } finally {
    if (activeInstalls.get(s.rootDir) === entry) activeInstalls.delete(s.rootDir);
  }
}

async function installInner(
  options: ManagedGitOptions & { tag: string; signal: AbortSignal },
): Promise<ManagedGitGenerationInfo> {
  const s = settings(options);
  const { signal } = options;
  if (!s.key) throw new Error("PwrDrvr Git is not available for this platform.");
  const progress = options.progress ?? createManagedRuntimeProgressReporter("git", s.now);
  const tag = options.tag;
  progress.checking();
  let release: ManagedGitRelease | undefined;
  try {
    const unlock = await lockManagedGitRoot(s.rootDir);
    try {
      // Re-read the release so nothing older than this moment is trusted.
      // Offline, the files a check already verified are enough to reuse a
      // cached archive.
      let verified: VerifiedRelease | undefined;
      try {
        const releases = await fetchReleaseList(options, true, signal);
        release = releases.find((entry) => entry.tag === tag);
        if (release) verified = await verifyReleaseMetadata(release, options, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ManagedGitTrustError) throw error;
        verified = await readSavedRelease(tag, options);
        if (!verified) throw error;
        log.info("managed_git_install_offline", { tag, error: String(error) });
      }
      if (!verified) throw new Error(`PwrDrvr Git ${tag.slice(1)} is no longer published.`);
      release = verified.release;
      await saveReleaseFiles(s.rootDir, verified);
      const generation = verified.available.generation;
      const existing = await readGenerationIfValid(generation, options, signal);
      if (existing) {
        progress.ready(tag);
        return existing;
      }
      const archive = await obtainArchive(verified, s.rootDir, options, progress, signal);
      progress.unpacking(tag);
      const staging = path.join(s.rootDir, "versions", `.staging-${randomUUID()}`);
      try {
        const payload = path.join(staging, verified.pin.key);
        await mkdir(payload, { recursive: true });
        await extractSafely(archive, payload, signal);
        const build = await verifyManagedGitPayload(payload, verified.pin, { ...options.verify, signal });
        const installed: ManagedGitInstalled = {
          schemaVersion: STATE_VERSION,
          generation,
          tag,
          version: verified.pin.catalog.version,
          sourceRevision: verified.pin.catalog.source_revision,
          platformKey: verified.pin.key,
          archiveSha256: verified.available.archiveSha256,
          inventorySha256: verified.pin.asset.inventory_sha256,
          ...(build.lfs_version ? { lfsVersion: build.lfs_version } : {}),
          installedAt: s.now(),
        };
        await writeFile(path.join(staging, "catalog.json"), verified.catalogBytes);
        await writeJsonAtomic(path.join(staging, "installed.json"), installed);
        signal.throwIfAborted();
        progress.activating(tag);
        const target = generationDirectory(s.rootDir, generation);
        try {
          await rename(staging, target);
        } catch (error) {
          // Another window finished the same immutable release first.
          const other = await readGenerationIfValid(generation, options, signal);
          if (other) {
            progress.ready(tag);
            return other;
          }
          throw existsSync(target)
            ? new Error(`An installed copy of ${generation} failed verification. Remove it, then download again.`)
            : error;
        }
        forgetManagedGitResolution(generation);
        progress.ready(tag);
        log.info("managed_git_installed", { generation, tag });
        return generationInfo(s.rootDir, installed);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } finally {
      await unlock().catch(() => undefined);
    }
  } catch (error) {
    if (signal.aborted) {
      progress.idle();
      throw new DOMException("The download was cancelled.", "AbortError");
    }
    progress.failed(error, { tag });
    log.warn("managed_git_install_failed", { tag, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function obtainArchive(
  verified: VerifiedRelease,
  rootDir: string,
  options: ManagedGitOptions,
  progress: ManagedRuntimeProgressReporter,
  signal: AbortSignal,
): Promise<string> {
  const { archiveSha256, archiveBytes, tag } = verified.available;
  const archives = path.join(rootDir, "archives");
  await mkdir(archives, { recursive: true });
  const archive = path.join(archives, `${archiveSha256}.tar.gz`);
  if (existsSync(archive)) {
    progress.verifying(tag);
    if (await sha256File(archive, signal) === archiveSha256) return archive;
    await rm(archive, { force: true });
  }
  const meter = progress.downloading(tag, archiveBytes);
  const partial = path.join(archives, `.partial-${randomUUID()}`);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(verified.pin.asset.url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}.`);
    }
    const limit = archiveBytes ?? MAX_ARCHIVE_BYTES;
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > Math.min(limit, MAX_ARCHIVE_BYTES)) {
          callback(new ManagedGitTrustError("The download is larger than the release says."));
          return;
        }
        meter(chunk.length);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      limiter,
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    progress.verifying(tag);
    const actual = await sha256File(partial, signal);
    if (actual !== archiveSha256) {
      throw new ManagedGitTrustError(
        `Checksum mismatch for ${verified.available.archiveName}. Nothing was installed.`,
      );
    }
    await rename(partial, archive);
    return archive;
  } finally {
    await rm(partial, { force: true });
  }
}

async function extractSafely(archive: string, target: string, signal: AbortSignal): Promise<void> {
  // The archive's hash already matches the release; the listing still has to
  // be safe before anything is written, and the sealed inventory decides
  // what may exist afterwards.
  const listing = await runCommand("tar", ["-tzf", archive], { signal });
  const members = listing.split(/\r?\n/u).filter((line) => line.length > 0);
  if (members.length === 0 || members.length > MAX_ARCHIVE_MEMBERS) {
    throw new ManagedGitTrustError("The Git archive has an unexpected number of entries.");
  }
  const unsafe = members.find(unsafeArchiveMember);
  if (unsafe !== undefined) throw new ManagedGitTrustError(`Unsafe path in the Git archive: ${unsafe}`);
  // -x preserves the archive's own modes; nothing is rewritten afterwards,
  // so the signed bytes stay exactly as published.
  await runCommand("tar", ["-xzf", archive, "-C", target], { signal });
}

// ---------------------------------------------------------------------------
// Installed releases

function generationDirectory(rootDir: string, generation: string): string {
  return path.join(rootDir, "versions", generation);
}

function generationInfo(rootDir: string, installed: ManagedGitInstalled): ManagedGitGenerationInfo {
  const root = path.join(generationDirectory(rootDir, installed.generation), installed.platformKey);
  return { ...installed, root, executable: path.join(root, "bin", "git") };
}

function parseInstalled(
  raw: string,
  generation: string,
  key: ManagedGitPlatformKey,
): ManagedGitInstalled | undefined {
  try {
    const installed = JSON.parse(raw) as ManagedGitInstalled;
    return installed?.schemaVersion === STATE_VERSION
      && installed.generation === generation
      && installed.platformKey === key
      && typeof installed.version === "string"
      && typeof installed.tag === "string"
      && typeof installed.inventorySha256 === "string"
      ? installed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Installed releases for this platform, newest first. Reads records only. */
export async function listManagedGitGenerations(
  options: ManagedGitOptions = {},
): Promise<ManagedGitGenerationInfo[]> {
  const s = settings(options);
  if (!s.key) return [];
  let names: string[];
  try {
    names = await readdir(path.join(s.rootDir, "versions"));
  } catch {
    return [];
  }
  const found: ManagedGitGenerationInfo[] = [];
  for (const name of names) {
    if (!MANAGED_GIT_GENERATION_PATTERN.test(name)) continue;
    try {
      const installed = parseInstalled(
        await readFile(path.join(generationDirectory(s.rootDir, name), "installed.json"), "utf8"),
        name,
        s.key,
      );
      if (installed) found.push(generationInfo(s.rootDir, installed));
    } catch {
      // A directory without a record is not an install.
    }
  }
  return found.sort((left, right) => compareManagedGitVersions(right.version, left.version));
}

/**
 * Re-run every check on an installed release: the stored catalog against
 * this build's rules, then the sealed inventory and, on macOS, every
 * signature. Used before Use and Roll back, and once per launch in the
 * background for the selected release.
 */
export async function verifyManagedGitGeneration(
  generation: string,
  options: ManagedGitOptions & { signal?: AbortSignal } = {},
): Promise<ManagedGitGenerationInfo> {
  const s = settings(options);
  if (!s.key) throw new ManagedGitUnavailableError(generation, "this platform has no PwrDrvr Git.");
  if (!MANAGED_GIT_GENERATION_PATTERN.test(generation)) {
    throw new ManagedGitUnavailableError(generation, "the name is not a PwrDrvr Git release.");
  }
  const directory = generationDirectory(s.rootDir, generation);
  let installed: ManagedGitInstalled | undefined;
  let catalogBytes: Buffer;
  try {
    installed = parseInstalled(await readFile(path.join(directory, "installed.json"), "utf8"), generation, s.key);
    catalogBytes = await readFile(path.join(directory, "catalog.json"));
  } catch {
    throw new ManagedGitUnavailableError(generation, "it is not installed.");
  }
  if (!installed) throw new ManagedGitUnavailableError(generation, "its install record is unreadable.");
  try {
    const pin = parseCustomGitCatalog(catalogBytes, {
      platform: s.platform,
      arch: s.arch,
      consumerSha256: s.consumerSha256,
      expectedVersion: installed.version,
    });
    if (managedGitGenerationId(pin) !== generation || pin.asset.inventory_sha256 !== installed.inventorySha256) {
      throw new ManagedGitTrustError("its install record does not match its catalog.");
    }
    await verifyManagedGitPayload(path.join(directory, s.key), pin, { ...options.verify, signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    throw new ManagedGitUnavailableError(generation, reason.endsWith(".") ? reason : `${reason}.`);
  }
  return generationInfo(s.rootDir, installed);
}

async function readGenerationIfValid(
  generation: string,
  options: ManagedGitOptions,
  signal: AbortSignal,
): Promise<ManagedGitGenerationInfo | undefined> {
  if (!existsSync(generationDirectory(settings(options).rootDir, generation))) return undefined;
  try {
    return await verifyManagedGitGeneration(generation, { ...options, signal });
  } catch (error) {
    signal.throwIfAborted();
    log.warn("managed_git_existing_install_rejected", { generation, error: String(error) });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Running a selected release

type Resolution =
  | { ok: true; root: string; executable: string; verified: boolean }
  | { ok: false; error: ManagedGitUnavailableError };

const resolutions = new Map<string, Resolution>();
const failureListeners = new Set<(generation: string, error: Error) => void>();
let backgroundVerifyDelayMs = 20_000;

export function onManagedGitVerificationFailed(
  listener: (generation: string, error: Error) => void,
): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/** Tests: run the background re-verification without the startup delay. */
export function setManagedGitBackgroundVerifyDelay(ms: number): void {
  backgroundVerifyDelayMs = ms;
}

export function forgetManagedGitResolution(generation?: string): void {
  if (generation === undefined) resolutions.clear();
  else resolutions.delete(generation);
}

/** Record a full verification this process just ran (Use, Roll back). */
export function noteManagedGitVerified(info: ManagedGitGenerationInfo): void {
  resolutions.set(info.generation, { ok: true, root: info.root, executable: info.executable, verified: true });
  markInUse(info.root);
}

/** The last answer for a release this process resolved, without doing work. */
export function managedGitResolutionFailure(generation: string): string | undefined {
  const resolution = resolutions.get(generation);
  return resolution && !resolution.ok ? resolution.error.message : undefined;
}

/**
 * The payload root of the selected release, for building a Git environment
 * synchronously on every command.
 *
 * The first call in a process checks only the cheap part (the install record,
 * the catalog and the sealed inventory's own hash, and that git and git-lfs
 * exist) and schedules the full verification in the background. A release
 * that fails either is never run: the error is remembered and every later
 * call throws it, so a broken selection fails loudly instead of quietly
 * running some other Git.
 */
export function resolveManagedGitRuntime(
  generation: string,
  options: ManagedGitOptions = {},
): { root: string; executable: string } {
  const cached = resolutions.get(generation);
  if (cached) {
    if (!cached.ok) throw cached.error;
    return { root: cached.root, executable: cached.executable };
  }
  const s = settings(options);
  let resolution: Resolution;
  try {
    if (!s.key) throw new Error("this platform has no PwrDrvr Git.");
    if (!MANAGED_GIT_GENERATION_PATTERN.test(generation)) throw new Error("the name is not a PwrDrvr Git release.");
    const directory = generationDirectory(s.rootDir, generation);
    if (!existsSync(directory)) throw new Error("it is not installed.");
    const installed = parseInstalled(readFileSync(path.join(directory, "installed.json"), "utf8"), generation, s.key);
    if (!installed) throw new Error("its install record is unreadable.");
    const root = path.join(directory, s.key);
    if (sha256Bytes(readFileSync(path.join(root, "runtime-files.json"))) !== installed.inventorySha256) {
      throw new Error("its sealed file list changed.");
    }
    const executable = path.join(root, "bin", "git");
    for (const required of [executable, path.join(root, "libexec", "git-core", "git-lfs")]) {
      if (!existsSync(required)) throw new Error(`${path.relative(root, required)} is missing.`);
    }
    resolution = { ok: true, root, executable, verified: false };
  } catch (error) {
    resolution = {
      ok: false,
      error: new ManagedGitUnavailableError(generation, error instanceof Error ? error.message : String(error)),
    };
  }
  resolutions.set(generation, resolution);
  if (!resolution.ok) throw resolution.error;
  markInUse(resolution.root);
  scheduleBackgroundVerify(generation, options);
  return { root: resolution.root, executable: resolution.executable };
}

function scheduleBackgroundVerify(generation: string, options: ManagedGitOptions): void {
  const timer = setTimeout(() => {
    void verifyManagedGitGeneration(generation, options).then(
      (info) => {
        const current = resolutions.get(generation);
        if (current?.ok) resolutions.set(generation, { ...current, verified: true, root: info.root });
      },
      (error: unknown) => {
        const failure = error instanceof ManagedGitUnavailableError
          ? error
          : new ManagedGitUnavailableError(generation, String(error));
        resolutions.set(generation, { ok: false, error: failure });
        log.error("managed_git_selected_release_rejected", { generation, error: failure.message });
        for (const listener of failureListeners) {
          try {
            listener(generation, failure);
          } catch {
            // A broken listener must not hide the rejection from the others.
          }
        }
      },
    );
  }, backgroundVerifyDelayMs);
  timer.unref?.();
}

const markedRoots = new Set<string>();
let markerCleanupInstalled = false;

function markerPath(directory: string, pid: number = process.pid): string {
  return path.join(directory, `.pwragent-use-${pid}`);
}

/** Exit removes this process's markers, so a reused PID cannot pin a release. */
export function removeManagedGitInUseMarkers(): void {
  for (const directory of markedRoots) {
    try {
      unlinkSync(markerPath(directory));
    } catch {
      // Already gone with its release.
    }
  }
  markedRoots.clear();
}

/** A live process's marker keeps its release on disk until it exits. */
function markInUse(root: string): void {
  const directory = path.dirname(root);
  if (markedRoots.has(directory)) return;
  try {
    writeFileSync(markerPath(directory), `${Date.now()}\n`);
    markedRoots.add(directory);
  } catch (error) {
    log.warn("managed_git_in_use_marker_failed", { directory, error: String(error) });
  }
  if (!markerCleanupInstalled) {
    markerCleanupInstalled = true;
    process.once("exit", removeManagedGitInUseMarkers);
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether another live process has run this release. */
function inUseElsewhere(directory: string, alive: (pid: number) => boolean): boolean {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return false;
  }
  return names.some((name) => {
    const pid = Number(/^\.pwragent-use-([1-9][0-9]*)$/u.exec(name)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid);
  });
}

/**
 * Remove one release the operator asked to remove. Refused while any profile
 * selects it (as current or as the roll-back target) or another running
 * PwrAgent has used it.
 */
export async function removeManagedGitGeneration(
  generation: string,
  protectedGenerations: ReadonlySet<string>,
  options: ManagedGitOptions = {},
): Promise<void> {
  const unlock = await lockManagedGitRoot(settings(options).rootDir);
  try {
    await removeGenerationLocked(generation, protectedGenerations, options);
  } finally {
    await unlock().catch(() => undefined);
  }
}

async function removeGenerationLocked(
  generation: string,
  protectedGenerations: ReadonlySet<string>,
  options: ManagedGitOptions,
): Promise<void> {
  const s = settings(options);
  if (!MANAGED_GIT_GENERATION_PATTERN.test(generation)) throw new Error("Not a PwrDrvr Git release.");
  if (protectedGenerations.has(generation)) {
    throw new Error("A profile still uses this release. Choose another Git first.");
  }
  const directory = generationDirectory(s.rootDir, generation);
  if (inUseElsewhere(directory, options.isProcessAlive ?? defaultProcessAlive)) {
    throw new Error("Another PwrAgent window is still using this release.");
  }
  if (markedRoots.has(directory)) {
    throw new Error("This window ran Git from this release. Restart PwrAgent, then remove it.");
  }
  // Rename first so no reader sees a half-deleted release.
  const doomed = path.join(s.rootDir, "versions", `.removing-${generation}-${randomUUID()}`);
  await rename(directory, doomed);
  forgetManagedGitResolution(generation);
  await rm(doomed, { recursive: true, force: true });
}

/**
 * Keep what any profile selects, what a live process ran, and the newest
 * installed release; remove the rest along with archives nothing needs.
 */
export async function pruneManagedGitGenerations(
  protectedGenerations: ReadonlySet<string>,
  options: ManagedGitOptions = {},
): Promise<string[]> {
  let unlock: () => Promise<void>;
  try {
    unlock = await lockManagedGitRoot(settings(options).rootDir);
  } catch (error) {
    // Another window is installing or pruning; its own prune covers this.
    if (error instanceof ManagedGitBusyError) return [];
    throw error;
  }
  try {
    return await pruneLocked(protectedGenerations, options);
  } finally {
    await unlock().catch(() => undefined);
  }
}

async function pruneLocked(
  protectedGenerations: ReadonlySet<string>,
  options: ManagedGitOptions,
): Promise<string[]> {
  const s = settings(options);
  const alive = options.isProcessAlive ?? defaultProcessAlive;
  const generations = await listManagedGitGenerations(options);
  const keep = new Set(protectedGenerations);
  if (generations[0]) keep.add(generations[0].generation);
  const removed: string[] = [];
  for (const info of generations) {
    if (keep.has(info.generation)) continue;
    const directory = generationDirectory(s.rootDir, info.generation);
    if (markedRoots.has(directory) || inUseElsewhere(directory, alive)) {
      keep.add(info.generation);
      continue;
    }
    try {
      await removeGenerationLocked(info.generation, protectedGenerations, options);
      removed.push(info.generation);
    } catch (error) {
      keep.add(info.generation);
      log.warn("managed_git_prune_failed", { generation: info.generation, error: String(error) });
    }
  }
  const keptArchives = new Set(
    generations.filter((info) => keep.has(info.generation)).map((info) => `${info.archiveSha256}.tar.gz`),
  );
  const check = await readManagedGitCheck(options);
  for (const track of DESKTOP_UPDATE_CHANNELS) {
    const offered = check?.tracks[track].available;
    if (offered) keptArchives.add(`${offered.archiveSha256}.tar.gz`);
  }
  try {
    for (const name of await readdir(path.join(s.rootDir, "archives"))) {
      if (/^[0-9a-f]{64}\.tar\.gz$/u.test(name) && !keptArchives.has(name)) {
        await rm(path.join(s.rootDir, "archives", name), { force: true });
      }
    }
  } catch {
    // No archive cache yet.
  }
  return removed;
}

/** The SHA256SUMS line for a file, exported for the selection tests. */
export { checksumFor };
