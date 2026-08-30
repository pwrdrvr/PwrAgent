import type {
  CreateInstanceThreadToolArgs,
  FederationSearchScope,
  ListFederationInstancesToolArgs,
  ListInstanceProjectsToolArgs,
  PwrAgentFederationOperationName,
  PwrAgentFederationRequest,
  PwrAgentFederationResponse,
  SearchFederationThreadsToolArgs,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  FEDERATION_SEARCH_SCOPES,
  isAppServerBackendKind,
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
const INSTANCE_THREAD_GROUPING_MODES = ["none", "subthread"] as const;

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
      return "List the local instance and known PwrAgent peers. Results include identity, purpose, status, capabilities, and host facts. Use this before you route work to a machine. Profiles with the same machineId share one host. Do not add their CPU, memory, or disk capacity. Host facts come from the last connection. Set includeLoad=true for current load, available memory, free disk, and sample time. A peer can omit load if it does not reply in time. Load is per machineId. Count it once. Use query instead of paging when possible. Cursor tokens expire after about one minute. A local-only result is valid when Federation is disabled. Only local or connected instances can accept work.";
    case "list_instance_projects":
      return "List projects on one local or remote PwrAgent instance. Pass an instanceId from list_federation_instances. Each result includes projectKey, label, path, and launchpad status. Use projectKey with create_instance_thread.";
    case "create_instance_thread":
      return "Create a PwrAgent thread in a project on a selected instance. Get instanceId and projectKey from the list tools. The input becomes the first prompt. Set groupingMode=subthread for delegated child work across instances. Use none for independent intake. Settings inherit from the launchpad and then the instance. Set overrides only when the user requests them. Read ~/.pwragent/AGENTS.md for operator startup preferences when it exists. Use handoff_task for local delegation that needs workspace or grouping controls. Use this tool for a selected instance or instance-based intake. Startup can take minutes. Do not retry a slow request. Use search_federation_threads to check for the thread. Return threadLink verbatim. Keep instanceId for later remote calls.";
    case "search_federation_threads":
      return "Search thread metadata on local and connected PwrAgent instances. Use scope=all, local, or remote to select the search area. Pass instanceId to select one instance. Scope and instanceId both apply when you set both. Filters apply before the result limit. Results include owner data, threadLink, and peer failures. Use search_threads for local transcript or advanced searches. Return threadLink verbatim. Keep instanceId for later remote calls.";
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
        properties: {
          query: {
            type: "string",
            description:
              "Case-insensitive filter for labels, notes, profiles, instance IDs, hostnames, platforms, and CPU architecture. Prefer this to paging. A cursor disables it.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Page size. Defaults to 25.",
          },
          cursor: {
            type: "string",
            description:
              "Continuation token from a truncated result. It expires after about one minute. After expiry, call the tool without a cursor.",
          },
          includeLoad: {
            type: "boolean",
            description:
              "Set true to get current load, available memory, free disk, and sampledAt. A slow peer can omit `load`. Count each machineId once.",
          },
        },
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
          tokenMiserEnabled: {
            type: "boolean",
            description:
              "Explicitly enable or disable Token Miser for the created thread before its first turn. The target profile's experiment gate must also be enabled.",
          },
          workMode: {
            type: "string",
            enum: LAUNCHPAD_WORK_MODES,
            description:
              "`worktree` uses an isolated Git worktree. `local` uses the project checkout. Omit workMode to inherit the launchpad preset.",
          },
          branchName: {
            type: "string",
            description:
              "Optional existing base branch/ref for workMode=worktree, for example `origin/main`. This is not a new feature branch name.",
          },
          groupingMode: {
            type: "string",
            enum: INSTANCE_THREAD_GROUPING_MODES,
            description:
              "Use subthread for child work that must remain nested across instances. The default none keeps independent intake separate.",
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
          projectKeys: {
            type: "array",
            items: { type: "string" },
            description: "Exact PwrAgent project keys to require.",
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
          scope: {
            type: "string",
            enum: FEDERATION_SEARCH_SCOPES,
            description:
              "`all` is the default and searches local and connected instances. `local` searches only this instance. `remote` searches only connected peers.",
          },
          instanceId: {
            type: "string",
            description:
              "Optional instance id to search only that instance. Intersects with scope when both are given.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Maximum results across all instances. Defaults to 50.",
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
      return normalizeListFederationInstancesArgs(args);
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
      return "list_federation_instances accepts an optional non-empty query, an integer limit between 1 and 100, an optional non-empty cursor, and an optional boolean includeLoad.";
    case "list_instance_projects":
      return "list_instance_projects requires a non-empty instanceId string.";
    case "create_instance_thread":
      return "create_instance_thread requires non-empty instanceId and projectKey strings, and accepts only known workMode and groupingMode values.";
    case "search_federation_threads":
      return "search_federation_threads requires a non-empty query string; scope must be all, local, or remote; backend and filters must be valid; limit must be an integer between 1 and 200.";
  }
}

function normalizeListFederationInstancesArgs(
  args: Record<string, unknown>,
): ListFederationInstancesToolArgs | undefined {
  for (const field of ["query", "cursor"] as const) {
    if (Object.hasOwn(args, field) && !readTrimmedString(args[field])) {
      return undefined;
    }
  }
  let limit: number | undefined;
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number"
      || !Number.isInteger(args.limit)
      || args.limit < 1
      || args.limit > 100
    ) {
      return undefined;
    }
    limit = args.limit;
  }
  if (
    args.includeLoad !== undefined
    && typeof args.includeLoad !== "boolean"
  ) {
    return undefined;
  }
  const query = readTrimmedString(args.query);
  const cursor = readTrimmedString(args.cursor);
  return {
    ...(query ? { query } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
    ...(args.includeLoad === true ? { includeLoad: true } : {}),
  };
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
  const groupingMode =
    args.groupingMode === undefined
      ? undefined
      : readChoice(args.groupingMode, INSTANCE_THREAD_GROUPING_MODES);
  if (args.groupingMode !== undefined && !groupingMode) {
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
  if (
    Object.hasOwn(args, "tokenMiserEnabled")
    && typeof args.tokenMiserEnabled !== "boolean"
  ) {
    return undefined;
  }
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
    ...(typeof args.tokenMiserEnabled === "boolean"
      ? { tokenMiserEnabled: args.tokenMiserEnabled }
      : {}),
    ...(workMode ? { workMode } : {}),
    ...(branchName ? { branchName } : {}),
    ...(groupingMode ? { groupingMode } : {}),
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
  const scope =
    args.scope === undefined
      ? undefined
      : readChoice(args.scope, FEDERATION_SEARCH_SCOPES);
  if (args.scope !== undefined && !scope) {
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
  let backend: SearchFederationThreadsToolArgs["backend"];
  if (args.backend !== undefined) {
    if (
      typeof args.backend !== "string"
      || (args.backend !== "all" && !isAppServerBackendKind(args.backend))
    ) {
      return undefined;
    }
    backend = args.backend;
  }
  if (
    args.includeArchived !== undefined
    && typeof args.includeArchived !== "boolean"
  ) {
    return undefined;
  }
  const projectKeys = readNonEmptyStringArray(args.projectKeys);
  if (args.projectKeys !== undefined && !projectKeys) {
    return undefined;
  }
  for (const field of ["updatedAfter", "updatedBefore"] as const) {
    if (
      args[field] !== undefined
      && (typeof args[field] !== "number" || !Number.isInteger(args[field]))
    ) {
      return undefined;
    }
  }
  return {
    query,
    ...(backend ? { backend } : {}),
    ...(args.includeArchived === true ? { includeArchived: true } : {}),
    ...(projectKeys ? { projectKeys } : {}),
    ...(typeof args.updatedAfter === "number"
      ? { updatedAfter: args.updatedAfter }
      : {}),
    ...(typeof args.updatedBefore === "number"
      ? { updatedBefore: args.updatedBefore }
      : {}),
    ...(scope ? { scope: scope as FederationSearchScope } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function readNonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const strings = value.map(readTrimmedString);
  return strings.every((entry): entry is string => Boolean(entry))
    ? strings
    : undefined;
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
