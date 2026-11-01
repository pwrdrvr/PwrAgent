import { resolvePullRequestIdentity, type PrSummary } from "@pwragent/shared";
import {
  buildPullRequestReferenceUrl,
  parsePullRequestReferenceUrl,
  type PullRequestRepositoryRef,
} from "./forge-reference";

/** Longest rename chain followed before giving up; guards a cycle. */
const MAX_ALIAS_HOPS = 8;

function repositoryKey(ref: Pick<PullRequestRepositoryRef, "provider" | "org" | "repo">): string {
  return `${ref.provider.trim().toLowerCase()}/${ref.org.toLowerCase()}/${ref.repo.toLowerCase()}`;
}

/**
 * The repository names a forge has told us are the same repository.
 *
 * GitHub keeps answering a renamed or transferred repository's old name and
 * always replies with the current one, so a PR attached by its old URL and the
 * same PR found by a branch lookup carried two status keys and showed as two
 * chips. A by-URL fetch that returns a PR at another path is the forge naming
 * the repository; this records that answer, keyed by the case-folded
 * `provider/org/repo` that was asked for.
 *
 * It holds forge answers, not authoritative state, so it lives in memory. Rows
 * rewritten through it are stored under the canonical name, and a restart
 * relearns any alias the next by-URL fetch of an old row meets.
 */
export class PullRequestRepositoryAliases {
  private readonly canonicalByKey = new Map<string, PullRequestRepositoryRef>();
  /**
   * Repository keys the forge has answered for this session, by a by-URL
   * fetch or a branch lookup. A name it has answered for is no longer a
   * question, so two PRs that share a number across such names stay apart
   * without being asked about again.
   */
  private readonly answeredKeys = new Set<string>();

  /** Whether any recorded answer moves a status key, not only its casing. */
  hasRenames(): boolean {
    for (const [key, ref] of this.canonicalByKey) {
      if (repositoryKey(ref) !== key) return true;
    }
    return false;
  }

  clear(): void {
    this.canonicalByKey.clear();
    this.answeredKeys.clear();
  }

  /**
   * Record repositories the forge named on its own, such as branch lookup
   * results. The forge reports a PR under its repository's current name.
   */
  confirm(prs: readonly Pick<PrSummary, "url">[]): void {
    for (const pr of prs) {
      const parsed = parsePullRequestReferenceUrl(pr.url);
      if (parsed) this.answeredKeys.add(repositoryKey(parsed));
    }
  }

  /**
   * Rows that may be one PR under two repository names, and that no forge
   * answer has placed yet: a row shares its provider and number with a row
   * of another repository, and its own repository is unanswered. Fetching
   * such a row by URL tells whether its repository was renamed.
   */
  renameCandidates<T extends PrSummary>(prs: readonly T[]): T[] {
    const repositoriesByNumber = new Map<string, Set<string>>();
    const rows = prs.map((pr) => {
      const identity = resolvePullRequestIdentity(pr);
      const ownKey = repositoryKey(identity);
      const canonical = this.canonicalRepository(identity);
      const numberKey = `${identity.provider.trim().toLowerCase()}#${identity.number}`;
      const repositories = repositoriesByNumber.get(numberKey) ?? new Set<string>();
      repositories.add(canonical ? repositoryKey(canonical) : ownKey);
      repositoriesByNumber.set(numberKey, repositories);
      return { pr, ownKey, numberKey };
    });
    return rows
      .filter(({ ownKey, numberKey }) =>
        (repositoriesByNumber.get(numberKey)?.size ?? 0) > 1
        && !this.answeredKeys.has(ownKey)
        && !this.canonicalByKey.has(ownKey)
      )
      .map(({ pr }) => pr);
  }

  /**
   * Record what the forge answered for `requestedUrl`. Only an answer for the
   * same provider and number names the same PR. Returns true when the answer
   * maps a repository to a different one; a letter-case difference only
   * adopts the forge's casing.
   */
  learn(
    requestedUrl: string | undefined,
    returned: Pick<PrSummary, "url"> | undefined,
  ): boolean {
    const requested = parsePullRequestReferenceUrl(requestedUrl);
    const canonical = parsePullRequestReferenceUrl(returned?.url);
    // Asked once, a name is not a rename candidate again this session, even
    // when the forge could not answer.
    if (requested) this.answeredKeys.add(repositoryKey(requested));
    if (
      !requested
      || !canonical
      || requested.provider !== canonical.provider
      || requested.number !== canonical.number
    ) {
      return false;
    }
    const requestedKey = repositoryKey(requested);
    const canonicalKey = repositoryKey(canonical);
    this.answeredKeys.add(canonicalKey);
    const ref: PullRequestRepositoryRef = {
      provider: canonical.provider,
      org: canonical.org,
      repo: canonical.repo,
      ...(canonical.kind ? { kind: canonical.kind } : {}),
      ...(canonical.urlBase ? { urlBase: canonical.urlBase } : {}),
    };
    // The answered name is current, so a rename back must not loop to an
    // older alias of it.
    const previousCanonical = this.canonicalByKey.get(canonicalKey);
    if (previousCanonical && repositoryKey(previousCanonical) !== canonicalKey) {
      this.canonicalByKey.delete(canonicalKey);
    }
    const previous = this.canonicalByKey.get(requestedKey);
    if (requestedKey === canonicalKey) {
      // Only a casing the forge corrects is worth remembering.
      if (requested.org !== canonical.org || requested.repo !== canonical.repo) {
        this.canonicalByKey.set(requestedKey, ref);
      } else if (previous) {
        this.canonicalByKey.delete(requestedKey);
      }
      return false;
    }
    this.canonicalByKey.set(requestedKey, ref);
    return !previous || repositoryKey(previous) !== canonicalKey;
  }

