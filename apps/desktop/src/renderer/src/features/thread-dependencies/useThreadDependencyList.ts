import { useEffect, useState } from "react";
import type {
  AppServerBackendKind,
  FederationTarget,
  ManageThreadDependenciesResponse,
  ThreadDependency,
} from "@pwragent/shared";
import { threadDependencyMarkDoneIndex } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/** A wait on this thread that it can mark done, with the machine that keeps it. */
export type MarkDoneWait = {
  dependency: ThreadDependency;
  conditionIndex: number;
  /** The wait's owner as this window names it; absent for this machine. */
  owner?: FederationTarget;
};

const isOpen = (dependency: ThreadDependency): boolean =>
  dependency.status === "waiting" || dependency.status === "ready";

/**
 * The open waits that hold this thread's merge. Prefers the owner's own
 * merge check (`mergeHolds`, asked for with `pullRequest`), which also counts
 * holds on other threads with the PR attached. An owner that predates it
 * leaves only this thread's waits to go on.
 */
export function mergeHoldingDependencies(response: ManageThreadDependenciesResponse | undefined): ThreadDependency[] {
  return response?.mergeHolds
    ?? (response?.dependencies ?? []).filter((dependency) => dependency.holdMerge && isOpen(dependency));
}

/**
 * Waits other threads keep on this one that end when it is marked done:
 * the owner's own (`dependents`, kept where this thread lives) and other
 * machines' (`peerDependents`, each with its owner).
 */
export function markDoneWaitsOnThread(
  response: ManageThreadDependenciesResponse | undefined,
  thread: { backend: AppServerBackendKind; threadId: string; owner?: FederationTarget },
): MarkDoneWait[] {
  if (!response) return [];
  const entries = [
    ...(response.dependents ?? []).map((dependency) => ({ dependency, owner: thread.owner, peer: false })),
    ...(response.peerDependents ?? []).map(({ dependency, owner }) => ({ dependency, owner, peer: true })),
  ];
  return entries.flatMap(({ dependency, owner, peer }) => {
    if (!isOpen(dependency)) return [];
    return dependency.conditions.flatMap((condition, index) => {
      // A local dependent names this thread without a machine; a peer's names it with one.
      if (condition.when !== "marked_done" || condition.subject !== undefined || Boolean(condition.target) !== peer
        || condition.backend !== thread.backend || condition.threadId !== thread.threadId
        || threadDependencyMarkDoneIndex(dependency, index) === undefined) return [];
      return [{ dependency, conditionIndex: index, ...(owner?.scope === "remote" ? { owner } : {}) }];
    });
  });
}

// Evaluation publishes one update per changed registration.
const REFRESH_DEBOUNCE_MS = 150;

/**
 * One thread's Continue After list from its owner. Refreshes on
 * `thread/dependencies/updated`, on `thread/pullRequests/updated` when it
 * asks about a merge, and on focus, never on a timer. A failed
 * refresh keeps the last list.
 */
export function useThreadDependencyList(
  backend: AppServerBackendKind,
  threadId: string,
  federationTarget: FederationTarget | undefined,
  api: DesktopApi | undefined,
  enabled = true,
  /** A PR this thread would merge; the owner then answers `mergeHolds`. */
  pullRequest?: string,
) {
  const instanceId = federationTarget?.scope === "remote" ? federationTarget.instanceId : undefined;
  const key = JSON.stringify([backend, threadId, instanceId, pullRequest]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data?: ManageThreadDependenciesResponse; error?: string }>({ key });
  useEffect(() => {
    if (!enabled || !api?.manageThreadDependencies) return;
    let disposed = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const data = await api.manageThreadDependencies!({
          action: "list", backend, threadId,
          ...(pullRequest ? { pullRequest } : {}),
          ...(instanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
        });
        if (!disposed && current === sequence) setState({ key, data });
      } catch (reason) {
        if (!disposed && current === sequence) setState((previous) => ({
          key, ...(previous.key === key ? { data: previous.data } : {}),
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    };
    void refresh();
    const unsubscribe = api.onAgentEvent?.((event) => {
      // A merge's holds also follow which threads have its PR attached.
      if (event.notification.method !== "thread/dependencies/updated"
        && !(pullRequest && event.notification.method === "thread/pullRequests/updated")) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
    });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener("focus", focus);
    };
  }, [api, enabled, backend, threadId, instanceId, pullRequest, key, revision]);
  const current = state.key === key ? state : undefined;
  return {
    refresh: () => setRevision((value) => value + 1),
    data: current?.data,
    error: current?.error,
    ready: !enabled || !api?.manageThreadDependencies || Boolean(current?.data),
  };
}
