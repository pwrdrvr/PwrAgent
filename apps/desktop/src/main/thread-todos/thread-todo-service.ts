import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ListThreadTodosRequest,
  ReviewThreadTodoCiDeploymentRequest,
  ThreadTodo,
  ThreadTodoAction,
  ThreadTodoCiApproval,
  ThreadTodoItem,
  ThreadTodoMergeMethod,
  ThreadTodoModelSettings,
  ThreadTodoMessageTarget,
  ThreadTodoPlacement,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoProject,
  ThreadTodoResolution,
  ThreadTodoSeenExecutionMode,
  ThreadTodoStartedThread,
  ThreadTodoStatus,
  ThreadTodosChangedEvent,
  ThreadTodoWorkMode,
} from "@pwragent/shared/contracts/thread-todos";
import type { CodexSpeed } from "@pwragent/shared/codex-speed";
import type { ThreadTodoNativeAccessMode } from "@pwragent/shared/thread-todo-access";
import {
  DEFAULT_THREAD_TODO_MERGE_METHOD,
  THREAD_TODO_MAX_OPEN_PER_THREAD,
  THREAD_TODO_MERGE_METHODS,
  THREAD_TODO_PLACEMENT_LOCK_MESSAGES,
  THREAD_TODO_SETUP_FAILURE_MAX_LENGTH,
  THREAD_TODO_RESOLUTION_RESULTS,
  mergeThreadTodoItems,
  resolveThreadTodoPlacement,
  settleMergeMethod,
  threadTodoActionProject,
  threadTodoCiDeploymentReviewRequest,
  threadTodoKindForAction,
  threadTodoBlockingItems,
  threadTodoItemNoun,
  threadTodoStartActionForRun,
  threadTodoStartAccessChanged,
  threadTodoSteps,
} from "@pwragent/shared/contracts/thread-todos";
import { PR_OFFER_RETIRE_RESULTS } from "../pr-status/pr-review-readiness";
import type { ThreadTodoStorage } from "@pwragent/owner-core/thread-todo-storage";
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
 * still picks the target and reviewer. A queued review carries the card to
 * the scheduler, which resolves it once the review starts.
 */
export type ThreadTodoActionRunners = {
  sendMessage?: (params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    target: ThreadTodoMessageTarget;
    prompt: string;
    todo: ThreadTodoDispatchCard;
  }) => Promise<{ summary: string }>;
  mergePullRequest: (params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    cwd?: string;
    pullRequest: string;
    method: ThreadTodoMergeMethod;
  }) => Promise<{ summary: string }>;
  /** Saves a proposed hands-off rule to the raising thread's project. */
  addForgeHandsOffRule?: (params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    repository: string;
    label?: string;
  }) => Promise<{ summary: string }>;
  /**
   * `crossProject` is true when the card is for a project other than the
   * raising thread's. `placement` is settled by then: a sub-thread is filed
   * under the source thread, and a cross-project start is always top-level.
   */
  startThread: (params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    cwd?: string;
    project?: ThreadTodoProject;
    crossProject: boolean;
    /** Absent is a sub-thread, unless the start is for another project. */
    placement?: ThreadTodoPlacement;
    action: StartThreadAction;
    todo: ThreadTodoDispatchCard;
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
    todo: ThreadTodoDispatchCard;
    /** Checked against the peer's catalog; absent uses the peer's defaults. */
    modelSettings?: ThreadTodoModelSettings;
    /** Raised on the peer when it answers `threadTodos.raisePlan`. */
    plan?: ThreadTodoPlan;
  } & ThreadTodoStartChoices) => Promise<ThreadTodoInstanceStartedThread>;
};

export type ThreadTodoInstanceStartedThread = ThreadTodoStartedThread & {
  /** Added to the card's result, as when the peer could not honor its Where. */
  notice?: string;
};

/**
 * The card whose action sent a prompt, recorded on the message's origin. The
 * card is resolved by then, so this is display text, never a link.
 */
