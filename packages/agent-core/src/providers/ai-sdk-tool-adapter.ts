import { jsonSchema, tool, type ToolSet } from "ai";
import type { ThreadState } from "../app-server/protocol.js";
import type {
  ToolExecutionContext,
  ToolExecutor,
  ToolInputSchema,
} from "../tools/tool-contract.js";
import { ToolError } from "../tools/tool-errors.js";
import type { ProviderSource, ProviderTurnEvent } from "./provider-contract.js";
import type { XaiAiSdkRuntime } from "./xai-ai-sdk-runtime.js";
import { normalizeAiSdkSources } from "./ai-sdk-sources.js";

type EmitProviderEvent = (event: ProviderTurnEvent) => Promise<void>;
const SEARCH_TOOL_MAX_FINDINGS = 5;

export function createAiSdkTools(params: {
  runtime: XaiAiSdkRuntime;
  thread: ThreadState;
  tools?: ToolExecutor;
  signal: AbortSignal;
  emit: EmitProviderEvent;
  hasListeners: () => boolean;
}): ToolSet | undefined {
  const toolSet: ToolSet = {};
  for (const descriptor of params.tools?.listTools() ?? []) {
    toolSet[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(toJsonSchema(descriptor.inputSchema)),
      execute: async (input, options) => {
        const arguments_ = asRecord(input);
        await params.emit({
          type: "item_started",
          item: {
            id: options.toolCallId,
            type: itemTypeForToolName(descriptor.name),
            text: descriptor.name,
            toolName: descriptor.name,
            arguments: arguments_,
            command: extractCommand(arguments_),
          },
        });
        const executionContext = buildToolExecutionContext({
          thread: params.thread,
          toolCallId: options.toolCallId,
          signal: options.abortSignal ?? params.signal,
          emit: params.emit,
          hasListeners: params.hasListeners,
        });
        const execution = await params.tools?.executeTool(
          {
            name: descriptor.name,
            arguments: arguments_,
          },
          executionContext,
        );
        if (!execution) {
          throw new ToolError(
            "tool_executor_missing",
            `No local tool executor is available for ${descriptor.name}`,
          );
        }
        const sources = normalizeAiSdkSources(execution.data?.sources);
        await params.emit({
          type: "item_completed",
          item: {
            id: options.toolCallId,
            type: execution.item.type,
            text: execution.item.text,
            command: execution.item.command,
            commandAction: execution.item.commandAction,
            toolName: execution.toolName,
            success: execution.success,
            arguments: execution.arguments,
            data: execution.data,
            sources: sources.length > 0 ? sources : undefined,
          },
        });
        return {
          toolName: execution.toolName,
          success: execution.success,
          output: execution.output,
          data: execution.data ?? null,
          errorCode: execution.errorCode ?? null,
        };
      },
    });
  }

  toolSet.search_web = createWebSearchTool({
    runtime: params.runtime,
    emit: params.emit,
  });
  toolSet.search_x = createXSearchTool({
    runtime: params.runtime,
    emit: params.emit,
  });

  return Object.keys(toolSet).length > 0 ? toolSet : undefined;
}

function createWebSearchTool(params: {
  runtime: XaiAiSdkRuntime;
  emit: EmitProviderEvent;
}) {
  return tool({
    description:
      "Search the web using xAI server-side web search. Set includeImages when the user asks about images found during search.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "The web search query." },
        allowedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to include, max 5.",
        },
        excludedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to exclude, max 5.",
        },
        includeImages: {
          type: "boolean",
          description: "Enable image understanding for pages/images found during search.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async (input, options) => {
      return await executeSearchTool({
        name: "search_web",
        input,
        toolCallId: options.toolCallId,
        signal: options.abortSignal,
        timeoutMs: params.runtime.searchToolTimeoutMs,
        emit: params.emit,
        run: async (args, signal) => {
          if (args.allowedDomains && args.excludedDomains) {
            throw new ToolError(
              "invalid_tool_arguments",
              "search_web cannot set both allowedDomains and excludedDomains",
            );
          }
          const result = await params.runtime.generateText({
            model: params.runtime.searchModel(),
            system: buildNestedSearchSystemPrompt("web"),
            prompt: buildNestedSearchPrompt(args.query),
            abortSignal: signal,
            toolChoice: "required",
            tools: {
              web_search: params.runtime.provider.tools.webSearch({
                allowedDomains: args.allowedDomains,
                excludedDomains: args.excludedDomains,
                enableImageUnderstanding: args.includeImages,
              }),
            },
          });
          const text = readTextResult(result);
          const sources = normalizeAiSdkSources(readResultArray(result, "sources"));
          return buildSearchOutput({ text, sources });
        },
      });
    },
  });
}

