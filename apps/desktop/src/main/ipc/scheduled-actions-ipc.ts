import { ipcMain } from "electron";
import type {
  CreateScheduledThreadActionRequest,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  UpdateScheduledThreadActionRequest,
} from "@pwragent/shared";
import { isRemoteFederationTarget } from "@pwragent/shared";
import {
  SCHEDULED_ACTIONS_CANCEL_CHANNEL,
  SCHEDULED_ACTIONS_CREATE_CHANNEL,
  SCHEDULED_ACTIONS_LIST_CHANNEL,
  SCHEDULED_ACTIONS_SEND_NOW_CHANNEL,
  SCHEDULED_ACTIONS_UPDATE_CHANNEL,
} from "../../shared/ipc";
import { getScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";

function remoteBackendFor(request: {
  federationTarget?: CreateScheduledThreadActionRequest["federationTarget"];
}) {
  return request.federationTarget
    && isRemoteFederationTarget(request.federationTarget)
    ? getDesktopFederationRuntime().remoteBackend(request.federationTarget)
    : undefined;
}

function stripFederationTarget<T extends {
  federationTarget?: CreateScheduledThreadActionRequest["federationTarget"];
}>(request: T): Omit<T, "federationTarget"> {
  const { federationTarget: _federationTarget, ...localRequest } = request;
  return localRequest;
}

export function registerScheduledActionIpcHandlers(): void {
  getScheduledThreadActionService();

  ipcMain.removeHandler(SCHEDULED_ACTIONS_LIST_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_LIST_CHANNEL,
    async (
      _event,
      request?: ListScheduledThreadActionsRequest,
    ): Promise<ListScheduledThreadActionsResponse> => {
      const routedRequest = request ?? {};
      const remote = remoteBackendFor(routedRequest);
      return remote
        ? await remote.listScheduledThreadActions(
            stripFederationTarget(routedRequest),
          )
        : getScheduledThreadActionService().list(routedRequest);
    },
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_CREATE_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_CREATE_CHANNEL,
    async (
      _event,
      request: CreateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> => {
      const remote = remoteBackendFor(request);
      return remote
        ? await remote.createScheduledThreadAction(stripFederationTarget(request))
        : await getScheduledThreadActionService().create(request);
    },
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_UPDATE_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_UPDATE_CHANNEL,
    async (
      _event,
      request: UpdateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> => {
      const remote = remoteBackendFor(request);
      return remote
        ? await remote.updateScheduledThreadAction(stripFederationTarget(request))
        : await getScheduledThreadActionService().update(request);
    },
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_CANCEL_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_CANCEL_CHANNEL,
    async (
      _event,
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> => {
      const remote = remoteBackendFor(request);
      return remote
        ? await remote.cancelScheduledThreadAction(stripFederationTarget(request))
        : await getScheduledThreadActionService().cancel(request);
    },
  );

  ipcMain.removeHandler(SCHEDULED_ACTIONS_SEND_NOW_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_SEND_NOW_CHANNEL,
    async (
      _event,
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> => {
      const remote = remoteBackendFor(request);
      return remote
        ? await remote.sendScheduledThreadActionNow(stripFederationTarget(request))
        : await getScheduledThreadActionService().sendNow(request);
    },
  );
}

export function disposeScheduledActionIpcHandlers(): void {
  ipcMain.removeHandler(SCHEDULED_ACTIONS_LIST_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_CREATE_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_UPDATE_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_CANCEL_CHANNEL);
  ipcMain.removeHandler(SCHEDULED_ACTIONS_SEND_NOW_CHANNEL);
}
