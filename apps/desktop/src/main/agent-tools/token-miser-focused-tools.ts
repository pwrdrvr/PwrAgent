import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import { agentToolFailure, type AgentToolDefinition } from "./agent-tool-definition";
import type { TokenMiserFocusedSummaries, FocusedRequest } from "../token-miser/token-miser-focused";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import { retrievalSuccess } from "./token-miser-delivery";

export function buildFocusedTokenMiserTools(store: TokenMiserStore, focused?: TokenMiserFocusedSummaries): AgentToolDefinition[] {
  return [{
    namespace: PWRAGENT_TOOL_NAMESPACE,
    advertise: focused?.isEnabled() ?? false,
    name: "summarize_token_miser_output",
    description: "Answer focused questions over selected preserved output using the configured summarizer, without returning source text. Supply up to 16 requests and 16 total selectors; each question can combine selections. Modes: head, tail, inclusive lines, or case-insensitive literal search (OR across queries, first maxMatches matching lines). Overlapping/adjacent spans within an answer merge. Limits: 60000 source bytes, 8000 total question bytes, 1000 answer bytes per request, two concurrent batches. Returns a plain authenticated string: Code Mode must emit it unchanged with text(result) for delivery accounting. segmentId retrieves the exact selected spans with read_token_miser_segment. References expire after five minutes or earlier cache eviction, source expiry, archive, restart, or next turn. Source IDs and read tools are unchanged.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["requests"],
      properties: { requests: { type: "array", minItems: 1, maxItems: 16, items: {
        type: "object", additionalProperties: false, required: ["question", "selections"],
        properties: {
          question: { type: "string", minLength: 1, maxLength: 4000 },
          selections: { type: "array", minItems: 1, maxItems: 16, items: {
            type: "object", additionalProperties: false, required: ["objectId", "mode"],
            properties: {
              objectId: { type: "string", minLength: 1, description: "Original objectId; for grouped output, use the member objectId with groupId." },
              groupId: { type: "string", minLength: 1 },
              memberId: { type: "string", minLength: 1, description: "Alternative: root sourceObjectId plus memberId; omit groupId." },
              mode: { type: "string", enum: ["head", "tail", "lines", "search"] },
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 },
              lines: { type: "integer", minimum: 1, maximum: 2000, default: 100 },
              queries: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 1000 } },
              maxMatches: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          } },
        },
      } } },
    },
    dispatch: async (args, context) => {
      if (!focused) return unavailable();
      try {
        const results = await focused.summarize(context.threadId, context.turnId, args.requests as FocusedRequest[]);
        // The batch has one authenticated delivery; use separate calls to emit a subset.
        const objectId = results[0]!.sources[0]!.objectId;
        return await retrievalSuccess({ store, context, objectId, kind: "summary",
          structuredContent: {}, visibleText: JSON.stringify({ results }),
        });
      } catch (error) {
        return agentToolFailure({ code: "focused_summary_failed", message: error instanceof Error ? error.message : "Focused summary failed." });
      }
    },
  }, {
    namespace: PWRAGENT_TOOL_NAMESPACE,
    advertise: focused?.isEnabled() ?? false,
    name: "read_token_miser_segment",
    description: "Read exact selected source spans for a focused summary segmentId. Returns JSON spans with source objectId, optional memberId, one-based inclusive line bounds, zero-based UTF-16 [start,end) offsets and exact text (including original CRLF). Noncontiguous spans stay separate; zero line bounds indicate no matches. Code Mode receives an authenticated plain string: emit it unchanged. Pages contain at most 6000 source UTF-8 bytes and 16 spans. Follow nextCursor to recover the remaining exact text; offset is relative to its span. Parent output caps still apply. Thread-owned references expire after five minutes or earlier source expiry, eviction, archive, restart, or next turn.",
    inputSchema: { type: "object", additionalProperties: false, required: ["segmentId"], properties: {
      segmentId: { type: "string", minLength: 1 },
      cursor: { type: "object", additionalProperties: false, required: ["spanIndex", "offset"], properties: {
        spanIndex: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
      } },
    } },
    dispatch: async (args, context) => {
      if (!focused || typeof args.segmentId !== "string") return unavailable();
      const result = await focused.read(args.segmentId, context.threadId, context.turnId, args.cursor as { spanIndex: number; offset: number } | undefined);
      if (!result) return unavailable();
      return await retrievalSuccess({ store, context, objectId: result.sources[0]!.objectId,
        structuredContent: {}, visibleText: JSON.stringify(result),
      });
    },
  }];
}

function unavailable() {
  return agentToolFailure({ code: "not_found", message: "Focused summary or selected source expired or unavailable for this thread." });
}
