import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  ListThreadTodosRequest,
  ThreadTodo,
  ThreadTodoAction,
  ThreadTodoItem,
  ThreadTodoMergeMethod,
  ThreadTodoModelSettings,
  ThreadTodoMessageTarget,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoProject,
  ThreadTodoResolution,
  ThreadTodoStartedThread,
  ThreadTodoStatus,
  ThreadTodosChangedEvent,
  ThreadTodoWorkMode,
  ThreadExecutionMode,
  CodexSpeed,
} from "@pwragent/shared";
import {
  DEFAULT_THREAD_TODO_MERGE_METHOD,
  THREAD_TODO_MAX_OPEN_PER_THREAD,
  THREAD_TODO_RESOLUTION_RESULTS,
  mergeThreadTodoItems,
  threadTodoActionProject,
  threadTodoKindForAction,
  threadTodoBlockingItems,
  threadTodoItemNoun,
  threadTodoSteps,
} from "@pwragent/shared";
import type { ThreadTodoStore } from "./thread-todo-store.js";
import {
  THREAD_TODO_PLAN_DETAIL,
  THREAD_TODO_PLAN_KEY,
  threadTodoPlanTitle,
  type ThreadTodoPlan,
} from "./thread-todo-plan.js";

type StartThreadAction = Extract<ThreadTodoAction, { type: "start_thread" }>;

/**
 * The two actions that run in the main process. `start_review` is not here:
 * it opens the composer's own `/review` flow in the renderer, so the operator
 * still picks the target and reviewer, and the renderer resolves the card
 * once the review starts.
 */
export type ThreadTodoActionRunners = {
  sendMessage?: (params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    target: ThreadTodoMessageTarget;
    prompt: string;
  }) => Promise<{ summary: string }>;
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
    modelSettings?: ThreadTodoModelSettings;
    /** The card's plain steps, raised as the new thread's own card. */
    plan?: ThreadTodoPlan;
  } & ThreadTodoStartChoices) => Promise<ThreadTodoStartedThread & {
    dispatchSettings?: { settings: ThreadTodoModelSettings; source: ThreadTodoModelSettings };
  }>;
  /** The same, on a federation peer, in that peer's copy of `project`. */
  startThreadOnInstance?: (params: {
    instanceId: string;
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    project?: ThreadTodoProject;
    crossProject: boolean;
    action: StartThreadAction;
    /** Checked against the peer's catalog; absent uses the peer's defaults. */
    modelSettings?: ThreadTodoModelSettings;
    /** Raised on the peer when it answers `threadTodos.raisePlan`. */
    plan?: ThreadTodoPlan;
  } & ThreadTodoStartChoices) => Promise<ThreadTodoStartedThread>;
};

/** What the operator chose on a handoff card besides its model. */
export type ThreadTodoStartChoices = {
  /** Replaces the card's own Where. */
  workMode?: ThreadTodoWorkMode;
  /** An environment id, or `none`. Absent keeps the default. */
  environment?: string;
  speed?: CodexSpeed;
};

