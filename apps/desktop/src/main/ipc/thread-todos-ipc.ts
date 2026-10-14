import { ipcMain } from "electron";
import type {
  ListThreadTodoProjectsResponse,
  ListThreadTodosRequest,
  ListThreadTodosResponse,
  ResolveThreadTodoRequest,
  RunThreadTodoActionRequest,
  SetThreadTodoItemCheckedRequest,
  SetThreadTodoProjectRequest,
  ThreadTodoMutationResponse,
  ThreadTodosChangedEvent,
  ListThreadReviewsRequest,
  UpdateThreadReviewRequest,
} from "@pwragent/shared";
import {
  isThreadTodoMergeMethod,
  isThreadTodoResolution,
  isThreadTodoStatus,
  threadReviewTodo,
} from "@pwragent/shared";
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
  getThreadTodoService,
  installThreadTodoRuntime,
  listThreadTodoProjects,
  setThreadTodoProject,
} from "../thread-todos/thread-todo-runtime";
import { subscribersForChannel } from "../window-channels";
import { appServerService } from "./app-server";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";

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

  ipcMain.removeHandler(THREAD_REVIEWS_LIST_CHANNEL);
  ipcMain.handle(THREAD_REVIEWS_LIST_CHANNEL, (_event, request: ListThreadReviewsRequest = {}) => ({
    reviews: getThreadReviewService().list(request),
  }));
  ipcMain.removeHandler(THREAD_REVIEWS_UPDATE_CHANNEL);
  ipcMain.handle(THREAD_REVIEWS_UPDATE_CHANNEL, (_event, request: UpdateThreadReviewRequest) => ({
    review: getThreadReviewService().update({
      ...request,
      note: request.note ?? (request.status === "dismissed" ? "Dismissed by operator." : "Marked addressed by operator."),
    }, "user"),
  }));

  ipcMain.removeHandler(THREAD_TODOS_LIST_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_LIST_CHANNEL,
    (_event, request: ListThreadTodosRequest = {}): ListThreadTodosResponse => {
      const todos = getThreadTodoService();
      return {
        todos: [
          ...todos.list(request),
          ...getThreadReviewService().list({
            ...request, status: request.status === "done" ? "handled" : request.status,
          }).map(threadReviewTodo),
        ].sort((a, b) => b.createdAt - a.createdAt),
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
        todo: request.id.startsWith("review:")
          ? threadReviewTodo(getThreadReviewService().update({
              id: request.id.slice("review:".length),
              status: request.status === "done" ? "handled" : request.status,
              ...(request.status === "open" ? {} : {
                note: request.status === "dismissed" ? "Dismissed by operator." : "Marked handled by operator.",
              }),
            }, "user"))
          : getThreadTodoService().resolve({
              id: request.id,
              status: request.status,
              ...(isThreadTodoResolution(request.resolution)
                ? { resolution: request.resolution }
                : {}),
              ...(request.allowOpenItems === true ? { allowOpenItems: true } : {}),
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
        ...(request.allowOpenItems === true ? { allowOpenItems: true } : {}),
      }),
    }),
  );

  ipcMain.removeHandler(THREAD_TODOS_LIST_PROJECTS_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_LIST_PROJECTS_CHANNEL,
    async (): Promise<ListThreadTodoProjectsResponse> => ({
      projects: await listThreadTodoProjects(),
    }),
  );

  ipcMain.removeHandler(THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_SET_ITEM_CHECKED_CHANNEL,
    (_event, request: SetThreadTodoItemCheckedRequest): ThreadTodoMutationResponse => {
      if (typeof request.itemId !== "string" || typeof request.checked !== "boolean") {
        throw new Error("A to-do step toggle needs a step id and a checked state.");
      }
      return {
        todo: getThreadTodoService().setItemsChecked({
          id: request.id,
          check: request.checked ? [request.itemId] : [],
          uncheck: request.checked ? [] : [request.itemId],
        }),
      };
    },
  );

  ipcMain.removeHandler(THREAD_TODOS_SET_PROJECT_CHANNEL);
  ipcMain.handle(
    THREAD_TODOS_SET_PROJECT_CHANNEL,
    async (
      _event,
      request: SetThreadTodoProjectRequest,
    ): Promise<ThreadTodoMutationResponse> => {
      const projectKey = request.projectKey;
      if (projectKey !== null && typeof projectKey !== "string") {
        throw new Error("A to-do's project must be a project key or null.");
      }
      return {
        todo: await setThreadTodoProject({ id: request.id, projectKey }),
      };
    },
  );
}
