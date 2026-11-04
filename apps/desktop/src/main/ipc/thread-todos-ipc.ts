import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { FederatedThreadTodoService, type ThreadTodoOperation } from "../federation/federation-thread-todos";
import {
  listLocalTodoOwnerThreads, localThreadTodoOperations, readManagedTodoThreadKeys,
} from "../thread-todos/thread-todo-operations";
import { ThreadTodoViewHub } from "../thread-todos/thread-todo-views";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { readLocalNavigationDirectoryIndex } from "../app-server/navigation-directory-index";
import { getMainLogger } from "../log";
import { ipcMain } from "electron";
import type {
  AppServerThreadMessageOrigin, FederationRemoteTarget, ThreadTodoFeedDelta, ThreadTodoFeedSnapshot, ThreadTodosChangedEvent,
} from "@pwragent/shared";
import {
  THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  THREAD_TODOS_DELTA_EVENT_CHANNEL,
  THREAD_TODOS_SNAPSHOT_CHANNEL,
  THREAD_TODOS_LIST_CHANNEL,
  THREAD_TODOS_LIST_PROJECTS_CHANNEL,
  THREAD_TODOS_RESOLVE_CHANNEL,
  THREAD_TODOS_RUN_ACTION_CHANNEL,
  THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL,
  THREAD_TODOS_SET_PROJECT_CHANNEL,
  THREAD_TODOS_LIST_DISPATCH_ENVIRONMENTS_CHANNEL,
  THREAD_REVIEWS_LIST_CHANNEL,
  THREAD_REVIEWS_UPDATE_CHANNEL,
} from "../../shared/ipc";
import { expectedNavigationReadFailure } from "../../shared/navigation-ipc-result";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type { ThreadTodoProjectCandidate } from "../thread-todos/thread-todo-projects";
import {
  installThreadTodoRuntime,
} from "../thread-todos/thread-todo-runtime";
import { federationTargetForChannelSubscriber, subscribersForChannel } from "../window-channels";

let unsubscribeRemoteTodos: (() => void) | undefined;
let unsubscribePeerStatus: (() => void) | undefined;
const todoLog = getMainLogger("pwragent:thread-todos");

/**
 * A federation viewer hears only its owner's changes. `everyWindow` is for
 * reconnection, after which every window reloads its owner's state.
 */
function broadcastThreadTodosChanged(event: ThreadTodosChangedEvent, everyWindow = false): void {
  for (const webContents of subscribersForChannel(
    THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  )) {
    const windowTarget = federationTargetForChannelSubscriber(webContents);
    if (!everyWindow && windowTarget
      && windowTarget.instanceId !== event.federationTarget?.instanceId) continue;
    if (!webContents.isDestroyed()) {
      webContents.send(THREAD_TODOS_CHANGED_EVENT_CHANNEL, event);
    }
  }
}

/** A window hears only its own view's deltas: its owner's, or the main window's. */
function sendThreadTodoDelta(target: FederationRemoteTarget | undefined, delta: ThreadTodoFeedDelta): void {
  for (const webContents of subscribersForChannel(THREAD_TODOS_DELTA_EVENT_CHANNEL)) {
    if (federationTargetForChannelSubscriber(webContents)?.instanceId !== target?.instanceId) continue;
    if (!webContents.isDestroyed()) webContents.send(THREAD_TODOS_DELTA_EVENT_CHANNEL, delta);
  }
}

function hasThreadTodoViewers(target: FederationRemoteTarget | undefined): boolean {
  return subscribersForChannel(THREAD_TODOS_DELTA_EVENT_CHANNEL).some((webContents) =>
    federationTargetForChannelSubscriber(webContents)?.instanceId === target?.instanceId);
}

/**
 * The local Directories lens rows, the projects a card can name. Every
 * page of them: a navigation page holds at most 100 rows.
 */
async function listLocalProjects(): Promise<ThreadTodoProjectCandidate[]> {
  return (await readLocalNavigationDirectoryIndex()).map((directory) => ({
    key: directory.key,
    label: directory.label,
    kind: directory.kind,
    ...(directory.path ? { path: directory.path } : {}),
    ...(directory.repositoryKey ? { repositoryKey: directory.repositoryKey } : {}),
    ...(directory.repositoryKeys?.length ? { repositoryKeys: directory.repositoryKeys } : {}),
    ...(directory.localAvailability ? { localAvailability: directory.localAvailability } : {}),
  }));
}

