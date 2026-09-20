import type { AppServerReviewTarget, PrSummary } from "@pwragent/shared";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { parseGitHubRemote } from "../pr-status/git-remote";
import { runGitCommand } from "./git-executable";
import type { ReviewGitRunner } from "./review-workspace-guard";

type PullRequestTarget = Extract<AppServerReviewTarget, { type: "pullRequest" }>;
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
  const identity = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  if (!identity || identity[1] !== "github.com") {
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
