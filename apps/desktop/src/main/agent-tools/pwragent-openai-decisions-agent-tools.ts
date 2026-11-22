import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import {
  OPENAI_DECISION_BOUNDS,
  OPENAI_DECISIONS_TOOL_NAMES,
  DECISION_IMAGE_SCHEMA_KEY,
  type OpenAIDecisionsToolName,
} from "@pwragent/shared/openai-decisions";
import type {
  AgentToolCallContext,
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import { agentToolFailure, agentToolSuccess } from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";
import { DECISION_BATCH_LIMITS } from "../openai-decisions/decision-batches.js";

export const PWRAGENT_OPENAI_DECISIONS_UNAVAILABLE_MESSAGE =
  "OpenAI Decisions tools are not available in this PwrAgent runtime.";

type DecisionCaller = { backend: string; threadId: string };

/**
 * One handler for every decisions tool. The calling thread comes from the
 * call context, never from arguments. Arguments are the model's data; the
 * handler loads the OpenAI key itself.
 */
export type PwrAgentOpenAIDecisionsHandler = {
  register: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
  list: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
  invoke: (
    caller: DecisionCaller,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ) => Promise<unknown>;
  update: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
  delete: (caller: DecisionCaller, args: Record<string, unknown>) => unknown;
  /** Reads a batch the calling thread started, or lists its batches. */
  batchResults: (caller: DecisionCaller, args: Record<string, unknown>) => Promise<unknown>;
  cancelBatch: (caller: DecisionCaller, args: Record<string, unknown>) => Promise<unknown>;
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
    case "decisions_invoke": return await handler.invoke(caller, args, context.signal, context.reportProgress);
    case "decisions_update": return handler.update(caller, args);
    case "decisions_delete": return handler.delete(caller, args);
    case "decisions_batch_results": return await handler.batchResults(caller, args);
    case "decisions_batch_cancel": return await handler.cancelBatch(caller, args);
  }
}

function isCodedError(error: unknown): error is CodedError {
  return error instanceof Error
    && typeof (error as Partial<CodedError>).code === "string"
    && error.name === "OpenAIDecisionsError";
}

