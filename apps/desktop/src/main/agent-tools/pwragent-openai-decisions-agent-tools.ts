import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import {
  OPENAI_DECISION_BOUNDS,
  OPENAI_DECISIONS_TOOL_NAMES,
  type OpenAIDecisionsToolName,
} from "@pwragent/shared/openai-decisions";
import type {
  AgentToolCallContext,
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import { agentToolFailure, agentToolSuccess } from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const PWRAGENT_OPENAI_DECISIONS_UNAVAILABLE_MESSAGE =
  "OpenAI Decisions tools are not available in this PwrAgent runtime.";

type DecisionCaller = { backend: string; threadId: string };

/**
 * One handler for all five tools. The calling thread comes from the call
 * context, never from arguments. Arguments are the model's data; the
 * handler loads the OpenAI key itself.
 */
export type PwrAgentOpenAIDecisionsHandler = {
  register: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
  list: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
  invoke: (
    caller: DecisionCaller,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  update: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
  delete: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
};

/** An error that carries a stable tool failure code, such as `decision_not_found`. */
type CodedError = Error & { code: string; data?: Record<string, unknown> };

export function buildPwrAgentOpenAIDecisionsToolRouter(
  handler: PwrAgentOpenAIDecisionsHandler | undefined,
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentOpenAIDecisionsToolDefinitions(handler), {
    unsupportedMessage: "Unsupported OpenAI Decisions tool.",
  });
}

export function buildPwrAgentOpenAIDecisionsToolDefinitions(
  handler: PwrAgentOpenAIDecisionsHandler | undefined,
): AgentToolDefinition<OpenAIDecisionsToolName>[] {
  return OPENAI_DECISIONS_TOOL_NAMES.map((name) => ({
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name,
    description: DESCRIPTIONS[name],
    inputSchema: INPUT_SCHEMAS[name],
    annotations: ANNOTATIONS[name],
    deferLoading: true,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_OPENAI_DECISIONS_UNAVAILABLE_MESSAGE,
        });
      }
      try {
        return agentToolSuccess(await dispatch(name, handler, args, context));
      } catch (error) {
        if (isCodedError(error)) {
          return agentToolFailure({
            code: error.code,
            message: error.message,
            ...(error.data ? { data: error.data } : {}),
          });
        }
        // Unexpected failures do not echo arbitrary error text, which could
        // carry request material.
        return agentToolFailure({
          code: "internal_error",
          message: "The OpenAI Decisions tool failed unexpectedly.",
        });
      }
    },
  }));
}

async function dispatch(
  name: OpenAIDecisionsToolName,
  handler: PwrAgentOpenAIDecisionsHandler,
  args: Record<string, unknown>,
  context: AgentToolCallContext,
): Promise<unknown> {
  const caller = { backend: context.backend, threadId: context.threadId };
  switch (name) {
    case "decisions_register": return handler.register(caller, args);
    case "decisions_list": return handler.list(caller, args);
    case "decisions_invoke": return await handler.invoke(caller, args, context.signal);
    case "decisions_update": return handler.update(caller, args);
    case "decisions_delete": return handler.delete(caller, args);
  }
}

function isCodedError(error: unknown): error is CodedError {
  return error instanceof Error
    && typeof (error as Partial<CodedError>).code === "string"
    && error.name === "OpenAIDecisionsError";
}

const DESCRIPTIONS: Record<OpenAIDecisionsToolName, string> = {
  decisions_register: [
    "Register a reusable decision that PwrAgent runs on the OpenAI Decisions API with gpt-6-luna.",
    "Give one predicate, choice, or score question, or up to 16 questions.",
    "Add an input JSON Schema and an optional shared prefix.",
    "Registration is stored locally and makes no API call.",
    "An active name in the same scope fails with decision_name_taken.",
    "Scope profile, the default, reaches every thread in this profile.",
    "Scope thread reaches only the registering thread.",
    "Never pass a key. PwrAgent attaches the operator's OpenAI key.",
    "Call decisions_list to see what exists.",
  ].join(" "),
  decisions_list: [
    "List registered OpenAI decisions visible to this thread.",
    "Each entry has its id, name, version, scope, questions, choice values or score labels, and input schema.",
    "Instructions and prefixes appear only with includeInstructions.",
  ].join(" "),
  decisions_invoke: [
    "Run a registered decision on new input.",
    "Input is checked against the stored schema before any request.",
    "Returns every answer, the OpenAI request id, and token usage with an estimated API price.",
    "A refusal for one question is still a success.",
    "Calls bill the operator's OpenAI API project, not a ChatGPT or Codex subscription.",
    "Pass version to pin an older stored version. Omit it for the latest.",
    "Call decisions_list first to find names and schemas.",
  ].join(" "),
  decisions_update: [
    "Replace a registered decision's questions, schema, or prefix.",
    "Takes the decisions_register arguments plus an optional decisionId.",
    "Stores a new version and makes it the default.",
    "Older versions stay invokable by pinned version until the decision is deleted.",
    "Cannot rename a decision or change its scope.",
  ].join(" "),
  decisions_delete: [
    "Delete a registered decision by name or decisionId.",
    "Every version stops running, and invoke returns decision_deleted.",
    "The name can then be registered again as a new decision.",
  ].join(" "),
};

