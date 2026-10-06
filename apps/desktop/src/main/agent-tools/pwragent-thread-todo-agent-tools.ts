import type {
  AppServerBackendKind,
  PwrAgentThreadTodoOperationName,
  ThreadExecutionMode,
  ThreadTodo,
  ThreadTodoAction,
  ThreadTodoStatus,
} from "@pwragent/shared";
import {
  PWRAGENT_THREAD_TODO_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
  THREAD_TODO_DETAIL_MAX_LENGTH,
  THREAD_TODO_PROMPT_MAX_LENGTH,
  THREAD_TODO_TITLE_MAX_LENGTH,
} from "@pwragent/shared";
import type {
  AgentToolCallContext,
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import { agentToolFailure, agentToolSuccess } from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";
import type {
  AddThreadTodoInput,
  ThreadTodoActionPatch,
  UpdateThreadTodoInput,
} from "../thread-todos/thread-todo-service.js";
import { ThreadTodoError } from "../thread-todos/thread-todo-service.js";

export const PWRAGENT_THREAD_TODO_UNAVAILABLE_MESSAGE =
  "PwrAgent to-do tools are not available.";

const KEY_MAX_LENGTH = 80;
const PROJECT_MAX_LENGTH = 1_000;
const MODEL_SETTING_MAX_LENGTH = 200;
const EXECUTION_MODES = ["default", "auto", "full-access"] as const satisfies
  readonly ThreadExecutionMode[];
const WORK_MODES = ["local", "worktree"] as const;

type ThreadTodoToolContext = {
  backend: AppServerBackendKind;
  threadId: string;
};

/**
 * The calling thread comes from the tool call context, never from the
 * arguments, so a thread can only raise and resolve its own cards.
 */
export type PwrAgentThreadTodoHandler = {
  add: (
    context: ThreadTodoToolContext,
    input: AddThreadTodoInput,
  ) => Promise<{ todo: ThreadTodo; created: boolean }>;
  update: (
    context: ThreadTodoToolContext,
    target: { id?: string; key?: string },
    input: UpdateThreadTodoInput,
  ) => Promise<ThreadTodo>;
  list: (
    context: ThreadTodoToolContext,
    status: ThreadTodoStatus | "all",
  ) => ThreadTodo[] | Promise<ThreadTodo[]>;
  resolve: (
    context: ThreadTodoToolContext,
    target: { id?: string; key?: string; status: Exclude<ThreadTodoStatus, "open"> },
  ) => ThreadTodo | Promise<ThreadTodo>;
};

export function buildPwrAgentThreadTodoToolRouter(
  handler: PwrAgentThreadTodoHandler | undefined,
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentThreadTodoToolDefinitions(handler), {
    unsupportedMessage: "Unsupported PwrAgent to-do tool.",
  });
}

export function isPwrAgentThreadTodoToolName(
  tool: string,
): tool is PwrAgentThreadTodoOperationName {
  return (PWRAGENT_THREAD_TODO_OPERATION_NAMES as readonly string[]).includes(tool);
}

export function buildPwrAgentThreadTodoToolDefinitions(
  handler: PwrAgentThreadTodoHandler | undefined,
): AgentToolDefinition<PwrAgentThreadTodoOperationName>[] {
  return PWRAGENT_THREAD_TODO_OPERATION_NAMES.map((operation) => ({
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_THREAD_TODO_UNAVAILABLE_MESSAGE,
        });
      }
      try {
        return await dispatchOperation(operation, args, context, handler);
      } catch (error) {
        if (error instanceof ThreadTodoError) {
          return agentToolFailure({ code: error.code, message: error.message });
        }
        return agentToolFailure({
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }));
}

