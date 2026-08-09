import { useCallback, useMemo, useState } from "react";
import type { AppServerThreadReplayPagination } from "@pwragent/shared";
import {
  DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
  THREAD_HISTORY_PAGE_LIMIT,
} from "../../lib/thread-history-limits";

/**
 * How much of a transcript is actually mounted.
 *
 * A thread's entry list can run to tens of thousands of items, and mounting
 * all of them is what turns a large thread into an unresponsive surface. Only
 * the newest `limit` entries render; scrolling up grows the window, and only
 * once the window has caught up with everything already fetched does an
 * upward scroll go back to the server for another page.
 *
 * This lived inside ThreadView, which is why the Star Map's chat cards — the
 * one other surface that mounts a transcript — rendered every entry they were
 * handed. It is a hook rather than a prop bag so both callers get the same
 * behaviour instead of a second implementation drifting away from this one.
 */
export type TranscriptWindow<Entry> = {
  /** The newest `limit` entries: what the transcript should mount. */
  visibleEntries: Entry[];
  /**
   * Pagination as the transcript should see it. When entries are being held
   * back locally there IS a previous page to reach, even on a thread whose
   * server-side history is already fully fetched — otherwise the transcript
   * hides its load-older affordance over entries it already has.
   */
  visiblePagination?: AppServerThreadReplayPagination;
  /** The server still holds a page we have not fetched. */
  canLoadFromServer: boolean;
  hasMoreHistory: boolean;
  hiddenCount: number;
  limit: number;
  /** Grow the window to at least `minimumLimit` entries. */
  expandLimit: (minimumLimit: number) => void;
  /** Widen the window first; go back to the server only when it is caught up. */
  loadOlder: () => Promise<void>;
};

export function useTranscriptWindow<Entry>(params: {
  entries: readonly Entry[];
  /**
   * Owner-controlled limit. Omit — along with `onLimitChange` — to let this
   * hook own it, which is what isolated renderers and tests do.
   */
  limit?: number;
  onLimitChange?: (limit: number) => void;
  onLoadOlder: () => Promise<void> | void;
  pagination?: AppServerThreadReplayPagination;
  /** Limits are per thread, so switching threads starts from the default. */
  threadKey?: string;
}): TranscriptWindow<Entry> {
  const { entries, onLimitChange, onLoadOlder, pagination, threadKey } = params;
  const [uncontrolledLimits, setUncontrolledLimits] = useState(
    () => new Map<string, number>(),
  );

  const limit = threadKey
    ? params.limit
      ?? uncontrolledLimits.get(threadKey)
      ?? DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT
    : DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT;

  const visibleEntries = useMemo(
    () => entries.slice(-limit),
    [entries, limit],
  );
  const entryCount = entries.length;
  const hiddenCount = entryCount - visibleEntries.length;
  const canLoadFromServer = Boolean(
    pagination?.supportsPagination && pagination.hasPreviousPage,
  );
  const hasMoreHistory = hiddenCount > 0 || canLoadFromServer;

  const visiblePagination = useMemo<
    AppServerThreadReplayPagination | undefined
  >(
    () =>
      hiddenCount > 0
        ? {
            ...(pagination ?? {}),
            hasPreviousPage: true,
            supportsPagination: true,
          }
        : pagination,
    [hiddenCount, pagination],
  );

  const expandLimit = useCallback(
    (minimumLimit: number) => {
      if (!threadKey) return;
      const nextLimit = Math.max(limit, minimumLimit);
      if (nextLimit === limit) return;
      if (onLimitChange) {
        onLimitChange(nextLimit);
        return;
      }
      setUncontrolledLimits((current) => {
        const currentLimit =
          current.get(threadKey) ?? DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT;
        if (currentLimit >= minimumLimit) return current;
        const next = new Map(current);
        next.set(threadKey, minimumLimit);
        return next;
      });
    },
    [limit, onLimitChange, threadKey],
  );

  const loadOlder = useCallback(async () => {
    if (hiddenCount > 0) {
      expandLimit(Math.min(entryCount, limit + THREAD_HISTORY_PAGE_LIMIT));
      return;
    }
    if (canLoadFromServer) {
      // Reserve renderer capacity before the response prepends its page.
      // Otherwise the newly loaded entries would remain hidden behind the
      // existing tail window until a second upward scroll.
      expandLimit(limit + THREAD_HISTORY_PAGE_LIMIT);
    }
    await onLoadOlder();
  }, [
    canLoadFromServer,
    entryCount,
    expandLimit,
    hiddenCount,
    limit,
    onLoadOlder,
  ]);

  return {
    canLoadFromServer,
    expandLimit,
    hasMoreHistory,
    hiddenCount,
    limit,
    loadOlder,
    visibleEntries,
    visiblePagination,
  };
}
