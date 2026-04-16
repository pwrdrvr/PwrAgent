import { contextBridge, ipcRenderer } from "electron";
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
import {
  APP_SERVER_LIST_THREADS_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  WINDOW_FOCUS_SYNC_CHANNEL,
} from "../shared/ipc";

console.info("[pwragnt:preload] start", {
  contextIsolated: process.contextIsolated,
  platform: process.platform,
  electron: process.versions.electron
});

const desktopApi = Object.freeze({
  ping: () => "pong",
  listThreads: async (
    request?: AppServerListThreadsRequest
  ): Promise<AppServerListThreadsResponse> =>
    await ipcRenderer.invoke(APP_SERVER_LIST_THREADS_CHANNEL, request),
  readThread: async (
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> =>
    await ipcRenderer.invoke(APP_SERVER_READ_THREAD_CHANNEL, request),
  getNavigationSnapshot: async (
    request?: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot> =>
    await ipcRenderer.invoke(NAVIGATION_SNAPSHOT_CHANNEL, request),
  markThreadSeen: async (
    request: MarkThreadSeenRequest,
  ): Promise<MarkThreadSeenResponse> =>
    await ipcRenderer.invoke(NAVIGATION_MARK_THREAD_SEEN_CHANNEL, request),
  onWindowFocus: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on(WINDOW_FOCUS_SYNC_CHANNEL, listener);
    return () => {
      ipcRenderer.off(WINDOW_FOCUS_SYNC_CHANNEL, listener);
    };
  },
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  }
});

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("pwragnt", desktopApi);
  console.info("[pwragnt:preload] exposed context bridge", {
    keys: Object.keys(desktopApi)
  });
} else {
  console.warn("[pwragnt:preload] context isolation disabled; bridge not exposed");
}
