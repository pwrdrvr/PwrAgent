import type { ThreadDependency } from "@pwragent/shared";
import { parsePullRequestReferenceUrl } from "../pr-status/forge-reference";

type Target = { backend: string; threadId: string; pullRequest?: string };

function prKey(url: string): string | undefined {
  const ref = parsePullRequestReferenceUrl(url);
  return ref ? JSON.stringify([ref.kind, ref.provider.toLowerCase(), ref.org.toLowerCase(), ref.repo.toLowerCase(), ref.number]) : undefined;
}

/**
 * The Continue After registrations that hold this merge: those with
 * `holdMerge` still waiting on the merging thread, or on any thread the PR
 * is attached to. Shared by merge cards and agent merges, and read again
 * just before the provider write.
 */
export function blockingMergeDependencies(
  active: readonly ThreadDependency[],
  target: Target,
  readPullRequestUrls: (thread: Pick<ThreadDependency, "backend" | "threadId">) => string[],
): ThreadDependency[] {
  const key = target.pullRequest ? prKey(target.pullRequest) : undefined;
  return active.filter((dependency) => dependency.holdMerge
    && (dependency.status === "waiting" || dependency.status === "ready")
    && ((dependency.backend === target.backend && dependency.threadId === target.threadId)
      || (key !== undefined && readPullRequestUrls(dependency).some((url) => prKey(url) === key))));
}

/**
 * A merge names its PR by number or URL. A merge resolves a number against
 * the thread's checkout before it checks holds; here the thread's one
 * attached PR with that number stands in for it. With none, or with that
 * number in two repositories, the number is returned and only the thread's
 * own holds can match it.
 */
export function resolveMergePullRequest(pullRequest: string, attachedUrls: readonly string[]): string {
  const value = pullRequest.trim();
  const number = /^#?(\d+)$/.exec(value)?.[1];
  if (!number) return value;
  const matches = new Map<string, string>();
  for (const url of attachedUrls) {
    const ref = parsePullRequestReferenceUrl(url);
    const key = prKey(url);
    if (ref && key && String(ref.number) === number) matches.set(key, url);
  }
  return matches.size === 1 ? [...matches.values()][0]! : value;
}

function describe(dependency: ThreadDependency): string {
  const names = dependency.conditions.map((condition) => condition.subject?.trim() || condition.title?.trim() || condition.threadId);
  return `${names.join(dependency.mode === "any" ? " or " : " and ")} (Continue After ${dependency.id})`;
}

export function assertMergeNotHeld(
  active: readonly ThreadDependency[],
  target: Target,
  readPullRequestUrls: (thread: Pick<ThreadDependency, "backend" | "threadId">) => string[],
): void {
  const blocking = blockingMergeDependencies(active, target, readPullRequestUrls);
  if (!blocking.length) return;
  throw new Error(`Merge held: waiting for ${blocking.map(describe).join("; ")}. Merging waits until it is met or the operator cancels the wait. Rebase and CI repair may continue. Do not bypass this hold with gh, glab, or another merge action.`);
}
