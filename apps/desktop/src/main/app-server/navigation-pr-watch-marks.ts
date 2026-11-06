import type {
  NavigationThreadSummary,
  ThreadPrCiWatchMark,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:navigation-pr-watch-marks");

/**
 * Marks each local row with its active CI watches, from one read of every
 * active watch. A viewer draws a peer row's eye from the marks. A peer's own
 * row keeps the marks its owner sent. The marks are an overlay on the list,
 * so a failed read serves the rows without them.
 */
export async function attachNavigationPrCiWatchMarks<T extends NavigationThreadSummary>(
  threads: T[],
  listActiveWatches: () => Promise<ThreadPullRequestWatchSummary[]>,
): Promise<T[]> {
  if (threads.length === 0) return threads;
  let watches: ThreadPullRequestWatchSummary[];
  try {
    watches = await listActiveWatches();
  } catch (error) {
    log.warn("PR watches unavailable for navigation", {
      error: error instanceof Error ? error.message : String(error),
    });
    return threads;
  }
  const marksByThread = new Map<string, ThreadPrCiWatchMark[]>();
  for (const watch of watches) {
    // A merge/close watch is near-permanent and draws no eye.
    if ((watch.kind ?? "checks") !== "checks") continue;
    const key = buildThreadIdentityKey(watch.backend, watch.threadId);
    const runAttempt = watch.runAttempt ?? watch.baseline?.runAttempt;
    const mark: ThreadPrCiWatchMark = {
      prKey: watch.prKey,
      watchId: watch.watchId,
      notifyOn: watch.notifyOn,
      createdAt: watch.createdAt,
      ...(runAttempt !== undefined ? { runAttempt } : {}),
    };
    const marks = marksByThread.get(key);
    if (marks) marks.push(mark);
    else marksByThread.set(key, [mark]);
  }
  if (marksByThread.size === 0) return threads;
  return threads.map((thread) => {
    if (thread.federation) return thread;
    const prCiWatches = marksByThread.get(buildThreadIdentityKey(thread.source, thread.id));
    return prCiWatches ? { ...thread, prCiWatches } : thread;
  });
}
