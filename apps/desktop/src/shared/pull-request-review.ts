import type { AppServerReviewTarget, PrSummary } from "@pwragent/shared";

/** Navigation filtering is advisory; the owner verifies fresh Git remotes. */
export function attachedPullRequestsForWorkspace(params: {
  prs: PrSummary[];
  cwd?: string;
  repository?: string;
}): PrSummary[] {
  if (!params.cwd) return [];
  const normalizePath = (value: string): string => {
    const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
  };
  const repository = (pr: PrSummary): string => {
    const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
    return match ? `${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : "";
  };
  const scoped = params.prs.filter((pr) => pr.linkedDirectoryPaths?.some(
    (path) => normalizePath(path) === normalizePath(params.cwd!),
  ));
  const repositories = new Set(params.repository
    ? [params.repository.toLowerCase()]
    : scoped.map(repository).filter(Boolean));
  return params.prs.filter((pr) => repositories.has(repository(pr)));
}

/** Translate only at the engine boundary; retain the original target in state. */
export function nativeReviewTarget(
  target: AppServerReviewTarget,
): Exclude<AppServerReviewTarget, { type: "pullRequest" }> {
  if (target.type !== "pullRequest") return target;
  const snapshot = target.snapshot;
  if (!snapshot || ![snapshot.baseCommit, snapshot.headCommit, snapshot.mergeBaseCommit]
    .every((sha) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))) {
    throw new Error("Pull request review requires an owner-resolved commit snapshot.");
  }
  return {
    type: "custom",
    instructions: [
      `Review the complete pull request diff at the following immutable commits.`,
      `Pull request: ${snapshot.pullRequest.url}; base branch: ${snapshot.pullRequest.baseRefName}; head branch: ${snapshot.pullRequest.headRefName}; captured at: ${snapshot.capturedAt}.`,
      `Base tip: ${snapshot.baseCommit}; head: ${snapshot.headCommit}; merge base: ${snapshot.mergeBaseCommit}.`,
      `Inspect git diff --no-ext-diff ${snapshot.mergeBaseCommit} ${snapshot.headCommit} --`,
      `Read every target file and surrounding context using git show '${snapshot.headCommit}:path/to/file' (substitute the actual path).`,
      "The active checkout may contain another stacked PR and uncommitted work. Do not read working-tree files as the reviewed version, compare against HEAD, or include later commits or local changes.",
      "Do not checkout, switch, reset, stash, or modify the workspace. If an object is unavailable, report that the review cannot proceed; do not substitute another revision.",
      "Report findings against the pinned head's file paths and line numbers.",
    ].join("\n"),
  };
}
