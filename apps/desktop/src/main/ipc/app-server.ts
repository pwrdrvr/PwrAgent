import { app, ipcMain } from "electron";
import path from "node:path";
import { OverlayStore } from "@pwragnt/agent-core";
import type {
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  GetNavigationSnapshotRequest,
  MarkThreadSeenRequest,
  MarkThreadSeenResponse,
  NavigationSnapshot,
} from "@pwragnt/shared";
import { CodexAppServerClient } from "../codex-app-server/client";
import {
  APP_SERVER_LIST_THREADS_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
} from "../../shared/ipc";

const isDevelopment = process.env.NODE_ENV !== "production";

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  console.info(`[pwragnt:app-server] ${event}`, payload);
}

function parseEnvArgs(rawArgs: string | undefined): string[] {
  if (!rawArgs?.trim()) {
    return [];
  }

  return rawArgs
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

class DesktopAppServerService {
  private codexClient: CodexAppServerClient | null = null;
  private overlayStore: OverlayStore | null = null;

  async listThreads(
    request: AppServerListThreadsRequest = {}
  ): Promise<AppServerListThreadsResponse> {
    const backend = request.backend ?? "codex";

    if (backend !== "codex") {
      throw new Error(`${backend} app server is not wired yet`);
    }

    const client = this.getCodexClient();
    const threads = await client.listThreads({
      filter: request.filter
    });

    logDebug("listThreads", {
      backend,
      count: threads.length,
      threadIds: threads.slice(0, 5).map((thread) => thread.id)
    });

    return {
      backend,
      fetchedAt: Date.now(),
      threads
    };
  }

  async readThread(
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> {
    const backend = request.backend ?? "codex";

    if (backend !== "codex") {
      throw new Error(`${backend} app server is not wired yet`);
    }

    const client = this.getCodexClient();
    const replay = await client.readThread({
      threadId: request.threadId
    });

    logDebug("readThread", {
      backend,
      threadId: request.threadId,
      hasLastUserMessage: Boolean(replay.lastUserMessage),
      hasLastAssistantMessage: Boolean(replay.lastAssistantMessage)
    });

    return {
      backend,
      fetchedAt: Date.now(),
      threadId: request.threadId,
      replay
    };
  }

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    const backend = request.backend ?? "codex";

    if (backend !== "codex") {
      throw new Error(`${backend} app server is not wired yet`);
    }

    const client = this.getCodexClient();
    const threads = await client.listThreads({
      filter: request.filter,
    });
    const snapshot = await this.getOverlayStore().reconcileNavigationSnapshot({
      backend,
      fetchedAt: Date.now(),
      threads,
    });

    logDebug("getNavigationSnapshot", {
      backend,
      count: snapshot.threads.length,
      inboxCount: snapshot.inboxThreadIds.length,
      unchanged: snapshot.unchanged,
    });

    return snapshot;
  }

  async markThreadSeen(
    request: MarkThreadSeenRequest,
  ): Promise<MarkThreadSeenResponse> {
    const backend = request.backend ?? "codex";

    if (backend !== "codex") {
      throw new Error(`${backend} app server is not wired yet`);
    }

    const response = await this.getOverlayStore().markThreadSeen({
      backend,
      seenAt: request.seenAt,
      seenUpdatedAt: request.seenUpdatedAt,
      threadId: request.threadId,
    });

    logDebug("markThreadSeen", {
      backend,
      threadId: request.threadId,
      seenUpdatedAt: request.seenUpdatedAt ?? null,
    });

    return response;
  }

  async close(): Promise<void> {
    await this.codexClient?.close();
    this.codexClient = null;
  }

  private getCodexClient(): CodexAppServerClient {
    if (this.codexClient) {
      return this.codexClient;
    }

    this.codexClient = new CodexAppServerClient({
      command: process.env.PWRAGNT_CODEX_COMMAND?.trim() || "codex",
      args: parseEnvArgs(process.env.PWRAGNT_CODEX_ARGS),
      requestTimeoutMs: 20_000
    });

    return this.codexClient;
  }

  private getOverlayStore(): OverlayStore {
    if (this.overlayStore) {
      return this.overlayStore;
    }

    this.overlayStore = new OverlayStore(
      path.join(app.getPath("userData"), "overlay-state.json"),
    );

    return this.overlayStore;
  }
}

const appServerService = new DesktopAppServerService();

export function registerAppServerIpcHandlers(): void {
  ipcMain.removeHandler(APP_SERVER_LIST_THREADS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_LIST_THREADS_CHANNEL,
    async (
      _event,
      request?: AppServerListThreadsRequest
    ): Promise<AppServerListThreadsResponse> => {
      return await appServerService.listThreads(request);
    }
  );
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_READ_THREAD_CHANNEL,
    async (
      _event,
      request: AppServerReadThreadRequest
    ): Promise<AppServerReadThreadResponse> => {
      return await appServerService.readThread(request);
    }
  );
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SNAPSHOT_CHANNEL,
    async (
      _event,
      request?: GetNavigationSnapshotRequest,
    ): Promise<NavigationSnapshot> => {
      return await appServerService.getNavigationSnapshot(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
    async (
      _event,
      request: MarkThreadSeenRequest,
    ): Promise<MarkThreadSeenResponse> => {
      return await appServerService.markThreadSeen(request);
    },
  );
}

export async function disposeAppServerIpcHandlers(): Promise<void> {
  ipcMain.removeHandler(APP_SERVER_LIST_THREADS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  await appServerService.close();
}
export { APP_SERVER_LIST_THREADS_CHANNEL };
