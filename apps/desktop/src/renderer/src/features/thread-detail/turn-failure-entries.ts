import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  ThreadTurnFailure,
} from "@pwragent/shared";

/**
 * Synthetic activity entries built from `turnFailureLog` reuse the
 * `turn-failed:` id prefix the transcript already recognizes as a
 * terminal failure (see `isTerminalTurnFailureActivity`), so they render
 * with the warning treatment without any new render branch. The prefix
 * also lets us dedupe against backends (e.g. ACP) that persist their own
 * failure entry under the same id.
 */
export const TURN_FAILURE_ENTRY_PREFIX = "turn-failed:";

export function buildTurnFailureActivityEntries(
  failures: ThreadTurnFailure[] | undefined,
): AppServerThreadActivityEntry[] {
  if (!failures || failures.length === 0) {
    return [];
  }
  return failures.map((failure) => ({
    type: "activity",
    id: `${TURN_FAILURE_ENTRY_PREFIX}${failure.turnId}`,
    summary: "Turn failed",
    createdAt: failure.occurredAt,
    tone: "warning",
    status: "failed",
    turn: {
      id: failure.turnId,
      status: "failed",
      completedAt: failure.occurredAt,
    },
    details: [
      {
        id: `${TURN_FAILURE_ENTRY_PREFIX}${failure.turnId}:detail`,
        kind: "read",
        label: failure.error,
        status: "failed",
      },
    ],
  }));
}

/**
 * Splice synthetic turn-failure activity entries into the transcript,
 * ordered by `createdAt` / `occurredAt` so the failure marker lands at the
 * moment the turn failed. Entries whose id already exists in the
 * transcript (a backend that emits its own failure entry) are skipped so a
 * failure is never rendered twice.
 */
export function injectTurnFailures(
  entries: AppServerThreadEntry[],
  failures: ThreadTurnFailure[] | undefined,
): AppServerThreadEntry[] {
  const synthetic = buildTurnFailureActivityEntries(failures);
  if (synthetic.length === 0) {
    return entries;
  }
  const existingIds = new Set(entries.map((entry) => entry.id));
  const additions = synthetic.filter((entry) => !existingIds.has(entry.id));
  if (additions.length === 0) {
    return entries;
  }
  const merged: AppServerThreadEntry[] = [...entries, ...additions];
  merged.sort((left, right) => {
    const leftAt = left.createdAt ?? 0;
    const rightAt = right.createdAt ?? 0;
    if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    // Stable tie-break: existing entries before synthetic failures when
    // timestamps match, so the failure marker lands after the work it
    // describes rather than shoving a same-instant entry around.
    const leftIsFailure = left.id.startsWith(TURN_FAILURE_ENTRY_PREFIX);
    const rightIsFailure = right.id.startsWith(TURN_FAILURE_ENTRY_PREFIX);
    if (leftIsFailure === rightIsFailure) {
      return 0;
    }
    return leftIsFailure ? 1 : -1;
  });
  return merged;
}

export function isTurnFailureEntry(entry: AppServerThreadEntry): boolean {
  return entry.id.startsWith(TURN_FAILURE_ENTRY_PREFIX);
}
