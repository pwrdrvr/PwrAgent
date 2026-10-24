import type { AppServerThreadEntry } from "@pwragent/shared";

/**
 * Inserts PwrAgent-owned rows (permission and channel transitions,
 * questionnaires, turn failures) into an already-ordered transcript.
 *
 * The transcript's array order is the owner's order and is never changed
 * here. Its timestamps come from different clocks: Codex stamps a final
 * message with its second-truncated turn completion, the renderer stamps a
 * turn total when it mints it, a live read can carry a receipt time forward,
 * and commentary and tool rows often carry no time at all. Sorting the whole
 * list by those values moved a turn total above the reply it follows, and the
 * order flipped whenever a re-read changed one timestamp.
 *
 * Each synthetic row goes before the first timed entry that is strictly
 * later than it, so on a tie it follows the existing entry. A synthetic row
 * with no later entry, or with no timestamp, goes last.
 */
export function insertSyntheticEntriesByTime(
  entries: AppServerThreadEntry[],
  synthetic: AppServerThreadEntry[],
): AppServerThreadEntry[] {
  if (synthetic.length === 0) {
    return entries;
  }
  const timed = synthetic
    .filter((entry) => typeof entry.createdAt === "number")
    .sort((left, right) => left.createdAt! - right.createdAt!);
  const untimed = synthetic.filter((entry) => typeof entry.createdAt !== "number");
  const merged: AppServerThreadEntry[] = [];
  let next = 0;
  for (const entry of entries) {
    const createdAt = entry.createdAt;
    if (typeof createdAt === "number") {
      while (next < timed.length && timed[next]!.createdAt! < createdAt) {
        merged.push(timed[next]!);
        next += 1;
      }
    }
    merged.push(entry);
  }
  for (; next < timed.length; next += 1) {
    merged.push(timed[next]!);
  }
  merged.push(...untimed);
  return merged;
}
