import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRemoteFederationTarget } from "@pwragent/shared/contracts/federation";
import { type AgentEvent, type EnsureDirectoryLaunchpadRequest } from "@pwragent/shared/contracts/agent";
import {
  type NavigationDirectoryGitStatus,
  type NavigationDirectoryGitStatusUpdatedNotification,
  type NavigationDirectoryRow,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationSnapshot,
  type RefreshDirectoryGitStatusesRequest,
  type RefreshDirectoryGitStatusesResponse,
} from "@pwragent/shared/contracts/navigation";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import type { GitReadRequest } from "../git-info/read-cache";
import { getMainLogger } from "../log";
import type { DesktopOwnerStorage, DirectoryGitStatusCacheEntry } from "../storage/desktop-overlay-store";
import {
  DIRECTORY_GIT_STATUS_BACKGROUND_BATCH_SIZE,
  DIRECTORY_GIT_STATUS_FORCE_COALESCE_WINDOW_MS,
  isFreshDirectoryGitStatusCacheEntry,
} from "./directory-git-status-refresh-policy";
import type { DirectoryGitStatusEntry } from "./git-directory-service";
import type { RegistryHostPorts } from "./registry-host-ports";

const appServerLog = getMainLogger("pwragent:app-server");

const STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT =
  DIRECTORY_GIT_STATUS_BACKGROUND_BATCH_SIZE;

type DirectoryGitRefreshTarget = Pick<NavigationDirectoryRow, "key" | "path" | "latestUpdatedAt">;


function applyDirectoryGitStatus(
  directory: NavigationSnapshot["directories"][number],
  gitStatus: NavigationDirectoryGitStatus | undefined,
): NavigationSnapshot["directories"][number] {
  const next = { ...directory };
  if (gitStatus) {
    next.gitStatus = gitStatus;
  } else {
    delete next.gitStatus;
  }
  return next;
}

type DesktopDirectoryGitStatusPorts = Pick<RegistryHostPorts, "publishLocalEvent"> & {
  getNavigationQueryPage(request: NavigationQueryRequest, consumerId: string): Promise<NavigationQueryPage>;
  releaseNavigationPage(consumerId: string): void;
  findDirectory(key: string): DirectoryGitRefreshTarget | undefined;
  getOverlayStore(): Pick<DesktopOwnerStorage, "readDirectoryGitStatusCache" | "writeDirectoryGitStatusCacheEntry">;
  readDirectoryStatusEntries(directories: DirectoryGitRefreshTarget[], request?: GitReadRequest): AsyncIterable<DirectoryGitStatusEntry>;
  logDebug(event: string, payload: Record<string, unknown>): void;
};

/** Owns the app-server directory Git status cache and its refresh scheduling. */
export class DesktopDirectoryGitStatus {
  constructor(private readonly ports: DesktopDirectoryGitStatusPorts) {}

  private readonly directoryGitStatusByKey = new Map<
    string,
    DirectoryGitStatusCacheEntry
  >();
  private directoryGitStatusCacheLoaded = false;
  private automaticDirectoryGitStatusRefreshesStarted = 0;
  private readonly pendingDirectoryGitStatusRefreshes = new Map<string, Promise<void>>();
  private readonly pendingDirectoryGitStatusKeys = new Set<string>();

  async refreshDirectoryGitStatusesForKeys(
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .refreshDirectoryGitStatuses(remoteRequest);
    }
    await this.loadDirectoryGitStatusCache();
    const directoryKeys = [
      ...new Set(request.directoryKeys.map((key) => key.trim()).filter(Boolean)),
    ];
    if (directoryKeys.length > 100) throw new Error("Refresh at most 100 directories at a time.");
    if (!directoryKeys.length) return { scheduledCount: 0 };
    const token = `directory-git-refresh:${randomUUID()}`;
    const deadlineAt = Date.now() + 10_000;
    const directories: DirectoryGitRefreshTarget[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    try {
      for (let count = 0; count < 16; count += 1) {
        const page = await this.ports.getNavigationQueryPage({ protocol: 2, consumer: "main-sidebar", inventory: "owner",
          query: { kind: "directory-index", keys: directoryKeys }, pageSize: 100, cursor, deadlineAt,
        }, token);
        // Coverage describes provider thread discovery, not whether a returned
        // directory's path is usable. Probe only the requested owner members
        // already present in this page, even while another provider is checking
        // or degraded. Missing members schedule no work and are never inferred
        // from caller-supplied keys.
        if (page.unchanged) throw new Error("Directory refresh returned no metadata.");
        bytes += Buffer.byteLength(JSON.stringify(page), "utf8");
        if (bytes > 512 * 1024) throw new Error("Directory refresh metadata exceeds its bounded budget.");
        for (const directory of page.directories ?? []) {
          if (!directoryKeys.includes(directory.key) || seen.has(directory.key)) throw new Error("Directory refresh returned inconsistent owner membership.");
          seen.add(directory.key);
          if (directory.path?.trim()) directories.push({ key: directory.key, path: directory.path, latestUpdatedAt: directory.latestUpdatedAt });
        }
        if (page.complete) break;
        if (!page.nextCursor || count === 15) throw new Error("Directory refresh did not reach a complete owner page range.");
        cursor = page.nextCursor;
      }
    } finally { this.ports.releaseNavigationPage(token); }
    const scheduledCount = this.startDirectoryGitStatusRefresh({
      automatic: false,
      directories,
      force: request.force ?? true,
      requestKey: "explicit",
    });

    return { scheduledCount };
  }

