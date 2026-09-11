import { useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "./federated-thread-events";

export const MAX_RECENT_REMOTE_THREADS = 5;

/** Window-local LRU. Background activity must not promote or retain a thread. */
export function useRecentRemoteThreads(params: {
  selectedThread?: NavigationThreadSummary;
  threads: NavigationThreadSummary[];
}): NavigationThreadSummary[] {
  const [recent, setRecent] = useState<NavigationThreadSummary[]>([]);
  const selected = params.selectedThread;
  const current = new Map(params.threads.map((item) => [threadSummaryIdentityKey(item), item]));
  if (selected) current.set(threadSummaryIdentityKey(selected), selected);
  const supportsRetention = (item: NavigationThreadSummary): boolean =>
    item.federation?.ref.target.scope === "remote"
    && item.federation.capabilities?.includes("event_subscriptions") === true
    && item.federation.capabilities.includes("thread_detail");
  let next = recent.map((item) => current.get(threadSummaryIdentityKey(item)) ?? item)
    .filter(supportsRetention);
  if (selected && supportsRetention(selected)) {
    const key = threadSummaryIdentityKey(selected);
    next = [selected, ...next.filter((item) => threadSummaryIdentityKey(item) !== key)]
      .slice(0, MAX_RECENT_REMOTE_THREADS);
  }
  if (next.length !== recent.length
    || next.some((item, index) => threadSummaryIdentityKey(item) !== threadSummaryIdentityKey(recent[index]!))) {
    setRecent(next);
  }
  return next;
}
