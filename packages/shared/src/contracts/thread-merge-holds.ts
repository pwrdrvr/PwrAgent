import type { FederatedThreadRef, FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";

export const THREAD_MERGE_HOLDS_CHANNEL = "thread:merge-holds";

/** Follow-up steps one wait may carry, and the length of each. */
export const THREAD_MERGE_HOLD_MAX_FOLLOW_UP_STEPS = 12;
export const THREAD_MERGE_HOLD_FOLLOW_UP_STEP_MAX_LENGTH = 200;

/**
 * An explicit wait for work to finish. Merging stays held, and conversation,
 * rebase and CI repair continue. Turn completion never clears it; someone
 * marks it done. Marking it done raises the operator's reminder card.
 */
export type ThreadMergeHold = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  /** What has to finish. */
  reason: string;
  /** What counts as done, when that is more than the reason says. */
  releaseWhen?: string;
  /** What the operator wants to be reminded to do once it is done. */
  followUp?: string[];
  /** The reminder card also offers to send the follow-up to this thread. */
  offerToSend?: boolean;
  dependency?: FederatedThreadRef & { title?: string };
  pullRequestUrls: string[];
  status: "waiting" | "resolved" | "cancelled";
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  resolution?: { note: string; actor: string; at: number };
  /** The reminder card raised when it was marked done. */
  reminderTodoId?: string;
};

export type ManageThreadMergeHoldsRequest = {
  action: "create" | "list" | "resolve" | "cancel" | "active";
  backend?: AppServerBackendKind;
  threadId?: string;
  /** Owner of the waiting thread, not the prerequisite thread. */
  federationTarget?: FederationTarget;
  holdId?: string;
  reason?: string;
  releaseWhen?: string;
  followUp?: string[];
  offerToSend?: boolean;
  dependency?: ThreadMergeHold["dependency"];
  /** Required for resolve/cancel; retained in history. */
  note?: string;
  /** Read-only merge-card lookup; a URL or number in the thread's repository. */
  pullRequest?: string;
  includeDependents?: boolean;
};

export type ManageThreadMergeHoldsResponse = {
  holds: ThreadMergeHold[];
  blockingHolds?: ThreadMergeHold[];
  dependents: Array<{ hold: ThreadMergeHold; owner?: FederationTarget }>;
  /** Connected peers that could not be inspected; never implies completion. */
  unavailablePeers?: string[];
};