  async loadDirectoryGitStatusCache(): Promise<void> {
    if (this.directoryGitStatusCacheLoaded) {
      return;
    }
    this.directoryGitStatusCacheLoaded = true;

    const entries = await this.ports.getOverlayStore().readDirectoryGitStatusCache();
    for (const entry of Object.values(entries)) {
      this.directoryGitStatusByKey.set(entry.directoryKey, entry);
    }
  }

  startDirectoryGitStatusRefresh(params: {
    automatic: boolean;
    directories: DirectoryGitRefreshTarget[];
    force?: boolean;
    requestKey: string;
  }): number {
    const directories = this.selectDirectoryGitStatusRefreshCandidates(params).filter(
      (directory) => !this.pendingDirectoryGitStatusKeys.has(directory.key),
    );
    if (directories.length === 0) {
      return 0;
    }

    const refreshKey = JSON.stringify({
      request: params.requestKey,
      directoryKeys: directories.map((directory) => directory.key),
      force: params.force === true,
    });
    if (this.pendingDirectoryGitStatusRefreshes.has(refreshKey)) {
      return 0;
    }

    if (params.automatic) {
      this.automaticDirectoryGitStatusRefreshesStarted += directories.length;
    }
    for (const directory of directories) {
      this.pendingDirectoryGitStatusKeys.add(directory.key);
    }

    this.ports.logDebug("directoryGitStatusRefresh:scheduled", {
      mode: params.automatic ? "automatic" : "explicit",
      count: directories.length,
      automaticStarted: this.automaticDirectoryGitStatusRefreshesStarted,
      automaticLimit: STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT,
    });

    const promise = this.refreshDirectoryGitStatuses(
      directories,
      params.force === true,
    )
      .catch((error) => {
        this.ports.logDebug("directoryGitStatusRefresh:failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        for (const directory of directories) {
          this.pendingDirectoryGitStatusKeys.delete(directory.key);
        }
        if (this.pendingDirectoryGitStatusRefreshes.get(refreshKey) === promise) {
          this.pendingDirectoryGitStatusRefreshes.delete(refreshKey);
        }
      });
    this.pendingDirectoryGitStatusRefreshes.set(refreshKey, promise);
    return directories.length;
  }

  private selectDirectoryGitStatusRefreshCandidates(params: {
    automatic: boolean;
    directories: DirectoryGitRefreshTarget[];
    force?: boolean;
  }): DirectoryGitRefreshTarget[] {
    const candidates = params.directories.filter((directory) => {
      if (!directory.path?.trim()) {
        return false;
      }
      const cached = this.directoryGitStatusByKey.get(directory.key);
      if (params.force) {
        // Forced refreshes bypass the normal freshness gate, but still
        // collapse a burst of same-key re-enqueues that land within a few
        // seconds of the previous probe completing (e.g. rapidly flipping
        // between two threads in the same repo). In-flight requests already
        // coalesce via `pendingDirectoryGitStatusKeys`; this closes the
        // sequential post-completion gap.
        return (
          !cached ||
          Date.now() - cached.fetchedAt >=
            DIRECTORY_GIT_STATUS_FORCE_COALESCE_WINDOW_MS
        );
      }
      if (!cached) {
        return true;
      }
      if (!isFreshDirectoryGitStatusCacheEntry(cached)) {
        return true;
      }
      return (directory.latestUpdatedAt ?? 0) > (cached.directoryUpdatedAt ?? 0);
    });

    if (!params.automatic) {
      return candidates;
    }

    const remaining =
      STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT -
      this.automaticDirectoryGitStatusRefreshesStarted;
    if (remaining <= 0) {
      return [];
    }

    return [...candidates]
      .sort((left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0))
      .slice(0, remaining);
  }

