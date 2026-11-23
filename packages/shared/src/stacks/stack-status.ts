import type { PrSummary } from "../contracts/navigation";
import type { StackAutomationBlock, StackLayerHealth, StackUnsettledReason } from "./stack-automation";
import type { GhStack, GhStackBranch } from "./catalog";
import { pullRequestStackOrder } from "../pull-request-review";

export type StackPullRequest = {
  number: number;
  headRefName?: string;
  baseRefName?: string;
  headSha?: string;
  lifecycleState?: "open" | "merged" | "closed";
};

export type { StackLayerHealth } from "./stack-automation";

export type StackThread = {
  key: string;
  title: string;
  paths: readonly string[];
  attached: readonly number[];
  remote?: true;
};

export type StackWorktree = { path: string; branch: string };

export type StackLayerBinding =
  | { role: "layer" | "holder" | "remote"; thread: StackThread }
  | { role: "ambiguous" | "unbound" };

export type StackLayerPullRequest = Pick<PrSummary, "number" | "lifecycleState" | "title" | "url"
  | "state" | "checkState" | "checksStillRunning" | "reviewState" | "mergeState" | "mergeQueue" | "mergedAt">;

export type StackLayer = {
  branch: string;
  parent: string;
  /** When a merged historical parent has been replaced by the stack trunk. */
  activeBase?: string;
  health: StackLayerHealth;
  heldBy?: StackAutomationBlock;
  unsettled?: StackUnsettledReason;
  pullRequest?: Pick<StackLayerPullRequest, "number"> & Partial<StackLayerPullRequest>;
  thread?: Pick<StackThread, "key" | "title">;
  role: StackLayerBinding["role"];
};

export type StackSummary = {
  key: string;
  name: string;
  repository: string;
  inferred: boolean;
  trunk: string;
  layers: StackLayer[];
};

export type ThreadStackMembership = {
  stack: StackSummary;
  /** One-based position, bottom first. */
  position: number;
};

export const MAX_COMPACT_STACK_MEMBERSHIPS = 8;

export type CompactStackMembership = {
  key: string;
  name: string;
  inferred: boolean;
  position: number;
  count: number;
  repository?: string;
  number?: number;
  health: StackLayerHealth;
  heldBy?: StackAutomationBlock;
  unsettled?: StackUnsettledReason;
  detailRevision?: string;
  threadKey?: string;
  parentThreadKey?: string;
  parentMerged?: boolean;
  trunk?: string;
  hasOpenPr?: boolean;
  basePr?: Pick<StackLayerPullRequest, "number" | "lifecycleState" | "checkState" | "mergeState">;
};

export type SelectedStackLayer = {
  stackKey: string;
  /** The first layer carries the stack header. */
  stack?: Omit<StackSummary, "layers">;
  position: number;
  layer: StackLayer;
};

export function compactStackMembership(
  stack: StackSummary,
  position: number,
  hasOpenPr = stack.layers.some((layer) => layer.pullRequest?.lifecycleState === "open"),
): CompactStackMembership | undefined {
  const layer = stack.layers[position - 1];
  if (!layer) return undefined;
  const parent = stack.layers[position - 2];
  const base = parent?.pullRequest;
  return {
    key: stack.key,
    name: stack.name.slice(0, 160),
    inferred: stack.inferred,
    position,
    count: stack.layers.length,
    repository: stack.repository,
    trunk: stack.trunk.slice(0, 160),
    hasOpenPr,
    ...(base && layer.activeBase !== stack.trunk ? { basePr: {
      number: base.number, lifecycleState: base.lifecycleState, checkState: base.checkState, mergeState: base.mergeState,
    } } : {}),
    ...(layer.pullRequest ? { number: layer.pullRequest.number } : {}),
    health: layer.health,
    ...(layer.heldBy ? { heldBy: layer.heldBy } : {}),
    ...(layer.unsettled ? { unsettled: layer.unsettled } : {}),
    ...(layer.thread && layer.thread.key.length <= 512 ? { threadKey: layer.thread.key } : {}),
    ...(parent?.thread && parent.thread.key.length <= 512 ? { parentThreadKey: parent.thread.key } : {}),
    ...(parent?.pullRequest?.lifecycleState === "merged" ? { parentMerged: true } : {}),
  };
}

/** Older peers still send full stack data in their rows. */
export function readCompactStackMemberships(thread: {
  stackMemberships?: CompactStackMembership[];
  stacks?: ThreadStackMembership[];
}): CompactStackMembership[] {
  return thread.stackMemberships ?? thread.stacks?.flatMap(({ stack, position }) =>
    compactStackMembership(stack, position) ?? []) ?? [];
}

