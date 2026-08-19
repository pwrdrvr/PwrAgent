import type {
  CaptureStarMapToolArgs,
  PwrAgentStarMapOperationName,
  PwrAgentStarMapRequest,
  PwrAgentStarMapResponse,
  ReadStarMapViewToolArgs,
} from "@pwragent/shared";
import {
  DEFAULT_STAR_MAP_CAPTURE_MAX_WIDTH,
  DEFAULT_STAR_MAP_VIEW_MAX_THREADS,
  MAX_STAR_MAP_CAPTURE_MAX_WIDTH,
  MAX_STAR_MAP_VIEW_MAX_THREADS,
  PWRAGENT_STAR_MAP_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  AgentToolCallContext,
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
    dispatch: async (
      args,
      context: AgentToolCallContext,
    ): Promise<AgentToolDispatchResult> => {
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
      return starMapResponseToAgentToolResult(response, context);
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
        "Each thread carries the backend, threadId and instanceId tools need.",
        "Fails when no Star Map surface is open.",
      ].join(" ");
    case "capture_star_map":
      return [
        "Take a screenshot of the Star Map surface the operator is looking at.",
        "Prefer read_star_map_view, which is cheaper and carries identifiers.",
        "Reach for a capture only for spatial questions it cannot answer.",
        "An example is where one card sits relative to another.",
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
    case "capture_star_map":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          maxWidth: {
            type: "integer",
            minimum: 320,
            maximum: MAX_STAR_MAP_CAPTURE_MAX_WIDTH,
            description: `Downscale the capture to this pixel width. Defaults to ${DEFAULT_STAR_MAP_CAPTURE_MAX_WIDTH}.`,
          },
        },
      };
  }
}

type ParsedArgs =
  | { args: ReadStarMapViewToolArgs | CaptureStarMapToolArgs }
  | { error: string };

function parseArgs(
  operation: PwrAgentStarMapOperationName,
  args: Record<string, unknown>,
): ParsedArgs {
  if (operation === "read_star_map_view") {
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
  const maxWidth = optionalPositiveInteger(
    args.maxWidth,
    MAX_STAR_MAP_CAPTURE_MAX_WIDTH,
  );
  if (maxWidth === "invalid" || (maxWidth !== undefined && maxWidth < 320)) {
    return {
      error: `capture_star_map maxWidth must be an integer between 320 and ${MAX_STAR_MAP_CAPTURE_MAX_WIDTH}.`,
    };
  }
  return { args: { maxWidth } };
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
  context: AgentToolCallContext,
): AgentToolDispatchResult {
  if (!response.ok) {
    return agentToolFailure({
      code: response.error.code,
      message: response.error.message,
    });
  }
  if (!response.imageBase64) {
    return agentToolSuccess(response.data);
  }
  // Only the MCP transport carries image content back to the model. Over
  // Codex dynamic tools the capture still succeeds and the data block says
  // so, rather than the model being handed a silently text-only "image".
  if (context.transport !== "mcp") {
    return agentToolSuccess({
      ...response.data,
      imageUnavailableReason:
        "This thread reaches PwrAgent tools over Codex dynamic tools, which carry text only. Screenshots are returned to threads using the PwrAgent MCP server; read_star_map_view has the same information in structured form.",
    });
  }
  return agentToolSuccess(response.data, {
    mcpContentItems: [
      {
        type: "image",
        data: response.imageBase64,
        mimeType: response.imageMimeType ?? "image/png",
      },
    ],
  });
}
