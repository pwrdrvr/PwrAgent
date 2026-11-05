// Trust rules for a downloaded PwrDrvr Git runtime.
//
// This is an asynchronous port of the shared `scripts/stage-runtime.mjs`
// (readRuntimeManifest + verifyRuntime), which packaging uses for the bundled
// runtime. The rules are the same, so a downloaded runtime is trusted exactly
// as far as a bundled one: the catalog pins the archive and its sealed file
// inventory, every file's bytes, mode and link must match that inventory, and
// on macOS every Mach-O must carry a strict PwrDrvr Developer ID signature.
// `managed-git-verify.oracle.test.ts` runs both over the same mutated
// payloads so the two cannot drift. The port exists because the script's
// spawnSync would stall the Electron main thread for the codesign calls.

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { compareManagedGitVersions } from "@pwragent/shared";

export const PWRDRVR_TEAM_ID = "T44CNHC4UH";
export const PWRDRVR_SIGNING_IDENTITY =
  "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)";
export const MANAGED_GIT_REPOSITORY = "huntharo/git";
export const MANAGED_GIT_RELEASE_DOWNLOAD_PREFIX =
  `https://github.com/${MANAGED_GIT_REPOSITORY}/releases/download/`;
/** Linux Git reads its CA bundle here, as the bundled runtime does. */
export const MANAGED_GIT_CA_BUNDLE_PATH = "ssl/cacert.pem";

const TEAM_REQUIREMENT =
  `=anchor apple generic and certificate leaf[subject.OU] = "${PWRDRVR_TEAM_ID}"`;
const MACH_O_MAGIC = new Set(["cffaedfe", "feedfacf", "cafebabe", "bebafeca"]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+-dev-pwrgit\.\d+$/u;
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)-dev-pwrgit\.(\d+)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ManagedGitPlatformKey =
  | "darwin-universal"
  | "linux-x64"
  | "linux-arm64";

/**
 * The catalog asset for this machine. Windows has no custom runtime: it keeps
 * Dugite's MinGit, so there is nothing to download there.
 */
export function managedGitPlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): ManagedGitPlatformKey | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return "darwin-universal";
  }
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  return undefined;
}

export type CustomGitCatalogAsset = {
  url: string;
  sha256: string;
  inventory_sha256: string;
  team_id?: string;
  notarized?: boolean;
  signing?: string;
  ca_bundle?: { path?: string; sha256?: string };
};

export type CustomGitCatalog = {
  schema: number;
  version: string;
  source_revision: string;
  consumer_sha256: string;
  assets: Record<string, CustomGitCatalogAsset>;
};

export type CustomGitPin = {
  catalog: CustomGitCatalog;
  asset: CustomGitCatalogAsset;
  key: ManagedGitPlatformKey;
};

export class ManagedGitTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedGitTrustError";
  }
}

/** A catalog this build cannot verify. Not a bad release: a newer contract. */
export class ManagedGitNeedsAppUpdateError extends ManagedGitTrustError {
  constructor(readonly version: string) {
    super(`PwrDrvr Git ${version} needs a newer PwrAgent.`);
    this.name = "ManagedGitNeedsAppUpdateError";
  }
}

/**
 * The catalog rules of `readRuntimeManifest`, plus the two a download adds:
 * the catalog must be for the release it came from, and it must target the
 * shared verifier this build shipped (`consumerSha256`, from the bundled
 * catalog). A catalog for a newer verifier is a "needs an app update", never
 * something to install with older rules.
 */
