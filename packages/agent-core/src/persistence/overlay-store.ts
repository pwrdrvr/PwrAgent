import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerBackendScope,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  MarkThreadSeenResponse,
  NavigationSnapshot,
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
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async reconcileNavigationSnapshot(params: {
    backend: AppServerBackendScope;
    fetchedAt: number;
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
        overlayByThreadKey,
        previousKnownThreadKeys: backendState?.knownThreadKeys ?? [],
        threads: params.threads,
        unchanged: false,
      });

      const nextHash = buildNavigationSnapshotHash({
        backend: params.backend,
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

  private async withData<T>(
    operation: (data: OverlayStoreData) => Promise<T> | T,
  ): Promise<T> {
    const next = this.queue.then(async () => {
      const data = await this.readData();
      const result = await operation(data);
      await this.writeData(data);
      return result;
    });

    this.queue = next.then(
      () => undefined,
      () => undefined,
    );

    return (await next) as T;
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
          threads: {},
        });
      }

      throw error;
    }
  }

  private async writeData(data: OverlayStoreData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}
