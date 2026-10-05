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
  THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  THREAD_TODOS_LIST_CHANNEL,
  THREAD_TODOS_RESOLVE_CHANNEL,
  THREAD_TODOS_RUN_ACTION_CHANNEL,
} from "../../shared/ipc";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import {
  getThreadTodoService,
  installThreadTodoRuntime,
} from "../thread-todos/thread-todo-runtime";
import { subscribersForChannel } from "../window-channels";

function broadcastThreadTodosChanged(event: ThreadTodosChangedEvent): void {
  for (const webContents of subscribersForChannel(
    THREAD_TODOS_CHANGED_EVENT_CHANNEL,
  )) {
    if (!webContents.isDestroyed()) {
      webContents.send(THREAD_TODOS_CHANGED_EVENT_CHANNEL, event);
    }
  }
}

export function registerThreadTodoIpcHandlers(): void {
  installThreadTodoRuntime({
    registry: getDesktopBackendRegistry(),
    broadcast: broadcastThreadTodosChanged,
  });

  ipcMain.removeHandler(THREAD_TODOS_LIST_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_LIST_CHANNEL,
    (_event, request: ListThreadTodosRequest = {}): ListThreadTodosResponse => ({
      todos: getThreadTodoService().list(request),
    }),
  );

  ipcMain.removeHandler(THREAD_TODOS_RESOLVE_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_RESOLVE_CHANNEL,
    (_event, request: ResolveThreadTodoRequest): ThreadTodoMutationResponse => ({
      todo: getThreadTodoService().resolve(request),
    }),
  );

  ipcMain.removeHandler(THREAD_TODOS_RUN_ACTION_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_RUN_ACTION_CHANNEL,
    async (
      _event,
      request: RunThreadTodoActionRequest,
    ): Promise<ThreadTodoMutationResponse> => ({
      todo: await getThreadTodoService().runAction(request.id),
    }),
  );
}
