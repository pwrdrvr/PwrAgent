import { stepCountIs } from "ai";
import type { AppServerProvider, ProviderActiveTurn, ProviderTurnEventListener, ProviderTurnParams, ProviderTurnResult } from "./provider-contract.js";
import { buildAiSdkMessages } from "./ai-sdk-message-builder.js";
import { createAiSdkTools } from "./ai-sdk-tool-adapter.js";
import { normalizeAiSdkSources, normalizeProviderMetadata } from "./ai-sdk-sources.js";
import { buildXaiProviderOptions, XaiAiSdkRuntime, type XaiAiSdkRuntimeOptions } from "./xai-ai-sdk-runtime.js";

export type GrokProviderOptions = XaiAiSdkRuntimeOptions & {
  maxToolRounds?: number;
};

const DEFAULT_MAX_TOOL_ROUNDS = 12;

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
  }) as {
    text: PromiseLike<string>;
    response: PromiseLike<{ id?: string }>;
    sources?: PromiseLike<unknown[]>;
    providerMetadata?: PromiseLike<unknown>;
  };

  const [assistantText, response, sources, providerMetadata] = await Promise.all([
    result.text,
    result.response,
    result.sources ?? Promise.resolve([]),
    result.providerMetadata ?? Promise.resolve(undefined),
  ]);

  return {
    assistantText,
    providerResponseId: response.id,
    sources: normalizeAiSdkSources(sources),
    providerMetadata: normalizeProviderMetadata(providerMetadata),
  };
}
