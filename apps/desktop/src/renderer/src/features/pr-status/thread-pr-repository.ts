import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";

type RepositoryIdentity = {
  provider: string;
  org: string;
  repo: string;
};

export function primaryRepositoryKey(thread: NavigationThreadSummary): string | undefined {
  const primaryRepository = threadPrimaryRepository(thread);
  return primaryRepository ? repositoryIdentityKey(primaryRepository) : undefined;
}

/**
 * The owner resolves `primaryGitRepository` from the thread's primary
 * workspace. Prefer it to the provider's origin, which still names the
 * project the session started in after a move to another project.
 */
export function threadPrimaryRepository(
  thread: NavigationThreadSummary,
): RepositoryIdentity | undefined {
  const primaryGitRepository = thread.primaryGitRepository?.trim();
  return (primaryGitRepository
    ? parseRepositoryIdentity(`https://${primaryGitRepository}`)
    : undefined)
    ?? parseRepositoryIdentity(thread.gitOriginUrl);
}

/**
 * Whether a PR belongs to the thread's checkout: its repository, or the fork
 * it pushes to. Without a parseable origin, the head-branch match alone
 * decides.
 */
export function isThreadRepositoryPr(
  primaryKey: string | undefined,
  pr: PrSummary,
): boolean {
  if (primaryKey === undefined) {
    return true;
  }
  return repositoryIdentityKey(pr) === primaryKey
    || (pr.sourceRepository !== undefined
      && repositoryIdentityKey(pr.sourceRepository) === primaryKey);
}

function parseRepositoryIdentity(
  remoteUrl?: string,
): RepositoryIdentity | undefined {
  const value = remoteUrl?.trim();
  if (!value) {
    return undefined;
  }

  const scpLike = value.match(/^[^@/]+@([^:]+):(.+)$/);
  let provider: string;
  let path: string;
  if (scpLike) {
    provider = scpLike[1]!;
    path = scpLike[2]!;
  } else {
    try {
      const parsed = new URL(value);
      if (!parsed.hostname) {
        return undefined;
      }
      provider = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }

  const segments = path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }

  const repo = segments.at(-1);
  const org = segments.slice(0, -1).join("/");
  if (!org || !repo) {
    return undefined;
  }

  return { provider, org, repo };
}

export function repositoryIdentityKey(identity: RepositoryIdentity): string {
  return [
    normalizeRepositoryProvider(identity.provider),
    identity.org,
    identity.repo,
  ]
    .map((part) => part.trim().toLowerCase())
    .join("/");
}

function normalizeRepositoryProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  // GitHub documents ssh.github.com:443 as an alternate SSH transport for
  // networks that block port 22. PR URLs still identify that forge as
  // github.com, so compare both hostnames as the same provider.
  return normalized === "ssh.github.com" ? "github.com" : normalized;
}
