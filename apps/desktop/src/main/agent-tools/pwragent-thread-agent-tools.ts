import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  FederationInstanceId,
  NavigationThreadSummary,
  SetThreadModelSettingsRequest,
  ThreadExecutionMode,
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

export type PwrAgentFederatedThreadInspectionRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: FederationInstanceId;
  before?: string;
  limit: number;
  includeTurns: boolean;
};

export type PwrAgentFederatedThreadInspectionResult = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  thread: AppServerThreadSummary;
  /** Enriched owner navigation row when the thread is active and available. */
  summary?: NavigationThreadSummary;
  read: AppServerReadThreadResponse;
};

export type PwrAgentFederatedThreadInspectionHandler = (
  request: PwrAgentFederatedThreadInspectionRequest,
) => Promise<PwrAgentFederatedThreadInspectionResult | undefined>;

export type PwrAgentFederatedThreadMutationRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: FederationInstanceId;
  title?: string;
  modelSettings?: Omit<SetThreadModelSettingsRequest, "backend" | "threadId">;
  executionMode?: ThreadExecutionMode;
  dryRun: boolean;
};

export type PwrAgentFederatedThreadMutationResult = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
};

export type PwrAgentFederatedThreadMutationHandler = (
  request: PwrAgentFederatedThreadMutationRequest,
) => Promise<PwrAgentFederatedThreadMutationResult | undefined>;

