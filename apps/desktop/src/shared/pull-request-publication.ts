import type { PrSummary } from "@pwragent/shared";

/** Provider-observed PR commits were published, regardless of PR lifecycle.
 * Their ancestry remains evidence when local remote refs are stale or deleted.
 */
export function publishedPrCommitShas(prs: PrSummary[]): string[] {
  return [...new Set(prs
    .flatMap((pr) => [pr.headSha ?? "", ...(pr.commitShas ?? [])])
    .map((sha) => sha.trim().toLowerCase())
    .filter((sha) => /^[0-9a-f]{40}$/.test(sha)))];
}