export function parseCustomGitCatalog(
  bytes: string | Uint8Array,
  options: {
    platform: NodeJS.Platform;
    arch: string;
    consumerSha256: string;
    expectedVersion?: string;
  },
): CustomGitPin {
  let catalog: CustomGitCatalog;
  try {
    catalog = JSON.parse(
      typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"),
    ) as CustomGitCatalog;
  } catch {
    throw new ManagedGitTrustError("The Git release catalog is not valid JSON.");
  }
  if (!catalog || typeof catalog !== "object") {
    throw new ManagedGitTrustError("The Git release catalog is not an object.");
  }
  const key = managedGitPlatformKey(options.platform, options.arch);
  if (!key) {
    throw new ManagedGitTrustError(
      `PwrDrvr Git has no build for ${options.platform}-${options.arch}.`,
    );
  }
  if (typeof catalog.version !== "string" || !VERSION_PATTERN.test(catalog.version)) {
    throw new ManagedGitTrustError("The Git release catalog has no valid version.");
  }
  if (options.expectedVersion !== undefined && catalog.version !== options.expectedVersion) {
    throw new ManagedGitTrustError(
      `The Git release catalog is for ${catalog.version}, not ${options.expectedVersion}.`,
    );
  }
  if (catalog.consumer_sha256 !== options.consumerSha256) {
    throw new ManagedGitNeedsAppUpdateError(catalog.version);
  }
  const asset = catalog.assets?.[key];
  if (
    catalog.schema !== 1
    || typeof catalog.source_revision !== "string"
    || !/^[0-9a-f]{40}$/u.test(catalog.source_revision)
    || !asset
    || !SHA256_PATTERN.test(asset.sha256 ?? "")
    || !SHA256_PATTERN.test(asset.inventory_sha256 ?? "")
  ) {
    throw new ManagedGitTrustError(`Unsupported or incomplete Git release catalog for ${key}.`);
  }
  const prefix = `${MANAGED_GIT_RELEASE_DOWNLOAD_PREFIX}v${catalog.version}/`;
  if (
    typeof asset.url !== "string"
    || !asset.url.startsWith(prefix)
    || /[?#]/u.test(asset.url)
    || asset.url.slice(prefix.length).includes("/")
  ) {
    throw new ManagedGitTrustError("The Git archive must use its immutable versioned release URL.");
  }
  if (key === "darwin-universal" && (asset.team_id !== PWRDRVR_TEAM_ID || asset.notarized !== true)) {
    throw new ManagedGitTrustError("macOS Git must be the notarized PwrDrvr build.");
  }
  if (
    key !== "darwin-universal"
    && (asset.ca_bundle?.path !== MANAGED_GIT_CA_BUNDLE_PATH
      || !SHA256_PATTERN.test(asset.ca_bundle.sha256 ?? ""))
  ) {
    throw new ManagedGitTrustError(`Linux Git must carry its CA bundle at ${MANAGED_GIT_CA_BUNDLE_PATH}.`);
  }
  return { catalog, asset, key };
}

export function managedGitArchiveName(pin: CustomGitPin): string {
  return pin.asset.url.slice(pin.asset.url.lastIndexOf("/") + 1);
}

/** `<version>-<rev7>`: one directory per immutable release. */
export function managedGitGenerationId(pin: CustomGitPin): string {
  return `${pin.catalog.version}-${pin.catalog.source_revision.slice(0, 7)}`;
}

export const MANAGED_GIT_GENERATION_PATTERN =
  /^\d+\.\d+\.\d+-dev-pwrgit\.\d+-[0-9a-f]{7}$/u;

// ---------------------------------------------------------------------------
// Releases

export {
  compareManagedGitVersions,
  parseManagedGitVersion,
  type ManagedGitVersion,
} from "@pwragent/shared";

export type ManagedGitReleaseAsset = {
  name: string;
  url: string;
  size?: number;
  /** GitHub's `sha256:` digest, when the API reports one. */
  sha256?: string;
};

export type ManagedGitRelease = {
  tag: string;
  version: string;
  /**
   * Promoted out of testing: GitHub's prerelease flag is exactly `false`.
   * Anything else is a prerelease, which only the Prerelease track offers.
   */
  promoted: boolean;
  publishedAt?: string;
  catalog: ManagedGitReleaseAsset;
  checksums: ManagedGitReleaseAsset;
  assets: ManagedGitReleaseAsset[];
};

type GithubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
};

function normalizeAsset(value: unknown, tag: string): ManagedGitReleaseAsset | undefined {
  if (!value || typeof value !== "object") return undefined;
  const asset = value as Record<string, unknown>;
  const name = typeof asset.name === "string" ? asset.name : undefined;
  const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : undefined;
  if (!name || !url) return undefined;
  // Every asset must come from this exact release, never a redirect elsewhere.
  if (url !== `${MANAGED_GIT_RELEASE_DOWNLOAD_PREFIX}${tag}/${name}`) return undefined;
  const digest = typeof asset.digest === "string"
    ? /^sha256:([0-9a-f]{64})$/u.exec(asset.digest)?.[1]
    : undefined;
  return {
    name,
    url,
    ...(typeof asset.size === "number" && Number.isSafeInteger(asset.size) ? { size: asset.size } : {}),
    ...(digest ? { sha256: digest } : {}),
  };
}

/**
 * Complete custom releases newer than `floorVersion`, newest by version first.
 *
 * GitHub's prerelease flag decides only the track (`promoted`), never whether
 * a release counts. A release counts only when it carries the catalog and
 * SHA256SUMS, which the release workflow uploads last. Upstream Git and Dugite assets are never candidates: only
 * this repository's tags of this exact shape are.
 */
