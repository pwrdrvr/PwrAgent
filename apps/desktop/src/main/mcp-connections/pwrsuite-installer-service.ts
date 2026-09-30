import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { app as electronApp, shell } from "electron";
import type {
  PwrSuiteAppId,
  PwrSuiteInstallerActionResult,
  PwrSuiteInstallerOffer,
  PwrSuiteInstallerPlatform,
  PwrSuiteInstallerState,
} from "../../shared/pwrsuite-installer";
import { getMainLogger } from "../log";

const installerLog = getMainLogger("pwragent:pwrsuite-installer");

const REPOSITORIES: Record<PwrSuiteAppId, string> = {
  pwrgit: "PwrGit",
  pwrsnap: "PwrSnap",
};

/** One release read answers every tile for half an hour; GitHub allows 60 unauthenticated reads an hour. */
const OFFER_TTL_MS = 30 * 60_000;
/** After a failed read, the next launchpad waits this long before asking again. */
const OFFER_RETRY_MS = 5 * 60_000;
const RELEASE_READ_TIMEOUT_MS = 10_000;
/** A download that receives nothing for this long is abandoned rather than left looking alive. */
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
/** The byte meter updates a few times a second, not once per network chunk. */
const REPORT_INTERVAL_MS = 250;
/** Weight of the newest sample in the smoothed rate. */
const RATE_SMOOTHING = 0.3;
const USER_AGENT = "PwrAgent-pwrsuite-installer";

type ResolvedOffer = PwrSuiteInstallerOffer & {
  url: string;
  sha256: string;
};

type CachedOffer = { offer: ResolvedOffer; readAt: number };

type Job = { controller: AbortController; canceled: boolean };

/** A failure whose message is already fit to show on the tile. */
class InstallerError extends Error {}

export type PwrSuiteInstallerServiceOptions = {
  fetchFn?: typeof globalThis.fetch;
  downloadsDir?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  openPath?: (path: string) => Promise<string>;
  showItemInFolder?: (path: string) => void;
  now?: () => number;
  stallTimeoutMs?: number;
};

type InstallerListener = (state: PwrSuiteInstallerState) => void;

export function isPwrSuiteAppId(value: unknown): value is PwrSuiteAppId {
  return value === "pwrgit" || value === "pwrsnap";
}

/**
 * Which installer this machine gets, and the asset names that carry it, in
 * order of preference. Both apps publish the same shapes: an Apple-silicon
 * dmg, a universal dmg, and an x64 Windows setup. Only the versioned names are
 * matched; the unversioned aliases (`PwrGit.dmg`) are the same bytes.
 */
export function installerAssetPatterns(
  repository: string,
  platform: NodeJS.Platform,
  arch: string,
): { platform: PwrSuiteInstallerPlatform; patterns: RegExp[] } | undefined {
  const versioned = (suffix: string): RegExp =>
    new RegExp(`^${repository}-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?-${suffix}$`);
  if (platform === "darwin") {
    const universal = versioned("universal\\.dmg");
    return {
      platform: "mac",
      patterns: arch === "arm64" ? [versioned("arm64\\.dmg"), universal] : [universal],
    };
  }
  if (platform === "win32") {
    // No Windows arm64 build exists; x64 runs under emulation there.
    return { platform: "windows", patterns: [versioned("windows-x64-setup\\.exe")] };
  }
  return undefined;
}

type GithubReleaseAsset = {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
};

/**
 * The release asset for this machine, from GitHub's own release record. The
 * record carries a sha256 digest for every asset, which is what the download
 * is checked against. electron-builder's `latest-mac.yml` would not do: it
 * lists the update zips, not the dmg an operator installs from.
 */
export function selectInstallerAsset(
  app: PwrSuiteAppId,
  release: { tag_name?: unknown; assets?: unknown },
  target: { platform: PwrSuiteInstallerPlatform; patterns: RegExp[] },
): ResolvedOffer | undefined {
  const repository = REPOSITORIES[app];
  const assets = Array.isArray(release.assets)
    ? (release.assets as GithubReleaseAsset[])
    : [];
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const downloadPrefix = `https://github.com/pwrdrvr/${repository}/releases/download/`;
  for (const pattern of target.patterns) {
    for (const asset of assets) {
      if (typeof asset.name !== "string" || !pattern.test(asset.name)) continue;
      const digest = typeof asset.digest === "string"
        ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)
        : null;
      if (
        !digest
        || typeof asset.size !== "number"
        || !Number.isSafeInteger(asset.size)
        || asset.size <= 0
        || typeof asset.browser_download_url !== "string"
        || !asset.browser_download_url.startsWith(downloadPrefix)
      ) {
        continue;
      }
      return {
        platform: target.platform,
        version: tag.replace(/^v/, ""),
        assetName: asset.name,
        sizeBytes: asset.size,
        url: asset.browser_download_url,
        sha256: digest[1],
      };
    }
  }
  return undefined;
}

