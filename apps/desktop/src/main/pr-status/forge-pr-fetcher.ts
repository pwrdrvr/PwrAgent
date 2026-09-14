import { FORGE_KINDS, FORGE_PRODUCTS, type ForgeKind, type PrSummary, type PullRequestProviderAvailability } from "@pwragent/shared";
import { GithubPrFetcher, type GithubPrFetcherOptions } from "./github-pr-fetcher";
import { GithubGraphqlPrClient } from "./github-graphql-client";
import { GitLabPrFetcher } from "./gitlab-pr-fetcher";
import { resolveGitHubReposForDirectory, type GitHubRepoRef } from "./git-remote";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { parseForgePrRefFromUrl, type ForgePrRef } from "./forge-pr-ref";

export { parseForgePrRefFromUrl, type ForgePrRef } from "./forge-pr-ref";

type BranchLookup = { cwd: string; branch: string; allowPrimed?: boolean; onProviderFailure?: () => void };
type UrlLookup = { cwd: string; url: string; onProviderFailure?: () => void };
type PollOptions = { reconnect?: boolean; requestTokenTaken?: boolean };

/** The only transport seam the router needs. Provider-specific auth and
 * GraphQL branch priming stay on their concrete adapters. */
export type ForgePrProvider = {
  resolveRepos: (cwd: string) => Promise<GitHubRepoRef[]>;
  isAvailable: () => Promise<boolean>;
  availabilityError: (host: string, available: boolean) => string | undefined;
  fetchForBranch: (params: BranchLookup) => Promise<PrSummary[]>;
  fetchByUrl: (params: UrlLookup, ref: ForgePrRef) => Promise<PrSummary | undefined>;
  fetchRefs: (refs: ForgePrRef[], options: PollOptions) => Promise<PrSummary[]>;
};

type ForgePrFetcherOptions = GithubPrFetcherOptions & {
  graphqlClient?: GithubPrFetcherOptions["graphqlClient"] & Partial<Pick<GithubGraphqlPrClient, "fetchPullRequestsAfterReconnect">>;
  isProviderEnabled?: (provider: ForgeKind) => boolean;
  providers?: Record<ForgeKind, ForgePrProvider>;
};

/** All entry points apply the same provider gate before remote or CLI access. */
export class ForgePrFetcher {
  readonly github: GithubPrFetcher;
  readonly gitlab: GitLabPrFetcher;
  private readonly providers: Record<ForgeKind, ForgePrProvider>;
  private readonly providerEnabled: (provider: ForgeKind) => boolean;

  constructor(options: ForgePrFetcherOptions = {}, gitlab = new GitLabPrFetcher()) {
    const graphql = options.graphqlClient ?? new GithubGraphqlPrClient({
      getConfiguredGhCommand: () => getDesktopSettingsService().resolveGhCommandPreference(),
    });
    this.github = new GithubPrFetcher({ ...options, graphqlClient: graphql });
    this.gitlab = gitlab;
    this.providerEnabled = options.isProviderEnabled ?? (() => true);
    this.providers = options.providers ?? {
      github: {
        resolveRepos: options.resolveGitHubRepos ?? resolveGitHubReposForDirectory,
        isAvailable: () => this.github.isGhAvailable(),
        availabilityError: () => undefined,
        fetchForBranch: (params) => this.github.fetchAllPullRequestsForBranch(params),
        fetchByUrl: (params) => this.github.fetchPullRequestByUrl(params),
        fetchRefs: (refs, poll) => poll.reconnect && graphql.fetchPullRequestsAfterReconnect
          ? graphql.fetchPullRequestsAfterReconnect(refs)
          : graphql.fetchPullRequests(refs),
      },
      gitlab: {
        resolveRepos: (cwd) => gitlab.resolveRepos(cwd),
        isAvailable: () => gitlab.isAvailable(),
        availabilityError: (host, available) => available
          ? gitlab.getLastError(host)
          : "Install glab or select its path in Settings → Git.",
        fetchForBranch: (params) => gitlab.fetchForBranch(params.cwd, params.branch),
        fetchByUrl: (_params, ref) => gitlab.fetchByRef(ref),
        fetchRefs: async (refs, poll) => {
          const results: PrSummary[] = [];
          // Each MR is one REST request. A failed observation must not discard
          // successful siblings or overwrite the previous persisted status.
          for (const ref of refs) {
            try {
              results.push(await gitlab.fetchByRef(ref, poll.requestTokenTaken));
            } catch {
              // Preserve the previous observation and timestamp.
            }
          }
          return results;
        },
      },
    } satisfies Record<ForgeKind, ForgePrProvider>;
  }

  isProviderEnabled(provider: ForgeKind): boolean {
    return this.providerEnabled(provider);
  }

  async getProviderAvailability(directories: string[], urls: string[] = []): Promise<PullRequestProviderAvailability[]> {
    const statuses: PullRequestProviderAvailability[] = [];
    for (const kind of FORGE_KINDS) {
      if (!this.isProviderEnabled(kind)) continue;
      const provider = this.providers[kind];
      const hosts = new Set(urls.flatMap((url) => {
        const ref = parseForgePrRefFromUrl(url);
        return ref?.kind === kind ? [ref.host] : [];
      }));
      // All resolvers share the TTL-cached git remote list.
      for (const repos of await Promise.all(directories.map((cwd) => provider.resolveRepos(cwd)))) {
        for (const repo of repos) hosts.add(repo.host);
      }
      if (!hosts.size) continue;
      const available = await provider.isAvailable();
      for (const host of hosts) {
        const error = provider.availabilityError(host, available);
        statuses.push({ provider: host, cli: FORGE_PRODUCTS[kind].cli, available, ...(error ? { error } : {}) });
      }
    }
    return statuses;
  }

  async fetchAllPullRequestsForBranch(params: BranchLookup): Promise<PrSummary[]> {
    const results: PrSummary[] = [];
    for (const kind of FORGE_KINDS) {
      if (!this.isProviderEnabled(kind)) continue;
      try {
        results.push(...await this.providers[kind].fetchForBranch(params));
      } catch {
        params.onProviderFailure?.();
      }
    }
    return results;
  }

  async fetchPullRequestByUrl(params: UrlLookup): Promise<PrSummary | undefined> {
    const ref = parseForgePrRefFromUrl(params.url);
    if (!ref || !this.isProviderEnabled(ref.kind)) return undefined;
    try {
      return await this.providers[ref.kind].fetchByUrl(params, ref);
    } catch {
      params.onProviderFailure?.();
      return undefined;
    }
  }

  async fetchPullRequests(refs: ForgePrRef[], options: PollOptions = {}): Promise<PrSummary[]> {
    const results: PrSummary[] = [];
    for (const kind of FORGE_KINDS) {
      if (!this.isProviderEnabled(kind)) continue;
      const matching = refs.filter((ref) => ref.kind === kind);
      if (!matching.length) continue;
      // The caller owns the aggregate, never a transport's retained array.
      results.push(...await this.providers[kind].fetchRefs(matching, options));
    }
    return results;
  }
}