export function selectManagedGitReleases(
  releases: unknown,
  floorVersion: string,
): ManagedGitRelease[] {
  if (!Array.isArray(releases)) return [];
  const selected: ManagedGitRelease[] = [];
  for (const entry of releases as GithubRelease[]) {
    if (!entry || typeof entry !== "object" || entry.draft !== false) continue;
    const tag = typeof entry.tag_name === "string" ? entry.tag_name : "";
    if (!TAG_PATTERN.test(tag)) continue;
    const version = tag.slice(1);
    if (compareManagedGitVersions(version, floorVersion) <= 0) continue;
    if (!Array.isArray(entry.assets)) continue;
    const assets = entry.assets
      .map((asset) => normalizeAsset(asset, tag))
      .filter((asset): asset is ManagedGitReleaseAsset => asset !== undefined);
    const catalog = assets.find((asset) => asset.name === "runtime-manifest.json");
    const checksums = assets.find((asset) => asset.name === "SHA256SUMS");
    if (!catalog || !checksums) continue;
    selected.push({
      tag,
      version,
      promoted: entry.prerelease === false,
      ...(typeof entry.published_at === "string" ? { publishedAt: entry.published_at } : {}),
      catalog,
      checksums,
      assets,
    });
  }
  return selected.sort((left, right) => compareManagedGitVersions(right.version, left.version));
}

/** One file's line from SHA256SUMS. A missing or repeated name is an error. */
export function checksumFor(sums: string, name: string): string {
  let found: string | undefined;
  for (const line of sums.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] !== name) continue;
    if (found !== undefined) throw new ManagedGitTrustError(`SHA256SUMS lists ${name} twice.`);
    found = match[1].toLowerCase();
  }
  if (found === undefined) throw new ManagedGitTrustError(`SHA256SUMS does not list ${name}.`);
  return found;
}

/**
 * The three published statements of one file's hash must agree: SHA256SUMS,
 * the catalog (when it pins the file), and GitHub's asset digest (when the API
 * reports one). A missing digest is tolerated; a disagreeing one is not.
 */