export type ThreadTodoDispatchCard = { id: string; title?: string };

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
  backend?: AppServerBackendKind | null;
  model?: string | null;
  reasoningEffort?: string | null;
  executionMode?: ThreadExecutionMode | null;
  workMode?: ThreadTodoWorkMode | null;
  placement?: ThreadTodoPlacement | null;
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
  "backend",
  "model",
  "reasoningEffort",
  "executionMode",
  "workMode",
  "placement",
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

/**
 * Approves the deployment gate the operator reviewed, on this owner's forge
 * sign-in. It re-reads GitHub and refuses unless the gate still matches;
 * see `approveGithubCiDeployment`.
 */
export type ThreadTodoCiDeploymentReviewer = (
  reviewed: ReviewThreadTodoCiDeploymentRequest,
) => Promise<{ environments: string[] }>;

export type ThreadTodoServiceOptions = {
  store: ThreadTodoStorage;
  readCiApprovals?: (todo: ThreadTodo, dependencyId: string) => ThreadTodoCiApproval[];
  runners?: ThreadTodoActionRunners;
  onChanged?: (event: ThreadTodosChangedEvent) => void;
  /** `[git] default_merge_method`, read when it is needed. */
  defaultMergeMethod?: () => ThreadTodoMergeMethod;
  now?: () => number;
  newId?: () => string;
};

export class ThreadTodoService {
  private readonly store: ThreadTodoStorage;
  private readonly readCiApprovals: ThreadTodoServiceOptions["readCiApprovals"];
  private ciDeploymentReviewer: ThreadTodoCiDeploymentReviewer | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly running = new Set<string>();
  private runners: ThreadTodoActionRunners | undefined;
  private readonly defaultMergeMethod: () => ThreadTodoMergeMethod;
  private onChanged: ((event: ThreadTodosChangedEvent) => void) | undefined;

