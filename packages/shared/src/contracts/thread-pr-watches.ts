import type { FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";
import type {
  ThreadPullRequestWatchEvent,
  ThreadPullRequestWatchSummary,
} from "./thread-tools";

/**
 * The operator's view of the PR watches that wake threads. Watches are created
 * by agents through `watch_thread_pull_request`; this channel lists them and
 * lets a local window stop one. A federation window cannot cancel: the owner
 * instance is authoritative and no signed request carries a cancel.
 */
export const THREAD_PR_WATCHES_CHANNEL = "thread:prWatches";

/** Most history rows one request returns. */
export const THREAD_PR_WATCH_HISTORY_MAX_LIMIT = 20;

export type ThreadPrWatchesRequest =
  | { action: "active" }
  | {
      action: "history";
      backend: AppServerBackendKind;
      threadId: string;
      /** Set for a peer's thread; history is read on the owner only. */
      federationTarget?: FederationTarget;
      /** At most `THREAD_PR_WATCH_HISTORY_MAX_LIMIT`. */
      limit?: number;
    }
  | {
      action: "cancel";
      backend: AppServerBackendKind;
      threadId: string;
      /** Set for a peer's thread, which this instance cannot stop. */
      federationTarget?: FederationTarget;
      watchId: string;
    };

export type ThreadPrWatchesErrorCode =
  | "not_found"
  | "federation_unsupported"
  | "invalid_arguments";

export type ThreadPrWatchesResponse =
  | {
      ok: true;
      active?: ThreadPullRequestWatchSummary[];
      history?: ThreadPrWatchHistoryEntry[];
      cancelled?: boolean;
    }
  | {
      ok: false;
      error: { code: ThreadPrWatchesErrorCode; message: string };
    };

export type ThreadPrWatchEndedStatus =
  | "dispatched"
  | "superseded"
  | "cancelled"
  | "failed";

/**
 * How a watch ended. Rows that ended before this field existed have none.
 * `moved` means a push moved a CI watch to the new head, where a copy waits.
 * `another_thread_woke` means an older watch on another thread received the
 * same result, and this thread got no turn. `pr_merged` and `pr_closed` end a
 * CI watch when its thread's merge/close watch woke it.
 */
export type ThreadPrWatchEndedReason =
  | "woke"
  | "another_thread_woke"
  | "moved"
  | "head_changed"
  | "cancelled_by_operator"
  | "detached"
  | "covered_by_auto_fix"
  | "pr_merged"
  | "pr_closed"
  | "failed";

export type ThreadPrWatchHistoryEntry = ThreadPullRequestWatchSummary & {
  status: ThreadPrWatchEndedStatus;
  updatedAt: number;
  endedReason?: ThreadPrWatchEndedReason;
  wokeOn?: ThreadPullRequestWatchEvent;
  /** The watch id of the copy at the new head, for `moved`. */
  movedTo?: string;
};
