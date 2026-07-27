import { APICallError, stepCountIs } from "ai";
import type { AppServerProvider, ProviderActiveTurn, ProviderTurnEventListener, ProviderTurnParams, ProviderTurnResult } from "./provider-contract.js";
import { buildAiSdkMessages } from "./ai-sdk-message-builder.js";
import { createAiSdkTools } from "./ai-sdk-tool-adapter.js";
import { normalizeAiSdkSources, normalizeProviderMetadata } from "./ai-sdk-sources.js";
import { buildXaiProviderOptions, XaiAiSdkRuntime, type XaiAiSdkRuntimeOptions } from "./xai-ai-sdk-runtime.js";

export type GrokProviderOptions = XaiAiSdkRuntimeOptions & {
  maxToolRounds?: number;
};

const DEFAULT_MAX_TOOL_ROUNDS = 12;
const MAX_RETRY_TOOL_OUTPUT_CHARS = 8_000;
const MAX_PROVIDER_ERROR_CHARS = 2_000;

type AiSdkStreamTextResult = {
  text: PromiseLike<string>;
  response: PromiseLike<{ id?: string }>;
  sources?: PromiseLike<unknown[]>;
  providerMetadata?: PromiseLike<unknown>;
  steps?: PromiseLike<AiSdkStep[]>;
};

type AiSdkStep = {
  toolResults?: Array<{
    output?: unknown;
  }>;
};

export class GrokProvider implements AppServerProvider {
  private readonly runtime: XaiAiSdkRuntime;
  private readonly maxToolRounds?: number;

  constructor(options: GrokProviderOptions) {
    this.runtime = new XaiAiSdkRuntime(options);
    this.maxToolRounds = options.maxToolRounds;
  }

  startTurn(params: ProviderTurnParams): ProviderActiveTurn {
    return startAiSdkTurn({
      runtime: this.runtime,
      params,
      maxToolRounds: this.maxToolRounds,
    });
  }
}

function startAiSdkTurn(options: {
  runtime: XaiAiSdkRuntime;
  params: ProviderTurnParams;
  maxToolRounds?: number;
}): ProviderActiveTurn {
  const listeners = new Set<ProviderTurnEventListener>();
  const abortController = new AbortController();

  const emit = async (event: Parameters<ProviderTurnEventListener>[0]): Promise<void> => {
    for (const listener of [...listeners]) {
      await listener(event);
    }
  };

  return {
    result: runAiSdkTurn({
      runtime: options.runtime,
      params: options.params,
      maxToolRounds: options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
      signal: abortController.signal,
      emit,
      hasListeners: () => listeners.size > 0,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    steer: async () => {
      throw new Error("GrokProvider does not support steering active turns yet");
    },
    interrupt: async () => {
      abortController.abort();
    },
  };
}

async function runAiSdkTurn(params: {
  runtime: XaiAiSdkRuntime;
  params: ProviderTurnParams;
  maxToolRounds: number;
  signal: AbortSignal;
  emit: (event: Parameters<ProviderTurnEventListener>[0]) => Promise<void>;
  hasListeners: () => boolean;
}): Promise<ProviderTurnResult> {
  let streamErrorMessage: string | undefined;
  const messages = await buildAiSdkMessages({
    history: params.params.previousResponseId ? undefined : params.params.history,
    input: params.params.input,
  });
  const result = params.runtime.streamText({
    model: params.runtime.model({ model: params.params.thread.model }),
    messages,
    tools: createAiSdkTools({
      runtime: params.runtime,
      thread: params.params.thread,
      tools: params.params.tools,
      signal: params.signal,
      emit: params.emit,
      hasListeners: params.hasListeners,
    }),
    abortSignal: params.signal,
    stopWhen: stepCountIs(params.maxToolRounds),
    providerOptions: buildXaiProviderOptions({
      model: params.params.thread.model,
      reasoningEffort: params.params.thread.reasoningEffort,
      previousResponseId: params.params.previousResponseId,
    }),
    onError: ({ error }: { error: unknown }) => {
      streamErrorMessage ??= formatProviderStreamError(error);
    },
  }) as AiSdkStreamTextResult;

  let assistantText: string;
  let response: { id?: string };
  let sources: unknown[];
  let providerMetadata: unknown;
  let steps: AiSdkStep[];
  try {
    [assistantText, response, sources, providerMetadata, steps] =
      await Promise.all([
        result.text,
        result.response,
        result.sources ?? Promise.resolve([]),
        result.providerMetadata ?? Promise.resolve(undefined),
        result.steps ?? Promise.resolve([]),
      ]);
  } catch (error) {
    if (streamErrorMessage) {
      // The original AI SDK error can retain request bodies. Preserve only the
      // sanitized diagnostic instead of attaching the caught error as `cause`.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(streamErrorMessage);
    }
    throw error;
  }
  const finalResult = assistantText.trim()
    ? { assistantText, response, sources, providerMetadata }
    : await retryFinalText({
        runtime: params.runtime,
        params: params.params,
        signal: params.signal,
        messages,
        toolOutputs: collectToolOutputs(steps),
      });

  return {
    assistantText: finalResult.assistantText,
    providerResponseId: finalResult.response.id,
    sources: normalizeAiSdkSources(finalResult.sources),
    providerMetadata: normalizeProviderMetadata(finalResult.providerMetadata),
  };
}

function formatProviderStreamError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const status =
      error.statusCode === undefined ? "" : ` (HTTP ${error.statusCode})`;
    const detail = sanitizeProviderErrorText(
      error.responseBody?.trim() || error.message,
    );
    return detail
      ? `xAI stream request failed${status}: ${detail}`
      : `xAI stream request failed${status}`;
  }

  const detail = sanitizeProviderErrorText(
    error instanceof Error ? error.message : String(error),
  );
  return detail ? `xAI stream failed: ${detail}` : "xAI stream failed";
}

