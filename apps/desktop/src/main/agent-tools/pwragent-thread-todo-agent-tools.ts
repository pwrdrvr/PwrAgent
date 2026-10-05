import type {
  AppServerBackendKind,
  PwrAgentThreadTodoOperationName,
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
import type { AddThreadTodoInput } from "../thread-todos/thread-todo-service.js";
import { ThreadTodoError } from "../thread-todos/thread-todo-service.js";

export const PWRAGENT_THREAD_TODO_UNAVAILABLE_MESSAGE =
  "PwrAgent to-do tools are not available.";

const KEY_MAX_LENGTH = 80;
const PROJECT_MAX_LENGTH = 1_000;

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
      if (workMode !== undefined && workMode !== "local" && workMode !== "worktree") {
        return { ok: false, message: "start_thread workMode must be local or worktree." };
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
        "Pass project when the work is for another project, and raise one card per project.",
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