  async refreshLaunchpadDirectoryGitStatus(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<{
    gitStatus?: NavigationDirectoryGitStatus | null;
    request: EnsureDirectoryLaunchpadRequest;
  }> {
    const launchpadPath = request.directoryPath?.trim();
    const statusSourcePath =
      request.gitStatusSourcePath?.trim() || launchpadPath;
    if (!statusSourcePath) {
      return { request };
    }

    const cachedDirectory = this.ports.findDirectory(request.directoryKey);
    const statusDirectory: NavigationSnapshot["directories"][number] = {
      key: request.directoryKey,
      kind: request.directoryKind,
      label: request.directoryLabel,
      path: statusSourcePath,
      threadKeys: [],
      needsAttentionCount: 0,
      ...(cachedDirectory?.latestUpdatedAt !== undefined
        ? { latestUpdatedAt: cachedDirectory.latestUpdatedAt }
        : {}),
    };
    const cacheDirectory = {
      ...statusDirectory,
      path: launchpadPath ?? statusSourcePath,
    };

    try {
      for await (const entry of this.ports.readDirectoryStatusEntries([statusDirectory])) {
        const fetchedAt = Date.now();
        // Non-Git workspaces have no status; the reader reports actual probe
        // failures as status-unavailable. An explicit source path is used for
        // ordinary scratch-workspace subthreads too, so it does not imply Git.
        const gitStatus = entry.gitStatus;
        try {
          await this.writeDirectoryGitStatusEntry({
            directory: cacheDirectory,
            directoryKey: entry.directoryKey,
            fetchedAt,
            gitStatus,
          });
        } catch (error) {
          appServerLog.warn("failed to persist launchpad branch status", {
            directoryKey: request.directoryKey,
            error: error instanceof Error ? error.message : String(error),
            statusSourcePath,
          });
        }
        if (gitStatus?.syncState === "status-unavailable") {
          appServerLog.warn("launchpad branch status unavailable", {
            directoryKey: request.directoryKey,
            error: gitStatus.statusUnavailableReason,
            statusSourcePath,
          });
        }
        return {
          gitStatus: gitStatus ?? null,
          request: gitStatus?.currentBranch
            ? {
                ...request,
                currentBranch: gitStatus.currentBranch,
              }
            : request,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appServerLog.warn("launchpad branch status refresh failed", {
        directoryKey: request.directoryKey,
        error: message,
        statusSourcePath,
      });
      return {
        gitStatus: {
          syncState: "status-unavailable",
          statusUnavailableReason: message,
        },
        request,
      };
    }

    if (request.gitStatusSourcePath) {
      const statusUnavailableReason =
        `Git branch information is unavailable for ${statusSourcePath}.`;
      appServerLog.warn("launchpad branch status unavailable", {
        directoryKey: request.directoryKey,
        error: statusUnavailableReason,
        statusSourcePath,
      });
      return {
        gitStatus: {
          syncState: "status-unavailable",
          statusUnavailableReason,
        },
        request,
      };
    }

    return { gitStatus: null, request };
  }

  private async refreshDirectoryGitStatuses(
    directories: DirectoryGitRefreshTarget[],
    force = false,
  ): Promise<void> {
    const refreshableDirectories = directories.filter((directory) => directory.path?.trim());
    if (refreshableDirectories.length === 0) {
      return;
    }

    const directoryByKey = new Map(
      refreshableDirectories.map((directory) => [directory.key, directory]),
    );
    for await (const entry of this.ports.readDirectoryStatusEntries(refreshableDirectories, {
      userAction: force, caller: "directory-status-ipc",
    })) {
      const directory = directoryByKey.get(entry.directoryKey);
      const fetchedAt = Date.now();
      await this.writeDirectoryGitStatusEntry({
        directory,
        directoryKey: entry.directoryKey,
        fetchedAt,
        gitStatus: entry.gitStatus,
      });
    }
  }

  async writeDirectoryGitStatusEntry(params: {
    directory?: DirectoryGitRefreshTarget;
    directoryKey: string;
    fetchedAt: number;
    gitStatus?: NavigationDirectoryGitStatus;
  }): Promise<void> {
    const current = this.directoryGitStatusByKey.get(params.directoryKey);
    const directoryPath = params.directory?.path ?? current?.directoryPath;
    const directoryUpdatedAt =
      params.directory?.latestUpdatedAt ?? current?.directoryUpdatedAt;
    const cacheEntry: DirectoryGitStatusCacheEntry = {
      directoryKey: params.directoryKey,
      ...(directoryPath ? { directoryPath } : {}),
      ...(directoryUpdatedAt !== undefined ? { directoryUpdatedAt } : {}),
      fetchedAt: params.fetchedAt,
      ...(params.gitStatus ? { gitStatus: params.gitStatus } : {}),
    };
    this.directoryGitStatusByKey.set(params.directoryKey, cacheEntry);
    await this.ports.getOverlayStore().writeDirectoryGitStatusCacheEntry(cacheEntry);
    if (isDeepStrictEqual(current?.gitStatus ?? null, params.gitStatus ?? null)) return;
    const notification: NavigationDirectoryGitStatusUpdatedNotification = {
      method: "navigation/directoryGitStatus/updated",
      params: {
        directoryKey: params.directoryKey,
        gitStatus: params.gitStatus ?? null,
        fetchedAt: params.fetchedAt,
      },
    };
    await this.ports.publishLocalEvent({
      backend: "codex",
      notification,
    } as unknown as AgentEvent);
  }

  applyCachedStatus(directory: NavigationSnapshot["directories"][number]): NavigationSnapshot["directories"][number] {
    const cached = this.directoryGitStatusByKey.get(directory.key);
    return cached ? applyDirectoryGitStatus(directory, cached.gitStatus) : directory;
  }

  clear(): void {
    this.pendingDirectoryGitStatusRefreshes.clear();
    this.pendingDirectoryGitStatusKeys.clear();
    this.directoryGitStatusByKey.clear();
    this.directoryGitStatusCacheLoaded = false;
    this.automaticDirectoryGitStatusRefreshesStarted = 0;
  }
}
