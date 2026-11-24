import { getDesktopFederationRuntime } from "../../federation/federation-runtime";
import { FederatedThreadTodoService, type ThreadTodoOperation } from "../../federation/federation-thread-todos";
import { localThreadTodoOperations } from "../../thread-todos/thread-todo-operations";
import { ThreadTodoViewHub } from "../../thread-todos/thread-todo-views";
import { getDesktopOverlayStore } from "../../storage/desktop-overlay-store";
import { getMainLogger } from "../../log";
import { ipcMain } from "electron";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type {
  ThreadTodoFeedDelta,
  ThreadTodoFeedSnapshot,
  ThreadTodosChangedEvent,
} from "@pwragent/shared/contracts/thread-todos";
import {
  THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  THREAD_TODOS_DELTA_EVENT_CHANNEL,
  THREAD_TODOS_SNAPSHOT_CHANNEL,
  THREAD_TODOS_LIST_CHANNEL,
  THREAD_TODOS_LIST_PROJECTS_CHANNEL,
  THREAD_TODOS_RESOLVE_CHANNEL,
  THREAD_TODOS_RUN_ACTION_CHANNEL,
  THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL,
  THREAD_TODOS_SET_ACCESS_CHANNEL,
  THREAD_TODOS_SET_PROJECT_CHANNEL,
  THREAD_TODOS_REVIEW_CI_DEPLOYMENT_CHANNEL,
  THREAD_TODOS_LIST_DISPATCH_ENVIRONMENTS_CHANNEL,
  THREAD_REVIEWS_LIST_CHANNEL,
  THREAD_REVIEWS_UPDATE_CHANNEL,
  THREAD_REVIEWS_READ_AUTO_FIX_CHANNEL,
  THREAD_REVIEWS_DISARM_AUTO_FIX_CHANNEL,
} from "../../../shared/ipc";
import { expectedNavigationReadFailure } from "../../../shared/navigation-ipc-result";
import type { OwnerQueueEvents } from "../../owner-queue-services";
import { federationTargetForChannelSubscriber, subscribersForChannel } from "../window-channels";

let unsubscribeLocalTodos: (() => void) | undefined;
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

export function registerThreadTodoIpcHandlers(events: OwnerQueueEvents): void {
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
  unsubscribeLocalTodos?.();
  const onLocalChange = (event: ThreadTodosChangedEvent): void => {
    broadcastThreadTodosChanged(event);
    hub.localChanged();
  };
  const onLocalDelta = (delta: ThreadTodoFeedDelta): void => hub.localDelta(delta);
  events.on("threadTodosChanged", onLocalChange);
  events.on("threadTodoDelta", onLocalDelta);
  unsubscribeLocalTodos = () => {
    events.off("threadTodosChanged", onLocalChange);
    events.off("threadTodoDelta", onLocalDelta);
  };

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
    readReviewAutoFix: THREAD_REVIEWS_READ_AUTO_FIX_CHANNEL,
    disarmReviewAutoFix: THREAD_REVIEWS_DISARM_AUTO_FIX_CHANNEL,
    listTodos: THREAD_TODOS_LIST_CHANNEL, resolveTodo: THREAD_TODOS_RESOLVE_CHANNEL,
    runAction: THREAD_TODOS_RUN_ACTION_CHANNEL, listProjects: THREAD_TODOS_LIST_PROJECTS_CHANNEL,
    setItemChecked: THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL, setProject: THREAD_TODOS_SET_PROJECT_CHANNEL,
    setAccess: THREAD_TODOS_SET_ACCESS_CHANNEL,
    listDispatchEnvironments: THREAD_TODOS_LIST_DISPATCH_ENVIRONMENTS_CHANNEL,
    reviewCiDeployment: THREAD_TODOS_REVIEW_CI_DEPLOYMENT_CHANNEL,
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