  /** The forge's name for a repository, or undefined when none is known. */
  canonicalRepository(
    ref: Pick<PullRequestRepositoryRef, "provider" | "org" | "repo">,
  ): PullRequestRepositoryRef | undefined {
    let key = repositoryKey(ref);
    let canonical: PullRequestRepositoryRef | undefined;
    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
      const next = this.canonicalByKey.get(key);
      if (!next) break;
      canonical = next;
      const nextKey = repositoryKey(next);
      if (nextKey === key) break;
      key = nextKey;
    }
    return canonical;
  }

  /**
   * The row under the forge's repository name. A row with no known alias, or
   * already under that exact name, is returned as is.
   */
  canonicalize<T extends PrSummary>(pr: T): T {
    if (this.canonicalByKey.size === 0) return pr;
    const identity = resolvePullRequestIdentity(pr);
    const canonical = this.canonicalRepository(identity);
    const source = identity.sourceRepository
      ? this.canonicalRepository(identity.sourceRepository)
      : undefined;
    const destinationChanged = Boolean(canonical)
      && (canonical!.org !== identity.org || canonical!.repo !== identity.repo);
    if (!destinationChanged && !source) return pr;
    const destination = destinationChanged ? canonical! : undefined;
    const parsedUrl = parsePullRequestReferenceUrl(pr.url);
    return {
      ...pr,
      ...(destination
        ? {
            provider: destination.provider,
            org: destination.org,
            repo: destination.repo,
            url: buildPullRequestReferenceUrl({
              ...destination,
              kind: destination.kind ?? parsedUrl?.kind,
              urlBase: destination.urlBase ?? parsedUrl?.urlBase,
              number: identity.number,
            }),
          }
        : {
            // Keep a legacy row's source-fork fields from being read as the
            // destination once its source repository is rewritten.
            org: identity.org,
            repo: identity.repo,
          }),
      ...(identity.sourceRepository
        ? {
            sourceRepository: source
              ? { provider: source.provider, org: source.org, repo: source.repo }
              : identity.sourceRepository,
          }
        : {}),
    };
  }

  /** A PR or MR URL under the forge's repository name. */
  canonicalizeUrl(url: string): string {
    const parsed = parsePullRequestReferenceUrl(url);
    const canonical = parsed ? this.canonicalRepository(parsed) : undefined;
    if (!parsed || !canonical || (canonical.org === parsed.org && canonical.repo === parsed.repo)) {
      return url;
    }
    return buildPullRequestReferenceUrl({
      ...canonical,
      kind: canonical.kind ?? parsed.kind,
      urlBase: canonical.urlBase ?? parsed.urlBase,
      number: parsed.number,
    });
  }

  /**
   * A case-folded `provider/org/repo` key under the forge's repository name.
   * The whole key is the lookup key, so GitLab subgroup paths cannot match a
   * shorter or longer repository path.
   */
  canonicalizeRepositoryKey(key: string): string {
    if (this.canonicalByKey.size === 0) return key;
    const folded = key.trim().toLowerCase();
    if (!this.canonicalByKey.has(folded)) return key;
    const [provider = "", ...rest] = folded.split("/");
    const repo = rest.pop();
    if (!provider || !repo || rest.length === 0) return key;
    const canonical = this.canonicalRepository({ provider, org: rest.join("/"), repo });
    return canonical ? repositoryKey(canonical) : key;
  }

  /** A `provider/org/repo#number` status key under the forge's repository name. */
  canonicalizeKey(key: string): string {
    if (this.canonicalByKey.size === 0) return key;
    const hashIndex = key.lastIndexOf("#");
    if (hashIndex <= 0) return key;
    const prefix = key.slice(0, hashIndex);
    const canonical = this.canonicalizeRepositoryKey(prefix);
    return canonical === prefix ? key : `${canonical}${key.slice(hashIndex)}`;
  }
}
