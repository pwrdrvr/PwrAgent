import type {
  AppServerBackendKind,
  ThreadTodo,
  ThreadTodoAction,
  ThreadTodoKind,
  ThreadTodoStatus,
} from "@pwragent/shared";
import { isThreadTodoStatus } from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";

type ThreadTodoRow = {
  todo_id: string;
  backend: AppServerBackendKind;
  thread_id: string;
  todo_key: string | null;
  kind: ThreadTodoKind;
  status: string;
  title: string;
  detail: string | null;
  action_json: string | null;
  cwd: string | null;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
};

type ThreadTodoResult = Pick<ThreadTodo, "result" | "startedThread">;

const ROW_COLUMNS = `
  todo_id, backend, thread_id, todo_key, kind, status, title, detail,
  action_json, cwd, result_json, error, created_at, updated_at, resolved_at
`;

export type InsertThreadTodoRecord = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  key?: string;
  kind: ThreadTodoKind;
  title: string;
  detail?: string;
  action?: ThreadTodoAction;
  cwd?: string;
  now: number;
};

export type ReplaceThreadTodoContentRecord = {
  id: string;
  kind: ThreadTodoKind;
  title: string;
  detail?: string;
  action?: ThreadTodoAction;
  cwd?: string;
  now: number;
};

/**
 * Each mutation is a single statement in its own implicit transaction: one
 * commit per tool call or operator click. Nothing here runs per turn, per
 * streamed event or on a timer.
 */
export class ThreadTodoStore {
  constructor(private readonly stateDb: StateDb) {}

  insert(record: InsertThreadTodoRecord): ThreadTodo {
    this.stateDb.raw
      .prepare(
        `INSERT INTO thread_todos (
          todo_id, backend, thread_id, todo_key, kind, status, title, detail,
          action_json, cwd, result_json, error, created_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        record.id,
        record.backend,
        record.threadId,
        record.key ?? null,
        record.kind,
        record.title,
        record.detail ?? null,
        record.action ? JSON.stringify(record.action) : null,
        record.cwd ?? null,
        record.now,
        record.now,
      );
    return this.require(record.id);
  }

  /** A re-raised key: new content, same card, previous error cleared. */
  replaceContent(record: ReplaceThreadTodoContentRecord): ThreadTodo {
    this.stateDb.raw
      .prepare(
        `UPDATE thread_todos
            SET kind = ?, title = ?, detail = ?, action_json = ?,
                cwd = COALESCE(?, cwd), error = NULL, updated_at = ?
          WHERE todo_id = ?`,
      )
      .run(
        record.kind,
        record.title,
        record.detail ?? null,
        record.action ? JSON.stringify(record.action) : null,
        record.cwd ?? null,
        record.now,
        record.id,
      );
    return this.require(record.id);
  }

  setStatus(params: {
    id: string;
    status: ThreadTodoStatus;
    now: number;
    result?: ThreadTodoResult;
  }): ThreadTodo {
    const resolvedAt = params.status === "open" ? null : params.now;
    this.stateDb.raw
      .prepare(
        `UPDATE thread_todos
            SET status = ?, resolved_at = ?, updated_at = ?,
                result_json = COALESCE(?, result_json),
                error = CASE WHEN ? = 'open' THEN error ELSE NULL END
          WHERE todo_id = ?`,
      )
      .run(
        params.status,
        resolvedAt,
        params.now,
        params.result ? JSON.stringify(params.result) : null,
        params.status,
        params.id,
      );
    return this.require(params.id);
  }

  setError(params: { id: string; error: string; now: number }): ThreadTodo {
    this.stateDb.raw
      .prepare(
        `UPDATE thread_todos SET error = ?, updated_at = ? WHERE todo_id = ?`,
      )
      .run(params.error, params.now, params.id);
    return this.require(params.id);
  }

  get(id: string): ThreadTodo | undefined {
    const row = this.stateDb.raw
      .prepare(`SELECT ${ROW_COLUMNS} FROM thread_todos WHERE todo_id = ?`)
      .get(id) as ThreadTodoRow | undefined;
    return row ? rowToThreadTodo(row) : undefined;
  }

  findOpenByKey(params: {
    backend: AppServerBackendKind;
    threadId: string;
    key: string;
  }): ThreadTodo | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM thread_todos
          WHERE backend = ? AND thread_id = ? AND todo_key = ? AND status = 'open'`,
      )
      .get(params.backend, params.threadId, params.key) as ThreadTodoRow | undefined;
    return row ? rowToThreadTodo(row) : undefined;
  }

