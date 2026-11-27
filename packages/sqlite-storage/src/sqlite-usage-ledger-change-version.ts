import type Database from "better-sqlite3";

const versions = new WeakMap<Database.Database, Map<string, number>>();

type LedgerChange = (backend: string, table: string, id: string, old: boolean, timestamp: number | null) => void;
const observers = new WeakMap<Database.Database, Map<string, Set<LedgerChange>>>();

export function watchThreadSpend(db: Database.Database, threadId: string, changed: LedgerChange): () => void {
  sqliteUsageLedgerVersions(db);
  const threads = observers.get(db) ?? new Map<string, Set<LedgerChange>>();
  observers.set(db, threads);
  const listeners = threads.get(threadId) ?? new Set<LedgerChange>();
  listeners.add(changed);
  threads.set(threadId, listeners);
  return () => {
    listeners.delete(changed);
    if (!listeners.size) threads.delete(threadId);
  };
}

/** The tables a thread's pricing ledger read selects from, and the columns
 * that read filters on. A ledger is every row whose thread or parent thread
 * is the thread read, so these columns name every ledger a row belongs to. */
const LEDGER_TABLES = [
  { table: "thread_usage_lines", columns: ["thread_id", "parent_thread_id"] },
  // Turn rows carry the end time and context ceiling attached to each line.
  { table: "thread_usage_turns", columns: ["thread_id", "parent_thread_id"] },
  { table: "thread_pricing_summaries", columns: ["thread_id"] },
] as const;

/**
 * Per-thread change counters for the pricing ledger tables, kept in memory.
 *
 * TEMP triggers count every row change on this connection, raw SQL included,
 * against both the old and new row's threads, with no persistent rows or WAL
 * writes. A ledger read is current while its thread's counter has not moved.
 * External writers are still detected by data_version at the caller. Counters
 * survive rollback, which invalidates too much and never too little, so
 * callers must not reuse or record a read inside a transaction.
 */
export function sqliteUsageLedgerVersions(
  db: Database.Database,
): ReadonlyMap<string, number> | undefined {
  let byThread = versions.get(db);
  if (!byThread && db.inTransaction) return undefined;
  if (!byThread) {
    const counters = new Map<string, number>();
    byThread = counters;
    db.function(
      "pwragent_usage_ledger_changed",
      { varargs: true },
      (backend: unknown, table: unknown, id: unknown, old: unknown, timestamp: unknown, ...threadIds: unknown[]) => {
        for (const threadId of threadIds) {
          if (typeof threadId === "string") {
            if (typeof id === "string" && typeof table === "string" && typeof backend === "string") {
              for (const listener of observers.get(db)?.get(threadId) ?? []) listener(backend, table, id, old === 1, typeof timestamp === "number" ? timestamp : null);
            }
            counters.set(threadId, (counters.get(threadId) ?? 0) + 1);
          }
        }
        return null;
      },
    );
    for (const { table, columns } of LEDGER_TABLES) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const rows = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
        const id = table === "thread_usage_lines" ? "usage_line_id" : "usage_turn_id";
        const calls = rows.map((row) => {
          let key = table === "thread_pricing_summaries" ? "NULL" : `${row}.${id}`;
          if (table === "thread_usage_turns" && operation === "UPDATE") {
            // Only the attached start time orders historical gap estimates.
            key = `CASE WHEN OLD.started_at IS NOT NEW.started_at OR OLD.usage_turn_id IS NOT NEW.usage_turn_id
              OR OLD.backend IS NOT NEW.backend OR OLD.thread_id IS NOT NEW.thread_id
              OR OLD.parent_thread_id IS NOT NEW.parent_thread_id THEN ${key} END`;
          }
          const timestamp = table === "thread_usage_lines" ? `${row}.created_at`
            : table === "thread_usage_turns" ? `${row}.started_at` : "NULL";
          const threadIds = columns.map((column) => `${row}.${column}`);
          return `SELECT pwragent_usage_ledger_changed(${row}.backend, '${table}', ${key}, ${row === "OLD" ? 1 : 0}, ${timestamp}, ${threadIds.join(", ")});`;
        });
        db.exec(`CREATE TEMP TRIGGER pwragent_usage_ledger_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON main.${table}
          BEGIN ${calls.join(" ")} END`);
      }
    }
    versions.set(db, byThread);
  }
  return byThread;
}
