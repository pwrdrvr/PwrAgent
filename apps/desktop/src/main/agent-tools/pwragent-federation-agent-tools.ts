import type {
  CreateInstanceThreadToolArgs,
  ListFederationInstancesToolArgs,
  ListInstanceProjectsToolArgs,
  PwrAgentFederationOperationName,
  PwrAgentFederationRequest,
  PwrAgentFederationResponse,
  SearchFederationThreadsToolArgs,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  PWRAGENT_FEDERATION_OPERATION_NAMES,
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

export const PWRAGENT_FEDERATION_UNAVAILABLE_MESSAGE =
  "PwrAgent federation tools are not available.";

const LAUNCHPAD_WORK_MODES = ["local", "worktree"] as const;

export type PwrAgentFederationHandler = (
  request: PwrAgentFederationRequest,
) => PwrAgentFederationResponse | Promise<PwrAgentFederationResponse>;

export function buildPwrAgentFederationToolRouter(
  handler: PwrAgentFederationHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(
    buildPwrAgentFederationToolDefinitions(handler, {
      namespace: options.namespace,
    }),
    {
      unsupportedMessage:
        options.unsupportedMessage ?? "Unsupported PwrAgent federation tool.",
    },
  );
}

export function buildPwrAgentFederationToolDefinitions(
  handler: PwrAgentFederationHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<PwrAgentFederationOperationName>[] {
  return PWRAGENT_FEDERATION_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_FEDERATION_UNAVAILABLE_MESSAGE,
        });
      }
      const normalizedArgs = normalizeArgsForOperation(operation, args);
      if (!normalizedArgs) {
        return agentToolFailure({
          code: "invalid_arguments",
          message: invalidArgumentsMessageForOperation(operation),
        });
      }
      const response = await handler({
        operation,
        context: {
          backend: context.backend,
          threadId: context.threadId,
          callId: context.callId,
          turnId: context.turnId,
        },
        args: normalizedArgs,
      } as PwrAgentFederationRequest);
      return federationResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(
  operation: PwrAgentFederationOperationName,
): string {
  switch (operation) {
    case "list_federation_instances":
      return "List every PwrAgent instance this app can reach: the local instance plus any federated peers, each with its id, display label, celestial icon, operator-written purpose notes, connection status, capabilities, and an isLocal flag. Use this first when the user wants work routed to a particular machine ('on the studio Mac', 'on the rack mini') or when deciding where a task should run — the purpose notes describe what each machine is for. Works with federation disabled too: the result is then just the local instance, so there is no need to check whether federation is configured before calling. Only instances with status connected (or the local instance) can accept new work.";
    case "list_instance_projects":
      return "List the projects/directories available on one PwrAgent instance, local or remote. Pass an instanceId from list_federation_instances. Each project row carries the key to pass to create_instance_thread as projectKey, plus its label, filesystem path, and whether a launchpad (per-project environment, model, and execution-mode presets) is configured. Use this to find the project the user is talking about on the chosen instance before creating a thread there.";
    case "create_instance_thread":
      return "Create and start a new PwrAgent thread in a project on a chosen instance, local or remote. Pass instanceId from list_federation_instances and projectKey from list_instance_projects; input becomes the first prompt of the created thread. Omitted settings inherit the project's launchpad presets, then the instance defaults — only pass model/executionMode/workMode overrides the user asked for. Consult ~/.pwragent/AGENTS.md (when it exists) for the operator's thread-startup preferences such as default projects and settings before choosing values. For delegating work on the local instance from an ordinary thread, prefer handoff_task, which offers richer workspace and grouping options; use create_instance_thread when targeting another instance or when routing intake work by instance. Thread startup can take minutes while a worktree or environment is prepared; if this call is slow, do not call it again — use search_federation_threads to check whether the thread appeared. When the result includes threadLink, include it verbatim when telling the user about the thread so it renders as a clickable chip; a bare threadId is a dead end for the user. Remote-instance results carry no threadLink yet — name the instance label instead.";
    case "search_federation_threads":
      return "Search threads across every reachable PwrAgent instance, including the local one, in a single call — use it to find 'the PwrSnap thread about X' wherever it lives. Pass instanceId to scope the search to one instance. Results carry the owning instanceId, its display label, and an isLocal flag; failures lists peers that could not be searched. This is a metadata search (titles, summaries, project paths). For deeper local-only search with transcript content modes, use search_threads instead. When mentioning a local result to the user, include its threadLink verbatim so it renders as a clickable chip.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentFederationOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "list_federation_instances":
      return {
        type: "object",
        additionalProperties: false,
        properties: {},
      };
    case "list_instance_projects":
      return {
        type: "object",
        additionalProperties: false,
        required: ["instanceId"],
        properties: {
          instanceId: {
            type: "string",
            description:
              "Instance id from list_federation_instances. The local instance id is accepted too.",
          },
        },
      };
    case "create_instance_thread":
      return {
        type: "object",
        additionalProperties: false,
        required: ["instanceId", "projectKey"],
        properties: {
          instanceId: {
            type: "string",
            description: "Target instance id from list_federation_instances.",
          },
          projectKey: {
            type: "string",
            description:
              "Project directory key from list_instance_projects on the same instance.",
          },
          input: {
            type: "string",
            description:
              "Initial prompt for the created thread's first turn. Include the concrete task, not the parent transcript.",
          },
          model: { type: "string" },
          reasoningEffort: { type: "string" },
          executionMode: { type: "string" },
          fastMode: { type: "boolean" },
          workMode: {
            type: "string",
            enum: LAUNCHPAD_WORK_MODES,
            description:
              "`worktree` runs the thread in an isolated Git worktree; `local` uses the project checkout directly. Omitted inherits the project's launchpad preset.",
          },
          branchName: {
            type: "string",
            description:
              "Optional existing base branch/ref for workMode=worktree, for example `origin/main`. This is not a new feature branch name.",
          },
        },
      };
    case "search_federation_threads":
      return {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Search text matched against thread titles, summaries, and project paths.",
          },
          instanceId: {
            type: "string",
            description:
              "Optional instance id to search only that instance. Omitted searches the local instance and every connected peer.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Maximum results across all instances. Defaults to 20.",
          },
        },
      };
  }
}