  countOpen(params: { backend: AppServerBackendKind; threadId: string }): number {
    const row = this.stateDb.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM thread_todos
          WHERE status = 'open' AND backend = ? AND thread_id = ?`,
      )
      .get(params.backend, params.threadId) as { count: number };
    return row.count;
  }

  list(params: {
    status?: ThreadTodoStatus | "all";
    backend?: AppServerBackendKind;
    threadId?: string;
    limit?: number;
  }): ThreadTodo[] {
    const status = params.status ?? "open";
    const thread = params.backend && params.threadId
      ? { backend: params.backend, threadId: params.threadId }
      : undefined;
    const limit = params.limit ?? 500;
    const rows = (thread
      ? status === "all"
        ? this.stateDb.raw
          .prepare(
            `SELECT ${ROW_COLUMNS} FROM thread_todos
              WHERE backend = ? AND thread_id = ?
              ORDER BY created_at DESC, todo_id DESC LIMIT ?`,
          )
          .all(thread.backend, thread.threadId, limit)
        : this.stateDb.raw
          .prepare(
            `SELECT ${ROW_COLUMNS} FROM thread_todos
              WHERE status = ? AND backend = ? AND thread_id = ?
              ORDER BY created_at DESC, todo_id DESC LIMIT ?`,
          )
          .all(status, thread.backend, thread.threadId, limit)
      : status === "all"
        ? this.stateDb.raw
          .prepare(
            `SELECT ${ROW_COLUMNS} FROM thread_todos
              ORDER BY created_at DESC, todo_id DESC LIMIT ?`,
          )
          .all(limit)
        : this.stateDb.raw
          .prepare(
            `SELECT ${ROW_COLUMNS} FROM thread_todos
              WHERE status = ?
              ORDER BY created_at DESC, todo_id DESC LIMIT ?`,
          )
          .all(status, limit)) as ThreadTodoRow[];
    return rows.map(rowToThreadTodo);
  }

  /** Archiving a thread dismisses its open cards, in one commit. */
  dismissOpenForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    now: number;
  }): number {
    return this.stateDb.raw
      .prepare(
        `UPDATE thread_todos
            SET status = 'dismissed', resolved_at = ?, updated_at = ?
          WHERE status = 'open' AND backend = ? AND thread_id = ?`,
      )
      .run(params.now, params.now, params.backend, params.threadId).changes;
  }

  private require(id: string): ThreadTodo {
    const todo = this.get(id);
    if (!todo) {
      throw new Error(`Thread to-do ${id} does not exist.`);
    }
    return todo;
  }
}

function rowToThreadTodo(row: ThreadTodoRow): ThreadTodo {
  const result = parseJson<ThreadTodoResult>(row.result_json);
  const action = parseJson<ThreadTodoAction>(row.action_json);
  return {
    id: row.todo_id,
    backend: row.backend,
    threadId: row.thread_id,
    ...(row.todo_key ? { key: row.todo_key } : {}),
    kind: row.kind,
    status: isThreadTodoStatus(row.status) ? row.status : "open",
    title: row.title,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(action ? { action } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(result?.result ? { result: result.result } : {}),
    ...(result?.startedThread ? { startedThread: result.startedThread } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
