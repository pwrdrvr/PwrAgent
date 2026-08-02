import type {
  GithubCommitAuthorIdentity,
  GithubCommitAuthorIdentityCacheEntry,
  GithubCommitAuthorIdentityCacheStatus,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";

type CacheRow = {
  identity_key: string;
  status: string;
  github_login: string | null;
  avatar_url: string | null;
  fetched_at: number;
  expires_at: number;
  failure_count: number;
  next_retry_at: number | null;
  updated_at: number;
};

/**
 * SQLite persistence for proof-backed GitHub commit-author identities.
 *
 * The schema deliberately carries only a one-way identity key, GitHub fields,
 * and cache timing. Raw Git author names/emails and authentication material do
 * not enter the state database through this store.
 */
export class GithubCommitAuthorIdentityCacheStore {
  constructor(private readonly stateDb: StateDb) {}

  read(identityKey: string): GithubCommitAuthorIdentityCacheEntry | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT
           identity_key,
           status,
           github_login,
           avatar_url,
           fetched_at,
           expires_at,
           failure_count,
           next_retry_at,
           updated_at
         FROM github_commit_author_identity_cache
         WHERE identity_key = ?`,
      )
      .get(identityKey) as CacheRow | undefined;

    return row ? parseCacheRow(row) : undefined;
  }

  writeResolved(params: {
    identityKey: string;
    identity: GithubCommitAuthorIdentity;
    fetchedAt: number;
    expiresAt: number;
  }): void {
    this.stateDb.raw
      .prepare(
        `INSERT INTO github_commit_author_identity_cache(
           identity_key,
           status,
           github_login,
           avatar_url,
           fetched_at,
           expires_at,
           failure_count,
           next_retry_at,
           updated_at
         ) VALUES (?, 'resolved', ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           status = excluded.status,
           github_login = excluded.github_login,
           avatar_url = excluded.avatar_url,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           failure_count = 0,
           next_retry_at = NULL,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= github_commit_author_identity_cache.updated_at`,
      )
      .run(
        params.identityKey,
        params.identity.login,
        params.identity.avatarUrl ?? null,
        params.fetchedAt,
        params.expiresAt,
        params.fetchedAt,
      );
  }

  writeNegative(params: {
    identityKey: string;
    fetchedAt: number;
    expiresAt: number;
  }): void {
    this.stateDb.raw
      .prepare(
        `INSERT INTO github_commit_author_identity_cache(
           identity_key,
           status,
           github_login,
           avatar_url,
           fetched_at,
           expires_at,
           failure_count,
           next_retry_at,
           updated_at
         ) VALUES (?, 'negative', NULL, NULL, ?, ?, 0, NULL, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           status = excluded.status,
           github_login = NULL,
           avatar_url = NULL,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           failure_count = 0,
           next_retry_at = NULL,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= github_commit_author_identity_cache.updated_at`,
      )
      .run(params.identityKey, params.fetchedAt, params.expiresAt, params.fetchedAt);
  }

  /**
   * Persist a retry gate without discarding a stale resolved identity. A newer
   * fresh success always wins over an older transport failure.
   */
  recordFailure(params: {
    identityKey: string;
    failureCount: number;
    nextRetryAt: number;
    updatedAt: number;
  }): void {
    this.stateDb.raw
      .prepare(
        `INSERT INTO github_commit_author_identity_cache(
           identity_key,
           status,
           github_login,
           avatar_url,
           fetched_at,
           expires_at,
           failure_count,
           next_retry_at,
           updated_at
         ) VALUES (?, 'unavailable', NULL, NULL, 0, 0, ?, ?, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           failure_count = excluded.failure_count,
           next_retry_at = excluded.next_retry_at,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= github_commit_author_identity_cache.updated_at
           AND (
             github_commit_author_identity_cache.status = 'unavailable'
             OR github_commit_author_identity_cache.expires_at <= excluded.updated_at
           )`,
      )
      .run(
        params.identityKey,
        params.failureCount,
        params.nextRetryAt,
        params.updatedAt,
      );
  }
}

function parseCacheRow(row: CacheRow): GithubCommitAuthorIdentityCacheEntry | undefined {
  if (
    !isCacheStatus(row.status)
    || !isTimestamp(row.fetched_at)
    || !isTimestamp(row.expires_at)
    || !isTimestamp(row.updated_at)
    || !Number.isSafeInteger(row.failure_count)
    || row.failure_count < 0
  ) {
    return undefined;
  }

  const nextRetryAt = isTimestamp(row.next_retry_at)
    ? row.next_retry_at
    : undefined;
  if (row.status === "resolved") {
    const login = row.github_login?.trim();
    if (!login) {
      return undefined;
    }
    const avatarUrl = row.avatar_url?.trim();
    return {
      identityKey: row.identity_key,
      status: row.status,
      identity: {
        login,
        ...(avatarUrl ? { avatarUrl } : {}),
      },
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      failureCount: row.failure_count,
      ...(nextRetryAt ? { nextRetryAt } : {}),
      updatedAt: row.updated_at,
    };
  }

  return {
    identityKey: row.identity_key,
    status: row.status,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    failureCount: row.failure_count,
    ...(nextRetryAt ? { nextRetryAt } : {}),
    updatedAt: row.updated_at,
  };
}

function isCacheStatus(value: string): value is GithubCommitAuthorIdentityCacheStatus {
  return value === "resolved" || value === "negative" || value === "unavailable";
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
