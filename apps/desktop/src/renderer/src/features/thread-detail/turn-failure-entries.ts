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
export const CODEX_INVALID_ID_RECOVERY_ENTRY_PREFIX =
  "codex-invalid-id-recovery:";

function buildCodexInvalidIdRecoveryActivityEntries(
  failure: ThreadTurnFailure,
): AppServerThreadActivityEntry[] {
  const recovery = failure.codexInvalidIdRecovery;
  if (!recovery) {
    return [];
  }
  const entries: AppServerThreadActivityEntry[] = [
    {
      type: "activity",
      id:
        `${CODEX_INVALID_ID_RECOVERY_ENTRY_PREFIX}${recovery.attemptId}`
        + ":repairing",
      summary:
        recovery.repairedAt !== undefined || recovery.failedAt !== undefined
          ? "Known Codex issue detected — thread repair attempted"
          : "Known Codex issue detected — repairing thread",
      createdAt: recovery.attemptedAt,
      tone: "warning",
      details: [
        {
          id: `${recovery.attemptId}:repairing:detail`,
          kind: "read",
          label:
            "PwrAgent is repairing invalid saved message IDs before retrying the request.",
          status:
            recovery.repairedAt !== undefined
              ? "completed"
              : recovery.failedAt !== undefined
                ? "failed"
                : "in_progress",
        },
      ],
    },
  ];
  if (recovery.repairedAt !== undefined) {
    entries.push({
      type: "activity",
      id:
        `${CODEX_INVALID_ID_RECOVERY_ENTRY_PREFIX}${recovery.attemptId}`
        + ":repaired",
      summary: "Thread repair succeeded",
      createdAt: recovery.repairedAt,
      details: [
        {
          id: `${recovery.attemptId}:repaired:detail`,
          kind: "read",
          label:
            recovery.removedMessageIdCount === undefined
              ? "Saved thread history was repaired successfully."
              : `Removed ${recovery.removedMessageIdCount} invalid saved message ID(s).`,
          status: "completed",
        },
      ],
    });
  }
  if (recovery.retrySubmittedAt !== undefined) {
    entries.push({
      type: "activity",
      id:
        `${CODEX_INVALID_ID_RECOVERY_ENTRY_PREFIX}${recovery.attemptId}`
        + ":retry",
      summary: "PwrAgent resubmitted the request once",
      createdAt: recovery.retrySubmittedAt,
      details: [
        {
          id: `${recovery.attemptId}:retry:detail`,
          kind: "read",
          label:
            "The next request was automatically resubmitted by PwrAgent, not entered again by the user.",
          status: recovery.failure ? "failed" : "completed",
        },
      ],
      ...(recovery.failure ? { tone: "warning" as const } : {}),
    });
  } else if (recovery.failedAt !== undefined) {
    entries.push({
      type: "activity",
      id:
        `${CODEX_INVALID_ID_RECOVERY_ENTRY_PREFIX}${recovery.attemptId}`
        + ":failed",
      summary: "Automatic thread repair failed",
      createdAt: recovery.failedAt,
      tone: "warning",
      status: "failed",
      details: [
        {
          id: `${recovery.attemptId}:failed:detail`,
          kind: "read",
          label: recovery.failure ?? "The request was not resubmitted.",
          status: "failed",
        },
      ],
    });
  }
  return entries;
}

export function buildTurnFailureActivityEntries(
  failures: ThreadTurnFailure[] | undefined,
): AppServerThreadActivityEntry[] {
  if (!failures || failures.length === 0) {
    return [];
  }
  return failures.flatMap((failure) => [
    {
      type: "activity" as const,
      id: `${TURN_FAILURE_ENTRY_PREFIX}${failure.turnId}`,
      summary: "Turn failed",
      createdAt: failure.occurredAt,
      tone: "warning" as const,
      status: "failed" as const,
      turn: {
        id: failure.turnId,
        status: "failed" as const,
        completedAt: failure.occurredAt,
      },
      details: [
        {
          id: `${TURN_FAILURE_ENTRY_PREFIX}${failure.turnId}:detail`,
          kind: "read" as const,
          label: failure.error,
          status: "failed" as const,
        },
      ],
    },
    ...buildCodexInvalidIdRecoveryActivityEntries(failure),
  ]);
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
