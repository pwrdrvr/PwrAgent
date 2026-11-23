import { memo } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { compactStackMembership, isStaleStackLayer, type CompactStackMembership } from "@pwragent/shared/stacks/stack-status";

type Rect = { x: number; y: number; width: number; height: number };

export const StarMapStackEdges = memo(function StarMapStackEdges({
  threads, rects, instanceId,
}: {
  threads: readonly Pick<NavigationThreadSummary, "stacks" | "stackMemberships">[];
  rects: ReadonlyMap<string, Rect>;
  instanceId: string | undefined;
}) {
  const memberships = new Map<string, CompactStackMembership>();
  const seenLegacyStacks = new Set<string>();
  for (const thread of threads) {
    for (const member of thread.stackMemberships ?? []) memberships.set(`${member.key}:${member.position}`, member);
    for (const { stack } of thread.stacks ?? []) {
      if (seenLegacyStacks.has(stack.key)) continue;
      seenLegacyStacks.add(stack.key);
      for (let position = 2; position <= stack.layers.length; position++) {
        const member = compactStackMembership(stack, position);
        if (member) memberships.set(`${member.key}:${position}`, member);
      }
    }
  }
  const edges = [...memberships].flatMap(([key, member]) => {
    if (!member.parentThreadKey || !member.threadKey || member.parentThreadKey === member.threadKey) return [];
    const from = rects.get(`${instanceId}::${member.parentThreadKey}`);
    const to = rects.get(`${instanceId}::${member.threadKey}`);
    if (!from || !to) return [];
    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height / 2;
    const x2 = to.x + to.width / 2;
    const y2 = to.y + to.height / 2;
    const midY = (y1 + y2) / 2;
    return [{
      key,
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
      state: member.parentMerged ? "merged" : isStaleStackLayer(member.health) ? "stale" : "healthy",
      inferred: member.inferred,
    }];
  });
  if (!edges.length) return null;
  return (
    <svg className="star-map__stacks" aria-hidden="true">
      {edges.map(({ key, d, state, inferred }) => <path key={key} d={d} data-state={state} data-inferred={inferred || undefined} />)}
    </svg>
  );
});
