import type { PrSummary, PullRequestProviderAvailability } from "@pwragent/shared";
import { GithubPrFetcher, type GithubPrFetcherOptions } from "./github-pr-fetcher";
import { parsePrRefFromUrl, type PrRef } from "./github-graphql-client";
import { GitLabPrFetcher, parseGitLabMrUrl } from "./gitlab-pr-fetcher";
import { resolveGitHubReposForDirectory, resolveGitLabReposForDirectory } from "./git-remote";

export type ForgePrRef = PrRef & { gitlabHost?: string };

export function parseForgePrRefFromUrl(url: string): ForgePrRef | undefined {
  const gitlab = parseGitLabMrUrl(url);
  if (gitlab) return { owner: gitlab.owner, repo: gitlab.repo, number: gitlab.number, gitlabHost: gitlab.host };
  return parsePrRefFromUrl(url);
}

/** Provider routing precedes CLI or API access, including mixed-remote checkouts. */
export class ForgePrFetcher extends GithubPrFetcher {
  readonly gitlab: GitLabPrFetcher;
  /** Operator's per-forge switch; defaults to on so tests and callers
   *  that never wire it keep the pre-gate behavior. */
  private readonly isProviderEnabled: (provider: "github" | "gitlab") => boolean;

  constructor(
    options: GithubPrFetcherOptions & {
      isProviderEnabled?: (provider: "github" | "gitlab") => boolean;
    } = {},
    gitlab = new GitLabPrFetcher(),
  ) {
    super(options);
    this.gitlab = gitlab;
    this.isProviderEnabled = options.isProviderEnabled ?? (() => true);
  }

  async getProviderAvailability(directories: string[], urls: string[] = []): Promise<PullRequestProviderAvailability[]> {
    let github = urls.some((url) => Boolean(parsePrRefFromUrl(url)));
    const gitlabHosts = new Set(urls.flatMap((url) => {
      const ref = parseGitLabMrUrl(url);
      return ref ? [ref.host] : [];
    }));
    for (const cwd of directories) {
      github ||= (await resolveGitHubReposForDirectory(cwd)).length > 0;
      for (const repo of await resolveGitLabReposForDirectory(cwd)) gitlabHosts.add(repo.host);
    }
    const statuses: PullRequestProviderAvailability[] = [];
    // A disabled forge reports nothing rather than reporting unavailable:
    // "you turned this off" is not a failure the operator needs told about
    // on every refresh.
    if (github && this.isProviderEnabled("github")) {
      statuses.push({ provider: "github.com", cli: "gh", available: await this.isGhAvailable() });
    }
    if (gitlabHosts.size > 0 && this.isProviderEnabled("gitlab")) {
      const available = await this.gitlab.isAvailable();
      for (const provider of gitlabHosts) {
        statuses.push({ provider, cli: "glab", available, error: available
          ? this.gitlab.getLastError(provider)
          : "Install glab or select its path in Settings → Git." });
      }
    }
    return statuses;
  }

  override async fetchAllPullRequestsForBranch(params: {
    cwd: string; branch: string; allowPrimed?: boolean; onProviderFailure?: () => void;
  }): Promise<PrSummary[]> {
    const github = this.isProviderEnabled("github")
      ? await super.fetchAllPullRequestsForBranch(params)
      : [];
    if (!this.isProviderEnabled("gitlab")) return github;
    try {
      const gitlab = await this.gitlab.fetchForBranch(params.cwd, params.branch);
      return [...github, ...gitlab];
    } catch {
      params.onProviderFailure?.();
      return github;
    }
  }

  override async fetchPullRequestByUrl(params: { cwd: string; url: string }): Promise<PrSummary | undefined> {
    const ref = parseGitLabMrUrl(params.url);
    if (ref) {
      return this.isProviderEnabled("gitlab") ? await this.gitlab.fetchByRef(ref) : undefined;
    }
    return this.isProviderEnabled("github")
      ? await super.fetchPullRequestByUrl(params)
      : undefined;
  }
}
