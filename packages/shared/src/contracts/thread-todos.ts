import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./normalized-app-server";

/**
 * Thread to-dos: small cards a thread raises with a tool call when the next
 * step belongs to the operator — review the work, merge the PR, start a
 * proposed follow-up thread, or just a reminder that should not scroll away
 * with the transcript.
 *
 * The thread only proposes. Every action runs when the operator clicks it,
 * in the main process, with the operator's own gh and backend credentials.
 * A card belongs to the thread that raised it; the tool context supplies
 * the thread, never the arguments.
 */
export const PWRAGENT_THREAD_TODO_OPERATION_NAMES = [
  "add_todo",
  "list_todos",
  "resolve_todo",
] as const;

export type PwrAgentThreadTodoOperationName =
  (typeof PWRAGENT_THREAD_TODO_OPERATION_NAMES)[number];

export const THREAD_TODO_STATUSES = ["open", "done", "dismissed"] as const;

export type ThreadTodoStatus = (typeof THREAD_TODO_STATUSES)[number];

/** Kind follows the action, so the agent cannot label a merge "Done". */
export type ThreadTodoKind = "reminder" | "review" | "merge" | "handoff";

export type ThreadTodoWorkMode = "local" | "worktree";

export type ThreadTodoAction =
  | { type: "start_review" }
  | {
      type: "merge_pull_request";
      /** A PR number or URL, as `gh pr merge` accepts it. */
      pullRequest: string;
      method: "squash";
    }
  | {
      type: "start_thread";
      prompt: string;
      title?: string;
      model?: string;
      reasoningEffort?: string;
      workMode?: ThreadTodoWorkMode;
    };

export type ThreadTodoActionType = ThreadTodoAction["type"];

export const THREAD_TODO_ACTION_TYPES = [
  "start_review",
  "merge_pull_request",
  "start_thread",
] as const satisfies readonly ThreadTodoActionType[];

export type ThreadTodo = {
  id: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** Re-adding an open card with the same key updates it in place. */
  key?: string;
  kind: ThreadTodoKind;
  status: ThreadTodoStatus;
  title: string;
  detail?: string;
  action?: ThreadTodoAction;
  /**
   * The raising thread's workspace when the card was created. Merge and
   * start-thread run from it, so a card keeps working after the thread moves.
   */
  cwd?: string;
  /** What the action produced, e.g. "Merged" or the started thread. */
  result?: string;
  startedThread?: { backend: AppServerBackendKind; threadId: ThreadIdentifier };
  /** The last action failure. The card stays open. */
  error?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
};

/** Open cards one thread may hold at once, so a looping turn cannot flood. */
export const THREAD_TODO_MAX_OPEN_PER_THREAD = 20;
export const THREAD_TODO_TITLE_MAX_LENGTH = 120;
export const THREAD_TODO_DETAIL_MAX_LENGTH = 1_000;
export const THREAD_TODO_PROMPT_MAX_LENGTH = 20_000;

export type ListThreadTodosRequest = {
  status?: ThreadTodoStatus | "all";
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
};

export type ListThreadTodosResponse = {
  todos: ThreadTodo[];
};

export type ResolveThreadTodoRequest = {
  id: string;
  /** `open` reopens a done or dismissed card (Undo). */
  status: ThreadTodoStatus;
};

export type RunThreadTodoActionRequest = {
  id: string;
};

export type ThreadTodoMutationResponse = {
  todo: ThreadTodo;
};

export type ThreadTodosChangedEvent = {
  at: number;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export function threadTodoKindForAction(
  action: ThreadTodoAction | undefined,
): ThreadTodoKind {
  switch (action?.type) {
    case "start_review":
      return "review";
    case "merge_pull_request":
      return "merge";
    case "start_thread":
      return "handoff";
    default:
      return "reminder";
  }
}

export function isThreadTodoStatus(value: unknown): value is ThreadTodoStatus {
  return (
    typeof value === "string"
    && (THREAD_TODO_STATUSES as readonly string[]).includes(value)
  );
}
