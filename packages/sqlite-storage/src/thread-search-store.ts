import { isDeepStrictEqual } from "node:util";
import type BetterSqlite3 from "better-sqlite3";
import {
  buildLegacyEncodedThreadIdentityKey,
  encodeLegacyThreadIdentityKey,
  normalizeThreadIdentityKey,
} from "@pwragent/shared/contracts/navigation";
import {
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type LinkedDirectorySummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import { type ThreadSearchFilters, type ThreadSearchResult } from "@pwragent/shared/contracts/thread-search";
import type { ThreadSearchProjectionSearchRequest, ThreadSearchStorage } from "@pwragent/owner-core/thread-search-storage";
import type { StateDb } from "./state-db";
import {
  buildPartialThreadSearchFtsQuery,
  buildThreadSearchFtsQuery,
  buildTypoThreadSearchFtsQuery,
} from "./thread-search-fts-query";

type ThreadSearchDocumentRow = {
  identity_key: string;
  backend: AppServerBackendKind;
  thread_id: string;
  title: string;
  title_source: AppServerThreadSummary["titleSource"] | null;
  summary: string | null;
  project_key: string | null;
  created_at: number | null;
  updated_at: number | null;
  archived_at: number | null;
  git_branch: string | null;
  model: string | null;
  linked_directories_json: string;
};

type ThreadSearchFtsRow = ThreadSearchDocumentRow & {
  rank_value?: number;
  snippet_text?: string | null;
};

type SearchProjection = ReturnType<typeof projectThread>;
type SearchProjectionBindings = ReturnType<typeof bindThreadProjection>;
type ProjectionVersion = { external: number; local: number };
type ProjectionCache = {
  rows: Map<string, SearchProjection>;
  version?: ProjectionVersion;
};
type ChangedProjection = { projection: SearchProjection; bindings: SearchProjectionBindings };

const MAX_VERIFIED_PROJECTIONS = 8192;
const projectionCaches = new WeakMap<BetterSqlite3.Database, ProjectionCache>();

export class ThreadSearchStore implements ThreadSearchStorage {
  private readonly db: BetterSqlite3.Database;
  private readonly pruneCursors = new Map<string, string>();
  private readonly projectionCache: ProjectionCache;
  private readonly readProjectionVersion: BetterSqlite3.Statement<[], ProjectionVersion>;
  private readonly readLocalChanges: BetterSqlite3.Statement<[], number>;
  private readonly hasCurrentProjection: BetterSqlite3.Statement<[SearchProjectionBindings]>;

  constructor(stateDb: StateDb) {
    this.db = stateDb.raw;
    const sharedCache = projectionCaches.get(this.db) ?? { rows: new Map() };
    projectionCaches.set(this.db, sharedCache);
    this.projectionCache = sharedCache;
    this.readProjectionVersion = this.db.prepare(`
      SELECT data_version AS external, total_changes() AS local FROM pragma_data_version
    `);
    this.readLocalChanges = this.db.prepare<[], number>("SELECT total_changes()").pluck();
    this.hasCurrentProjection = this.db.prepare(`
      SELECT 1 FROM thread_search_documents d
      WHERE d.identity_key = @identityKey AND d.backend IS @backend AND d.thread_id IS @threadId
        AND d.title IS @title AND d.title_source IS @titleSource AND d.summary IS @summary
        AND d.project_key IS @projectKey AND d.created_at IS @createdAt AND d.updated_at IS @updatedAt
        AND d.archived_at IS @archivedAt AND d.git_branch IS @gitBranch AND d.git_origin_url IS @gitOriginUrl
        AND d.model IS @model AND d.linked_directories_json IS @linkedDirectoriesJson AND d.display_json IS @displayJson
        AND EXISTS (
          SELECT 1 FROM thread_search_fts_rows k
          JOIN thread_search_fts f ON f.rowid = k.fts_rowid
          WHERE k.identity_key = d.identity_key AND f.identity_key = k.identity_key
            AND f.title IS @title AND f.summary IS @ftsSummary AND f.project_key IS @ftsProjectKey
            AND f.directory_labels IS @directoryLabels AND f.directory_paths IS @directoryPaths
            AND f.git_branch IS @ftsGitBranch AND f.git_origin_url IS @ftsGitOriginUrl
            AND f.model IS @ftsModel AND f.backend IS @backend AND f.thread_id IS @ftsThreadId
        )
    `);
  }

  /** One write commit per changed slice, with no writer lock for a stable, current slice. */
  upsertThreads(threads: readonly AppServerThreadSummary[]): void {
    this.upsert(threads);
  }

  upsertThread(thread: AppServerThreadSummary, indexedAt = Date.now()): void {
    this.upsert([thread], indexedAt);
  }

  private upsert(threads: readonly AppServerThreadSummary[], indexedAt?: number): void {
    if (threads.length === 0) return;
    if (this.db.inTransaction) {
      // A caller-owned transaction can see uncommitted state and roll it back.
      this.db.transaction(() => this.writeChangedProjections(this.findChanges(threads), indexedAt))();
      return;
    }

    const cache = this.projectionCache;
    let preflight = this.db.transaction(() => {
      // Pin the version and the projection reads to the same snapshot.
      const version = this.refreshProjectionCache();
      return { version, changed: this.findChanges(threads, cache) };
    })();
    if (preflight.changed.length === 0) {
      // The final search can see commits hidden by the preflight snapshot.
      const version = this.refreshProjectionCache();
      if (version === preflight.version) return;
      // Recheck with fresh per-row reads. An unrelated commit should leave
      // this slice read-only, even if a peer still holds the writer lock.
      preflight = { version, changed: this.findChanges(threads) };
      if (preflight.changed.length === 0) return;
    }

    const committed = this.db.transaction(() => {
      // A peer may have reconciled these rows since preflight. Recheck first
      // so SQLite only upgrades to a write transaction if work remains.
      const version = this.refreshProjectionCache();
      const changed = version === preflight.version ? preflight.changed : this.findChanges(threads, cache);
      return {
        written: this.writeChangedProjections(changed, indexedAt),
        external: version.external,
      };
    }).deferred();
    if (committed.written.size === 0) return;
    // Keep the external version from the transaction snapshot. FTS can flush
    // shadow changes at commit, so sample our own count after the commit.
    cache.version = { external: committed.external, local: this.readLocalChanges.get()! };
    for (const projection of committed.written.values()) rememberProjection(cache, projection);
  }

  private refreshProjectionCache(): ProjectionVersion {
    // total_changes detects writes through this connection, including repairs
    // and writes rolled back outside this store.
    const version = this.readProjectionVersion.get()!;
    const previous = this.projectionCache.version;
    if (previous?.external === version.external && previous.local === version.local) return previous;
    this.projectionCache.rows.clear();
    this.projectionCache.version = version;
    return version;
  }

  private findChanges(
    threads: readonly AppServerThreadSummary[],
    cache?: ProjectionCache,
  ): ChangedProjection[] {
    const changed: ChangedProjection[] = [];
    for (const thread of threads) {
      const projection = projectThread(thread);
      const previous = cache?.rows.get(projection.identityKey);
      if (previous && isDeepStrictEqual(previous, projection)) continue;
      const bindings = bindThreadProjection(projection);
      if (!this.hasCurrentProjection.get(bindings)) {
        changed.push({ projection, bindings });
      } else if (cache) {
        rememberProjection(cache, projection);
      }
    }
    return changed;
  }

  private writeChangedProjections(changed: ChangedProjection[], indexedAt?: number): Map<string, SearchProjection> {
    const written = new Map<string, SearchProjection>();
    for (const { projection, bindings } of changed) {
      // A provider can repeat an identity within one slice. Recheck only if
      // an earlier input in this slice wrote that identity.
      if (written.has(projection.identityKey) && this.hasCurrentProjection.get(bindings)) continue;
      this.writeProjection(bindings, indexedAt ?? Date.now());
      written.set(projection.identityKey, projection);
    }
    return written;
  }

  private writeProjection(bindings: SearchProjectionBindings, indexedAt: number): void {
    this.deleteFtsRows(bindings.identityKey);
    this.db.prepare(`
      INSERT INTO thread_search_documents (
        identity_key, backend, thread_id, title, title_source, summary,
        project_key, created_at, updated_at, archived_at, git_branch,
        git_origin_url, model, linked_directories_json, display_json, indexed_at
      ) VALUES (
        @identityKey, @backend, @threadId, @title, @titleSource, @summary,
        @projectKey, @createdAt, @updatedAt, @archivedAt, @gitBranch,
        @gitOriginUrl, @model, @linkedDirectoriesJson, @displayJson, @indexedAt
      )
      ON CONFLICT(identity_key) DO UPDATE SET
        backend = excluded.backend,
        thread_id = excluded.thread_id,
        title = excluded.title,
        title_source = excluded.title_source,
        summary = excluded.summary,
        project_key = excluded.project_key,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        git_branch = excluded.git_branch,
        git_origin_url = excluded.git_origin_url,
        model = excluded.model,
        linked_directories_json = excluded.linked_directories_json,
        display_json = excluded.display_json,
        indexed_at = excluded.indexed_at
    `).run({ ...bindings, indexedAt });
    // Allocate above both stores: an older process sharing this profile can
    // still insert FTS rows without knowing the mapping table exists.
    this.db.prepare(`INSERT INTO thread_search_fts_rows (identity_key, fts_rowid)
      SELECT ?, MAX(
        COALESCE((SELECT MAX(fts_rowid) FROM thread_search_fts_rows), 0),
        COALESCE((SELECT rowid FROM thread_search_fts ORDER BY rowid DESC LIMIT 1), 0)
      ) + 1
      WHERE NOT EXISTS (SELECT 1 FROM thread_search_fts_rows WHERE identity_key = ?)
    `).run(bindings.identityKey, bindings.identityKey);
    this.db.prepare(`
      INSERT INTO thread_search_fts (
        rowid, identity_key, title, summary, project_key, directory_labels,
        directory_paths, git_branch, git_origin_url, model, backend, thread_id
      ) VALUES (
        (SELECT fts_rowid FROM thread_search_fts_rows WHERE identity_key = @identityKey),
        @identityKey, @title, @ftsSummary, @ftsProjectKey, @directoryLabels, @directoryPaths,
        @ftsGitBranch, @ftsGitOriginUrl, @ftsModel, @backend, @ftsThreadId
      )
    `).run(bindings);
  }

  deleteThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void {
    const identityKey = buildLegacyEncodedThreadIdentityKey(
      params.backend,
      params.threadId,
    );
    this.db.transaction(() => {
      this.deleteThreadRows(identityKey, params.backend, params.threadId);
    })();
  }

  private deleteFtsRows(identityKey: string): void {
    const mapping = this.db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM thread_search_fts f
        WHERE f.rowid = k.fts_rowid AND f.identity_key = k.identity_key
      ) AS current FROM thread_search_fts_rows k WHERE k.identity_key = ?
    `).get(identityKey) as { current: number } | undefined;
    if (mapping?.current) {
      this.db.prepare(`DELETE FROM thread_search_fts WHERE rowid = (
        SELECT fts_rowid FROM thread_search_fts_rows WHERE identity_key = ?
      )`).run(identityKey);
      return;
    }
    // Only legacy writers can invalidate a migrated mapping. Verify it before
    // deletion so a reused rowid never deletes another thread's tokens. New
    // identities skip the compatibility scan altogether.
    if (mapping || this.db.prepare("SELECT 1 FROM thread_search_documents WHERE identity_key = ?").get(identityKey)) {
      this.db.prepare("DELETE FROM thread_search_fts WHERE identity_key = ?").run(identityKey);
    }
    if (mapping) this.db.prepare("DELETE FROM thread_search_fts_rows WHERE identity_key = ?").run(identityKey);
  }

  private deleteThreadRows(identityKey: string, backend: AppServerBackendKind, threadId: string): void {
    this.db.prepare(`
      INSERT INTO thread_usage_titles (identity_key, title)
      SELECT identity_key, title FROM thread_search_documents
       WHERE identity_key = ?
         AND (
           EXISTS (
             SELECT 1 FROM thread_usage_lines
              WHERE backend = ? AND thread_id = ?
              LIMIT 1
           )
           OR EXISTS (
             SELECT 1 FROM automation_runs r
             JOIN thread_usage_lines l
               ON l.backend = r.backend
              AND l.thread_id = json_extract(r.payload, '$.backendThreadId')
            WHERE r.backend = ? AND r.thread_id = ?
            LIMIT 1
           )
         )
      ON CONFLICT(identity_key) DO UPDATE SET title = excluded.title
    `).run(
      identityKey,
      backend,
      threadId,
      backend,
      threadId,
    );
    this.deleteFtsRows(identityKey);
    this.db
      .prepare("DELETE FROM thread_search_documents WHERE identity_key = ?")
      .run(identityKey);
    this.db.prepare("DELETE FROM thread_search_fts_rows WHERE identity_key = ?").run(identityKey);
  }

  /** Explicit complete-inventory maintenance only; listings used by search are partial. */
  pruneMissingThreads(params: {
    backend?: AppServerBackendKind;
    includeArchived: boolean;
    retainedIdentityKeys: string[];
  }): void {
    const retained = new Set(params.retainedIdentityKeys.map((key) => encodeLegacyThreadIdentityKey(key) ?? key));
    const scope = JSON.stringify([params.backend ?? null, params.includeArchived]);
    const cursor = this.pruneCursors.get(scope) ?? "";
    const next = this.db.transaction(() => {
      // Page the identity index, then apply inventory/partition rules. A slice
      // examines at most 64 documents even when none are eligible for deletion.
      const rows = this.db.prepare(`
        SELECT identity_key, backend, thread_id, archived_at FROM thread_search_documents
        WHERE identity_key > ? ORDER BY identity_key LIMIT 64
      `).all(cursor) as Array<{
        identity_key: string; backend: AppServerBackendKind; thread_id: string; archived_at: number | null;
      }>;
      for (const row of rows) {
        if (retained.has(row.identity_key)
          || (params.backend && row.backend !== params.backend)
          || (!params.includeArchived && row.archived_at !== null)) continue;
        this.deleteThreadRows(row.identity_key, row.backend, row.thread_id);
      }
      return rows.length === 64 ? rows[rows.length - 1].identity_key : "";
    })();
    this.pruneCursors.set(scope, next);
  }

  search(request: ThreadSearchProjectionSearchRequest): ThreadSearchResult[] {
    if (request.identityKeys?.length === 0) return [];
    const ftsQuery = buildThreadSearchFtsQuery(request.query);
    const backendClause = request.backend ? " AND d.backend = @backend" : "";
    const archivedClause = request.includeArchived ? "" : " AND d.archived_at IS NULL";
    const filterWhere = buildFilterWhereClause(request.filters);
    const scopedDocuments = request.identityKeys
      ? `FROM (SELECT DISTINCT value AS identity_key FROM json_each(@identityKeys)) keys
         CROSS JOIN thread_search_documents d ON d.identity_key = keys.identity_key`
      : "FROM thread_search_documents d";
    if (request.identityKeys) {
      filterWhere.params.identityKeys = JSON.stringify(request.identityKeys.map(encodeLegacyThreadIdentityKey));
    }

    if (!ftsQuery) {
      return this.db
        .prepare(
          `SELECT d.*
             ` + scopedDocuments + `
            WHERE 1 = 1` + backendClause + archivedClause + filterWhere.sql + `
            ORDER BY COALESCE(d.updated_at, d.created_at, 0) DESC
            LIMIT @limit`,
        )
        .all({
          backend: request.backend,
          ...filterWhere.params,
          limit: request.limit,
        })
        .map((row) => this.rowToResult(row as ThreadSearchDocumentRow, 0, null));
    }

    // Each MATCH/ranking pass must have one cursor for the whole result set. Driving
    // FTS by inventory rowid restarts its corpus statistics for every identity.
    // Membership stays in WHERE, before ranking and LIMIT.
    const ranked = this.db
      .prepare(
        `SELECT d.*,
                bm25(thread_search_fts) AS rank_value,
                snippet(thread_search_fts, 1, '', '', '...', 16) AS snippet_text
           FROM thread_search_fts
           CROSS JOIN thread_search_documents d ON d.identity_key = thread_search_fts.identity_key
          WHERE thread_search_fts MATCH @query`
          + (request.identityKeys ? " AND d.identity_key IN (SELECT value FROM json_each(@identityKeys))" : "")
          + backendClause + archivedClause + filterWhere.sql + `
          ORDER BY rank_value ASC, COALESCE(d.updated_at, d.created_at, 0) DESC, thread_search_fts.rowid ASC
          LIMIT @limit`,
      );
    const runMatch = (query: string, limit: number): ThreadSearchFtsRow[] =>
      ranked.all({
        backend: request.backend,
        ...filterWhere.params,
        limit,
        query,
      }) as ThreadSearchFtsRow[];
    const toResult = (row: ThreadSearchFtsRow, relaxation = 0): ThreadSearchResult => {
      const bm25 = -(row.rank_value ?? 0);
      // Exact matches keep the score that older peers already send and sort
      // by. Relaxed matches occupy disjoint negative bands, even for a viewer
      // that only knows how to compare numeric scores.
      const score = relaxation === 0 ? bm25 : bm25 / (1 + bm25) - relaxation;
      return this.rowToResult(row, score, row.snippet_text, request.query);
    };
    // A second process can update the index between passes. One deferred
    // read transaction keeps MATCH and its exclusions on the same snapshot.
    return this.db.transaction(() => {
      const exact = runMatch(ftsQuery, request.limit);
      const results = exact.map((row) => toResult(row));
      if (results.length >= request.limit) return results;

      const correctedQuery = exact.length === 0 ? buildTypoThreadSearchFtsQuery(request.query) : undefined;
      const corrected = correctedQuery ? runMatch(correctedQuery, request.limit) : [];
      results.push(...corrected.map((row) => toResult(row, 1)));
      if (results.length >= request.limit) return results;

      const partialQuery = buildPartialThreadSearchFtsQuery(request.query);
      if (partialQuery) {
        const correctedKeys = new Set(corrected.map((row) => row.identity_key));
        // Corrected results can also match an uncorrected term. Overfetch by
        // at most the size of that band to fill the page after deduplication.
        const partial = runMatch(partialQuery, request.limit - exact.length)
          .filter((row) => !correctedKeys.has(row.identity_key))
          .slice(0, request.limit - results.length);
        results.push(...partial.map((row) => toResult(row, 2)));
      }
      return results;
    })();
  }

  private rowToResult(
    row: ThreadSearchDocumentRow,
    score: number,
    snippetText: string | null | undefined,
    query?: string,
  ): ThreadSearchResult {
    const threadIdMatch = queryMatchesIdentifier(query, row.thread_id);
    return {
      backend: row.backend,
      threadId: row.thread_id,
      identityKey:
        normalizeThreadIdentityKey(row.identity_key) ?? row.identity_key,
      title: row.title,
      ...(row.title_source ? { titleSource: row.title_source } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.project_key ? { projectKey: row.project_key } : {}),
      ...(row.created_at ? { createdAt: row.created_at } : {}),
      ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      linkedDirectories: parseLinkedDirectories(row.linked_directories_json),
      source: row.backend,
      ...(row.git_branch ? { gitBranch: row.git_branch } : {}),
      ...(row.model ? { model: row.model } : {}),
      score,
      confidence: threadIdMatch ? "high" : score !== 0 ? "medium" : "low",
      matchReasons:
        score !== 0
          ? [
              threadIdMatch
                ? { kind: "thread_id_match", field: "thread_id" }
                : { kind: "summary_match", field: "projection" },
            ]
          : [],
      snippets: snippetText
        ? [{ scope: "projection", field: "summary", text: snippetText }]
        : [],
    };
  }
}

function queryMatchesIdentifier(query: string | undefined, identifier: string): boolean {
  const needle = query?.trim().toLowerCase();
  return needle !== undefined && needle.length > 0
    ? identifier.toLowerCase().includes(needle)
    : false;
}

function projectThread(thread: AppServerThreadSummary) {
  return {
    identityKey: buildLegacyEncodedThreadIdentityKey(thread.source, thread.id),
    backend: thread.source,
    threadId: thread.id,
    title: thread.title,
    titleSource: thread.titleSource ?? null,
    summary: thread.summary ?? null,
    projectKey: thread.projectKey ?? null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    archivedAt: thread.archivedAt ?? null,
    gitBranch: thread.gitBranch ?? null,
    gitOriginUrl: thread.gitOriginUrl ?? null,
    model: thread.model ?? null,
    serviceTier: thread.serviceTier,
    reasoningEffort: thread.reasoningEffort,
    linkedDirectories: thread.linkedDirectories,
  };
}

function bindThreadProjection(projection: SearchProjection) {
  const { linkedDirectories, serviceTier, reasoningEffort, ...fields } = projection;
  return {
    ...fields,
    linkedDirectoriesJson: JSON.stringify(linkedDirectories),
    displayJson: JSON.stringify({ source: projection.backend, serviceTier, reasoningEffort }),
    directoryLabels: linkedDirectories.map((directory) => directory.label).join(" "),
    directoryPaths: linkedDirectories
      .flatMap((directory) => [directory.path, directory.worktreePath].filter(Boolean))
      .join(" "),
    ftsSummary: projection.summary ?? "",
    ftsProjectKey: projection.projectKey ?? "",
    ftsGitBranch: projection.gitBranch ?? "",
    ftsGitOriginUrl: projection.gitOriginUrl ?? "",
    ftsModel: projection.model ?? "",
    ftsThreadId: buildThreadIdSearchText(projection.threadId),
  };
}

function rememberProjection(cache: ProjectionCache, projection: SearchProjection): void {
  // Keep the verified subset when a fleet exceeds the bound, so a repeated
  // traversal in provider order still gets cache hits.
  if (cache.rows.size < MAX_VERIFIED_PROJECTIONS || cache.rows.has(projection.identityKey)) {
    cache.rows.set(projection.identityKey, {
      ...projection,
      linkedDirectories: structuredClone(projection.linkedDirectories),
    });
  }
}

function buildThreadIdSearchText(threadId: string): string {
  const variants = new Set([threadId]);
  for (const match of threadId.matchAll(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  )) {
    variants.add(match[0]);
  }
  return [...variants].join(" ");
}

function buildFilterWhereClause(filters: ThreadSearchFilters | undefined): {
  params: Record<string, unknown>;
  sql: string;
} {
  if (!filters) {
    return { params: {}, sql: "" };
  }
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.projectKeys?.length) {
    const placeholders = filters.projectKeys.map((projectKey, index) => {
      const param = `projectKey${index}`;
      params[param] = projectKey;
      return `@${param}`;
    });
    clauses.push(`d.project_key IN (${placeholders.join(", ")})`);
  }

  if (filters.models?.length) {
    const placeholders = filters.models.map((model, index) => {
      const param = `model${index}`;
      params[param] = model;
      return `@${param}`;
    });
    clauses.push(`d.model IN (${placeholders.join(", ")})`);
  }

  if (filters.dateRange?.from !== undefined) {
    params.dateFrom = filters.dateRange.from;
    clauses.push("COALESCE(d.updated_at, d.created_at, 0) >= @dateFrom");
  }
  if (filters.dateRange?.to !== undefined) {
    params.dateTo = filters.dateRange.to;
    clauses.push("COALESCE(d.updated_at, d.created_at, 0) <= @dateTo");
  }

  if (filters.directoryIds?.length) {
    clauses.push(buildJsonArrayPredicate(filters.directoryIds, "directoryId", params));
  }
  if (filters.directoryPaths?.length) {
    const pathPredicates = filters.directoryPaths.flatMap((directoryPath, index) => {
      const pathParam = `directoryPath${index}`;
      const worktreePathParam = `worktreePath${index}`;
      params[pathParam] = directoryPath;
      params[worktreePathParam] = directoryPath;
      return [
        `json_extract(value, '$.path') = @${pathParam}`,
        `json_extract(value, '$.worktreePath') = @${worktreePathParam}`,
      ];
    });
    clauses.push(
      `EXISTS (
        SELECT 1
          FROM json_each(d.linked_directories_json)
         WHERE ` + pathPredicates.join(" OR ") + `
      )`,
    );
  }

  return {
    params,
    sql: clauses.map((clause) => ` AND ${clause}`).join(""),
  };
}

function buildJsonArrayPredicate(
  values: string[],
  paramPrefix: string,
  params: Record<string, unknown>,
): string {
  const predicates = values.map((value, index) => {
    const param = `${paramPrefix}${index}`;
    params[param] = value;
    return `json_extract(value, '$.id') = @${param}`;
  });
  return `EXISTS (
    SELECT 1
      FROM json_each(d.linked_directories_json)
     WHERE ` + predicates.join(" OR ") + `
  )`;
}

function parseLinkedDirectories(value: string): LinkedDirectorySummary[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as LinkedDirectorySummary[]) : [];
  } catch {
    return [];
  }
}
