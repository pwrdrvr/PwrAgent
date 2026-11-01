import {
  type AppServerBackendKind,
  type AppServerReadThreadRequest,
  type AppServerThreadEntry,
  type AppServerThreadReplay,
  isAcpBackendId,
  type ThreadReplayCursorIdSpace,
  fitThreadReplayWithinByteBudget,
  pageThreadReplay,
} from "@pwragent/shared";

import { getMainLogger } from "../log";
import { isOverlayOwnedTranscriptEntry } from "./overlay-transcript-entries";

const threadReplayPaginationLog = getMainLogger(
  "pwragent:thread-replay-pagination",
);

export type { ThreadReplayCursorIdSpace } from "@pwragent/shared";

/**
 * Whose id space a backend's own page cursor lives in.
 *
 * Ask this only about a response the backend already paged; a page cut here
 * is named with entry ids by construction.
 *
 * Codex resolves `before` by handing it straight to `thread/turns/list`, which
 * only ever accepts a cursor it issued. An ACP thread is read whole and paged
 * by `pageNormalizedReplay`, which resolves `before` by looking that id up
 * among the provider's own transcript entries.
 *
 * A backend nobody has classified defaults to `provider-cursor`. Preserving a
 * cursor we cannot improve on costs a page of history; inventing one the
 * backend rejects costs every page behind it.
 */
export function threadReplayCursorIdSpace(
  backend: AppServerBackendKind | undefined,
): ThreadReplayCursorIdSpace {
  return backend !== undefined && isAcpBackendId(backend)
    ? "entry-id"
    : "provider-cursor";
}

export type PageNormalizedReplayOptions =
  Pick<AppServerReadThreadRequest, "before" | "includeTurns" | "limit">
  & Partial<Pick<AppServerReadThreadRequest, "backend" | "threadId">>;

export function pageNormalizedReplay(
  replay: AppServerThreadReplay,
  options: PageNormalizedReplayOptions,
): AppServerThreadReplay {
  return pageThreadReplay(replay, options, {
    isCursorEntry: isProviderCursorEntry,
    onUnresolvedCursor: () => {
      threadReplayPaginationLog.warn("unresolved_transcript_pagination_cursor", {
        backend: options.backend,
        before: options.before,
        entryCount: replay.entries.length,
        threadId: options.threadId,
      });
    },
  });
}

export function fitNormalizedReplayWithinByteBudget(params: {
  cursorIdSpace: ThreadReplayCursorIdSpace;
  replay: AppServerThreadReplay;
  maxBytes: number;
  measureBytes: (replay: AppServerThreadReplay) => number;
}): AppServerThreadReplay {
  return fitThreadReplayWithinByteBudget({
    ...params,
    isCursorEntry: isProviderCursorEntry,
  });
}

/**
 * A page's cursor names its first **provider-owned** entry, not simply its
 * first entry.
 *
 * `before` is resolved against the provider's own replay, which never contains
 * an overlay-minted row, so an overlay id as a cursor is a cursor no read can
 * resolve. Skipping forward costs at most one overlay row repeated on the
 * older page, which `prependTranscriptHistoryPage` already dedupes by id.
 *
 * `hasPreviousPage` is reported only when a cursor was actually found. A page
 * made entirely of overlay rows leaves nothing to name, and announcing history
 * that cannot be requested is worse than announcing none: the renderer gates
 * its "load older" affordance on `hasPreviousPage` alone but every loader
 * bails on the missing cursor, so the control would render, the scroll
 * sentinel would keep firing it, and each request would resolve having loaded
 * nothing.
 */
function isProviderCursorEntry(entry: AppServerThreadEntry): boolean {
  return !isOverlayOwnedTranscriptEntry(entry);
}
