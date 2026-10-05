import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  ListThreadTodosRequest,
  ThreadTodo,
  ThreadTodoAction,
  ThreadTodoMergeMethod,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoProject,
  ThreadTodoResolution,
  ThreadTodoStartedThread,
  ThreadTodoStatus,
  ThreadTodosChangedEvent,
  ThreadTodoWorkMode,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  DEFAULT_THREAD_TODO_MERGE_METHOD,
  THREAD_TODO_MAX_OPEN_PER_THREAD,
  THREAD_TODO_RESOLUTION_RESULTS,
  threadTodoActionProject,
  threadTodoKindForAction,
} from "@pwragent/shared";
import type { ThreadTodoStore } from "./thread-todo-store.js";

type StartThreadAction = Extract<ThreadTodoAction, { type: "start_thread" }>;

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
    method: ThreadTodoMergeMethod;
  }) => Promise<{ summary: string }>;
  /**
   * `crossProject` is true when the card is for a project other than the
   * raising thread's. Such a thread is not grouped under the source thread,
   * matching handoff_task.
   */
  startThread: (params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    cwd?: string;
    crossProject: boolean;
    action: StartThreadAction;
  }) => Promise<ThreadTodoStartedThread>;
  /** The same, on a federation peer, in that peer's copy of `project`. */
  startThreadOnInstance?: (params: {
    instanceId: string;
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    project?: ThreadTodoProject;
    crossProject: boolean;
    action: StartThreadAction;
  }) => Promise<ThreadTodoStartedThread>;
};

export type AddThreadTodoInput = {
  title: string;
  detail?: string;
  key?: string;
  action?: ThreadTodoAction;
  /** The project name or path the thread named, resolved by the runtime. */
  project?: string;
};

/**
 * Changes to one field of a card's action. Absent leaves the field alone;
 * null clears an optional one back to its default.
 */
export type ThreadTodoActionPatch = {
  prompt?: string;
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  executionMode?: ThreadExecutionMode | null;
  workMode?: ThreadTodoWorkMode | null;
  pullRequest?: string;
};

export type UpdateThreadTodoInput = {
  title?: string;
  detail?: string | null;
  /** A project name or path, resolved by the runtime; null for the thread's own. */
  project?: string | null;
  action?: ThreadTodoActionPatch;
};

const START_THREAD_PATCH_FIELDS = [
  "prompt",
  "title",
  "model",
  "reasoningEffort",
  "executionMode",
  "workMode",
] as const;

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
  /** `[git] default_merge_method`, read when it is needed. */
  defaultMergeMethod?: () => ThreadTodoMergeMethod;
  now?: () => number;
  newId?: () => string;
};

export class ThreadTodoService {
  private readonly store: ThreadTodoStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly running = new Set<string>();
  private runners: ThreadTodoActionRunners | undefined;
  private readonly defaultMergeMethod: () => ThreadTodoMergeMethod;
  private onChanged: ((event: ThreadTodosChangedEvent) => void) | undefined;

