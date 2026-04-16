import { contextBridge, ipcRenderer } from "electron";
import type {
  AppServerListThreadsRequest,
  AppServerListThreadsResponse,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse
} from "@pwragnt/shared";
import {
  APP_SERVER_LIST_THREADS_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL
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
