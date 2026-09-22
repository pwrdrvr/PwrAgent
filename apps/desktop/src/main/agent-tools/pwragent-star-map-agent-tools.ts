import type {
  FlyStarMapToToolArgs,
  HighlightStarMapThreadsToolArgs,
  PwrAgentStarMapOperationName,
  PwrAgentStarMapRequest,
  PwrAgentStarMapResponse,
  ReadStarMapViewToolArgs,
  SetStarMapViewToolArgs,
  StarMapThreadOpenMode,
  StarMapThreadRef,
  StarMapViewFilterKey,
  StarMapViewFilterSetting,
  StarMapViewLayout,
} from "@pwragent/shared";
import {
  DEFAULT_STAR_MAP_VIEW_MAX_THREADS,
  isAppServerBackendKind,
  MAX_STAR_MAP_HIGHLIGHT_THREADS,
  MAX_STAR_MAP_VIEW_MAX_THREADS,
  PWRAGENT_STAR_MAP_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
  STAR_MAP_THREAD_OPEN_MODES,
  STAR_MAP_VIEW_FILTER_KEYS,
  STAR_MAP_VIEW_FILTER_SETTINGS,
  STAR_MAP_VIEW_LAYOUTS,
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

export const PWRAGENT_STAR_MAP_UNAVAILABLE_MESSAGE =
  "PwrAgent star map tools are not available.";

export type PwrAgentStarMapHandler = (
  request: PwrAgentStarMapRequest,
) => PwrAgentStarMapResponse | Promise<PwrAgentStarMapResponse>;

export function buildPwrAgentStarMapToolRouter(
  handler: PwrAgentStarMapHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(
    buildPwrAgentStarMapToolDefinitions(handler, {
      namespace: options.namespace,
    }),
    {
      unsupportedMessage:
        options.unsupportedMessage ?? "Unsupported PwrAgent star map tool.",
    },
  );
}

export function buildPwrAgentStarMapToolDefinitions(
  handler: PwrAgentStarMapHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<PwrAgentStarMapOperationName>[] {
  return PWRAGENT_STAR_MAP_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    deferLoading: false,
    dispatch: async (args): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_STAR_MAP_UNAVAILABLE_MESSAGE,
        });
      }
      const parsed = parseArgs(operation, args);
      if ("error" in parsed) {
        return agentToolFailure({
          code: "invalid_arguments",
          message: parsed.error,
        });
      }
      const response = await handler({
        operation,
        context: {},
        args: parsed.args,
      } as PwrAgentStarMapRequest);
      return starMapResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(
  operation: PwrAgentStarMapOperationName,
): string {
  switch (operation) {
    case "read_star_map_view":
      return [
        "Read what the operator sees on the PwrAgent Star Map right now.",
        "Reports instances and clouds, the labelled groups of thread cards.",
        "Reports which cards are drawn and which are folded behind a chip.",
        "Also reports the card selection, open chat cards, camera and filters.",
        "Call this to resolve on-screen references to a thread or a cloud.",
        "Each drawn card reports where it sits, so position resolves too.",
        "Use screenRect for that: viewport pixels, with x rising to the right.",
        "So the leftmost card is the drawn one with the smallest screenRect x.",
        "onScreen is false for a card the operator has panned out of view.",
        "Each thread carries the backend, threadId and instanceId tools need.",
        "Fails when no Star Map surface is open.",
      ].join(" ");
    case "fly_star_map_to":
      return [
        "Fly the operator's Star Map camera to a card, a cloud, or an instance's body.",
        "Use it when the operator asks where something is or to be shown it.",
        "For a card, pass threadId and backend, plus instanceId for a peer's thread.",
        "A card the map is not drawing is brought onto it first.",
        "For a cloud, pass cloudKey from read_star_map_view.",
        "Add instanceId when that project has a cloud on more than one instance.",
        "Pass instanceId alone for an instance's body, which the projects lens does not draw.",
        "Pass open as card to open a thread's chat card on the map once there.",
        "Pass open as full to open the whole thread instead, which leaves the map.",
        "Fails when no Star Map surface is open.",
      ].join(" ");
    case "highlight_star_map_threads":
      return [
        "Ring thread cards on the operator's Star Map so they can see which ones you mean.",
        "Use it before acting on several threads, while you ask the operator to confirm.",
        "Each thread takes threadId and backend, plus instanceId for a peer's thread.",
        "A thread the map has not loaded is loaded and brought onto it first.",
        "The camera frames every ringed card.",
        "Each call replaces the last highlight.",
        "Pass clear as true to remove it once the operator has answered.",
        "Fails when no Star Map surface is open.",
      ].join(" ");
    case "set_star_map_view":
      return [
        "Change the operator's Star Map lens and filter chips.",
        "Use it when the operator asks to see the map a different way.",
        "layout picks the lens: lanes, orbit, or projects.",
        "filters sets chips by key to include, exclude, or neutral.",
        "Chips not named keep their state.",
        "Within attention, approval, pr and unpushed, included chips match any of them.",
        "Chips in different groups must all match.",
        "clearFilters turns every chip off before filters apply.",
        "hideOfflineInstances drops disconnected instances from the map.",
        "Fails when no Star Map surface is open.",
      ].join(" ");
  }
}