const DESCRIPTIONS: Record<OpenAIDecisionsToolName, string> = {
  decisions_register: [
    "Register a reusable decision that a decision model answers with probabilities instead of text.",
    "provider picks the model: openai (OpenAI Decisions, gpt-6-luna), jev (TypeSafe Jev), or local (a decision model on this Mac).",
    "Omit provider to use the one the operator set up.",
    "Give one predicate, choice, or score question, or up to 16 questions.",
    `Add an input JSON Schema and an optional shared text prefix. Set "${DECISION_IMAGE_SCHEMA_KEY}": true at the schema root to require an image per item.`,
    "OpenAI Decisions and local Clef accept images. Jev 1.13, 1.14 and jev-latest accept images through TypeSafe's experimental API.",
    "Registration is stored locally and makes no API call.",
    "An active name in the same scope fails with decision_name_taken.",
    "Scope profile, the default, reaches every thread in this profile.",
    "Scope thread reaches only the registering thread.",
    "Never pass a key. PwrAgent attaches the operator's OpenAI key.",
    "Call decisions_list to see what exists.",
  ].join(" "),
  decisions_list: [
    "List registered decisions visible to this thread.",
    "Each entry has its id, name, version, scope, provider, questions, choice values or score labels, and input schema.",
    "inputCapabilities.images reports support for its configured model, including experimental status, formats and limits.",
    "timing gives one request's p50Ms, meanMs, minMs and maxMs over the version's latest 200 successes.",
    "It appears once the version has run since PwrAgent started.",
    "Instructions and prefixes appear only with includeInstructions.",
  ].join(" "),
  decisions_invoke: [
    "Run a registered decision on new input, or pass definition to run one ad hoc without registering it.",
    "One input returns its answers. For OpenAI it also returns the request id, response body, and token usage with an estimated price.",
    "Pass inputs instead of input to run a batch of up to 500 items, at most 8 at once.",
    "For images, pass an array starting with an optional {type: input_text, text: ...} or {type: input_json, data: {...}}, followed by one to four {type: input_image, image_url: ...} parts.",
    "Use PNG or JPEG base64 data URLs. Images go to the chosen provider. Jev image input is experimental and requires each side to be 280–1568 pixels. Check decisions_list for model-specific limits.",
    "The schema applies to the text or JSON part. images_unsupported and invalid_image are per-item batch failures.",
    "A batch returns a batchId, totals, and results by index: each item's answers and confidence, without response bodies.",
    "Pass detail full for response bodies, request ids, and per-item usage.",
    "Results stop at 64 KiB. nextFrom then says where decisions_batch_results continues.",
    "The thread shows the batch's progress while it runs.",
    "Estimate a batch as inputs / concurrency x timing.p50Ms from decisions_list.",
    "Wait for a batch you expect to finish within about a minute.",
    "For a longer or unknown one, pass background true: the call returns the batchId at once, so end your turn.",
    "PwrAgent then starts a turn on this thread when the batch ends.",
    "If a batch call is cancelled or times out, its finished answers are kept.",
    "Every batch is also appended to resultsFile, a JSONL file you can read directly.",
    "Call decisions_batch_results without arguments to find the batchId.",
    "A refusal for one question is still a success.",
    "OpenAI calls bill the operator's API project, and Jev calls bill their TypeSafe account.",
    "Pass version to pin an older stored version. Omit it for the latest.",
    "Call decisions_list first to find names and schemas.",
  ].join(" "),
  decisions_update: [
    "Replace a registered decision's questions, schema, prefix, or provider.",
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
  decisions_batch_results: [
    "Read a decisions_invoke batch this thread started, while it runs or after it ends.",
    "Pass batchId for its state, totals, and a page of finished items in input order.",
    "status picks succeeded, failed (skipped included), or skipped items. The default is all.",
    "from is the first input index and limit the most items, 100 by default and 500 at most.",
    "A page also stops at 64 KiB. Pass nextFrom back as from for the rest.",
    "Items are compact, answers and confidence only. Pass detail full for response bodies and per-item usage.",
    "Without batchId, lists this thread's batches, newest first.",
    "Batches survive a restart: each is a JSONL file in the thread's storage, and the latest 20 are kept.",
    "Reading makes no API call.",
  ].join(" "),
  decisions_batch_cancel: [
    "Cancel a running decisions_invoke batch this thread started.",
    "Requests in flight are aborted and unsent items are skipped.",
    "Finished answers stay readable with decisions_batch_results.",
    "No wake-up turn follows a cancel.",
  ].join(" "),
};

const ANNOTATIONS: Record<OpenAIDecisionsToolName, AgentToolDefinition["annotations"]> = {
  decisions_register: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  decisions_list: { readOnlyHint: true, openWorldHint: false },
  decisions_invoke: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  decisions_update: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  decisions_delete: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  decisions_batch_results: { readOnlyHint: true, openWorldHint: false },
  decisions_batch_cancel: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

const DETAIL_SCHEMA = {
  type: "string",
  enum: ["compact", "full"],
  description: "compact: answers and confidence. full: also response bodies, request ids, and per-item usage. Default compact for batches, full for one input.",
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
  provider: {
    type: "string",
    enum: ["openai", "jev", "local"],
    description: "Which decision model runs it. Omit to use the one the operator set up.",
  },
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
      `Optional root ${DECISION_IMAGE_SCHEMA_KEY}: true requires at least one image part.`,
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
    properties: {
      name: NAME_SCHEMA,
      decisionId: { type: "string" },
      version: { type: "integer", minimum: 1 },
      definition: {
        type: "object",
        description: "An ad hoc decision instead of name: provider, instructions, question or questions, prefix, optional inputSchema. Nothing is stored.",
        additionalProperties: false,
        properties: {
          provider: DEFINITION_PROPERTIES.provider,
          instructions: DEFINITION_PROPERTIES.instructions,
          question: DEFINITION_PROPERTIES.question,
          questions: DEFINITION_PROPERTIES.questions,
          prefix: DEFINITION_PROPERTIES.prefix,
          inputSchema: DEFINITION_PROPERTIES.inputSchema,
        },
      },
      input: {
        description: "One string or JSON object, or an array with optional input_text or input_json followed by input_image data URL parts.",
      },
      inputs: {
        type: "array",
        minItems: 1,
        maxItems: OPENAI_DECISION_BOUNDS.bulkMaxItems,
        description: "A batch of inputs instead of input. Results come back by index.",
        items: { description: "Same evidence shape as input, including optional image parts." },
      },
      concurrency: {
        type: "integer",
        minimum: 1,
        maximum: OPENAI_DECISION_BOUNDS.bulkMaxConcurrency,
        description: "Requests in flight at once for inputs. Default 8.",
      },
      detail: DETAIL_SCHEMA,
      background: {
        type: "boolean",
        description: "inputs only. Return the batchId at once and run the batch after the call. PwrAgent starts a turn on this thread when it ends.",
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
  decisions_batch_results: {
    type: "object",
    additionalProperties: false,
    properties: {
      batchId: { type: "string", description: "From decisions_invoke. Omit to list this thread's batches." },
      status: {
        type: "string",
        enum: ["all", "succeeded", "failed", "skipped"],
        description: "Which finished items to return. failed includes skipped. Default all.",
      },
      from: { type: "integer", minimum: 0, description: "First input index to read. Default 0. Pass nextFrom for the next page." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: DECISION_BATCH_LIMITS.pageMaxItems,
        description: "Most items to return. Default 100.",
      },
      detail: DETAIL_SCHEMA,
    },
  },
  decisions_batch_cancel: {
    type: "object",
    additionalProperties: false,
    required: ["batchId"],
    properties: {
      batchId: { type: "string" },
    },
  },
};
