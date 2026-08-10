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
      return "List the PwrAgent instances this app can reach: the local instance plus any federated peers, each with its id, display label, celestial icon, operator-written purpose notes, connection status, capabilities, an isLocal flag, and host facts (OS platform/version, hostname, CPU architecture and count, total RAM, free disk, machineId). Use this first when the user wants work routed to a particular machine ('on the studio Mac', 'on the rack mini') or for 'find me a place to run this' requests — purpose notes describe intent, host facts describe capability. Instances sharing the same host.machineId are profiles on one physical machine and compete for the same CPUs/RAM — never sum their capacity. Disk/host figures are snapshots from the last handshake, not live readings. For live readings, pass includeLoad: true to attach a `load` sibling next to `host` (1/5/15-minute CPU load averages, available RAM bytes, free disk bytes, sampledAt) fetched from each reachable instance with a short per-peer timeout — instances that fail to answer in time simply omit `load`. Load is per machine, not per instance: rows sharing host.machineId report the same underlying load, so dedupe by machineId when aggregating load for placement decisions. Results are paged: at most `limit` rows (default 25) per call, with nextCursor and totalCount when more remain; pass nextCursor back promptly (tokens expire after about a minute), or better, use `query` to filter by label, notes, profile, hostname, platform, or architecture instead of paging through a large fleet. Works with federation disabled too: the result is then just the local instance, so there is no need to check whether federation is configured before calling. Only instances with status connected (or the local instance) can accept new work.";
    case "list_instance_projects":
      return "List the projects/directories available on one PwrAgent instance, local or remote. Pass an instanceId from list_federation_instances. Each project row carries the key to pass to create_instance_thread as projectKey, plus its label, filesystem path, and whether a launchpad (per-project environment, model, and execution-mode presets) is configured. Use this to find the project the user is talking about on the chosen instance before creating a thread there.";
    case "create_instance_thread":
      return "Create and start a new PwrAgent thread in a project on a chosen instance, local or remote. Pass instanceId from list_federation_instances and projectKey from list_instance_projects; input becomes the first prompt of the created thread. Set groupingMode=subthread when the new thread is delegated child work that should stay nested beneath the caller across instances; leave it none for independent intake/routing work. Omitted settings inherit the project's launchpad presets, then the instance defaults — only pass model/executionMode/workMode overrides the user asked for. Consult ~/.pwragent/AGENTS.md (when it exists) for the operator's thread-startup preferences such as default projects and settings before choosing values. For delegating work on the local instance from an ordinary thread, prefer handoff_task, which offers richer workspace and grouping options; use create_instance_thread when targeting another instance or when routing intake work by instance. Thread startup can take minutes while a worktree or environment is prepared; if this call is slow, do not call it again — use search_federation_threads to check whether the thread appeared. The result includes threadLink and instanceId. Include threadLink verbatim when telling the user about the thread so it renders as a clickable chip, and preserve instanceId when passing the remote target to send_message_to_thread.";
    case "search_federation_threads":
      return "Search threads across every reachable PwrAgent instance, including the local one, in a single call — use it to find 'the PwrSnap thread about X' wherever it lives. Use scope to pick the search surface: `all` (default) is local plus every connected peer, `local` is this instance only, and `remote` is every connected peer excluding local — the right choice when the user knows the thread is not on this machine. Pass instanceId to target one specific instance; scope and instanceId intersect when both are given. Backend, project, archive, and update-time filters are applied on each instance before the global result limit. Results carry the owning instanceId, its display label, an isLocal flag, and a threadLink that preserves cross-instance routing; failures lists peers that could not be searched. This is a metadata search (titles, summaries, project paths). For deeper local-only search with transcript content modes, use search_threads instead. Include threadLink verbatim when mentioning a result so it renders as a clickable chip, and preserve instanceId when passing a remote target to send_message_to_thread.";
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
              "Optional case-insensitive substring filter matched against label, purpose notes, profile name, instance id, hostname, OS platform/version, and CPU architecture. Prefer filtering over paging through a large fleet. Ignored when cursor is set.",
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
              "Continuation token from a previous truncated result. Tokens expire after about a minute; on an expired-cursor error, call again without a cursor.",
          },
          includeLoad: {
            type: "boolean",
            description:
              "When true, attach a live `load` block (CPU load averages, available RAM, free disk, sampledAt) to each reachable instance via a short-timeout on-demand query. Instances that fail to answer in time omit `load`. Rows sharing host.machineId report the same underlying load — dedupe by machineId when aggregating.",
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
          groupingMode: {
            type: "string",
            enum: INSTANCE_THREAD_GROUPING_MODES,
            description:
              "Use subthread for delegated child work that should remain nested beneath the calling thread across instances; defaults to none for independent intake work.",
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
              "`all` (default) searches the local instance plus every connected peer. `local` searches only this instance. `remote` searches every connected peer and excludes local — use it when the thread is known to live on another machine.",
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
