import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import {
  agentToolFailure,
  agentToolSuccess,
  type AgentToolDefinition,
} from "./agent-tool-definition.js";
import type { TokenMiserStore } from "../token-miser/token-miser-store.js";

export function buildTokenMiserToolDefinitions(
  store?: TokenMiserStore,
): AgentToolDefinition[] {
  if (!store) {
    return [];
  }
  return [
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "search_token_miser_output",
      description:
        "Search one Token Miser-preserved tool result by literal text. Returns matching line numbers and bounded line contents. The output must belong to the invoking thread.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objectId", "query"],
        properties: {
          objectId: { type: "string" },
          query: { type: "string", minLength: 1 },
          maxResults: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      dispatch: async (args, context) => {
        const objectId = readString(args.objectId);
        const query = readString(args.query);
        if (!objectId || !query) return invalidArguments("objectId and query are required.");
        const result = await store.search({
          objectId,
          threadId: context.threadId,
          query,
          maxResults: readNumber(args.maxResults),
        });
        return result ? agentToolSuccess(result) : notFound();
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "read_token_miser_output",
      description:
        "Read a bounded inclusive line range from one Token Miser-preserved tool result. The output must belong to the invoking thread.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objectId"],
        properties: {
          objectId: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
      },
      dispatch: async (args, context) => {
        const objectId = readString(args.objectId);
        if (!objectId) return invalidArguments("objectId is required.");
        const result = await store.readLines({
          objectId,
          threadId: context.threadId,
          startLine: readNumber(args.startLine),
          endLine: readNumber(args.endLine),
        });
        return result ? agentToolSuccess(result) : notFound();
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "read_all_token_miser_output",
      description:
        "Deliberately retrieve an entire Token Miser-preserved tool result. This can erase the context savings; prefer search or bounded reads first. The output must belong to the invoking thread.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["objectId"],
        properties: {
          objectId: { type: "string" },
        },
      },
      dispatch: async (args, context) => {
        const objectId = readString(args.objectId);
        if (!objectId) return invalidArguments("objectId is required.");
        const result = await store.readAll({
          objectId,
          threadId: context.threadId,
        });
        return result ? agentToolSuccess(result) : notFound();
      },
    },
  ];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invalidArguments(message: string) {
  return agentToolFailure({ code: "invalid_arguments", message });
}

function notFound() {
  return agentToolFailure({
    code: "not_found",
    message: "Token Miser output was not found or does not belong to this thread.",
  });
}
