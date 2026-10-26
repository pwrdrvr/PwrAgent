import type BetterSqlite3 from "better-sqlite3";

/**
 * The one-time move of one array out of `threads.payload` into its own table.
 *
 * The table's capture triggers do the moving: any write of a payload that
 * still holds the array copies it into the table and removes it from the
 * payload, inside the writer's own transaction. A no-op payload update fires
 * them, so the lazy move of one row, the sliced background sweep, and an older
 * build's whole-payload write all take the same path. The meta marker records
 * that the sweep has visited every row, so later launches do no scanning.
 */
export class LegacyPayloadArrayMove {
  private moved: boolean | undefined;
  private readonly path: string;
  private readonly needle: string;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly meta: { get(key: string): string | undefined; set(key: string, value: string): void },
    field: string,
    private readonly markerKey: string,
  ) {
    this.path = `$.${field}`;
    this.needle = JSON.stringify(field);
  }

  /** True once no legacy payload array can remain, apart from an older writer's (which the triggers capture). */
  isComplete(): boolean {
    this.moved ??= this.meta.get(this.markerKey) === "1";
    return this.moved;
  }

  /** Move one thread's legacy array, if it still has one. */
  moveRow(storageKey: string): void {
    if (this.isComplete()) return;
    // Read first, so a row with nothing to move costs no write lock or commit.
    const legacy = this.db.prepare(`SELECT 1 FROM threads WHERE thread_id = ?
      AND CASE WHEN json_valid(payload) THEN json_type(payload, ?) = 'array' ELSE 0 END`).get(storageKey, this.path);
    if (!legacy) return;
    this.db.prepare("UPDATE threads SET payload = payload WHERE thread_id = ?").run(storageKey);
  }

  /**
   * One bounded slice of the one-time move, in one immediate transaction: the
   * next threads by rowid until about `byteBudget` payload bytes (always at
   * least one row). `octet_length` reads the stored size without loading the
   * payload. Returns the cursor for the next slice, or `undefined` once every
   * row has been visited and the marker is set.
   */
  moveSlice(afterRowid: number, byteBudget: number): number | undefined {
    if (this.isComplete()) return undefined;
    return this.db.transaction(() => {
      const candidates = this.db.prepare(`SELECT rowid AS id, thread_id, octet_length(payload) AS bytes
        FROM threads WHERE rowid > ? ORDER BY rowid LIMIT 500`).all(afterRowid) as Array<{
        id: number; thread_id: string; bytes: number;
      }>;
      if (candidates.length === 0) {
        this.meta.set(this.markerKey, "1");
        this.moved = true;
        return undefined;
      }
      const move = this.db.prepare(`UPDATE threads SET payload = payload WHERE thread_id = ?
        AND instr(payload, ?) > 0
        AND CASE WHEN json_valid(payload) THEN json_type(payload, ?) = 'array' ELSE 0 END`);
      let bytes = 0;
      let last = afterRowid;
      for (const row of candidates) {
        if (last !== afterRowid && bytes + row.bytes > byteBudget) break;
        move.run(row.thread_id, this.needle, this.path);
        bytes += row.bytes;
        last = row.id;
      }
      return last;
    }).immediate();
  }
}
