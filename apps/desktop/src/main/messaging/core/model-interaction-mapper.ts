import type { MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import {
  XaiEphemeralObjectCaller,
  type XaiObjectClientLike,
} from "../../app-server/ephemeral-object-call";
import {
  actionsForIntent,
  DeterministicInteractionMapper,
} from "./deterministic-interaction-mapper.js";
import type {
  MessagingInteractionMapper,
  MessagingInteractionMapperResult,
} from "./interaction-mapper.js";
import type {
  MessagingHelperObjectRequest,
  MessagingHelperObjectResult,
} from "./messaging-adapter.js";
import modelInteractionMapperSystemPrompt from "./model-interaction-mapper-prompt.md?raw";

const MODEL_INTERACTION_MAPPER_PROMPT_VERSION =
  "messaging-interaction-mapper-v1";
const MODEL_INTERACTION_MAPPER_TIMEOUT_MS = 4_000;

export type ModelInteractionMapperClient = {
  classify(params: {
    actions: ModelInteractionMapperAction[];
    intent: ModelInteractionMapperIntentSummary;
    text: string;
  }): Promise<ModelInteractionMapperClientResult>;
};

export type ModelInteractionMapperAction = {
  id: string;
  label: string;
  fallbackText?: string;
  index: number;
};

export type ModelInteractionMapperIntentSummary = {
  kind: MessagingSurfaceIntent["kind"];
  title?: string;
  body?: string;
  prompt?: string;
  fallbackText?: string;
};

export type ModelInteractionMapperClientResult =
  | {
      status: "ok";
      disposition: "action";
      actionId: string;
      confidence: number;
      reason?: string;
    }
  | {
      status: "ok";
      disposition: "pass_through";
      confidence: number;
      reason?: string;
    }
  | {
      status: "ok";
      disposition: "clarify";
      confidence: number;
      clarification: string;
      reason?: string;
    }
  | {
      status: "ok";
      disposition: "ambiguous";
      confidence: number;
      reason?: string;
    }
  | {
      status: "unavailable" | "failed";
      reason: string;
    };

export type XaiModelInteractionMapperClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  client?: XaiObjectClientLike;
  model?: string;
  timeoutMs?: number;
};

export type CodexModelInteractionMapperClientOptions = {
  helper: {
    generateHelperObject(
      request: MessagingHelperObjectRequest,
    ): Promise<MessagingHelperObjectResult>;
  };
  timeoutMs?: number;
};

export class ModelInteractionMapper implements MessagingInteractionMapper {
  private readonly deterministic = new DeterministicInteractionMapper();

  constructor(private readonly client: ModelInteractionMapperClient | undefined) {}

  async mapText(params: {
    intent: MessagingSurfaceIntent;
    text: string;
  }): Promise<MessagingInteractionMapperResult> {
    const deterministic = this.deterministic.mapText(params);
    if (deterministic.kind === "matched" || !this.client) {
      return deterministic;
    }

    const actions = summarizeActions(params.intent);
    if (actions.length === 0) {
      return deterministic;
    }

    const result = await this.client.classify({
      actions,
      intent: summarizeIntent(params.intent),
      text: params.text,
    });
    if (result.status !== "ok") {
      return deterministic;
    }

    if (result.disposition === "action" && result.confidence >= 0.62) {
      const action = actionsForIntent(params.intent).find(
        (candidate) => candidate.id === result.actionId,
      );
      if (action && !action.disabled) {
        return {
          kind: "matched",
          action,
        };
      }
    }

    if (result.disposition === "pass_through" && result.confidence >= 0.55) {
      return {
        kind: "pass_through",
        text: params.text,
      };
    }

    if (
      result.disposition === "clarify" &&
      result.confidence >= 0.5 &&
      result.clarification.trim()
    ) {
      return {
        kind: "clarification",
        text: result.clarification.trim(),
      };
    }

    return deterministic;
  }
}

export class FallbackModelInteractionMapperClient
  implements ModelInteractionMapperClient
{
  constructor(private readonly clients: ModelInteractionMapperClient[]) {}

  async classify(params: {
    actions: ModelInteractionMapperAction[];
    intent: ModelInteractionMapperIntentSummary;
    text: string;
  }): Promise<ModelInteractionMapperClientResult> {
    let lastResult: ModelInteractionMapperClientResult | undefined;
    for (const client of this.clients) {
      const result = await client.classify(params);
      if (result.status === "ok") {
        return result;
      }
      lastResult = result;
    }

    return (
      lastResult ?? {
        status: "unavailable",
        reason: "no_interaction_mapper_clients",
      }
    );
  }
}

export class CodexModelInteractionMapperClient
  implements ModelInteractionMapperClient
{
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexModelInteractionMapperClientOptions) {
    this.timeoutMs = options.timeoutMs ?? MODEL_INTERACTION_MAPPER_TIMEOUT_MS;
  }

  async classify(params: {
    actions: ModelInteractionMapperAction[];
    intent: ModelInteractionMapperIntentSummary;
    text: string;
  }): Promise<ModelInteractionMapperClientResult> {
    const result = await this.options.helper.generateHelperObject({
      prompt: buildCodexModelInteractionMapperPrompt(params),
      promptVersion: MODEL_INTERACTION_MAPPER_PROMPT_VERSION,
      schema: MODEL_INTERACTION_MAPPER_RESPONSE_SCHEMA,
      schemaName: "messaging_interaction_mapping",
      timeoutMs: this.timeoutMs,
    });
    if (result.status !== "ok") {
      return result;
    }

    return normalizeModelResponse(result.object, params.actions);
  }
}

