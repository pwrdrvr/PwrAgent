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
import {
  isFederationPeerUnavailableError,
} from "../federation/federation-peer-unavailable-error";

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
  const cachedRemoteLists = new Map<
    string,
    ListScheduledThreadActionsResponse
  >();
  const pendingRemoteLists = new Map<
    string,
    Promise<ListScheduledThreadActionsResponse>
  >();

  const listRemoteActions = async (
    request: ListScheduledThreadActionsRequest,
  ): Promise<ListScheduledThreadActionsResponse> => {
    const target = request.federationTarget;
    if (!target || !isRemoteFederationTarget(target)) {
      return getScheduledThreadActionService().list(request);
    }
    const localRequest = stripFederationTarget(request);
    // terminalUpdatedAfter advances every reconciliation pass, but the last
    // successful response remains the correct stale projection for this
    // target/thread scope during an outage.
    const cacheKey = JSON.stringify({
      instanceId: target.instanceId,
      backend: request.backend ?? "all",
      threadId: request.threadId ?? "",
    });
    const pendingKey = JSON.stringify({ cacheKey, request: localRequest });
    const pending = pendingRemoteLists.get(pendingKey);
    if (pending) {
      return await pending;
    }
    const operation = (async () => {
      try {
        const response = await getDesktopFederationRuntime()
          .remoteBackend(target)
          .listScheduledThreadActions(localRequest);
        cachedRemoteLists.set(cacheKey, response);
        return response;
      } catch (error) {
        if (!isFederationPeerUnavailableError(error)) {
          throw error;
        }
        // Resolve normally so Electron never prints an expected disconnect
        // stack. Do not advance observedAt: reconnect must resume from the
        // last owner clock cursor and collect terminal actions from the gap.
        return cachedRemoteLists.get(cacheKey) ?? { actions: [] };
      }
    })().finally(() => {
      pendingRemoteLists.delete(pendingKey);
    });
    pendingRemoteLists.set(pendingKey, operation);
    return await operation;
  };

  ipcMain.removeHandler(SCHEDULED_ACTIONS_LIST_CHANNEL);
  ipcMain.handle(
    SCHEDULED_ACTIONS_LIST_CHANNEL,
    async (
      _event,
      request?: ListScheduledThreadActionsRequest,
    ): Promise<ListScheduledThreadActionsResponse> => {
      const routedRequest = request ?? {};
      return await listRemoteActions(routedRequest);
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
