import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import {
  agentToolFailure,
  agentToolSuccess,
  type AgentToolDefinition,
} from "./agent-tool-definition.js";
import type { TokenMiserStore } from "../token-miser/token-miser-store.js";
import type { TokenMiserGroupBatchOperation } from "../token-miser/token-miser-store.js";

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
      name: "read_token_miser_output_batch",
      description:
        "Retrieve selected members from one grouped Token Miser Code Mode result in a single bounded call. Operations run in request order and may read a full member, search it, or return its head or tail. The group must belong to the invoking thread.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["groupId", "operations"],
        properties: {
          groupId: { type: "string", minLength: 1 },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["objectId", "mode"],
              properties: {
                objectId: { type: "string" },
                mode: {
                  type: "string",
                  enum: ["full", "search", "head", "tail"],
                },
                query: { type: "string", minLength: 1 },
                maxMatches: { type: "integer", minimum: 1, maximum: 100 },
                lines: { type: "integer", minimum: 1, maximum: 500 },
              },
            },
          },
          maxOutputChars: { type: "integer", minimum: 5_000, maximum: 40_000 },
        },
      },
      dispatch: async (args, context) => {
        const groupId = readString(args.groupId);
        const operations = readBatchOperations(args.operations);
        if (!groupId || !operations) {
          return invalidArguments("groupId and valid operations are required.");
        }
        const result = await store.readGroupBatch({
          groupId,
          threadId: context.threadId,
          operations,
          maxOutputChars: readNumber(args.maxOutputChars),
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

function readBatchOperations(
  value: unknown,
): TokenMiserGroupBatchOperation[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return undefined;
  }
  const operations: TokenMiserGroupBatchOperation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const objectId = readString(record.objectId);
    const mode = record.mode;
    if (
      !objectId
      || (
        mode !== "full"
        && mode !== "search"
        && mode !== "head"
        && mode !== "tail"
      )
      || (mode === "search" && !readString(record.query))
    ) {
      return undefined;
    }
    operations.push({
      objectId,
      mode,
      ...(readString(record.query) ? { query: readString(record.query) } : {}),
      ...(readNumber(record.maxMatches) !== undefined
        ? { maxMatches: readNumber(record.maxMatches) }
        : {}),
      ...(readNumber(record.lines) !== undefined
        ? { lines: readNumber(record.lines) }
        : {}),
    });
  }
  return operations;
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
