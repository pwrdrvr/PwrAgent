import type Database from "better-sqlite3";

const idColumns = {
  thread_sub_agents: "monitor_id",
  token_miser_objects: "object_id",
  token_miser_observations: "observation_id",
} as const;
type Table = keyof typeof idColumns;
type Listeners = Map<string, Set<(id: string) => void>>;
const databases = new WeakMap<Database.Database, Map<Table, Listeners>>();

/** TEMP triggers include raw SQL writes and both sides of a move. A hint
 * survives rollback; the open page always rereads the committed row. */
export function watchPricingRows(db: Database.Database, table: Table, key: string, changed: (id: string) => void): () => void {
  const tables = databases.get(db) ?? new Map<Table, Listeners>();
  databases.set(db, tables);
  const threads = tables.get(table) ?? new Map<string, Set<(id: string) => void>>();
  if (!tables.has(table)) {
    const fn = "pwragent_pricing_" + table;
    const column = idColumns[table];
    db.function(fn, (thread: string, id: string) => {
      for (const notify of threads.get(thread) ?? []) notify(id);
      return null;
    });
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const rows = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
      const calls = rows.map((row) => `SELECT ${fn}(${row}.thread_id, ${row}.${column});`);
      db.exec(`CREATE TEMP TRIGGER ${fn}_${operation.toLowerCase()} AFTER ${operation} ON main.${table}
        BEGIN ${calls.join(" ")} END`);
    }
    tables.set(table, threads);
  }
  const listeners = threads.get(key) ?? new Set();
  threads.set(key, listeners);
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (!listeners.size) threads.delete(key);
  };
}
