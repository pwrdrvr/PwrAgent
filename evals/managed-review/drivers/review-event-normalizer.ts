import { normalizeReviewOutputRecord } from "@pwragent/shared/review-command";
import {
  normalizeOverallCorrectness,
  parsePlainReview,
  parseReviewOutputText,
} from "@pwragent/shared/review-output";
import type { AppServerReviewOutput } from "@pwragent/shared/contracts/normalized-app-server";

const REVIEW_COMMENTS_HEADING_RE = /\n\s*(?:Full\s+)?Review comments?:\s*\n/i;
const REVIEWER_NO_RESPONSE_SENTINEL = "Reviewer failed to output a response.";
const CLEAN_COMMENTS_SENTINEL_RE = /^(?:no findings|none)\.?$/i;

/**
 * Matches a terminal turn notification against the active review turn.
 *
 * Codex native `review/start` emits terminal events under Codex's inner turn ID
 * while attaching the outer `started.turnId` on `event.relatedReviewTurnId`.
 */
export function isReviewTerminalEventMatch(params: {
  expectedTurnId?: string;
  eventTurnId?: string;
  relatedReviewTurnId?: string;
}): boolean {
  const { expectedTurnId, eventTurnId, relatedReviewTurnId } = params;
  if (!eventTurnId && !relatedReviewTurnId) return false;
  if (!expectedTurnId) return true;
  return eventTurnId === expectedTurnId || relatedReviewTurnId === expectedTurnId;
}

/**
 * Normalize an `exitedReviewMode` item using the same priority chain PwrAgent
 * uses for structured outputs, with plain-text `parsePlainReview` fallback for
 * Codex native `review/start` runs (`allowPlainTextReview: true`).
 */
export function extractReviewFromExitedItem(
  item: Record<string, unknown>,
  options: { allowPlainTextReview?: boolean } = {},
): { reviewOutput?: AppServerReviewOutput; reviewText?: string } {
  const data = item.data && typeof item.data === "object" && !Array.isArray(item.data)
    ? (item.data as Record<string, unknown>)
    : undefined;
  const reviewText = typeof item.review === "string"
    ? item.review
    : typeof item.text === "string"
      ? item.text
      : undefined;

  const structured = normalizeReviewOutputRecord(
    data?.reviewOutput ?? data?.review_output ?? item.reviewOutput ?? item.review_output,
  ) ?? parseReviewOutputText(reviewText);

  if (structured) {
    return {
      reviewOutput: structured,
      ...(reviewText !== undefined ? { reviewText } : {}),
    };
  }

  if (!options.allowPlainTextReview || !reviewText?.trim()) {
    return reviewText !== undefined ? { reviewText } : {};
  }

  const trimmed = reviewText.trim();
  if (trimmed === REVIEWER_NO_RESPONSE_SENTINEL) {
    return { reviewText };
  }

  const parsed = parsePlainReview(reviewText);
  if (parsed.findings.length > 0) {
    return {
      reviewText,
      reviewOutput: {
        findings: parsed.findings,
        overall_correctness: "patch is incorrect",
        overall_explanation: parsed.explanation || trimmed,
      },
    };
  }

  const sections = reviewText.split(REVIEW_COMMENTS_HEADING_RE);
  if (sections.length > 1) {
    const trailing = (sections[1] ?? "").trim();
    if (trailing && !CLEAN_COMMENTS_SENTINEL_RE.test(trailing)) {
      // A comments section existed but did not parse into structured findings;
      // fail loudly instead of silently reporting 0 findings.
      return { reviewText };
    }
  }

  const explanation = parsed.explanation || trimmed;
  return {
    reviewText,
    reviewOutput: {
      findings: [],
      overall_correctness: normalizeOverallCorrectness(explanation, []),
      overall_explanation: explanation,
    },
  };
}
