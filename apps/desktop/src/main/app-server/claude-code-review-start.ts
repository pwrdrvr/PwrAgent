import type { PrSummary, StartReviewRequest } from "@pwragent/shared";
import {
  normalizePullRequestUrl,
  pullRequestRepositoryKey,
  pullRequestSetProblem,
} from "../../shared/pull-request-review";
import {
  claudeCodeReviewCommand,
  claudeCodeReviewTakesTarget,
} from "../../shared/review-command";
import { resolveGitHubReposForDirectory, type GitHubRepoRef } from "../pr-status/git-remote";
import { normalizeWorkspacePath } from "./review-workspace-guard";

/**
 * The checkout's own repository, when it has exactly one GitHub remote. A
 * bare pull request number means that repository's; with a fork beside its
 * upstream, Claude Code could read it as either, so every PR is named in full.
 */
async function soleCheckoutRepository(
  cwd: string,
  resolveRepositories: (cwd: string) => Promise<GitHubRepoRef[]>,
): Promise<string | undefined> {
  try {
    const repositories = new Set((await resolveRepositories(cwd))
      .map((repo) => `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase()));
    return repositories.size === 1 ? [...repositories][0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check the thread, workspace, and target at admission and again at start.
 * Claude Code reads each pull request when its turn starts.
 */
export function validateClaudeCodeReview(params: {
  request: StartReviewRequest;
  threadCwd: string | undefined;
  prs: readonly PrSummary[];
}): string[] {
  const { request } = params;
  if (request.backend !== "claude" || (request.reviewBackend && request.reviewBackend !== "claude")) {
    throw new Error("Claude Code's /code-review runs only in a Claude thread, as its own reviewer.");
  }
  if (request.delivery === "detached") {
    throw new Error("Explicit review modes do not support detached delivery.");
  }
  if (!claudeCodeReviewTakesTarget(request.target)) {
    throw new Error("Claude Code's /code-review has no form for this review target.");
  }
  const threadCwd = params.threadCwd?.trim();
  const requestedCwd = request.cwd?.trim();
  if (requestedCwd && threadCwd
    && normalizeWorkspacePath(requestedCwd) !== normalizeWorkspacePath(threadCwd)) {
    throw new Error("Claude Code reviews this thread's own workspace. Choose PwrAgent Sub Agent to review another project.");
  }
  const urls = request.target.type === "pullRequest"
    ? [request.target.url]
    : request.target.type === "pullRequests"
      ? request.target.pullRequests.map((member) => member.url)
      : [];
  if (request.target.type === "pullRequests") {
    const problem = pullRequestSetProblem(urls);
    if (problem) throw new Error(`Review not started: ${problem}`);
  }
  const attached = new Set(params.prs.map((pr) => normalizePullRequestUrl(pr.url)));
  if (urls.some((url) => !attached.has(normalizePullRequestUrl(url)))) {
    throw new Error("Review not started: select pull requests attached to this thread.");
  }
  return urls;
}

/** Resolve whether the command can refer to attached PRs by number. */
export async function prepareClaudeCodeReview(params: Parameters<typeof validateClaudeCodeReview>[0] & {
  resolveRepositories?: (cwd: string) => Promise<GitHubRepoRef[]>;
}): Promise<string> {
  const { request } = params;
  const urls = validateClaudeCodeReview(params);
  const threadCwd = params.threadCwd?.trim();
  const repository = urls.length > 0 && threadCwd
    ? await soleCheckoutRepository(threadCwd, params.resolveRepositories ?? resolveGitHubReposForDirectory)
    : undefined;
  return claudeCodeReviewCommand({
    target: request.target,
    ...(request.reasoningEffort ? { level: request.reasoningEffort } : {}),
    // Bare numbers only for the checkout's own repository.
    ...(repository && urls.every((url) => pullRequestRepositoryKey({ url }) === repository)
      ? { repository }
      : {}),
  });
}
