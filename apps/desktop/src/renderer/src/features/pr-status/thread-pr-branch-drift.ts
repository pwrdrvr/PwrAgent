import { useMemo } from "react";
import {
  buildPullRequestStatusKey,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { findBranchDriftPr, type PrBranchDrift } from "./pr-branch-drift";
import { isThreadRepositoryPr, primaryRepositoryKey } from "./thread-pr-repository";

export function useThreadPrBranchDrift(thread: NavigationThreadSummary | undefined): PrBranchDrift | undefined {
  const working = thread?.gitWorkingState;
  const baseBranch = working?.baseBranch;
  const behind = working?.baseBehindCommitCount;
  const ahead = working?.baseAheadCommitCount;
  const repository = thread && primaryRepositoryKey(thread);
  const pr = thread && baseBranch && findBranchDriftPr({
    prs: thread.prs ?? [],
    branch: thread.observedGitBranch?.trim() || thread.gitBranch,
    baseBranch,
    isThreadRepository: (pr) => isThreadRepositoryPr(repository, pr),
  });
  const prKey = pr ? buildPullRequestStatusKey(pr) : undefined;

  // Keep the same object until a count or its owning PR changes.
  return useMemo(
    () => prKey && baseBranch ? { prKey, baseBranch, behind, ahead } : undefined,
    [prKey, baseBranch, behind, ahead],
  );
}