function createXSearchTool(params: {
  runtime: XaiAiSdkRuntime;
  emit: EmitProviderEvent;
}) {
  return tool({
    description:
      "Search X using xAI server-side X search. Set includeImages or includeVideos when the user asks about images or videos in posts.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "The X search query." },
        allowedXHandles: {
          type: "array",
          items: { type: "string" },
          description: "Only include posts from these handles, max 10.",
        },
        excludedXHandles: {
          type: "array",
          items: { type: "string" },
          description: "Exclude posts from these handles, max 10.",
        },
        fromDate: { type: "string", description: "Start date in YYYY-MM-DD format." },
        toDate: { type: "string", description: "End date in YYYY-MM-DD format." },
        includeImages: {
          type: "boolean",
          description: "Enable analysis of images in X posts.",
        },
        includeVideos: {
          type: "boolean",
          description: "Enable analysis of videos in X posts.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async (input, options) => {
      return await executeSearchTool({
        name: "search_x",
        input,
        toolCallId: options.toolCallId,
        signal: options.abortSignal,
        timeoutMs: params.runtime.searchToolTimeoutMs,
        emit: params.emit,
        run: async (args, signal) => {
          if (args.allowedXHandles && args.excludedXHandles) {
            throw new ToolError(
              "invalid_tool_arguments",
              "search_x cannot set both allowedXHandles and excludedXHandles",
            );
          }
          const result = await params.runtime.generateText({
            model: params.runtime.searchModel(),
            system: buildNestedSearchSystemPrompt("x"),
            prompt: buildNestedSearchPrompt(args.query),
            abortSignal: signal,
            toolChoice: "required",
            tools: {
              x_search: params.runtime.provider.tools.xSearch({
                allowedXHandles: args.allowedXHandles,
                excludedXHandles: args.excludedXHandles,
                fromDate: args.fromDate,
                toDate: args.toDate,
                enableImageUnderstanding: args.includeImages,
                enableVideoUnderstanding: args.includeVideos,
              }),
            },
          });
          const text = readTextResult(result);
          const sources = normalizeAiSdkSources(readResultArray(result, "sources"));
          return buildSearchOutput({ text, sources });
        },
      });
    },
  });
}

async function executeSearchTool(params: {
  name: "search_web" | "search_x";
  input: unknown;
  toolCallId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  emit: EmitProviderEvent;
  run: (args: Record<string, any>, signal: AbortSignal | undefined) => Promise<SearchToolOutput>;
}): Promise<SearchToolOutput> {
  const arguments_ = asRecord(params.input);
  const startedAt = Date.now();
  await params.emit({
    type: "item_started",
    item: {
      id: params.toolCallId,
      type: "dynamicToolCall",
      text: params.name,
      toolName: params.name,
      arguments: arguments_,
    },
  });

  try {
    if (params.signal?.aborted) {
      throw new Error("Search tool execution was aborted");
    }
    const result = await runSearchWithTimeout({
      name: params.name,
      args: parseSearchArguments(params.input),
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      run: params.run,
    });
    const completedAt = Date.now();
    await params.emit({
      type: "item_completed",
      item: {
        id: params.toolCallId,
        type: "dynamicToolCall",
        text: result.output,
        toolName: params.name,
        success: true,
        arguments: arguments_,
        data: {
          output: result.output,
          sources: result.sources,
          startedAt,
          completedAt,
          elapsedMs: completedAt - startedAt,
        },
        sources: result.sources.length > 0 ? result.sources : undefined,
      },
    });
    return result;
  } catch (error) {
    if (params.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const errorCode =
      error instanceof ToolError || error instanceof SearchToolTimeoutError
        ? error.code
        : "search_tool_failed";
    const completedAt = Date.now();
    const result = {
      success: false,
      output: message,
      sources: [],
      errorCode,
      startedAt,
      completedAt,
      elapsedMs: completedAt - startedAt,
    };
    await params.emit({
      type: "item_completed",
      item: {
        id: params.toolCallId,
        type: "dynamicToolCall",
        text: message,
        toolName: params.name,
        success: false,
        arguments: arguments_,
        data: result,
      },
    });
    return result;
  }
}

async function runSearchWithTimeout(params: {
  name: "search_web" | "search_x";
  args: Record<string, any>;
  signal?: AbortSignal;
  timeoutMs: number;
  run: (args: Record<string, any>, signal: AbortSignal | undefined) => Promise<SearchToolOutput>;
}): Promise<SearchToolOutput> {
  if (!params.timeoutMs) {
    return await params.run(params.args, params.signal);
  }

  const timeoutController = new AbortController();
  const relayAbort = () => {
    timeoutController.abort(params.signal?.reason);
  };
  if (params.signal?.aborted) {
    relayAbort();
  } else {
    params.signal?.addEventListener("abort", relayAbort, { once: true });
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const runPromise = params.run(params.args, timeoutController.signal);
  runPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new SearchToolTimeoutError(params.name, params.timeoutMs));
      timeoutController.abort();
    }, params.timeoutMs);
  });

  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    params.signal?.removeEventListener("abort", relayAbort);
  }
}

class SearchToolTimeoutError extends Error {
  readonly code = "search_tool_timeout";

