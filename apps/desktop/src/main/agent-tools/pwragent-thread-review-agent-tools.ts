import type {
  ListThreadReviewsRequest,
  RecordThreadReviewInput,
  ThreadReview,
  ThreadReviewIdentity,
  UpdateThreadReviewRequest,
} from "@pwragent/shared";
import { PWRAGENT_THREAD_REVIEW_OPERATION_NAMES, PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type { AgentToolDefinition } from "./agent-tool-definition";
import { agentToolFailure, agentToolSuccess } from "./agent-tool-definition";
import { ThreadReviewError } from "../thread-reviews/thread-review-service";

export type PwrAgentThreadReviewHandler = {
  record: (identity: ThreadReviewIdentity, input: RecordThreadReviewInput) => ThreadReview | Promise<ThreadReview>;
  list: (identity: ThreadReviewIdentity, status: ListThreadReviewsRequest["status"]) => ThreadReview[];
  update: (identity: ThreadReviewIdentity, request: UpdateThreadReviewRequest) => ThreadReview;
};

const stringField = { type: "string", minLength: 1, maxLength: 10_000 };
const resolutionFields = {
  id: { ...stringField, description: "Review id from list_reviews or record_review." },
  note: { ...stringField, description: "Required when settling work: explain the fix or why it should not be addressed." },
  url: { ...stringField, description: "Optional HTTP(S) link to the commit, resolution, or dismissal discussion." },
};

const schemas: Record<(typeof PWRAGENT_THREAD_REVIEW_OPERATION_NAMES)[number], Record<string, unknown>> = {
  record_review: {
    type: "object", additionalProperties: false, required: ["sourceKey", "title", "items"],
    properties: {
      sourceKey: { ...stringField, description: "Stable review artifact id or URL. Reusing it returns the existing review without reopening findings." },
      sourceUrl: stringField, title: stringField, summary: stringField,
      items: {
        type: "array", maxItems: 200,
        items: { type: "object", additionalProperties: false, required: ["title"], properties: {
          title: stringField, body: stringField,
          priority: { type: "integer", minimum: 0, maximum: 3 },
        } },
      },
    },
  },
  list_reviews: {
    type: "object", additionalProperties: false,
    properties: { status: { type: "string", enum: ["open", "handled", "dismissed", "all"] } },
  },
  update_review_item: {
    type: "object", additionalProperties: false, required: ["id", "itemId", "status"],
    properties: { ...resolutionFields, itemId: stringField, status: { type: "string", enum: ["open", "addressed", "dismissed"] } },
  },
  update_review: {
    type: "object", additionalProperties: false, required: ["id", "status"],
    properties: { ...resolutionFields, status: { type: "string", enum: ["open", "handled", "dismissed"] } },
  },
};

/**
 * How to settle a finding, carried in the list_reviews result: the agent
 * reads it where it reads the findings, once per lookup, instead of a note
 * repeated every turn that would pull its attention to reviews.
 */
export const OPEN_FINDINGS_GUIDANCE =
  "Work on these findings only when the operator asks you to. When you fix one, mark it addressed with update_review_item: a short note on what changed, and a commit or pull request link when there is one.";

const descriptions = {
  record_review: "Track an external or manually written code review on this thread. Native and managed reviews are tracked automatically. Use a stable sourceKey. Findings remain on the operator's To-do list until addressed or dismissed. Do not use this for progress updates.",
  list_reviews: "List this thread's tracked reviews and findings, including stable ids, statuses, last update dates, and resolution notes/links. Defaults to open reviews. Read dismissed reviews with status all: do not address them unless the operator asks to reopen them.",
  update_review_item: "Mark a finding addressed after fixing it, dismissed with a reason, or open again. Document the resolution in note and optionally url. Settling the last open finding automatically marks the review handled and removes it from To-dos.",
  update_review: "Dismiss, reopen, or document an entire review as handled. Dismissed reviews remain visible as Did not address. A review with open findings cannot be marked handled: settle each finding first. Use note and optionally url to document the final outcome.",
};

export function buildPwrAgentThreadReviewToolDefinitions(
  handler: PwrAgentThreadReviewHandler | undefined,
): AgentToolDefinition[] {
  return PWRAGENT_THREAD_REVIEW_OPERATION_NAMES.map((operation) => ({
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    annotations: { readOnlyHint: operation === "list_reviews" },
    description: descriptions[operation],
    inputSchema: schemas[operation],
    deferLoading: true,
    dispatch: async (args, context) => {
      if (!handler) return agentToolFailure({ code: "internal_error", message: "Review tracking is unavailable." });
      const identity = { backend: context.backend, threadId: context.threadId };
      try {
        if (operation === "list_reviews") {
          const status = args.status ?? "open";
          if (!["open", "handled", "dismissed", "all"].includes(String(status))) throw new ThreadReviewError("invalid_arguments", "Invalid review status.");
          const reviews = handler.list(identity, status as ListThreadReviewsRequest["status"]);
          const hasOpenFindings = reviews.some((review) =>
            review.status === "open" && review.items.some((item) => item.status === "open"));
          return agentToolSuccess({ reviews, ...(hasOpenFindings ? { guidance: OPEN_FINDINGS_GUIDANCE } : {}) });
        }
        if (operation === "record_review") {
          const sourceKey = requiredString(args.sourceKey);
          const title = requiredString(args.title);
          if (!Array.isArray(args.items) || args.items.length > 200) throw new ThreadReviewError("invalid_arguments", "Provide at most 200 findings.");
          const items = args.items.map((value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new ThreadReviewError("invalid_arguments", "Invalid finding.");
            const item = value as Record<string, unknown>;
            if (item.priority !== undefined && (!Number.isInteger(item.priority) || Number(item.priority) < 0 || Number(item.priority) > 3)) throw new ThreadReviewError("invalid_arguments", "Priority must be 0 through 3.");
            return { title: requiredString(item.title), body: optionalString(item.body), priority: item.priority as number | undefined };
          });
          return agentToolSuccess({ review: await handler.record(identity, {
            sourceKey, title, items, sourceUrl: optionalString(args.sourceUrl), summary: optionalString(args.summary), clean: items.length === 0,
          }) });
        }
        const itemId = operation === "update_review_item" ? requiredString(args.itemId) : undefined;
        return agentToolSuccess({ review: handler.update(identity, {
          id: requiredString(args.id), itemId,
          status: requiredString(args.status) as UpdateThreadReviewRequest["status"],
          note: optionalString(args.note), url: optionalString(args.url),
        }) });
      } catch (error) {
        return agentToolFailure({
          code: error instanceof ThreadReviewError ? error.code : "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }));
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 10_000) {
    throw new ThreadReviewError("invalid_arguments", "Expected a nonempty string of at most 10,000 characters.");
  }
  return value.trim();
}
