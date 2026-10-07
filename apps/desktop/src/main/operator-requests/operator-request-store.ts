import type {
  AppServerBackendKind,
  CodexAsyncQuestion,
  OperatorAsyncQuestion,
} from "@pwragent/shared";
import { normalizeCodexAsyncQuestions } from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";

type AsyncQuestionRow = {
  backend: AppServerBackendKind;
  thread_id: string;
  message_id: string;
  questions_json: string;
  created_at: number;
};

export type AsyncQuestionStatus = "open" | "answered" | "dismissed";

/** Resolved questions and seen marks older than this are pruned at start. */
export const OPERATOR_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * An open question is a pending operator request, the same class of record as
 * a pending approval, so its text is kept while it is open. Closing it blanks
 * the text: a closed row keeps only the identity and times, never history.
 *
 * Each mutation is one implicit transaction, except a batch of seen marks,
 * which is one explicit transaction: one commit per question that arrives,
 * per reply or dismissal, and per batch of items that came on screen.
 */
export class OperatorRequestStore {
  constructor(private readonly stateDb: StateDb) {}

  /** Records an open question. A message already recorded keeps its row. */
  insertQuestion(record: {
    backend: AppServerBackendKind;
    threadId: string;
    messageId: string;
    questions: CodexAsyncQuestion[];
    now: number;
  }): boolean {
    const result = this.stateDb.raw
      .prepare(
        `INSERT OR IGNORE INTO operator_async_questions (
          backend, thread_id, message_id, questions_json, status, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, 'open', ?, NULL)`,
      )
      .run(
        record.backend,
        record.threadId,
        record.messageId,
        JSON.stringify(record.questions),
        record.now,
      );
    return result.changes > 0;
  }

  /** Closes open questions on one thread; true when a row changed. */
  resolveQuestions(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageIds: readonly string[];
    status: Exclude<AsyncQuestionStatus, "open">;
    now: number;
  }): boolean {
    if (params.messageIds.length === 0) return false;
    const placeholders = params.messageIds.map(() => "?").join(", ");
    const result = this.stateDb.raw
      .prepare(
        `UPDATE operator_async_questions
          SET status = ?, resolved_at = ?, questions_json = '[]'
          WHERE backend = ? AND thread_id = ? AND status = 'open'
            AND message_id IN (${placeholders})`,
      )
      .run(params.status, params.now, params.backend, params.threadId, ...params.messageIds);
    return result.changes > 0;
  }

  /** Closes every open question on a thread, as when it is archived. */
  dismissQuestionsForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    now: number;
  }): boolean {
    const result = this.stateDb.raw
      .prepare(
        `UPDATE operator_async_questions
          SET status = 'dismissed', resolved_at = ?, questions_json = '[]'
          WHERE backend = ? AND thread_id = ? AND status = 'open'`,
      )
      .run(params.now, params.backend, params.threadId);
    return result.changes > 0;
  }

  listOpenQuestions(): OperatorAsyncQuestion[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT backend, thread_id, message_id, questions_json, created_at
          FROM operator_async_questions
          WHERE status = 'open'
          ORDER BY created_at DESC`,
      )
      .all() as AsyncQuestionRow[];
    return rows.flatMap((row) => {
      const questions = parseQuestions(row.questions_json);
      return questions
        ? [{
            backend: row.backend,
            threadId: row.thread_id,
            messageId: row.message_id,
            questions,
            createdAt: row.created_at,
          }]
        : [];
    });
  }

  listSeenKeys(): string[] {
    return (
      this.stateDb.raw
        .prepare("SELECT item_key FROM operator_seen_items")
        .all() as Array<{ item_key: string }>
    ).map((row) => row.item_key);
  }

  /** Marks items seen in one commit; returns how many were new. */
  markSeen(keys: readonly string[], now: number): number {
    if (keys.length === 0) return 0;
    const insert = this.stateDb.raw.prepare(
      "INSERT OR IGNORE INTO operator_seen_items (item_key, seen_at) VALUES (?, ?)",
    );
    return this.stateDb.raw.transaction(() => {
      let added = 0;
      for (const key of keys) {
        added += insert.run(key, now).changes;
      }
      return added;
    })();
  }

  /**
   * Drops resolved questions and seen marks past retention. A seen mark
   * outlives its item by design: the item list never names closed items, so
   * an old mark for a closed one is harmless until it ages out.
   */
  prune(now: number): void {
    const cutoff = now - OPERATOR_REQUEST_RETENTION_MS;
    const stale = this.stateDb.raw
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM operator_async_questions
            WHERE status != 'open' AND resolved_at < ?) AS questions,
          (SELECT COUNT(*) FROM operator_seen_items WHERE seen_at < ?) AS seen`,
      )
      .get(cutoff, cutoff) as { questions: number; seen: number };
    // A clean start writes nothing.
    if (stale.questions === 0 && stale.seen === 0) return;
    this.stateDb.raw.transaction(() => {
      this.stateDb.raw
        .prepare(
          "DELETE FROM operator_async_questions WHERE status != 'open' AND resolved_at < ?",
        )
        .run(cutoff);
      this.stateDb.raw
        .prepare("DELETE FROM operator_seen_items WHERE seen_at < ?")
        .run(cutoff);
    })();
  }
}

function parseQuestions(json: string): CodexAsyncQuestion[] | undefined {
  try {
    return normalizeCodexAsyncQuestions(JSON.parse(json));
  } catch {
    return undefined;
  }
}
