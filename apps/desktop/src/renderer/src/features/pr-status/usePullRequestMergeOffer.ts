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
  /** The thread's project never merges its pull requests (Forge Automation). */
  | { kind: "never_merge"; projectLabel: string }
  | PullRequestMergeOffer;

/**
 * What a PR card or the merge dialog offers, read only while one is open:
 * the project's remembered method and the Continue After holds on this
 * thread's merge, both from the instance that owns the thread. A sidebar of chips reads nothing.
 */
export function usePullRequestMergeOffer(
  pr: PrSummary,
  thread: ThreadPullRequestMergeTarget,
  service: PullRequestMergeService,
): PullRequestMergeOfferState {
  const base = resolvePullRequestMergeOffer({ pr });
  const offered = base.kind !== "none";
  const [preference, setPreference] = useState<{ key: string; value?: ReadThreadPullRequestMergeResponse }>();
  const { backend, threadId, federationTarget } = thread;
  const owner = federationTarget?.scope === "remote" ? federationTarget.instanceId : undefined;
  const key = `${owner ?? ""}\u0000${backend}\u0000${threadId}`;
  // Read for a queue too: the owner also says whether the project merges.
  useEffect(() => {
    if (!offered) return;
    let disposed = false;
    const read = service.api.readThreadPullRequestMerge;
    if (!read) {
      setPreference({ key });
      return;
    }
    read({ backend, threadId, ...(owner ? { federationTarget: { scope: "remote", instanceId: owner } } : {}) })
      .then((value) => { if (!disposed) setPreference({ key, value }); })
      // Unreadable: start on the Settings order over the repository's methods.
      .catch(() => { if (!disposed) setPreference({ key }); });
    return () => { disposed = true; };
  }, [offered, key, backend, threadId, owner, service.api]);
  // A peer's holds are read from its owner, which also enforces them.
  const holds = useThreadDependencyList(backend, threadId, federationTarget, service.api, offered, pr.url);
  if (!offered) return base;
  if (preference?.key !== key) return { kind: "loading" };
  const neverMergeProject = preference.value?.neverMergeProject;
  if (neverMergeProject) return { kind: "never_merge", projectLabel: neverMergeProject };
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
  return resolvePullRequestMergeOffer({
    pr,
    ...(preference.value?.remembered ? { remembered: preference.value.remembered } : {}),
    ...(preference.value?.fallback ? { fallback: preference.value.fallback } : {}),
  });
}
