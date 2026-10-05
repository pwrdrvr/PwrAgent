import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  ListThreadTodosRequest,
  ThreadTodo,
  ThreadTodoAction,
  ThreadTodoStatus,
  ThreadTodosChangedEvent,
} from "@pwragent/shared";
import {
  THREAD_TODO_MAX_OPEN_PER_THREAD,
  threadTodoKindForAction,
} from "@pwragent/shared";
import type { ThreadTodoStore } from "./thread-todo-store.js";

export type ThreadTodoStartedThread = {
  backend: AppServerBackendKind;
  threadId: string;
};

/**
 * The two actions that run in the main process. `start_review` is not here:
 * it opens the composer's own `/review` flow in the renderer, so the operator
 * still picks the target and reviewer, and the renderer resolves the card
 * once the review starts.
 */
export type ThreadTodoActionRunners = {
  mergePullRequest: (params: {
    cwd?: string;
    pullRequest: string;
  }) => Promise<{ summary: string }>;
  startThread: (params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    cwd?: string;
    action: Extract<ThreadTodoAction, { type: "start_thread" }>;
  }) => Promise<ThreadTodoStartedThread>;
};

export type AddThreadTodoInput = {
  title: string;
  detail?: string;
  key?: string;
  action?: ThreadTodoAction;
};

export class ThreadTodoError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_arguments" | "limit_reached" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export type ThreadTodoServiceOptions = {
  store: ThreadTodoStore;
  runners?: ThreadTodoActionRunners;
  onChanged?: (event: ThreadTodosChangedEvent) => void;
  now?: () => number;
  newId?: () => string;
};

export class ThreadTodoService {
  private readonly store: ThreadTodoStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly running = new Set<string>();
  private runners: ThreadTodoActionRunners | undefined;
  private onChanged: ((event: ThreadTodosChangedEvent) => void) | undefined;

  constructor(options: ThreadTodoServiceOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.onChanged = options.onChanged;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  setRunners(runners: ThreadTodoActionRunners | undefined): void {
    this.runners = runners;
  }

  setOnChanged(
    listener: ((event: ThreadTodosChangedEvent) => void) | undefined,
  ): void {
    this.onChanged = listener;
  }

  /**
   * Raise a card for the calling thread. An open card with the same key is
   * updated in place, so a thread that reports "ready for review" after every
   * turn keeps one card instead of stacking them.
   */
  add(params: {
    backend: AppServerBackendKind;
    threadId: string;
    cwd?: string;
    input: AddThreadTodoInput;
  }): { todo: ThreadTodo; created: boolean } {
    const { backend, threadId, input } = params;
    const kind = threadTodoKindForAction(input.action);
    const now = this.now();
    const existing = input.key
      ? this.store.findOpenByKey({ backend, threadId, key: input.key })
      : undefined;
    if (existing) {
      const todo = this.store.replaceContent({
        id: existing.id,
        kind,
        title: input.title,
        detail: input.detail,
        action: input.action,
        cwd: params.cwd,
        now,
      });
      this.emit(todo);
      return { todo, created: false };
    }
    if (this.store.countOpen({ backend, threadId }) >= THREAD_TODO_MAX_OPEN_PER_THREAD) {
      throw new ThreadTodoError(
        "limit_reached",
        `This thread already has ${THREAD_TODO_MAX_OPEN_PER_THREAD} open to-dos. Resolve some with resolve_todo, or reuse a key to update one.`,
      );
    }
    const todo = this.store.insert({
      id: this.newId(),
      backend,
      threadId,
      key: input.key,
      kind,
      title: input.title,
      detail: input.detail,
      action: input.action,
      cwd: params.cwd,
      now,
    });
    this.emit(todo);
    return { todo, created: true };
  }

  list(request: ListThreadTodosRequest = {}): ThreadTodo[] {
    return this.store.list(request);
  }

  /** Operator resolve or reopen (Undo), from the card or the panel. */
  resolve(params: { id: string; status: ThreadTodoStatus }): ThreadTodo {
    const current = this.require(params.id);
    if (current.status === params.status) {
      return current;
    }
    if (params.status === "open" && current.key) {
      const conflicting = this.store.findOpenByKey({
        backend: current.backend,
        threadId: current.threadId,
        key: current.key,
      });
      if (conflicting) {
        throw new ThreadTodoError(
          "conflict",
          "The thread raised a newer card with the same key. Resolve that one instead.",
        );
      }
    }
    const todo = this.store.setStatus({
      id: params.id,
      status: params.status,
      now: this.now(),
    });
    this.emit(todo);
    return todo;
  }

  /** The thread resolves one of its own cards, by id or key. */
  resolveFromThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    id?: string;
    key?: string;
    status: Exclude<ThreadTodoStatus, "open">;
  }): ThreadTodo {
    const target = params.id
      ? this.store.get(params.id)
      : params.key
        ? this.store.findOpenByKey({
            backend: params.backend,
            threadId: params.threadId,
            key: params.key,
          })
        : undefined;
    if (
      !target
      || target.backend !== params.backend
      || target.threadId !== params.threadId
    ) {
      throw new ThreadTodoError(
        "not_found",
        "No to-do with that id or key belongs to this thread.",
      );
    }
    return this.resolve({ id: target.id, status: params.status });
  }

  /**
   * Run a card's main-process action. Success marks the card done with its
   * result. Failure keeps the card open with the error, so the operator can
   * read it and retry.
   */
  async runAction(id: string): Promise<ThreadTodo> {
    const todo = this.require(id);
    if (todo.status !== "open") {
      throw new ThreadTodoError("conflict", "This to-do is already resolved.");
    }
    const action = todo.action;
    if (!action || action.type === "start_review") {
      throw new ThreadTodoError(
        "invalid_arguments",
        "This to-do has no action that runs here.",
      );
    }
    if (this.running.has(id)) {
      throw new ThreadTodoError("conflict", "This to-do's action is already running.");
    }
    const runners = this.runners;
    if (!runners) {
      throw new Error("Thread to-do actions are not available.");
    }
    this.running.add(id);
    try {
      if (action.type === "merge_pull_request") {
        const merged = await runners.mergePullRequest({
          cwd: todo.cwd,
          pullRequest: action.pullRequest,
        });
        return this.finish(id, { result: merged.summary });
      }
      const started = await runners.startThread({
        sourceBackend: todo.backend,
        sourceThreadId: todo.threadId,
        cwd: todo.cwd,
        action,
      });
      return this.finish(id, {
        result: "Started thread",
        startedThread: started,
      });
    } catch (error) {
      const failed = this.store.setError({
        id,
        error: error instanceof Error ? error.message : String(error),
        now: this.now(),
      });
      this.emit(failed);
      return failed;
    } finally {
      this.running.delete(id);
    }
  }

  dismissOpenForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void {
    const changed = this.store.dismissOpenForThread({
      ...params,
      now: this.now(),
    });
    if (changed > 0) {
      this.onChanged?.({ at: this.now(), ...params });
    }
  }

  private finish(
    id: string,
    result: { result: string; startedThread?: ThreadTodoStartedThread },
  ): ThreadTodo {
    const todo = this.store.setStatus({
      id,
      status: "done",
      now: this.now(),
      result,
    });
    this.emit(todo);
    return todo;
  }

  private require(id: string): ThreadTodo {
    const todo = this.store.get(id);
    if (!todo) {
      throw new ThreadTodoError("not_found", "That to-do no longer exists.");
    }
    return todo;
  }

  private emit(todo: ThreadTodo): void {
    this.onChanged?.({
      at: this.now(),
      backend: todo.backend,
      threadId: todo.threadId,
    });
  }
}
