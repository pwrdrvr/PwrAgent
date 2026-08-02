import { createHash } from "node:crypto";
import type {
  GithubCommitAuthorIdentity,
  GithubCommitAuthorIdentityAuthor,
  GithubCommitAuthorIdentityCacheEntry,
  GithubCommitAuthorIdentityInput,
  GithubCommitAuthorIdentityLookup,
  GithubCommitAuthorIdentityProof,
  GithubCommitAuthorIdentityRequest,
} from "@pwragent/shared";

/** How long a proof-backed GitHub identity stays fresh before revalidation. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an authoritative "no GitHub account for this commit" stays fresh. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** First delay before retrying a failed CLI/auth/network lookup. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_INITIAL_BACKOFF_MS = 60 * 1000;
/** Upper bound for exponential retry gates; there is no background retry loop. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Minimal canonical form returned by a GitHub transport for one exact commit.
 *
 * A `null` `githubAuthor` means GitHub authoritatively returned no associated
 * account. `undefined` means the response was incomplete and must never be
 * negative-cached.
 */
export type GithubCommitAuthorIdentityRemoteCommit = {
  sha?: string | null;
  author?: {
    name?: string | null;
    email?: string | null;
  } | null;
  githubAuthor?: {
    login?: string | null;
    avatarUrl?: string | null;
  } | null;
};

/**
 * Credential-opaque transport seam. The resolver never receives, stores, or
 * logs an auth token; a desktop adapter may delegate authentication to `gh`.
 */
export type GithubCommitAuthorIdentityTransport = {
  fetchCommit(
    proof: GithubCommitAuthorIdentityProof,
  ): Promise<GithubCommitAuthorIdentityRemoteCommit>;
};

/** Optional redacted diagnostic sink; never receives author data or tokens. */
export type GithubCommitAuthorIdentityLogger = {
  debug(
    message: string,
    metadata: {
      reason: "inconclusive" | "transport";
      failureCount: number;
      retryAfterMs: number;
    },
  ): void;
};

/**
 * Persistence seam for the resolver. PwrGit can supply its own durable store
 * without depending on PwrAgent's SQLite implementation.
 */
export type GithubCommitAuthorIdentityCache = {
  read(identityKey: string): GithubCommitAuthorIdentityCacheEntry | undefined;
  writeResolved(params: {
    identityKey: string;
    identity: GithubCommitAuthorIdentity;
    fetchedAt: number;
    expiresAt: number;
  }): void;
  writeNegative(params: {
    identityKey: string;
    fetchedAt: number;
    expiresAt: number;
  }): void;
  recordFailure(params: {
    identityKey: string;
    failureCount: number;
    nextRetryAt: number;
    updatedAt: number;
  }): void;
};

export type GithubCommitAuthorIdentityResolverOptions = {
  cache: GithubCommitAuthorIdentityCache;
  transport: GithubCommitAuthorIdentityTransport;
  logger?: GithubCommitAuthorIdentityLogger;
  now?: () => number;
  resolvedTtlMs?: number;
  negativeTtlMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
};

type NormalizedAuthor = GithubCommitAuthorIdentityAuthor;

type PreparedLookup = {
  identityKey: string;
  author: NormalizedAuthor;
  proof?: GithubCommitAuthorIdentityProof;
};

type RemoteOutcome =
  | { kind: "resolved"; identity: GithubCommitAuthorIdentity }
  | { kind: "negative" }
  | { kind: "inconclusive" };

/**
 * Best-effort resolver for adding GitHub presentation fields to a known Git
 * commit author.
 *
 * `request` returns synchronously from SQLite and starts work only when the
 * row is stale/missing and a full GitHub commit proof is present. Its optional
 * completion promise is safe to observe for an eventual repaint and never
 * rejects; callers should always render their local Git author immediately.
 */
export class GithubCommitAuthorIdentityResolver {
  private readonly cache: GithubCommitAuthorIdentityCache;
  private readonly transport: GithubCommitAuthorIdentityTransport;
  private readonly logger: GithubCommitAuthorIdentityLogger | undefined;
  private readonly now: () => number;
  private readonly resolvedTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly inFlightByIdentityKey = new Map<
    string,
    Promise<GithubCommitAuthorIdentityLookup>
  >();

  constructor(options: GithubCommitAuthorIdentityResolverOptions) {
    this.cache = options.cache;
    this.transport = options.transport;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.resolvedTtlMs = positiveDuration(
      options.resolvedTtlMs,
      GITHUB_COMMIT_AUTHOR_IDENTITY_TTL_MS,
    );
    this.negativeTtlMs = positiveDuration(
      options.negativeTtlMs,
      GITHUB_COMMIT_AUTHOR_IDENTITY_NEGATIVE_TTL_MS,
    );
    this.initialBackoffMs = positiveDuration(
      options.initialBackoffMs,
      GITHUB_COMMIT_AUTHOR_IDENTITY_INITIAL_BACKOFF_MS,
    );
    this.maxBackoffMs = Math.max(
      this.initialBackoffMs,
      positiveDuration(
        options.maxBackoffMs,
        GITHUB_COMMIT_AUTHOR_IDENTITY_MAX_BACKOFF_MS,
      ),
    );
  }