async function dispatchOperation(
  operation: PwrAgentThreadTodoOperationName,
  args: Record<string, unknown>,
  callContext: AgentToolCallContext,
  handler: PwrAgentThreadTodoHandler,
): Promise<AgentToolDispatchResult> {
  const context = {
    backend: callContext.backend,
    threadId: callContext.threadId,
  };
  switch (operation) {
    case "add_todo": {
      const parsed = normalizeAddTodoArgs(args);
      if (!parsed.ok) {
        return agentToolFailure({ code: "invalid_arguments", message: parsed.message });
      }
      const { todo, created } = await handler.add(context, parsed.value);
      return agentToolSuccess({ created, todo: summarizeTodo(todo) });
    }
    case "update_todo": {
      const parsed = normalizeUpdateTodoArgs(args);
      if (!parsed.ok) {
        return agentToolFailure({ code: "invalid_arguments", message: parsed.message });
      }
      const todo = await handler.update(context, parsed.target, parsed.value);
      return agentToolSuccess({ todo: summarizeTodo(todo) });
    }
    case "list_todos": {
      const status = args.status === undefined ? "open" : args.status;
      if (
        status !== "open"
        && status !== "done"
        && status !== "dismissed"
        && status !== "all"
      ) {
        return agentToolFailure({
          code: "invalid_arguments",
          message: "list_todos status must be open, done, dismissed or all.",
        });
      }
      const todos = await handler.list(context, status);
      return agentToolSuccess({ todos: todos.map(summarizeTodo) });
    }
    case "resolve_todo": {
      const id = optionalString(args.id);
      const key = optionalString(args.key);
      const status = args.status === undefined ? "done" : args.status;
      if (!id && !key) {
        return agentToolFailure({
          code: "invalid_arguments",
          message: "resolve_todo requires id or key.",
        });
      }
      if (status !== "done" && status !== "dismissed") {
        return agentToolFailure({
          code: "invalid_arguments",
          message: "resolve_todo status must be done or dismissed.",
        });
      }
      const todo = await handler.resolve(context, {
        ...(id ? { id } : {}),
        ...(key ? { key } : {}),
        status,
      });
      return agentToolSuccess({ todo: summarizeTodo(todo) });
    }
  }
}

export function normalizeAddTodoArgs(
  args: Record<string, unknown>,
): { ok: true; value: AddThreadTodoInput } | { ok: false; message: string } {
  const title = optionalString(args.title);
  if (!title) {
    return { ok: false, message: "add_todo requires a non-empty title." };
  }
  if (title.length > THREAD_TODO_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      message: `add_todo title must be at most ${THREAD_TODO_TITLE_MAX_LENGTH} characters.`,
    };
  }
  const detail = optionalString(args.detail);
  if (detail && detail.length > THREAD_TODO_DETAIL_MAX_LENGTH) {
    return {
      ok: false,
      message: `add_todo detail must be at most ${THREAD_TODO_DETAIL_MAX_LENGTH} characters.`,
    };
  }
  const key = optionalString(args.key);
  if (key && key.length > KEY_MAX_LENGTH) {
    return {
      ok: false,
      message: `add_todo key must be at most ${KEY_MAX_LENGTH} characters.`,
    };
  }
  const project = optionalString(args.project);
  if (project && project.length > PROJECT_MAX_LENGTH) {
    return {
      ok: false,
      message: `add_todo project must be at most ${PROJECT_MAX_LENGTH} characters.`,
    };
  }
  const action = normalizeAction(args.action);
  if (action && !action.ok) {
    return action;
  }
  return {
    ok: true,
    value: {
      title,
      ...(detail ? { detail } : {}),
      ...(key ? { key } : {}),
      ...(project ? { project } : {}),
      ...(action ? { action: action.value } : {}),
    },
  };
}

