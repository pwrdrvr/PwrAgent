import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import {
  agentToolFailure,
  agentToolSuccess,
  type AgentToolDefinition,
} from "./agent-tool-definition.js";
import type { TokenMiserStore } from "../token-miser/token-miser-store.js";
import type { TokenMiserGroupBatchOperation } from "../token-miser/token-miser-store.js";
import { TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS } from "../token-miser/token-miser-types.js";

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
        "Search one preserved tool result by literal text. The returned matches remain subject to the 10k-token parent-result cap. Code Mode receives a plain string and should emit that string directly; MCP clients receive an ordinary text content block. The source must belong to the invoking thread.",
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
        return result
          ? await retrievalSuccess({
              store,
              context,
              objectId,
              structuredContent: {
                objectId: result.objectId,
                totalLines: result.totalLines,
                matchCount: result.matches.length,
              },
              visibleText: JSON.stringify(result, null, 2),
            })
          : notFound();
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "read_token_miser_output",
      description:
        "Read an inclusive line range from one preserved tool result. The returned range remains subject to the 10k-token parent-result cap, including one very long line. Code Mode receives the requested text as a plain string and should emit that string directly; MCP clients receive an ordinary text content block. The source must belong to the invoking thread.",
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
        return result
          ? await retrievalSuccess({
              store,
              context,
              objectId,
              structuredContent: {
                objectId: result.objectId,
                startLine: result.startLine,
                endLine: result.endLine,
                totalLines: result.totalLines,
              },
              visibleText: result.text,
            })
          : notFound();
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "read_token_miser_output_batch",
      description:
        "Read selected members from one grouped Code Mode result in a single call. Operations run in request order and may read a complete member, search it, or return its head or tail. Code Mode receives one plain string and should emit it directly. The group must belong to the invoking thread.",
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
        return result
          ? await retrievalSuccess({
              store,
              context,
              objectId: result.sourceObjectId,
              maxResponseCharacters: readNumber(args.maxOutputChars),
              structuredContent: {
                sourceObjectId: result.sourceObjectId,
                groupId: result.groupId,
                resultCount: result.results.length,
                truncated: result.truncated,
              },
              visibleText: JSON.stringify(result, null, 2),
            })
          : notFound();
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "read_all_token_miser_output",
      description:
        "Read the preserved tool result up to the 10k-token parent-result cap as plain text in Code Mode or a text content block over MCP. Use line-range reads for additional material. The source must belong to the invoking thread.",
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
        return result
          ? await retrievalSuccess({
              store,
              context,
              objectId,
              structuredContent: {
                objectId: result.objectId,
                startLine: result.startLine,
                endLine: result.endLine,
                totalLines: result.totalLines,
              },
              visibleText: result.text,
            })
          : notFound();
      },
    },
  ];
}

async function retrievalSuccess(params: {
  store: TokenMiserStore;
  context: { threadId: string };
  objectId: string;
  maxResponseCharacters?: number;
  structuredContent: Record<string, unknown>;
  visibleText: string;
}) {
  let visibleText = params.visibleText;
  // Bound the tool response itself as well as the later outer Code Mode cell.
  // The first boundary prevents a requested minified line from becoming an
  // enormous nested result; confirmation enforces the shared outer ceiling.
  const maxResponseCharacters =
    params.maxResponseCharacters
    ?? TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS;
  while (true) {
    const delivery = await params.store.prepareRetrievalDelivery({
      objectId: params.objectId,
      threadId: params.context.threadId,
      visibleText,
    });
    if (!delivery) {
      return notFound();
    }
    const payload = {
      content: [{ type: "text", text: delivery.text }],
      structuredContent: params.structuredContent,
    };
    if (
      delivery.text.length <= maxResponseCharacters
    ) {
      return agentToolSuccess(payload, {
        contentItems: [{ type: "inputText", text: delivery.text }],
        mcpContentItems: [{ type: "text", text: delivery.text }],
      });
    }
    params.store.abandonRetrievalDelivery(delivery.deliveryId);
    const nextLength = Math.max(
      0,
      visibleText.length
      - (delivery.text.length - maxResponseCharacters)
      - 64,
    );
    if (nextLength >= visibleText.length) {
      return agentToolFailure({
        code: "output_budget_exceeded",
        message: "The bounded Token Miser retrieval could not fit its response budget.",
      });
    }
    visibleText = `${visibleText.slice(0, nextLength)}\n… retrieval truncated`;
  }
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