function normalizeArgsForOperation(
  operation: PwrAgentFederationOperationName,
  args: Record<string, unknown>,
):
  | ListFederationInstancesToolArgs
  | ListInstanceProjectsToolArgs
  | CreateInstanceThreadToolArgs
  | SearchFederationThreadsToolArgs
  | undefined {
  switch (operation) {
    case "list_federation_instances":
      return {};
    case "list_instance_projects":
      return normalizeListInstanceProjectsArgs(args);
    case "create_instance_thread":
      return normalizeCreateInstanceThreadArgs(args);
    case "search_federation_threads":
      return normalizeSearchFederationThreadsArgs(args);
  }
}

function invalidArgumentsMessageForOperation(
  operation: PwrAgentFederationOperationName,
): string {
  switch (operation) {
    case "list_federation_instances":
      return "list_federation_instances accepts no arguments.";
    case "list_instance_projects":
      return "list_instance_projects requires a non-empty instanceId string.";
    case "create_instance_thread":
      return "create_instance_thread requires non-empty instanceId and projectKey strings, and accepts only known workMode values.";
    case "search_federation_threads":
      return "search_federation_threads requires a non-empty query string; limit must be an integer between 1 and 200.";
  }
}

function normalizeListInstanceProjectsArgs(
  args: Record<string, unknown>,
): ListInstanceProjectsToolArgs | undefined {
  const instanceId = readTrimmedString(args.instanceId);
  if (!instanceId) {
    return undefined;
  }
  return { instanceId };
}

function normalizeCreateInstanceThreadArgs(
  args: Record<string, unknown>,
): CreateInstanceThreadToolArgs | undefined {
  const instanceId = readTrimmedString(args.instanceId);
  const projectKey = readTrimmedString(args.projectKey);
  if (!instanceId || !projectKey) {
    return undefined;
  }
  const workMode =
    args.workMode === undefined
      ? undefined
      : readChoice(args.workMode, LAUNCHPAD_WORK_MODES);
  if (args.workMode !== undefined && !workMode) {
    return undefined;
  }
  const optionalStringFields = [
    "input",
    "model",
    "reasoningEffort",
    "executionMode",
    "branchName",
  ] as const;
  for (const field of optionalStringFields) {
    if (Object.hasOwn(args, field) && !readTrimmedString(args[field])) {
      return undefined;
    }
  }
  const input = readTrimmedString(args.input);
  const model = readTrimmedString(args.model);
  const reasoningEffort = readTrimmedString(args.reasoningEffort);
  const executionMode = readTrimmedString(args.executionMode);
  const branchName = readTrimmedString(args.branchName);
  return {
    instanceId,
    projectKey,
    ...(input ? { input } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(executionMode
      ? { executionMode: executionMode as ThreadExecutionMode }
      : {}),
    ...(typeof args.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
    ...(workMode ? { workMode } : {}),
    ...(branchName ? { branchName } : {}),
  };
}

function normalizeSearchFederationThreadsArgs(
  args: Record<string, unknown>,
): SearchFederationThreadsToolArgs | undefined {
  const query = readTrimmedString(args.query);
  if (!query) {
    return undefined;
  }
  if (Object.hasOwn(args, "instanceId") && !readTrimmedString(args.instanceId)) {
    return undefined;
  }
  let limit: number | undefined;
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number"
      || !Number.isInteger(args.limit)
      || args.limit < 1
      || args.limit > 200
    ) {
      return undefined;
    }
    limit = args.limit;
  }
  const instanceId = readTrimmedString(args.instanceId);
  return {
    query,
    ...(instanceId ? { instanceId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readChoice<TValue extends string>(
  value: unknown,
  choices: readonly TValue[],
): TValue | undefined {
  return typeof value === "string" && choices.includes(value as TValue)
    ? (value as TValue)
    : undefined;
}

function federationResponseToAgentToolResult(
  response: PwrAgentFederationResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
    data: response.error.data,
  });
}
