import { ipcMain } from "electron";
import type {
  CreateScheduledThreadActionRequest,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  UpdateScheduledThreadActionRequest,
} from "@pwragent/shared";
import {
  SCHEDULED_ACTIONS_CANCEL_CHANNEL,
  SCHEDULED_ACTIONS_CREATE_CHANNEL,
  SCHEDULED_ACTIONS_LIST_CHANNEL,
  SCHEDULED_ACTIONS_SEND_NOW_CHANNEL,
  SCHEDULED_ACTIONS_UPDATE_CHANNEL,
} from "../../shared/ipc";
import {
  disposeScheduledThreadActionService,
  getScheduledThreadActionService,
} from "../scheduled-actions/scheduled-thread-action-service";

export function registerScheduledActionIpcHandlers(): void {
  getScheduledThreadActionService();

  ipcMain.removeHandler(SCHEDULED_ACTIONS_LIST_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_LIST_CHANNEL,
    (
      _event,
      request?: ListScheduledThreadActionsRequest,
    ): ListScheduledThreadActionsResponse =>
      getScheduledThreadActionService().list(request),
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_CREATE_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_CREATE_CHANNEL,
    async (
      _event,
      request: CreateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> =>
      await getScheduledThreadActionService().create(request),
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_UPDATE_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_UPDATE_CHANNEL,
    async (
      _event,
      request: UpdateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> =>
      await getScheduledThreadActionService().update(request),
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_CANCEL_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_CANCEL_CHANNEL,
    async (
      _event,
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> =>
      await getScheduledThreadActionService().cancel(request),
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_SEND_NOW_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_SEND_NOW_CHANNEL,
    async (
      _event,
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> =>
      await getScheduledThreadActionService().sendNow(request),
  );
}

export function disposeScheduledActionIpcHandlers(): void {
  ipcMain.removeHandler(SCHEDULED_ACTIONS_LIST_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_CREATE_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_UPDATE_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_CANCEL_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_SEND_NOW_CHANNEL);
  disposeScheduledThreadActionService();
}
