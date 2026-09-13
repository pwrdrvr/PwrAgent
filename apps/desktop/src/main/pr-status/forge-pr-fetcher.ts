import type { PrSummary, PullRequestProviderAvailability } from "@pwragent/shared";
import { GithubPrFetcher, type GithubPrFetcherOptions } from "./github-pr-fetcher";
import { parsePrRefFromUrl, type PrRef } from "./github-graphql-client";
import { GitLabPrFetcher, parseGitLabMrUrl } from "./gitlab-pr-fetcher";
import { resolveGitHubReposForDirectory } from "./git-remote";

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
  private readonly providerEnabled: (provider: "github" | "gitlab") => boolean;

  /** The operator's per-forge switch. Public because the poll path reaches
   *  the transports directly and must apply the same gate. */
  isProviderEnabled(provider: "github" | "gitlab"): boolean {
    return this.providerEnabled(provider);
  }

  private readonly options: GithubPrFetcherOptions;

  constructor(
    options: GithubPrFetcherOptions & {
      isProviderEnabled?: (provider: "github" | "gitlab") => boolean;
    } = {},
    gitlab = new GitLabPrFetcher(),
  ) {
    super(options);
    this.options = options;
    this.gitlab = gitlab;
    this.providerEnabled = options.isProviderEnabled ?? (() => true);
  }

  async getProviderAvailability(directories: string[], urls: string[] = []): Promise<PullRequestProviderAvailability[]> {
    // A disabled forge reports nothing rather than reporting unavailable:
    // "you turned this off" is not a failure the operator needs told about
    // on every refresh. Decided first so a disabled forge costs no remote
    // resolution at all.
    const wantGithub = this.isProviderEnabled("github");
    const wantGitLab = this.isProviderEnabled("gitlab");
    let github = wantGithub && urls.some((url) => Boolean(parsePrRefFromUrl(url)));
    const gitlabHosts = new Set(wantGitLab ? urls.flatMap((url) => {
      const ref = parseGitLabMrUrl(url);
      return ref ? [ref.host] : [];
    }) : []);
    // Both resolvers read the same TTL-cached remote list, so the two passes
    // over one directory cost one `git remote` at most.
    const resolveGitHub = this.options.resolveGitHubRepos ?? resolveGitHubReposForDirectory;
    const resolveGitLab = this.gitlab.resolveRepos;
    await Promise.all(directories.map(async (cwd) => {
      if (wantGithub && !github && (await resolveGitHub(cwd)).length > 0) github = true;
      if (wantGitLab) {
        for (const repo of await resolveGitLab(cwd)) gitlabHosts.add(repo.host);
      }
    }));
    const statuses: PullRequestProviderAvailability[] = [];
    if (github) {
      statuses.push({ provider: "github.com", cli: "gh", available: await this.isGhAvailable() });
    }
    if (gitlabHosts.size > 0) {
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

  override async fetchPullRequestByUrl(params: {
    cwd: string; url: string; onProviderFailure?: () => void;
  }): Promise<PrSummary | undefined> {
    const ref = parseGitLabMrUrl(params.url);
    if (ref) {
      // A disabled forge is not a failure, so it reports none.
      if (!this.isProviderEnabled("gitlab")) return undefined;
      try {
        return await this.gitlab.fetchByRef(ref);
      } catch {
        params.onProviderFailure?.();
        return undefined;
      }
    }
    return this.isProviderEnabled("github")
      ? await super.fetchPullRequestByUrl(params)
      : undefined;
  }
}
