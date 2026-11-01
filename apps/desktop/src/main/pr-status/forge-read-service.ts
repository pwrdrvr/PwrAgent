import { forgeKindForRemoteHost, type PrSummary } from "@pwragent/shared";
import { ForgeReadError, repositoryKey, type ForgeReadArgs, type ForgeReadOperation, type ForgeRepository } from "./forge-tool-contract";
import { parseForgePrRefFromUrl } from "./forge-pr-ref";
import type { GitHubRepoRef } from "./git-remote";
import type { ForgeCiClient } from "./forge-ci-client";

export type ForgeObservation = { pr: PrSummary; fetchedAt: number };
export type ForgeReadScope = { remotes: GitHubRepoRef[]; attached: PrSummary[]; observations: ForgeObservation[]; branch?: string };
export function repositoryFromPr(url: string): ForgeRepository | undefined {
  const ref = parseForgePrRefFromUrl(url);
  if (ref) return { provider: ref.kind, host: ref.host, owner: ref.owner, repo: ref.repo };
  // Enterprise GitHub supplies explicit product evidence via the /pull/ URL.
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/[1-9]\d*\/?$/);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && match) return { provider: "github", host: parsed.host.toLowerCase(), owner: match[1]!, repo: match[2]! };
  } catch { /* No supported identity. */ }
  return undefined;
}
export function sameRepository(a: Omit<ForgeRepository, "provider"> & { provider?: ForgeRepository["provider"] }, b: Omit<ForgeRepository, "provider"> & { provider?: ForgeRepository["provider"] }): boolean {
  const fold = a.provider === "github" || b.provider === "github";
  return a.host.toLowerCase() === b.host.toLowerCase()
    && (fold ? a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() : a.owner === b.owner && a.repo === b.repo);
}
/**
 * The repositories a forge tool may touch for one thread: its linked remotes
 * and the base repositories of its attached PRs/MRs. An explicit repository
 * or URL narrows that set and must belong to it.
 */
export function resolveForgeRepositories(args: Pick<ForgeReadArgs, "repository" | "url">, scope: Pick<ForgeReadScope, "remotes" | "attached">): ForgeRepository[] {
  const candidates = new Map<string, ForgeRepository>();
  for (const remote of scope.remotes) {
    const provider = forgeKindForRemoteHost(remote.host);
    if (provider) candidates.set(repositoryKey({ ...remote, provider }), { ...remote, provider });
  }
  for (const pr of scope.attached) {
    const repository = repositoryFromPr(pr.url);
    if (repository) candidates.set(repositoryKey(repository), repository);
  }
  const explicit = args.repository ?? (args.url ? repositoryFromPr(args.url) : undefined);
  if (args.url && !repositoryFromPr(args.url)) throw new ForgeReadError("invalid_arguments", "Use a supported HTTPS PR/MR URL.");
  if (explicit) {
    const key = repositoryKey(explicit);
    const inferred = forgeKindForRemoteHost(explicit.host);
    if (inferred && inferred !== explicit.provider) throw new ForgeReadError("invalid_arguments", "Provider does not match the known forge host.");
    if (!candidates.has(key) && !scope.remotes.some((r) => sameRepository(r, explicit))) throw new ForgeReadError("forbidden", "Repository is outside the target thread's linked remotes and attached PR/MR repositories.");
    if (args.url && (explicit.provider !== repositoryFromPr(args.url)!.provider || !sameRepository(explicit, repositoryFromPr(args.url)!))) throw new ForgeReadError("invalid_arguments", "PR/MR URL does not match repository.");
    candidates.clear(); candidates.set(key, { ...explicit, host: explicit.host.toLowerCase() });
  }
  const repositories = [...candidates.values()];
  if (!repositories.length) throw new ForgeReadError("not_found", "No supported forge repository is linked to this thread. For a custom host, select an explicit repository with its product and actual host.");
  return repositories;
}

export class ForgeReadService {
  constructor(private readonly options: {
    enabled: (provider: ForgeRepository["provider"]) => boolean;
    ci: Pick<ForgeCiClient, "execute">;
    refresh: (args: ForgeReadArgs, repositories: ForgeRepository[]) => Promise<PrSummary[]>;
  }) {}

  async execute(operation: ForgeReadOperation, args: ForgeReadArgs, scope: ForgeReadScope, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const repositories = resolveForgeRepositories(args, scope);
    if (operation !== "get_forge_status") {
      if (repositories.length !== 1) throw new ForgeReadError("ambiguous_repository", `Select repository from: ${repositories.map(repositoryKey).join(", ")}.`);
      const repository = repositories[0]!;
      if (!this.options.enabled(repository.provider)) throw new ForgeReadError("provider_disabled", `${repository.provider} is disabled in Settings → Git.`);
      return this.options.ci.execute(operation, repository, args, signal);
    }
    const selected = new Set(repositories.map(repositoryKey));
    const matches = (pr: PrSummary) => {
      const repository = repositoryFromPr(pr.url);
      return repository && selected.has(repositoryKey(repository)) && (!args.url || pr.url.replace(/\/$/, "") === args.url.replace(/\/$/, "")) && (!args.branch || pr.headRefName === args.branch);
    };
    const cached = scope.observations.filter(({ pr }) => matches(pr));
    for (const pr of scope.attached.filter(matches)) if (!cached.some((o) => o.pr.url === pr.url)) cached.push({ pr, fetchedAt: 0 });
    const now = Date.now();
    let observations = cached;
    let source = "cache";
    if (args.refresh) {
      for (const r of repositories) {
        if (!this.options.enabled(r.provider)) throw new ForgeReadError("provider_disabled", `${r.provider} is disabled in Settings → Git; cached reads remain available.`);
        if (r.provider === "github" && r.host !== "github.com") throw new ForgeReadError("unsupported_provider", "GitHub Enterprise PR status is unsupported by the existing provider. Enterprise CI reads are supported.");
      }
      const refreshed = await this.options.refresh(args, repositories);
      signal?.throwIfAborted();
      observations = refreshed.filter(matches).map((pr) => ({ pr, fetchedAt: Date.now() }));
      source = "provider";
    }
    return {
      repositories: repositories.map((r) => ({ ...r, enabled: this.options.enabled(r.provider) })), source, providerAvailability: args.refresh ? "queried" : "not_checked", lastRefreshError: "not_recorded_in_cache", requestedAt: now, refreshRequested: args.refresh === true,
      refreshCost: args.refresh ? "Charges the shared PR request budget; discovery, verification and provider retries may require multiple requests." : "No provider requests.",
      observations: observations.slice(0, 100).map(({ pr, fetchedAt }) => ({ pr, source, fetchedAt: fetchedAt || null, ageMs: fetchedAt ? Math.max(0, Date.now() - fetchedAt) : null, freshness: !fetchedAt ? "unknown" : Date.now() - fetchedAt > 60_000 ? "stale" : "recent", checks: "Aggregated provider status only; use get_ci_run for individual CI jobs.", error: null })),
      truncated: observations.length > 100,
      error: observations.length ? null : { code: args.refresh ? "no_matching_pull_requests" : "cache_miss", message: args.refresh ? "Provider lookup returned no matching PR/MR." : "No cached observation. This does not mean CI passes or that no PR/MR exists. Use refresh=true for an explicit provider lookup." },
      freshnessPolicy: "recent means fetched within 60 seconds, not a guarantee of current provider state. Reads do not create repair turns or duplicate monitoring.",
    };
  }
}
