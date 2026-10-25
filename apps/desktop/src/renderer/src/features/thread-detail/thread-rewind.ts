import type {
  AppServerBackendKind,
  AppServerThreadEntry,
} from "@pwragent/shared";

/**
 * The user messages a rewind can go back before: the first prompt of each
 * turn. A provider that reports no turns (ACP) offers every prompt. Codex
 * rewinds by turn, so a prompt without one cannot be a target.
 */
export function collectRewindableMessageIds(
  entries: readonly AppServerThreadEntry[],
  backend: AppServerBackendKind,
): Set<string> {
  const ids = new Set<string>();
  const seenTurnIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "user") {
      continue;
    }
    const turnId = entry.turn?.id;
    if (turnId) {
      if (seenTurnIds.has(turnId)) {
        continue;
      }
      seenTurnIds.add(turnId);
    } else if (backend === "codex") {
      continue;
    }
    ids.add(entry.id);
  }
  return ids;
}

export type ThreadRewindSummary = {
  /** Turns after the target's own turn, which the rewind also removes. */
  laterTurnCount: number;
  /**
   * Distinct files changed from the target on. Undefined when a collapsed
   * history entry hides its details, so the count cannot be trusted.
   */
  changedFileCount?: number;
};

/** What a rewind to before `messageId` removes, from the loaded transcript. */
export function summarizeThreadRewind(
  entries: readonly AppServerThreadEntry[],
  messageId: string,
  backend: AppServerBackendKind,
): ThreadRewindSummary | undefined {
  const start = entries.findIndex((entry) => entry.id === messageId);
  if (start < 0) {
    return undefined;
  }
  const removed = entries.slice(start);
  const rewindable = collectRewindableMessageIds(removed, backend);
  rewindable.delete(messageId);
  const paths = new Set<string>();
  let countKnown = true;
  for (const entry of removed) {
    if (entry.type !== "activity") {
      continue;
    }
    if (entry.detailsRef && entry.details.length === 0) {
      countKnown = false;
    }
    for (const detail of entry.details) {
      if (detail.path && (detail.fileDiff || detail.kind === "write")) {
        paths.add(detail.path);
      }
    }
  }
  return {
    laterTurnCount: rewindable.size,
    ...(countKnown ? { changedFileCount: paths.size } : {}),
  };
}
