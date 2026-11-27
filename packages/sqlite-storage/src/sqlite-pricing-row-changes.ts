import type Database from "better-sqlite3";

const idColumns = {
  thread_sub_agents: "monitor_id",
  token_miser_objects: "object_id",
  token_miser_observations: "observation_id",
} as const;
type Table = keyof typeof idColumns;
type Listener = (id: string, previouslyPresent: boolean) => void;
type Listeners = Map<string, Set<Listener>>;
const databases = new WeakMap<Database.Database, Map<Table, Listeners>>();

/** TEMP triggers include raw SQL writes and both sides of a move. A hint
 * survives rollback; the open page always rereads the committed row. */
export function watchPricingRows(db: Database.Database, table: Table, key: string, changed: Listener): () => void {
  const tables = databases.get(db) ?? new Map<Table, Listeners>();
  databases.set(db, tables);
  const threads = tables.get(table) ?? new Map<string, Set<Listener>>();
  if (!tables.has(table)) {
    const fn = "pwragent_pricing_" + table;
    const column = idColumns[table];
    db.function(fn, (thread: string, id: string, present: number) => {
      for (const notify of threads.get(thread) ?? []) notify(id, Boolean(present));
      return null;
    });
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const rows = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
      const calls = rows.map((row) => `SELECT ${fn}(${row}.thread_id, ${row}.${column}, ${row === "OLD" ? 1 : 0});`);
      const membership = table === "token_miser_observations";
      if (membership && operation !== "DELETE") {
        // INSERT OR REPLACE can silently displace an existing id in another
        // thread. Report its actual owner first, while the old row still exists.
        calls.unshift(`SELECT pwragent_pricing_token_miser_observations(thread_id, observation_id, 1)
          FROM token_miser_observations WHERE observation_id = NEW.observation_id;`);
      }
      db.exec(`CREATE TEMP TRIGGER ${fn}_${operation.toLowerCase()} ${membership ? "BEFORE" : "AFTER"} ${operation} ON main.${table}
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
