import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  AppServerThreadReviewEntry,
  CreateInstanceThreadResult,
  ListInstanceProjectsResult,
  PwrAgentFederationContext,
  RaiseThreadTodoPlanRequest,
  ThreadReviewIdentity,
  ThreadTodo,
  ThreadTodoMergeMethod,
  ThreadTodoProject,
  ThreadTodoFeedDelta,
  ThreadTodosChangedEvent,
} from "@pwragent/shared";
import {
  DEFAULT_THREAD_TODO_MERGE_METHOD, NAVIGATION_QUERY_MAX_PAGE_ROWS, resolveThreadTodoModelSettings, threadReviewTodo,
} from "@pwragent/shared";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools.js";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getMainLogger } from "../log.js";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher.js";
import { getAppStateDb } from "../state/app-state.js";
import {
  findPeerThreadTodoProject,
  threadTodoProjectIdentity,
  matchThreadTodoProject,
  threadTodoProjectChoices,
  threadTodoProjectForDirectory,
  type ThreadTodoProjectCandidate,
} from "./thread-todo-projects.js";
import { resolveThreadTodoModel } from "./thread-todo-models.js";
import {
  resolveThreadTodoStartEnvironment,
  resolveThreadTodoStartSpeed,
  threadTodoSpeedNeedsDestination,
} from "./thread-todo-dispatch.js";
import {
  ThreadTodoError,
  ThreadTodoService,
  type AddThreadTodoInput,
  type ThreadTodoActionPatch,
  type ThreadTodoActionRunners,
} from "./thread-todo-service.js";
import { ThreadTodoStore } from "./thread-todo-store.js";
import { withThreadTodoPlanNote, type ThreadTodoPlan } from "./thread-todo-plan.js";
import { ThreadTodoFeed, type ThreadTodoFeedOwner } from "./thread-todo-feed.js";
import {
  getThreadReviewService,
  setThreadReviewBroadcast,
  resetThreadReviewServiceForTests,
} from "../thread-reviews/thread-review-runtime";
import { completedThreadReview, reportedThreadReviewOutcomes } from "../thread-reviews/thread-review-events";
import { ThreadReviewError } from "../thread-reviews/thread-review-service";

const threadTodoLog = getMainLogger("pwragent:thread-todos");

let service: ThreadTodoService | null = null;
let feed: ThreadTodoFeed | null = null;
let unsubscribeArchive: (() => void) | undefined;
let readDefaultMergeMethod: (() => ThreadTodoMergeMethod) | undefined;
let listProjectCandidates: (() => Promise<ThreadTodoProjectCandidate[]>) | undefined;

export function getThreadTodoService(): ThreadTodoService {
  if (!service) {
    service = new ThreadTodoService({
      store: new ThreadTodoStore(getAppStateDb()),
      defaultMergeMethod: () =>
        readDefaultMergeMethod?.() ?? DEFAULT_THREAD_TODO_MERGE_METHOD,
    });
  }
  return service;
}

/** This owner's live open cards. Installed with the runtime. */
export function getThreadTodoFeed(): ThreadTodoFeed {
  if (!feed) throw new Error("To-dos are not available yet.");
  return feed;
}

export function resetThreadTodoServiceForTests(): void {
  feed = null;
  unsubscribeArchive?.();
  unsubscribeArchive = undefined;
  readDefaultMergeMethod = undefined;
  listProjectCandidates = undefined;
  service = null;
  resetThreadReviewServiceForTests();
}

/**
 * The projects a card's project menu offers. Empty before install. A failed
 * listing rejects, so the menu says so instead of showing no projects.
 */
export async function listThreadTodoProjects(): Promise<ThreadTodoProject[]> {
  return threadTodoProjectChoices(await (listProjectCandidates?.() ?? []));
}

/** The local Directories rows a card's project can match. Empty before install. */
export async function listThreadTodoProjectCandidates(): Promise<ThreadTodoProjectCandidate[]> {
  return await (listProjectCandidates?.() ?? []);
}