export class XaiModelInteractionMapperClient implements ModelInteractionMapperClient {
  private readonly caller: XaiEphemeralObjectCaller;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: XaiModelInteractionMapperClientOptions = {}) {
    this.model = options.model?.trim() || "grok-4-1-fast-non-reasoning";
    this.timeoutMs = options.timeoutMs ?? MODEL_INTERACTION_MAPPER_TIMEOUT_MS;
    this.caller = new XaiEphemeralObjectCaller({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      client: options.client,
      model: this.model,
    });
  }

  async classify(params: {
    actions: ModelInteractionMapperAction[];
    intent: ModelInteractionMapperIntentSummary;
    text: string;
  }): Promise<ModelInteractionMapperClientResult> {
    const result = await this.caller.generateObject({
      model: this.model,
      promptCacheKey: MODEL_INTERACTION_MAPPER_PROMPT_VERSION,
      headers: {
        "x-grok-conv-id": MODEL_INTERACTION_MAPPER_PROMPT_VERSION,
      },
      timeoutMs: this.timeoutMs,
      schema: MODEL_INTERACTION_MAPPER_RESPONSE_SCHEMA,
      schemaName: "messaging_interaction_mapping",
      system: modelInteractionMapperSystemPrompt,
      prompt: JSON.stringify(buildModelInteractionMapperPayload(params)),
    });
    if (result.status !== "ok") {
      return result;
    }

    return normalizeModelResponse(result.response.object, params.actions);
  }
}

const MODEL_INTERACTION_MAPPER_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["disposition", "confidence"],
  properties: {
    disposition: {
      type: "string",
      enum: ["action", "pass_through", "clarify", "ambiguous"],
    },
    actionId: {
      type: "string",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    clarification: {
      type: "string",
    },
    reason: {
      type: "string",
    },
  },
} as const;

function summarizeActions(intent: MessagingSurfaceIntent): ModelInteractionMapperAction[] {
  return actionsForIntent(intent)
    .filter((action) => !action.disabled)
    .map((action, index) => ({
      id: action.id,
      label: action.label,
      ...(action.fallbackText ? { fallbackText: action.fallbackText } : {}),
      index: index + 1,
    }));
}

function buildModelInteractionMapperPayload(params: {
  actions: ModelInteractionMapperAction[];
  intent: ModelInteractionMapperIntentSummary;
  text: string;
}): {
  actions: ModelInteractionMapperAction[];
  intent: ModelInteractionMapperIntentSummary;
  userReply: string;
} {
  return {
    intent: params.intent,
    actions: params.actions,
    userReply: params.text,
  };
}

function buildCodexModelInteractionMapperPrompt(params: {
  actions: ModelInteractionMapperAction[];
  intent: ModelInteractionMapperIntentSummary;
  text: string;
}): string {
  return [
    modelInteractionMapperSystemPrompt.trim(),
    "",
    "Return only JSON matching the provided output schema.",
    "",
    "Context:",
    JSON.stringify(buildModelInteractionMapperPayload(params), null, 2),
  ].join("\n");
}

function summarizeIntent(intent: MessagingSurfaceIntent): ModelInteractionMapperIntentSummary {
  switch (intent.kind) {
    case "approval":
      return {
        kind: intent.kind,
        title: intent.title,
        body: intent.body,
        fallbackText: intent.fallbackText,
      };
    case "confirmation":
      return {
        kind: intent.kind,
        title: intent.title,
        body: intent.body,
        fallbackText: intent.fallbackText,
      };
    case "thread_picker":
    case "project_picker":
    case "single_select":
    case "multi_select":
      return {
        kind: intent.kind,
        prompt: intent.prompt,
        fallbackText: intent.fallbackText,
      };
    case "questionnaire": {
      const question = intent.questions[intent.currentIndex];
      return {
        kind: intent.kind,
        prompt: question?.question,
      };
    }
    case "status":
      return {
        kind: intent.kind,
        body: intent.text,
      };
    default:
      return {
        kind: intent.kind,
      };
  }
}

function normalizeModelResponse(
  object: unknown,
  actions: ModelInteractionMapperAction[],
): ModelInteractionMapperClientResult {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return { status: "failed", reason: "model_response_must_be_object" };
  }
  const record = object as Record<string, unknown>;
  const disposition = record.disposition;
  const confidence = record.confidence;
  if (
    disposition !== "action" &&
    disposition !== "pass_through" &&
    disposition !== "clarify" &&
    disposition !== "ambiguous"
  ) {
    return { status: "failed", reason: "model_response_invalid_disposition" };
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    return { status: "failed", reason: "model_response_invalid_confidence" };
  }
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  if (disposition === "action") {
    const actionId = typeof record.actionId === "string" ? record.actionId : "";
    if (!actions.some((action) => action.id === actionId)) {
      return { status: "failed", reason: "model_response_unknown_action" };
    }
    return {
      status: "ok",
      disposition,
      actionId,
      confidence,
      ...(reason ? { reason } : {}),
    };
  }
  if (disposition === "clarify") {
    const clarification =
      typeof record.clarification === "string" ? record.clarification.trim() : "";
    if (!clarification) {
      return { status: "failed", reason: "model_response_missing_clarification" };
    }
    return {
      status: "ok",
      disposition,
      confidence,
      clarification,
      ...(reason ? { reason } : {}),
    };
  }
  return {
    status: "ok",
    disposition,
    confidence,
    ...(reason ? { reason } : {}),
  };
}