  constructor(options: ThreadTodoServiceOptions) {
    this.store = options.store;
    this.readCiApprovals = options.readCiApprovals;
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
      if (!threadTodoStartActionForRun(todo.action, { startNewThread: true }) || !this.readDispatchSettings) return todo;
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

  /** Installed by the owner with its forge client; absent, the cards offer Review on GitHub alone. */
  setCiDeploymentReviewer(reviewer: ThreadTodoCiDeploymentReviewer | undefined): void {
    this.ciDeploymentReviewer = reviewer;
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
    assertPlacementFitsProject(input.action?.type === "start_thread" ? input.action.placement : undefined, targetProject);
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
    /** A dependency offers Start thread; a finished wait offers to send its steps. */
    action?: StartThreadAction | Extract<ThreadTodoAction, { type: "send_message" }>;
    items?: ThreadTodoItem[];
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
      ...(params.items?.length ? { items: params.items } : {}),
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

  /** The open card a thread holds under `key`, if any. */
  findOpenByKey(params: {
    backend: AppServerBackendKind;
    threadId: string;
    key: string;
  }): ThreadTodo | undefined {
    return this.store.findOpenByKey(params);
  }

  /**
   * Swaps the review or merge offer PwrAgent holds for one pull request, in
   * one commit: withdraws the card it replaces, then raises the new offer.
   * See docs/pr-review-readiness.md.
   *
   * Like a dependency card, each offer has one card for its lifetime:
   * `offerId` is stored as the card's dependency id, so an offer the
   * operator dismissed or ran is not raised again. A card PwrAgent itself
   * withdrew (its result is one of `withdrawnResults`) reopens instead. The
   * open-card cap does not apply: a thread holds at most one offer card per
   * pull request.
   */
  reconcileOffer(params: {
    backend: AppServerBackendKind;
    threadId: string;
    retire?: { id: string; result: string };
    raise?: {
      offerId: string;
      key: string;
      title: string;
      detail?: string;
      action: Extract<ThreadTodoAction, { type: "start_review" | "merge_pull_request" }>;
      cwd?: string;
      sourceProject?: ThreadTodoProject;
      withdrawnResults?: readonly string[];
    };
  }): { retired?: ThreadTodo; raised?: ThreadTodo } {
    const changed = this.store.transaction(() => {
      const result: { retired?: ThreadTodo; raised?: ThreadTodo } = {};
      const retiring = params.retire ? this.store.get(params.retire.id) : undefined;
      // A card whose merge is running finishes on its own.
      if (retiring?.status === "open" && !this.running.has(retiring.id)) {
        result.retired = this.store.setStatus({
          id: retiring.id,
          status: "dismissed",
          now: this.now(),
          result: { result: params.retire!.result },
        });
      }
      // A card whose merge is still running stays the only offer: the next
      // event reconciles again once the run ends.
      const raise = retiring?.status === "open" && !result.retired ? undefined : params.raise;
      const earlier = raise ? this.store.findByDependency(raise.offerId) : undefined;
      if (
        raise
        && earlier?.status === "dismissed"
        && earlier.result !== undefined
        && raise.withdrawnResults?.includes(earlier.result)
        && !this.store.findOpenByKey({ backend: params.backend, threadId: params.threadId, key: raise.key })
      ) {
        this.store.setStatus({ id: earlier.id, status: "open", now: this.now() });
        result.raised = this.store.replaceContent({
          id: earlier.id,
          kind: threadTodoKindForAction(raise.action),
          title: raise.title,
          detail: raise.detail,
          items: earlier.items,
          action: raise.action,
          cwd: raise.cwd,
          sourceProject: raise.sourceProject,
          now: this.now(),
        });
      } else if (raise && !earlier) {
        const keyed = this.store.findOpenByKey({
          backend: params.backend,
          threadId: params.threadId,
          key: raise.key,
        });
        result.raised = this.store.insert({
          id: this.newId(),
          backend: params.backend,
          threadId: params.threadId,
          ...(keyed ? {} : { key: raise.key }),
          kind: threadTodoKindForAction(raise.action),
          title: raise.title,
          detail: raise.detail,
          action: raise.action,
          cwd: raise.cwd,
          sourceProject: raise.sourceProject,
          dependencyId: raise.offerId,
          now: this.now(),
        });
      }
      return result;
    });
    const todo = changed.raised ?? changed.retired;
    if (todo) this.emit(todo);
    return changed;
  }

  /** Announce a card written outside the service's own mutations. */
  publish(todo: ThreadTodo): void {
    this.emit(todo);
  }

  list(request: ListThreadTodosRequest = {}): ThreadTodo[] {
    const todos = this.store.list(request);
    const readCiApprovals = this.readCiApprovals;
    if (!readCiApprovals) return todos;
    return todos.map((todo) => {
      if (todo.status !== "open" || !todo.dependencyId) return todo;
      const ciApprovals = readCiApprovals(todo, todo.dependencyId);
      return ciApprovals.length > 0 ? { ...todo, ciApprovals } : todo;
    });
  }

  /** One open card's deployment gates, as `list` decorates it. */
  private ciApprovalsFor(todo: ThreadTodo): ThreadTodoCiApproval[] {
    return todo.status === "open" && !todo.action && todo.dependencyId && this.readCiApprovals
      ? this.readCiApprovals(todo, todo.dependencyId)
      : [];
  }

  /** The runs open approval cards are waiting on, for the owner's reconciler. */
  ciApprovalUrls(include: (todo: ThreadTodo) => boolean = () => true): string[] {
    return [...new Set(this.list({ status: "open" }).filter(include)
      .flatMap((todo) => (todo.ciApprovals ?? []).map((approval) => approval.url)))];
  }

  /**
   * The operator's Approve on a CI approval card. The request must match
   * the card as stored now, so a card whose milestone changed after the
   * operator saw it is refused before GitHub is asked. A refusal from the
   * reviewer, ours or GitHub's, stays on the card as its error.
   */
  async reviewCiDeployment(request: ReviewThreadTodoCiDeploymentRequest): Promise<ThreadTodo> {
    const todo = this.require(request.id);
    if (todo.status !== "open") throw new ThreadTodoError("conflict", "This to-do is already resolved.");
    const approval = this.ciApprovalsFor(todo).find((entry) => entry.url === request.url);
    if (!approval) throw new ThreadTodoError("invalid_arguments", "This to-do has no deployment gate for that run.");
    const shown = threadTodoCiDeploymentReviewRequest(todo, approval);
    if (!shown) {
      throw new ThreadTodoError("invalid_arguments", "This card cannot approve the gate here. Review it on GitHub.");
    }
    if (!sameCiDeploymentReview(shown, request)) {
      throw new ThreadTodoError("conflict", "This card's deployment gate changed after you saw it. Review it again.");
    }
    if (this.running.has(todo.id)) throw new ThreadTodoError("conflict", "This to-do's action is already running.");
    const reviewer = this.ciDeploymentReviewer;
    if (!reviewer) throw new Error("Deployment reviews are not available on this PwrAgent.");
    this.running.add(todo.id);
    try {
      // The owner's stored gate, not the viewer's copy, is what GitHub is asked to approve.
      const approved = await reviewer(shown);
      return this.finish(todo.id, { result: `Approved ${approved.environments.join(", ")} on GitHub` });
    } catch (error) {
      const failed = this.store.setError({
        id: todo.id,
        error: error instanceof Error ? error.message : String(error),
        now: this.now(),
      });
      this.emit(failed);
      return failed;
    } finally {
      this.running.delete(todo.id);
    }
  }

  /**
   * Resolves each open approval card whose every run GitHub no longer holds
   * at its gates, whoever reviewed them. `settled` names a run's result once
   * the owner has seen it settle; a card with a review running is left to it.
   */
  settleCiApprovals(settled: (approval: ThreadTodoCiApproval) => string | undefined): ThreadTodo[] {
    const resolved: ThreadTodo[] = [];
    for (const todo of this.list({ status: "open" })) {
      const approvals = todo.ciApprovals ?? [];
      if (approvals.length === 0 || this.running.has(todo.id)) continue;
      const results = approvals.map(settled);
      if (results.some((result) => result === undefined)) continue;
      resolved.push(this.finish(todo.id, { result: [...new Set(results)].join("; ") }));
    }
    return resolved;
  }

  /** The operator's last merge-method pick for a project, if any. */
  projectMergeMethod(projectKey: string): ThreadTodoMergeMethod | undefined {
    return this.store.getProjectMergeMethod(projectKey);
  }

  /**
   * Remember a merge-method pick for a project, as a pick from a card's menu
   * is. An agent's merge approval offers the same menu and shares the pick.
   */
  rememberProjectMergeMethod(projectKey: string, method: ThreadTodoMergeMethod): boolean {
    return this.store.setProjectMergeMethod({ directoryKey: projectKey, method, now: this.now() });
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

  /** A scheduled review completes its source card after provider acceptance. */
  resolveStartedReview(params: {
    backend: AppServerBackendKind;
    threadId: string;
    id: string;
    allowOpenItems?: boolean;
  }): void {
    const todo = this.findForThread(params);
    const suppressed = todo.status === "dismissed" && todo.result === PR_OFFER_RETIRE_RESULTS.review_running;
    if ((todo.status !== "open" && !suppressed) || todo.action?.type !== "start_review") return;
    this.resolve({ id: todo.id, status: "done", allowOpenItems: params.allowOpenItems });
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
   * The operator's pick from a start card's Access menu. The pick is stored
   * on the card, so every window shows it and the owner applies it; starting
   * the card still passes the Full Access gate, which judges this stored
   * mode. One commit, and none when the card already says it.
   */
  setAccess(params: {
    id: string;
    executionMode: ThreadExecutionMode;
    nativeAccessMode?: ThreadTodoNativeAccessMode;
  }): ThreadTodo {
    const before = this.requireOpen(params.id);
    if (before.action?.type !== "start_thread") {
      throw new ThreadTodoError("invalid_arguments", "Only a card that starts a thread has access to choose.");
    }
    const sameNative = (action: StartThreadAction) => action.nativeAccessMode?.backend === params.nativeAccessMode?.backend
      && action.nativeAccessMode?.id === params.nativeAccessMode?.id;
    if (before.action.executionMode === params.executionMode && sameNative(before.action)) return before;
    const todo = this.store.transaction(() => {
      const current = this.requireOpen(params.id);
      if (this.running.has(current.id)) {
        throw new ThreadTodoError("conflict", "This to-do's action is running now.");
      }
      if (current.action?.type !== "start_thread") {
        throw new ThreadTodoError("invalid_arguments", "Only a card that starts a thread has access to choose.");
      }
      const { nativeAccessMode: _previous, ...rest } = current.action;
      return this.store.replaceContent({
        id: current.id,
        kind: current.kind,
        title: current.title,
        detail: current.detail,
        items: current.items ?? [],
        action: {
          ...rest,
          executionMode: params.executionMode,
          ...(params.nativeAccessMode ? { nativeAccessMode: { ...params.nativeAccessMode } } : {}),
        },
        targetProject: current.targetProject,
        now: this.now(),
      });
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
    // Only a placement named in this change is checked: a proposal made
    // before the card moved to another project just no longer applies.
    assertPlacementFitsProject(params.action?.placement ?? undefined, targetProject);
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
      startNewThread?: boolean;
      messageTarget?: ThreadTodoMessageTarget;
      modelSettings?: ThreadTodoModelSettings;
      /** A run that succeeds marks the card done, so it asks the same. */
      allowOpenItems?: boolean;
      /** The access the operator saw on a start card. */
      seenExecutionMode?: ThreadTodoSeenExecutionMode;
      /** The agent mode the operator saw picked on a start card. */
      seenNativeAccessMode?: string;
      /** The operator's placement, replacing the card's proposal. */
      placement?: ThreadTodoPlacement;
    } & ThreadTodoStartChoices = {},
  ): Promise<ThreadTodo> {
    const todo = this.require(id);
    if (todo.status !== "open") {
      throw new ThreadTodoError("conflict", "This to-do is already resolved.");
    }
    const startAction = threadTodoStartActionForRun(todo.action, options);
    if (options.startNewThread && !startAction) {
      throw new ThreadTodoError("invalid_arguments", "Choose a handoff and a single destination to start a new thread.");
    }
    const action = startAction ?? todo.action;
    if (!action || action.type === "start_review") {
      throw new ThreadTodoError(
        "invalid_arguments",
        "This to-do has no action that runs here.",
      );
    }
    // The desktop's Full Access gate judged the card the operator saw. An
    // agent can change a card's access at any time, so the start runs only
    // if the stored card still matches it.
    if (
      startAction && threadTodoStartAccessChanged(startAction, options.seenExecutionMode, options.seenNativeAccessMode)
    ) {
      throw new ThreadTodoError(
        "conflict",
        "This card's access changed after you saw it. Review it and start it again.",
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
    const placement = startAction
      ? resolveThreadTodoPlacement({
          ...(options.placement ? { requested: options.placement } : {}),
          ...(startAction.placement ? { proposed: startAction.placement } : {}),
          crossProject,
          otherMachine: startOnInstance !== undefined,
        })
      : undefined;
    // A sub-thread needs its parent here, in the same project. Starting a
    // top-level thread instead would file it where the operator did not ask.
    if (placement?.refused) {
      throw new ThreadTodoError(
        "invalid_arguments",
        `${THREAD_TODO_PLACEMENT_LOCK_MESSAGES[placement.lock ?? "project"]} It cannot be a sub-thread of this thread.`,
      );
    }
    // The card's own title: the action's names the new thread, which shows it.
    const dispatchCard: ThreadTodoDispatchCard = { id: todo.id, title: todo.title };
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
          todo: dispatchCard,
        });
        return this.finish(id, { result: sent.summary });
      }
      if (action.type === "merge_pull_request") {
        const method = settleMergeMethod({
          offered: THREAD_TODO_MERGE_METHODS,
          requested: options.mergeMethod,
          remembered: project ? this.store.getProjectMergeMethod(project.key) : undefined,
          fallback: this.defaultMergeMethod(),
        });
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
          sourceBackend: todo.backend, sourceThreadId: todo.threadId,
          cwd,
          pullRequest: action.pullRequest,
          method,
        });
        return this.finish(id, { result: merged.summary });
      }
      if (action.type === "add_forge_hands_off_rule") {
        if (!runners.addForgeHandsOffRule) throw new Error("Forge Automation is not available here.");
        const added = await runners.addForgeHandsOffRule({
          sourceBackend: todo.backend, sourceThreadId: todo.threadId,
          repository: action.repository,
          ...(action.label ? { label: action.label } : {}),
        });
        return this.finish(id, { result: added.summary });
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
      const started: Awaited<ReturnType<ThreadTodoActionRunners["startThread"]>> & Pick<ThreadTodoInstanceStartedThread, "notice"> = startOnInstance && options.startOnInstanceId
        ? await startOnInstance({
            instanceId: options.startOnInstanceId,
            sourceBackend: todo.backend,
            sourceThreadId: todo.threadId,
            project,
            crossProject,
            action,
            todo: dispatchCard,
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
            project,
            crossProject,
            placement: placement?.placement ?? "sub_thread",
            action,
            todo: dispatchCard,
            modelSettings: options.modelSettings
              ?? (action.backend ? undefined : this.store.getThreadModelSettings(todo.backend, todo.threadId)),
            ...(plan ? { plan } : {}),
            ...choices,
          });
      if (started.dispatchSettings) {
        this.store.rememberDispatch(todo.backend, todo.threadId,
          started.dispatchSettings.settings, started.dispatchSettings.source);
      }
      const { backend, threadId, instanceId, instanceLabel } = started;
      const setupFailure = started.setupFailure?.trim().slice(0, THREAD_TODO_SETUP_FAILURE_MAX_LENGTH);
      const result = [
        started.instanceLabel ? `Started thread on ${started.instanceLabel}` : "Started thread",
        ...(setupFailure ? ["Its environment setup failed"] : []),
        ...(started.notice ? [started.notice] : []),
      ].join(". ");
      return this.finish(id, {
        result,
        startedThread: {
          backend, threadId,
          ...(instanceId ? { instanceId } : {}),
          ...(instanceLabel ? { instanceLabel } : {}),
          ...(setupFailure ? { setupFailure } : {}),
        },
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

/** The operator reviewed exactly this gate: same run, attempt, commit and environments. */
function sameCiDeploymentReview(
  stored: ReviewThreadTodoCiDeploymentRequest,
  request: ReviewThreadTodoCiDeploymentRequest,
): boolean {
  return stored.url === request.url
    && stored.repository.toLowerCase() === String(request.repository).toLowerCase()
    && stored.runId === request.runId
    && stored.attempt === request.attempt
    && stored.headSha.toLowerCase() === String(request.headSha).toLowerCase()
    && Array.isArray(request.environments) && Array.isArray(request.environmentIds)
    && stored.environments.length === request.environments.length
    && stored.environments.every((name, index) => name === request.environments[index]
      && stored.environmentIds[index] === request.environmentIds[index]);
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
  if (action?.type === "add_forge_hands_off_rule") {
    if (fields.length > 0) {
      throw new ThreadTodoError(
        "invalid_arguments",
        "A hands-off rule card cannot be edited. Raise it again with the same key to change the rule.",
      );
    }
    return action;
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
    // The operator's agent-mode pick carried the card's old level. An agent
    // that names another access replaces it, and cannot keep a raised pick.
    if (patch.executionMode !== undefined) delete next.nativeAccessMode;
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

/** add_todo and update_todo refuse a sub-thread proposed for another project. */
function assertPlacementFitsProject(
  placement: ThreadTodoPlacement | undefined,
  targetProject: ThreadTodoProject | undefined,
): void {
  if (placement === "sub_thread" && targetProject) {
    throw new ThreadTodoError(
      "invalid_arguments",
      `Work for ${targetProject.label} always starts as a top-level thread there, so placement cannot be sub_thread.`,
    );
  }
}
