import { ipcMain } from "electron";
import {
  INTEGRATED_TERMINAL_CLOSE_CHANNEL,
  INTEGRATED_TERMINAL_CREATE_CHANNEL,
  INTEGRATED_TERMINAL_RESIZE_CHANNEL,
  INTEGRATED_TERMINAL_WRITE_CHANNEL,
} from "../../shared/ipc";
import type {
  IntegratedTerminalCloseRequest,
  IntegratedTerminalCreateRequest,
  IntegratedTerminalCreateResponse,
  IntegratedTerminalResizeRequest,
  IntegratedTerminalWriteRequest,
} from "../../shared/integrated-terminal";
import { IntegratedTerminalService } from "../terminal/integrated-terminal-service";
import type { IntegratedTerminalQuitSnapshot } from "../terminal/integrated-terminal-service";

let service: IntegratedTerminalService | undefined;

export function registerIntegratedTerminalIpcHandlers(): void {
  service ??= new IntegratedTerminalService();

  ipcMain.removeHandler(INTEGRATED_TERMINAL_CREATE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_CREATE_CHANNEL,
    async (
      event,
      request: IntegratedTerminalCreateRequest,
    ): Promise<IntegratedTerminalCreateResponse> =>
      await service!.createOrAttach(request, event.sender),
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_WRITE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_WRITE_CHANNEL,
    (_event, request: IntegratedTerminalWriteRequest): void => {
      service?.write(request);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_RESIZE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_RESIZE_CHANNEL,
    (_event, request: IntegratedTerminalResizeRequest): void => {
      service?.resize(request);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_CLOSE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_CLOSE_CHANNEL,
    (_event, request: IntegratedTerminalCloseRequest): void => {
      service?.close(request);
    },
  );
}

export function disposeIntegratedTerminalIpcHandlers(): void {
  ipcMain.removeHandler(INTEGRATED_TERMINAL_CREATE_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_WRITE_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_RESIZE_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_CLOSE_CHANNEL);
  service?.dispose();
  service = undefined;
}

export function getIntegratedTerminalQuitSnapshot(): IntegratedTerminalQuitSnapshot {
  return (
    service?.getQuitSnapshot() ?? {
      count: 0,
      sessionIds: [],
      threadKeys: [],
    }
  );
}
