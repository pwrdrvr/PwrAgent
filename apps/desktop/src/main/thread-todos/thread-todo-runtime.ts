import type {
  AppServerBackendKind,
  CreateInstanceThreadResult,
  ListInstanceProjectsResult,
  PwrAgentFederationContext,
  ThreadTodoMergeMethod,
  ThreadTodoProject,
  ThreadTodosChangedEvent,
} from "@pwragent/shared";
import { DEFAULT_THREAD_TODO_MERGE_METHOD } from "@pwragent/shared";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools.js";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getMainLogger } from "../log.js";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher.js";
import { getAppStateDb } from "../state/app-state.js";
import {
  findPeerThreadTodoProject,
  matchThreadTodoProject,
  threadTodoProjectForDirectory,
  type ThreadTodoProjectCandidate,
} from "./thread-todo-projects.js";
import { resolveThreadTodoModel } from "./thread-todo-models.js";
import {
  ThreadTodoError,
  ThreadTodoService,
  type AddThreadTodoInput,
  type ThreadTodoActionPatch,
} from "./thread-todo-service.js";
import { ThreadTodoStore } from "./thread-todo-store.js";

const threadTodoLog = getMainLogger("pwragent:thread-todos");

let service: ThreadTodoService | null = null;
let unsubscribeArchive: (() => void) | undefined;
let readDefaultMergeMethod: (() => ThreadTodoMergeMethod) | undefined;

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

export function resetThreadTodoServiceForTests(): void {
  unsubscribeArchive?.();
  unsubscribeArchive = undefined;
  readDefaultMergeMethod = undefined;
  service = null;
}

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
}): void {
  const { registry, listProjects, federation } = params;
  const todos = getThreadTodoService();
  readDefaultMergeMethod = params.readDefaultMergeMethod;
  todos.setOnChanged(params.broadcast);
  todos.setRunners({
    mergePullRequest: async (request) =>
      await new GithubPrFetcher().mergePullRequest(request),
    startThread: async ({ sourceBackend, sourceThreadId, cwd, crossProject, action }) => {
      const started = await registry.startThread({
        backend: sourceBackend,
        ...(cwd ? { cwd } : {}),
        ...(action.model ? { model: action.model } : {}),
        ...(action.reasoningEffort
          ? { reasoningEffort: action.reasoningEffort }
          : {}),
        ...(action.executionMode ? { executionMode: action.executionMode } : {}),
        ...(action.workMode ? { workMode: action.workMode } : {}),
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
      await registry.startTurn({
        backend: started.backend,
        threadId: started.threadId,
        input: [{ type: "text", text: action.prompt }],
        ...(action.model ? { model: action.model } : {}),
        ...(action.reasoningEffort
          ? { reasoningEffort: action.reasoningEffort }
          : {}),
      });
      return { backend: started.backend, threadId: started.threadId };
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
          }) => {
            if (!project) {
              throw new Error("This to-do has no project to find on the other PwrAgent.");
            }
            const context: PwrAgentFederationContext = {
              backend: sourceBackend,
              threadId: sourceThreadId,
            };
            const listed = await federation({
              operation: "list_instance_projects",
              context,
              args: { instanceId, limit: 500 },
            });
            if (!listed.ok) throw new Error(listed.error.message);
            const projects = listed.data as ListInstanceProjectsResult;
            const counterpart = findPeerThreadTodoProject(project, projects.projects);
            if (!counterpart) {
              throw new Error(`${projects.instanceLabel} has no project named ${project.label}.`);
            }
            // No title: create_instance_thread has none to set, and the
            // peer names the thread from its first turn.
            const created = await federation({
              operation: "create_instance_thread",
              context,
              args: {
                instanceId,
                projectKey: counterpart.key,
                input: action.prompt,
                ...(action.model ? { model: action.model } : {}),
                ...(action.reasoningEffort
                  ? { reasoningEffort: action.reasoningEffort }
                  : {}),
                ...(action.executionMode
                  ? { executionMode: action.executionMode }
                  : {}),
                ...(action.workMode ? { workMode: action.workMode } : {}),
                groupingMode: crossProject ? "none" : "subthread",
              },
            });
            if (!created.ok) throw new Error(created.error.message);
            const thread = created.data as CreateInstanceThreadResult;
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
  });
  // An archived thread's cards have nothing left to act on.
  unsubscribeArchive?.();
  unsubscribeArchive = registry.onEvent((event) => {
    if (
      event.notification.method !== "thread/archived"
      || event.federationTarget?.scope === "remote"
    ) {
      return;
    }
    try {
      todos.dismissOpenForThread({
        backend: event.backend,
        threadId: event.notification.params.threadId,
      });
    } catch (error) {
      threadTodoLog.warn("could not dismiss an archived thread's to-dos", {
        error: error instanceof Error ? error.message : String(error),
        threadId: event.notification.params.threadId,
      });
    }
  });
  // A model the catalog does not list would start the handoff on the
  // default model without a word, so a card's model is settled when the
  // card is written. See resolveThreadTodoModel.
  const settleModel = async (
    backend: AppServerBackendKind,
    requested: { model?: string; reasoningEffort?: string },
  ): Promise<{ model?: string; reasoningEffort?: string }> => {
    if (!requested.model && !requested.reasoningEffort) return {};
    const options = await registry.readBackendModelOptions(backend).catch((error: unknown) => {
      threadTodoLog.warn("could not read models for a to-do", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    const resolved = resolveThreadTodoModel(options, requested);
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
    backend: AppServerBackendKind,
    input: AddThreadTodoInput,
  ): Promise<AddThreadTodoInput> => {
    const action = input.action;
    if (action?.type !== "start_thread") return input;
    const { model, reasoningEffort } = await settleModel(backend, action);
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
        const settled = await settleModel(current.backend, { model, reasoningEffort });
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
        ...(targetProject !== undefined ? { targetProject } : {}),
        ...(action ? { action } : {}),
      });
    },
    add: async (context, rawInput) => {
      const input = await settleAddInput(context.backend, rawInput);
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
