import {
  rankThreadJumpMatches,
  type NavigationDirectorySummary,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
} from "@pwragent/shared";

/** Test-owned owner projection for renderer fixtures, with explicit row fields. */
export function navigationQueryFixture(
  request: NavigationQueryRequest,
  population: {
    directories?: readonly NavigationDirectorySummary[];
    threads?: readonly NavigationThreadSummary[];
  },
): NavigationQueryPage {
  const query = request.query;
  const threads = query.kind === "search"
    ? rankThreadJumpMatches(population.threads ?? [], query.text)
    : [...(population.threads ?? [])];
  const count = request.pageSize ?? 100;
  return {
    protocol: 2,
    queryKey: JSON.stringify(query),
    generation: "fixture",
    ownerEpoch: "fixture",
    countsRevision: "fixture",
    coverage: { state: "complete" },
    counts: { total: threads.length, active: 0, unread: 0, review: 0 },
    complete: threads.length <= count,
    directories: query.kind === "directory-index"
      ? (population.directories ?? [])
          .filter((directory) => !query.filter
            || `${directory.label}\n${directory.path ?? ""}`.toLowerCase().includes(query.filter.toLowerCase()))
          .slice(0, count).map((directory) => ({
            key: directory.key,
            kind: directory.kind,
            label: directory.label,
            path: directory.path,
            latestUpdatedAt: directory.latestUpdatedAt,
            counts: { total: 0, active: 0, unread: 0, review: 0 },
            pinnedRootCount: 0,
            unpinnedRootCount: 0,
            launchpadPresent: false,
          }))
      : [],
    entries: query.kind === "directory-index" ? [] : threads.slice(0, count).map((thread) => ({
      row: {
        ref: { backend: thread.source, threadId: thread.id },
        rowRevision: "fixture",
        id: thread.id,
        source: thread.source,
        title: thread.title,
        titleSource: thread.titleSource,
        linkedDirectories: thread.linkedDirectories,
        inbox: thread.inbox,
        prs: thread.prs,
        gitBranch: thread.gitBranch,
        federation: thread.federation,
        ordinaryChildCount: 0,
        nativeSubAgentGroupPresent: false,
        queueCount: 0,
        queueState: "unknown",
      },
      orderKey: thread.id,
      placement: { kind: "root" },
    })),
  };
}
