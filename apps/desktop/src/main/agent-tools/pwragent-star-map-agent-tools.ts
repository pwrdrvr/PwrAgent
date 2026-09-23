import type {
  FlyStarMapToToolArgs,
  PwrAgentStarMapOperationName,
  PwrAgentStarMapRequest,
  PwrAgentStarMapResponse,
  ReadStarMapViewToolArgs,
} from "@pwragent/shared";
import {
  DEFAULT_STAR_MAP_VIEW_MAX_THREADS,
  MAX_STAR_MAP_VIEW_MAX_THREADS,
  PWRAGENT_STAR_MAP_OPERATION_NAMES,
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
        },
      };
  }
}

type ParsedArgs =
  | { args: ReadStarMapViewToolArgs | FlyStarMapToToolArgs }
  | { error: string };

function parseArgs(
  operation: PwrAgentStarMapOperationName,
  args: Record<string, unknown>,
): ParsedArgs {
  return operation === "fly_star_map_to"
    ? parseFlyArgs(args)
    : parseReadArgs(args);
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
