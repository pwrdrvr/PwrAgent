import { ipcMain } from "electron";
import type { AppUpdateNoticeAgentIdentity } from "../../../shared/app-metadata";
import { APP_UPDATE_NOTICE_AGENTS_CHANNEL, APP_UPDATE_NOTICE_AGENT_SET_CHANNEL } from "../../../shared/ipc";
import { listAgentUpdateNoticeSettings, setAgentUpdateNoticeSetting } from "../../messaging/agent-update-notices";

export function registerAppUpdateNoticeIpcHandlers(): void {
  disposeAppUpdateNoticeIpcHandlers();
  ipcMain.handle(APP_UPDATE_NOTICE_AGENTS_CHANNEL, () => listAgentUpdateNoticeSettings());
  ipcMain.handle(APP_UPDATE_NOTICE_AGENT_SET_CHANNEL, (_event, request: AppUpdateNoticeAgentIdentity & { enabled: boolean }) => {
    if (typeof request?.backend !== "string" || typeof request.threadId !== "string"
      || typeof request.enabled !== "boolean") throw new Error("Invalid Agent update notice setting.");
    return setAgentUpdateNoticeSetting(request, request.enabled);
  });
}

export function disposeAppUpdateNoticeIpcHandlers(): void {
  ipcMain.removeHandler(APP_UPDATE_NOTICE_AGENTS_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_NOTICE_AGENT_SET_CHANNEL);
}
