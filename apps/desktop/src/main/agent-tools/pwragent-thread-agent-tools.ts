import type {
  PwrAgentThreadInspectionOperationName,
  PwrAgentThreadInspectionRequest,
  PwrAgentThreadInspectionResponse,
} from "@pwragent/shared";
import {
  PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
} from "./agent-tool-definition.js";
import {
  agentToolFailure,
  agentToolSuccess,
} from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const PWRAGENT_THREAD_INSPECTION_UNAVAILABLE_MESSAGE =
  "PwrAgent thread inspection is not available.";

export type PwrAgentThreadInspectionHandler = (
  request: PwrAgentThreadInspectionRequest,
) => PwrAgentThreadInspectionResponse | Promise<PwrAgentThreadInspectionResponse>;

export function buildPwrAgentThreadToolRouter(
  handler: PwrAgentThreadInspectionHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentThreadToolDefinitions(handler, {
    namespace: options.namespace,
  }), {
    unsupportedMessage:
      options.unsupportedMessage ?? "Unsupported PwrAgent thread tool.",
  });
}

export function buildPwrAgentThreadToolDefinitions(
  handler: PwrAgentThreadInspectionHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<PwrAgentThreadInspectionOperationName>[] {
  return PWRAGENT_THREAD_INSPECTION_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_THREAD_INSPECTION_UNAVAILABLE_MESSAGE,
        });
      }
      const response = await handler({
        operation,
        context: {
          backend: context.backend,
          threadId: context.threadId,
        },
        args,
      } as PwrAgentThreadInspectionRequest);
      return threadInspectionResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(
  operation: PwrAgentThreadInspectionOperationName,
): string {
  switch (operation) {
    case "search_threads":
      return "Search known PwrAgent threads by title, summary, Agent metadata, backend, and linked directory. Omit query to inspect recent lightweight thread candidates before choosing a thread. The response may include pendingHandoffs for handoff_task calls that are still creating a child thread and pendingWorkspaceMoves for move_thread_workspace calls that are still moving the same thread; do not retry those operations while they are starting.";
    case "read_thread":
      return "Read a bounded page of another known PwrAgent thread's recent transcript and activity. Use search_threads first when the threadId is unknown.";
    case "get_thread_status":
      return "Read status and compact metadata for a known PwrAgent thread, including pendingHandoffs when this thread has child handoffs that are still being created and pendingWorkspaceMoves when this thread has same-thread workspace moves in progress.";
    case "mutate_thread":
      return "Mutate guarded PwrAgent thread settings such as the PwrAgent thread title, model settings, or execution mode. This does not rename any attached Telegram topic, Discord thread, or other messaging surface.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentThreadInspectionOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "search_threads":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Thread/project words to search. Use OR or | between alternatives, for example `telegram naming OR topic issue`. Omit this to list recent candidates.",
          },
          backend: {
            type: "string",
            description:
              "Backend to search. Defaults to all known PwrAgent backends.",
          },
          includeArchived: {
            type: "boolean",
            description:
              "When true, search active threads plus archived threads. Defaults to active threads only.",
          },
          agentOnly: {
            type: "boolean",
            description:
              "Restrict results to PwrAgent Agent threads only. Leave false when the user asks to find an ordinary coding thread.",
          },
          projectKeys: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact PwrAgent project keys to require, for example `PwrAgent`.",
          },
          directoryPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact linked local or worktree directory paths to require.",
          },
          models: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact model ids to require when the user remembers the model.",
          },
          updatedAfter: {
            type: "integer",
            description:
              "Only include threads updated at or after this Unix epoch millisecond timestamp.",
          },
          updatedBefore: {
            type: "integer",
            description:
              "Only include threads updated at or before this Unix epoch millisecond timestamp.",
          },
          contentMode: {
            type: "string",
            enum: ["metadata", "available", "required"],
            description:
              "Use `metadata` for title/project/folder search only, `available` to also search bounded provider transcript content when possible, or `required` when content search must be attempted.",
          },
          semanticMode: {
            type: "string",
            enum: ["disabled", "available", "required"],
            description:
              "Semantic search mode. Currently disabled unless a future local semantic index is configured.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description:
              "Maximum candidate rows to return. Defaults to 10 for a query and 100 when query is omitted.",
          },
        },
      };
    case "get_thread_status":
      return {
        type: "object",
        additionalProperties: false,
        required: ["backend", "threadId"],
        properties: {
          backend: {
            type: "string",
          },
          threadId: { type: "string" },
        },
      };
    case "read_thread":
      return {
        type: "object",
        additionalProperties: false,
        required: ["backend", "threadId"],
        properties: {
          backend: {
            type: "string",
          },
          threadId: { type: "string" },
          before: {
            type: "string",
            description:
              "Optional pagination cursor returned by a previous read_thread response.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description:
              "Maximum transcript entries to return. Defaults to 10.",
          },
          includeMessages: {
            type: "boolean",
            description:
              "Whether to include normalized transcript messages. Defaults to true.",
          },
          includeEntries: {
            type: "boolean",
            description:
              "Whether to include normalized timeline entries. Defaults to true.",
          },
          includeStatus: {
            type: "boolean",
            description:
              "Whether to include current thread status when available. Defaults to true.",
          },
          maxCharsPerEntry: {
            type: "integer",
            minimum: 200,
            maximum: 20000,
            description:
              "Maximum characters retained in each text-like transcript field. Defaults to 4000.",
          },
        },
      };
    case "mutate_thread":
      return {
        type: "object",
        additionalProperties: false,
        required: ["backend", "threadId"],
        properties: {
          backend: {
            type: "string",
          },
          threadId: { type: "string" },
          title: {
            type: "string",
            description:
              "New PwrAgent thread title. This does not rename attached messaging topics or threads.",
          },
          model: {
            type: "string",
            description:
              "Provider model id to use for future turns, for example `gpt-5.5`.",
          },
          serviceTier: {
            type: "string",
            description:
              "Provider service tier to use for future turns when supported.",
          },
          reasoningEffort: {
            type: "string",
            description:
              "Provider reasoning effort to use for future turns when supported.",
          },
          fastMode: {
            type: "boolean",
            description:
              "Whether to enable the thread's fast-mode setting when supported.",
          },
          executionMode: {
            type: "string",
            enum: ["default", "full-access"],
            description:
              "Thread execution/permission mode. Active turns may queue this until the next safe boundary.",
          },
          dryRun: {
            type: "boolean",
            description:
              "When true, validate and report requested mutations without applying them.",
          },
        },
      };
  }
}

function threadInspectionResponseToAgentToolResult(
  response: PwrAgentThreadInspectionResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
  });
}
