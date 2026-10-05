import type { ThreadTodosChangedEvent } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getMainLogger } from "../log.js";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher.js";
import { getAppStateDb } from "../state/app-state.js";
import { ThreadTodoService } from "./thread-todo-service.js";
import { ThreadTodoStore } from "./thread-todo-store.js";

const threadTodoLog = getMainLogger("pwragent:thread-todos");

let service: ThreadTodoService | null = null;
let unsubscribeArchive: (() => void) | undefined;

export function getThreadTodoService(): ThreadTodoService {
  if (!service) {
    service = new ThreadTodoService({
      store: new ThreadTodoStore(getAppStateDb()),
    });
  }
  return service;
}

export function resetThreadTodoServiceForTests(): void {
  unsubscribeArchive?.();
  unsubscribeArchive = undefined;
  service = null;
}

/**
 * Connects the service to the registry: the agent tools raise cards through
 * it, and its two main-process actions run through the registry and gh.
 */
export function installThreadTodoRuntime(params: {
  registry: DesktopBackendRegistry;
  broadcast: (event: ThreadTodosChangedEvent) => void;
}): void {
  const { registry } = params;
  const todos = getThreadTodoService();
  todos.setOnChanged(params.broadcast);
  todos.setRunners({
    mergePullRequest: async (request) =>
      await new GithubPrFetcher().mergePullRequest(request),
    startThread: async ({ sourceBackend, sourceThreadId, cwd, action }) => {
      const started = await registry.startThread({
        backend: sourceBackend,
        ...(cwd ? { cwd } : {}),
        ...(action.model ? { model: action.model } : {}),
        ...(action.reasoningEffort
          ? { reasoningEffort: action.reasoningEffort }
          : {}),
        ...(action.workMode ? { workMode: action.workMode } : {}),
        parentThreadId: sourceThreadId,
        parentThreadBackend: sourceBackend,
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
  registry.setPwrAgentThreadTodoHandler({
    add: async (context, input) => {
      let cwd: string | undefined;
      try {
        cwd = await registry.resolveThreadWorkspaceCwd(
          context.backend,
          context.threadId,
        );
      } catch {
        cwd = undefined;
      }
      return todos.add({ ...context, cwd, input });
    },
    list: (context, status) => todos.list({ ...context, status }),
    resolve: (context, target) =>
      todos.resolveFromThread({ ...context, ...target }),
  });
}
