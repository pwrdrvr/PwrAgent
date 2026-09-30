import type { AcpJsonRpcTransport } from "./acp-client.js";

/**
 * One prompt against an ACP agent on a transport the caller owns and closes:
 * a dedicated agent process, not the pooled client. Nothing the session does
 * reaches that client, so it writes no session or rollout row, feeds no
 * normalizer, and emits nothing to a window. A shared client cannot promise
 * that: an agent reports some updates, such as its command list, before
 * `session/new` answers with the id they belong to.
 *
 * Every request the agent makes of the client is refused, and a permission
 * request is answered `cancelled`. That alone does not make a session
 * tool-less: Grok runs read-only tools without asking in every permission
 * mode, so the caller's `sessionMeta` has to remove the tools themselves.
 */
export type AcpEphemeralPromptRequest = {
  /** A directory the operator does not work in; agents key history by cwd. */
  cwd: string;
  prompt: string;
  /** `_meta` for `session/new`, such as a Grok agent profile. */
  sessionMeta?: Record<string, unknown>;
  /** Must be offered by the agent; another model is never substituted. */
  model?: string;
  /** Applied only when the selected model offers it. */
  reasoningEffort?: string;
  /** The whole run, from `initialize` to the answer. */
  timeoutMs: number;
  /** Answer characters. A longer answer cancels the turn. */
  maxOutputChars: number;
  /**
   * Agent methods that forget a closed session, called with `{ sessionId }`.
   * `session/close` ends a session but Grok still lists it afterwards.
   */
  discardMethods?: readonly string[];
};

export type AcpEphemeralPromptResult = {
  text: string;
  /** The model that answered, as the agent reported it. */
  model?: string;
  /** Requests the agent made of the client, all refused. */
  refusedRequests: number;
};

export type AcpEphemeralPromptFailure =
  | "timeout"
  | "output_limit"
  | "model_unavailable"
  | "stopped"
  | "protocol";

export class AcpEphemeralPromptError extends Error {
  constructor(
    readonly failure: AcpEphemeralPromptFailure,
    message: string,
  ) {
    super(message);
    this.name = "AcpEphemeralPromptError";
  }
}

/** Each cleanup request's budget, so a wedged agent cannot hold the caller. */
const CLEANUP_REQUEST_TIMEOUT_MS = 5_000;

