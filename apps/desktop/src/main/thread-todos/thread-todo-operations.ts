import type {
  ListThreadTodoProjectsResponse,
  ListThreadTodoProjectsRequest,
  ListThreadTodosRequest,
  ListThreadTodosResponse,
  ResolveThreadTodoRequest,
  RunThreadTodoActionRequest,
  SetThreadTodoItemCheckedRequest,
  SetThreadTodoProjectRequest,
  ThreadTodoMutationResponse,
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
  getThreadTodoService,
  listThreadTodoProjects,
  setThreadTodoProject,
} from "../thread-todos/thread-todo-runtime";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";
import { loadLocalNavigationQueryIndex } from "../app-server/navigation-query-source";
import { listThreadTodosForAvailableOwners } from "../thread-todos/thread-todo-owners";

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
      todos: await listThreadTodosForAvailableOwners([
        ...todos.list(request),
        ...getThreadReviewService().list({
          ...request, status: request.status === "done" ? "handled" : request.status,
        }).map(threadReviewTodo),
      ].sort((a, b) => b.createdAt - a.createdAt), async () => (await loadLocalNavigationQueryIndex({
        callerReason: "thread-todo-owners",
      })).threads),
      mergeMethods: todos.mergeMethodPreferences(),
    };
  },
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
    }),
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
