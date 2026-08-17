import { randomUUID } from "node:crypto";
import {
  TOKEN_MISER_DEFAULT_THRESHOLD_CHARACTERS,
  estimateTokenCount,
  serializeToolResponse,
  type TokenMiserHelperUsage,
  type TokenMiserHookOutput,
  type TokenMiserObjectMetadata,
  type TokenMiserPostToolUsePayload,
  type TokenMiserSummary,
} from "./token-miser-types.js";
import { TokenMiserStore } from "./token-miser-store.js";

const TOKEN_MISER_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "usefulDetails", "suggestedNextStep"],
  properties: {
    summary: {
      type: "string",
      minLength: 1,
      description: "A concise factual summary of what the tool returned.",
    },
    usefulDetails: {
      type: "array",
      maxItems: 8,
      items: { type: "string" },
      description: "Specific filenames, errors, counts, identifiers, or findings worth retaining.",
    },
    suggestedNextStep: {
      type: "string",
      minLength: 1,
      description: "How the parent should narrow the next lookup, or say no lookup is needed.",
    },
  },
} as const;

const TOKEN_MISER_SYSTEM_PROMPT = [
  "You are Token Miser, the first gate on tool output entering a parent coding agent's context.",
  "The complete output is preserved outside the parent context and can be searched or read later.",
  "Summarize only what is present. Preserve exact filenames, identifiers, errors, counts, and commands that help the parent decide what to inspect next.",
  "Do not repeat long passages. Do not give general advice. Keep the complete response under 450 words.",
].join("\n");

export type TokenMiserStructuredGenerationResult =
  | ({ status: "ok"; object: unknown } & TokenMiserHelperUsage)
  | { status: "unavailable" | "failed"; reason: string };

export type TokenMiserServiceOptions = {
  store: TokenMiserStore;
  isEnabled: () => boolean;
  generateSummary: (params: {
    model: string;
    reasoningEffort: "medium";
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    timeoutMs: number;
  }) => Promise<TokenMiserStructuredGenerationResult>;
  onInterceptionStored?: (
    metadata: TokenMiserObjectMetadata,
  ) => void | Promise<void>;
  thresholdCharacters?: number;
  summaryTimeoutMs?: number;
};

export class TokenMiserService {
  private readonly thresholdCharacters: number;
  private readonly summaryTimeoutMs: number;

  constructor(private readonly options: TokenMiserServiceOptions) {
    this.thresholdCharacters =
      options.thresholdCharacters ?? TOKEN_MISER_DEFAULT_THRESHOLD_CHARACTERS;
    this.summaryTimeoutMs = options.summaryTimeoutMs ?? 45_000;
  }

  async handlePostToolUse(
    payload: TokenMiserPostToolUsePayload,
  ): Promise<TokenMiserHookOutput | undefined> {
    if (!this.options.isEnabled()) {
      return undefined;
    }
    const output = serializeToolResponse(payload.tool_response);
    if (output.length <= this.thresholdCharacters) {
      return undefined;
    }

    const generated = await this.options.generateSummary({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      system: TOKEN_MISER_SYSTEM_PROMPT,
      prompt: buildSummaryPrompt(payload, output),
      schema: TOKEN_MISER_SUMMARY_SCHEMA,
      timeoutMs: this.summaryTimeoutMs,
    });
    if (generated.status !== "ok") {
      return undefined;
    }
    const summary = parseSummary(generated.object);
    if (!summary) {
      return undefined;
    }

    const objectId = randomUUID();
    const replacement = buildReplacement({
      objectId,
      toolName: payload.tool_name,
      outputCharacters: output.length,
      summary,
    });
    const metadata = await this.options.store.store({
      objectId,
      threadId: payload.session_id,
      turnId: payload.turn_id,
      toolUseId: payload.tool_use_id,
      toolName: payload.tool_name,
      output,
      replacementCharacters: replacement.length,
      summary,
      helperUsage: {
        helperThreadId: generated.helperThreadId,
        helperTurnId: generated.helperTurnId,
        model: generated.model,
        reasoningEffort: generated.reasoningEffort,
        serviceTier: generated.serviceTier,
        tokenUsage: generated.tokenUsage,
      },
    });
    await this.options.onInterceptionStored?.(metadata);

    return {
      continue: false,
      stopReason: replacement,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: replacement,
      },
    };
  }
}

function buildSummaryPrompt(
  payload: TokenMiserPostToolUsePayload,
  output: string,
): string {
  return [
    `Tool: ${payload.tool_name}`,
    `Tool input: ${serializeToolResponse(payload.tool_input)}`,
    `Output characters: ${output.length}`,
    "",
    "Tool output:",
    output,
  ].join("\n");
}

function buildReplacement(params: {
  objectId: string;
  toolName: string;
  outputCharacters: number;
  summary: TokenMiserSummary;
}): string {
  const estimatedTokens = estimateTokenCount(params.outputCharacters);
  const details = params.summary.usefulDetails.length > 0
    ? params.summary.usefulDetails.map((detail) => `- ${detail}`).join("\n")
    : "- No additional details were retained by the summary gate.";
  return [
    `Token Miser intercepted a large ${params.toolName} result (${params.outputCharacters.toLocaleString()} characters, about ${estimatedTokens.toLocaleString()} tokens before the model-visible cap).`,
    "",
    params.summary.summary,
    "",
    "Useful details:",
    details,
    "",
    `Suggested next step: ${params.summary.suggestedNextStep}`,
    "",
    `The exact model-facing tool result is preserved as Token Miser output ${params.objectId}. Use pwragent.search_token_miser_output or pwragent.read_token_miser_output for selected lines. Use pwragent.read_all_token_miser_output only when the complete result is necessary.`,
  ].join("\n");
}

function parseSummary(value: unknown): TokenMiserSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== "string"
    || !record.summary.trim()
    || typeof record.suggestedNextStep !== "string"
    || !record.suggestedNextStep.trim()
    || !Array.isArray(record.usefulDetails)
    || !record.usefulDetails.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  return {
    summary: record.summary.trim(),
    usefulDetails: record.usefulDetails
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 8),
    suggestedNextStep: record.suggestedNextStep.trim(),
  };
}
