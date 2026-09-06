import type { NavigationThreadSummary } from "@pwragent/shared";

/** Search rows are navigation-compatible placeholders, not hydrated thread state.
 * Use an allowlist so new overlay fields never silently become search payloads.
 * Selecting a row pins its owner/id and refreshes navigation before opening it.
 */
export function compactNavigationSearchResult(
  thread: NavigationThreadSummary,
  query: string,
): NavigationThreadSummary {
  const needle = query.trim().toLowerCase();
  const excerpt = (value: string | undefined, length = 512): string | undefined => {
    if (value === undefined || value.length <= length) return value;
    const at = value.toLowerCase().indexOf(needle);
    const start = Math.max(0, at - 80);
    return value.slice(start, start + length);
  };
  // Older viewers re-run matching. Retain small genuine instruction excerpts
  // around each matching token instead of shipping the complete persona text.
  const instructions = thread.agent?.instructions;
  const lowerInstructions = instructions?.toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  const instructionExcerpts = instructions
    ? tokens.map((token) => {
        const at = lowerInstructions!.indexOf(token);
        return at < 0 ? "" : instructions.slice(Math.max(0, at - 24), at + token.length + 24);
      }).filter(Boolean).join(" … ").slice(0, 2048)
    : undefined;
  const prNumber = Number(needle.replace(/^#/, ""));
  return {
    id: thread.id,
    source: thread.source,
    title: excerpt(thread.title)!,
    titleSource: thread.titleSource,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    projectKey: thread.projectKey,
    gitBranch: excerpt(thread.gitBranch),
    linkedDirectories: [...thread.linkedDirectories]
      .sort((a, b) => Number(b.label.toLowerCase().includes(needle)) - Number(a.label.toLowerCase().includes(needle)))
      .slice(0, 3)
      .map(({ id, label, path, worktreePath, kind, gitBranch }) => ({
        id, label: excerpt(label)!, path, worktreePath, kind, gitBranch: excerpt(gitBranch),
      })),
    inbox: { inInbox: thread.inbox.inInbox },
    federation: thread.federation,
    agent: thread.agent ? {
      name: excerpt(thread.agent.name)!,
      instructions: instructionExcerpts,
      instructionLineCount: thread.agent.instructionLineCount,
      instructionsTooLong: thread.agent.instructionsTooLong,
      updatedAt: thread.agent.updatedAt,
    } : undefined,
    prs: [...(thread.prs ?? [])]
      .sort((a, b) =>
        Number(b.number === prNumber) - Number(a.number === prNumber)
        || Number(String(b.number).includes(needle.replace(/^#/, "")))
          - Number(String(a.number).includes(needle.replace(/^#/, ""))),
      )
      .slice(0, 8)
      .map((pr) => ({
        provider: pr.provider, org: pr.org, repo: pr.repo, number: pr.number,
        url: pr.url, title: excerpt(pr.title), state: pr.state,
        checkState: pr.checkState, lifecycleState: pr.lifecycleState,
        reviewState: pr.reviewState, mergeState: pr.mergeState,
      })),
  };
}