export function registerThreadTodoIpcHandlers(options: {
  /** Starts handoff threads on federation peers. */
  federation?: PwrAgentFederationHandler;
  /** The same tools sending one message origin, for a card's peer start. */
  federationWithOrigin?: (messageOrigin: AppServerThreadMessageOrigin) => PwrAgentFederationHandler;
} = {}): void {
  const runtime = getDesktopFederationRuntime();
  const mountedThreads = async () => (await getDesktopOverlayStore().listRemoteThreadPins())
    .filter((pin) => pin.ref.target.scope === "remote")
    .map((pin) => ({ ...pin.ref, target: pin.ref.target as FederationRemoteTarget }));
  const onUnavailable = (error: unknown) => todoLog.warn("mounted thread to-dos unavailable", { error: String(error) });
  const hub = new ThreadTodoViewHub({
    local: { snapshot: () => localThreadTodoOperations.snapshotFeed() },
    remote: {
      supportsFeed: (target) => runtime.remotePeerSupportsTodoFeed(target),
      watchFeeds: (targets) => runtime.setTodoFeedWatches(targets.map((target) => target.instanceId)),
      snapshot: (target) => runtime.requestThreadTodoOperation(target, "snapshotFeed", {}),
      list: (target, request) => runtime.requestThreadTodoOperation(target, "listTodos", request),
    },
    mountedThreads,
    hasViewers: hasThreadTodoViewers,
    send: sendThreadTodoDelta,
    onUnavailable,
  });
  installThreadTodoRuntime({
    registry: getDesktopBackendRegistry(),
    broadcast: (event) => {
      broadcastThreadTodosChanged(event);
      runtime.publishThreadTodosChanged(event);
      hub.localChanged();
    },
    feed: {
      loadOwners: listLocalTodoOwnerThreads,
      managedThreadKeys: readManagedTodoThreadKeys,
      onDelta: (delta) => {
        hub.localDelta(delta);
        runtime.publishThreadTodoDelta(delta);
      },
    },
    listProjects: listLocalProjects,
    readDefaultMergeMethod: () =>
      getDesktopSettingsService().resolveDefaultMergeMethod(),
    ...(options.federation ? { federation: options.federation } : {}),
    ...(options.federationWithOrigin ? { federationWithOrigin: options.federationWithOrigin } : {}),
    peerPlans: {
      // The instance picker can name this machine, which raises its own.
      supports: (instanceId) => isLocalTodoInstance(runtime, instanceId)
        || runtime.remotePeerSupportsTodoPlan({ scope: "remote", instanceId }),
      raise: (instanceId, request) =>
        runtime.requestThreadTodoOperation({ scope: "remote", instanceId }, "raisePlan", request),
    },
  });

  const service = new FederatedThreadTodoService({
    local: localThreadTodoOperations,
    remote: (target, operation, request) => runtime.requestThreadTodoOperation(target, operation, request),
    mountedThreads,
    onUnavailable,
  });
  unsubscribeRemoteTodos?.();
  unsubscribeRemoteTodos = runtime.onRemoteBackendEvent((event) => {
    hub.handleRemoteEvent(event);
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
    broadcastThreadTodosChanged({ at: Date.now() }, true);
    hub.peerStatusChanged();
  });
  ipcMain.removeHandler(THREAD_TODOS_SNAPSHOT_CHANNEL);
  ipcMain.handle(THREAD_TODOS_SNAPSHOT_CHANNEL, (event): Promise<ThreadTodoFeedSnapshot> =>
    hub.snapshot(federationTargetForChannelSubscriber(event.sender)));
  const channels = {
    listReviews: THREAD_REVIEWS_LIST_CHANNEL, updateReview: THREAD_REVIEWS_UPDATE_CHANNEL,
    listTodos: THREAD_TODOS_LIST_CHANNEL, resolveTodo: THREAD_TODOS_RESOLVE_CHANNEL,
    runAction: THREAD_TODOS_RUN_ACTION_CHANNEL, listProjects: THREAD_TODOS_LIST_PROJECTS_CHANNEL,
    setItemChecked: THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL, setProject: THREAD_TODOS_SET_PROJECT_CHANNEL,
    listDispatchEnvironments: THREAD_TODOS_LIST_DISPATCH_ENVIRONMENTS_CHANNEL,
  } as const;
  // The feed snapshot has its own per-window channel above.
  for (const operation of Object.keys(channels) as Array<keyof typeof channels & ThreadTodoOperation>) {
    ipcMain.removeHandler(channels[operation]);
    ipcMain.handle(channels[operation], async (event, request = {}) => {
      try {
        return await service.request(operation, request, federationTargetForChannelSubscriber(event.sender));
      } catch (error) {
        // A busy or offline owner is expected, not a handler fault. The
        // listing crosses as data, and the preload restores a coded rejection
        // the panel can recognize and retry.
        const expected = operation === "listTodos" ? expectedNavigationReadFailure(error) : undefined;
        if (expected) return expected;
        throw error;
      }
    });
  }
}

function isLocalTodoInstance(
  runtime: ReturnType<typeof getDesktopFederationRuntime>,
  instanceId: string,
): boolean {
  try {
    return instanceId === runtime.localFederationInstanceId();
  } catch {
    // State is not open yet, so the id cannot be read or minted.
    return false;
  }
}