const ANNOTATIONS: Record<OpenAIDecisionsToolName, AgentToolDefinition["annotations"]> = {
  decisions_register: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  decisions_list: { readOnlyHint: true, openWorldHint: false },
  decisions_invoke: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  decisions_update: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  decisions_delete: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

const NAME_SCHEMA = {
  type: "string",
  pattern: "^[a-z][a-z0-9_]{0,63}$",
  description: "Stable decision name: lowercase letters, digits, and underscores.",
};

const QUESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["predicate", "choice", "score"] },
    name: { type: "string", maxLength: OPENAI_DECISION_BOUNDS.questionNameMaxLength },
    instructions: {
      type: "string",
      maxLength: OPENAI_DECISION_BOUNDS.instructionsMaxLength,
      description: "The question. Defaults to the top-level instructions.",
    },
    choices: {
      type: "array",
      minItems: OPENAI_DECISION_BOUNDS.choicesMin,
      maxItems: OPENAI_DECISION_BOUNDS.choicesMax,
      description: "Choice questions only. Unique string values. Include a fallback such as other.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    levels: {
      type: "array",
      minItems: OPENAI_DECISION_BOUNDS.levelsMin,
      maxItems: OPENAI_DECISION_BOUNDS.levelsMax,
      description: "Score questions only. Ordered levels, lowest first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: {
          label: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

const DEFINITION_PROPERTIES = {
  name: NAME_SCHEMA,
  scope: { type: "string", enum: ["profile", "thread"] },
  instructions: {
    type: "string",
    maxLength: OPENAI_DECISION_BOUNDS.instructionsMaxLength,
    description: "Question text shared by question, or by questions items without their own.",
  },
  question: QUESTION_SCHEMA,
  questions: {
    type: "array",
    minItems: OPENAI_DECISION_BOUNDS.questionsMin,
    maxItems: OPENAI_DECISION_BOUNDS.questionsMax,
    items: QUESTION_SCHEMA,
  },
  inputSchema: {
    type: "object",
    description: [
      "JSON Schema for invoke input, at most 8 KiB, with root type object or string.",
      "Supported keywords are type, properties, required, additionalProperties, items, enum, and title.",
      "Also description, minLength, maxLength, minimum, maximum, minItems, and maxItems.",
    ].join(" "),
  },
  prefix: {
    type: "string",
    maxLength: OPENAI_DECISION_BOUNDS.prefixMaxLength,
    description: "Optional stable text sent before every input and marked for prompt caching.",
  },
};

const INPUT_SCHEMAS: Record<OpenAIDecisionsToolName, Record<string, unknown>> = {
  decisions_register: {
    type: "object",
    additionalProperties: false,
    required: ["name", "inputSchema"],
    properties: DEFINITION_PROPERTIES,
  },
  decisions_list: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeInstructions: { type: "boolean" },
    },
  },
  decisions_invoke: {
    type: "object",
    additionalProperties: false,
    required: ["input"],
    properties: {
      name: NAME_SCHEMA,
      decisionId: { type: "string" },
      version: { type: "integer", minimum: 1 },
      input: {
        description: "Evidence for the decision, matching the stored inputSchema (an object or a string).",
      },
    },
  },
  decisions_update: {
    type: "object",
    additionalProperties: false,
    required: ["name", "inputSchema"],
    properties: { ...DEFINITION_PROPERTIES, decisionId: { type: "string" } },
  },
  decisions_delete: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: NAME_SCHEMA,
      decisionId: { type: "string" },
    },
  },
};
