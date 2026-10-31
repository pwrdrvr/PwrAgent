import type {
  AppServerBackendKind,
  AppServerThreadReviewEntry,
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
  THREAD_TODO_ITEM_TEXT_MAX_LENGTH,
  THREAD_TODO_MAX_ITEMS,
  THREAD_TODO_MAX_PREREQUISITES,
  THREAD_TODO_PROMPT_MAX_LENGTH,
  THREAD_TODO_TITLE_MAX_LENGTH,
  parseThreadTodoItemTexts,
  threadTodoPrerequisites,
  threadTodoSteps,
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
import {
  buildPwrAgentThreadReviewToolDefinitions,
  type PwrAgentThreadReviewHandler,
} from "./pwragent-thread-review-agent-tools";

export const PWRAGENT_THREAD_TODO_UNAVAILABLE_MESSAGE =
  "PwrAgent to-do tools are not available.";

const KEY_MAX_LENGTH = 80;
const PROJECT_MAX_LENGTH = 1_000;
const MODEL_SETTING_MAX_LENGTH = 200;
const EXECUTION_MODES = ["default", "auto", "full-access"] as const satisfies
  readonly ThreadExecutionMode[];
const WORK_MODES = ["local", "worktree"] as const;
const TODO_WRITING_GUIDANCE = [
  "Write titles, details, and handoff prompts in clear, natural language for the operator.",
  "Use normal spacing and complete sentences, without compressed agent shorthand.",
  "Organize longer prompts with Markdown headings, lists, and tables where helpful.",
].join(" ");
// Repeated on add_todo and list_todos: a backend that loads tool schemas on
// demand may not read resolve_todo until the work is done.
const CLAIM_GUIDANCE = [
  "When the operator asks you to do a card's work in this thread, claim it first.",
  "Call resolve_todo with resolution sent_here before you start, as the card's Do it here button does.",
].join(" ");

type ThreadTodoToolContext = {
  backend: AppServerBackendKind;
  threadId: string;
};

/**
 * The calling thread comes from the tool call context, never from the
 * arguments, so a thread can only raise and resolve its own cards.
 */
export type PwrAgentThreadTodoHandler = {
  reviews?: PwrAgentThreadReviewHandler;
  importReviews?: (context: ThreadTodoToolContext, entries: AppServerThreadReviewEntry[]) => void;
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
    target: {
      id?: string;
      key?: string;
      status: Exclude<ThreadTodoStatus, "open">;
      /** With done: the operator handed the card to this thread. */
      resolution?: "sent_here";
      allowOpenItems?: boolean;
    },
  ) => ThreadTodo | Promise<ThreadTodo>;
};