function inputSchemaForOperation(
  operation: PwrAgentStarMapOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "read_star_map_view":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          maxThreads: {
            type: "integer",
            minimum: 1,
            maximum: MAX_STAR_MAP_VIEW_MAX_THREADS,
            description: `Cap on returned threads. Defaults to ${DEFAULT_STAR_MAP_VIEW_MAX_THREADS}. Cloud counts stay complete, so a truncated list reports what it dropped.`,
          },
          instanceId: {
            type: "string",
            description:
              "Restrict to one instance's cards. Omit for the whole fleet.",
          },
          includeHidden: {
            type: "boolean",
            description:
              "Include threads folded behind a cloud's overflow chip. Defaults to true.",
          },
        },
      };
    case "fly_star_map_to":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          threadId: {
            type: "string",
            description: "Fly to this thread's card.",
          },
          backend: {
            type: "string",
            description: "The thread's backend. Required with threadId.",
          },
          cloudKey: {
            type: "string",
            description: "Fly to this cloud, by its read_star_map_view key.",
          },
          instanceId: {
            type: "string",
            description:
              "The instance that owns the thread or cloud. Alone, fly to its body.",
          },
          open: {
            type: "string",
            enum: [...STAR_MAP_THREAD_OPEN_MODES],
            description:
              "With threadId only. card opens its chat card on the map. full opens the whole thread.",
          },
        },
      };
    case "highlight_star_map_threads":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          threads: {
            type: "array",
            minItems: 1,
            maxItems: MAX_STAR_MAP_HIGHLIGHT_THREADS,
            description: "The cards to ring. Replaces the last highlight.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["threadId", "backend"],
              properties: {
                threadId: { type: "string" },
                backend: { type: "string" },
                instanceId: {
                  type: "string",
                  description: "The owning instance, for a peer's thread.",
                },
              },
            },
          },
          clear: {
            type: "boolean",
            description: "true removes the highlight. Pass it without threads.",
          },
        },
      };
    case "set_star_map_view":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          layout: {
            type: "string",
            enum: [...STAR_MAP_VIEW_LAYOUTS],
            description: "The lens to show.",
          },
          filters: {
            type: "object",
            additionalProperties: false,
            description: "Chip states by key. neutral turns a chip off.",
            properties: Object.fromEntries(
              STAR_MAP_VIEW_FILTER_KEYS.map((key) => [
                key,
                { type: "string", enum: [...STAR_MAP_VIEW_FILTER_SETTINGS] },
              ]),
            ),
          },
          clearFilters: {
            type: "boolean",
            description: "true turns every chip off before filters apply.",
          },
          hideOfflineInstances: {
            type: "boolean",
            description: "true drops disconnected instances from the map.",
          },
        },
      };
  }
}

type ParsedArgs =
  | {
      args:
        | ReadStarMapViewToolArgs
        | FlyStarMapToToolArgs
        | HighlightStarMapThreadsToolArgs
        | SetStarMapViewToolArgs;
    }
  | { error: string };

function parseArgs(
  operation: PwrAgentStarMapOperationName,
  args: Record<string, unknown>,
): ParsedArgs {
  switch (operation) {
    case "read_star_map_view":
      return parseReadArgs(args);
    case "fly_star_map_to":
      return parseFlyArgs(args);
    case "highlight_star_map_threads":
      return parseHighlightArgs(args);
    case "set_star_map_view":
      return parseSetViewArgs(args);
  }
}

/**
 * Types only: which combination names a destination is the service's call,
 * because it is the same rule whether the call came from Codex or MCP.
 */
function parseFlyArgs(args: Record<string, unknown>): ParsedArgs {
  const parsed: FlyStarMapToToolArgs = {};
  for (const field of ["threadId", "backend", "cloudKey", "instanceId"] as const) {
    const value = args[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) {
      return { error: `fly_star_map_to ${field} must be a non-empty string.` };
    }
    (parsed as Record<string, string>)[field] = value.trim();
  }
  if (args.open !== undefined) {
    if (!STAR_MAP_THREAD_OPEN_MODES.includes(args.open as StarMapThreadOpenMode)) {
      return { error: "fly_star_map_to open must be card or full." };
    }
    parsed.open = args.open as StarMapThreadOpenMode;
  }
  return { args: parsed };
}

