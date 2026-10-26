import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  ThreadRewindRecord,
} from "@pwragent/shared";
import { insertSyntheticEntriesByTime } from "./synthetic-transcript-entries";

/**
 * One marker row stands where a rewind removed turns. Built from the thread's
 * `rewindLog`, placed by the time of the rewind, which follows every turn it
 * kept. An undone rewind has no marker.
 */
export const REWIND_MARKER_ENTRY_PREFIX = "rewind-marker:";

export function rewindMarkerLabel(rewind: ThreadRewindRecord): string {
  const turns = rewind.removedTurnCount;
  const files = rewind.restoredFileCount;
  const parts = [
    turns === undefined
      ? "Rewound the conversation"
      : `Rewound ${turns} ${turns === 1 ? "turn" : "turns"}`,
  ];
  if (files) {
    parts.push(`restored ${files} ${files === 1 ? "file" : "files"}`);
  }
  return parts.join(" · ");
}

export function injectRewindMarkers(
  entries: AppServerThreadEntry[],
  rewinds: ThreadRewindRecord[] | undefined,
): AppServerThreadEntry[] {
  const synthetic: AppServerThreadActivityEntry[] = (rewinds ?? [])
    .filter((rewind) => rewind.undoneAt === undefined)
    .map((rewind) => ({
      type: "activity",
      id: `${REWIND_MARKER_ENTRY_PREFIX}${rewind.id}`,
      summary: rewindMarkerLabel(rewind),
      createdAt: rewind.occurredAt,
      details: [],
    }));
  return insertSyntheticEntriesByTime(entries, synthetic);
}

export function isRewindMarkerEntry(entry: AppServerThreadEntry): boolean {
  return entry.type === "activity" && entry.id.startsWith(REWIND_MARKER_ENTRY_PREFIX);
}

/**
 * The rewind the transcript offers to undo: the latest one still in effect,
 * when its provider kept the removed turns and no message has followed it.
 * A message after the marker means a new turn continued the rewound branch.
 */
export function undoableRewindId(
  entries: readonly AppServerThreadEntry[],
  rewinds: ThreadRewindRecord[] | undefined,
): string | undefined {
  const latest = (rewinds ?? []).filter((rewind) => rewind.undoneAt === undefined).at(-1);
  if (!latest?.undoable) {
    return undefined;
  }
  const markerId = `${REWIND_MARKER_ENTRY_PREFIX}${latest.id}`;
  const index = entries.findIndex((entry) => entry.id === markerId);
  if (index < 0 || entries.slice(index + 1).some((entry) => entry.type === "message")) {
    return undefined;
  }
  return latest.id;
}
