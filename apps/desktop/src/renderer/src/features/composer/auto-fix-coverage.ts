import {
  buildPullRequestStatusKey,
  pullRequestMatchesRepositoryKey,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import {
  describeHandsOffMatch,
  findHandsOffMatch,
  type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import { resolveLifecycleState } from "../pr-status/pr-chip-state";

export type AutoFixCoverageEntry = {
  prKey: string;
  /** `owner/repo#number`. */
  label: string;
  /**
   * `on`: Auto-fix repairs it here. `off`: the operator switched it off for
   * this PR. `hands-off`: the project's Forge Automation leaves it alone,
   * which only the project's rules change.
   */
  state: "on" | "off" | "hands-off";
  /** Why a hands-off PR is left alone. */
  reason?: string;
};

/**
 * The PRs a thread's Auto-fix covers, the way main elects them: open PRs on
 * the thread's primary repository, an upstream PR opened from it included.
 * `automation` is the thread's project's Forge Automation, when this window
 * holds it; a peer's thread has none here, so no PR reads hands-off.
 */
export function describeAutoFixCoverage(
  thread: Pick<NavigationThreadSummary, "prs" | "primaryGitRepository">,
  automation: Pick<ProjectForgeAutomation, "handsOff"> | undefined,
): AutoFixCoverageEntry[] {
  return (thread.prs ?? [])
    .filter((pr) => resolveLifecycleState(pr) === "open"
      && pullRequestMatchesRepositoryKey(pr, thread.primaryGitRepository))
    .map((pr): AutoFixCoverageEntry => {
      const base = { prKey: buildPullRequestStatusKey(pr), label: `${pr.org}/${pr.repo}#${pr.number}` };
      const match = findHandsOffMatch(automation, pr);
      if (match) return { ...base, state: "hands-off", reason: describeHandsOffMatch(match) };
      return { ...base, state: pr.autoFixOff === true ? "off" : "on" };
    });
}
