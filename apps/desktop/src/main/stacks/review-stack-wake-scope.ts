import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { ReviewAutoFixStackWakeFilter } from "../thread-reviews/review-auto-fix";

function repositoryKey(prKey: string): string {
  return prKey.slice(0, prKey.lastIndexOf("#"));
}

/** Dependencies of one review gate observation, including other layers' owners. */
export function createReviewStackWakeScope(threadKey: string, candidates: readonly PrSummary[]) {
  const prKeys = new Set(candidates.map(buildPullRequestStatusKey));
  const repositories = new Set([...prKeys].map(repositoryKey));
  const uncertainRepositories = new Set<string>();
  const threadKeys = new Set([threadKey]);
  const repairThreadKeys = new Set<string>();
  const inferredRefs = new Map<string, { heads: Set<string>; bases: Set<string> }>();
  let reading = candidates.length > 0;
  let operationScopeUnknown = false;
  let unavailable = false;

  const matches: ReviewAutoFixStackWakeFilter = (update) => {
    if ("repairThreadKey" in update) return reading || repairThreadKeys.has(update.repairThreadKey);
    if ("threadKey" in update) return reading || operationScopeUnknown || threadKeys.has(update.threadKey);
    return update.prKeys.some((key) => {
      if (prKeys.has(key)) return true;
      const repository = repositoryKey(key);
      if ((reading ? repositories : uncertainRepositories).has(repository)) return true;
      const refs = inferredRefs.get(repository);
      const { headRefName, baseRefName } = update.pr ?? {};
      return !!refs && ((headRefName !== undefined && (refs.heads.has(headRefName) || refs.bases.has(headRefName)))
        || (baseRefName !== undefined && refs.heads.has(baseRefName)));
    });
  };

  return {
    matches,
    needsRetry: () => unavailable,
    observe(pr: PrSummary, stacks: readonly StackSummary[] | undefined): void {
      const repository = repositoryKey(buildPullRequestStatusKey(pr));
      if (!stacks) {
        uncertainRepositories.add(repository);
        operationScopeUnknown = true;
        unavailable = true;
        return;
      }
      for (const stack of stacks) {
        // A local journal can mark the entire clone held. The notification
        // identifies a participant, which may be in a different stack.
        operationScopeUnknown ||= stack.journalHeld === true;
        const refs = stack.inferred
          ? inferredRefs.get(repository) ?? { heads: new Set<string>(), bases: new Set<string>() }
          : undefined;
        if (refs) inferredRefs.set(repository, refs);
        const reviewedPosition = stack.layers.findIndex((layer) => layer.pullRequest?.number === pr.number);
        for (const [position, layer] of stack.layers.entries()) {
          if (layer.pullRequest) {
            prKeys.add(`${repository}#${layer.pullRequest.number}`);
          } else {
            // A competing PR can leave this branch and resolve an
            // ambiguous layer without naming the branch in its new status.
            uncertainRepositories.add(repository);
          }
          if (layer.thread) {
            threadKeys.add(layer.thread.key);
            if (position < reviewedPosition && layer.unsettled === "repair in progress") repairThreadKeys.add(layer.thread.key);
          }
          // A new head/base relationship can reshape an inferred chain.
          refs?.heads.add(layer.branch);
          refs?.bases.add(layer.parent);
        }
      }
    },
    finish(): void {
      reading = false;
    },
  };
}
