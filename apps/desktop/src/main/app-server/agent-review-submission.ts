import { createHash } from "node:crypto";
import type { TurnInputSource } from "@pwragent/owner-core/turn-input-source";
import type { StartReviewRequest } from "@pwragent/shared/contracts/agent";
import type {
  AppServerReviewPullRequestSnapshot,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
} from "@pwragent/shared/contracts/normalized-app-server";
import { isReviewFixPromptText } from "../../shared/review-fix-prompts";
import { normalizeWorkspacePath } from "./review-workspace-guard";

export function isOperatorReviewInput(source?: TurnInputSource): boolean {
  return source === "desktop" || source === "federation" || source === "messaging";
}

/**
 * True when a turn was started to settle findings from an existing review:
 * automatic review Auto-fix, a review card's Auto-fix / Fix / Fix now control,
 * or an older Federation viewer sending the canonical review-fix prompt.
 * Review-fix turns must never reset the agent review allowance or schedule
 * another review via `start_review`.
 */
export function isReviewFixTurnInput(params: {
  reviewFix?: boolean;
  messageOrigin?: AppServerThreadMessageOrigin;
  input?: readonly AppServerTurnInputItem[];
}): boolean {
  if (params.reviewFix === true || params.messageOrigin?.reviewAutoFix !== undefined) return true;
  if (!params.input) return false;
  return params.input.some(
    (item) => item.type === "text" && typeof item.text === "string" && isReviewFixPromptText(item.text),
  );
}

function pullRequestDiff(snapshot: AppServerReviewPullRequestSnapshot): string {
  const { pullRequest, headCommit, mergeBaseCommit } = snapshot;
  return JSON.stringify([
    pullRequest.provider.toLowerCase(), pullRequest.org.toLowerCase(), pullRequest.repo.toLowerCase(),
    pullRequest.number, mergeBaseCommit, headCommit,
  ]);
}

/** Only owner-resolved, immutable diffs can be compared across turns. */
function immutableReviewDiff({ target, cwd }: StartReviewRequest): string | undefined {
  const workspace = cwd ? normalizeWorkspacePath(cwd) : undefined;
  if (target.type === "commit" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(target.sha)) {
    return JSON.stringify([workspace, target.type, target.sha.toLowerCase()]);
  }
  if (target.type === "pullRequest" && target.snapshot) {
    return JSON.stringify([workspace, "pullRequests", [pullRequestDiff(target.snapshot)]]);
  }
  if (target.type === "pullRequests") {
    const diffs = target.pullRequests.flatMap(({ snapshot }) => snapshot ? [pullRequestDiff(snapshot)] : []);
    if (diffs.length === target.pullRequests.length) {
      return JSON.stringify([workspace, target.type, diffs.sort()]);
    }
  }
  return undefined;
}

/** A persisted receipt identifies the diff without retaining prompt or path text. */
export function immutableReviewDiffHash(request: StartReviewRequest): string | undefined {
  const diff = immutableReviewDiff(request);
  return diff && createHash("sha256").update(diff).digest("hex");
}
