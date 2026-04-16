import { contextBridge, ipcRenderer } from "electron";
import type {
  AppServerListThreadsRequest,
  AppServerListThreadsResponse
} from "@pwragnt/shared";
import { APP_SERVER_LIST_THREADS_CHANNEL } from "../shared/ipc";

const desktopApi = Object.freeze({
  ping: () => "pong",
  listThreads: async (
    request?: AppServerListThreadsRequest
  ): Promise<AppServerListThreadsResponse> =>
    await ipcRenderer.invoke(APP_SERVER_LIST_THREADS_CHANNEL, request),
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  }
});

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("pwragnt", desktopApi);
}
