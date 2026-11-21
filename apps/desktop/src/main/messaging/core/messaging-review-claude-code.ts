import type { ReviewRunMode } from "@pwragent/shared/contracts/agent";
import type { AppServerReviewTarget } from "@pwragent/shared/contracts/normalized-app-server";
import { claudeCodeReviewTakesTarget } from "../../../shared/review-command";

/**
 * The run mode the messaging review picker shows and submits. An owner
 * without explicit modes keeps whatever was asked for. A secondary workspace
 * or another provider's reviewer needs the PwrAgent Sub Agent. Otherwise a
 * thread that reviews as Claude Code defaults to Claude Code's
 * `/code-review`, as the desktop panel does, and any other thread to the
 * Codex Sub Agent.
 */
export function resolveMessagingReviewRunMode(params: {
  claudeCodeAvailable: boolean;
  managed: boolean;
  modeSupported: boolean;
  requested?: ReviewRunMode;
}): ReviewRunMode | undefined {
  if (!params.modeSupported) {
    return params.requested;
  }
  if (params.managed) {
    return "pwragent-sub-agent";
  }
  if (params.requested === "claude-code-review" || params.requested === undefined) {
    return params.claudeCodeAvailable ? "claude-code-review" : "codex-sub-agent";
  }
  return params.requested;
}

/**
 * The target a run mode can review. Claude Code takes current changes, pull
 * requests, a branch, or a path, and starts from current changes, which is
 * what a bare `/code-review` reviews. The other modes take no branch or path,
 * so those fall back to the base branch.
 */
export function messagingReviewTargetForMode(
  target: AppServerReviewTarget,
  runMode: ReviewRunMode | undefined,
  baseBranch: string,
): AppServerReviewTarget {
  if (runMode === "claude-code-review") {
    return claudeCodeReviewTakesTarget(target) ? target : { type: "uncommittedChanges" };
  }
  return target.type === "branch" || target.type === "path"
    ? { type: "baseBranch", branch: baseBranch }
    : target;
}
