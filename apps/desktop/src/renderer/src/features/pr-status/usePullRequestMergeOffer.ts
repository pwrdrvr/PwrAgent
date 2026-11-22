import { useEffect, useState } from "react";
import type {
  PrSummary,
  ReadThreadPullRequestMergeResponse,
  ThreadPullRequestMergeTarget,
} from "@pwragent/shared/contracts/navigation";
import {
  resolvePullRequestMergeOffer,
  type PullRequestMergeOffer,
} from "@pwragent/shared/pull-request-merge-offer";
import { conditionName } from "../thread-dependencies/dependency-labels";
import {
  mergeHoldingDependencies,
  useThreadDependencyList,
} from "../thread-dependencies/useThreadDependencyList";
import type { PullRequestMergeService } from "./pull-request-merge-context";

export type PullRequestMergeOfferState =
  /** Still reading the project's method or the merge's holds. */
  | { kind: "loading" }
  /** A Continue After wait holds the merge; the strings name what it waits for. */
  | { kind: "held"; waitingFor: string[] }
  | PullRequestMergeOffer;

/**
 * What a PR card or the merge dialog offers, read only while one is open:
 * the project's remembered method (from main) and the Continue After holds
 * on this thread's merge (from its owner). A sidebar of chips reads nothing.
 */
export function usePullRequestMergeOffer(
  pr: PrSummary,
  thread: ThreadPullRequestMergeTarget,
  service: PullRequestMergeService,
): PullRequestMergeOfferState {
  const base = resolvePullRequestMergeOffer({ pr });
  const offered = base.kind !== "none";
  const [preference, setPreference] = useState<{ key: string; value?: ReadThreadPullRequestMergeResponse }>();
  const { backend, threadId } = thread;
  const key = `${backend}\u0000${threadId}`;
  const wantsMethod = base.kind === "merge";
  useEffect(() => {
    if (!wantsMethod) return;
    let disposed = false;
    const read = service.api.readThreadPullRequestMerge;
    if (!read) {
      setPreference({ key });
      return;
    }
    read({ backend, threadId })
      .then((value) => { if (!disposed) setPreference({ key, value }); })
      // Unreadable: start on the Settings order over the repository's methods.
      .catch(() => { if (!disposed) setPreference({ key }); });
    return () => { disposed = true; };
  }, [wantsMethod, key, backend, threadId, service.api]);
  const holds = useThreadDependencyList(thread.backend, thread.threadId, undefined, service.api, offered, pr.url);
  if (!offered) return base;
  // An owner that cannot answer still refuses a held merge itself.
  if (!holds.ready && !holds.error) return { kind: "loading" };
  const blocking = mergeHoldingDependencies(holds.data);
  if (blocking.length > 0) {
    return {
      kind: "held",
      waitingFor: blocking.flatMap((dependency) => dependency.conditions.map(conditionName)),
    };
  }
  if (base.kind !== "merge") return base;
  if (preference?.key !== key) return { kind: "loading" };
  return resolvePullRequestMergeOffer({
    pr,
    ...(preference.value?.remembered ? { remembered: preference.value.remembered } : {}),
    ...(preference.value?.fallback ? { fallback: preference.value.fallback } : {}),
  });
}
