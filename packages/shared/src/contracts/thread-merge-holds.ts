import type { FederatedThreadRef, FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";

export const THREAD_MERGE_HOLDS_CHANNEL = "thread:merge-holds";

/** An explicit prerequisite for landing work. Turn completion never clears it. */
export type ThreadMergeHold = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  reason: string;
  releaseWhen: string;
  dependency?: FederatedThreadRef & { title?: string };
  pullRequestUrls: string[];
  status: "waiting" | "resolved" | "cancelled";
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  resolution?: { note: string; actor: string; at: number };
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
