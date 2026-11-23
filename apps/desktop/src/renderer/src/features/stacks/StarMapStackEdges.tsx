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
    const x1 = from.x + from.width;
    const x2 = to.x + to.width;
    const radius = 10;
    const gutter = Math.max(x1, x2) + 16 + (member.position % 3) * 7;
    // Offset the two ports when cards overlap so there is still a visible
    // outside segment, with room to read the dash pattern and arrowhead.
    const y1 = from.y + from.height * 0.65;
    const endY = to.y + to.height * 0.35;
    const y2 = Math.abs(endY - y1) < 2 * radius ? to.y + to.height * 0.82 : endY;
    const bend = Math.min(radius, Math.abs(y1 - y2) / 2);
    const direction = Math.sign(y2 - y1);
    return [{
      key,
      d: `M ${x1} ${y1} H ${gutter - bend} Q ${gutter} ${y1} ${gutter} ${y1 + bend * direction} V ${y2 - bend * direction} Q ${gutter} ${y2} ${gutter - bend} ${y2} H ${x2}`,
      arrow: `M ${x2 + 7} ${y2 - 4} L ${x2} ${y2} L ${x2 + 7} ${y2 + 4}`,
      state: member.parentMerged ? "merged" : isStaleStackLayer(member.health) ? "stale" : "healthy",
      inferred: member.inferred,
    }];
  });
  if (!edges.length) return null;
  return (
    <svg className="star-map__stacks" aria-hidden="true">
      {edges.map(({ key, d, arrow, state, inferred }) => (
        <g key={key} data-state={state} data-inferred={inferred || undefined}>
          <path d={d} className="star-map__stack-halo" />
          <path d={d} className="star-map__stack-edge" />
          <path d={arrow} />
        </g>
      ))}
    </svg>
  );
});