  /**
   * Return cache data immediately and, when eligible, start one deduplicated
   * background lookup. A fresh negative row is deliberately indistinguishable
   * from an ordinary absence to presentation code: keep showing local Git
   * identity and do not suggest a guessed GitHub account.
   */
  request(input: GithubCommitAuthorIdentityInput): GithubCommitAuthorIdentityRequest {
    const prepared = prepareLookup(input);
    if (!prepared) {
      return {
        lookup: {
          cacheState: "miss",
          refreshState: "not-eligible",
        },
      };
    }

    const now = this.now();
    const cached = this.readCache(prepared.identityKey);
    if (isFresh(cached, now)) {
      return { lookup: toLookup(cached, now, "idle") };
    }
    if (!prepared.proof) {
      return {
        lookup: toLookup(cached, now, "not-eligible"),
      };
    }
    if (cached?.nextRetryAt && cached.nextRetryAt > now) {
      return {
        lookup: toLookup(cached, now, "backing-off"),
      };
    }

    const completion = this.startRefresh(prepared);
    return {
      lookup: toLookup(cached, now, "in-flight"),
      completion,
    };
  }

  private startRefresh(
    prepared: PreparedLookup,
  ): Promise<GithubCommitAuthorIdentityLookup> {
    const existing = this.inFlightByIdentityKey.get(prepared.identityKey);
    if (existing) {
      return existing;
    }

    const completion = Promise.resolve()
      .then(async () => {
        await this.refresh(prepared);
        const now = this.now();
        const cached = this.readCache(prepared.identityKey);
        return toLookup(
          cached,
          now,
          refreshStateAfterCompletion(cached, now),
        );
      })
      .catch(() => ({
        // `refresh` absorbs expected failures. This guard keeps the public
        // completion promise non-rejecting even if cache I/O itself misbehaves.
        cacheState: "miss" as const,
        refreshState: "backing-off" as const,
      }));

    this.inFlightByIdentityKey.set(prepared.identityKey, completion);
    void completion.then(() => {
      if (this.inFlightByIdentityKey.get(prepared.identityKey) === completion) {
        this.inFlightByIdentityKey.delete(prepared.identityKey);
      }
    });
    return completion;
  }

  private async refresh(prepared: PreparedLookup): Promise<void> {
    if (!prepared.proof) {
      return;
    }

    try {
      const response = await this.transport.fetchCommit(prepared.proof);
      const completedAt = this.now();
      const outcome = evaluateRemoteCommit(
        response,
        prepared.author,
        prepared.proof,
      );
      if (outcome.kind === "resolved") {
        this.cache.writeResolved({
          identityKey: prepared.identityKey,
          identity: outcome.identity,
          fetchedAt: completedAt,
          expiresAt: completedAt + this.resolvedTtlMs,
        });
        return;
      }
      if (outcome.kind === "negative") {
        this.cache.writeNegative({
          identityKey: prepared.identityKey,
          fetchedAt: completedAt,
          expiresAt: completedAt + this.negativeTtlMs,
        });
        return;
      }
      this.recordFailure(prepared.identityKey, completedAt, "inconclusive");
    } catch {
      this.recordFailure(prepared.identityKey, this.now(), "transport");
    }
  }

  private readCache(
    identityKey: string,
  ): GithubCommitAuthorIdentityCacheEntry | undefined {
    try {
      return this.cache.read(identityKey);
    } catch {
      return undefined;
    }
  }

  private recordFailure(
    identityKey: string,
    now: number,
    reason: "inconclusive" | "transport",
  ): void {
    const failureCount = Math.min(
      16,
      (this.readCache(identityKey)?.failureCount ?? 0) + 1,
    );
    const retryAfterMs = backoffMs(
      failureCount,
      this.initialBackoffMs,
      this.maxBackoffMs,
    );
    try {
      this.cache.recordFailure({
        identityKey,
        failureCount,
        nextRetryAt: now + retryAfterMs,
        updatedAt: now,
      });
    } catch {
      // Do not turn a cache write issue into UI-visible commit-card failure.
    }
    this.logger?.debug("GitHub commit-author identity lookup deferred", {
      reason,
      failureCount,
      retryAfterMs,
    });
  }
}

/**
 * Return the stable, one-way SQLite key for a valid author pair. Cache entries
 * are intentionally not keyed by repo or commit because a direct commit proof
 * establishes a reusable mapping for the same name/email pair.
 */