function publicOffer(offer: ResolvedOffer): PwrSuiteInstallerOffer {
  return {
    platform: offer.platform,
    version: offer.version,
    assetName: offer.assetName,
    sizeBytes: offer.sizeBytes,
  };
}

/** Five words for the tile; the full error goes to the log. */
function describeDownloadFailure(error: unknown): string {
  if (error instanceof InstallerError) return error.message;
  return "Download failed: connection lost";
}

/**
 * Downloads a PwrSuite app's installer into the operator's Downloads folder
 * and checks it before offering to open it. Nothing is installed: opening a
 * dmg mounts it and opening a setup.exe runs it, so the operator installs the
 * app the way they would from a browser.
 */
export class PwrSuiteInstallerService {
  private readonly states = new Map<PwrSuiteAppId, PwrSuiteInstallerState>();
  private readonly offers = new Map<PwrSuiteAppId, CachedOffer>();
  private readonly offerReads = new Map<PwrSuiteAppId, Promise<void>>();
  private readonly offerFailures = new Map<PwrSuiteAppId, number>();
  private readonly jobs = new Map<PwrSuiteAppId, Job>();
  private readonly readyPaths = new Map<PwrSuiteAppId, string>();
  private readonly listeners = new Set<InstallerListener>();

  constructor(private readonly options: PwrSuiteInstallerServiceOptions = {}) {}

