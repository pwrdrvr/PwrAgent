import type {
  AgentEvent, AppServerReviewFindingOutcome, AppServerThreadReviewEntry, ThreadReviewIdentity,
} from "@pwragent/shared";
import { normalizeReviewOutputRecord } from "../../shared/review-command";

/** Only final review artifacts are persisted; deltas and started items are ignored. */
export function completedThreadReview(event: AgentEvent): {
  identity: ThreadReviewIdentity;
  entry: AppServerThreadReviewEntry;
} | undefined {
  if (event.federationTarget?.scope === "remote" || event.notification.method !== "item/completed") return undefined;
  const { threadId, item: value } = event.notification.params;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.type !== "exitedReviewMode" || typeof item.id !== "string") return undefined;
  const data = item.data as Record<string, unknown> | undefined;
  const timestamp = item.createdAt ?? item.created_at;
  const createdAt = typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
    : undefined;
  return {
    identity: { backend: event.backend, threadId },
    entry: {
      type: "review",
      id: item.id,
      review: typeof item.review === "string" ? item.review : typeof item.text === "string" ? item.text : "",
      createdAt,
      output: normalizeReviewOutputRecord(data?.reviewOutput ?? data?.review_output ?? item.reviewOutput ?? item.review_output),
      context: data?.context as AppServerThreadReviewEntry["context"],
    },
  };
}

/** Outcomes a reviewer reported for findings of a review it already completed. */
export function reportedThreadReviewOutcomes(event: AgentEvent): {
  identity: ThreadReviewIdentity;
  sourceKey: string;
  outcomes: AppServerReviewFindingOutcome[];
} | undefined {
  if (event.federationTarget?.scope === "remote" || event.notification.method !== "thread/review/outcomesReported") {
    return undefined;
  }
  const { threadId, reviewId, outcomes } = event.notification.params as Extract<
    AgentEvent["notification"], { method: "thread/review/outcomesReported" }
  >["params"];
  if (!reviewId || !Array.isArray(outcomes)) return undefined;
  return { identity: { backend: event.backend, threadId }, sourceKey: reviewId, outcomes };
}
