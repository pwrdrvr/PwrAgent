import { BrowserWindow, ipcMain } from "electron";
import type {
  AgentEvent,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
} from "@pwragnt/shared";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import {
  AGENT_EVENT_CHANNEL,
  AGENT_INTERRUPT_TURN_CHANNEL,
  AGENT_START_THREAD_CHANNEL,
  AGENT_START_TURN_CHANNEL,
  BACKEND_LIST_CHANNEL,
} from "../../shared/ipc";

let unsubscribeRegistryEvents: (() => void) | undefined;

function broadcastAgentEvent(event: AgentEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
      continue;
    }

    if (typeof window.webContents.send !== "function") {
      continue;
    }

    window.webContents.send(AGENT_EVENT_CHANNEL, event);
  }
}

export function registerAgentIpcHandlers(): void {
  const registry = getDesktopBackendRegistry();

  unsubscribeRegistryEvents?.();
  unsubscribeRegistryEvents = registry.onEvent((event) => {
    broadcastAgentEvent(event);
  });

  ipcMain.removeHandler(BACKEND_LIST_CHANNEL);
  ipcMain.handle(
    BACKEND_LIST_CHANNEL,
    async (
      _event,
      request?: ListBackendsRequest
    ): Promise<ListBackendsResponse> => {
      return await registry.listBackends(request);
    },
  );

  ipcMain.removeHandler(AGENT_START_THREAD_CHANNEL);
  ipcMain.handle(
    AGENT_START_THREAD_CHANNEL,
    async (
      _event,
      request: StartThreadRequest
    ): Promise<StartThreadResponse> => {
      return await registry.startThread(request);
    },
  );

  ipcMain.removeHandler(AGENT_START_TURN_CHANNEL);
  ipcMain.handle(
    AGENT_START_TURN_CHANNEL,
    async (
      _event,
      request: StartTurnRequest
    ): Promise<StartTurnResponse> => {
      return await registry.startTurn(request);
    },
  );

  ipcMain.removeHandler(AGENT_INTERRUPT_TURN_CHANNEL);
  ipcMain.handle(
    AGENT_INTERRUPT_TURN_CHANNEL,
    async (
      _event,
      request: InterruptTurnRequest
    ): Promise<InterruptTurnResponse> => {
      return await registry.interruptTurn(request);
    },
  );
}

export function disposeAgentIpcHandlers(): void {
  unsubscribeRegistryEvents?.();
  unsubscribeRegistryEvents = undefined;
  ipcMain.removeHandler(BACKEND_LIST_CHANNEL);
  ipcMain.removeHandler(AGENT_START_THREAD_CHANNEL);
  ipcMain.removeHandler(AGENT_START_TURN_CHANNEL);
  ipcMain.removeHandler(AGENT_INTERRUPT_TURN_CHANNEL);
}
