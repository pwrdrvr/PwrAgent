import type {
  FederationCapability, FederationRemoteTarget, ThreadTodo, ListThreadTodosRequest, ThreadTodoMergeMethodPreferences,
  TodoBusyThread, TodoUnavailableInstance,
} from "@pwragent/shared";
import { normalizeThreadReview, resolveThreadTodoMergeMethod } from "@pwragent/shared";
import { expectedNavigationReadFailure } from "../../shared/navigation-ipc-result";
import type { FederationRouter } from "./federation-router";
import type { localThreadTodoOperations } from "../thread-todos/thread-todo-operations";

type Operations = typeof localThreadTodoOperations;
export type ThreadTodoOperation = keyof Operations;
export type ThreadTodoOperationRequest<K extends ThreadTodoOperation> = Parameters<Operations[K]>[0];
export type ThreadTodoOperationResponse<K extends ThreadTodoOperation> = Awaited<ReturnType<Operations[K]>>;
export type ThreadTodoRemoteRequest = <K extends ThreadTodoOperation>(
  target: FederationRemoteTarget, operation: K, request: ThreadTodoOperationRequest<K>,
) => Promise<ThreadTodoOperationResponse<K>>;

export const FEDERATION_THREAD_TODO_METHODS = {
  listTodos: "threadTodos.list", listReviews: "threadReviews.list", updateReview: "threadReviews.update",
  resolveTodo: "threadTodos.resolve", runAction: "threadTodos.runAction", listProjects: "threadTodos.listProjects",
  setItemChecked: "threadTodos.setItemChecked", setProject: "threadTodos.setProject",
  // Needs `thread_todo_feed` on the owner; viewers fall back to `threadTodos.list`.
  snapshotFeed: "threadTodos.snapshot",
} as const;

export const FEDERATION_THREAD_TODO_CAPABILITIES: Record<string, FederationCapability> = {
  [FEDERATION_THREAD_TODO_METHODS.listTodos]: "thread_detail",
  [FEDERATION_THREAD_TODO_METHODS.listReviews]: "thread_detail",
  [FEDERATION_THREAD_TODO_METHODS.listProjects]: "thread_detail",
  [FEDERATION_THREAD_TODO_METHODS.snapshotFeed]: "thread_detail",
  [FEDERATION_THREAD_TODO_METHODS.updateReview]: "turn_control",
  [FEDERATION_THREAD_TODO_METHODS.resolveTodo]: "turn_control",
  [FEDERATION_THREAD_TODO_METHODS.setItemChecked]: "turn_control",
  [FEDERATION_THREAD_TODO_METHODS.setProject]: "turn_control",
  [FEDERATION_THREAD_TODO_METHODS.runAction]: "turn_control",
};

export function registerFederationThreadTodoHandlers(router: FederationRouter, operations: Operations): void {
  for (const operation of Object.keys(FEDERATION_THREAD_TODO_METHODS) as ThreadTodoOperation[]) {
    router.registerHandler(FEDERATION_THREAD_TODO_METHODS[operation], (envelope) => {
      const request = (envelope.params ?? {}) as { federationTarget?: unknown };
      if (request.federationTarget !== undefined) throw new Error("To-do requests must terminate at their owner.");
      // The method table preserves the request/result pair; dispatch only calls
      // the owner-local operation, never the viewer's routing service.
      return (operations[operation] as (request: unknown) => unknown)(request);
    });
  }
}

/** Opaque viewer ids keep equal owner-local ids distinct in cards and pending actions. */
export function remoteThreadTodoId(target: FederationRemoteTarget, id: string): string {
  return `remote-todo:${encodeURIComponent(target.instanceId)}:${encodeURIComponent(id)}`;
}

function projectTodo(todo: ThreadTodo, target: FederationRemoteTarget): ThreadTodo {
  return { ...todo, id: remoteThreadTodoId(target, todo.id), federationTarget: target };
}

/** An owner's card as a viewer shows it: its owner's id, target, and merge method. */
export function projectRemoteThreadTodo(
  todo: ThreadTodo,
  target: FederationRemoteTarget,
  mergeMethods: ThreadTodoMergeMethodPreferences | undefined,
): ThreadTodo {
  return projectTodo({ ...todo, mergeMethod: resolveThreadTodoMergeMethod(todo, mergeMethods) }, target);
}