export function buildGithubCommitAuthorIdentityCacheKey(
  author: GithubCommitAuthorIdentityAuthor,
): string | undefined {
  const normalized = normalizeAuthor(author);
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256")
    .update(`github-commit-author-identity:v1\0${normalized.email}\0${normalized.name}`)
    .digest("hex");
}

function prepareLookup(
  input: GithubCommitAuthorIdentityInput,
): PreparedLookup | undefined {
  const author = normalizeAuthor(input?.author);
  if (!author) {
    return undefined;
  }
  const identityKey = buildGithubCommitAuthorIdentityCacheKey(author);
  if (!identityKey) {
    return undefined;
  }
  const proof = normalizeProof(input?.proof);
  return {
    identityKey,
    author,
    ...(proof ? { proof } : {}),
  };
}

function normalizeAuthor(value: unknown): NormalizedAuthor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = normalizeName(value.name);
  const email = normalizeEmail(value.email);
  return name && email ? { name, email } : undefined;
}

function normalizeProof(
  value: GithubCommitAuthorIdentityProof | undefined,
): GithubCommitAuthorIdentityProof | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const owner = normalizeGithubPathSegment(value.owner);
  const repo = normalizeGithubPathSegment(value.repo);
  const commitSha = normalizeCommitSha(value.commitSha);
  return owner && repo && commitSha ? { owner, repo, commitSha } : undefined;
}

function evaluateRemoteCommit(
  response: GithubCommitAuthorIdentityRemoteCommit,
  expectedAuthor: NormalizedAuthor,
  expectedProof: GithubCommitAuthorIdentityProof,
): RemoteOutcome {
  if (normalizeCommitSha(response.sha) !== expectedProof.commitSha) {
    return { kind: "inconclusive" };
  }
  const remoteAuthor = normalizeAuthor(response.author);
  if (
    !remoteAuthor
    || remoteAuthor.name !== expectedAuthor.name
    || remoteAuthor.email !== expectedAuthor.email
  ) {
    return { kind: "inconclusive" };
  }
  if (response.githubAuthor === null) {
    return { kind: "negative" };
  }
  const identity = normalizeGithubIdentity(response.githubAuthor);
  return identity ? { kind: "resolved", identity } : { kind: "inconclusive" };
}

function normalizeGithubIdentity(
  value: GithubCommitAuthorIdentityRemoteCommit["githubAuthor"],
): GithubCommitAuthorIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const login = safeText(value.login, 255);
  if (!login) {
    return undefined;
  }
  const avatarUrl = normalizeAvatarUrl(value.avatarUrl);
  return {
    login,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function toLookup(
  entry: GithubCommitAuthorIdentityCacheEntry | undefined,
  now: number,
  refreshState: GithubCommitAuthorIdentityLookup["refreshState"],
): GithubCommitAuthorIdentityLookup {
  const cacheState = !entry || entry.status === "unavailable"
    ? "miss"
    : entry.expiresAt > now
      ? "fresh"
      : "stale";
  return {
    ...(entry?.identity ? { identity: entry.identity } : {}),
    cacheState,
    refreshState,
  };
}

function isFresh(
  entry: GithubCommitAuthorIdentityCacheEntry | undefined,
  now: number,
): boolean {
  return Boolean(entry && entry.status !== "unavailable" && entry.expiresAt > now);
}

function refreshStateAfterCompletion(
  entry: GithubCommitAuthorIdentityCacheEntry | undefined,
  now: number,
): GithubCommitAuthorIdentityLookup["refreshState"] {
  return entry?.nextRetryAt && entry.nextRetryAt > now ? "backing-off" : "idle";
}

function normalizeName(value: unknown): string | undefined {
  const name = safeText(value, 512);
  return name?.normalize("NFC");
}

function normalizeEmail(value: unknown): string | undefined {
  const email = safeText(value, 320)?.normalize("NFC").toLowerCase();
  return email && email.includes("@") && !/\s/.test(email) ? email : undefined;
}

function normalizeGithubPathSegment(value: unknown): string | undefined {
  const segment = safeText(value, 100);
  return segment && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment)
    ? segment
    : undefined;
}

function normalizeCommitSha(value: unknown): string | undefined {
  const sha = safeText(value, 40)?.toLowerCase();
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
}

function normalizeAvatarUrl(value: unknown): string | undefined {
  const raw = safeText(value, 2_048);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized
    && normalized.length <= maxLength
    && !hasControlCharacter(normalized)
    ? normalized
    : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1F || code === 0x7F) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backoffMs(
  failureCount: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
): number {
  return Math.min(
    maxBackoffMs,
    initialBackoffMs * 2 ** Math.max(0, failureCount - 1),
  );
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
