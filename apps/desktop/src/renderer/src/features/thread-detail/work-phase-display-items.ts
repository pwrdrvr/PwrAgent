import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared";
import { classifyExplorationLabel } from "@pwragent/shared";
import {
  isPullRequestWatchToolDetail,
  isThreadReferenceToolDetail,
} from "./TranscriptCommandOutput";

export type WorkPhaseDisplayItem =
  | { type: "entry"; entry: AppServerThreadEntry }
  | { type: "activityRun"; id: string; entries: AppServerThreadActivityEntry[] };

/**
 * What an open work group draws. Consecutive one-call tool activities become
 * one run of rows, the way a batched call's activity lists its rows, so a
 * model that makes one tool call per step reads the same as one that batches
 * them. Every other entry keeps its own presentation, header included.
 */
export function buildWorkPhaseDisplayItems(
  entries: readonly AppServerThreadEntry[],
): WorkPhaseDisplayItem[] {
  const items: WorkPhaseDisplayItem[] = [];
  let run: AppServerThreadActivityEntry[] = [];
  const flushRun = (): void => {
    const first = run[0];
    if (first) {
      items.push({ type: "activityRun", id: `activity-run:${first.id}`, entries: run });
    }
    run = [];
  };

  for (const entry of entries) {
    if (isRunnableToolActivity(entry)) {
      run.push(entry);
      continue;
    }
    flushRun();
    items.push({ type: "entry", entry });
  }
  flushRun();
  return items;
}

/**
 * A provider tool activity with exactly one row that renders the same as a
 * row of a batched activity. Activities that need their header keep it:
 * notices (warning tone, synthetic repair or question rows), deferred
 * details, images, and the tools with their own card (PR watch, thread
 * reads and messages).
 */
export function isRunnableToolActivity(
  entry: AppServerThreadEntry,
): entry is AppServerThreadActivityEntry {
  if (
    entry.type !== "activity"
    || entry.details.length !== 1
    || entry.detailsRef
    || entry.tone
    // A live bucket gains calls as the turn runs. Drawn as a row at one
    // call, it would turn into a collapsed header at the second and hide
    // the row being read.
    || entry.id.startsWith("live-tools-")
  ) {
    return false;
  }
  const detail = entry.details[0];
  if (!detail || detail.images?.length || detail.fileDiff) {
    return false;
  }
  if (detail.command) {
    return !isThreadReferenceToolDetail(detail)
      && !isPullRequestWatchToolDetail(detail);
  }
  return detail.kind === "read"
    && !detail.markdown
    && classifyExplorationLabel(detail.label) !== undefined;
}
