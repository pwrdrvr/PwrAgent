import type {
  OpenAIDecisionInputSchema,
  OpenAIDecisionQuestion,
  OpenAIDecisionScope,
} from "@pwragent/shared/openai-decisions";
import type { StateDb } from "./state-db.js";

export type OpenAIDecisionVersionStatus = "active" | "superseded" | "deleted";

export type OpenAIDecisionVersionRecord = {
  decisionId: string;
  version: number;
  name: string;
  scope: OpenAIDecisionScope;
  ownerBackend: string;
  /** Required for thread scope; undefined for profile scope. */
  ownerThreadId?: string;
  status: OpenAIDecisionVersionStatus;
  questions: OpenAIDecisionQuestion[];
  prefix?: string;
  inputSchema: OpenAIDecisionInputSchema;
  promptCacheKey: string;
  createdAt: number;
};

export type OpenAIDecisionCaller = { backend: string; threadId: string };

/** Thrown when an active name already exists in the requested scope. */
export class OpenAIDecisionNameTakenError extends Error {
  constructor(readonly decisionName: string) {
    super(`An active decision named "${decisionName}" already exists in this scope.`);
    this.name = "OpenAIDecisionNameTakenError";
  }
}

/** Thrown when an update targets a decision whose active version moved or was deleted. */
export class OpenAIDecisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIDecisionConflictError";
  }
}

