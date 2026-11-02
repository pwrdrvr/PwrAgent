import type { PrSummary } from "@pwragent/shared";
import { withForgeRepositoryNames } from "./forge-repository-names";
import type { GitHubRepoRef } from "./git-remote";

/**
 * A head branch name is only unique inside its source repository. A remote
 * also matches under the name the forge answers for it, so a checkout whose
 * remote still has a renamed repository's old name keeps its own PRs.
 */
export function prMatchesSourceRepository(
  pr: PrSummary,
  repos: GitHubRepoRef[],
): boolean {
  const source = pr.sourceRepository ?? pr;
  const host = source.provider ?? pr.provider ?? "github.com";
  return withForgeRepositoryNames(repos).some((repo) =>
    repo.host.toLowerCase() === host.toLowerCase()
    && repo.owner.toLowerCase() === source.org.toLowerCase()
    && repo.repo.toLowerCase() === source.repo.toLowerCase(),
  );
}
