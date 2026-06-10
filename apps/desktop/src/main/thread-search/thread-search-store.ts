import type BetterSqlite3 from "better-sqlite3";
import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type LinkedDirectorySummary,
  type ThreadSearchResult,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";
import { buildThreadSearchFtsQuery } from "./thread-search-fts-query";

export type ThreadSearchProjectionSearchRequest = {
  query?: string;
  backend?: AppServerBackendKind;
  includeArchived?: boolean;
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
             directory_paths, git_branch, git_origin_url, model, backend
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  search(request: ThreadSearchProjectionSearchRequest): ThreadSearchResult[] {
    const ftsQuery = buildThreadSearchFtsQuery(request.query);
    const backendClause = request.backend ? " AND d.backend = @backend" : "";
    const archivedClause = request.includeArchived ? "" : " AND d.archived_at IS NULL";

    if (!ftsQuery) {
      return this.db
        .prepare(
          `SELECT d.*
             FROM thread_search_documents d
            WHERE 1 = 1${backendClause}${archivedClause}
            ORDER BY COALESCE(d.updated_at, d.created_at, 0) DESC
            LIMIT @limit`,
        )
        .all({
          backend: request.backend,
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
          WHERE thread_search_fts MATCH @query${backendClause}${archivedClause}
          ORDER BY rank_value ASC, COALESCE(d.updated_at, d.created_at, 0) DESC
          LIMIT @limit`,
      )
      .all({
        backend: request.backend,
        limit: request.limit,
        query: ftsQuery,
      })
      .map((row) => {
        const ftsRow = row as ThreadSearchFtsRow;
        return this.rowToResult(
          ftsRow,
          typeof ftsRow.rank_value === "number" ? -ftsRow.rank_value : 0,
          ftsRow.snippet_text,
        );
      });
  }

  private rowToResult(
    row: ThreadSearchDocumentRow,
    score: number,
    snippetText: string | null | undefined,
  ): ThreadSearchResult {
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
      confidence: score > 0 ? "medium" : "low",
      matchReasons: score > 0 ? [{ kind: "summary_match", field: "projection" }] : [],
      snippets: snippetText
        ? [{ scope: "projection", field: "summary", text: snippetText }]
        : [],
    };
  }
}

function parseLinkedDirectories(value: string): LinkedDirectorySummary[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as LinkedDirectorySummary[]) : [];
  } catch {
    return [];
  }
}
