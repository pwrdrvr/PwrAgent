import type { AppServerReviewContext } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadReviewItem } from "@pwragent/shared/contracts/thread-reviews";
import { reviewFindingPullRequests } from "./pull-request-review";
import { reviewFindingTag } from "./review-output";

type ReviewFinding = Pick<ThreadReviewItem, "title" | "priority" | "category" | "codeLocation">;

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

/**
 * One line per finding. A combined review's finding also names the reviewed
 * pull requests that changed its file, so the agent can tell which branch a
 * fix belongs on.
 */
function findingLines(items: readonly ReviewFinding[], context?: AppServerReviewContext): string[] {
  return items.map((item, index) => {
    const tag = reviewFindingTag(item);
    const pullRequests = item.codeLocation
      ? reviewFindingPullRequests(item.codeLocation.absolute_file_path, context)
      : undefined;
    const where = pullRequests?.length
      ? ` (in ${pullRequests.map((pr) => `#${pr.number}`).join(", ")})`
      : "";
    return `${index + 1}. ${tag ? `[${tag}] ` : ""}${item.title}${where}`;
  });
}

/**
 * The reply the review card's Fix button sends to the review's own thread:
 * the findings the operator picked, by title. `list_reviews` returns their
 * details and ids, and with them how to settle each one.
 */
export function fixReviewFindingsPrompt(
  reviewTitle: string,
  items: readonly ReviewFinding[],
  context?: AppServerReviewContext,
): string {
  return [
    items.length === 1
      ? `Fix this finding from ${reviewTitle}:`
      : `Fix these ${items.length} findings from ${reviewTitle}:`,
    "",
    ...findingLines(items, context),
    "",
    "Use PwrAgent's `list_reviews` tool for their details and how to record each fix.",
    "Do not schedule another review (`start_review`) when finished; report each finding's outcome and let the operator decide whether to review again.",
  ].join("\n");
}

/**
 * The reply Auto-fix sends to the review's own thread, from the card or when
 * a review started with auto-fix finishes. The thread's agent, not the
 * reviewer, decides each finding: fix it, defer it to a To-do card, or
 * decline it. Settling every finding without a push is a good outcome when
 * nothing merits one, because each push starts a CI run.
 */
export function autoFixReviewFindingsPrompt(
  reviewTitle: string,
  items: readonly ReviewFinding[],
  context?: AppServerReviewContext,
): string {
  return [
    items.length === 1
      ? `Auto-fix the finding from ${reviewTitle}. Decide whether to fix it.`
      : `Auto-fix the ${items.length} findings from ${reviewTitle}. Decide which ones to fix.`,
    "",
    ...findingLines(items, context),
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
    "Do not schedule another review (`start_review`) when finished; report each finding's outcome and let the operator decide whether to review again.",
    "End with one line per finding: its outcome and why.",
  ].join("\n");
}

const AUTO_FIX_PROMPT_HEADER =
  /^Auto-fix the (?:finding|\d+ findings) from [^\n]+\. Decide (?:whether|which ones) to fix (?:it|them)\.\n\n1\. /;
const AUTO_FIX_PROMPT_MARKER =
  "Use PwrAgent's `list_reviews` tool for each finding's details. Settle every finding with `update_review_item`:";
const FIX_PROMPT_HEADER =
  /^Fix (?:this finding|these \d+ findings) from [^\n]+:\n\n1\. /;
const FIX_PROMPT_MARKER =
  "Use PwrAgent's `list_reviews` tool for their details and how to record each fix.";

/**
 * Recognizes the canonical PwrAgent review-fix prompts so an owner still treats
 * card-triggered review-fix turns from older Federation viewers as review-fix
 * turns even without the explicit `reviewFix` request flag.
 */
export function isReviewFixPromptText(text: string): boolean {
  const trimmed = text.trimStart();
  return (AUTO_FIX_PROMPT_HEADER.test(trimmed) && trimmed.includes(AUTO_FIX_PROMPT_MARKER))
    || (FIX_PROMPT_HEADER.test(trimmed) && trimmed.includes(FIX_PROMPT_MARKER));
}