function normalizeAction(
  value: unknown,
): { ok: true; value: ThreadTodoAction } | { ok: false; message: string } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "add_todo action must be an object." };
  }
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "start_review":
      return { ok: true, value: { type: "start_review" } };
    case "merge_pull_request": {
      const pullRequest = normalizePullRequestReference(action.pullRequest);
      if (!pullRequest) {
        return {
          ok: false,
          message:
            "merge_pull_request requires pullRequest: a PR number or a github.com pull request URL.",
        };
      }
      // The merge method is the operator's pick at click time, so any
      // method the agent names is ignored rather than refused.
      return {
        ok: true,
        value: { type: "merge_pull_request", pullRequest },
      };
    }
    case "start_thread": {
      const prompt = optionalString(action.prompt);
      if (!prompt) {
        return { ok: false, message: "start_thread requires a non-empty prompt." };
      }
      if (prompt.length > THREAD_TODO_PROMPT_MAX_LENGTH) {
        return {
          ok: false,
          message: `start_thread prompt must be at most ${THREAD_TODO_PROMPT_MAX_LENGTH} characters.`,
        };
      }
      const workMode = action.workMode;
      if (workMode !== undefined && !isOneOf(workMode, WORK_MODES)) {
        return { ok: false, message: "start_thread workMode must be local or worktree." };
      }
      const executionMode = action.executionMode;
      if (executionMode !== undefined && !isOneOf(executionMode, EXECUTION_MODES)) {
        return {
          ok: false,
          message: "start_thread executionMode must be default, auto or full-access.",
        };
      }
      const title = optionalString(action.title);
      const model = optionalString(action.model);
      const reasoningEffort = optionalString(action.reasoningEffort);
      return {
        ok: true,
        value: {
          type: "start_thread",
          prompt,
          ...(title ? { title: title.slice(0, THREAD_TODO_TITLE_MAX_LENGTH) } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(executionMode ? { executionMode } : {}),
          ...(workMode ? { workMode } : {}),
        },
      };
    }
    default:
      return {
        ok: false,
        message:
          "add_todo action.type must be start_review, merge_pull_request or start_thread.",
      };
  }
}

/**
 * update_todo's fields are a patch: an absent field is left alone, and an
 * empty string clears an optional one back to its default. That keeps
 * "use another model" from making the thread restate the whole card.
 */
export function normalizeUpdateTodoArgs(
  args: Record<string, unknown>,
):
  | { ok: true; target: { id?: string; key?: string }; value: UpdateThreadTodoInput }
  | { ok: false; message: string } {
  const id = optionalString(args.id);
  const key = optionalString(args.key);
  if (!id && !key) {
    return { ok: false, message: "update_todo requires id or key." };
  }
  const value: UpdateThreadTodoInput = {};
  if (args.title !== undefined) {
    const title = optionalString(args.title);
    if (!title) {
      return { ok: false, message: "update_todo title cannot be empty." };
    }
    if (title.length > THREAD_TODO_TITLE_MAX_LENGTH) {
      return {
        ok: false,
        message: `update_todo title must be at most ${THREAD_TODO_TITLE_MAX_LENGTH} characters.`,
      };
    }
    value.title = title;
  }
  const detail = readClearable(args.detail, "detail", THREAD_TODO_DETAIL_MAX_LENGTH);
  if (detail && !detail.ok) return detail;
  if (detail) value.detail = detail.value;
  const project = readClearable(args.project, "project", PROJECT_MAX_LENGTH);
  if (project && !project.ok) return project;
  if (project) value.project = project.value;

  const action: ThreadTodoActionPatch = {};
  if (args.prompt !== undefined) {
    const prompt = optionalString(args.prompt);
    if (!prompt) {
      return { ok: false, message: "update_todo prompt cannot be empty." };
    }
    if (prompt.length > THREAD_TODO_PROMPT_MAX_LENGTH) {
      return {
        ok: false,
        message: `update_todo prompt must be at most ${THREAD_TODO_PROMPT_MAX_LENGTH} characters.`,
      };
    }
    action.prompt = prompt;
  }
  const threadTitle = readClearable(args.threadTitle, "threadTitle", THREAD_TODO_TITLE_MAX_LENGTH);
  if (threadTitle && !threadTitle.ok) return threadTitle;
  if (threadTitle) action.title = threadTitle.value;
  for (const field of ["model", "reasoningEffort"] as const) {
    const parsed = readClearable(args[field], field, MODEL_SETTING_MAX_LENGTH);
    if (parsed && !parsed.ok) return parsed;
    if (parsed) action[field] = parsed.value;
  }
  const executionMode = readClearableChoice(args.executionMode, "executionMode", EXECUTION_MODES);
  if (executionMode && !executionMode.ok) return executionMode;
  if (executionMode) action.executionMode = executionMode.value;
  const workMode = readClearableChoice(args.workMode, "workMode", WORK_MODES);
  if (workMode && !workMode.ok) return workMode;
  if (workMode) action.workMode = workMode.value;
  if (args.pullRequest !== undefined) {
    const pullRequest = normalizePullRequestReference(args.pullRequest);
    if (!pullRequest) {
      return {
        ok: false,
        message: "update_todo pullRequest must be a PR number or a github.com pull request URL.",
      };
    }
    action.pullRequest = pullRequest;
  }
  if (Object.keys(action).length > 0) value.action = action;
  if (Object.keys(value).length === 0) {
    return { ok: false, message: "update_todo needs at least one field to change." };
  }
  return {
    ok: true,
    target: { ...(id ? { id } : {}), ...(key ? { key } : {}) },
    value,
  };
}