export function stackLayerBinding(input: {
  branch: string;
  pullRequest?: number;
  worktrees: readonly StackWorktree[];
  threads: readonly StackThread[];
  lead?: StackThread;
}): StackLayerBinding {
  const paths = new Set(input.worktrees.filter((tree) => tree.branch === input.branch).map((tree) => tree.path));
  const attached = input.threads.filter((thread) => input.pullRequest !== undefined && thread.attached.includes(input.pullRequest));
  const checkedOut = input.threads.filter((thread) => thread.paths.some((path) => paths.has(path)));
  if (paths.size > 1 || checkedOut.length > 1 || attached.length > 1) return { role: "ambiguous" };
  if (checkedOut[0]) {
    const thread = checkedOut[0];
    return { role: thread.remote ? "remote" : "layer", thread };
  }
  const thread = paths.size === 0 ? attached[0] ?? input.lead : undefined;
  if (!thread) return { role: "unbound" };
  return { role: thread.remote ? "remote" : "holder", thread };
}

export function stackLayerHealth(input: {
  parent: GhStackBranch;
  branch: GhStackBranch;
  pr?: StackPullRequest;
  parentPr?: StackPullRequest;
  localHead?: string;
  parentTip?: string;
  remoteHead?: string;
  baseIsAncestor?: boolean;
  remoteIsAncestor?: boolean;
  parentIntegrated?: boolean;
  ambiguous?: boolean;
  held?: boolean;
}): StackLayerHealth {
  const { branch, localHead, parent, parentPr, parentTip, pr, remoteHead } = input;
  if (input.ambiguous) return "ambiguous";
  if (input.held) return "held";
  if (pr?.baseRefName && pr.baseRefName !== parent.branch) return "drift";
  if (remoteHead && remoteHead !== branch.head && remoteHead !== pr?.headSha && input.remoteIsAncestor === false) return "remote_ahead";
  if (parentPr ? parentPr.lifecycleState === "merged" : parent.pullRequest?.merged || input.parentIntegrated) return "parent_merged";
  if (branch.base && parentTip && (branch.base !== parentTip || input.baseIsAncestor === false)) return "needs_restack";
  if (localHead && pr?.headSha && localHead !== pr.headSha) return "needs_push";
  return branch.base && branch.base === parentTip && input.baseIsAncestor ? "in_sync" : "unknown";
}

export function isStaleStackLayer(health: StackLayerHealth): boolean {
  return health === "needs_restack" || health === "parent_merged" || health === "drift" || health === "remote_ahead";
}

/** Extract independent chains. PRs sharing only a trunk are separate components. */
export function inferPullRequestStacks<T extends StackPullRequest>(
  pullRequests: readonly T[],
  catalogBranches: ReadonlySet<string>,
): T[][] {
  const open = pullRequests.filter((pr) => pr.lifecycleState === "open" && pr.headRefName && pr.baseRefName);
  const byHead = new Map<string, T[]>();
  const byBase = new Map<string, T[]>();
  for (const pr of open) {
    for (const [index, ref] of [[byHead, pr.headRefName!], [byBase, pr.baseRefName!]] as const) {
      const entries = index.get(ref) ?? [];
      entries.push(pr);
      index.set(ref, entries);
    }
  }
  const remaining = new Set(open);
  const chains: T[][] = [];
  for (const seed of remaining) {
    const component = [seed];
    remaining.delete(seed);
    for (const pr of component) {
      for (const neighbor of [
        ...(byHead.get(pr.headRefName!) ?? []),
        ...(byHead.get(pr.baseRefName!) ?? []),
        ...(byBase.get(pr.headRefName!) ?? []),
      ]) {
        if (remaining.delete(neighbor)) component.push(neighbor);
      }
    }
    if (component.some((pr) => catalogBranches.has(pr.headRefName!) || catalogBranches.has(pr.baseRefName!))) continue;
    const chain = pullRequestStackOrder(component, (pr) => pr);
    if (chain) chains.push(chain);
  }
  return chains.sort((a, b) => a[0]!.number - b[0]!.number);
}

export function catalogMergeBlock(
  stack: GhStack,
  position: number,
  forgeBase: string | undefined,
  merged: ReadonlySet<number>,
): string | undefined {
  if (forgeBase !== stack.trunk.branch) return `The pull request must target stack trunk ${stack.trunk.branch} before it can merge.`;
  const pending = stack.branches.slice(0, position).find((branch) =>
    !branch.pullRequest || !merged.has(branch.pullRequest.number));
  if (pending) {
    const label = pending.pullRequest ? `#${pending.pullRequest.number} (${pending.branch})` : pending.branch;
    return `Wait for stack layer ${label} to merge before merging this pull request.`;
  }
}
