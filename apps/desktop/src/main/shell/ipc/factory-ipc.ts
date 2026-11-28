import type { FactoryAdmission } from "@pwragent/owner-core/factory-admission";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { parseThreadUrl } from "@pwragent/shared/contracts/thread-link";
import type { FactoryProjectOption, FactoryProjectProjection } from "@pwragent/shared/factory-projection";
import {
  FACTORY_ADMISSION_CHANNEL,
  FACTORY_LANDING_CHANNEL,
  FACTORY_OPEN_THREAD_CHANNEL,
  FACTORY_OPEN_WINDOW_CHANNEL,
  FACTORY_PROJECT_READ_CHANNEL,
  FACTORY_PROJECTS_CHANNEL,
} from "../../../shared/ipc";
import { showFactoryWindow } from "../factory-window";
import { primaryMainWindowWebContents } from "../primary-main-window";
import { federationTargetForChannelSubscriber, isFactoryWindowWebContents, isLocalMainWindowWebContents } from "../window-channels";
import { requestShowThread } from "../window-show-thread";

const channels = [
  FACTORY_ADMISSION_CHANNEL,
  FACTORY_LANDING_CHANNEL,
  FACTORY_PROJECT_READ_CHANNEL,
  FACTORY_PROJECTS_CHANNEL,
  FACTORY_OPEN_WINDOW_CHANNEL,
  FACTORY_OPEN_THREAD_CHANNEL,
];

function isTopFrame(event: IpcMainInvokeEvent): boolean {
  return !!event.senderFrame && event.senderFrame === event.sender.mainFrame;
}

function requireFactoryWindow(event: IpcMainInvokeEvent): void {
  if (!isTopFrame(event) || !isFactoryWindowWebContents(event.sender)) {
    throw new Error("Open the Factory window in this profile.");
  }
}

export function registerFactoryIpcHandlers(owner: {
  readFactoryProject(request: unknown): Promise<FactoryProjectProjection>;
  listFactoryProjects(): Promise<FactoryProjectOption[]>;
}, admission?: Pick<FactoryAdmission, "command">, landing?: false | ((request: unknown) => Promise<unknown>)): void {
  disposeFactoryIpcHandlers();
  ipcMain.handle(FACTORY_ADMISSION_CHANNEL, (event, request: unknown) => {
    if (!isTopFrame(event) || !isLocalMainWindowWebContents(event.sender)) {
      throw new Error("Factory admission is available to this profile's local operator.");
    }
    if (!admission) throw new Error("Factory requires an active owner profile.");
    return admission.command(request);
  });
  ipcMain.handle(FACTORY_LANDING_CHANNEL, (event, request: unknown) => {
    if (!isTopFrame(event) || federationTargetForChannelSubscriber(event.sender)
      || (!isLocalMainWindowWebContents(event.sender) && !isFactoryWindowWebContents(event.sender))) {
      throw new Error("Factory landing is available to this profile's local operator.");
    }
    if (!landing) throw new Error("Factory landing requires an active owner profile.");
    return landing(request);
  });
  ipcMain.handle(FACTORY_PROJECT_READ_CHANNEL, (event, request: unknown) => {
    if (!isTopFrame(event)
      || (!isLocalMainWindowWebContents(event.sender) && !isFactoryWindowWebContents(event.sender))) {
      throw new Error("Factory evidence is available to this profile's local operator.");
    }
    return owner.readFactoryProject(request);
  });
  ipcMain.handle(FACTORY_PROJECTS_CHANNEL, (event) => {
    requireFactoryWindow(event);
    return owner.listFactoryProjects();
  });
  ipcMain.handle(FACTORY_OPEN_WINDOW_CHANNEL, (event) => {
    if (!isTopFrame(event) || !isLocalMainWindowWebContents(event.sender)) {
      throw new Error("Open Factory from the local main window.");
    }
    showFactoryWindow({ sourceWindow: BrowserWindow.fromWebContents(event.sender) ?? undefined });
  });
  ipcMain.handle(FACTORY_OPEN_THREAD_CHANNEL, (event, reference: unknown) => {
    requireFactoryWindow(event);
    const ref = typeof reference === "string" && reference.length <= 1024 ? parseThreadUrl(reference) : undefined;
    if (!ref?.backend || ref.instanceId || ref.profile) throw new Error("This evidence has no local thread link.");
    const target = primaryMainWindowWebContents();
    const routed = target && requestShowThread({
      backend: ref.backend, threadId: ref.threadId, messageId: ref.messageId,
    }, { preferWebContents: target, requirePreferred: true });
    if (!routed) throw new Error("Open the main PwrAgent window to view this thread.");
  });
}

export function disposeFactoryIpcHandlers(): void {
  for (const channel of channels) ipcMain.removeHandler(channel);
}
