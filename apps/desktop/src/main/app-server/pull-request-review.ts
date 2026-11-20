import type {
  AppServerReviewPullRequestSnapshot,
  AppServerReviewTarget,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { parseGitHubRemote } from "../pr-status/git-remote";
import {
  EXPLICIT_REVIEW_PULL_REQUEST_URL,
  PULL_REQUEST_SET_CHANGED_PATHS_MAX,
  pullRequestSetProblem,
} from "../../shared/pull-request-review";
import { runGitCommand } from "./git-executable";
import type { ReviewGitRunner } from "./review-workspace-guard";

type PullRequestTarget = Extract<AppServerReviewTarget, { type: "pullRequest" }>;
type PullRequestSetTarget = Extract<AppServerReviewTarget, { type: "pullRequests" }>;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Incoming snapshots are ignored. Only internal scheduler release may reuse one. */
export async function resolvePullRequestReview(params: {
  target: PullRequestTarget;
  cwd: string;
  prs: PrSummary[];
  executionTarget?: "local" | "remote";
  trustedSnapshot?: boolean;
  runGit?: ReviewGitRunner;
  fetchPullRequest?: (url: string) => Promise<PrSummary | undefined>;
}): Promise<PullRequestTarget> {
  if (params.executionTarget === "remote") {
    throw new Error("Pull request reviews in remote execution workspaces are not supported. Resolve and run this review on the workspace's owning execution host.");
  }
  const url = params.target.url.replace(/\/$/, "");
  const attached = params.prs.filter((pr) => pr.url.replace(/\/$/, "") === url);
  if (attached.length !== 1) {
    throw new Error("Review not started: select one unambiguous attached pull request.");
  }
  const identity = EXPLICIT_REVIEW_PULL_REQUEST_URL.exec(url);
  if (!identity) {
    throw new Error("Explicit pull request review currently requires a GitHub.com attachment with authoritative base and head commits.");
  }
  const [, provider, org, repo, number] = identity;
  const runGit = params.runGit ?? runGitCommand;
  // Re-read remotes rather than trusting navigation's cached repository label.
  const remotes = (await runGit(params.cwd, ["remote"])).stdout.trim().split(/\s+/).filter(Boolean);
  const matchingRemotes: string[] = [];
  for (const remote of remotes) {
    const urls = (await runGit(params.cwd, ["remote", "get-url", "--all", remote])).stdout.trim().split("\n");
    if (urls.slice(0, 1).some((value) => {
      const parsed = parseGitHubRemote(value);
      return parsed?.host === provider
        && parsed.owner.toLowerCase() === org.toLowerCase()
        && parsed.repo.toLowerCase() === repo.toLowerCase();
    })) matchingRemotes.push(remote);
  }
  if (!matchingRemotes.length) {
    throw new Error("Review not started: the attached pull request does not belong to the selected repository.");
  }
  const persisted = params.trustedSnapshot ? params.target.snapshot : undefined;
  if (params.trustedSnapshot && !persisted) {
    throw new Error("Queued pull request review is missing its captured commits; submit it again.");
  }
  if (persisted && (persisted.pullRequest.url !== url
    || persisted.pullRequest.provider !== provider
    || persisted.pullRequest.org !== org || persisted.pullRequest.repo !== repo
    || persisted.pullRequest.number !== Number(number))) {
    throw new Error("Queued pull request identity does not match its captured snapshot.");
  }
  const fresh = persisted ? undefined : await (params.fetchPullRequest
    ?? ((prUrl) => new GithubPrFetcher().fetchPullRequestByUrl({ cwd: params.cwd, url: prUrl })))(url);
  if (!persisted && (!fresh || fresh.url !== url || !fresh.baseRefName || !fresh.headRefName)) {
    throw new Error("Review not started: fresh pull request metadata is unavailable.");
  }
  const baseCommit = persisted?.baseCommit ?? fresh?.baseSha ?? "";
  const headCommit = persisted?.headCommit ?? fresh?.headSha ?? "";
  if (![baseCommit, headCommit].every((sha) => commitPattern.test(sha))) {
    throw new Error("Review not started: the provider did not supply exact base and head commits.");
  }
  for (const sha of new Set([baseCommit, headCommit])) {
    const verify = async (): Promise<boolean> => {
      try {
        return (await runGit(params.cwd, ["rev-parse", "--verify", `${sha}^{commit}`])).stdout.trim() === sha;
      } catch { return false; }
    };
    if (!await verify()) {
      // Fetch the SHA from the selected repository, never a moving branch or
      // a destination ref. Neither FETCH_HEAD nor the active worktree changes.
      await runGit(params.cwd, ["fetch", "--no-tags", "--no-write-fetch-head", "--", matchingRemotes[0], sha]);
      if (!await verify()) throw new Error(`Review commit ${sha} is unavailable after fetch.`);
    }
    // Protect a queued snapshot from pruning after a force push.
    await runGit(params.cwd, ["update-ref", `refs/pwragent/review-objects/${sha}`, sha]);
  }
  const mergeBaseCommit = (await runGit(params.cwd, ["merge-base", "--all", baseCommit, headCommit])).stdout.trim();
  if (!commitPattern.test(mergeBaseCommit)
    || (persisted && persisted.mergeBaseCommit !== mergeBaseCommit)) {
    throw new Error("Review not started: the pull request has an unavailable or ambiguous merge base.");
  }
  return {
    type: "pullRequest",
    url,
    snapshot: persisted ?? {
      pullRequest: {
        provider, org, repo, number: Number(number), url,
        title: fresh!.title,
        baseRefName: fresh!.baseRefName,
        headRefName: fresh!.headRefName,
      },
      baseCommit, headCommit, mergeBaseCommit,
      capturedAt: Date.now(),
    },
  };
}

/**
 * The repository paths a snapshot's merge-base-to-head diff changes, or
 * undefined when Git cannot say or there are more than the cap. Renames count
 * as a deletion and an addition, so a finding on either path matches.
 */
async function readChangedPaths(
  runGit: ReviewGitRunner,
  cwd: string,
  snapshot: AppServerReviewPullRequestSnapshot,
): Promise<string[] | undefined> {
  try {
    const output = (await runGit(cwd, [
      "diff", "--name-only", "--no-renames", "-z",
      snapshot.mergeBaseCommit, snapshot.headCommit, "--",
    ])).stdout;
    const paths = output.split("\0").filter(Boolean);
    return paths.length <= PULL_REQUEST_SET_CHANGED_PATHS_MAX ? paths : undefined;
  } catch {
    // Attribution is a label on the findings; the review does not depend on it.
    return undefined;
  }
}

/**
 * Resolve every pull request of a combined review the way a single one is
 * resolved, in the order given. Any one failing fails the whole review: a
 * combined review that silently dropped a pull request would read as covering
 * it. Only internal scheduler release reuses the captured snapshots, changed
 * paths included; an incoming snapshot is replaced.
 */
export async function resolvePullRequestSetReview(params: {
  target: PullRequestSetTarget;
  cwd: string;
  prs: PrSummary[];
  executionTarget?: "local" | "remote";
  trustedSnapshot?: boolean;
  runGit?: ReviewGitRunner;
  fetchPullRequest?: (url: string) => Promise<PrSummary | undefined>;
}): Promise<PullRequestSetTarget> {
  const problem = pullRequestSetProblem(params.target.pullRequests.map((member) => member.url));
  if (problem) throw new Error(`Review not started: ${problem}`);
  const runGit = params.runGit ?? runGitCommand;
  const pullRequests: PullRequestSetTarget["pullRequests"] = [];
  for (const member of params.target.pullRequests) {
    const resolved = await resolvePullRequestReview({
      ...params,
      runGit,
      target: {
        type: "pullRequest",
        url: member.url,
        ...(member.snapshot ? { snapshot: member.snapshot } : {}),
      },
    });
    const snapshot = resolved.snapshot!;
    const changedPaths = params.trustedSnapshot
      ? snapshot.changedPaths
      : await readChangedPaths(runGit, params.cwd, snapshot);
    const { changedPaths: _incoming, ...captured } = snapshot;
    pullRequests.push({
      url: resolved.url,
      snapshot: { ...captured, ...(changedPaths ? { changedPaths } : {}) },
    });
  }
  return { type: "pullRequests", pullRequests };
}
