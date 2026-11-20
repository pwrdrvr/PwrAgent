import { useLayoutEffect, useRef, useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { threadSummaryIdentityKey } from "./federated-thread-events";

export const MAX_RECENT_REMOTE_THREADS = 5;

type ThreadIndexInput = {
  backend: NavigationThreadSummary["source"];
  threadId: string;
  scope: "local" | "remote" | undefined;
  instanceId: string | undefined;
};

function threadIndexInputsMatch(inputs: ThreadIndexInput[], threads: NavigationThreadSummary[]): boolean {
  if (inputs.length !== threads.length) return false;
  for (let index = 0; index < threads.length; index++) {
    const thread = threads[index]!;
    const previous = inputs[index]!;
    const ref = thread.federation?.ref;
    if (previous.backend !== (ref ? ref.backend : thread.source)
      || previous.threadId !== (ref ? ref.threadId : thread.id)
      || previous.scope !== ref?.target.scope
      || previous.instanceId !== (ref?.target.scope === "remote" ? ref.target.instanceId : undefined)) return false;
  }
  return true;
}

/** Cache positions, never row objects: metadata and capabilities are read from this render's rows. */
function useCurrentThreadIndexes(threads: NavigationThreadSummary[], needed: boolean): Map<string, number> | undefined {
  const cache = useRef<{ inputs: ThreadIndexInput[]; indexes: Map<string, number> } | undefined>(undefined);
  let next = cache.current;
  if (!needed) {
    next = undefined;
  } else if (!next || !threadIndexInputsMatch(next.inputs, threads)) {
    const inputs: ThreadIndexInput[] = [];
    const indexes = new Map<string, number>();
    for (let index = 0; index < threads.length; index++) {
      const thread = threads[index]!;
      const ref = thread.federation?.ref;
      inputs.push({
        backend: ref ? ref.backend : thread.source,
        threadId: ref ? ref.threadId : thread.id,
        // A federation-local ref and a bare local row have different canonical keys.
        scope: ref?.target.scope,
        instanceId: ref?.target.scope === "remote" ? ref.target.instanceId : undefined,
      });
      // Ordered inputs and last-write wins preserve duplicate precedence.
      indexes.set(threadSummaryIdentityKey(thread), index);
    }
    next = { inputs, indexes };
  }
  // Keep one committed inventory snapshot; abandoned renders cannot publish it.
  useLayoutEffect(() => { cache.current = next; }, [next]);
  return next?.indexes;
}

/** Window-local LRU. Background activity must not promote or retain a thread. */
export function useRecentRemoteThreads(params: {
  selectedThread?: NavigationThreadSummary;
  threads: NavigationThreadSummary[];
}): NavigationThreadSummary[] {
  const [recent, setRecent] = useState<NavigationThreadSummary[]>([]);
  const selected = params.selectedThread;
  const current = useCurrentThreadIndexes(params.threads, recent.length > 0);
  const selectedKey = selected ? threadSummaryIdentityKey(selected) : undefined;
  const supportsRetention = (item: NavigationThreadSummary): boolean =>
    item.federation?.ref.target.scope === "remote"
    && item.federation.capabilities?.includes("event_subscriptions") === true
    && item.federation.capabilities.includes("thread_detail");
  let next = recent.map((item) => {
    const key = threadSummaryIdentityKey(item);
    if (selected && key === selectedKey) return selected;
    const index = current?.get(key);
    return index === undefined ? item : params.threads[index]!;
  })
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
