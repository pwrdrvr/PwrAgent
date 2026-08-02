# GitHub Commit-Author Identity Contract

This subsystem enriches a local Git commit author with a GitHub login and avatar
only after GitHub proves the mapping for the exact commit. It is deliberately a
main-process service with no renderer, IPC handler, or PwrAgent-specific UI.

## Public surface

The portable data contract is exported by `@pwragent/shared` from
`contracts/github-commit-author-identity.ts`:

```ts
export type GithubCommitAuthorIdentityInput = {
  author: { name: string; email: string };
  proof?: { owner: string; repo: string; commitSha: string };
};

export type GithubCommitAuthorIdentity = {
  login: string;
  avatarUrl?: string;
};

export type GithubCommitAuthorIdentityLookup = {
  identity?: GithubCommitAuthorIdentity;
  cacheState: "fresh" | "stale" | "miss";
  refreshState: "idle" | "in-flight" | "backing-off" | "not-eligible";
};
```

The implementation surface is exported by
`apps/desktop/src/main/github/index.ts`:

- `GithubCommitAuthorIdentityResolver` owns lookup policy, deduplication, TTL,
  negative caching, and retry gating.
- `GithubCommitAuthorIdentityCache` is the four-method durable-cache interface.
  `GithubCommitAuthorIdentityCacheStore` is PwrAgent's SQLite implementation.
- `GithubCommitAuthorIdentityTransport` is the one-method fetch interface.
  `GhCliCommitAuthorIdentityTransport` is PwrAgent's `gh api` adapter.
- `GithubCommitAuthorIdentityLogger` is an optional redacted diagnostic sink;
  the resolver is silent unless a host supplies it.

The resolver accepts interfaces rather than desktop singletons, so PwrGit can
reuse the contract and resolver with its own cache and process wiring.

## Required proof and reliability rule

A first network lookup requires all of the following:

- a non-empty local Git author name and email;
- a GitHub `owner` and `repo`; and
- the full, 40-character GitHub commit SHA from the local commit, never a
  short SHA, branch, tag, or email query.

The `gh api` transport requests this exact REST resource:

```text
GET /repos/{owner}/{repo}/commits/{commitSha}
```

The resolver accepts a GitHub identity only when the response has all of these
properties:

1. Its returned SHA equals the supplied full SHA.
2. Its Git commit author `name` and `email` equal the normalized local Git
   author fields.
3. GitHub returned an associated `author.login` for that commit.

A valid login is returned with an HTTPS avatar URL when GitHub supplied one.
The service never searches users by email or name, treats a partial/mismatched
response as inconclusive, and never substitutes a GitHub name for the local
Git author display.

When GitHub authoritatively returns `author: null` for an otherwise exact
commit, the resolver records an explicit no-match. A missing/malformed
response, a network failure, missing `gh`, an auth failure, a permission
failure, or an author/SHA mismatch is *not* a no-match.

## Non-blocking use

`request` reads SQLite synchronously and returns its presentation-neutral
snapshot immediately. It starts at most one background request per normalized
author pair and returns an optional, never-rejecting completion promise.

```ts
const request = resolver.request({
  author: {
    name: commit.authorName,
    email: commit.authorEmail,
  },
  proof: githubRemote
    ? {
      owner: githubRemote.owner,
      repo: githubRemote.repo,
      commitSha: commit.hash,
    }
    : undefined,
});

// Always render local Git data. Add these fields only when present.
contextCard.setGithubIdentity(request.lookup.identity);

// Schedule a repaint; do not await before opening the card.
void request.completion?.then(({ identity }) => {
  contextCard.setGithubIdentity(identity);
});
```

With no proof, `request` is cache-only. It may safely return a previously
proved identity for the same local name/email pair, but it cannot initiate a
network request. An invalid input, short SHA, or non-GitHub remote is similarly
`not-eligible` and does not guess.

For a cross-repository PwrGit adoption, implement the exported
`GithubCommitAuthorIdentityCache` interface against PwrGit's state store and
pass a transport that returns the canonical
`GithubCommitAuthorIdentityRemoteCommit` shape. The PwrAgent SQLite store and
`gh` transport may also be adopted together where their dependencies are
available. No PwrAgent app process or UI API is required.

## Cache and retry behavior

| Outcome | Returned immediately | Persistent behavior |
| --- | --- | --- |
| Verified GitHub identity | Fresh result, or a safe stale result during refresh | Login/avatar TTL: 7 days |
| Exact commit with no associated GitHub account | No added GitHub fields | Negative TTL: 24 hours |
| Network, `gh`, auth, permission, malformed, or mismatch failure | Existing stale verified identity if available; otherwise no fields | Retry gate: 1 minute, exponential to 1 hour |

There is no hidden polling or retry timer. A subsequent consumer request after
the gate expires performs the next attempt. This keeps offline sessions quiet
and prevents a commit-card hover from pinning work or retrying aggressively.

PwrAgent's persistent table is `github_commit_author_identity_cache`. It uses a
SHA-256 key derived from the normalized name/email pair and stores only that
opaque key, GitHub login/avatar, timestamps, status, and retry metadata. State
GC retains stale verified mappings for 90 days after expiry, negative rows for
7 days after expiry, and unavailable/backoff rows for 1 day.

## Credential and logging boundary

`GhCliCommitAuthorIdentityTransport` deliberately reuses PwrAgent's configured
`gh` command discovery, but not the PR GraphQL client's token flow. It invokes
`gh api --hostname github.com`; it does not call `gh auth token`, read
`GITHUB_TOKEN`, accept a token argument, persist a token, or expose one through
the contract. When a host supplies the optional logger, the resolver emits only
a generic deferred reason plus retry counts/duration—never raw response text,
author data, command output, or credentials.

The existing GraphQL PR poller remains the right boundary for batched PR status
across repositories. An identity lookup needs an exact single-commit proof, so
credential delegation through `gh api` is both narrower and safer here.

## PwrGit adoption checklist

- Derive `owner`/`repo` only from a recognized GitHub remote and use the
  existing full `Commit.hash` as `commitSha`.
- Keep the card's local `authorName` and `authorEmail` as the primary display.
  Show the GitHub login/avatar only when `lookup.identity` exists.
- Request without awaiting, then repaint from `completion` or an equivalent
  main-process event.
- Use no proof for non-GitHub remotes, missing origins, or short/untrusted SHAs.
- Treat every absent identity as ordinary fallback UI, not as an error or a
  request to authenticate.
- Keep the cache's opaque-key/no-token property if implementing a PwrGit-native
  adapter.
