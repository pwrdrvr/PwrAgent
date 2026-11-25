import { buildThreadIdentityKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { describeStackAutomationBlock } from "@pwragent/shared/stacks/stack-automation";
import { compactStackMembership, readCompactStackMemberships, type CompactStackMembership, type StackLayerHealth, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import { prPhaseLabel, resolveLifecycleState } from "../pr-status/pr-chip-state";

export const stackRepository = (pr: PrSummary) => `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase();

export function stackMembershipForPr(thread: NavigationThreadSummary, pr: PrSummary) {
  const repository = stackRepository(pr);
  return readCompactStackMemberships(thread).find((layer) => layer.repository === repository && layer.number === pr.number);
}

export function stackHoldForPr(thread: NavigationThreadSummary, pr: PrSummary) {
  return stackMembershipForPr(thread, pr)?.heldBy;
}

export function showsStackTag(member: CompactStackMembership, pr: PrSummary, thread: NavigationThreadSummary) {
  if (member.count < 2) return false;
  if (member.hasOpenPr !== undefined) return member.hasOpenPr;
  // Older compact rows can still prove that a member of this stack is open.
  return resolveLifecycleState(pr) === "open" || thread.prs?.some((candidate) =>
    resolveLifecycleState(candidate) === "open" && stackMembershipForPr(thread, candidate)?.key === member.key);
}

export function stackThreadKey(thread: NavigationThreadSummary) {
  // Stack detail is produced by one owner. Its layer keys are local to it.
  return buildThreadIdentityKey(thread.source, thread.id);
}

const healthLabels: Partial<Record<StackLayerHealth, string>> = {
  needs_restack: "needs restack",
  parent_merged: "parent merged · needs sync",
  needs_push: "needs push",
  remote_ahead: "remote has newer commits",
  drift: "moved outside the stack",
  held: "stack operation in progress",
};

export function stackHoldLabel(block: NonNullable<CompactStackMembership["heldBy"]>) {
  return describeStackAutomationBlock(block, " ").replace(/^Held by /, "held · ")
    .replace(/settlement unknown$/, "has yet to settle");
}

export function stackHealthLabel(layer: Pick<CompactStackMembership, "health" | "heldBy">) {
  return layer.heldBy
    ? `merge ${stackHoldLabel(layer.heldBy)}`
    : healthLabels[layer.health];
}

export function staleStackSpine(health: StackLayerHealth) {
  return health === "needs_restack" || health === "parent_merged";
}

export function knownPrStatus(label: string) {
  return label.split(" · ").filter((part) => part !== "status unknown").join(" · ");
}

export function stackLayerReadiness(pr: PrSummary | undefined, status: string | undefined, health: string | undefined) {
  if (!health) return status;
  return pr && prPhaseLabel(pr) === "draft" ? "draft" : undefined;
}

export type StackRollupRow = { pr: PrSummary; member?: CompactStackMembership };

/**
 * The rollup's rows in one flat list. A stacked PR keeps the row every other
 * PR has and says where it sits (`2/4`), so a thread holding part of a stack,
 * or several stacks beside loose PRs, reads as one list. A stack's attached
 * PRs run together, top first, from where its first one falls in the
 * rollup's order; every other PR keeps that order.
 */
export function orderStackRollup(
  ordered: readonly PrSummary[],
  thread: NavigationThreadSummary | undefined,
  details?: readonly StackSummary[],
): StackRollupRow[] {
  if (!thread) return ordered.map((pr) => ({ pr }));
  const memberships = new Map<string, CompactStackMembership>();
  for (const member of readCompactStackMemberships(thread)) {
    const identity = `${member.repository}#${member.number}`;
    if (!memberships.has(identity)) memberships.set(identity, member);
  }
  // The compact preview is capped; the owner's stacks place the rest.
  for (const stack of details ?? []) {
    const hasOpenPr = stack.layers.some((layer) => layer.pullRequest?.lifecycleState === "open");
    for (const [index, layer] of stack.layers.entries()) {
      const identity = `${stack.repository}#${layer.pullRequest?.number}`;
      if (!memberships.has(identity)) memberships.set(identity, compactStackMembership(stack, index + 1, hasOpenPr)!);
    }
  }
  const runs = new Map<string, StackRollupRow[]>();
  const slots: StackRollupRow[][] = [];
  for (const pr of ordered) {
    const member = memberships.get(`${stackRepository(pr)}#${pr.number}`);
    if (!member || member.count < 2) {
      slots.push([{ pr }]);
      continue;
    }
    let run = runs.get(member.key);
    if (!run) {
      run = [];
      runs.set(member.key, run);
      slots.push(run);
    }
    run.push({ pr, member });
  }
  for (const run of runs.values()) run.sort((a, b) => b.member!.position - a.member!.position);
  return slots.flat();
}
