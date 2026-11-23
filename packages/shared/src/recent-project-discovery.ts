import type {
  DiscoverRecentProjectsResponse,
  RecentProjectSourceReport,
} from "./contracts/settings";

const STATUS_WEIGHT: Record<RecentProjectSourceReport["status"], number> = {
  skipped: 0,
  complete: 1,
  partial: 2,
  failed: 3,
};

/**
 * One report per agent from several discovery answers, as if one request had
 * run every read. The worst attempted status wins: failed, then partial,
 * then complete. Skipped is neutral, so a read that was not asked for never
 * hides one that ran. On a tie the earlier answer's report wins, so pass the
 * Claude Code history answer first to keep its detail, as one request does.
 */
export function mergeRecentProjectSourceReports(
  answers: readonly Pick<DiscoverRecentProjectsResponse, "sources">[],
): RecentProjectSourceReport[] {
  const byAgent = new Map<string, RecentProjectSourceReport>();
  for (const answer of answers) {
    for (const report of answer.sources) {
      const existing = byAgent.get(report.agent);
      if (!existing || STATUS_WEIGHT[report.status] > STATUS_WEIGHT[existing.status]) {
        byAgent.set(report.agent, report);
      }
    }
  }
  return [...byAgent.values()];
}

/** Several discovery answers as one: merged reports and every observation. */
export function mergeRecentProjectDiscoveries(
  answers: readonly DiscoverRecentProjectsResponse[],
): DiscoverRecentProjectsResponse {
  return {
    sources: mergeRecentProjectSourceReports(answers),
    observations: answers.flatMap((answer) => answer.observations),
  };
}