  subscribe(listener: InstallerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The current state, answered at once. When the tile could offer a
   * download and the release has not been read recently, GitHub is asked in
   * the background and the offer arrives as an event: a slow or unreachable
   * api.github.com must not hold the tile on "Checking…".
   */
  readState(app: PwrSuiteAppId): PwrSuiteInstallerState {
    const state = this.state(app);
    if (state.platform && (state.phase === "idle" || state.phase === "failed")) {
      void this.refreshOffer(app);
    }
    return this.state(app);
  }

  private async refreshOffer(app: PwrSuiteAppId): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.offers.get(app);
    const failedAt = this.offerFailures.get(app);
    if (
      this.offerReads.has(app)
      || (cached && now - cached.readAt < OFFER_TTL_MS)
      || (failedAt !== undefined && now - failedAt < OFFER_RETRY_MS)
    ) {
      return;
    }
    const read = (async () => {
      try {
        const offer = await this.resolveOffer(app);
        this.offerFailures.delete(app);
        if (offer) this.update(app, { offer: publicOffer(offer) });
      } catch (error) {
        this.offerFailures.set(app, now);
        installerLog.warn("could not read the latest release", {
          app,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.offerReads.delete(app);
      }
    })();
    this.offerReads.set(app, read);
    await read;
  }

  async start(app: PwrSuiteAppId): Promise<PwrSuiteInstallerState> {
    const state = this.state(app);
    if (state.phase === "downloading" || state.phase === "verifying") return state;
    if (!state.platform) {
      return this.update(app, { phase: "failed", error: "No installer for this system" });
    }
    let offer: ResolvedOffer | undefined;
    try {
      offer = await this.resolveOffer(app, { fresh: true });
    } catch (error) {
      installerLog.warn("could not read the latest release", {
        app,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.update(app, { phase: "failed", error: "Couldn't reach GitHub" });
    }
    if (!offer) {
      return this.update(app, { phase: "failed", error: "No installer in the latest release" });
    }
    const job: Job = { controller: new AbortController(), canceled: false };
    this.jobs.set(app, job);
    this.readyPaths.delete(app);
    const next = this.update(app, {
      phase: "downloading",
      offer: publicOffer(offer),
      receivedBytes: 0,
      totalBytes: offer.sizeBytes,
      bytesPerSecond: undefined,
      fileName: undefined,
      error: undefined,
    });
    void this.download(app, offer, job);
    return next;
  }

  cancel(app: PwrSuiteAppId): PwrSuiteInstallerState {
    const job = this.jobs.get(app);
    if (job) {
      job.canceled = true;
      job.controller.abort();
    }
    return this.state(app);
  }

  async openInstaller(app: PwrSuiteAppId): Promise<PwrSuiteInstallerActionResult> {
    const path = this.readyPaths.get(app);
    if (!path || !existsSync(path)) {
      this.readyPaths.delete(app);
      this.update(app, { phase: "idle", fileName: undefined });
      return { opened: false, error: "The installer is no longer in Downloads." };
    }
    const error = await (this.options.openPath ?? shell.openPath)(path);
    return error ? { opened: false, error } : { opened: true };
  }

  revealInstaller(app: PwrSuiteAppId): PwrSuiteInstallerActionResult {
    const path = this.readyPaths.get(app);
    if (!path || !existsSync(path)) {
      return { opened: false, error: "The installer is no longer in Downloads." };
    }
    (this.options.showItemInFolder ?? shell.showItemInFolder)(path);
    return { opened: true };
  }

  private state(app: PwrSuiteAppId): PwrSuiteInstallerState {
    const existing = this.states.get(app);
    if (existing) return existing;
    const target = installerAssetPatterns(
      REPOSITORIES[app],
      this.options.platform ?? process.platform,
      this.options.arch ?? process.arch,
    );
    const initial: PwrSuiteInstallerState = {
      app,
      phase: "idle",
      ...(target ? { platform: target.platform } : {}),
    };
    this.states.set(app, initial);
    return initial;
  }

  private update(
    app: PwrSuiteAppId,
    patch: Partial<Omit<PwrSuiteInstallerState, "app" | "platform">>,
    publish = true,
  ): PwrSuiteInstallerState {
    const merged: PwrSuiteInstallerState = { ...this.state(app), ...patch };
    // Drop keys a patch cleared, so the IPC payload carries no `undefined`.
    for (const key of Object.keys(merged) as (keyof PwrSuiteInstallerState)[]) {
      if (merged[key] === undefined) delete merged[key];
    }
    this.states.set(app, merged);
    if (publish) {
      for (const listener of this.listeners) {
        try {
          listener(merged);
        } catch {
          // A broken subscriber must not fail a download.
        }
      }
    }
    return merged;
  }

  private async resolveOffer(
    app: PwrSuiteAppId,
    options: { fresh?: boolean } = {},
  ): Promise<ResolvedOffer | undefined> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.offers.get(app);
    if (cached && !options.fresh && now - cached.readAt < OFFER_TTL_MS) {
      return cached.offer;
    }
    const target = installerAssetPatterns(
      REPOSITORIES[app],
      this.options.platform ?? process.platform,
      this.options.arch ?? process.arch,
    );
    if (!target) return undefined;
    const response = await (this.options.fetchFn ?? globalThis.fetch)(
      `https://api.github.com/repos/pwrdrvr/${REPOSITORIES[app]}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(RELEASE_READ_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub answered HTTP ${response.status} for the latest release.`);
    }
    const offer = selectInstallerAsset(
      app,
      (await response.json()) as { tag_name?: unknown; assets?: unknown },
      target,
    );
    if (offer) this.offers.set(app, { offer, readAt: now });
    return offer;
  }

  private async download(
    app: PwrSuiteAppId,
    offer: ResolvedOffer,
    job: Job,
  ): Promise<void> {
    const directory = (this.options.downloadsDir ?? (() => electronApp.getPath("downloads")))();
    const target = join(directory, offer.assetName);
    const partial = `${target}.download`;
    const now = this.options.now ?? Date.now;
    const stallTimeoutMs = this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        job.controller.abort();
      }, stallTimeoutMs);
      stallTimer.unref?.();
    };
    try {
      await rm(partial, { force: true });
      armStallTimer();
      const response = await (this.options.fetchFn ?? globalThis.fetch)(offer.url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: job.controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new InstallerError(`Download failed (HTTP ${response.status})`);
      }
      const hash = createHash("sha256");
      let received = 0;
      let lastReportAt = now();
      let lastReportBytes = 0;
      let rate: number | undefined;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          if (received > offer.sizeBytes) {
            callback(new InstallerError("The download didn't verify"));
            return;
          }
          hash.update(chunk);
          armStallTimer();
          const at = now();
          if (at - lastReportAt >= REPORT_INTERVAL_MS) {
            const sample = (received - lastReportBytes) / ((at - lastReportAt) / 1000);
            rate = rate === undefined
              ? sample
              : rate * (1 - RATE_SMOOTHING) + sample * RATE_SMOOTHING;
            lastReportAt = at;
            lastReportBytes = received;
            this.update(app, { receivedBytes: received, bytesPerSecond: rate });
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        meter,
        createWriteStream(partial),
        { signal: job.controller.signal },
      );
      if (stallTimer) clearTimeout(stallTimer);
      this.update(app, {
        phase: "verifying",
        receivedBytes: received,
        bytesPerSecond: undefined,
      });
      if (received !== offer.sizeBytes || hash.digest("hex") !== offer.sha256) {
        throw new InstallerError("The download didn't verify");
      }
      await rm(target, { force: true });
      await rename(partial, target);
      this.readyPaths.set(app, target);
      this.update(app, { phase: "ready", fileName: offer.assetName });
    } catch (error) {
      if (stallTimer) clearTimeout(stallTimer);
      await rm(partial, { force: true }).catch(() => undefined);
      if (job.canceled) {
        this.update(app, {
          phase: "idle",
          receivedBytes: undefined,
          totalBytes: undefined,
          bytesPerSecond: undefined,
          error: undefined,
        });
        return;
      }
      installerLog.warn("installer download failed", {
        app,
        asset: offer.assetName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.update(app, {
        phase: "failed",
        bytesPerSecond: undefined,
        error: stalled ? "Download stalled" : describeDownloadFailure(error),
      });
    } finally {
      if (this.jobs.get(app) === job) this.jobs.delete(app);
    }
  }
}

let service: PwrSuiteInstallerService | undefined;

export function getPwrSuiteInstallerService(): PwrSuiteInstallerService {
  service ??= new PwrSuiteInstallerService();
  return service;
}
