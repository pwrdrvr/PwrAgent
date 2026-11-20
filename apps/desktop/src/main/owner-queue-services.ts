import { EventEmitter } from "node:events";
import type { OperatorRequestsChangedEvent } from "@pwragent/shared/contracts/operator-requests";
import type { ThreadTodoFeedDelta, ThreadTodosChangedEvent } from "@pwragent/shared/contracts/thread-todos";
import { readLocalNavigationDirectoryIndex } from "./app-server/navigation-directory-index";
import type { DesktopFederationRuntime } from "./federation/federation-runtime";
import {
  createDesktopOperatorRequestService,
  installOperatorRequestService,
} from "./operator-requests/operator-request-runtime";
import {
  listLocalTodoOwnerThreads,
  readManagedTodoThreadKeys,
} from "./thread-todos/thread-todo-operations";
import type { ThreadTodoProjectCandidate } from "./thread-todos/thread-todo-projects";
import { installThreadTodoRuntime } from "./thread-todos/thread-todo-runtime";

export type OwnerQueueEvents = EventEmitter<{
  operatorRequestsChanged: [OperatorRequestsChangedEvent];
  threadTodosChanged: [ThreadTodosChangedEvent];
  threadTodoDelta: [ThreadTodoFeedDelta];
}>;

/** Include the entire Directories index, which can span many pages. */
async function listLocalProjects(): Promise<ThreadTodoProjectCandidate[]> {
  return (await readLocalNavigationDirectoryIndex()).map((directory) => ({
    key: directory.key,
    label: directory.label,
    kind: directory.kind,
    ...(directory.path ? { path: directory.path } : {}),
    ...(directory.repositoryKey ? { repositoryKey: directory.repositoryKey } : {}),
    ...(directory.repositoryKeys?.length ? { repositoryKeys: directory.repositoryKeys } : {}),
    ...(directory.localAvailability ? { localAvailability: directory.localAvailability } : {}),
  }));
}

function isLocalTodoInstance(runtime: DesktopFederationRuntime, instanceId: string): boolean {
  try {
    return instanceId === runtime.localFederationInstanceId();
  } catch {
    // State is not open yet, so the id cannot be read or minted.
    return false;
  }
}

type TodoRuntimeOptions = Pick<Parameters<typeof installThreadTodoRuntime>[0],
  "registry" | "readDefaultMergeMethod" | "federation" | "federationWithOrigin">;

/** Federation and the desktop windows serve the same owner-local queues. */
export function startOwnerQueues(runtime: DesktopFederationRuntime, options: TodoRuntimeOptions) {
  const events: OwnerQueueEvents = new EventEmitter();
  installThreadTodoRuntime({
    ...options,
    broadcast: (event) => {
      runtime.publishThreadTodosChanged(event);
      events.emit("threadTodosChanged", event);
    },
    feed: {
      loadOwners: listLocalTodoOwnerThreads,
      managedThreadKeys: readManagedTodoThreadKeys,
      onDelta: (delta) => {
        runtime.publishThreadTodoDelta(delta);
        events.emit("threadTodoDelta", delta);
      },
    },
    listProjects: listLocalProjects,
    peerPlans: {
      // The instance picker can name this machine, which raises its own.
      supports: (instanceId) => isLocalTodoInstance(runtime, instanceId)
        || runtime.remotePeerSupportsTodoPlan({ scope: "remote", instanceId }),
      raise: (instanceId, request) =>
        runtime.requestThreadTodoOperation({ scope: "remote", instanceId }, "raisePlan", request),
    },
  });
  const operatorRequests = createDesktopOperatorRequestService((event) => {
    runtime.publishOperatorRequestsChanged(event);
    if (event.reason === "questions" && event.backend && event.threadId) {
      runtime.publishOperatorQuestionsChanged({ backend: event.backend, threadId: event.threadId });
    }
    events.emit("operatorRequestsChanged", event);
  });
  installOperatorRequestService(operatorRequests);
  operatorRequests.start();
  return { operatorRequests, events };
}