export class FederatedThreadTodoService {
  constructor(private readonly options: {
    local: Operations;
    remote: ThreadTodoRemoteRequest;
    mountedThreads: () => Promise<Array<{ target: FederationRemoteTarget; backend: ThreadTodo["backend"]; threadId: string }>>;
    onUnavailable?: (error: unknown) => void;
  }) {}

  async request<K extends ThreadTodoOperation>(
    operation: K, input: ThreadTodoOperationRequest<K>, windowTarget?: FederationRemoteTarget,
  ): Promise<ThreadTodoOperationResponse<K>> {
    const request = { ...input } as Record<string, unknown>;
    let target = request.federationTarget as FederationRemoteTarget | undefined;
    delete request.federationTarget;
    if (typeof request.id === "string" && request.id.startsWith("remote-todo:")) {
      const match = /^remote-todo:([^:]+):(.+)$/.exec(request.id);
      if (!match) throw new Error("Invalid remote to-do id.");
      const owner = decodeURIComponent(match[1]!);
      if (target && target.instanceId !== owner) throw new Error("To-do owner does not match its target.");
      target = { scope: "remote", instanceId: owner };
      request.id = decodeURIComponent(match[2]!);
    }
    target ??= windowTarget;
    if (target) {
      // An owner that predates `declined` accepts only `dismissed` for a
      // finding, and every owner still takes that name, so it crosses as that.
      if (operation === "updateReview" && request.itemId !== undefined && request.status === "declined") {
        request.status = "dismissed";
      }
      const response = await this.options.remote(target, operation, request as ThreadTodoOperationRequest<K>);
      if (operation === "listTodos") {
        const listed = response as ThreadTodoOperationResponse<"listTodos">;
        return { ...listed, todos: listed.todos.map((todo) => projectRemoteThreadTodo(todo, target, listed.mergeMethods)),
        } as ThreadTodoOperationResponse<K>;
      }
      if ("todo" in response) return { ...response, todo: projectTodo(response.todo, target) } as ThreadTodoOperationResponse<K>;
      // An older owner's findings can still say `dismissed`.
      if (operation === "listReviews") return { reviews: (response as ThreadTodoOperationResponse<"listReviews">).reviews
        .map((review) => ({ ...normalizeThreadReview(review), federationTarget: target })) } as ThreadTodoOperationResponse<K>;
      if (operation === "updateReview") return { review: {
        ...normalizeThreadReview((response as ThreadTodoOperationResponse<"updateReview">).review),
        federationTarget: target } } as ThreadTodoOperationResponse<K>;
      return response;
    }
    const response = await (this.options.local[operation] as (request: unknown) => Promise<ThreadTodoOperationResponse<K>>)(request);
    if (operation !== "listTodos") return response;
    const listed = response as ThreadTodoOperationResponse<"listTodos">;
    const filter = request as ListThreadTodosRequest;
    const mounts = await this.options.mountedThreads();
    const unique = new Map(mounts.filter((mount) => (!filter.backend || mount.backend === filter.backend)
      && (!filter.threadId || mount.threadId === filter.threadId))
      .map((mount) => [JSON.stringify([mount.target.instanceId, mount.backend, mount.threadId]), mount]));
    const errors: string[] = [];
    const busyThreads: TodoBusyThread[] = [];
    const unavailableInstances = new Map<string, TodoUnavailableInstance>();
    const remote = await Promise.all([...unique.values()].map(async (mount) => {
      try {
        const response = await this.request("listTodos", { ...filter, backend: mount.backend, threadId: mount.threadId,
          federationTarget: mount.target });
        for (const instance of response.unavailableInstances ?? []) unavailableInstances.set(instance.instanceId, instance);
        errors.push(...response.errors ?? []);
        return response.todos;
      } catch (error) {
        // A busy owner is expected contention. Name the thread instead, so
        // the panel keeps its last cards while local cards stay fresh.
        if (expectedNavigationReadFailure(error)?.code === "navigation_busy") {
          busyThreads.push({ federationTarget: mount.target, backend: mount.backend, threadId: mount.threadId });
          return [];
        }
        this.options.onUnavailable?.(error);
        errors.push(`${mount.target.instanceId}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    return { ...listed, ...(errors.length ? { errors } : {}), ...(busyThreads.length ? { busyThreads } : {}),
      ...(unavailableInstances.size ? { unavailableInstances: [...unavailableInstances.values()] } : {}),
      todos: [...listed.todos, ...remote.flat()].sort((a, b) => b.createdAt - a.createdAt) } as ThreadTodoOperationResponse<K>;
  }
}
