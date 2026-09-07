import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { getDesktopNavigationQueryPool } from "../app-server/navigation-query-pool";
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
  const consumersBySender = new Map<number, { tokens: Set<string>; release: () => void }>();
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
      event,
      request?: ListScheduledThreadActionsRequest,
      consumerId?: string,
    ): Promise<ListScheduledThreadActionsResponse> => {
      const routedRequest = request ?? {};
      if (routedRequest.projectionProtocol === 2) {
        // A cached final page is not a complete replacement baseline. Outages
        // must reject V2 reads so the renderer retains its complete mirrors.
        if (consumerId !== undefined && (typeof consumerId !== "string" || consumerId.length > 256)) {
          throw new Error("Invalid scheduled projection consumer.");
        }
        const pool = getDesktopNavigationQueryPool();
        const token = JSON.stringify([event.sender?.id ?? 0, consumerId ?? randomUUID()]);
        const sender = event.sender;
        let owner = sender ? consumersBySender.get(sender.id) : undefined;
        if (sender && !owner) {
          const tokens = new Set<string>();
          owner = { tokens, release: () => {
            for (const consumer of tokens) pool.release(consumer);
            consumersBySender.delete(sender.id);
          } };
          consumersBySender.set(sender.id, owner);
          sender.once("destroyed", owner.release);
        }
        owner?.tokens.add(token);
        const { cursor, deadlineAt, ...identity } = stripFederationTarget(routedRequest);
        try {
          return await pool.readExact({ kind: "scheduled", consumerId: token, owner: routedRequest.federationTarget,
            identity: JSON.stringify(identity), operation: JSON.stringify({ cursor }), deadlineAt,
            load: async (options) => {
              const backend = remoteBackendFor(routedRequest);
              return backend ? backend.listScheduledThreadActions({ ...identity, cursor, deadlineAt: options.deadlineAt }, options)
                : getScheduledThreadActionService().list({ ...identity, cursor, deadlineAt: options.deadlineAt });
            },
          });
        } finally {
          pool.release(token);
          owner?.tokens.delete(token);
          if (sender && owner && owner.tokens.size === 0) {
            sender.removeListener("destroyed", owner.release);
            consumersBySender.delete(sender.id);
          }
        }
      }
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
