import type { PrSummary } from "./contracts/navigation";
import {
  forgeMergeMethods,
  settleMergeMethod,
  THREAD_TODO_MERGE_METHODS,
  type ThreadTodoMergeMethod,
} from "./contracts/thread-todos";
import { FORGE_PRODUCTS } from "./forge-product";
import { isMergeQueueActive, mergeQueueNoun } from "./pr-merge-queue";
import { resolveLifecycleState } from "./pull-request-rollup";

/**
 * The forge a PR's URL belongs to, from its change-request path: GitHub's
 * `/pull/<n>`, GitLab's `/-/merge_requests/<n>`. Undefined for anything else.
 */
export function pullRequestUrlForge(url: string): "github" | "gitlab" | undefined {
  // This package has no URL global: read the path after scheme and host.
  const path = /^https?:\/\/[^/?#]+(\/[^?#]*)/i.exec(url.trim())?.[1];
  if (!path) return undefined;
  const segments = path.split("/").filter(Boolean);
  const numberAt = (index: number): boolean => /^[1-9]\d*$/.test(segments[index] ?? "");
  const gitlab = segments.findIndex((segment, index) =>
    segment === "-" && segments[index + 1] === "merge_requests");
  if (gitlab > 0 && numberAt(gitlab + 2)) return "gitlab";
  const github = segments.indexOf(FORGE_PRODUCTS.github.changeRequestPath);
  return github >= 2 && numberAt(github + 1) ? "github" : undefined;
}

/**
 * The merge methods a PR can land with, in the to-do card's order: the
 * forge's, narrowed to the repository's own settings when the status poll
 * read them. Unknown settings leave the forge's list.
 */
export function pullRequestMergeMethods(
  pr: Pick<PrSummary, "allowedMergeMethods" | "url">,
): ThreadTodoMergeMethod[] {
  const forge = pullRequestUrlForge(pr.url);
  const offered = forge ? forgeMergeMethods(forge) : [...THREAD_TODO_MERGE_METHODS];
  const allowed = Array.isArray(pr.allowedMergeMethods) ? pr.allowedMergeMethods : [];
  const narrowed = offered.filter((method) => allowed.includes(method));
  return narrowed.length > 0 ? narrowed : offered;
}

/**
 * What a PR card's footer offers to land the PR. `merge` names the method its
 * button runs and every method its chevron lists; `queue` adds the PR to the
 * base branch's queue, whose ruleset picks the method.
 */
export type PullRequestMergeOffer =
  | { kind: "none" }
  | { kind: "queue"; noun: string; again: boolean }
  | { kind: "merge"; method: ThreadTodoMergeMethod; methods: ThreadTodoMergeMethod[] };

/**
 * The card's merge control, from the PR's status and the operator's
 * preferences. Only an open, ready, conflict-free GitHub PR is offered: the
 * operator's `gh` lands it, so a GitLab merge request is not. A PR already in
 * its queue has nothing to run.
 */
export function resolvePullRequestMergeOffer(input: {
  pr: PrSummary;
  remembered?: ThreadTodoMergeMethod;
  fallback?: ThreadTodoMergeMethod;
}): PullRequestMergeOffer {
  const { pr } = input;
  if (pullRequestUrlForge(pr.url) !== "github") return { kind: "none" };
  if (resolveLifecycleState(pr) !== "open") return { kind: "none" };
  if (pr.reviewState === "draft" || pr.state === "draft") return { kind: "none" };
  if (pr.mergeState === "conflicting") return { kind: "none" };
  const queue = pr.mergeQueue;
  if (queue && queue.state !== "merged_by_queue") {
    if (isMergeQueueActive(queue)) return { kind: "none" };
    return { kind: "queue", noun: mergeQueueNoun(queue.kind), again: queue.state === "removed" };
  }
  const methods = pullRequestMergeMethods(pr);
  return {
    kind: "merge",
    method: settleMergeMethod({
      offered: methods,
      ...(input.remembered ? { remembered: input.remembered } : {}),
      ...(input.fallback ? { fallback: input.fallback } : {}),
    }),
    methods,
  };
}
