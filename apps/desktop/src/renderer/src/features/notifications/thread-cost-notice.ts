import type { AppNoticeToastNotice } from "./AppNoticeToast";

export type ThreadCostNoticeKind =
  | "tool-output"
  | "active-turn-spend"
  | "thread-spend";

const THREAD_COST_NOTICE_PRIORITY: Record<ThreadCostNoticeKind, number> = {
  "tool-output": 0,
  "active-turn-spend": 1,
  "thread-spend": 2,
};

const THREAD_COST_DISMISS_GROUP = {
  key: "thread-cost",
  label: "cost notices",
} as const;

/**
 * Cost warnings share one renderer slot per owning instance and thread. The
 * instance segment matters for federation viewers: identical backend/thread
 * ids on two peers are different threads, even when one window normally
 * fronts only one peer at a time.
 */
export function buildThreadCostNoticeMetadata(params: {
  backend: string;
  instanceId?: string;
  kind: ThreadCostNoticeKind;
  threadId: string;
}): Pick<AppNoticeToastNotice, "coalescing" | "dismissGroup"> {
  const source = params.instanceId
    ? `remote:${encodeURIComponent(params.instanceId)}`
    : "local";
  return {
    coalescing: {
      key: [
        "thread-cost",
        source,
        encodeURIComponent(params.backend),
        encodeURIComponent(params.threadId),
      ].join(":"),
      priority: THREAD_COST_NOTICE_PRIORITY[params.kind],
    },
    dismissGroup: THREAD_COST_DISMISS_GROUP,
  };
}
