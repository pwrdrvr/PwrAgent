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

export type StackRollupGroup = {
  stack: CompactStackMembership;
  trunk: string;
  rows: { pr: PrSummary; member: CompactStackMembership }[];
};

export function groupStackRollup(
  ordered: readonly PrSummary[],
  thread: NavigationThreadSummary | undefined,
  details?: readonly StackSummary[],
): Array<PrSummary | StackRollupGroup> {
  if (!thread) return [...ordered];
  const memberships = new Map<string, CompactStackMembership>();
  for (const member of readCompactStackMemberships(thread)) {
    const identity = `${member.repository}#${member.number}`;
    if (!memberships.has(identity)) memberships.set(identity, member);
  }
  if (details) {
    const attached = new Set(ordered.map((pr) => `${stackRepository(pr)}#${pr.number}`));
    for (const stack of details) {
      const hasOpenPr = stack.layers.some((layer) => layer.pullRequest?.lifecycleState === "open");
      for (const [index, layer] of stack.layers.entries()) {
        const identity = `${stack.repository}#${layer.pullRequest?.number}`;
        if (!attached.has(identity)) continue;
        const compact = memberships.get(identity);
        if (!compact || (compact.key === stack.key && !compact.trunk)) {
          memberships.set(identity, compactStackMembership(stack, index + 1, hasOpenPr)!);
        }
      }
    }
  }
  const trunks = new Map<string, string>();
  for (const pr of ordered) {
    const member = memberships.get(`${stackRepository(pr)}#${pr.number}`);
    // The lowest attached PR supplies a trunk for compact rows from older peers.
    const trunk = member?.trunk ?? (member?.position === 1 ? pr.baseRefName : undefined);
    if (member && trunk) trunks.set(member.key, trunk);
  }
  const groups = new Map<string, StackRollupGroup>();
  const list: Array<PrSummary | StackRollupGroup> = [];
  for (const pr of ordered) {
    const member = memberships.get(`${stackRepository(pr)}#${pr.number}`);
    const trunk = member && trunks.get(member.key);
    if (!member || !trunk || member.count < 2) {
      list.push(pr);
      continue;
    }
    // The input is open-first, newest-first, so the first attached member
    // sets the group's slot even when its bottom layer has since merged.
    let group = groups.get(member.key);
    if (!group) {
      group = { stack: member, trunk, rows: [] };
      groups.set(member.key, group);
      list.push(group);
    }
    group.rows.push({ pr, member });
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) => b.member.position - a.member.position);
  }
  return list;
}
