import { ipcMain } from "electron";
import type {
  ListThreadTodosRequest,
  ListThreadTodosResponse,
  ResolveThreadTodoRequest,
  RunThreadTodoActionRequest,
  ThreadTodoMutationResponse,
  ThreadTodosChangedEvent,
} from "@pwragent/shared";
import {
  isThreadTodoMergeMethod,
  isThreadTodoResolution,
  isThreadTodoStatus,
} from "@pwragent/shared";
import {
  THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  THREAD_TODOS_LIST_CHANNEL,
  THREAD_TODOS_RESOLVE_CHANNEL,
  THREAD_TODOS_RUN_ACTION_CHANNEL,
} from "../../shared/ipc";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type { ThreadTodoProjectCandidate } from "../thread-todos/thread-todo-projects";
import {
  getThreadTodoService,
  installThreadTodoRuntime,
} from "../thread-todos/thread-todo-runtime";
import { subscribersForChannel } from "../window-channels";
import { appServerService } from "./app-server";

function broadcastThreadTodosChanged(event: ThreadTodosChangedEvent): void {
  for (const webContents of subscribersForChannel(
    THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  )) {
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
    broadcast: broadcastThreadTodosChanged,
    listProjects: listLocalProjects,
    readDefaultMergeMethod: () =>
      getDesktopSettingsService().resolveDefaultMergeMethod(),
    ...(options.federation ? { federation: options.federation } : {}),
  });

  ipcMain.removeHandler(THREAD_TODOS_LIST_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_LIST_CHANNEL,
    (_event, request: ListThreadTodosRequest = {}): ListThreadTodosResponse => {
      const todos = getThreadTodoService();
      return {
        todos: todos.list(request),
        mergeMethods: todos.mergeMethodPreferences(),
      };
    },
  );

  ipcMain.removeHandler(THREAD_TODOS_RESOLVE_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_RESOLVE_CHANNEL,
    (_event, request: ResolveThreadTodoRequest): ThreadTodoMutationResponse => {
      // The status is written to the row as given, so it is checked here.
      if (!isThreadTodoStatus(request.status)) {
        throw new Error(`Unknown to-do status: ${String(request.status)}`);
      }
      return {
        todo: getThreadTodoService().resolve({
          id: request.id,
          status: request.status,
          ...(isThreadTodoResolution(request.resolution)
            ? { resolution: request.resolution }
            : {}),
        }),
      };
    },
  );

  ipcMain.removeHandler(THREAD_TODOS_RUN_ACTION_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_RUN_ACTION_CHANNEL,
    async (
      _event,
      request: RunThreadTodoActionRequest,
    ): Promise<ThreadTodoMutationResponse> => ({
      todo: await getThreadTodoService().runAction(request.id, {
        ...(isThreadTodoMergeMethod(request.mergeMethod)
          ? {
              mergeMethod: request.mergeMethod,
              rememberMergeMethod: request.rememberMergeMethod === true,
            }
          : {}),
        ...(typeof request.startOnInstanceId === "string"
          && request.startOnInstanceId.trim()
          ? { startOnInstanceId: request.startOnInstanceId.trim() }
          : {}),
      }),
    }),
  );
}
