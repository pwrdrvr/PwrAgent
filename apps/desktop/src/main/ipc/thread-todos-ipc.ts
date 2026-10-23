import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { FederatedThreadTodoService, type ThreadTodoOperation } from "../federation/federation-thread-todos";
import { localThreadTodoOperations } from "../thread-todos/thread-todo-operations";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { getMainLogger } from "../log";
import { ipcMain } from "electron";
import type { FederationRemoteTarget, ThreadTodosChangedEvent } from "@pwragent/shared";
import {
  THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  THREAD_TODOS_LIST_CHANNEL,
  THREAD_TODOS_LIST_PROJECTS_CHANNEL,
  THREAD_TODOS_RESOLVE_CHANNEL,
  THREAD_TODOS_RUN_ACTION_CHANNEL,
  THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL,
  THREAD_TODOS_SET_PROJECT_CHANNEL,
  THREAD_REVIEWS_LIST_CHANNEL,
  THREAD_REVIEWS_UPDATE_CHANNEL,
} from "../../shared/ipc";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type { ThreadTodoProjectCandidate } from "../thread-todos/thread-todo-projects";
import {
  installThreadTodoRuntime,
} from "../thread-todos/thread-todo-runtime";
import { federationTargetForChannelSubscriber, subscribersForChannel } from "../window-channels";
import { appServerService } from "./app-server";

let unsubscribeRemoteTodos: (() => void) | undefined;
let unsubscribePeerStatus: (() => void) | undefined;
const todoLog = getMainLogger("pwragent:thread-todos");

function broadcastThreadTodosChanged(event: ThreadTodosChangedEvent): void {
  for (const webContents of subscribersForChannel(
    THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  )) {
    const windowTarget = federationTargetForChannelSubscriber(webContents);
    if (windowTarget && windowTarget.instanceId !== event.federationTarget?.instanceId
      && (event.backend !== undefined || event.federationTarget !== undefined)) continue;
    if (!webContents.isDestroyed()) {
      webContents.send(THREAD_TODOS_CHANGED_EVENT_CHANNEL, event);
    }
  }
}

/** The local Directories lens rows, the projects a card can name. */
async function listLocalProjects(): Promise<ThreadTodoProjectCandidate[]> {
  const page = await appServerService.getNavigationQueryPage({
    protocol: 2,
    inventory: "owner",
    consumer: "agent-tool",
    query: { kind: "directory-index" },
    pageSize: 500,
  });
  return (page.directories ?? []).map((directory) => ({
    key: directory.key,
    label: directory.label,
    kind: directory.kind,
    ...(directory.path ? { path: directory.path } : {}),
  }));
}

export function registerThreadTodoIpcHandlers(options: {
  /** Starts handoff threads on federation peers. */
  federation?: PwrAgentFederationHandler;
} = {}): void {
  installThreadTodoRuntime({
    registry: getDesktopBackendRegistry(),
    broadcast: (event) => {
      broadcastThreadTodosChanged(event);
      getDesktopFederationRuntime().publishThreadTodosChanged(event);
    },
    listProjects: listLocalProjects,
    readDefaultMergeMethod: () =>
      getDesktopSettingsService().resolveDefaultMergeMethod(),
    ...(options.federation ? { federation: options.federation } : {}),
  });

  const runtime = getDesktopFederationRuntime();
  const service = new FederatedThreadTodoService({
    local: localThreadTodoOperations,
    remote: (target, operation, request) => runtime.requestThreadTodoOperation(target, operation, request),
    mountedThreads: async () => (await getDesktopOverlayStore().listRemoteThreadPins())
      .filter((pin) => pin.ref.target.scope === "remote")
      .map((pin) => ({ ...pin.ref, target: pin.ref.target as FederationRemoteTarget })),
    onUnavailable: (error) => todoLog.warn("mounted thread to-dos unavailable", { error: String(error) }),
  });
  unsubscribeRemoteTodos?.();
  unsubscribeRemoteTodos = runtime.onRemoteBackendEvent((event) => {
    if (event.notification.method === "thread/todos/changed" || event.notification.method === "thread/todoDetails/changed") {
      broadcastThreadTodosChanged({ ...(event.notification.params as ThreadTodosChangedEvent), federationTarget: event.federationTarget?.scope === "remote"
        ? event.federationTarget : undefined });
    } else if (event.notification.method === "federation/eventStream/changed") {
      broadcastThreadTodosChanged({ at: Date.now(),
        federationTarget: event.federationTarget?.scope === "remote" ? event.federationTarget : undefined,
      });
    }
  });
  unsubscribePeerStatus?.();
  unsubscribePeerStatus = runtime.onPeerStatusChanged(() => {
    broadcastThreadTodosChanged({ at: Date.now() });
  });
  const channels = {
    listReviews: THREAD_REVIEWS_LIST_CHANNEL, updateReview: THREAD_REVIEWS_UPDATE_CHANNEL,
    listTodos: THREAD_TODOS_LIST_CHANNEL, resolveTodo: THREAD_TODOS_RESOLVE_CHANNEL,
    runAction: THREAD_TODOS_RUN_ACTION_CHANNEL, listProjects: THREAD_TODOS_LIST_PROJECTS_CHANNEL,
    setItemChecked: THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL, setProject: THREAD_TODOS_SET_PROJECT_CHANNEL,
  } as const;
  for (const operation of Object.keys(channels) as ThreadTodoOperation[]) {
    ipcMain.removeHandler(channels[operation]);
    ipcMain.handle(channels[operation], (event, request = {}) => service.request(
      operation, request, federationTargetForChannelSubscriber(event.sender),
    ));
  }
}