export class PwrAgentFederatedThreadInspectionError extends Error {
  constructor(
    readonly code: "peer_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PwrAgentFederatedThreadInspectionError";
  }
}

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
      return "Search known PwrAgent threads. By default, metadata search includes connected peers. Content and advanced filters work only on the local instance. Omit query to list recent candidates. Use instanceId for one peer or includeRemote=false for local metadata only. Results can include pending handoffs and workspace moves. Do not retry a pending operation.";
    case "read_thread":
      return "Read a bounded page of transcript and activity from another known PwrAgent thread. Use search_threads when threadId is unknown. Pass instanceId for a known remote thread. Otherwise, PwrAgent resolves the owner. Return threadLink or a messageLink verbatim when referring to what was read.";
    case "get_thread_status":
      return "Read compact status and metadata for a PwrAgent thread. Results include linked directories, repository groups, pull requests, PR automation, pending handoffs, and workspace moves. Omit backend and threadId for the current thread. Pass instanceId for a known remote thread. Follow prAutomation.guidance. Auto-fix PR active means this thread owns monitoring, not that another agent is repairing the PR. If Auto-fix PR started the current turn, continue the repair. Otherwise, do not poll CI or create a monitor.";
    case "attach_thread_pull_request":
      return "Attach a pull request reference to a PwrAgent thread. Omit backend and threadId for the current thread. Use this when automatic branch discovery cannot find the PR. Pass a URL, a full provider identity, or a number for one inferable repository.";
    case "check_thread_pull_request_status":
      return "Check pull request status through the PwrAgent provider. Use this instead of a shell command. Omit backend and threadId for the current thread. The result includes freshness and prAutomation state. prAutomation.autoFixActive means this thread owns monitoring, not that another agent is repairing the PR. If Auto-fix PR started the current turn, continue the repair and never end only because this field is true. In any other turn, do not poll CI or create a monitor; end the turn. Use watch_thread_pull_request when the thread must also wake after success.";
    case "watch_thread_pull_request":
      return "Create a durable, one-time watch for an attached pull request at the current head. The watch wakes the thread after CI success, early failure, or a merge conflict. Only a primary-workspace PR is eligible. The oldest duplicate watch receives the result. A terminal snapshot returns currentOutcome without a new watch. Omit backend and threadId for the current thread. Omit url only when one eligible PR exists. After creation, end the turn. Do not poll CI or create a monitor. Auto-fix PR handles failure wake-ups without a duplicate turn.";
    case "mutate_thread":
      return "Change guarded settings on a PwrAgent thread. Pass instanceId for a known remote thread. Otherwise, PwrAgent resolves the owner. This tool does not rename a messaging topic or thread.";
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
          instanceId: {
            type: "string",
            description:
              "Restrict the search to one connected Federation instance. Omit to combine local and connected remote results.",
          },
          includeRemote: {
            type: "boolean",
            description:
              "Whether to include metadata matches from connected Federation instances. Defaults to true.",
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
              "Use `metadata` for metadata only. Use `available` to search bounded transcript content when possible. Use `required` when content search is mandatory.",
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
        properties: {
          backend: {
            type: "string",
            description:
              "Backend that owns the thread. Defaults to the invoking thread's backend.",
          },
          threadId: {
            type: "string",
            description:
              "Thread id to inspect. Defaults to the invoking PwrAgent thread id.",
          },
          instanceId: {
            type: "string",
            description:
              "Federation instance that owns the thread. Omit to check the local instance, then remembered and connected peers.",
          },
          includeRemote: {
            type: "boolean",
            description:
              "Whether to resolve the thread across connected Federation peers after checking locally. Defaults to true.",
          },
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
          instanceId: {
            type: "string",
            description:
              "Federation instance that owns the thread. Omit to check the local instance, then remembered and connected peers.",
          },
          includeRemote: {
            type: "boolean",
            description:
              "Whether to resolve the thread across connected Federation peers after checking locally. Defaults to true.",
          },
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
    case "attach_thread_pull_request":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: {
            type: "string",
            description:
              "Backend that owns the thread. Defaults to the invoking thread's backend.",
          },
          threadId: {
            type: "string",
            description:
              "Thread id to attach the PR reference to. Defaults to the invoking PwrAgent thread id.",
          },
          url: {
            type: "string",
            description:
              "Full PR/MR URL, for example https://github.com/org/repo/pull/123 or https://gitlab.example.com/group/repo/-/merge_requests/123.",
          },
          provider: {
            type: "string",
            description:
              "Forge host such as github.com, ghe.example.com, or gitlab.example.com. Required when url is omitted unless it can be inferred from the thread.",
          },
          org: {
            type: "string",
            description:
              "Repo owner or group. For nested GitLab groups, use the slash-separated group path.",
          },
          repo: {
            type: "string",
          },
          number: {
            type: "integer",
            minimum: 1,
            description:
              "PR/MR number. May be used alone only when the thread has exactly one inferable repository.",
          },
          title: {
            type: "string",
            description:
              "Optional title to display until provider refresh hydrates current status.",
          },
        },
      };
    case "check_thread_pull_request_status":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: {
            type: "string",
            description:
              "Backend that owns the thread. Defaults to the invoking thread's backend.",
          },
          threadId: {
            type: "string",
            description:
              "Thread id to check. Defaults to the invoking PwrAgent thread id.",
          },
          provider: {
            type: "string",
            description:
              "Forge host such as github.com or a GitHub Enterprise host. Defaults to github.com.",
          },
          branch: {
            type: "string",
            description:
              "Optional branch override. Defaults to the thread's observed/expected branch or HEAD.",
          },
          directoryPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional cwd list for provider lookups. Defaults to the thread's linked directories.",
          },
        },
      };
    case "watch_thread_pull_request":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: {
            type: "string",
            description:
              "Backend that owns the thread. Defaults to the invoking thread's backend.",
          },
          threadId: {
            type: "string",
            description:
              "Thread id to watch. Defaults to the invoking PwrAgent thread id.",
          },
          url: {
            type: "string",
            description:
              "Full PR/MR URL attached to the primary workspace. Omit only when the thread has exactly one eligible pull request.",
          },
          notifyOn: {
            type: "array",
            items: {
              type: "string",
              enum: ["success", "failure"],
            },
            minItems: 1,
            uniqueItems: true,
            description:
              "Outcomes that should wake the thread. Defaults to both success and failure.",
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
          instanceId: {
            type: "string",
            description:
              "Federation instance that owns the thread. Omit to check the local instance, then remembered and connected peers.",
          },
          includeRemote: {
            type: "boolean",
            description:
              "Whether to resolve the thread across connected Federation peers after checking locally. Defaults to true.",
          },
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
