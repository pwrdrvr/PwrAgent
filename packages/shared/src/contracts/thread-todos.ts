import type { FederationRemoteTarget } from "./federation";
import { federatedThreadIdentityKey } from "./federation";
import { buildThreadIdentityKey } from "./navigation";

import type {
  AppServerBackendKind,
  ThreadExecutionMode,
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
  "update_todo",
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

/**
 * How the operator lands a PR. The operator picks it when clicking, not the
 * agent: the default comes from Settings, and a pick from the card's menu
 * sticks for that project.
 */
export const THREAD_TODO_MERGE_METHODS = ["squash", "rebase", "merge"] as const;

export type ThreadTodoMergeMethod = (typeof THREAD_TODO_MERGE_METHODS)[number];

export const DEFAULT_THREAD_TODO_MERGE_METHOD: ThreadTodoMergeMethod = "squash";

export function isThreadTodoMergeMethod(
  value: unknown,
): value is ThreadTodoMergeMethod {
  return (
    typeof value === "string"
    && (THREAD_TODO_MERGE_METHODS as readonly string[]).includes(value)
  );
}

export type ThreadTodoAction =
  | { type: "start_review" }
  | {
      type: "merge_pull_request";
      /** A PR number or URL, as `gh pr merge` accepts it. */
      pullRequest: string;
    }
  | {
      type: "start_thread";
      prompt: string;
      title?: string;
      model?: string;
      reasoningEffort?: string;
      /** The new thread's permissions. Absent starts it in Default Access. */
      executionMode?: ThreadExecutionMode;
      workMode?: ThreadTodoWorkMode;
    };

export type ThreadTodoActionType = ThreadTodoAction["type"];

/**
 * A project as the Directories lens files it: `key` is the directory key
 * (`directory:<repo root>`), which worktrees of one repo share. `label` and
 * `path` are captured when the card is raised, so a card still reads right
 * after the project is renamed or removed.
 */
export type ThreadTodoProject = {
  key: string;
  label: string;
  path: string;
};

export type ThreadTodoStartedThread = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** Set when the thread was started on a federation peer. */
  instanceId?: string;
  instanceLabel?: string;
};

export const THREAD_TODO_ACTION_TYPES = [
  "start_review",
  "merge_pull_request",
  "start_thread",
] as const satisfies readonly ThreadTodoActionType[];

/**
 * One step of a multi-step card. The id is minted by the main process, so
 * an agent checks a step by the id it was handed back, never by position.
 */
export type ThreadTodoItem = {
  id: string;
  text: string;
  checked: boolean;
};

export type ThreadTodo = {
  id: string;
  /** A projected tracked review, whose status is owned by review tracking. */
  reviewId?: string;
  /** Present only on a viewer projection; state remains on the owner. */
  federationTarget?: FederationRemoteTarget;
  mergeMethod?: ThreadTodoMergeMethod;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** Current owner title projected when listing cards; never persisted with the card. */
  threadTitle?: string;
  /** Re-adding an open card with the same key updates it in place. */
  key?: string;
  /**
   * Set when a thread dependency raised the card for the operator. One
   * dependency raises at most one card, whatever its status.
   */
  dependencyId?: string;
  kind: ThreadTodoKind;
  status: ThreadTodoStatus;
  title: string;
  detail?: string;
  /**
   * Checkable steps, in the thread's order. A card with an unchecked step
   * is not done: resolving it done takes an explicit `allowOpenItems`.
   */
  items?: ThreadTodoItem[];
  action?: ThreadTodoAction;
  /**
   * The raising thread's workspace when the card was created. Merge and
   * start-thread run from it, so a card keeps working after the thread moves.
   */
  cwd?: string;
  /** The raising thread's project when the card was raised. */
  sourceProject?: ThreadTodoProject;
  /**
   * The project the work is for, when the thread named one other than its
   * own ("build this in PwrSnap"). Merge and start-thread run there.
   */
  targetProject?: ThreadTodoProject;
  /** What the action produced, e.g. "Merged" or the started thread. */
  result?: string;
  startedThread?: ThreadTodoStartedThread;
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
/** Steps one card may hold; a longer plan belongs in more than one card. */
export const THREAD_TODO_MAX_ITEMS = 20;
export const THREAD_TODO_ITEM_TEXT_MAX_LENGTH = 200;

/**
 * Checks an agent's or the operator's step texts: an array of non-empty
 * strings within the limits. Texts are trimmed; order is kept.
 */
export function parseThreadTodoItemTexts(
  value: unknown,
  field = "items",
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: `${field} must be an array of step texts.` };
  }
  if (value.length > THREAD_TODO_MAX_ITEMS) {
    return {
      ok: false,
      message: `${field} may hold at most ${THREAD_TODO_MAX_ITEMS} steps.`,
    };
  }
  const texts: string[] = [];
  for (const [index, entry] of value.entries()) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text) {
      return {
        ok: false,
        message: `${field}[${index}] must be a non-empty string.`,
      };
    }
    if (text.length > THREAD_TODO_ITEM_TEXT_MAX_LENGTH) {
      return {
        ok: false,
        message: `${field}[${index}] must be at most ${THREAD_TODO_ITEM_TEXT_MAX_LENGTH} characters.`,
      };
    }
    texts.push(text);
  }
  return { ok: true, value: texts };
}

/**
 * The card's steps after the thread restates them. A text that matches an
 * existing step keeps that step's id and checked state, so a re-raised card
 * does not undo the operator's ticks; each existing step matches at most
 * once, in order. New texts start unchecked, and steps the thread left out
 * are dropped.
 */
