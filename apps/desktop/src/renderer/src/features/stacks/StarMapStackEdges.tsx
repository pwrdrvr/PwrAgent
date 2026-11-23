import { memo } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { isStaleStackLayer } from "@pwragent/shared/stacks/stack-status";

type Rect = { x: number; y: number; width: number; height: number };

export const StarMapStackEdges = memo(function StarMapStackEdges({
  threads, rects, instanceId,
}: {
  threads: readonly Pick<NavigationThreadSummary, "stacks">[];
  rects: ReadonlyMap<string, Rect>;
  instanceId: string | undefined;
}) {
  const stacks = new Map(threads.flatMap((thread) => thread.stacks?.map(({ stack }) => [stack.key, stack] as const) ?? []));
  const edges = [...stacks.values()].flatMap((stack) => stack.layers.flatMap((child, i) => {
    const parent = stack.layers[i - 1];
    if (!parent?.thread || !child.thread || parent.thread.key === child.thread.key) return [];
    const from = rects.get(`${instanceId}::${parent.thread.key}`);
    const to = rects.get(`${instanceId}::${child.thread.key}`);
    if (!from || !to) return [];
    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height / 2;
    const x2 = to.x + to.width / 2;
    const y2 = to.y + to.height / 2;
    const midY = (y1 + y2) / 2;
    return [{
      key: `${stack.key}:${child.branch}`,
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
      state: parent.pullRequest?.lifecycleState === "merged" ? "merged" : isStaleStackLayer(child.health) ? "stale" : "healthy",
      inferred: stack.inferred,
    }];
  }));
  if (!edges.length) return null;
  return (
    <svg className="star-map__stacks" aria-hidden="true">
      {edges.map(({ key, d, state, inferred }) => <path key={key} d={d} data-state={state} data-inferred={inferred || undefined} />)}
    </svg>
  );
});
