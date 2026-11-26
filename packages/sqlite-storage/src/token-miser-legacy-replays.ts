import type BetterSqlite3 from "better-sqlite3";

type Invocation = { observed_at: number; invocation_id: string; item_id: string };
type Gate = { turnId: string; toolUseId: string };

// The legacy array starts in SQLite's descending binary order. The stable
// locale sort retains that order when two distinct ids collate equally.
function compareInvocationIds(left: string, right: string): number {
  if (left === right) return 0;
  return left.localeCompare(right) || Buffer.compare(Buffer.from(right), Buffer.from(left));
}

/** Stream only the turns and columns used by the legacy replay calculation. */
export function readTokenMiserLegacyReplayCounts(
  db: BetterSqlite3.Database,
  params: { backend: string; threadId: string; gates: readonly Gate[] },
): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const { turnId, toolUseId } of params.gates) {
    // The accounting row decoder treats an empty turn id as absent.
    if (!turnId) continue;
    const turn = counts.get(turnId) ?? new Map<string, number>();
    turn.set(toolUseId, 0);
    counts.set(turnId, turn);
  }
  const invocations = db.prepare(`SELECT observed_at, invocation_id, item_id
    FROM thread_tool_invocations WHERE backend = ? AND thread_id = ? AND turn_id = ?
    ORDER BY observed_at ASC`);
  const tied = db.prepare(`SELECT invocation_id FROM thread_tool_invocations
    WHERE backend = ? AND thread_id = ? AND turn_id = ? AND observed_at = ?`);
  // Both passes see the same read snapshot, even when another profile
  // process writes while the cursor is open.
  return db.transaction(() => {
    for (const [turnId, targets] of counts) {
      const first = new Map<string, Invocation>();
      const endPosition = new Map<number, number>();
      let length = 0;
      for (const row of invocations.iterate(params.backend, params.threadId, turnId) as Iterable<Invocation>) {
        length += 1;
        if (targets.has(row.item_id)) {
          const match = first.get(row.item_id);
          if (!match || (row.observed_at === match.observed_at
            && compareInvocationIds(row.invocation_id, match.invocation_id) < 0)) {
            first.set(row.item_id, row);
            endPosition.set(row.observed_at, length);
          }
        }
        if (endPosition.has(row.observed_at)) endPosition.set(row.observed_at, length);
      }
      for (const [itemId, match] of first) {
        let after = length - endPosition.get(match.observed_at)!;
        for (const row of tied.iterate(params.backend, params.threadId, turnId, match.observed_at) as Iterable<Pick<Invocation, "invocation_id">>) {
          if (compareInvocationIds(row.invocation_id, match.invocation_id) > 0) after += 1;
        }
        // The first later invocation received the result uncached.
        targets.set(itemId, Math.max(0, after - 1));
      }
    }
    return counts;
  })();
}