export function mergeThreadTodoItems(
  existing: readonly ThreadTodoItem[] | undefined,
  texts: readonly string[],
  newId: () => string,
): ThreadTodoItem[] {
  const unmatched = [...(existing ?? [])];
  return texts.map((text) => {
    const index = unmatched.findIndex((item) => item.text === text);
    const match = index === -1 ? undefined : unmatched.splice(index, 1)[0];
    return match
      ? { id: match.id, text, checked: match.checked }
      : { id: newId(), text, checked: false };
  });
}

export function threadTodoOpenItems(
  todo: Pick<ThreadTodo, "items">,
): ThreadTodoItem[] {
  return (todo.items ?? []).filter((item) => !item.checked);
}

/** "2 of 4" for a card with steps; undefined for one without. */
export function threadTodoItemProgress(
  todo: Pick<ThreadTodo, "items">,
): { checked: number; total: number } | undefined {
  const total = todo.items?.length ?? 0;
  if (total === 0) return undefined;
  return { checked: total - threadTodoOpenItems(todo).length, total };
}

export type ListThreadTodosRequest = {
  federationTarget?: FederationRemoteTarget;
  status?: ThreadTodoStatus | "all";
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
};

export type ListThreadTodosResponse = {
  errors?: string[];
  todos: ThreadTodo[];
  /** What a merge card's primary button does, so its label can say so. */
  mergeMethods?: ThreadTodoMergeMethodPreferences;
};

export type ThreadTodoMergeMethodPreferences = {
  /** `[git] default_merge_method`. */
  defaultMethod: ThreadTodoMergeMethod;
  /** The operator's last pick from a card's menu, per project key. */
  byProject: Record<string, ThreadTodoMergeMethod>;
};

/** The project a card's actions run in: its target, else where it came from. */
export function threadTodoActionProject(
  todo: Pick<ThreadTodo, "sourceProject" | "targetProject">,
): ThreadTodoProject | undefined {
  return todo.targetProject ?? todo.sourceProject;
}

export function resolveThreadTodoMergeMethod(
  todo: Pick<ThreadTodo, "sourceProject" | "targetProject" | "mergeMethod">,
  preferences: ThreadTodoMergeMethodPreferences | undefined,
): ThreadTodoMergeMethod {
  if (isThreadTodoMergeMethod(todo.mergeMethod)) return todo.mergeMethod;
  const projectKey = threadTodoActionProject(todo)?.key;
  return (projectKey ? preferences?.byProject[projectKey] : undefined)
    ?? preferences?.defaultMethod
    ?? DEFAULT_THREAD_TODO_MERGE_METHOD;
}

export type ResolveThreadTodoRequest = {
  federationTarget?: FederationRemoteTarget;
  id: string;
  /** `open` reopens a done or dismissed card (Undo). */
  status: ThreadTodoStatus;
  /**
   * With `done`, how the work got done when no action ran:
   * `handled_elsewhere` when the operator pasted a handoff prompt into an
   * agent outside PwrAgent, `sent_here` when it went to this thread as a
   * reply. Recorded as the result.
   */
  resolution?: ThreadTodoResolution;
  /**
   * With `done`, complete the card although some of its steps are still
   * unchecked. Without it the main process refuses, naming the open steps.
   */
  allowOpenItems?: boolean;
};

/** The operator ticks or unticks one step. One commit. */
export type SetThreadTodoItemCheckedRequest = {
  federationTarget?: FederationRemoteTarget;
  id: string;
  itemId: string;
  checked: boolean;
};

export type ThreadTodoResolution = "handled_elsewhere" | "sent_here";

export const THREAD_TODO_RESOLUTION_RESULTS: Record<ThreadTodoResolution, string> = {
  handled_elsewhere: "Handled elsewhere",
  sent_here: "Sent to this thread",
};

export function isThreadTodoResolution(value: unknown): value is ThreadTodoResolution {
  return value === "handled_elsewhere" || value === "sent_here";
}

export type RunThreadTodoActionRequest = {
  federationTarget?: FederationRemoteTarget;
  id: string;
  /**
   * Merge cards only. Absent: the project's remembered pick, else the
   * configured default.
   */
  mergeMethod?: ThreadTodoMergeMethod;
  /** Remember `mergeMethod` for the card's project: a pick from the menu. */
  rememberMergeMethod?: boolean;
  /** Handoff cards only: start the thread on this federation peer. */
  startOnInstanceId?: string;
  /**
   * Run although some steps are unchecked. A run that succeeds marks the
   * card done, so it follows the same rule as resolving it.
   */
  allowOpenItems?: boolean;
};

export type ThreadTodoMutationResponse = {
  todo: ThreadTodo;
};

/**
 * The projects a card can be for: the local Directories lens, directories
 * only, as the agent's `project` argument is matched against them.
 */
export type ListThreadTodoProjectsRequest = { federationTarget?: FederationRemoteTarget };

export type ListThreadTodoProjectsResponse = {
  projects: ThreadTodoProject[];
};

/**
 * The operator's pick from a card's project menu. `null`, or the key of the
 * card's own project, returns the card to the thread's project.
 */
export type SetThreadTodoProjectRequest = {
  federationTarget?: FederationRemoteTarget;
  id: string;
  projectKey: string | null;
};

/** An identity-less notification refreshes the whole list after owner discovery. */
export type ThreadTodosChangedEvent = { at: number; federationTarget?: FederationRemoteTarget } & ({
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
} | { backend?: undefined; threadId?: undefined });

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

/** The same owner-qualified key navigation uses for mounted threads. */
export function threadTodoThreadKey(todo: Pick<ThreadTodo, "backend" | "threadId" | "federationTarget">): string {
  return todo.federationTarget
    ? federatedThreadIdentityKey({ backend: todo.backend, threadId: todo.threadId, target: todo.federationTarget })
    : buildThreadIdentityKey(todo.backend, todo.threadId);
}