  constructor(toolName: string, timeoutMs: number) {
    super(`${toolName} timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "SearchToolTimeoutError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type SearchToolOutput = {
  success: boolean;
  output: string;
  sources: ProviderSource[];
  errorCode?: string;
};

function buildSearchOutput(params: { text: string; sources: ProviderSource[] }): SearchToolOutput {
  return {
    success: true,
    output: params.text,
    sources: params.sources,
  };
}

function parseSearchArguments(input: unknown): Record<string, any> {
  const args = asRecord(input);
  const query = readRequiredString(args, "query");
  return {
    query,
    allowedDomains: readOptionalStringArray(args, "allowedDomains", 5),
    excludedDomains: readOptionalStringArray(args, "excludedDomains", 5),
    allowedXHandles: readOptionalStringArray(args, "allowedXHandles", 10),
    excludedXHandles: readOptionalStringArray(args, "excludedXHandles", 10),
    fromDate: readOptionalString(args, "fromDate"),
    toDate: readOptionalString(args, "toDate"),
    includeImages: readOptionalBoolean(args, "includeImages"),
    includeVideos: readOptionalBoolean(args, "includeVideos"),
  };
}

function buildToolExecutionContext(params: {
  thread: ThreadState;
  toolCallId: string;
  signal: AbortSignal;
  emit: EmitProviderEvent;
  hasListeners: () => boolean;
}): ToolExecutionContext {
  return {
    cwd: params.thread.cwd,
    threadId: params.thread.threadId,
    approvalPolicy: params.thread.approvalPolicy,
    sandbox: params.thread.sandbox,
    signal: params.signal,
    onOutputDelta: (delta) => {
      void params.emit({
        type: "item_command_output_delta",
        itemId: params.toolCallId,
        delta: delta.text,
        stream: delta.stream,
        bytes: delta.bytes,
      });
    },
    requestApproval: async (request) => {
      if (!params.hasListeners()) {
        return { decision: "decline" };
      }
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(new Error("Tool approval request was aborted"));
        };
        params.signal.addEventListener("abort", onAbort, { once: true });
        void params
          .emit({
            type: "request_input",
            requestId: request.requestId,
            method: "turn/requestApproval",
            params: {
              kind: request.kind,
              reason: request.reason,
              path: request.path,
              command: request.command,
              commandAction: request.commandAction,
            },
            respond: (response) => {
              params.signal.removeEventListener("abort", onAbort);
              resolve(response);
            },
          })
          .catch((error) => {
            params.signal.removeEventListener("abort", onAbort);
            reject(error);
          });
      });
    },
  };
}

function toJsonSchema(schema: ToolInputSchema): Record<string, unknown> {
  return {
    type: schema.type,
    properties: schema.properties,
    ...(schema.required?.length ? { required: schema.required } : {}),
    ...(typeof schema.additionalProperties === "boolean"
      ? { additionalProperties: schema.additionalProperties }
      : {}),
  };
}

function itemTypeForToolName(name: string): "dynamicToolCall" | "commandExecution" {
  return name === "shell_command" ? "commandExecution" : "dynamicToolCall";
}

function buildNestedSearchSystemPrompt(kind: "web" | "x"): string {
  const target = kind === "x" ? "X posts" : "web results";
  return [
    `You are a ${kind.toUpperCase()} search summarizer for a parent agent.`,
    `Use the provided ${target} tool to answer the query, then return a concise synthesis.`,
    `Return at most ${SEARCH_TOOL_MAX_FINDINGS} findings.`,
    "Prefer the most relevant and recent evidence over broad coverage.",
    "Avoid exhaustive dumps, long preambles, and repeated restatements.",
    "If the search is weak or inconclusive, say so briefly.",
  ].join(" ");
}

function buildNestedSearchPrompt(query: string): string {
  return [
    "Search query:",
    query,
    "",
    `Return no more than ${SEARCH_TOOL_MAX_FINDINGS} high-signal findings.`,
    "Keep the response compact so the parent agent can read it quickly.",
  ].join("\n");
}

function extractCommand(arguments_: Record<string, unknown> | undefined): string | undefined {
  const value = arguments_?.command;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readTextResult(value: unknown): string {
  return value && typeof value === "object" && "text" in value
    ? String((value as { text?: unknown }).text ?? "")
    : "";
}

function readResultArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const array = (value as Record<string, unknown>)[key];
  return Array.isArray(array) ? array : [];
}

function readRequiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError("invalid_tool_arguments", `"${key}" must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolError("invalid_tool_arguments", `"${key}" must be a string`);
  }
  return value.trim() || undefined;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolError("invalid_tool_arguments", `"${key}" must be a boolean`);
  }
  return value;
}

function readOptionalStringArray(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string[] | undefined {
  const value = args[key];
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ToolError("invalid_tool_arguments", `"${key}" must be an array`);
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ToolError("invalid_tool_arguments", `"${key}" entries must be strings`);
    }
    const trimmed = entry.trim();
    if (trimmed) {
      normalized.push(trimmed);
    }
  }
  if (normalized.length > max) {
    throw new ToolError("invalid_tool_arguments", `"${key}" cannot contain more than ${max} entries`);
  }
  return normalized.length > 0 ? normalized : undefined;
}
