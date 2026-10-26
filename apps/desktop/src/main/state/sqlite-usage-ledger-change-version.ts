import type Database from "better-sqlite3";

const versions = new WeakMap<Database.Database, Map<string, number>>();

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
      (...threadIds: unknown[]) => {
        for (const threadId of threadIds) {
          if (typeof threadId === "string") {
            counters.set(threadId, (counters.get(threadId) ?? 0) + 1);
          }
        }
        return null;
      },
    );
    for (const { table, columns } of LEDGER_TABLES) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const rows = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
        const threadIds = rows.flatMap((row) => columns.map((column) => `${row}.${column}`));
        db.exec(`CREATE TEMP TRIGGER pwragent_usage_ledger_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON main.${table}
          BEGIN SELECT pwragent_usage_ledger_changed(${threadIds.join(", ")}); END`);
      }
    }
    versions.set(db, byThread);
  }
  return byThread;
}