export function buildPwrAgentThreadTodoToolRouter(
  handler: PwrAgentThreadTodoHandler | undefined,
): AgentToolRouter {
  return new AgentToolRouter([
    ...buildPwrAgentThreadTodoToolDefinitions(handler),
    ...buildPwrAgentThreadReviewToolDefinitions(handler?.reviews),
  ], {
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
    annotations: { readOnlyHint: operation === "list_todos" },
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
      if (args.allowOpenItems !== undefined && typeof args.allowOpenItems !== "boolean") {
        return agentToolFailure({
          code: "invalid_arguments",
          message: "resolve_todo allowOpenItems must be true or false.",
        });
      }
      if (args.resolution !== undefined && args.resolution !== "sent_here") {
        return agentToolFailure({
          code: "invalid_arguments",
          message: "resolve_todo resolution must be sent_here.",
        });
      }
      if (args.resolution !== undefined && status !== "done") {
        return agentToolFailure({
          code: "invalid_arguments",
          message: "resolve_todo resolution applies only to done.",
        });
      }
      const todo = await handler.resolve(context, {
        ...(id ? { id } : {}),
        ...(key ? { key } : {}),
        status,
        ...(args.resolution === "sent_here" ? { resolution: "sent_here" as const } : {}),
        ...(args.allowOpenItems === true ? { allowOpenItems: true } : {}),
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
  const checklist = readChecklistTexts(args, "add_todo");
  if (!checklist.ok) {
    return checklist;
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
      ...checklist.value,
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
 * The card's step and prerequisite texts, each left out when absent so a
 * restated card keeps that list. Prerequisites have their own, smaller cap.
 */
function readChecklistTexts(
  args: Record<string, unknown>,
  operation: "add_todo" | "update_todo",
):
  | { ok: true; value: { items?: string[]; prerequisites?: string[] } }
  | { ok: false; message: string } {
  const value: { items?: string[]; prerequisites?: string[] } = {};
  for (const [field, maxItems] of [
    ["items", THREAD_TODO_MAX_ITEMS],
    ["prerequisites", THREAD_TODO_MAX_PREREQUISITES],
  ] as const) {
    if (args[field] === undefined) continue;
    const texts = parseThreadTodoItemTexts(args[field], `${operation} ${field}`, maxItems);
    if (!texts.ok) return texts;
    value[field] = texts.value;
  }
  return { ok: true, value };
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
  const checklist = readChecklistTexts(args, "update_todo");
  if (!checklist.ok) return checklist;
  Object.assign(value, checklist.value);
  for (const field of ["check", "uncheck"] as const) {
    if (args[field] === undefined) continue;
    const ids = readItemIds(args[field], field);
    if (!ids.ok) return ids;
    if (ids.value.length > 0) value[field] = ids.value;
  }

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

function readItemIds(
  value: unknown,
  name: "check" | "uncheck",
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (
    !Array.isArray(value)
    || value.length > THREAD_TODO_MAX_ITEMS + THREAD_TODO_MAX_PREREQUISITES
    || !value.every((entry) => typeof entry === "string" && entry.trim())
  ) {
    return {
      ok: false,
      message: `update_todo ${name} must be an array of at most ${THREAD_TODO_MAX_ITEMS + THREAD_TODO_MAX_PREREQUISITES} step ids.`,
    };
  }
  return { ok: true, value: [...new Set(value.map((entry: string) => entry.trim()))] };
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
    ...summarizeItems(todo),
    ...(todo.action ? { action: todo.action } : {}),
    ...(todo.targetProject
      ? { project: { label: todo.targetProject.label, path: todo.targetProject.path } }
      : {}),
    ...(todo.result ? { result: todo.result } : {}),
    ...(todo.error ? { error: todo.error } : {}),
    createdAt: new Date(todo.createdAt).toISOString(),
  };
}

/** Steps and prerequisites as two lists, each in the order the thread gave. */
function summarizeItems(todo: ThreadTodo): Record<string, unknown> {
  if (!todo.items) return {};
  const steps = threadTodoSteps(todo).map(({ id, text, checked }) => ({ id, text, checked }));
  const prerequisites = threadTodoPrerequisites(todo)
    .map(({ id, text, checked }) => ({ id, text, checked }));
  return {
    ...(steps.length > 0 ? { items: steps } : {}),
    ...(prerequisites.length > 0 ? { prerequisites } : {}),
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
        TODO_WRITING_GUIDANCE,
        "Omit the action for a reminder that must not be lost.",
        "The operator clicks to run an action, and you never run it.",
        "Do not use cards for progress updates.",
        "Pass a stable key to update one card instead of adding another each turn.",
        "For a multi-step follow-up, raise one card with items, its checkable steps, rather than one card per step.",
        "On a start_thread card, items are the new thread's plan and never block starting it.",
        "The new thread gets those steps as its own checklist card, keyed plan, to tick as it works.",
        "It does not see this card, so its prompt must still carry the steps.",
        "Use prerequisites only for what the operator must do before the thread can start.",
        "Cloning a repository the thread will work in is one example.",
        "Leave prerequisites out when the thread can start right away.",
        "On any other card, items are the operator's steps.",
        "A card with unchecked blocking steps cannot be marked done until they are checked.",
        "Re-adding a key with items keeps the id and checked state of every step whose text is unchanged.",
        "Use update_todo to change some fields of a card you already raised.",
        CLAIM_GUIDANCE,
        "Pass project when the work is for another project, and raise one card per project.",
        "For the exact project, pass a projectKey from list_instance_projects for this machine.",
      ].join(" ");
    case "update_todo":
      return [
        "Change some fields of one of this thread's open to-do cards, by id or key.",
        TODO_WRITING_GUIDANCE,
        "Fields you omit stay as they are.",
        "Pass an empty string to clear an optional field back to its default.",
        "Use it when the operator asks to change a card, such as its model, effort or permissions.",
        "Pass check or uncheck with step or prerequisite ids to tick them as they are finished.",
        "A model may be named by id or by its display name, and the card stores the id.",
      ].join(" ");
    case "list_todos":
      return ["List this thread's to-do cards. Defaults to open cards.", CLAIM_GUIDANCE].join(" ");
    case "resolve_todo":
      return [
        "Mark one of this thread's to-do cards done or dismissed, by id or key.",
        "Use it when a card no longer applies.",
        CLAIM_GUIDANCE,
        "Otherwise the card stays open while you work, and the operator can start or dismiss it again.",
        "Marking a card done fails while any of its steps is unchecked, and the error names them.",
        "On a start_thread card only its prerequisites count.",
        "Check finished steps with update_todo first.",
        "Dismiss works regardless.",
      ].join(" ");
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
          items: {
            type: "array",
            maxItems: THREAD_TODO_MAX_ITEMS,
            items: { type: "string", maxLength: THREAD_TODO_ITEM_TEXT_MAX_LENGTH },
            description: [
              "Checkable steps, in order.",
              `Each step is at most ${THREAD_TODO_ITEM_TEXT_MAX_LENGTH} characters, and a card holds at most ${THREAD_TODO_MAX_ITEMS} steps.`,
              "Steps start unchecked, and the result gives each step's id.",
              "Re-adding a key with items replaces the list.",
              "A step whose text is unchanged keeps its id and checked state.",
              "A new text starts unchecked, and a step you leave out is removed.",
              "Omit items to keep the card's steps as they are.",
              "On a start_thread card these are the new thread's steps, and they do not block the start.",
            ].join(" "),
          },
          prerequisites: {
            type: "array",
            maxItems: THREAD_TODO_MAX_PREREQUISITES,
            items: { type: "string", maxLength: THREAD_TODO_ITEM_TEXT_MAX_LENGTH },
            description: [
              "Checkable steps the operator must finish before the card's action runs.",
              "Use them only for work the operator has to do first.",
              "Cloning a repository and pointing the card at it is one example.",
              "The operator is asked to confirm before starting while one is unchecked.",
              "They are shown above the steps and merged like items.",
              `A card holds at most ${THREAD_TODO_MAX_PREREQUISITES} prerequisites.`,
            ].join(" "),
          },
          key: {
            type: "string",
            description:
              "Stable identifier. Adding with the key of an open card updates that card in place.",
          },
          project: {
            type: "string",
            description:
              "The project the work is for. Pass a projectKey from list_instance_projects, a project name, or a path inside the project or its worktree. Omit for this thread's own project.",
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
                description: "start_thread only: model id for the new thread. Omit to use this thread's model.",
              },
              reasoningEffort: {
                type: "string",
                description: "start_thread only: reasoning effort, such as medium, high or xhigh. Omit to use this thread's.",
              },
              executionMode: {
                type: "string",
                enum: [...EXECUTION_MODES],
                description:
                  "start_thread only: the new thread's permissions: default is Default Access, auto is Auto, and full-access is Full Access. Omit to use this thread's.",
              },
              workMode: {
                type: "string",
                enum: ["local", "worktree"],
                description:
                  "start_thread only: worktree starts the thread in a new git worktree of this thread's repository, based on the default branch. Local, the default, shares the directory.",
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
          items: {
            type: "array",
            maxItems: THREAD_TODO_MAX_ITEMS,
            items: { type: "string", maxLength: THREAD_TODO_ITEM_TEXT_MAX_LENGTH },
            description: [
              "The card's steps, restated in full.",
              "An unchanged text keeps its id and checked state, as with add_todo.",
              "An empty array removes every step.",
            ].join(" "),
          },
          prerequisites: {
            type: "array",
            maxItems: THREAD_TODO_MAX_PREREQUISITES,
            items: { type: "string", maxLength: THREAD_TODO_ITEM_TEXT_MAX_LENGTH },
            description: [
              "The card's prerequisites, restated in full, merged like items.",
              "An empty array removes every prerequisite.",
            ].join(" "),
          },
          check: {
            type: "array",
            items: { type: "string" },
            description: "Ids of steps to mark checked, from add_todo or list_todos.",
          },
          uncheck: {
            type: "array",
            items: { type: "string" },
            description: "Ids of steps to mark unchecked.",
          },
          project: {
            type: "string",
            description: "The project the work is for: a projectKey from list_instance_projects, a name, or a path. Empty returns the card to this thread's project.",
          },
          prompt: { type: "string", description: "Handoff cards: the new thread's complete first message." },
          threadTitle: { type: "string", description: "Handoff cards: the new thread's name. Empty clears it." },
          model: {
            type: "string",
            description: "Handoff cards: model id or display name. Empty returns to this thread's model.",
          },
          reasoningEffort: {
            type: "string",
            description: "Handoff cards: reasoning effort, such as medium, high or xhigh. Empty returns to this thread's.",
          },
          executionMode: {
            type: "string",
            enum: [...EXECUTION_MODES, ""],
            description: "Handoff cards: the new thread's permissions. Empty returns to this thread's.",
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
          resolution: {
            type: "string",
            enum: ["sent_here"],
            description:
              "With done: the operator asked you to do the card's work in this thread. Resolve before you start, so the card cannot run twice.",
          },
          allowOpenItems: {
            type: "boolean",
            description:
              "With done: mark the card done although some steps are unchecked. Pass it only when the operator says the remaining steps no longer apply. Also pass it with resolution sent_here when those steps are the work you take on.",
          },
        },
      };
  }
}
