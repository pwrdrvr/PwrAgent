import type BetterSqlite3 from "better-sqlite3";
import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type LinkedDirectorySummary,
  type ThreadSearchFilters,
  type ThreadSearchResult,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";
import { buildThreadSearchFtsQuery } from "./thread-search-fts-query";

export type ThreadSearchProjectionSearchRequest = {
  query?: string;
  backend?: AppServerBackendKind;
  includeArchived?: boolean;
  filters?: ThreadSearchFilters;
  limit: number;
};

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

export class ThreadSearchStore {
  private readonly db: BetterSqlite3.Database;

  constructor(stateDb: StateDb) {
    this.db = stateDb.raw;
  }

  upsertThread(thread: AppServerThreadSummary, indexedAt = Date.now()): void {
    const identityKey = buildThreadIdentityKey(thread.source, thread.id);
    const directoryLabels = thread.linkedDirectories
      .map((directory) => directory.label)
      .join(" ");
    const directoryPaths = thread.linkedDirectories
      .flatMap((directory) => [directory.path, directory.worktreePath].filter(Boolean))
      .join(" ");
    const displayJson = JSON.stringify({
      source: thread.source,
      serviceTier: thread.serviceTier,
      reasoningEffort: thread.reasoningEffort,
    });
    const linkedDirectoriesJson = JSON.stringify(thread.linkedDirectories);

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO thread_search_documents (
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
             indexed_at = excluded.indexed_at`,
        )
        .run({
          identityKey,
          backend: thread.source,
          threadId: thread.id,
          title: thread.title,
          titleSource: thread.titleSource,
          summary: thread.summary ?? null,
          projectKey: thread.projectKey ?? null,
          createdAt: thread.createdAt ?? null,
          updatedAt: thread.updatedAt ?? null,
          archivedAt: thread.archivedAt ?? null,
          gitBranch: thread.gitBranch ?? null,
          gitOriginUrl: thread.gitOriginUrl ?? null,
          model: thread.model ?? null,
          linkedDirectoriesJson,
          displayJson,
          indexedAt,
        });
      this.db
        .prepare("DELETE FROM thread_search_fts WHERE identity_key = ?")
        .run(identityKey);
      this.db
        .prepare(
          `INSERT INTO thread_search_fts (
             identity_key, title, summary, project_key, directory_labels,
             directory_paths, git_branch, git_origin_url, model, backend,
             thread_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identityKey,
          thread.title,
          thread.summary ?? "",
          thread.projectKey ?? "",
          directoryLabels,
          directoryPaths,
          thread.gitBranch ?? "",
          thread.gitOriginUrl ?? "",
          thread.model ?? "",
          thread.source,
          thread.id,
        );
    });

    transaction();
  }

  deleteThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void {
    const identityKey = buildThreadIdentityKey(params.backend, params.threadId);
    const transaction = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM thread_search_fts WHERE identity_key = ?")
        .run(identityKey);
      this.db
        .prepare("DELETE FROM thread_search_documents WHERE identity_key = ?")
        .run(identityKey);
    });
    transaction();
  }

  pruneMissingThreads(params: {
    backend?: AppServerBackendKind;
    includeArchived: boolean;
    retainedIdentityKeys: string[];
  }): void {
    const retained = new Set(params.retainedIdentityKeys);
    const rows = this.db
      .prepare(
        `SELECT identity_key, backend, thread_id, archived_at
           FROM thread_search_documents
          WHERE 1 = 1${params.backend ? " AND backend = @backend" : ""}`,
      )
      .all({ backend: params.backend }) as Array<{
      identity_key: string;
      backend: AppServerBackendKind;
      thread_id: string;
      archived_at: number | null;
    }>;

    for (const row of rows) {
      if (retained.has(row.identity_key)) {
        continue;
      }
      if (!params.includeArchived && row.archived_at !== null) {
        continue;
      }
      this.deleteThread({
        backend: row.backend,
        threadId: row.thread_id,
      });
    }
  }

  search(request: ThreadSearchProjectionSearchRequest): ThreadSearchResult[] {
    const ftsQuery = buildThreadSearchFtsQuery(request.query);
    const backendClause = request.backend ? " AND d.backend = @backend" : "";
    const archivedClause = request.includeArchived ? "" : " AND d.archived_at IS NULL";
    const filterWhere = buildFilterWhereClause(request.filters);

    if (!ftsQuery) {
      return this.db
        .prepare(
          `SELECT d.*
             FROM thread_search_documents d
            WHERE 1 = 1${backendClause}${archivedClause}${filterWhere.sql}
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

    return this.db
      .prepare(
        `SELECT d.*,
                bm25(thread_search_fts) AS rank_value,
                snippet(thread_search_fts, 1, '', '', '...', 16) AS snippet_text
           FROM thread_search_fts
           JOIN thread_search_documents d
             ON d.identity_key = thread_search_fts.identity_key
          WHERE thread_search_fts MATCH @query${backendClause}${archivedClause}${filterWhere.sql}
          ORDER BY rank_value ASC, COALESCE(d.updated_at, d.created_at, 0) DESC
          LIMIT @limit`,
      )
      .all({
        backend: request.backend,
        ...filterWhere.params,
        limit: request.limit,
        query: ftsQuery,
      })
      .map((row) => {
        const ftsRow = row as ThreadSearchFtsRow;
        return this.rowToResult(
          ftsRow,
          typeof ftsRow.rank_value === "number" ? -ftsRow.rank_value : 0,
          ftsRow.snippet_text,
          request.query,
        );
      });
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
      identityKey: row.identity_key,
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
      confidence: threadIdMatch ? "high" : score > 0 ? "medium" : "low",
      matchReasons:
        score > 0
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
         WHERE ${pathPredicates.join(" OR ")}
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
     WHERE ${predicates.join(" OR ")}
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