export async function runAcpEphemeralPrompt(
  transport: AcpJsonRpcTransport,
  request: AcpEphemeralPromptRequest,
): Promise<AcpEphemeralPromptResult> {
  if (!transport.onRequest) {
    // Without a request handler the agent's permission requests would go
    // unanswered by us, and the transport decides what that means.
    throw new AcpEphemeralPromptError(
      "protocol",
      "The agent transport cannot refuse permission requests.",
    );
  }
  let sessionId: string | undefined;
  let closeSupported = false;
  let refusedRequests = 0;
  let collecting = false;
  let text = "";
  // Set once the race is lost, so a late `session/new` goes no further.
  let abandoned = false;
  let sessionSettled: () => void = () => undefined;
  const sessionStarted = new Promise<void>((resolve) => {
    sessionSettled = resolve;
  });
  let fail: (error: AcpEphemeralPromptError) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const unsubscribeRequest = transport.onRequest((method) => {
    refusedRequests += 1;
    if (method === "session/request_permission") {
      return { outcome: { outcome: "cancelled" } };
    }
    throw new Error(`${method} is not available to this session`);
  });
  const unsubscribeNotification = transport.onNotification((method, params) => {
    // The process serves this one session, so every update is ours.
    if (!collecting || method !== "session/update") {
      return;
    }
    const update = asRecord(params.update);
    if (update?.sessionUpdate !== "agent_message_chunk") {
      return;
    }
    const content = asRecord(update.content);
    if (content?.type !== "text" || typeof content.text !== "string") {
      return;
    }
    text += content.text;
    if (text.length > request.maxOutputChars) {
      fail(new AcpEphemeralPromptError(
        "output_limit",
        `The answer passed ${request.maxOutputChars.toLocaleString("en-US")} characters.`,
      ));
    }
  });
  const timer = setTimeout(() => {
    fail(new AcpEphemeralPromptError(
      "timeout",
      `No answer within ${Math.ceil(request.timeoutMs / 1_000)} s.`,
    ));
  }, request.timeoutMs);
  timer.unref?.();

  const run = async (): Promise<AcpEphemeralPromptResult> => {
    const initialized = asRecord(await transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "pwragent", title: "PwrAgent", version: "0.0.0" },
    }));
    closeSupported = asRecord(asRecord(asRecord(initialized?.agentCapabilities)
      ?.sessionCapabilities)?.close) !== undefined;
    let created: Record<string, unknown> | undefined;
    try {
      created = asRecord(await transport.request("session/new", {
        cwd: request.cwd,
        mcpServers: [],
        ...(request.sessionMeta ? { _meta: request.sessionMeta } : {}),
      }));
    } finally {
      const createdId = created?.sessionId ?? created?.session_id;
      if (typeof createdId === "string" && createdId) {
        sessionId = createdId;
      }
      sessionSettled();
    }
    if (!sessionId) {
      throw new AcpEphemeralPromptError("protocol", "The agent started no session.");
    }
    if (abandoned) {
      throw new AcpEphemeralPromptError("protocol", "The run ended before the session started.");
    }
    let configOptions = readConfigOptions(created);
    let model = readCurrentModel(created, configOptions);
    if (request.model && request.model !== model) {
      const modelOption = configOptions.find((option) => option.category === "model");
      if (modelOption && optionOffers(modelOption, request.model)) {
        // The reply is the new model's menu; its efforts can differ.
        const reply = readConfigOptions(await transport.request("session/set_config_option", {
          sessionId, configId: modelOption.id, value: request.model,
        }));
        configOptions = reply.length ? reply : configOptions;
      } else if (!modelOption && modelsOffer(created, request.model)) {
        await transport.request("session/set_model", { sessionId, modelId: request.model });
      } else {
        throw new AcpEphemeralPromptError(
          "model_unavailable",
          `The agent does not offer the model ${request.model}.`,
        );
      }
      model = request.model;
    }
    const effortOption = configOptions.find((option) => option.category === "thought_level");
    if (
      request.reasoningEffort
      && effortOption
      && effortOption.currentValue !== request.reasoningEffort
      && optionOffers(effortOption, request.reasoningEffort)
    ) {
      // The effort is a cost preference, not a condition of the answer.
      await transport.request("session/set_config_option", {
        sessionId, configId: effortOption.id, value: request.reasoningEffort,
      }).catch(() => undefined);
    }
    if (abandoned) {
      throw new AcpEphemeralPromptError("protocol", "The run ended before the prompt.");
    }
    collecting = true;
    const prompted = asRecord(await transport.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: request.prompt }] },
      request.timeoutMs,
    ));
    collecting = false;
    const stopReason = prompted?.stopReason;
    if (stopReason !== "end_turn") {
      throw new AcpEphemeralPromptError(
        "stopped",
        `The agent stopped the turn (${typeof stopReason === "string" ? stopReason : "no reason"}).`,
      );
    }
    const reportedModel = asRecord(prompted?._meta)?.modelId;
    return {
      text: text.trim(),
      ...(typeof reportedModel === "string" && reportedModel
        ? { model: reportedModel }
        : model ? { model } : {}),
      refusedRequests,
    };
  };

  const running = run();
  // A run that loses the race still settles; nothing is waiting for it.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, failed]);
  } catch (error) {
    abandoned = true;
    if (!sessionId) {
      // A deadline can pass while `session/new` is in flight. The agent may
      // still create that session, so wait for its id to discard it.
      await bounded(sessionStarted);
    }
    if (
      sessionId
      && error instanceof AcpEphemeralPromptError
      && (error.failure === "timeout" || error.failure === "output_limit")
    ) {
      await bounded(transport.notify?.("session/cancel", { sessionId }));
    }
    throw error instanceof AcpEphemeralPromptError
      ? error
      : new AcpEphemeralPromptError(
          "protocol",
          error instanceof Error ? error.message : String(error),
        );
  } finally {
    clearTimeout(timer);
    collecting = false;
    unsubscribeNotification();
    unsubscribeRequest();
    if (sessionId) {
      const params = { sessionId };
      if (closeSupported) {
        await bounded(transport.request("session/close", params, CLEANUP_REQUEST_TIMEOUT_MS));
      }
      for (const method of request.discardMethods ?? []) {
        await bounded(transport.request(method, params, CLEANUP_REQUEST_TIMEOUT_MS));
      }
    }
  }
}

type ConfigOption = {
  id: string;
  category?: string;
  currentValue?: unknown;
  options: unknown[];
};

function readConfigOptions(value: unknown): ConfigOption[] {
  const options = asRecord(value)?.configOptions;
  if (!Array.isArray(options)) {
    return [];
  }
  return options.flatMap((item) => {
    const option = asRecord(item);
    return option && typeof option.id === "string"
      ? [{
          id: option.id,
          ...(typeof option.category === "string" ? { category: option.category } : {}),
          currentValue: option.currentValue,
          options: Array.isArray(option.options) ? option.options : [],
        }]
      : [];
  });
}

/** Flat `{ value }` entries, or `{ group, options }` groups of them. */
function optionOffers(option: ConfigOption, value: string): boolean {
  return option.options.some((item) => {
    const entry = asRecord(item);
    return entry?.value === value
      || (Array.isArray(entry?.options)
        && entry.options.some((nested) => asRecord(nested)?.value === value));
  });
}

function readCurrentModel(created: Record<string, unknown> | undefined, configOptions: ConfigOption[]): string | undefined {
  const option = configOptions.find((item) => item.category === "model");
  const current = option?.currentValue ?? asRecord(created?.models)?.currentModelId;
  return typeof current === "string" ? current : undefined;
}

function modelsOffer(created: Record<string, unknown> | undefined, model: string): boolean {
  const available = asRecord(created?.models)?.availableModels;
  return Array.isArray(available)
    && available.some((item) => asRecord(item)?.modelId === model);
}

/** Best effort, and never longer than one cleanup budget. */
async function bounded(operation: Promise<unknown> | undefined): Promise<void> {
  if (!operation) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLEANUP_REQUEST_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // The agent process is closed next either way.
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
