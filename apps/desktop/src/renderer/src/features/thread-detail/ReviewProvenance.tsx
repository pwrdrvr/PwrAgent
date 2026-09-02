import type {
  AppServerReviewContext,
  AppServerReviewPullRequest,
  PrSummary,
} from "@pwragent/shared";
import { useMemo } from "react";
import { reviewComparedPastPullRequestBase } from "../../../../shared/review-command";
import { BranchIcon } from "../../icons/BranchIcon";
import { FolderIcon } from "../../icons/FolderIcon";
import { WorktreeIcon } from "../../icons/WorktreeIcon";
import { useLivePullRequest } from "../../lib/pull-request-links";
import { CopyableThreadChip } from "../navigation/ThreadMetaChips";
import { PrChip } from "../pr-status/PrChip";

type ReviewProvenanceProps = {
  context: AppServerReviewContext;
};

/**
 * A review runs in one of a thread's linked directories, and the card's summary
 * line never says which. The chips answer that before the card gets to what the
 * review found: which project, which branch, and which pull request.
 *
 * The association is frozen — resolved once when the review started — so a
 * card from last month keeps naming the workspace, branch, and PR it reviewed.
 * The PR chip may hydrate that same PR identity with current canonical status;
 * status can move without relabelling what the review was about.
 */
export function ReviewProvenance(props: ReviewProvenanceProps) {
  const context = props.context;
  const isWorktree = Boolean(context.repositoryPath);
  const projectLabel = context.projectLabel ?? "Project";
  const branch = context.gitBranch?.trim();
  const branchLabel = formatBranchLabel(context);
  const pullRequest = context.pullRequest;

  return (
    <div
      aria-label="What was reviewed"
      className="transcript-review__provenance"
      role="group"
    >
      <CopyableThreadChip
        aria-label={`Copy workspace path for ${projectLabel}`}
        className="review-chip review-chip--project path-copy-target"
        tooltipText={formatWorkspaceTooltip(context)}
        value={context.workspacePath}
      >
        <span aria-hidden="true" className="review-chip__icon">
          <FolderIcon size={12} />
        </span>
        <span className="review-chip__label">{projectLabel}</span>
        {isWorktree ? (
          <span aria-hidden="true" className="review-chip__icon">
            <WorktreeIcon size={11} />
          </span>
        ) : null}
      </CopyableThreadChip>

      {branchLabel ? (
        <CopyableThreadChip
          aria-label={`Copy branch ${branch ?? branchLabel}`}
          className="review-chip path-copy-target"
          value={branch ?? branchLabel}
        >
          <span aria-hidden="true" className="review-chip__icon">
            <BranchIcon size={12} />
          </span>
          <span className="review-chip__label">{branchLabel}</span>
        </CopyableThreadChip>
      ) : null}

      {pullRequest ? (
        <ReviewPullRequestChip pullRequest={pullRequest} />
      ) : pullRequest === null ? (
        // Distinct from an absent field: the branch was checked and carried no
        // pull request. Saying so is the difference between an answer and a
        // reader wondering whether anything was looked at.
        <span className="review-chip review-chip--empty">
          <span className="review-chip__label">no PR at review time</span>
        </span>
      ) : null}
    </div>
  );
}

function ReviewPullRequestChip(props: {
  pullRequest: AppServerReviewPullRequest;
}) {
  const fallback = useMemo<PrSummary>(
    () => ({ ...props.pullRequest, state: "unknown" }),
    [props.pullRequest],
  );
  const pullRequest = useLivePullRequest(fallback);
  return (
    <PrChip
      pr={pullRequest}
      showRepoPrefix
      onOpen={openPullRequest}
    />
  );
}

function openPullRequest(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * The base half only earns its space when the review did not compare against
 * the pull request's own base — a stacked branch reviewed against `origin/main`
 * rather than the branch below it. Everywhere else the card's summary line
 * already names the base, and repeating it here would be noise.
 */
function formatBranchLabel(
  context: AppServerReviewContext,
): string | undefined {
  const branch = context.gitBranch?.trim();
  if (!branch) {
    return undefined;
  }
  const base = context.baseBranch?.trim();
  // GitHub reports a bare `main` while a review target is usually written
  // `origin/main`, so the two have to be compared as refs. Comparing the raw
  // strings put the arrow on every ordinary review and hid it on the stacked
  // one it exists for.
  return reviewComparedPastPullRequestBase(
    base,
    context.pullRequest?.baseRefName,
  )
    ? `${branch} → ${base}`
    : branch;
}

function formatWorkspaceTooltip(context: AppServerReviewContext): string {
  const repositoryPath = context.repositoryPath?.trim();
  return repositoryPath
    ? `${context.workspacePath}\nWorktree of ${repositoryPath}`
    : context.workspacePath;
}