/**
 * The operator's pick from a card's project menu. A key the sidebar no
 * longer lists is refused rather than kept as a stale label.
 */
export async function setThreadTodoProject(
  params: { id: string; projectKey: string | null },
  deps: {
    todos?: Pick<ThreadTodoService, "update">;
    listProjects?: () => Promise<ThreadTodoProject[]>;
  } = {},
): Promise<ThreadTodo> {
  const todos = deps.todos ?? getThreadTodoService();
  if (params.projectKey === null) {
    return todos.update({ id: params.id, targetProject: null });
  }
  const project = (await (deps.listProjects ?? listThreadTodoProjects)())
    .find((candidate) => candidate.key === params.projectKey);
  if (!project) {
    throw new ThreadTodoError("not_found", "That project is no longer in the sidebar.");
  }
  return todos.update({ id: params.id, targetProject: project });
}

/**
 * Where a card raised on this thread runs its Start thread, and the project
 * it files under, the way add_todo resolves them. Best effort: a missing
 * workspace or project leaves the card on the thread alone.
 */
export async function readThreadTodoPlacement(
  registry: Pick<DesktopBackendRegistry, "resolveThreadWorkspaceCwd" | "resolveThreadPrimaryDirectory">,
  thread: { backend: AppServerBackendKind; threadId: string },
): Promise<{ cwd?: string; sourceProject?: ThreadTodoProject }> {
  const [cwd, primaryDirectory, projects] = await Promise.all([
    registry.resolveThreadWorkspaceCwd(thread.backend, thread.threadId)
      .catch(() => undefined),
    registry.resolveThreadPrimaryDirectory(thread.backend, thread.threadId)
      .catch(() => undefined),
    (listProjectCandidates?.() ?? Promise.resolve([]))
      .catch((): ThreadTodoProjectCandidate[] => []),
  ]);
  const sourceProject = threadTodoProjectForDirectory(primaryDirectory, projects);
  return {
    ...(cwd ? { cwd } : {}),
    ...(sourceProject ? { sourceProject } : {}),
  };
}

/**
 * Raises a started thread's plan card on this owner, filed where add_todo
 * would file a card the thread raised itself.
 */
export async function raiseThreadTodoPlan(
  registry: Pick<DesktopBackendRegistry, "resolveThreadWorkspaceCwd" | "resolveThreadPrimaryDirectory">,
  thread: { backend: AppServerBackendKind; threadId: string },
  plan: ThreadTodoPlan,
  todos: Pick<ThreadTodoService, "raisePlan"> = getThreadTodoService(),
): Promise<ThreadTodo> {
  const placement = await readThreadTodoPlacement(registry, thread);
  return todos.raisePlan({ ...thread, ...placement, plan });
}

/** A peer's plan cards, through `threadTodos.raisePlan`. */
export type ThreadTodoPeerPlans = {
  /** The peer advertises `thread_todo_plan`. */
  supports: (instanceId: string) => boolean;
  raise: (instanceId: string, request: RaiseThreadTodoPlanRequest) => Promise<unknown>;
};

/**
 * Connects the service to the registry: the agent tools raise cards through
 * it, and its main-process actions run through the registry, gh, and the
 * federation tools for a peer.
 */
