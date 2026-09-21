import type { AppServerReviewTarget } from "@pwragent/shared";
import {
  MANAGED_REVIEW_CONTEXT_CLOSE_MARKER,
  reviewTargetInstructions,
  MANAGED_REVIEW_CONTEXT_OPEN_MARKER,
} from "../../shared/review-command";
import { REVIEW_OUTPUT_INSTRUCTIONS } from "../../shared/review-output";

export function buildManagedReviewPrompt(
  target: AppServerReviewTarget,
): string {
  return [
    "Perform a code review. Focus on concrete correctness regressions introduced by the requested changes. Do not modify files.",
    reviewTargetInstructions(target),
    REVIEW_OUTPUT_INSTRUCTIONS,
  ].join("\n\n");
}

export function buildManagedReviewContextInput(outputs: string[]): string {
  return [
    MANAGED_REVIEW_CONTEXT_OPEN_MARKER,
    ...outputs.map((output, index) => [
      outputs.length > 1 ? `Review ${index + 1}:` : undefined,
      output.trim(),
    ].filter((line): line is string => Boolean(line)).join("\n")),
    MANAGED_REVIEW_CONTEXT_CLOSE_MARKER,
  ].join("\n\n");
}
