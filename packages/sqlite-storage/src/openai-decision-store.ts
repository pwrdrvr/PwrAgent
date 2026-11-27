import {
  isRegisteredDecisionProvider,
  type OpenAIDecisionInputSchema,
  type OpenAIDecisionQuestion,
  type OpenAIDecisionScope,
  type RegisteredDecisionProvider,
} from "@pwragent/shared/openai-decisions";
import type { StateDb } from "./state-db.js";

export type OpenAIDecisionVersionStatus = "active" | "superseded" | "deleted";

export type OpenAIDecisionVersionRecord = {
  decisionId: string;
  version: number;
  name: string;
  scope: OpenAIDecisionScope;
  ownerBackend: string;
  /** Required for thread scope; optional registering thread for research_run; undefined for profile scope. */
  ownerThreadId?: string;
  /** Required for research_run scope; undefined for profile and thread scopes. */
  researchRunId?: string;
  status: OpenAIDecisionVersionStatus;
  provider: RegisteredDecisionProvider;
  questions: OpenAIDecisionQuestion[];
  prefix?: string;
  inputSchema: OpenAIDecisionInputSchema;
  promptCacheKey: string;
  createdAt: number;
};

export type OpenAIDecisionCaller = {
  backend: string;
  threadId: string;
  /** Research run IDs visible to this caller, ordered newest/most-relevant first. */
  researchRunIds?: readonly string[];
};

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
  /** The caller's own thread-scope definition first, then research_run, then profile. */
  findActiveByName(name: string, caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[];
  listVisible(caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[];
  /** Active research_run-scope decisions for one run, by name. */
  listActiveForResearchRun?(researchRunId: string): OpenAIDecisionVersionRecord[];
  /** Every active profile-scope decision, by name: the ones no thread owns. */
  listActiveProfile(): OpenAIDecisionVersionRecord[];
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
  research_run_id: string | null;
  status: OpenAIDecisionVersionStatus;
  provider: string;
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
    const runIds = caller.researchRunIds ?? [];
    const rows = this.stateDb.raw.prepare(
      `SELECT * FROM openai_decision_versions
        WHERE name = @name AND status = 'active' AND (
          scope = 'profile'
          OR (scope = 'thread' AND owner_backend = @backend AND owner_thread_id = @threadId)
          OR (scope = 'research_run' AND research_run_id IN (SELECT value FROM json_each(@researchRunIds)))
        )`,
    ).all({
      name,
      backend: caller.backend,
      threadId: caller.threadId,
      researchRunIds: JSON.stringify(runIds),
    }) as Row[];
    return sortVisibleRecords(rows.map(fromRow), runIds, false);
  }

  listVisible(caller: OpenAIDecisionCaller): OpenAIDecisionVersionRecord[] {
    const runIds = caller.researchRunIds ?? [];
    const rows = this.stateDb.raw.prepare(
      `SELECT * FROM openai_decision_versions
        WHERE status = 'active' AND (
          scope = 'profile'
          OR (scope = 'thread' AND owner_backend = @backend AND owner_thread_id = @threadId)
          OR (scope = 'research_run' AND research_run_id IN (SELECT value FROM json_each(@researchRunIds)))
        )`,
    ).all({
      backend: caller.backend,
      threadId: caller.threadId,
      researchRunIds: JSON.stringify(runIds),
    }) as Row[];
    return sortVisibleRecords(rows.map(fromRow), runIds, true);
  }

  listActiveForResearchRun(researchRunId: string): OpenAIDecisionVersionRecord[] {
    const rows = this.stateDb.raw.prepare(
      `SELECT * FROM openai_decision_versions
        WHERE status = 'active' AND scope = 'research_run' AND research_run_id = ?
        ORDER BY name`,
    ).all(researchRunId) as Row[];
    return rows.map(fromRow);
  }

  listActiveProfile(): OpenAIDecisionVersionRecord[] {
    const rows = this.stateDb.raw.prepare(
      `SELECT * FROM openai_decision_versions
        WHERE status = 'active' AND scope = 'profile'
        ORDER BY name`,
    ).all() as Row[];
    return rows.map(fromRow);
  }

  hasDeletedName(name: string, caller: OpenAIDecisionCaller): boolean {
    const runIds = caller.researchRunIds ?? [];
    return this.stateDb.raw.prepare(
      `SELECT 1 FROM openai_decision_versions
        WHERE name = @name AND status = 'deleted' AND (
          scope = 'profile'
          OR (scope = 'thread' AND owner_backend = @backend AND owner_thread_id = @threadId)
          OR (scope = 'research_run' AND research_run_id IN (SELECT value FROM json_each(@researchRunIds)))
        )
        LIMIT 1`,
    ).get({
      name,
      backend: caller.backend,
      threadId: caller.threadId,
      researchRunIds: JSON.stringify(runIds),
    }) !== undefined;
  }

  private insertRow(record: OpenAIDecisionVersionRecord): void {
    this.stateDb.raw.prepare(
      `INSERT INTO openai_decision_versions (
        decision_id, version, name, scope, owner_backend, owner_thread_id, research_run_id, status, provider,
        questions_json, prefix_text, input_schema_json, prompt_cache_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.decisionId,
      record.version,
      record.name,
      record.scope,
      record.ownerBackend,
      record.scope === "profile" ? null : record.ownerThreadId ?? null,
      record.scope === "research_run" ? record.researchRunId ?? null : null,
      record.status,
      record.provider,
      JSON.stringify(record.questions),
      record.prefix ?? null,
      JSON.stringify(record.inputSchema),
      record.promptCacheKey,
      record.createdAt,
    );
  }
}

function scopePrecedence(scope: OpenAIDecisionScope): number {
  switch (scope) {
    case "thread": return 0;
    case "research_run": return 1;
    case "profile": return 2;
  }
}

function sortVisibleRecords(
  records: OpenAIDecisionVersionRecord[],
  runIds: readonly string[],
  byNameFirst: boolean,
): OpenAIDecisionVersionRecord[] {
  const runOrder = new Map(runIds.map((id, index) => [id, index]));
  return records.sort((left, right) => {
    if (byNameFirst && left.name !== right.name) return left.name < right.name ? -1 : 1;
    const scopeDelta = scopePrecedence(left.scope) - scopePrecedence(right.scope);
    if (scopeDelta !== 0) return scopeDelta;
    if (left.scope === "research_run" && right.scope === "research_run") {
      const leftIndex = runOrder.get(left.researchRunId ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = runOrder.get(right.researchRunId ?? "") ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
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
    ...(row.research_run_id ? { researchRunId: row.research_run_id } : {}),
    status: row.status,
    provider: isRegisteredDecisionProvider(row.provider) ? row.provider : "openai",
    questions: JSON.parse(row.questions_json) as OpenAIDecisionQuestion[],
    ...(row.prefix_text !== null ? { prefix: row.prefix_text } : {}),
    inputSchema: JSON.parse(row.input_schema_json) as OpenAIDecisionInputSchema,
    promptCacheKey: row.prompt_cache_key,
    createdAt: row.created_at,
  };
}