export function agreedSha256(
  name: string,
  sums: string,
  sources: { catalog?: string; githubDigest?: string },
): string {
  const listed = checksumFor(sums, name);
  if (sources.catalog !== undefined && sources.catalog !== listed) {
    throw new ManagedGitTrustError(`The catalog and SHA256SUMS disagree about ${name}.`);
  }
  if (sources.githubDigest !== undefined && sources.githubDigest !== listed) {
    throw new ManagedGitTrustError(`GitHub's digest and SHA256SUMS disagree about ${name}.`);
  }
  return listed;
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Archive members and the sealed payload

/**
 * Archive member names that could write outside the extraction directory.
 * Checked on the listing before anything is extracted; the sealed inventory
 * then rejects anything else that does not belong.
 */
export function unsafeArchiveMember(name: string): boolean {
  const normalized = name.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) return true;
  return normalized.split("/").some((part) => part === "..");
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<string>;

const execFile = promisify(execFileCallback);

export const runCommand: CommandRunner = async (command, args, options) => {
  const { stdout } = await execFile(command, args, {
    encoding: "utf8",
    env: options.env,
    signal: options.signal,
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
};

export type ManagedGitBuildInfo = {
  version: string;
  source_revision: string;
  primary_sha1: string;
  architecture?: string;
  lfs_version?: string;
  notarized?: boolean;
  signing?: string;
};

export type VerifyManagedGitOptions = {
  /** Strict PwrDrvr signature on every Mach-O. Off only for unit fixtures. */
  requireSigned?: boolean;
  /** Run the payload's Git and LFS. Off only for unit fixtures. */
  probe?: boolean;
  run?: CommandRunner;
  signal?: AbortSignal;
  /** How many codesign or lipo checks run at once. */
  concurrency?: number;
};

type InventoryEntry = { sha256?: string; mode?: number; link?: string };

/**
 * `verifyRuntime` from the shared script: the payload is exactly the sealed
 * file set, and is the release the catalog names.
 */
export async function verifyManagedGitPayload(
  directory: string,
  pin: CustomGitPin,
  options: VerifyManagedGitOptions = {},
): Promise<ManagedGitBuildInfo> {
  const { signal } = options;
  const requireSigned = options.requireSigned ?? true;
  const run = options.run ?? runCommand;
  const root = await realpath(directory);
  const inventoryBytes = await readFile(path.join(root, "runtime-files.json"));
  if (sha256Bytes(inventoryBytes) !== pin.asset.inventory_sha256) {
    throw new ManagedGitTrustError("Git inventory checksum mismatch.");
  }
  let expected: Record<string, InventoryEntry>;
  try {
    expected = JSON.parse(inventoryBytes.toString("utf8")) as Record<string, InventoryEntry>;
  } catch {
    throw new ManagedGitTrustError("Git inventory is not valid JSON.");
  }
  const actual = new Map<string, InventoryEntry>();
  const machO: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (rel === "runtime-files.json") continue;
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = path.relative(root, await realpath(file));
        } catch {
          throw new ManagedGitTrustError(`Git symlink does not resolve: ${rel}`);
        }
        if (resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
          throw new ManagedGitTrustError(`Git symlink escapes payload: ${rel}`);
        }
        actual.set(rel, { link: await readlink(file) });
      } else if (stat.isDirectory()) {
        await visit(file);
      } else if (stat.isFile()) {
        const bytes = await readFile(file);
        actual.set(rel, { sha256: sha256Bytes(bytes), mode: stat.mode & 0o7777 });
        if (MACH_O_MAGIC.has(bytes.subarray(0, 4).toString("hex"))) machO.push(file);
      } else {
        throw new ManagedGitTrustError(`Unexpected Git payload file: ${rel}`);
      }
    }
  };
  await visit(root);
  for (const [name, entry] of Object.entries(expected)) {
    const found = actual.get(name);
    if (
      !found
      || found.link !== entry.link
      || found.sha256 !== entry.sha256
      || found.mode !== entry.mode
    ) {
      throw new ManagedGitTrustError(`A file changed after the release was sealed: ${name}`);
    }
  }
  if (actual.size !== Object.keys(expected).length) {
    throw new ManagedGitTrustError("The Git file set differs from the sealed release.");
  }

  let build: ManagedGitBuildInfo;
  try {
    build = JSON.parse(await readFile(path.join(root, "pwrgit-build.json"), "utf8")) as ManagedGitBuildInfo;
  } catch {
    throw new ManagedGitTrustError("Git build record is unreadable.");
  }
  if (
    build.version !== pin.catalog.version
    || build.source_revision !== pin.catalog.source_revision
    || build.primary_sha1 !== "SHA1_DC"
  ) {
    throw new ManagedGitTrustError("Git source or version mismatch.");
  }

  if (pin.key === "darwin-universal") {
    if (build.architecture !== "universal" || machO.length === 0) {
      throw new ManagedGitTrustError("Expected universal Git executables.");
    }
    if (requireSigned && (build.notarized !== true || build.signing !== PWRDRVR_SIGNING_IDENTITY)) {
      throw new ManagedGitTrustError("Expected Developer ID signed and notarized PwrDrvr Git.");
    }
    await forEachLimited(machO, options.concurrency ?? 4, async (file) => {
      const rel = path.relative(root, file);
      const archs = await run("/usr/bin/lipo", ["-archs", file], { signal });
      if (archs.split(/\s+/u).sort().join(" ") !== "arm64 x86_64") {
        throw new ManagedGitTrustError(`Missing universal Git slice: ${rel}`);
      }
      try {
        await run("/usr/bin/codesign", [
          "--verify", "--all-architectures", "--strict",
          ...(requireSigned ? ["--test-requirement", TEAM_REQUIREMENT] : []),
          file,
        ], { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw new ManagedGitTrustError(
          `${rel} is not signed by PwrDrvr: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  } else {
    const arch = pin.key === "linux-x64" ? "x64" : "arm64";
    if (build.architecture !== arch) {
      throw new ManagedGitTrustError(`Expected ${arch} Git, found ${build.architecture ?? "none"}.`);
    }
  }

  if (options.probe ?? true) {
    signal?.throwIfAborted();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(GIT_|DYLD_|LD_)/u.test(name)),
    );
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_TERMINAL_PROMPT = "0";
    env.PATH = `${path.join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const git = path.join(root, "bin", "git");
    const buildOptions = (await run(git, ["version", "--build-options"], { env, signal })).split(/\r?\n/u);
    if (
      !buildOptions.includes("SHA-1: SHA1_DC")
      || !buildOptions.includes(`built from commit: ${build.source_revision}`)
    ) {
      throw new ManagedGitTrustError("The Git executable's source revision or SHA-1 protection changed.");
    }
    if (
      await run(git, ["--version"], { env, signal }) !== `git version ${build.version}`
      || await run(git, ["--exec-path"], { env, signal }) !== path.join(root, "libexec", "git-core")
      || !(await run(git, ["lfs", "version"], { env, signal })).startsWith(`git-lfs/${build.lfs_version} `)
    ) {
      throw new ManagedGitTrustError("Git, Git LFS or helper resolution failed.");
    }
  }
  return build;
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await task(item);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure !== undefined) throw failure;
}
