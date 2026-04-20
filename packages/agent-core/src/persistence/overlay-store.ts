import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerBackendScope,
  AppServerThreadSummary,
  DirectoryLaunchpadOverlayState,
  LinkedDirectorySummary,
  MarkThreadSeenResponse,
  NavigationDirectoryGitStatus,
  NavigationLaunchpadDefaults,
  NavigationSnapshot,
  ThreadExecutionMode,
  ThreadOverlayState,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import {
  buildNavigationSnapshot,
  buildNavigationSnapshotHash,
} from "../domain/navigation-state";
import {
  CURRENT_OVERLAY_STORE_VERSION,
  migrateOverlayStoreData,
  type OverlayStoreData,
} from "./migrations";

export class OverlayStore {
  private static readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly filePath: string) {}

  async reconcileNavigationSnapshot(params: {
    backend: AppServerBackendScope;
    fetchedAt: number;
    gitStatusByDirectoryKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
    threads: AppServerThreadSummary[];
  }): Promise<NavigationSnapshot> {
    return await this.withData(async (data) => {
      const backendState = data.backends[params.backend];
      const firstSnapshot = !backendState?.lastSnapshotHash;

      if (firstSnapshot) {
        for (const thread of params.threads) {
          const threadKey = buildThreadIdentityKey(thread.source, thread.id);
          data.threads[threadKey] = {
            backend: thread.source,
            threadId: thread.id,
            executionMode:
              data.threads[threadKey]?.executionMode ?? thread.executionMode ?? "default",
            model: data.threads[threadKey]?.model ?? thread.model,
            reasoningEffort:
              data.threads[threadKey]?.reasoningEffort ?? thread.reasoningEffort,
            serviceTier: data.threads[threadKey]?.serviceTier ?? thread.serviceTier,
            fastMode: data.threads[threadKey]?.fastMode ?? thread.fastMode,
            lastSeenAt: params.fetchedAt,
            lastSeenUpdatedAt: thread.updatedAt,
            extraLinkedDirectories:
              data.threads[threadKey]?.extraLinkedDirectories ?? [],
          };
        }
      }

      const overlayByThreadKey = Object.fromEntries(
        params.threads.map((thread) => {
          const threadKey = buildThreadIdentityKey(thread.source, thread.id);
          return [threadKey, data.threads[threadKey]];
        }),
      );

      const snapshot = buildNavigationSnapshot({
        backend: params.backend,
        fetchedAt: params.fetchedAt,
        firstSnapshot,
        gitStatusByDirectoryKey: params.gitStatusByDirectoryKey,
        launchpadDefaults: data.launchpadDefaults,
        launchpadsByKey: data.directoryLaunchpads,
        overlayByThreadKey,
        previousKnownThreadKeys: backendState?.knownThreadKeys ?? [],
        threads: params.threads,
        unchanged: false,
      });

      const nextHash = buildNavigationSnapshotHash({
        backend: params.backend,
        directories: snapshot.directories,
        launchpadDefaults: snapshot.launchpadDefaults,
        threads: snapshot.threads,
      });
      const unchanged = backendState?.lastSnapshotHash === nextHash;

      data.backends[params.backend] = {
        knownThreadKeys: params.threads.map((thread) =>
          buildThreadIdentityKey(thread.source, thread.id),
        ),
        lastSnapshotHash: nextHash,
      };

      return {
        ...snapshot,
        unchanged,
      };
    });
  }

  async markThreadSeen(params: {
    backend: ThreadOverlayState["backend"];
    seenAt?: number;
    seenUpdatedAt?: number;
    threadId: string;
  }): Promise<MarkThreadSeenResponse> {
    return await this.withData(async (data) => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      const current = data.threads[threadKey];
      const seenAt = params.seenAt ?? Date.now();

      data.threads[threadKey] = {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: current?.executionMode ?? "default",
        model: current?.model,
        reasoningEffort: current?.reasoningEffort,
        serviceTier: current?.serviceTier,
        fastMode: current?.fastMode,
        dismissedAt: current?.dismissedAt,
        snoozedUntil: current?.snoozedUntil,
        lastSeenAt: seenAt,
        lastSeenUpdatedAt: params.seenUpdatedAt ?? current?.lastSeenUpdatedAt,
        extraLinkedDirectories: current?.extraLinkedDirectories ?? [],
      };

      return {
        backend: params.backend,
        threadId: params.threadId,
        seenAt,
        seenUpdatedAt: params.seenUpdatedAt,
      };
    });
  }

  async addLinkedDirectory(params: {
    backend: ThreadOverlayState["backend"];
    directory: LinkedDirectorySummary;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    return await this.withData(async (data) => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      const current = data.threads[threadKey] ?? {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };

      const nextDirectories = [
        ...current.extraLinkedDirectories.filter(
          (directory) => directory.id !== params.directory.id,
        ),
        params.directory,
      ];

      const nextState: ThreadOverlayState = {
        ...current,
        extraLinkedDirectories: nextDirectories,
      };
      data.threads[threadKey] = nextState;
      return nextState;
    });
  }

  async getThreadExecutionMode(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<ThreadExecutionMode> {
    return await this.withReadData(async (data) => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      return data.threads[threadKey]?.executionMode ?? "default";
    });
  }

  async getThreadOverlayState(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
  }): Promise<ThreadOverlayState | undefined> {
    return await this.withReadData(async (data) => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      return data.threads[threadKey];
    });
  }

  async getThreadOverlayStates(params: {
    backend: ThreadOverlayState["backend"];
    threadIds: string[];
  }): Promise<Record<string, ThreadOverlayState | undefined>> {
    return await this.withReadData(async (data) =>
      Object.fromEntries(
        params.threadIds.map((threadId) => {
          const threadKey = buildThreadIdentityKey(params.backend, threadId);
          return [threadId, data.threads[threadKey]];
        }),
      ),
    );
  }

  async setThreadExecutionMode(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    executionMode: ThreadExecutionMode;
  }): Promise<ThreadOverlayState> {
    return await this.withData(async (data) => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      const current = data.threads[threadKey] ?? {
        backend: params.backend,
        threadId: params.threadId,
        extraLinkedDirectories: [],
      };
      const nextState: ThreadOverlayState = {
        ...current,
        executionMode: params.executionMode,
      };
      data.threads[threadKey] = nextState;
      return nextState;
    });
  }

  async setThreadModelSettings(params: {
    backend: ThreadOverlayState["backend"];
    threadId: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    fastMode?: boolean;
  }): Promise<ThreadOverlayState> {
    return await this.withData(async (data) => {
      const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
      const current = data.threads[threadKey] ?? {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: "default",
        extraLinkedDirectories: [],
      };
      const nextState: ThreadOverlayState = {
        ...current,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        serviceTier: params.serviceTier,
        fastMode: params.fastMode,
      };
      data.threads[threadKey] = nextState;
      return nextState;
    });
  }

  async getLaunchpadDefaults(): Promise<NavigationLaunchpadDefaults> {
    return await this.withReadData(async (data) => data.launchpadDefaults);
  }

  async setLaunchpadDefaults(
    patch: Partial<NavigationLaunchpadDefaults>,
  ): Promise<NavigationLaunchpadDefaults> {
    return await this.withData(async (data) => {
      data.launchpadDefaults = {
        ...data.launchpadDefaults,
        ...patch,
      };
      return data.launchpadDefaults;
    });
  }

  async getDirectoryLaunchpad(params: {
    directoryKey: string;
  }): Promise<DirectoryLaunchpadOverlayState | undefined> {
    return await this.withReadData(async (data) => data.directoryLaunchpads[params.directoryKey]);
  }

  async listDirectoryLaunchpads(): Promise<DirectoryLaunchpadOverlayState[]> {
    return await this.withReadData(async (data) => Object.values(data.directoryLaunchpads));
  }

  async upsertDirectoryLaunchpad(
    launchpad: DirectoryLaunchpadOverlayState,
  ): Promise<DirectoryLaunchpadOverlayState> {
    return await this.withData(async (data) => {
      const current = data.directoryLaunchpads[launchpad.directoryKey];
      const nextLaunchpad: DirectoryLaunchpadOverlayState = {
        ...current,
        ...launchpad,
        createdAt: current?.createdAt ?? launchpad.createdAt,
      };
      data.directoryLaunchpads[launchpad.directoryKey] = nextLaunchpad;
      return nextLaunchpad;
    });
  }

  async resetDirectoryLaunchpad(params: {
    directoryKey: string;
  }): Promise<void> {
    await this.withData(async (data) => {
      delete data.directoryLaunchpads[params.directoryKey];
    });
  }

  private async withData<T>(
    operation: (data: OverlayStoreData) => Promise<T> | T,
  ): Promise<T> {
    const currentQueue = OverlayStore.queues.get(this.filePath) ?? Promise.resolve();
    const next = currentQueue.then(async () => {
      const data = await this.readData();
      const result = await operation(data);
      await this.writeData(data);
      return result;
    });

    OverlayStore.queues.set(
      this.filePath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );

    return (await next) as T;
  }

  private async withReadData<T>(
    operation: (data: OverlayStoreData) => Promise<T> | T,
  ): Promise<T> {
    await (OverlayStore.queues.get(this.filePath) ?? Promise.resolve());
    return await operation(await this.readData());
  }

  private async readData(): Promise<OverlayStoreData> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return migrateOverlayStoreData(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return migrateOverlayStoreData({
          version: CURRENT_OVERLAY_STORE_VERSION,
          backends: {},
          launchpadDefaults: {
            backend: "codex",
            executionMode: "default",
          },
          directoryLaunchpads: {},
          threads: {},
        });
      }

      throw error;
    }
  }

  private async writeData(data: OverlayStoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}
