import type {
  AppServerBackendKind,
  ThreadTodoModelSettings,
  ListThreadTodoProjectsResponse,
  ListThreadTodoProjectsRequest,
  ListThreadTodosRequest,
  ListThreadTodosResponse,
  ResolveThreadTodoRequest,
  RunThreadTodoActionRequest,
  SetThreadTodoItemCheckedRequest,
  SetThreadTodoProjectRequest,
  ThreadTodoMutationResponse,
  ThreadTodoFeedSnapshot,
  ListThreadReviewsRequest,
  UpdateThreadReviewRequest,
  ListThreadTodoDispatchEnvironmentsRequest,
  ListThreadTodoDispatchEnvironmentsResponse,
  CodexSpeed,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  isThreadTodoMergeMethod,
  isThreadTodoResolution,
  isThreadTodoStatus,
  threadReviewTodo,
} from "@pwragent/shared";
import {
  getThreadTodoFeed,
  getThreadTodoService,
  listThreadTodoProjectCandidates,
  listThreadTodoProjects,
  setThreadTodoProject,
} from "../thread-todos/thread-todo-runtime";
import { listThreadTodoDispatchEnvironments } from "../thread-todos/thread-todo-dispatch";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { listThreadTodosForAvailableOwners } from "../thread-todos/thread-todo-owners";

/**
 * This owner's threads, as the cached provider listing has them. The same
 * listing backs the sidebar, so this is usually a cache hit: no navigation
 * index, overlay projection, PR, Git or messaging work for a card filter.
 */
export async function listLocalTodoOwnerThreads() {
  return await getDesktopBackendRegistry().listThreads({
    callerReason: "thread-todo-owners",
    // The sidebar index lists with directories, so this shares its cache entry.
    enrichDirectories: true,
  });
}

/** Private managed sub-agent threads; their cards never reach the queue. */
export function readManagedTodoThreadKeys(): ReadonlySet<string> {
  return getDesktopOverlayStore().readManagedSubAgentThreadKeys();
}

async function listLocalTodoOwners() {
  const threads = await listLocalTodoOwnerThreads();
  const managed = readManagedTodoThreadKeys();
  return managed.size === 0 ? threads
    : threads.filter((thread) => !managed.has(buildThreadIdentityKey(thread.source, thread.id)));
}

/**
 * The note an operator's click records, which the agent reads in
 * `list_reviews`. Reopening records none, so a repeated Reopen stays a no-op.
 */
function operatorReviewNote(
  request: Pick<UpdateThreadReviewRequest, "itemId" | "status">,
): string | undefined {
  switch (request.status) {
    case "open":
      return undefined;
    case "addressed":
      return "Marked addressed by operator.";
    case "handled":
      return "Marked handled by operator.";
    case "declined":
      return "Declined by operator.";
    case "deferred":
      // A deferral needs a to-do card, which an operator update never carries.
      return undefined;
    case "dismissed":
      // A finding's older name for declined, from a viewer that predates it.
      return request.itemId ? "Declined by operator." : "Dismissed by operator.";
  }
}

/** A review card's resolve or Undo, as a whole-review update. */
function reviewResolveRequest(
  id: string,
  status: UpdateThreadReviewRequest["status"],
): UpdateThreadReviewRequest {
  const note = operatorReviewNote({ status });
  return { id, status, ...(note ? { note } : {}) };
}

export const localThreadTodoOperations = {
  listReviews: (request: ListThreadReviewsRequest = {}) => ({ reviews: getThreadReviewService().list(request) }),
  updateReview: (request: UpdateThreadReviewRequest) => ({ review: getThreadReviewService().update({
    ...request, note: request.note ?? operatorReviewNote(request),
  }, "user") }),
  listTodos: async (request: ListThreadTodosRequest = {}): Promise<ListThreadTodosResponse> => {
    const todos = getThreadTodoService();
    return {
      todos: await todos.withDispatchDefaults(await listThreadTodosForAvailableOwners([
        ...todos.list(request),
        ...getThreadReviewService().list({
          ...request, status: request.status === "done" ? "handled" : request.status,
        }).map(threadReviewTodo),
      ].sort((a, b) => b.createdAt - a.createdAt), listLocalTodoOwners)),
      mergeMethods: todos.mergeMethodPreferences(),
    };
  },
  /** Open cards at the live feed's revision; `thread/todos/delta` follows it. */
  snapshotFeed: async (_request: Record<string, never> = {}): Promise<ThreadTodoFeedSnapshot> =>
    await getThreadTodoFeed().snapshot(),
  resolveTodo: (request: ResolveThreadTodoRequest): ThreadTodoMutationResponse => {
    // The status is written to the row as given, so it is checked here.
    if (!isThreadTodoStatus(request.status)) {
      throw new Error(`Unknown to-do status: ${String(request.status)}`);
    }
    return {
      todo: request.id.startsWith("review:")
        ? threadReviewTodo(getThreadReviewService().update(reviewResolveRequest(
            request.id.slice("review:".length),
            request.status === "done" ? "handled" : request.status,
          ), "user"))
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
  runAction: async (
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
      ...(request.modelSettings ? { modelSettings: parseDispatchSettings(request.modelSettings) } : {}),
      ...(request.workMode === "local" || request.workMode === "worktree" ? { workMode: request.workMode } : {}),
      ...(typeof request.environment === "string" && request.environment.trim()
        ? { environment: request.environment.trim() }
        : {}),
      ...(isCodexSpeed(request.speed) ? { speed: request.speed } : {}),
    }),
  }),
  listDispatchEnvironments: async (
    request: ListThreadTodoDispatchEnvironmentsRequest,
  ): Promise<ListThreadTodoDispatchEnvironmentsResponse> => await listThreadTodoDispatchEnvironments(request, {
    getTodo: (id) => getThreadTodoService().get(id),
    listProjects: listThreadTodoProjectCandidates,
    readThreadEnvironmentId: async (thread) =>
      (await getDesktopBackendRegistry().readThreadHandoffSettings(thread)).codexEnvironmentRuntime?.environmentId,
    readProjectPresetId: async (directoryKey) =>
      (await getDesktopOverlayStore().getDirectoryLaunchpad({ directoryKey }))?.codexEnvironmentId,
  }),
  listProjects: async (_request: ListThreadTodoProjectsRequest = {}): Promise<ListThreadTodoProjectsResponse> => ({
    projects: await listThreadTodoProjects(),
  }),
  setItemChecked: (request: SetThreadTodoItemCheckedRequest): ThreadTodoMutationResponse => {
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
  setProject: async (
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
};

function isCodexSpeed(value: unknown): value is CodexSpeed {
  return value === "standard" || value === "fast" || value === "ultrafast";
}

function parseDispatchSettings(value: unknown): ThreadTodoModelSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid dispatch model settings.");
  const { backend, model, reasoningEffort } = value as Record<string, unknown>;
  if (typeof backend !== "string" || !(backend === "codex" || backend === "claude" || /^acp:.+/.test(backend))
    || (model !== undefined && (typeof model !== "string" || !model.trim()))
    || (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || !reasoningEffort.trim()))) {
    throw new Error("Invalid dispatch model settings.");
  }
  return { backend: backend as AppServerBackendKind,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
  };
}