/** Absent → undefined; "" → clear (null); otherwise the trimmed string. */
function readClearable(
  value: unknown,
  name: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; message: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return { ok: false, message: `update_todo ${name} must be a string.` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, message: `update_todo ${name} must be at most ${maxLength} characters.` };
  }
  return { ok: true, value: trimmed || null };
}

function readClearableChoice<T extends string>(
  value: unknown,
  name: string,
  choices: readonly T[],
): { ok: true; value: T | null } | { ok: false; message: string } | undefined {
  if (value === undefined) return undefined;
  if (value === "") return { ok: true, value: null };
  if (!isOneOf(value, choices)) {
    return { ok: false, message: `update_todo ${name} must be ${choices.join(", ")}, or empty to clear it.` };
  }
  return { ok: true, value };
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && (choices as readonly string[]).includes(value);
}

/**
 * `gh pr merge` takes a number, a URL or a branch. Branch names are refused:
 * the card must name one PR, not whatever the branch points at when clicked.
 */
export function normalizePullRequestReference(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/^#/, "");
  if (/^[1-9]\d*$/.test(trimmed)) {
    return trimmed;
  }
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*\/?$/.test(trimmed)
    ? trimmed.replace(/\/$/, "")
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function summarizeTodo(todo: ThreadTodo): Record<string, unknown> {
  return {
    id: todo.id,
    ...(todo.key ? { key: todo.key } : {}),
    kind: todo.kind,
    status: todo.status,
    title: todo.title,
    ...(todo.detail ? { detail: todo.detail } : {}),
    ...(todo.action ? { action: todo.action } : {}),
    ...(todo.targetProject
      ? { project: { label: todo.targetProject.label, path: todo.targetProject.path } }
      : {}),
    ...(todo.result ? { result: todo.result } : {}),
    ...(todo.error ? { error: todo.error } : {}),
    createdAt: new Date(todo.createdAt).toISOString(),
  };
}

function descriptionForOperation(operation: PwrAgentThreadTodoOperationName): string {
  switch (operation) {
    case "add_todo":
      return [
        "Raise a to-do card for the operator on this thread.",
        "Cards stay in the corner of the transcript and in the To-dos panel.",
        "Use one when the next step is the operator's.",
        "Use start_review when the work is ready for review.",
        "Use merge_pull_request when the PR is green and ready to land.",
        "Use start_thread to propose a follow-up thread with its full prompt.",
        "Omit the action for a reminder that must not be lost.",
        "The operator clicks to run an action, and you never run it.",
        "Do not use cards for progress updates.",
        "Pass a stable key to update one card instead of adding another each turn.",
        "Use update_todo to change some fields of a card you already raised.",
        "Pass project when the work is for another project, and raise one card per project.",
      ].join(" ");
    case "update_todo":
      return [
        "Change some fields of one of this thread's open to-do cards, by id or key.",
        "Fields you omit stay as they are.",
        "Pass an empty string to clear an optional field back to its default.",
        "Use it when the operator asks to change a card, such as its model, effort or permissions.",
        "A model may be named by id or by its display name, and the card stores the id.",
      ].join(" ");
    case "list_todos":
      return "List this thread's to-do cards. Defaults to open cards.";
    case "resolve_todo":
      return "Mark one of this thread's to-do cards done or dismissed, by id or key. Use it when a card no longer applies.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentThreadTodoOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "add_todo":
      return {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: `Card title, at most ${THREAD_TODO_TITLE_MAX_LENGTH} characters. Say what the operator should do, such as "Ready to merge".`,
          },
          detail: {
            type: "string",
            description: "One or two sentences of context shown under the title.",
          },
          key: {
            type: "string",
            description:
              "Stable identifier. Adding with the key of an open card updates that card in place.",
          },
          project: {
            type: "string",
            description:
              "The project the work is for, by name or path, such as PwrSnap. Omit for this thread's own project.",
          },
          action: {
            type: "object",
            description: "The one action the card's button runs. Omit for a reminder.",
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: ["start_review", "merge_pull_request", "start_thread"],
              },
              pullRequest: {
                type: "string",
                description:
                  "merge_pull_request only: the PR number in this thread's repository, or its github.com URL. The operator picks the merge method.",
              },
              prompt: {
                type: "string",
                description:
                  "start_thread only: the complete first message for the new thread. It must stand alone, because the new thread does not see this one.",
              },
              title: {
                type: "string",
                description: "start_thread only: a short name for the new thread.",
              },
              model: {
                type: "string",
                description: "start_thread only: model id for the new thread. Defaults to this thread's backend default.",
              },
              reasoningEffort: {
                type: "string",
                description: "start_thread only: reasoning effort, such as medium, high or xhigh.",
              },
              executionMode: {
                type: "string",
                enum: [...EXECUTION_MODES],
                description:
                  "start_thread only: the new thread's permissions. Default Access is the default, auto is Auto, and full-access is Full Access.",
              },
              workMode: {
                type: "string",
                enum: ["local", "worktree"],
                description:
                  "start_thread only: worktree starts the thread in a new git worktree from this thread's directory. Local, the default, shares the directory.",
              },
            },
          },
        },
      };
    case "update_todo":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "The card's id, from add_todo or list_todos." },
          key: { type: "string", description: "An open card's key, instead of its id." },
          title: { type: "string" },
          detail: { type: "string", description: "Empty clears it." },
          project: {
            type: "string",
            description: "The project the work is for, by name or path. Empty returns the card to this thread's project.",
          },
          prompt: { type: "string", description: "Handoff cards: the new thread's complete first message." },
          threadTitle: { type: "string", description: "Handoff cards: the new thread's name. Empty clears it." },
          model: {
            type: "string",
            description: "Handoff cards: model id or display name. Empty returns to the backend default.",
          },
          reasoningEffort: {
            type: "string",
            description: "Handoff cards: reasoning effort, such as medium, high or xhigh. Empty returns to the default.",
          },
          executionMode: {
            type: "string",
            enum: [...EXECUTION_MODES, ""],
            description: "Handoff cards: the new thread's permissions. Empty returns to Default Access.",
          },
          workMode: {
            type: "string",
            enum: [...WORK_MODES, ""],
            description: "Handoff cards: local or worktree. Empty returns to local.",
          },
          pullRequest: {
            type: "string",
            description: "Merge cards: the PR number or github.com URL.",
          },
        },
      };
    case "list_todos":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["open", "done", "dismissed", "all"],
          },
        },
      };
    case "resolve_todo":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          key: { type: "string" },
          status: {
            type: "string",
            enum: ["done", "dismissed"],
            description: "Defaults to done.",
          },
        },
      };
  }
}
