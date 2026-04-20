import type { ThreadState } from "../app-server/protocol.js";
import type {
  AppServerProvider,
  ProviderActiveTurn,
  ProviderTurnEvent,
  ProviderTurnEventListener,
  ProviderTurnParams,
  ProviderTurnResult,
} from "./provider-contract.js";
import {
  normalizeXaiResponse,
  parseNormalizedFunctionArguments,
  type NormalizedFunctionCall,
} from "./response-normalizer.js";
import {
  buildFunctionCallOutputInput,
  buildXaiFunctionTools,
  buildXaiInput,
  type XaiResponsesClient,
} from "./xai-responses-client.js";
import type {
  ToolApprovalRequest,
  ToolExecutionContext,
  ToolExecutor,
} from "../tools/tool-contract.js";
import { ToolError } from "../tools/tool-errors.js";

const DEFAULT_MAX_TOOL_ROUNDS = 100;

type StartResponsesToolLoopOptions = {
  client: XaiResponsesClient;
  params: ProviderTurnParams;
  maxToolRounds?: number;
};

type ToolExecutionResult = Awaited<ReturnType<ToolExecutor["executeTool"]>>;
type ProviderItemEventItem = Extract<
  ProviderTurnEvent,
  { type: "item_started" | "item_completed" }
>["item"];

