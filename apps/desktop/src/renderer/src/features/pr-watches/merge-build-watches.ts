import { buildPullRequestStatusKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadDependency } from "@pwragent/shared/contracts/thread-dependencies";
import {
  summarizeThreadDependencyMergeBuild,
  THREAD_DEPENDENCY_MERGE_BUILD_WAITING_REASON,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { DesktopApi } from "../../lib/desktop-api";
import { parsePullRequestUrl } from "../../lib/pull-request-links";

/**
 * Merge build watches as every PR surface shows them: the composer's PR
 * menu, the PR chip's menu and hover card, and the rail's Pull requests
 * card. A merge build watch is a Continue After `merge_build` wait that a
 * thread keeps on its own PR (docs/thread-dependencies.md#merge-builds).
 */

export const isActiveMergeBuildWait = (dependency: ThreadDependency): boolean =>
  dependency.status === "waiting" || dependency.status === "ready" || dependency.status === "dispatching";

/** This thread's own merge build waits: the PR it opened, merged, then built on its target branch. */
export function ownMergeBuildWaits(dependencies: readonly ThreadDependency[], thread: { backend: string; threadId: string }): ThreadDependency[] {
  return dependencies.filter((dependency) => dependency.backend === thread.backend && dependency.threadId === thread.threadId
    && dependency.conditions.some((condition) =>
      condition.when === "merge_build" && condition.backend === thread.backend && condition.threadId === thread.threadId));
}

/**
 * The PR a new merge build watch names: the newest open PR, else the one
 * merged most recently, whose build may still be running.
 */
export function mergeBuildPullRequestUrl(prs: readonly PrSummary[]): string | undefined {
  const merged = (pr: PrSummary) => pr.lifecycleState === "merged" || pr.state === "merged";
  const open = prs.filter((pr) => !merged(pr) && pr.lifecycleState !== "closed" && pr.state !== "closed");
  const newest = (list: PrSummary[], at: (pr: PrSummary) => number | undefined) =>
    [...list].sort((left, right) => (at(right) ?? 0) - (at(left) ?? 0))[0];
  return (newest(open, (pr) => pr.createdAt) ?? newest(prs.filter(merged), (pr) => pr.mergedAt))?.url;
}

/** The PR a merge build wait is about: the one it names, else the one it found. */
export function mergeBuildWaitPrUrl(dependency: ThreadDependency): string | undefined {
  const index = dependency.conditions.findIndex((condition) => condition.when === "merge_build");
  if (index < 0) return undefined;
  return dependency.conditions[index]!.prUrl ?? dependency.evidence[index]?.prUrl;
}

/**
 * The thread's active merge build wait for `pr`, if any. A wait that names
 * no PR and has not found one yet is about no chip.
 */
export function mergeBuildWaitForPr(waits: readonly ThreadDependency[] | undefined, pr: PrSummary): ThreadDependency | undefined {
  if (!waits?.length) return undefined;
  const url = pr.url.toLowerCase();
  const key = buildPullRequestStatusKey(pr);
  return waits.find((dependency) => {
    if (!isActiveMergeBuildWait(dependency)) return false;
    const watchUrl = mergeBuildWaitPrUrl(dependency);
    if (!watchUrl) return false;
    if (watchUrl.toLowerCase() === url) return true;
    const target = parsePullRequestUrl(watchUrl);
    return target !== undefined && buildPullRequestStatusKey(target) === key;
  });
}

/**
 * What Watch Merge Build says for a thread. A thread with an active wait shows
 * it checked, with what will wake it. Without one, the default for every
 * merge applies (`[git] watch_merge_builds`, or the project's Forge
 * Automation), unless the operator stopped this thread's watch for its
 * current PR.
 */
export function describeMergeBuildWatch(params: {
  waits: readonly ThreadDependency[];
  defaultOn: boolean;
  prUrl?: string;
}): { checked: boolean; detail: string } {
  const active = params.waits.find(isActiveMergeBuildWait);
  if (active) return { checked: true, detail: active.wakeOn === "failure" ? "Wakes if it fails" : "Wakes on pass or fail" };
  const prUrl = params.prUrl?.toLowerCase();
  const stopped = params.waits.some((dependency) => dependency.status === "cancelled"
    && dependency.conditions.some((condition) => condition.when === "merge_build"
      && (!prUrl || !condition.prUrl || condition.prUrl.toLowerCase() === prUrl)));
  if (stopped) return { checked: false, detail: "Off for this PR" };
  return { checked: false, detail: params.defaultOn ? "Default: wakes if it fails" : "Off" };
}

/**
 * One active merge build watch as a row: what wakes the thread, and where
 * the build stands. Before the merge it waits for the merge; after it, the
 * latest check, which the owner keeps in memory and lists with the wait.
 */
export function describeMergeBuildWatchRow(dependency: ThreadDependency, now: number): {
  wakes: "if it fails" | "on pass or fail";
  status: string;
} {
  const wakes = dependency.wakeOn === "failure" ? "if it fails" : "on pass or fail";
  if (dependency.status === "ready" || dependency.status === "dispatching") return { wakes, status: "Waking the thread" };
  const index = dependency.conditions.findIndex((condition) => condition.when === "merge_build");
  const evidence = index >= 0 ? dependency.evidence[index] : undefined;
  const build = evidence?.state === "waiting" ? evidence.mergeBuild : undefined;
  if (build) return { wakes, status: `${summarizeThreadDependencyMergeBuild(build)} · checked ${formatAge(build.checkedAt, now)}` };
  if (evidence?.reason === THREAD_DEPENDENCY_MERGE_BUILD_WAITING_REASON) return { wakes, status: "Merged · waiting for checks" };
  return { wakes, status: "After the PR merges" };
}

function formatAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

type MergeBuildApi = Pick<DesktopApi, "manageThreadDependencies">;

function addressed(thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">) {
  const owner = thread.federation?.ref.target;
  return {
    backend: thread.source,
    threadId: thread.id,
    ...(owner?.scope === "remote" ? { federationTarget: { scope: "remote" as const, instanceId: owner.instanceId } } : {}),
  };
}

/** Watches `prUrl`'s merge build on the thread, waking it on pass or fail. */
export async function createMergeBuildWatch(api: MergeBuildApi, thread: Pick<NavigationThreadSummary, "id" | "source" | "federation" | "title">,
  prUrl: string | undefined): Promise<void> {
  if (!api.manageThreadDependencies) throw new Error("This window cannot change Continue After.");
  await api.manageThreadDependencies({
    action: "create", ...addressed(thread),
    conditions: [{
      backend: thread.source, threadId: thread.id, when: "merge_build",
      ...(prUrl ? { prUrl } : {}),
      ...(thread.title ? { title: thread.title.slice(0, 200) } : {}),
    }],
  });
}

/**
 * Stops merge build watches on the thread. A stopped watch also keeps
 * PwrAgent from arming one for that PR when it merges.
 */
export async function cancelMergeBuildWatches(api: MergeBuildApi, thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">,
  waits: readonly ThreadDependency[]): Promise<void> {
  if (!api.manageThreadDependencies) throw new Error("This window cannot change Continue After.");
  for (const dependency of waits.filter(isActiveMergeBuildWait)) {
    await api.manageThreadDependencies({ action: "cancel", ...addressed(thread), dependencyId: dependency.id });
  }
}