export interface OpenAIDecisionRegistryStorage {
  insertFirstVersion(record: OpenAIDecisionVersionRecord): void;
  /** Supersedes the active version and inserts `record` as active, in one commit. */
  insertNextVersion(record: OpenAIDecisionVersionRecord): void;
  /** Marks every version of the decision deleted. Returns false when none was live. */
  softDelete(decisionId: string): boolean;
  getVersion(decisionId: string, version: number): OpenAIDecisionVersionRecord | undefined;
  getActive(decisionId: string): OpenAIDecisionVersionRecord | undefined;
  /** The caller's own thread-scope definition first, then the profile one. */
  findActiveByName(name: string, caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[];
  listVisible(caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[];
  /** Whether a deleted decision with this name was visible to the caller. */
  hasDeletedName(name: string, caller: OpenAIDecisionCaller): boolean;
}

type Row = {
  decision_id: string;
  version: number;
  name: string;
  scope: OpenAIDecisionScope;
  owner_backend: string;
  owner_thread_id: string | null;
  status: OpenAIDecisionVersionStatus;
  questions_json: string;
  prefix_text: string | null;
  input_schema_json: string;
  prompt_cache_key: string;
  created_at: number;
};

/**
 * Profile-scoped registry of OpenAI Decisions. Each mutation is one commit
 * per tool call. Invoke only reads.
 */
export class OpenAIDecisionStore implements OpenAIDecisionRegistryStorage {
  constructor(private readonly stateDb: StateDb) {}

  insertFirstVersion(record: OpenAIDecisionVersionRecord): void {
    try {
      this.insertRow(record);
    } catch (error) {
      throw translateUniqueViolation(error, record.name);
    }
  }

  insertNextVersion(record: OpenAIDecisionVersionRecord): void {
    const db = this.stateDb.raw;
    db.transaction(() => {
      const current = db.prepare(
        `SELECT version FROM openai_decision_versions
          WHERE decision_id = ? AND status = 'active'`,
      ).get(record.decisionId) as { version: number } | undefined;
      if (!current || current.version !== record.version - 1) {
        throw new OpenAIDecisionConflictError(
          "The decision changed or was deleted while it was being updated.",
        );
      }
      db.prepare(
        `UPDATE openai_decision_versions SET status = 'superseded'
          WHERE decision_id = ? AND version = ?`,
      ).run(record.decisionId, current.version);
      try {
        this.insertRow(record);
      } catch (error) {
        throw translateUniqueViolation(error, record.name);
      }
    }).immediate();
  }

  softDelete(decisionId: string): boolean {
    const result = this.stateDb.raw.prepare(
      `UPDATE openai_decision_versions SET status = 'deleted'
        WHERE decision_id = ? AND status != 'deleted'`,
    ).run(decisionId);
    return result.changes > 0;
  }

  getVersion(decisionId: string, version: number): OpenAIDecisionVersionRecord | undefined {
    const row = this.stateDb.raw.prepare(
      "SELECT * FROM openai_decision_versions WHERE decision_id = ? AND version = ?",
    ).get(decisionId, version) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  getActive(decisionId: string): OpenAIDecisionVersionRecord | undefined {
    const row = this.stateDb.raw.prepare(
      "SELECT * FROM openai_decision_versions WHERE decision_id = ? AND status = 'active'",
    ).get(decisionId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  findActiveByName(name: string, caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[] {
    const rows = this.stateDb.raw.prepare(
      `SELECT * FROM openai_decision_versions
        WHERE name = @name AND status = 'active' AND (
          scope = 'profile'
          OR (scope = 'thread' AND owner_backend = @backend AND owner_thread_id = @threadId)
        )
        ORDER BY CASE scope WHEN 'thread' THEN 0 ELSE 1 END`,
    ).all({ name, backend: caller.backend, threadId: caller.threadId }) as Row[];
    return rows.map(fromRow);
  }

  listVisible(caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[] {
    const rows = this.stateDb.raw.prepare(
      `SELECT * FROM openai_decision_versions
        WHERE status = 'active' AND (
          scope = 'profile'
          OR (scope = 'thread' AND owner_backend = @backend AND owner_thread_id = @threadId)
        )
        ORDER BY name, CASE scope WHEN 'thread' THEN 0 ELSE 1 END`,
    ).all({ backend: caller.backend, threadId: caller.threadId }) as Row[];
    return rows.map(fromRow);
  }

  hasDeletedName(name: string, caller: OpenAIDecisionCaller): boolean {
    return this.stateDb.raw.prepare(
      `SELECT 1 FROM openai_decision_versions
        WHERE name = @name AND status = 'deleted' AND (
          scope = 'profile'
          OR (scope = 'thread' AND owner_backend = @backend AND owner_thread_id = @threadId)
        )
        LIMIT 1`,
    ).get({ name, backend: caller.backend, threadId: caller.threadId }) !== undefined;
  }

  private insertRow(record: OpenAIDecisionVersionRecord): void {
    this.stateDb.raw.prepare(
      `INSERT INTO openai_decision_versions (
        decision_id, version, name, scope, owner_backend, owner_thread_id, status,
        questions_json, prefix_text, input_schema_json, prompt_cache_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.decisionId,
      record.version,
      record.name,
      record.scope,
      record.ownerBackend,
      record.scope === "thread" ? record.ownerThreadId ?? null : null,
      record.status,
      JSON.stringify(record.questions),
      record.prefix ?? null,
      JSON.stringify(record.inputSchema),
      record.promptCacheKey,
      record.createdAt,
    );
  }
}

function translateUniqueViolation(error: unknown, name: string): unknown {
  return error instanceof Error
    && /UNIQUE constraint failed: index 'idx_openai_decision_versions_active_name'/.test(error.message)
    ? new OpenAIDecisionNameTakenError(name)
    : error;
}

function fromRow(row: Row): OpenAIDecisionVersionRecord {
  return {
    decisionId: row.decision_id,
    version: row.version,
    name: row.name,
    scope: row.scope,
    ownerBackend: row.owner_backend,
    ...(row.owner_thread_id ? { ownerThreadId: row.owner_thread_id } : {}),
    status: row.status,
    questions: JSON.parse(row.questions_json) as OpenAIDecisionQuestion[],
    ...(row.prefix_text !== null ? { prefix: row.prefix_text } : {}),
    inputSchema: JSON.parse(row.input_schema_json) as OpenAIDecisionInputSchema,
    promptCacheKey: row.prompt_cache_key,
    createdAt: row.created_at,
  };
}
