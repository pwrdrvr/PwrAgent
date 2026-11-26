import type {
  FederationCapability,
  FederationRemoteTarget,
  FederationTarget,
} from "./contracts/federation";
import { isRemoteFederationTarget } from "./contracts/federation";
import type { PrSummary } from "./contracts/navigation";
import { THREAD_PULL_REQUEST_MERGE_CAPABILITY } from "./contracts/navigation";
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

/**
 * Where a thread's PR card merges. `local` is this instance's own thread in
 * its own window. `owner` is a peer's thread, merged by the instance that
 * owns it. `none` offers no merge.
 */
export type PullRequestMergeRoute =
  | { kind: "local" }
  | { kind: "owner"; target: FederationRemoteTarget }
  | { kind: "none" };

/**
 * A peer's thread merges on its owner only when that owner answers the merge
 * request and grants this instance turn control, and only while it is
 * reachable. A viewer window's rows all name their owner; one that does not
 * cannot be routed, so it gets no merge.
 */
export function resolvePullRequestMergeRoute(input: {
  /** The thread row's federation metadata, as navigation sends it. */
  federation?: {
    ref: { target: FederationTarget };
    peerStatus?: string;
    capabilities?: readonly FederationCapability[];
  };
  viewerWindow: boolean;
}): PullRequestMergeRoute {
  const target = input.federation?.ref.target;
  if (target && isRemoteFederationTarget(target)) {
    const { capabilities = [], peerStatus } = input.federation!;
    if (peerStatus !== undefined && peerStatus !== "connected") return { kind: "none" };
    return capabilities.includes(THREAD_PULL_REQUEST_MERGE_CAPABILITY) && capabilities.includes("turn_control")
      ? { kind: "owner", target: { scope: "remote", instanceId: target.instanceId } }
      : { kind: "none" };
  }
  return input.viewerWindow ? { kind: "none" } : { kind: "local" };
}

/**
 * What merging a layer of a GitHub stack does with the open layers below it.
 * GitHub's asynchronous merge lands every open layer below the one merged,
 * so the operator has to see and choose them: `with_layers_below` sends
 * their numbers with the merge, which this instance's main checks against
 * the stack again. A peer's owner takes no such choice, so its card says to
 * merge the lower layers first. Undefined when nothing below is open.
 */
export type GithubStackMergePlan =
  /** `trunk`: where GitHub lands the stack, whatever the PR's base is now. */
  | { kind: "with_layers_below"; below: number[]; count: number; trunk?: string }
  | { kind: "merge_below_first"; below: number[] };

export function resolveGithubStackMergePlan(input: {
  /** The PR's compact stack membership, when its stack exists on GitHub. */
  member?: { githubStack?: number; openBelow?: readonly number[]; trunk?: string };
  /** The merge runs on a peer that owns the thread. */
  remote: boolean;
}): GithubStackMergePlan | undefined {
  const below = input.member?.githubStack !== undefined ? [...input.member.openBelow ?? []] : [];
  if (!below.length) return undefined;
  if (input.remote) return { kind: "merge_below_first", below };
  const trunk = input.member?.trunk;
  return { kind: "with_layers_below", below, count: below.length + 1, ...(trunk ? { trunk } : {}) };
}

/** "#7", "#7 and #8", "#7, #8 and #9". */
export function listPullRequestNumbers(numbers: readonly number[]): string {
  const labels = numbers.map((number) => `#${number}`);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** The line a merge of a stacked PR shows before it runs. */
export function githubStackMergeNote(plan: GithubStackMergePlan, number: number): string {
  const below = listPullRequestNumbers(plan.below);
  const verb = plan.below.length === 1 ? "is" : "are";
  return plan.kind === "with_layers_below"
    ? `${below} below #${number} in its GitHub stack ${verb} still open. GitHub merges ${plan.below.length === 1 ? "it" : "them"} first, then #${number}.`
    : `${below} below #${number} in its GitHub stack ${verb} still open. Merge ${plan.below.length === 1 ? "it" : "them"} first.`;
}