function sanitizeProviderErrorText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Z0-9_]*|api[-_ ]?key)["']?\s*(?:[:=]\s*|\s+))("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROVIDER_ERROR_CHARS);
}

async function retryFinalText(params: {
  runtime: XaiAiSdkRuntime;
  params: ProviderTurnParams;
  signal: AbortSignal;
  messages: unknown[];
  toolOutputs: string[];
}): Promise<{
  assistantText: string;
  response: { id?: string };
  sources: unknown[];
  providerMetadata: unknown;
}> {
  const result = await params.runtime.generateText({
    model: params.runtime.model({ model: params.params.thread.model }),
    messages: [
      ...params.messages,
      {
        role: "user",
        content: buildRetryPrompt(params.toolOutputs),
      },
    ],
    abortSignal: params.signal,
    providerOptions: buildXaiProviderOptions({
      model: params.params.thread.model,
      reasoningEffort: params.params.thread.reasoningEffort,
      previousResponseId: params.params.previousResponseId,
    }),
  });

  return {
    assistantText: readTextResult(result),
    response: readResponseResult(result),
    sources: readArrayResult(result, "sources"),
    providerMetadata: readRecordResult(result, "providerMetadata"),
  };
}

function buildRetryPrompt(toolOutputs: string[]): string {
  if (toolOutputs.length === 0) {
    return [
      "The previous response did not include user-visible assistant text.",
      "Produce the final answer requested by the user.",
      "Do not include reasoning or hidden deliberation.",
    ].join(" ");
  }

  return [
    "The previous tool call completed, but no user-visible assistant text was emitted.",
    "Produce the final answer requested by the user using only the tool results below.",
    "Do not include reasoning or hidden deliberation.",
    "",
    "Tool results:",
    toolOutputs.map((output, index) => `Result ${index + 1}:\n${output}`).join("\n\n"),
  ].join("\n");
}

function collectToolOutputs(steps: AiSdkStep[]): string[] {
  return steps
    .flatMap((step) => step.toolResults ?? [])
    .map((result) => formatToolOutput(result.output))
    .filter((output): output is string => Boolean(output?.trim()))
    .map((output) => truncate(output, MAX_RETRY_TOOL_OUTPUT_CHARS));
}

function formatToolOutput(output: unknown): string | undefined {
  if (typeof output === "string") {
    return output;
  }
  if (output && typeof output === "object" && "output" in output) {
    const nested = (output as { output?: unknown }).output;
    if (typeof nested === "string") {
      return nested;
    }
  }
  if (!output) {
    return undefined;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}

function readTextResult(value: unknown): string {
  return value && typeof value === "object" && "text" in value
    ? String((value as { text?: unknown }).text ?? "")
    : "";
}

function readResponseResult(value: unknown): { id?: string } {
  if (!value || typeof value !== "object") {
    return {};
  }
  const response = (value as { response?: unknown }).response;
  return response && typeof response === "object" ? (response as { id?: string }) : {};
}

function readArrayResult(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const array = (value as Record<string, unknown>)[key];
  return Array.isArray(array) ? array : [];
}

function readRecordResult(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
