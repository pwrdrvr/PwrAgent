import type { ThreadReviewItem } from "@pwragent/shared";
import { reviewFindingTag } from "./review-output";

type ReviewFinding = Pick<ThreadReviewItem, "title" | "priority" | "category">;

/**
 * Open findings first, then by priority; ties keep the reviewer's order. The
 * card lists findings this way, and every fix prompt sends them this way.
 */
export function orderReviewItems<T extends Pick<ThreadReviewItem, "status" | "priority">>(items: readonly T[]): T[] {
  const rank = (item: T): number => item.priority ?? 9;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      Number(a.item.status !== "open") - Number(b.item.status !== "open")
      || rank(a.item) - rank(b.item)
      || a.index - b.index)
    .map(({ item }) => item);
}

function findingLines(items: readonly ReviewFinding[]): string[] {
  return items.map((item, index) => {
    const tag = reviewFindingTag(item);
    return `${index + 1}. ${tag ? `[${tag}] ` : ""}${item.title}`;
  });
}

/**
 * The reply the review card's Fix button sends to the review's own thread:
 * the findings the operator picked, by title. `list_reviews` returns their
 * details and ids, and with them how to settle each one.
 */
export function fixReviewFindingsPrompt(reviewTitle: string, items: readonly ReviewFinding[]): string {
  return [
    items.length === 1
      ? `Fix this finding from ${reviewTitle}:`
      : `Fix these ${items.length} findings from ${reviewTitle}:`,
    "",
    ...findingLines(items),
    "",
    "Use PwrAgent's `list_reviews` tool for their details and how to record each fix.",
  ].join("\n");
}

/**
 * The reply Auto-fix sends to the review's own thread, from the card or when
 * a review started with auto-fix finishes. The thread's agent, not the
 * reviewer, decides each finding: fix it, defer it to a To-do card, or
 * decline it. Settling every finding without a push is a good outcome when
 * nothing merits one, because each push starts a CI run.
 */
export function autoFixReviewFindingsPrompt(reviewTitle: string, items: readonly ReviewFinding[]): string {
  return [
    items.length === 1
      ? `Auto-fix the finding from ${reviewTitle}. Decide whether to fix it.`
      : `Auto-fix the ${items.length} findings from ${reviewTitle}. Decide which ones to fix.`,
    "",
    ...findingLines(items),
    "",
    "Use PwrAgent's `list_reviews` tool for each finding's details. Settle every finding with `update_review_item`:",
    "",
    "- addressed: it is a real problem in this change. Fix it, and note what changed.",
    "- deferred: it is worth doing, but needs a new system or is well outside this change's scope."
      + " Raise a To-do card with `add_todo` whose prompt stands alone, then pass its id.",
    "- declined: it only fixes a contrived case that is unlikely to happen, or it is wrong. Note why.",
    "",
    "Each push starts a CI run. When only minor findings would change code, consider whether they are"
      + " worth a run; settling every finding without a code change is a good outcome."
      + " Do not decline a correctness bug to avoid a push.",
    "",
    "Make all the fixes and run the relevant checks. If this thread has a pull request, commit and push them once.",
    "End with one line per finding: its outcome and why.",
  ].join("\n");
}
