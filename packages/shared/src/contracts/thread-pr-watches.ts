import type { FederationCapability, FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";
import type {
  ThreadPullRequestWatchEvent,
  ThreadPullRequestWatchSummary,
  WatchThreadPullRequestResult,
} from "./thread-tools";

/**
 * The operator's view of the PR watches that wake threads. Agents create
 * watches through `watch_thread_pull_request`; this channel lists them, stops
 * one, and arms a CI watch with the tool's own logic. A peer's thread is
 * managed on its owner, through `FederationThreadPrWatchesRequestV1`, when
 * the owner advertises `THREAD_PR_WATCH_CONTROL_CAPABILITY`.
 */
export const THREAD_PR_WATCHES_CHANNEL = "thread:prWatches";

/** The owner manages its watches for a viewer, and marks its rows' CI watches. */
export const THREAD_PR_WATCH_CONTROL_CAPABILITY = "thread_pr_watch_control_v1" satisfies FederationCapability;

/** Most history rows one request returns. */
export const THREAD_PR_WATCH_HISTORY_MAX_LIMIT = 20;

export type ThreadPrWatchesRequest =
  | { action: "active" }
  | {
      action: "history";
      backend: AppServerBackendKind;
      threadId: string;
      /** Set for a peer's thread; history is read on the owner. */
      federationTarget?: FederationTarget;
      /** At most `THREAD_PR_WATCH_HISTORY_MAX_LIMIT`. */
      limit?: number;
    }
  | {
      action: "cancel";
      backend: AppServerBackendKind;
      threadId: string;
      /** Set for a peer's thread; its owner stops the watch. */
      federationTarget?: FederationTarget;
      watchId: string;
    }
  | {
      /**
       * The operator's Watch CI: a success and failure watch on one of the
       * thread's primary-workspace PRs, armed as the agent tool arms one.
       */
      action: "watch";
      backend: AppServerBackendKind;
      threadId: string;
      /** Set for a peer's thread; its owner arms the watch. */
      federationTarget?: FederationTarget;
      prUrl: string;
    };

/**
 * A viewer's request to the thread's owner, as `backend.manageThreadPrWatchesV1`.
 * It names one of the owner's own threads. The owner never lists every watch
 * for a peer: its navigation rows carry `prCiWatches` instead. The owner
 * answers with a `ThreadPrWatchesResponse`.
 */
export type FederationThreadPrWatchesRequestV1 =
  | {
      action: "history";
      backend: AppServerBackendKind;
      threadId: string;
      limit?: number;
    }
  | {
      action: "cancel";
      backend: AppServerBackendKind;
      threadId: string;
      watchId: string;
    }
  | {
      action: "watch";
      backend: AppServerBackendKind;
      threadId: string;
      prUrl: string;
    };

/**
 * One active CI watch, as the owner marks it on a navigation row so a viewer
 * draws the row's eye without the owner's full watch list.
 */
export type ThreadPrCiWatchMark = {
  prKey: string;
  watchId: string;
  notifyOn: ThreadPullRequestWatchEvent[];
  createdAt: number;
  runAttempt?: number;
};

/** `forbidden`: Git settings turned background PR polling off. */
export type ThreadPrWatchesErrorCode =
  | "not_found"
  | "federation_unsupported"
  | "invalid_arguments"
  | "forbidden";

/**
 * Whether Auto-fix starts a repair turn on one opted-in local thread for one
 * of its PRs. Main repairs a PR on one elected thread only, and not while the
 * profile's repair budget is paused. `handled_by_other_thread` names the
 * thread that won the election.
 */
export type ThreadPrAutoFixState = {
  backend: AppServerBackendKind;
  threadId: string;
  prKey: string;
  state: "active" | "paused" | "handled_by_other_thread";
  handledBy?: {
    backend: AppServerBackendKind;
    threadId: string;
    title?: string;
  };
};

export type ThreadPrWatchesResponse =
  | {
      ok: true;
      active?: ThreadPullRequestWatchSummary[];
      /**
       * Sent with `active`. An entry exists only where Auto-fix can run. An
       * owner that predates it sends none.
       */
      autoFix?: ThreadPrAutoFixState[];
      history?: ThreadPrWatchHistoryEntry[];
      cancelled?: boolean;
      /** Sent with `watch`: the same result the agent tool returns. */
      watch?: WatchThreadPullRequestResult;
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
  | "cancelled_by_agent"
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