function parseHighlightArgs(args: Record<string, unknown>): ParsedArgs {
  if (args.clear !== undefined && typeof args.clear !== "boolean") {
    return { error: "highlight_star_map_threads clear must be a boolean." };
  }
  if (args.threads === undefined) {
    return { args: args.clear === undefined ? {} : { clear: args.clear } };
  }
  if (
    !Array.isArray(args.threads)
    || args.threads.length === 0
    || args.threads.length > MAX_STAR_MAP_HIGHLIGHT_THREADS
  ) {
    return {
      error: `highlight_star_map_threads threads must list 1 to ${MAX_STAR_MAP_HIGHLIGHT_THREADS} threads.`,
    };
  }
  const threads: StarMapThreadRef[] = [];
  for (const [index, entry] of args.threads.entries()) {
    const thread = entry as Record<string, unknown> | null;
    const threadId = typeof thread?.threadId === "string"
      ? thread.threadId.trim()
      : "";
    const backend = thread?.backend;
    const instanceId = thread?.instanceId;
    if (
      !threadId
      || typeof backend !== "string"
      || !isAppServerBackendKind(backend)
    ) {
      return {
        error: `highlight_star_map_threads threads[${index}] needs a threadId and a known backend.`,
      };
    }
    if (
      instanceId !== undefined
      && (typeof instanceId !== "string" || !instanceId.trim())
    ) {
      return {
        error: `highlight_star_map_threads threads[${index}].instanceId must be a non-empty string.`,
      };
    }
    threads.push({
      backend,
      threadId,
      ...(typeof instanceId === "string" ? { instanceId: instanceId.trim() } : {}),
    });
  }
  return {
    args: {
      threads,
      ...(args.clear === undefined ? {} : { clear: args.clear }),
    },
  };
}

function parseSetViewArgs(args: Record<string, unknown>): ParsedArgs {
  const parsed: SetStarMapViewToolArgs = {};
  if (args.layout !== undefined) {
    if (!STAR_MAP_VIEW_LAYOUTS.includes(args.layout as StarMapViewLayout)) {
      return {
        error: `set_star_map_view layout must be one of ${STAR_MAP_VIEW_LAYOUTS.join(", ")}.`,
      };
    }
    parsed.layout = args.layout as StarMapViewLayout;
  }
  if (args.filters !== undefined) {
    if (
      typeof args.filters !== "object"
      || args.filters === null
      || Array.isArray(args.filters)
    ) {
      return { error: "set_star_map_view filters must be an object of chip states." };
    }
    const filters: SetStarMapViewToolArgs["filters"] = {};
    for (const [key, state] of Object.entries(args.filters)) {
      if (!STAR_MAP_VIEW_FILTER_KEYS.includes(key as StarMapViewFilterKey)) {
        return {
          error: `set_star_map_view has no ${key} chip. The chips are ${STAR_MAP_VIEW_FILTER_KEYS.join(", ")}.`,
        };
      }
      if (
        !STAR_MAP_VIEW_FILTER_SETTINGS.includes(state as StarMapViewFilterSetting)
      ) {
        return {
          error: `set_star_map_view filters.${key} must be include, exclude, or neutral.`,
        };
      }
      filters[key as StarMapViewFilterKey] = state as StarMapViewFilterSetting;
    }
    parsed.filters = filters;
  }
  for (const field of ["clearFilters", "hideOfflineInstances"] as const) {
    if (args[field] === undefined) continue;
    if (typeof args[field] !== "boolean") {
      return { error: `set_star_map_view ${field} must be a boolean.` };
    }
    parsed[field] = args[field];
  }
  return { args: parsed };
}

function parseReadArgs(args: Record<string, unknown>): ParsedArgs {
  const maxThreads = optionalPositiveInteger(
    args.maxThreads,
    MAX_STAR_MAP_VIEW_MAX_THREADS,
  );
  if (maxThreads === "invalid") {
    return {
      error: `read_star_map_view maxThreads must be an integer between 1 and ${MAX_STAR_MAP_VIEW_MAX_THREADS}.`,
    };
  }
  if (
    args.instanceId !== undefined
    && (typeof args.instanceId !== "string" || args.instanceId.length === 0)
  ) {
    return {
      error: "read_star_map_view instanceId must be a non-empty string.",
    };
  }
  if (
    args.includeHidden !== undefined
    && typeof args.includeHidden !== "boolean"
  ) {
    return { error: "read_star_map_view includeHidden must be a boolean." };
  }
  return {
    args: {
      maxThreads,
      instanceId: args.instanceId as string | undefined,
      includeHidden: args.includeHidden as boolean | undefined,
    },
  };
}

function optionalPositiveInteger(
  value: unknown,
  max: number,
): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < 1
    || value > max
  ) {
    return "invalid";
  }
  return value;
}

function starMapResponseToAgentToolResult(
  response: PwrAgentStarMapResponse,
): AgentToolDispatchResult {
  if (!response.ok) {
    return agentToolFailure({
      code: response.error.code,
      message: response.error.message,
    });
  }
  return agentToolSuccess(response.data);
}