export function installThreadTodoRuntime(params: {
  registry: DesktopBackendRegistry;
  broadcast: (event: ThreadTodosChangedEvent) => void;
  /** The local Directories lens rows, for naming and filing projects. */
  listProjects: () => Promise<ThreadTodoProjectCandidate[]>;
  /** `[git] default_merge_method`. */
  readDefaultMergeMethod: () => ThreadTodoMergeMethod;
  /** The federation agent tools, which start threads on peers. */
  federation?: PwrAgentFederationHandler;
  /** The same tools sending one message origin, for a card's peer start. */
  federationWithOrigin?: (messageOrigin: AppServerThreadMessageOrigin) => PwrAgentFederationHandler;
  /** Plan cards for threads started on a peer. */
  peerPlans?: ThreadTodoPeerPlans;
  /** What the live card feed reads besides the services, and where it publishes. */
  feed: {
    loadOwners: () => Promise<readonly ThreadTodoFeedOwner[]>;
    managedThreadKeys: () => ReadonlySet<string>;
    onDelta: (delta: ThreadTodoFeedDelta) => void;
  };
}): void {
  const { registry, listProjects, federation } = params;
  const todos = getThreadTodoService();
  const reviews = getThreadReviewService();
  feed = new ThreadTodoFeed({
    readOpenCards: (scope) => [
      ...todos.list({ ...scope, status: "open" }),
      ...reviews.list({ ...scope, status: "open" }).map(threadReviewTodo),
    ],
    loadOwners: params.feed.loadOwners,
    managedThreadKeys: params.feed.managedThreadKeys,
    withDispatchDefaults: (cards) => todos.withDispatchDefaults(cards),
    mergeMethods: () => todos.mergeMethodPreferences(),
  }, params.feed.onDelta);
  const liveFeed = feed;
  // Markers stay for viewers that predate the feed and for review details.
  const changed = (event: ThreadTodosChangedEvent): void => {
    params.broadcast(event);
    liveFeed.cardsChanged(event.backend === undefined ? undefined
      : { backend: event.backend, threadId: event.threadId });
  };
  setThreadReviewBroadcast(changed);
  // Tracking a review is a side effect of reading or finishing a new one. A review
  // that cannot be recorded must not fail the thread read or the event.
  const importReview = (
    identity: ThreadReviewIdentity,
    entry: AppServerThreadReviewEntry,
    source: "live" | "replay" = "replay",
  ): void => {
    try {
      reviews.importEntry(identity, entry, source);
    } catch (error) {
      threadTodoLog.warn("could not track a completed review", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  readDefaultMergeMethod = params.readDefaultMergeMethod;
  todos.setOnChanged(changed);
  todos.setRunners(createThreadTodoRunners({
    registry,
    federation,
    ...(params.federationWithOrigin ? { federationWithOrigin: params.federationWithOrigin } : {}),
    listProjects,
    plans: {
      raiseHere: (thread, plan) => raiseThreadTodoPlan(registry, thread, plan, todos),
      ...(params.peerPlans ? { peer: params.peerPlans } : {}),
    },
  }));
  todos.setDispatchSettingsReader(async (thread) => {
    const settings = await registry.readThreadHandoffSettings(thread);
    const threadSpeed = {
      ...optional("serviceTier", settings.serviceTier),
      ...optional("fastMode", settings.fastMode),
    };
    return {
      thread: { backend: thread.backend, model: settings.model, reasoningEffort: settings.reasoningEffort },
      ...(Object.keys(threadSpeed).length > 0 ? { threadSpeed } : {}),
    };
  });
  // An archived thread's cards have nothing left to act on.
  unsubscribeArchive?.();
  unsubscribeArchive = registry.onEvent((event) => {
    if (event.federationTarget?.scope === "remote") return;
    // Owner membership, titles, PR attachments and dispatch defaults.
    liveFeed.handleBackendEvent(event);
    if (event.notification.method === "navigation/providerThreads/refreshed") {
      // Discovery and authentication recovery can make persisted owners
      // available without changing a card. The inventory spans backends.
      params.broadcast({ at: Date.now() });
      return;
    }
    const completed = completedThreadReview(event);
    if (completed) importReview(completed.identity, completed.entry, "live");
    const reported = reportedThreadReviewOutcomes(event);
    if (reported) {
      try {
        reviews.applyReportedOutcomes(reported.identity, reported.sourceKey, reported.outcomes);
      } catch (error) {
        threadTodoLog.warn("could not record reported review outcomes", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (event.notification.method === "thread/pullRequests/updated"
      || event.notification.method === "thread/unarchived"
      || event.notification.method === "thread/name/updated"
      || event.notification.method === "thread/modelSettings/updated") {
      params.broadcast({ backend: event.backend, threadId: event.notification.params.threadId, at: Date.now() });
    }
    if (event.notification.method !== "thread/archived") return;
    try {
      todos.dismissOpenForThread({
        backend: event.backend,
        threadId: event.notification.params.threadId,
      });
      for (const review of reviews.list({ backend: event.backend, threadId: event.notification.params.threadId }, { includeDetached: true })) {
        reviews.update({ id: review.id, status: "dismissed", note: "Thread archived." }, "system");
      }
    } catch (error) {
      threadTodoLog.warn("could not dismiss an archived thread's to-dos", {
        error: error instanceof Error ? error.message : String(error),
        threadId: event.notification.params.threadId,
      });
    } finally {
      // Ownership and titles are read-time projections too. Refresh even when
      // no tracked row changed (for example, an already archived legacy card).
      params.broadcast({ backend: event.backend, threadId: event.notification.params.threadId, at: Date.now() });
    }
  });
  // A model the catalog does not list would start the handoff on the
  // default model without a word, so a card's model is settled when the
  // card is written. See resolveThreadTodoModel.
  const settleModel = async (
    thread: { backend: AppServerBackendKind; threadId: string },
    requested: { model?: string; reasoningEffort?: string },
  ): Promise<{ model?: string; reasoningEffort?: string }> => {
    if (!requested.model && !requested.reasoningEffort) return {};
    const options = await registry.readBackendModelOptions(thread.backend).catch((error: unknown) => {
      threadTodoLog.warn("could not read models for a to-do", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    // An effort with no model runs on the thread's model, which the
    // handoff inherits; check it there.
    const threadModel = requested.model
      ? undefined
      : (await registry.readThreadHandoffSettings({
        backend: thread.backend,
        threadId: thread.threadId,
      }).catch(() => undefined))?.model;
    const resolved = resolveThreadTodoModel(options, requested, threadModel);
    if (!resolved.ok) {
      throw new ThreadTodoError("invalid_arguments", resolved.message);
    }
    return { model: resolved.model, reasoningEffort: resolved.reasoningEffort };
  };
  const listProjectsForTodo = (): Promise<ThreadTodoProjectCandidate[]> =>
    listProjects().catch((error: unknown) => {
      threadTodoLog.warn("could not list projects for a to-do", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [] as ThreadTodoProjectCandidate[];
    });
  listProjectCandidates = listProjects;
  const matchProject = (
    query: string,
    projects: readonly ThreadTodoProjectCandidate[],
  ): ThreadTodoProject => {
    const match = matchThreadTodoProject(query, projects);
    if (!match.ok) {
      throw new ThreadTodoError("invalid_arguments", match.message);
    }
    return match.project;
  };
  const settleAddInput = async (
    thread: { backend: AppServerBackendKind; threadId: string },
    input: AddThreadTodoInput,
  ): Promise<AddThreadTodoInput> => {
    const action = input.action;
    if (action?.type !== "start_thread") return input;
    const { model, reasoningEffort } = await settleModel(thread, action);
    const { model: _model, reasoningEffort: _effort, ...rest } = action;
    return {
      ...input,
      action: {
        ...rest,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    };
  };
  registry.setPwrAgentThreadTodoHandler({
    reviews: {
      record: async (identity, input) => {
        const [cwd, directory, projects] = await Promise.all([
          registry.resolveThreadWorkspaceCwd(identity.backend, identity.threadId).catch(() => undefined),
          registry.resolveThreadPrimaryDirectory(identity.backend, identity.threadId).catch(() => undefined),
          listProjectsForTodo(),
        ]);
        const project = threadTodoProjectForDirectory(directory, projects);
        const workspacePath = cwd ?? project?.path;
        return reviews.record(identity, {
          ...input,
          ...(workspacePath ? { context: {
            workspacePath,
            ...(project ? { projectLabel: project.label, repositoryPath: project.path } : {}),
          } } : {}),
        });
      },
      list: (identity, status) => reviews.list({ ...identity, status }),
      update: (identity, request) => {
        // A deferral names a card this thread raised; the lookup refuses any other.
        let todo: { id: string; title: string } | undefined;
        if (request.todoId) {
          let card: ThreadTodo;
          try {
            card = todos.findForThread({ ...identity, id: request.todoId });
          } catch (error) {
            if (!(error instanceof ThreadTodoError)) throw error;
            throw new ThreadReviewError("not_found", "No to-do card with that todoId belongs to this thread.");
          }
          // A closed card tracks nothing; the finding would leave every queue.
          if (card.status !== "open") {
            throw new ThreadReviewError("conflict", "That to-do card is closed. Defer the finding to an open card.");
          }
          todo = card;
        }
        return reviews.update(request, "agent", identity, todo && { id: todo.id, title: todo.title });
      },
    },
    importReviews: (identity, entries) => {
      for (const entry of entries) importReview(identity, entry);
    },
    update: async (context, target, input) => {
      const current = todos.findForThread({ ...context, ...target });
      let action: ThreadTodoActionPatch | undefined = input.action;
      const touchesModel = action
        && (action.model !== undefined || action.reasoningEffort !== undefined);
      if (action && touchesModel && current.action?.type === "start_thread") {
        // Check the pair the card will hold, not just the changed half: a
        // new model may not offer the effort the card already names.
        const model = action.model === undefined
          ? current.action.model
          : action.model ?? undefined;
        const reasoningEffort = action.reasoningEffort === undefined
          ? current.action.reasoningEffort
          : action.reasoningEffort ?? undefined;
        const settled = await settleModel(current, { model, reasoningEffort });
        action = {
          ...action,
          model: settled.model ?? null,
          reasoningEffort: settled.reasoningEffort ?? null,
        };
      }
      let targetProject: ThreadTodoProject | null | undefined;
      if (input.project === null) {
        targetProject = null;
      } else if (input.project !== undefined) {
        targetProject = matchProject(input.project, await listProjectsForTodo());
      }
      return todos.update({
        id: current.id,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.items !== undefined ? { items: input.items } : {}),
        ...(input.prerequisites !== undefined ? { prerequisites: input.prerequisites } : {}),
        ...(input.check ? { check: input.check } : {}),
        ...(input.uncheck ? { uncheck: input.uncheck } : {}),
        ...(targetProject !== undefined ? { targetProject } : {}),
        ...(action ? { action } : {}),
      });
    },
    add: async (context, rawInput) => {
      const input = await settleAddInput(context, rawInput);
      const [cwd, primaryDirectory, projects] = await Promise.all([
        registry.resolveThreadWorkspaceCwd(context.backend, context.threadId)
          .catch(() => undefined),
        registry.resolveThreadPrimaryDirectory(context.backend, context.threadId)
          .catch(() => undefined),
        listProjectsForTodo(),
      ]);
      const targetProject = input.project
        ? matchProject(input.project, projects)
        : undefined;
      return todos.add({
        ...context,
        cwd,
        sourceProject: threadTodoProjectForDirectory(primaryDirectory, projects),
        targetProject,
        input,
      });
    },
    list: (context, status) => todos.list({ ...context, status }),
    resolve: (context, target) =>
      todos.resolveFromThread({ ...context, ...target }),
  });
}

/** The registry calls a to-do's Start thread makes. */
export type ThreadTodoRunnerRegistry = Pick<
  DesktopBackendRegistry,
  | "readThreadHandoffSettings" | "readBackendModelOptions" | "listBackends" | "renameThread" | "startThread" | "startTurn"
  | "sendThreadTodoMessage" | "buildThreadTodoMessageOrigin"
>;

/**
 * The main-process actions behind a card's buttons: merging through gh, and
 * starting a thread here or, through the federation tools, on a peer.
 *
 * A started thread is a handoff, so whatever the card leaves unnamed comes
 * from the thread that raised it, as handoff_task does it: its access mode,
 * model, reasoning effort, and speed. Left to startThread, a card with no
 * model ran on the catalog's default model and in Default Access, whatever
 * the raising thread used.
 */
export function createThreadTodoRunners(params: {
  registry: ThreadTodoRunnerRegistry;
  federation?: PwrAgentFederationHandler;
  /**
   * The federation tools with one message origin: a peer start then labels
   * its prompt as the card's. Without it the start carries the default origin.
   */
  federationWithOrigin?: (messageOrigin: AppServerThreadMessageOrigin) => PwrAgentFederationHandler;
  /**
   * This machine's Directories rows, whose origins find a card's project on
   * a peer that files it under another name.
   */
  listProjects?: () => Promise<ThreadTodoProjectCandidate[]>;
  /**
   * Where a card's steps become the started thread's own `plan` card. A
   * start without them, or whose raise fails, sends the prompt alone.
   */
  plans?: {
    raiseHere: (thread: { backend: AppServerBackendKind; threadId: string }, plan: ThreadTodoPlan) => Promise<unknown>;
    peer?: ThreadTodoPeerPlans;
  };
}): ThreadTodoActionRunners {
  const { registry, federation, plans } = params;
  // A failed plan card leaves the start as it was before plan cards: the
  // prompt alone, which add_todo asks to carry the steps too.
  const raisePlan = async (
    raise: () => Promise<unknown>,
    thread: { threadId: string; instanceId?: string },
  ): Promise<boolean> => {
    try {
      await raise();
      return true;
    } catch (error) {
      threadTodoLog.warn("could not raise the started thread's plan card", {
        error: error instanceof Error ? error.message : String(error),
        threadId: thread.threadId,
        ...(thread.instanceId ? { instanceId: thread.instanceId } : {}),
      });
      return false;
    }
  };
  // Without them the peer is matched by name, as before.
  const listLocalProjects = async (): Promise<ThreadTodoProjectCandidate[]> =>
    await Promise.resolve().then(() => params.listProjects?.() ?? []).catch((error: unknown) => {
      threadTodoLog.warn("could not list projects to match a peer's copy", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
  return {
    sendMessage: async (request) => {
      await registry.sendThreadTodoMessage(request);
      return { summary: `Sent to ${request.target.title ?? request.target.threadId}` };
    },
    mergePullRequest: async (request) =>
      await new GithubPrFetcher().mergePullRequest(request),
    startThread: async ({
      sourceBackend, sourceThreadId, cwd, crossProject, action, todo, modelSettings, workMode: chosenWorkMode, environment, speed, plan,
    }) => {
      const source = await registry.readThreadHandoffSettings({
        backend: sourceBackend,
        threadId: sourceThreadId,
      });
      const sourceSettings = {
        backend: sourceBackend, model: source.model, reasoningEffort: source.reasoningEffort,
      };
      const selected = resolveThreadTodoModelSettings({ thread: sourceSettings, action, pick: modelSettings }).settings;
      const catalog = await registry.readBackendModelOptions(selected.backend);
      const validated = resolveThreadTodoModel(catalog, selected);
      if (!validated.ok) throw new ThreadTodoError("invalid_arguments", validated.message);
      const chosen = { backend: selected.backend, model: validated.model, reasoningEffort: validated.reasoningEffort };
      const sameBackend = chosen.backend === sourceBackend;
      let executionMode = action.executionMode ?? source.executionMode;
      const inheritedSpeed = sameBackend ? source : undefined;
      const destination = (!sameBackend && action.executionMode === undefined)
        || threadTodoSpeedNeedsDestination(speed, inheritedSpeed)
        ? (await registry.listBackends({ includeUnavailable: true })).backends
          .find((backend) => backend.kind === chosen.backend)
        : undefined;
      if (!sameBackend && action.executionMode === undefined) {
        if (destination && !destination.executionModes.some((mode) => mode.mode === executionMode && mode.available)) {
          // An inherited mode must never raise access to make a provider fit.
          if (!destination.executionModes.some((mode) => mode.mode === "default" && mode.available)) {
            throw new ThreadTodoError("invalid_arguments", `${destination.label} cannot use the inherited access mode or Default Access.`);
          }
          executionMode = "default";
        }
      }
      const speedSettings = resolveThreadTodoStartSpeed({
        ...(destination ? { destination } : {}),
        ...(catalog ? { catalog } : {}),
        ...optional("model", chosen.model ?? catalog?.models?.find((entry) => entry.current)?.id),
        ...optional("requested", speed),
        ...optional("inherited", inheritedSpeed),
      });
      const workMode = chosenWorkMode ?? action.workMode;
      const codexEnvironment = await resolveThreadTodoStartEnvironment({
        requested: environment,
        cwd,
        source: crossProject ? undefined : source.codexEnvironmentRuntime,
      });
      const settings = {
        executionMode,
        ...optional("model", chosen.model),
        ...optional("reasoningEffort", chosen.reasoningEffort),
        ...speedSettings,
      };
      const started = await registry.startThread({
        backend: chosen.backend,
        ...(cwd ? { cwd } : {}),
        ...settings,
        // startThread prepares an environment only for a named work mode.
        ...(workMode || codexEnvironment ? { workMode: workMode ?? "local" } : {}),
        ...(codexEnvironment
          ? {
              codexEnvironmentRuntime: codexEnvironment.runtime,
              ...(codexEnvironment.rerunSetup ? { rerunCodexEnvironmentSetup: true } : {}),
            }
          : {}),
        // The cwd is the raising thread's checkout. Its branch carries that
        // thread's unpublished work, so a card's new worktree starts from
        // the default branch instead.
        // A card that says New worktree must not fall back to sharing the
        // raising thread's checkout.
        ...(workMode === "worktree"
          ? { worktreeBase: "default_branch" as const, requiredWorkMode: "worktree" as const }
          : {}),
        // Work for another project is not grouped under this thread, as
        // handoff_task does not group it.
        ...(crossProject
          ? {}
          : {
              parentThreadId: sourceThreadId,
              parentThreadBackend: sourceBackend,
            }),
      });
      if (action.title) {
        try {
          await registry.renameThread({
            backend: started.backend,
            threadId: started.threadId,
            name: action.title,
          });
        } catch (error) {
          // The first turn still names the thread; a missing title is cosmetic.
          threadTodoLog.warn("could not name the handoff thread", {
            error: error instanceof Error ? error.message : String(error),
            threadId: started.threadId,
          });
        }
      }
      // Raised before the first turn, so the thread's first list_todos
      // finds it, and the prompt names it only once it exists.
      const planned = plan && plans
        ? await raisePlan(() => plans.raiseHere({ backend: started.backend, threadId: started.threadId }, plan), started)
        : false;
      // The operator sent the card's prompt, so the thread shows where it came from.
      const messageOrigin = await registry.buildThreadTodoMessageOrigin({
        backend: sourceBackend,
        threadId: sourceThreadId,
        todo,
      });
      await registry.startTurn({
        backend: started.backend,
        threadId: started.threadId,
        input: [{ type: "text", text: planned ? withThreadTodoPlanNote(action.prompt) : action.prompt }],
        messageOrigin,
        ...settings,
      });
      return {
        backend: started.backend, threadId: started.threadId,
        dispatchSettings: { settings: chosen, source: sourceSettings },
      };
    },
    ...(federation
      ? {
          startThreadOnInstance: async ({
            instanceId,
            sourceBackend,
            sourceThreadId,
            project,
            crossProject,
            action,
            todo,
            modelSettings,
            workMode,
            environment,
            speed,
            plan,
          }) => {
            if (!project) {
              throw new Error("This to-do has no project to find on the other PwrAgent.");
            }
            // The access mode carries over. The model goes only when the
            // operator picked it for this peer: the card's own was checked
            // against this machine's catalog, not the peer's.
            if (speed === "ultrafast") {
              throw new ThreadTodoError("invalid_arguments", "Ultrafast cannot be requested on another PwrAgent. Choose Standard or Fast.");
            }
            const source = await registry.readThreadHandoffSettings({
              backend: sourceBackend,
              threadId: sourceThreadId,
            });
            const context: PwrAgentFederationContext = {
              backend: sourceBackend,
              threadId: sourceThreadId,
            };
            // Match against the complete list, including label matches that
            // take precedence over a folder-name fallback on an earlier page.
            // Read alongside the peer's pages: this machine's row names the
            // repository the card's project clones.
            const localProjects = listLocalProjects();
            const candidates: ListInstanceProjectsResult["projects"] = [];
            const cursors = new Set<string>();
            let cursor: string | undefined;
            let projects: ListInstanceProjectsResult;
            do {
              const listed = await federation({
                operation: "list_instance_projects",
                context,
                args: { instanceId, limit: NAVIGATION_QUERY_MAX_PAGE_ROWS, ...(cursor ? { cursor } : {}) },
              });
              if (!listed.ok) throw new Error(listed.error.message);
              projects = listed.data as ListInstanceProjectsResult;
              if (typeof projects.complete !== "boolean" || projects.complete === Boolean(projects.nextCursor)) {
                throw new Error("The peer project listing is not complete and cannot be continued.");
              }
              candidates.push(...projects.projects);
              if (projects.complete) break;
              cursor = projects.nextCursor!;
              if (cursors.has(cursor)) throw new Error("The peer project listing cursor did not advance.");
              cursors.add(cursor);
            } while (cursor);
            // The peer may file the same checkout under another name, so
            // match by the repository this machine's row says it clones.
            const identity = threadTodoProjectIdentity(project, await localProjects);
            const counterpart = findPeerThreadTodoProject(identity, candidates);
            if (!counterpart) {
              const repository = identity.repositoryKey ?? identity.repositoryKeys?.[0];
              throw new Error(repository
                ? `${projects.instanceLabel} has no checkout of ${repository} (${project.label} here).`
                : `${projects.instanceLabel} has no project named ${project.label}.`);
            }
            // create_instance_thread's signed shape carries no steps, so a
            // peer that answers threadTodos.raisePlan gets them right after
            // the start; the thread's first tool call comes seconds later.
            // An older peer gets the prompt alone.
            const peerPlans = plans?.peer;
            const plannable = plan !== undefined && peerPlans?.supports(instanceId) === true;
            const messageOrigin = await registry.buildThreadTodoMessageOrigin({
              backend: sourceBackend,
              threadId: sourceThreadId,
              todo,
            });
            const createThread = params.federationWithOrigin?.(messageOrigin) ?? federation;
            // No title: create_instance_thread has none to set, and the
            // peer names the thread from its first turn.
            const created = await createThread({
              operation: "create_instance_thread",
              context,
              args: {
                instanceId,
                projectKey: counterpart.key,
                input: plannable ? withThreadTodoPlanNote(action.prompt) : action.prompt,
                executionMode: action.executionMode ?? source.executionMode,
                ...(modelSettings
                  ? {
                      backend: modelSettings.backend,
                      ...optional("model", modelSettings.model),
                      ...optional("reasoningEffort", modelSettings.reasoningEffort),
                    }
                  : {}),
                ...(speed ? { fastMode: speed === "fast" } : {}),
                ...((workMode ?? action.workMode) ? { workMode: workMode ?? action.workMode } : {}),
                // As on this machine, the peer's checkout can sit on a branch
                // with another thread's unpublished work.
                ...((workMode ?? action.workMode) === "worktree"
                  ? { worktreeBase: "default_branch" as const }
                  : {}),
                ...(environment ? { environment } : {}),
                groupingMode: crossProject ? "none" : "subthread",
              },
            });
            if (!created.ok) throw new Error(created.error.message);
            const thread = created.data as CreateInstanceThreadResult;
            if (plannable && plan && plans && peerPlans) {
              // The instance picked can be this one, which raises its own.
              const started = { backend: thread.backend, threadId: thread.threadId };
              await raisePlan(() => thread.isLocal
                ? plans.raiseHere(started, plan)
                : peerPlans.raise(thread.instanceId, { ...started, title: plan.title, items: plan.items }),
              { threadId: thread.threadId, instanceId: thread.instanceId });
            }
            return {
              backend: thread.backend,
              threadId: thread.threadId,
              ...(thread.isLocal
                ? {}
                : { instanceId: thread.instanceId, instanceLabel: thread.instanceLabel }),
            };
          },
        }
      : {}),
  };
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
