import type { AppServerReviewTarget } from "@pwragent/shared";

export type ParsedReviewCommand = {
  target: AppServerReviewTarget;
  displayText: string;
};

export function formatReviewCommand(target: AppServerReviewTarget): string {
  if (target.type === "uncommittedChanges") {
    return "/review";
  }
  if (target.type === "baseBranch") {
    return `/review ${target.branch}`;
  }
  if (target.type === "commit") {
    return `/review --commit ${[target.sha, target.title].filter(Boolean).join(" ")}`;
  }
  return `/review --custom ${target.instructions}`;
}

/**
 * Delimiters wrapping the managed-review artifact that PwrAgent prepends to the
 * next prompt after a review finishes. The agent needs the text in its context
 * window; the operator does not need to read it in the transcript, and ACP
 * agents echo every prompt back as a `user_message_chunk`. Both the writer
 * (`buildManagedReviewContextInput`) and the transcript filter
 * (`stripManagedReviewContextBlock`) key off these exact strings — change one
 * and the block starts rendering as a user message again.
 */
export const MANAGED_REVIEW_CONTEXT_OPEN_MARKER =
  "[PwrAgent review sub-agent results — context for this turn]";
export const MANAGED_REVIEW_CONTEXT_CLOSE_MARKER =
  "[End PwrAgent review sub-agent results]";

/**
 * Removes the wrapped review-context block from prompt text meant for display.
 * Returns the remaining operator-authored text, or an empty string when the
 * block was the whole message.
 *
 * Handles a block split across streamed chunks in either direction: a chunk
 * holding only the opening half drops its whole tail, and a chunk holding only
 * the closing half drops everything up to and including the close marker.
 * Without the second case the artifact's tail renders as a user message.
 */
export function stripManagedReviewContextBlock(value: string): string {
  const start = value.indexOf(MANAGED_REVIEW_CONTEXT_OPEN_MARKER);
  const closeAt = value.indexOf(
    MANAGED_REVIEW_CONTEXT_CLOSE_MARKER,
    start === -1 ? 0 : start,
  );
  if (start === -1) {
    return closeAt === -1
      ? value
      : value.slice(closeAt + MANAGED_REVIEW_CONTEXT_CLOSE_MARKER.length).trim();
  }
  // An unterminated block means the whole tail is review context — a truncated
  // or still-streaming echo. Dropping it beats rendering half an artifact.
  const end =
    closeAt === -1
      ? value.length
      : closeAt + MANAGED_REVIEW_CONTEXT_CLOSE_MARKER.length;
  return `${value.slice(0, start)}${value.slice(end)}`.trim();
}

export function normalizeReviewDisplayText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (/^current changes$/i.test(normalized)) {
    return "Review current changes";
  }

  const branchMatch = /^(?:review\s+)?changes\s+against\s+(.+)$/i.exec(normalized);
  if (branchMatch) {
    return `Review changes against ${stripWrappingQuotes(branchMatch[1])}`;
  }

  const commitMatch = /^(?:review\s+)?commit\s+(.+)$/i.exec(normalized);
  if (commitMatch) {
    return `Review commit ${stripWrappingQuotes(commitMatch[1])}`;
  }

  if (/^custom instructions$/i.test(normalized)) {
    return "Review custom instructions";
  }

  if (/^(review|code review)\b/i.test(normalized)) {
    return normalized;
  }

  return `Review ${normalized}`;
}

export function parseReviewCommand(input: string): ParsedReviewCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^\/review(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const argument = match[1]?.trim() ?? "";
  if (!argument) {
    return {
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
    };
  }

  const customPrefix = "--custom";
  if (argument === customPrefix || argument.startsWith(`${customPrefix} `)) {
    const instructions = argument.slice(customPrefix.length).trim();
    if (!instructions) {
      return undefined;
    }
    return {
      target: { type: "custom", instructions },
      displayText: "Review custom instructions",
    };
  }

  const commitPrefix = "--commit";
  if (argument === commitPrefix || argument.startsWith(`${commitPrefix} `)) {
    const rest = argument.slice(commitPrefix.length).trim();
    const [sha, ...titleParts] = rest.split(/\s+/);
    if (!sha) {
      return undefined;
    }
    const title = titleParts.join(" ").trim();
    return {
      target: {
        type: "commit",
        sha,
        title: title || null,
      },
      displayText: `Review commit ${sha}`,
    };
  }

  return {
    target: { type: "baseBranch", branch: argument },
    displayText: `Review changes against ${argument}`,
  };
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^(['"])(.*)\1$/, "$2").trim();
}

/**
 * Keeps a reviewer-reported confidence only when it can mean something.
 *
 * The score is the reviewer's own confidence that its `overall_correctness`
 * verdict is right. Three values look like numbers and are not judgements:
 *
 * - Exactly `0`. The output schema in the review prompt has to show the field,
 *   and whatever value it shows is the one a weaker model copies through. A
 *   literal zero next to "patch is correct" is a transcription, not a reviewer
 *   with no confidence at all.
 * - Anything above 1. A model answering `95` may mean 95%, or may mean nothing.
 *   Rescaling it guesses at intent; dropping it does not.
 * - Anything below 0, or non-finite.
 *
 * Dropping the value is safe because the verdict stands on its own — readers
 * render the correctness without a number. Substituting zero would not.
 */
export function normalizeReviewConfidenceScore(
  value: unknown,
): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value <= 1
    ? value
    : undefined;
}
