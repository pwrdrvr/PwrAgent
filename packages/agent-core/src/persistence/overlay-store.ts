import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  MarkThreadSeenResponse,
  NavigationSnapshot,
  ThreadOverlayState,
} from "@pwragnt/shared";
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
    backend: AppServerBackendKind;
    fetchedAt: number;
    threads: AppServerThreadSummary[];
  }): Promise<NavigationSnapshot> {
    return await this.withData(async (data) => {
      const backendState = data.backends[params.backend];
      const firstSnapshot = !backendState?.lastSnapshotHash;
      const overlayByThreadId = Object.fromEntries(
        params.threads.map((thread) => [thread.id, data.threads[thread.id]]),
      );

      if (firstSnapshot) {
        for (const thread of params.threads) {
          data.threads[thread.id] = {
            threadId: thread.id,
            lastSeenAt: params.fetchedAt,
            lastSeenUpdatedAt: thread.updatedAt,
            extraLinkedDirectories:
              data.threads[thread.id]?.extraLinkedDirectories ?? [],
          };
        }
      }

      const snapshot = buildNavigationSnapshot({
        backend: params.backend,
        fetchedAt: params.fetchedAt,
        firstSnapshot,
        overlayByThreadId: Object.fromEntries(
          params.threads.map((thread) => [thread.id, data.threads[thread.id]]),
        ),
        previousKnownThreadIds: backendState?.knownThreadIds ?? [],
        threads: params.threads,
        unchanged: false,
      });

      const nextHash = buildNavigationSnapshotHash({
        backend: params.backend,
        threads: snapshot.threads,
      });
      const unchanged = backendState?.lastSnapshotHash === nextHash;

      data.backends[params.backend] = {
        knownThreadIds: params.threads.map((thread) => thread.id),
        lastSnapshotHash: nextHash,
      };

      return {
        ...snapshot,
        unchanged,
      };
    });
  }

  async markThreadSeen(params: {
    backend: AppServerBackendKind;
    seenAt?: number;
    seenUpdatedAt?: number;
    threadId: string;
  }): Promise<MarkThreadSeenResponse> {
    return await this.withData(async (data) => {
      const current = data.threads[params.threadId];
      const seenAt = params.seenAt ?? Date.now();

      data.threads[params.threadId] = {
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
    directory: LinkedDirectorySummary;
    threadId: string;
  }): Promise<ThreadOverlayState> {
    return await this.withData(async (data) => {
      const current = data.threads[params.threadId] ?? {
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
      data.threads[params.threadId] = nextState;
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