  constructor(options: ThreadTodoServiceOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.onChanged = options.onChanged;
    this.defaultMergeMethod = options.defaultMergeMethod
      ?? (() => DEFAULT_THREAD_TODO_MERGE_METHOD);
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
    sourceProject?: ThreadTodoProject;
    targetProject?: ThreadTodoProject;
    input: AddThreadTodoInput;
  }): { todo: ThreadTodo; created: boolean } {
    const { backend, threadId, input, sourceProject } = params;
    const kind = threadTodoKindForAction(input.action);
    // Naming the thread's own project is not a target: there is nothing
    // to point at that the source does not already say.
    const targetProject = params.targetProject
      && params.targetProject.key !== sourceProject?.key
      ? params.targetProject
      : undefined;
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
        sourceProject,
        targetProject,
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
      sourceProject,
      targetProject,
      now,
    });
    this.emit(todo);
    return { todo, created: true };
  }

  list(request: ListThreadTodosRequest = {}): ThreadTodo[] {
    return this.store.list(request);
  }

  mergeMethodPreferences(): ThreadTodoMergeMethodPreferences {
    return {
      defaultMethod: this.defaultMergeMethod(),
      byProject: this.store.listProjectMergeMethods(),
    };
  }

  /** Operator resolve or reopen (Undo), from the card or the panel. */
  resolve(params: {
    id: string;
    status: ThreadTodoStatus;
    resolution?: ThreadTodoResolution;
  }): ThreadTodo {
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
      ...(params.status === "done" && params.resolution
        ? { result: { result: THREAD_TODO_RESOLUTION_RESULTS[params.resolution] } }
        : {}),
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
    const target = this.findForThread(params);
    return this.resolve({ id: target.id, status: params.status });
  }

  /** One of the calling thread's cards, by id or by an open card's key. */
  findForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    id?: string;
    key?: string;
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
    return target;
  }

  /**
   * Change some of an open card's fields and keep the rest, so "use another
   * model" does not make the thread restate the prompt. The runtime has
   * already resolved the project and checked the model. One commit, and it
   * clears a failed run's error, since the card now says something else.
   */
  update(params: {
    id: string;
    title?: string;
    detail?: string | null;
    /** Resolved project; null returns the card to its thread's project. */
    targetProject?: ThreadTodoProject | null;
    action?: ThreadTodoActionPatch;
  }): ThreadTodo {
    const current = this.require(params.id);
    if (current.status !== "open") {
      throw new ThreadTodoError(
        "conflict",
        "This to-do is already resolved. Raise a new card with add_todo instead.",
      );
    }
    if (this.running.has(current.id)) {
      throw new ThreadTodoError("conflict", "This to-do's action is running now.");
    }
    const action = patchAction(current.action, params.action);
    const targetProject = params.targetProject === undefined
      ? current.targetProject
      : params.targetProject !== null
        && params.targetProject.key !== current.sourceProject?.key
        ? params.targetProject
        : undefined;
    const todo = this.store.replaceContent({
      id: current.id,
      kind: current.kind,
      title: params.title ?? current.title,
      detail: params.detail === undefined ? current.detail : params.detail ?? undefined,
      action,
      targetProject,
      now: this.now(),
    });
    this.emit(todo);
    return todo;
  }

  /**
   * Run a card's main-process action. Success marks the card done with its
   * result. Failure keeps the card open with the error, so the operator can
   * read it and retry.
   */
  async runAction(
    id: string,
    options: {
      mergeMethod?: ThreadTodoMergeMethod;
      rememberMergeMethod?: boolean;
      startOnInstanceId?: string;
    } = {},
  ): Promise<ThreadTodo> {
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
    const startOnInstance = action.type === "start_thread" && options.startOnInstanceId
      ? runners.startThreadOnInstance
      : undefined;
    if (action.type === "start_thread" && options.startOnInstanceId && !startOnInstance) {
      throw new Error("Starting a thread on another PwrAgent is not available.");
    }
    const project = threadTodoActionProject(todo);
    // A target project is a different repository: run there, not in the
    // raising thread's workspace.
    const cwd = todo.targetProject ? todo.targetProject.path : todo.cwd;
    const crossProject = todo.targetProject !== undefined;
    this.running.add(id);
    try {
      if (action.type === "merge_pull_request") {
        const method = options.mergeMethod
          ?? (project ? this.store.getProjectMergeMethod(project.key) : undefined)
          ?? this.defaultMergeMethod();
        // Remembered before the merge runs: the pick is the operator's
        // preference whether or not this particular merge succeeds.
        if (options.mergeMethod && options.rememberMergeMethod && project) {
          this.store.setProjectMergeMethod({
            directoryKey: project.key,
            method: options.mergeMethod,
            now: this.now(),
          });
        }
        const merged = await runners.mergePullRequest({
          cwd,
          pullRequest: action.pullRequest,
          method,
        });
        return this.finish(id, { result: merged.summary });
      }
      const started = startOnInstance && options.startOnInstanceId
        ? await startOnInstance({
            instanceId: options.startOnInstanceId,
            sourceBackend: todo.backend,
            sourceThreadId: todo.threadId,
            project,
            crossProject,
            action,
          })
        : await runners.startThread({
            sourceBackend: todo.backend,
            sourceThreadId: todo.threadId,
            cwd,
            crossProject,
            action,
          });
      return this.finish(id, {
        result: started.instanceLabel
          ? `Started thread on ${started.instanceLabel}`
          : "Started thread",
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

function patchAction(
  action: ThreadTodoAction | undefined,
  patch: ThreadTodoActionPatch | undefined,
): ThreadTodoAction | undefined {
  if (!patch || Object.keys(patch).length === 0) {
    return action;
  }
  const fields = Object.keys(patch);
  if (action?.type === "merge_pull_request") {
    const misplaced = fields.filter((field) => field !== "pullRequest");
    if (misplaced.length > 0) {
      throw new ThreadTodoError(
        "invalid_arguments",
        `A merge card takes only pullRequest, not ${misplaced.join(", ")}.`,
      );
    }
    return patch.pullRequest ? { ...action, pullRequest: patch.pullRequest } : action;
  }
  if (action?.type === "start_thread") {
    if (patch.pullRequest !== undefined) {
      throw new ThreadTodoError(
        "invalid_arguments",
        "A handoff card has no pull request to change.",
      );
    }
    const next: StartThreadAction = { ...action };
    for (const field of START_THREAD_PATCH_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === null) {
        // The prompt is required: null cannot clear it.
        if (field !== "prompt") delete (next as Record<string, unknown>)[field];
      } else {
        (next as Record<string, unknown>)[field] = value;
      }
    }
    return next;
  }
  throw new ThreadTodoError(
    "invalid_arguments",
    action
      ? "A review card has no action fields to change."
      : "A reminder has no action to change. Raise a new card with add_todo to add one.",
  );
}
