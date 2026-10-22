import type { PrSummary } from "@pwragent/shared";
import type { GitHubRepoRef } from "./git-remote";

/** A head branch name is only unique inside its source repository. */
export function prMatchesSourceRepository(
  pr: PrSummary,
  repos: GitHubRepoRef[],
): boolean {
  const source = pr.sourceRepository ?? pr;
  const host = source.provider ?? pr.provider ?? "github.com";
  return repos.some((repo) =>
    repo.host.toLowerCase() === host.toLowerCase()
    && repo.owner.toLowerCase() === source.org.toLowerCase()
    && repo.repo.toLowerCase() === source.repo.toLowerCase(),
  );
}
