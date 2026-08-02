/**
 * The local Git author fields that identify the person shown beside a commit.
 *
 * These are intentionally kept separate from `GithubCommitAuthorIdentity`:
 * callers must always keep rendering the local Git identity as the source of
 * truth, and may only add the GitHub fields when a resolver returns them.
 */
export type GithubCommitAuthorIdentityAuthor = {
  name: string;
  email: string;
};

/**
 * Evidence that lets a resolver prove an author-to-GitHub-account mapping.
 *
 * `commitSha` must be the full GitHub commit object id, not a short SHA or a
 * branch name. A resolver compares the returned commit id and Git author
 * fields before it accepts an account identity.
 */
export type GithubCommitAuthorIdentityProof = {
  owner: string;
  repo: string;
  commitSha: string;
};

/**
 * Input to a commit-author identity lookup.
 *
 * A proof is optional only so a caller can reuse a previously proven cache
 * entry. Without one, the resolver must not start a network lookup or infer a
 * GitHub account from an email address.
 */
export type GithubCommitAuthorIdentityInput = {
  author: GithubCommitAuthorIdentityAuthor;
  proof?: GithubCommitAuthorIdentityProof;
};

/** GitHub account fields safe to add beside a local Git commit author. */
export type GithubCommitAuthorIdentity = {
  login: string;
  /** HTTPS avatar URL when GitHub returned one; absent is valid. */
  avatarUrl?: string;
};

/** Persistent state of a proof-backed identity cache entry. */
export type GithubCommitAuthorIdentityCacheStatus =
  | "resolved"
  | "negative"
  | "unavailable";

/**
 * Portable record shape for a durable identity cache adapter. `identityKey` is
 * an opaque one-way key derived from the normalized local Git author pair.
 */
export type GithubCommitAuthorIdentityCacheEntry = {
  identityKey: string;
  status: GithubCommitAuthorIdentityCacheStatus;
  identity?: GithubCommitAuthorIdentity;
  fetchedAt: number;
  expiresAt: number;
  failureCount: number;
  nextRetryAt?: number;
  updatedAt: number;
};

/** Freshness of the persistent author-identity cache entry. */
export type GithubCommitAuthorIdentityCacheState = "fresh" | "stale" | "miss";

/**
 * The resolver's background-work state. These are intentionally presentation
 * neutral: clients can keep showing their local Git author while a lookup is
 * in flight, backed off, or ineligible for a first fetch.
 */
export type GithubCommitAuthorIdentityRefreshState =
  | "idle"
  | "in-flight"
  | "backing-off"
  | "not-eligible";

/** Immediate, non-blocking result of a commit-author identity request. */
export type GithubCommitAuthorIdentityLookup = {
  /** Present only after a proof-backed GitHub match has been accepted. */
  identity?: GithubCommitAuthorIdentity;
  cacheState: GithubCommitAuthorIdentityCacheState;
  refreshState: GithubCommitAuthorIdentityRefreshState;
};

/**
 * Result returned by a resolver request.
 *
 * `lookup` is always available immediately. `completion`, when present,
 * never rejects and resolves after the best-effort background fetch has
 * updated the cache. UI adapters can subscribe to it to schedule a repaint,
 * but they must not await it before displaying commit context.
 */
export type GithubCommitAuthorIdentityRequest = {
  lookup: GithubCommitAuthorIdentityLookup;
  completion?: Promise<GithubCommitAuthorIdentityLookup>;
};