export type AddThreadTodoInput = {
  title: string;
  detail?: string;
  /**
   * Step texts, already checked against the limits. Re-adding a key merges
   * them into the open card's steps (see mergeThreadTodoItems); leaving them
   * out keeps the card's steps as they are.
   */
  items?: string[];
  /**
   * What the operator must do before the action can run, merged like
   * `items`. Only these hold a start_thread card's Start back.
   */
  prerequisites?: string[];
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
  /** The card's steps restated, merged as add_todo merges them; [] clears. */
  items?: string[];
  /** The card's prerequisites restated, merged the same way; [] clears. */
  prerequisites?: string[];
  /** Step ids to tick, and to untick. */
  check?: string[];
  uncheck?: string[];
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
    readonly code:
      | "not_found"
      | "invalid_arguments"
      | "limit_reached"
      | "conflict"
      | "open_items",
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

  private readDispatchSettings: ((thread: { backend: AppServerBackendKind; threadId: string }) => Promise<
    Pick<NonNullable<ThreadTodo["dispatchDefaults"]>, "thread" | "threadSpeed">
  >) | undefined;

  setDispatchSettingsReader(reader: NonNullable<ThreadTodoService["readDispatchSettings"]>): void {
    this.readDispatchSettings = reader;
  }

  /** Read once per owner, with the cards, so a remembered pick never flashes. */
  async withDispatchDefaults(todos: ThreadTodo[]): Promise<ThreadTodo[]> {
    const defaults = new Map<string, Promise<NonNullable<ThreadTodo["dispatchDefaults"]>>>();
    return Promise.all(todos.map(async (todo) => {
      if (todo.action?.type !== "start_thread" || !this.readDispatchSettings) return todo;
      const key = JSON.stringify([todo.backend, todo.threadId]);
      let pending = defaults.get(key);
      if (!pending) {
        pending = this.readDispatchSettings(todo).then((defaults) => ({
          ...defaults,
          lastDispatch: this.store.getThreadModelSettings(todo.backend, todo.threadId),
        }));
        defaults.set(key, pending);
      }
      return { ...todo, dispatchDefaults: await pending };
    }));
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
    // Read and write in one transaction: a re-raise merges into the steps
    // the operator may be ticking from another window at the same moment.
    const result = this.store.transaction((): { todo: ThreadTodo; created: boolean } => {
      const existing = input.key
        ? this.store.findOpenByKey({ backend, threadId, key: input.key })
        : undefined;
      if (existing) {
        const todo = this.store.replaceContent({
          id: existing.id,
          kind,
          title: input.title,
          detail: input.detail,
          items: input.items === undefined && input.prerequisites === undefined
            ? existing.items
            : mergeThreadTodoItems(
                existing.items,
                input.items,
                this.newId,
                input.prerequisites,
              ),
          action: input.action,
          cwd: params.cwd,
          sourceProject,
          targetProject,
          now,
        });
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
        items: mergeThreadTodoItems(
          undefined,
          input.items ?? [],
          this.newId,
          input.prerequisites ?? [],
        ),
        action: input.action,
        cwd: params.cwd,
        sourceProject,
        targetProject,
        now,
      });
      return { todo, created: true };
    });
    this.emit(result.todo);
    return result;
  }

  /**
   * The card a thread dependency raises for the operator. Synchronous so it
   * can share the dependency's claim transaction, and silent until
   * `publish`, after that transaction commits.
   *
   * A dependency raises one card for its lifetime: an existing card is
   * returned as it stands, even when the operator already resolved it. The
   * open-card cap does not apply. It guards against a looping turn calling
   * add_todo; a dependency fires once, after a prerequisite event, and a
   * thread holds at most 32 active registrations.
   */
  raiseForDependency(params: {
    backend: AppServerBackendKind;
    threadId: string;
    dependencyId: string;
    key: string;
    title: string;
    detail?: string;
    action?: StartThreadAction;
    cwd?: string;
    sourceProject?: ThreadTodoProject;
  }): { todo: ThreadTodo; created: boolean } {
    const existing = this.store.findByDependency(params.dependencyId);
    if (existing) return { todo: existing, created: false };
    // A card the thread raised itself with this key would block the insert.
    const keyed = this.store.findOpenByKey(params);
    const todo = this.store.insert({
      id: this.newId(),
      backend: params.backend,
      threadId: params.threadId,
      ...(keyed ? {} : { key: params.key }),
      kind: threadTodoKindForAction(params.action),
      title: params.title,
      detail: params.detail,
      action: params.action,
      cwd: params.cwd,
      sourceProject: params.sourceProject,
      dependencyId: params.dependencyId,
      now: this.now(),
    });
    return { todo, created: true };
  }

  /**
   * The checklist a thread started from a card works through: that card's
   * plain steps, as the new thread's own card keyed `plan`. One commit. The
   * card is a reminder, so the thread ticks its steps with update_todo and
   * can restate or resolve it; a repeat for the same thread merges into the
   * open card instead of adding one.
   */
  raisePlan(params: {
    backend: AppServerBackendKind;
    threadId: string;
    cwd?: string;
    sourceProject?: ThreadTodoProject;
    plan: ThreadTodoPlan;
  }): ThreadTodo {
    return this.add({
      backend: params.backend,
      threadId: params.threadId,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.sourceProject ? { sourceProject: params.sourceProject } : {}),
      input: {
        title: threadTodoPlanTitle(params.plan.title),
        detail: THREAD_TODO_PLAN_DETAIL,
        key: THREAD_TODO_PLAN_KEY,
        items: params.plan.items,
      },
    }).todo;
  }

  /** Announce a card written outside the service's own mutations. */
  publish(todo: ThreadTodo): void {
    this.emit(todo);
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
    /** Complete it done although steps are unchecked. Dismiss never needs it. */
    allowOpenItems?: boolean;
  }): ThreadTodo {
    const current = this.require(params.id);
    if (current.status === params.status) {
      return current;
    }
    if (params.status === "done" && !params.allowOpenItems) {
      assertNoBlockingItems(current);
    }
    // The run would write its result over this when it ends: a dismissed
    // card would come back done, or take the run's error after resolving.
    if (this.running.has(current.id)) {
      throw new ThreadTodoError("conflict", "This to-do's action is running now.");
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
    /** The operator handed the card to this thread, which claims it first. */
    resolution?: "sent_here";
    allowOpenItems?: boolean;
  }): ThreadTodo {
    const target = this.findForThread(params);
    return this.resolve({
      id: target.id,
      status: params.status,
      ...(params.resolution ? { resolution: params.resolution } : {}),
      ...(params.allowOpenItems ? { allowOpenItems: true } : {}),
    });
  }

  /** Any card on this owner, by id. */
  get(id: string): ThreadTodo {
    return this.require(id);
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
    /** Step texts restated; merged with the card's steps. [] clears them. */
    items?: string[];
    /** Prerequisite texts restated, merged the same way. */
    prerequisites?: string[];
    /** Step ids to tick and untick, after `items` is merged. */
    check?: string[];
    uncheck?: string[];
    /** Resolved project; null returns the card to its thread's project. */
    targetProject?: ThreadTodoProject | null;
    action?: ThreadTodoActionPatch;
  }): ThreadTodo {
    const contentChanges = params.title !== undefined
      || params.detail !== undefined
      || params.items !== undefined
      || params.prerequisites !== undefined
      || params.targetProject !== undefined
      || (params.action !== undefined && Object.keys(params.action).length > 0);
    // Ticking steps changes nothing a running action reads, so it is
    // allowed while a merge or a handoff runs.
    if (!contentChanges) {
      return this.setItemsChecked({
        id: params.id,
        check: params.check ?? [],
        uncheck: params.uncheck ?? [],
      });
    }
    const todo = this.store.transaction(() => {
      const current = this.requireOpen(params.id);
      if (this.running.has(current.id)) {
        throw new ThreadTodoError("conflict", "This to-do's action is running now.");
      }
      return this.replaceOpenContent(current, params);
    });
    this.emit(todo);
    return todo;
  }

  /**
   * Tick and untick steps by id, from the card or an agent. One commit, and
   * none when every step already reads that way. Checking the last step does
   * not resolve the card: Done stays the operator's click.
   */
  setItemsChecked(params: {
    id: string;
    check: readonly string[];
    uncheck: readonly string[];
  }): ThreadTodo {
    const both = params.check.filter((itemId) => params.uncheck.includes(itemId));
    if (both.length > 0) {
      throw new ThreadTodoError(
        "invalid_arguments",
        `Step ${both.join(", ")} cannot be both checked and unchecked.`,
      );
    }
    // Checked outside the transaction first, so a tick that changes
    // nothing (a repeat, or an agent restating) opens no transaction.
    const before = this.requireOpen(params.id);
    const unchanged = applyItemChecks(before.items ?? [], params.check, params.uncheck)
      .every((item, index) => item.checked === before.items?.[index]?.checked);
    if (unchanged) return before;
    const todo = this.store.transaction(() => {
      const current = this.requireOpen(params.id);
      return this.store.setItems({
        id: current.id,
        items: applyItemChecks(current.items ?? [], params.check, params.uncheck),
        now: this.now(),
      });
    });
    this.emit(todo);
    return todo;
  }

  private requireOpen(id: string): ThreadTodo {
    const current = this.require(id);
    if (current.status !== "open") {
      throw new ThreadTodoError(
        "conflict",
        "This to-do is already resolved. Raise a new card with add_todo instead.",
      );
    }
    return current;
  }

  private replaceOpenContent(
    current: ThreadTodo,
    params: {
      title?: string;
      detail?: string | null;
      items?: string[];
      prerequisites?: string[];
      check?: string[];
      uncheck?: string[];
      targetProject?: ThreadTodoProject | null;
      action?: ThreadTodoActionPatch;
    },
  ): ThreadTodo {
    const merged = params.items === undefined && params.prerequisites === undefined
      ? current.items ?? []
      : mergeThreadTodoItems(current.items, params.items, this.newId, params.prerequisites);
    const items = applyItemChecks(merged, params.check ?? [], params.uncheck ?? []);
    const action = patchAction(current.action, params.action);
    const targetProject = params.targetProject === undefined
      ? current.targetProject
      : params.targetProject !== null
        && params.targetProject.key !== current.sourceProject?.key
        ? params.targetProject
        : undefined;
    return this.store.replaceContent({
      id: current.id,
      kind: current.kind,
      title: params.title ?? current.title,
      detail: params.detail === undefined ? current.detail : params.detail ?? undefined,
      items,
      action,
      targetProject,
      now: this.now(),
    });
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
      messageTarget?: ThreadTodoMessageTarget;
      modelSettings?: ThreadTodoModelSettings;
      /** A run that succeeds marks the card done, so it asks the same. */
      allowOpenItems?: boolean;
    } & ThreadTodoStartChoices = {},
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
    if (!options.allowOpenItems) {
      assertNoBlockingItems(todo);
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
      if (action.type === "send_message" || options.messageTarget) {
        if (action.type !== "send_message" && action.type !== "start_thread") {
          throw new ThreadTodoError("invalid_arguments", "Only a handoff can be sent to another thread.");
        }
        const target = options.messageTarget ?? (action.type === "send_message" ? action.target : undefined);
        if (!target || !runners.sendMessage) throw new Error("Sending a message is not available.");
        if (!target.instanceId && target.backend === todo.backend && target.threadId === todo.threadId) {
          throw new ThreadTodoError("invalid_arguments", "Use Do it here for this card's own thread.");
        }
        const sent = await runners.sendMessage({
          sourceBackend: todo.backend, sourceThreadId: todo.threadId, target, prompt: action.prompt,
        });
        return this.finish(id, { result: sent.summary });
      }
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
      if (action.type !== "start_thread") throw new Error("Unsupported to-do action.");
      const choices: ThreadTodoStartChoices = {
        ...(options.workMode ? { workMode: options.workMode } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
      };
      // Prerequisites were the operator's; the plain steps are the new
      // thread's work, so only those go along.
      const steps = threadTodoSteps(todo).map((item) => item.text);
      const plan: ThreadTodoPlan | undefined = steps.length > 0
        ? { title: action.title ?? todo.title, items: steps }
        : undefined;
      const started: Awaited<ReturnType<ThreadTodoActionRunners["startThread"]>> = startOnInstance && options.startOnInstanceId
        ? await startOnInstance({
            instanceId: options.startOnInstanceId,
            sourceBackend: todo.backend,
            sourceThreadId: todo.threadId,
            project,
            crossProject,
            action,
            // The thread's remembered dispatch was checked against this
            // machine's catalog, so only an explicit pick goes to a peer.
            ...(options.modelSettings ? { modelSettings: options.modelSettings } : {}),
            ...(plan ? { plan } : {}),
            ...choices,
          })
        : await runners.startThread({
            sourceBackend: todo.backend,
            sourceThreadId: todo.threadId,
            cwd,
            crossProject,
            action,
            modelSettings: options.modelSettings
              ?? this.store.getThreadModelSettings(todo.backend, todo.threadId),
            ...(plan ? { plan } : {}),
            ...choices,
          });
      if (started.dispatchSettings) {
        this.store.rememberDispatch(todo.backend, todo.threadId,
          started.dispatchSettings.settings, started.dispatchSettings.source);
      }
      const { backend, threadId, instanceId, instanceLabel } = started;
      return this.finish(id, {
        result: started.instanceLabel
          ? `Started thread on ${started.instanceLabel}`
          : "Started thread",
        startedThread: { backend, threadId, ...(instanceId ? { instanceId } : {}), ...(instanceLabel ? { instanceLabel } : {}) },
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

/**
 * The completion rule: a card with unchecked blocking steps is not done, and
 * its action does not run (threadTodoBlockingItems). The message names each
 * open step and its id, so an agent can tick the ones that are finished or
 * say why the rest no longer apply.
 */
function assertNoBlockingItems(todo: ThreadTodo): void {
  const open = threadTodoBlockingItems(todo);
  if (open.length === 0) return;
  const steps = open.map((item) => `"${item.text}" (${item.id})`).join(", ");
  throw new ThreadTodoError(
    "open_items",
    `This to-do has ${open.length} unchecked ${threadTodoItemNoun(open)}: ${steps}. `
      + "Check finished steps with update_todo check, or pass allowOpenItems: true when the operator says the rest no longer apply.",
  );
}

function applyItemChecks(
  items: readonly ThreadTodoItem[],
  check: readonly string[],
  uncheck: readonly string[],
): ThreadTodoItem[] {
  const known = new Set(items.map((item) => item.id));
  const unknown = [...check, ...uncheck].filter((itemId) => !known.has(itemId));
  if (unknown.length > 0) {
    throw new ThreadTodoError(
      "invalid_arguments",
      `This to-do has no step with id ${unknown.join(", ")}. list_todos shows each step's id.`,
    );
  }
  return items.map((item) => {
    if (check.includes(item.id)) return { ...item, checked: true };
    if (uncheck.includes(item.id)) return { ...item, checked: false };
    return item;
  });
}

function patchAction(
  action: ThreadTodoAction | undefined,
  patch: ThreadTodoActionPatch | undefined,
): ThreadTodoAction | undefined {
  if (!patch || Object.keys(patch).length === 0) {
    return action;
  }
  const fields = Object.keys(patch);
  if (action?.type === "send_message") {
    if (fields.some((field) => field !== "prompt")) {
      throw new ThreadTodoError("invalid_arguments", "A message card takes only prompt updates. Raise it again with the same key to change its destination.");
    }
    return patch.prompt ? { ...action, prompt: patch.prompt } : action;
  }
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