export function startResponsesToolLoop(
  options: StartResponsesToolLoopOptions,
): ProviderActiveTurn {
  const listeners = new Set<ProviderTurnEventListener>();
  const abortController = new AbortController();

  const emit = async (event: ProviderTurnEvent): Promise<void> => {
    for (const listener of [...listeners]) {
      await listener(event);
    }
  };

  return {
    result: runResponsesToolLoop({
      client: options.client,
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

async function runResponsesToolLoop(params: {
  client: XaiResponsesClient;
  params: ProviderTurnParams;
  maxToolRounds: number;
  signal: AbortSignal;
  emit: (event: ProviderTurnEvent) => Promise<void>;
  hasListeners: () => boolean;
}): Promise<ProviderTurnResult> {
  const tools = params.params.tools?.listTools() ?? [];
  const xaiTools = tools.length > 0 ? buildXaiFunctionTools(tools) : undefined;
  let response = await params.client.createResponse({
    model: params.params.thread.model,
    input: buildXaiInput(params.params.input),
    previousResponseId: params.params.previousResponseId,
    tools: xaiTools,
    signal: params.signal,
  });

  for (let round = 0; ; round += 1) {
    throwIfAborted(params.signal);
    const normalized = normalizeXaiResponse(response);
    if (normalized.functionCalls.length === 0) {
      return {
        assistantText: normalized.assistantText,
        providerResponseId: normalized.providerResponseId,
      };
    }
    if (round >= params.maxToolRounds) {
      throw new Error(
        `Grok tool loop exceeded the maximum round limit (${params.maxToolRounds}) before round ${round + 1}`,
      );
    }
    if (!normalized.providerResponseId) {
      throw new Error("Grok tool loop requires a response id before continuing");
    }

    const toolOutputs: Array<Record<string, unknown>> = [];
    for (const functionCall of normalized.functionCalls) {
      const startedItem = buildStartedItem(functionCall);
      await params.emit({
        type: "item_started",
        item: startedItem,
      });

      const execution = await executeFunctionCall({
        functionCall,
        thread: params.params.thread,
        tools: params.params.tools,
        signal: params.signal,
        emit: params.emit,
        hasListeners: params.hasListeners,
      });

      await params.emit({
        type: "item_completed",
        item: {
          id: functionCall.callId,
          type: execution.item.type,
          text: execution.item.text,
          command: execution.item.command,
          commandAction: execution.item.commandAction,
          toolName: execution.toolName,
          success: execution.success,
          arguments: execution.arguments,
          data: execution.item.type === "commandExecution" ? execution.data : undefined,
        },
      });

      toolOutputs.push(
        buildFunctionCallOutputInput(
          functionCall.callId,
          JSON.stringify({
            toolName: execution.toolName,
            success: execution.success,
            output: execution.output,
            data: execution.data ?? null,
            errorCode: execution.errorCode ?? null,
          }),
        ),
      );
    }

    response = await params.client.createResponse({
      model: params.params.thread.model,
      input: toolOutputs,
      previousResponseId: normalized.providerResponseId,
      tools: xaiTools,
      signal: params.signal,
    });
  }
}

async function executeFunctionCall(params: {
  functionCall: NormalizedFunctionCall;
  thread: ThreadState;
  tools?: ToolExecutor;
  signal: AbortSignal;
  emit: (event: ProviderTurnEvent) => Promise<void>;
  hasListeners: () => boolean;
}): Promise<ToolExecutionResult> {
  const parsedArguments = tryParseFunctionArguments(
    params.functionCall.name,
    params.functionCall.argumentsText,
  );

  if (parsedArguments instanceof ToolError) {
    return {
      toolName: params.functionCall.name,
      arguments: {},
      success: false,
      output: parsedArguments.message,
      errorCode: parsedArguments.code,
      item: {
        type: itemTypeForToolName(params.functionCall.name),
        text: parsedArguments.message,
        toolName: params.functionCall.name,
        success: false,
        arguments: {},
        command: extractCommand(undefined),
      },
    };
  }

  if (!params.tools) {
    const error = new ToolError(
      "tool_executor_missing",
      `No local tool executor is available for ${params.functionCall.name}`,
    );
    return {
      toolName: params.functionCall.name,
      arguments: parsedArguments,
      success: false,
      output: error.message,
      errorCode: error.code,
      item: {
        type: itemTypeForToolName(params.functionCall.name),
        text: error.message,
        toolName: params.functionCall.name,
        success: false,
        arguments: parsedArguments,
        command: extractCommand(parsedArguments),
      },
    };
  }

  const executionContext: ToolExecutionContext = {
    cwd: params.thread.cwd,
    threadId: params.thread.threadId,
    approvalPolicy: params.thread.approvalPolicy,
    sandbox: params.thread.sandbox,
    signal: params.signal,
    onOutputDelta: (delta) => {
      void params.emit({
        type: "item_command_output_delta",
        itemId: params.functionCall.callId,
        delta: delta.text,
        stream: delta.stream,
        bytes: delta.bytes,
      });
    },
    requestApproval: async (request) =>
      await requestToolApprovalFromProvider({
        request,
        emit: params.emit,
        hasListeners: params.hasListeners,
        signal: params.signal,
      }),
  };

  return await params.tools.executeTool(
    {
      name: params.functionCall.name,
      arguments: parsedArguments,
    },
    executionContext,
  );
}

function buildStartedItem(functionCall: NormalizedFunctionCall): ProviderItemEventItem {
  const parsedArguments = tryParseFunctionArguments(
    functionCall.name,
    functionCall.argumentsText,
  );
  const arguments_ = parsedArguments instanceof ToolError ? undefined : parsedArguments;
  return {
    id: functionCall.callId,
    type: itemTypeForToolName(functionCall.name),
    text: functionCall.name,
    toolName: functionCall.name,
    arguments: arguments_,
    command: extractCommand(arguments_),
  };
}

async function requestToolApprovalFromProvider(params: {
  request: ToolApprovalRequest;
  emit: (event: ProviderTurnEvent) => Promise<void>;
  hasListeners: () => boolean;
  signal: AbortSignal;
}): Promise<unknown> {
  if (params.signal.aborted || !params.hasListeners()) {
    return { decision: "decline" };
  }
  return await new Promise<unknown>((resolve) => {
    let settled = false;
    const finish = (response: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      params.signal.removeEventListener("abort", onAbort);
      resolve(response);
    };
    const onAbort = () => finish({ decision: "cancel" });
    params.signal.addEventListener("abort", onAbort, { once: true });
    void params.emit({
      type: "request_input",
      requestId: params.request.requestId,
      method: "turn/requestApproval",
      params: {
        kind: params.request.kind,
        reason: params.request.reason,
        path: params.request.path,
        command: params.request.command,
        commandAction: params.request.commandAction,
      },
      respond: async (response) => {
        finish(response);
      },
    });
  });
}

function tryParseFunctionArguments(
  toolName: string,
  argumentsText: string,
): Record<string, unknown> | ToolError {
  try {
    return parseNormalizedFunctionArguments(toolName, argumentsText);
  } catch (error) {
    return error instanceof ToolError
      ? error
      : new ToolError(
          "tool_arguments_invalid",
          `${toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  }
}

function itemTypeForToolName(toolName: string): "dynamicToolCall" | "commandExecution" {
  return toolName === "shell_command" ? "commandExecution" : "dynamicToolCall";
}

function extractCommand(
  arguments_: Record<string, unknown> | undefined,
): string | undefined {
  return typeof arguments_?.command === "string" ? arguments_.command : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Grok turn was interrupted");
  }
}
