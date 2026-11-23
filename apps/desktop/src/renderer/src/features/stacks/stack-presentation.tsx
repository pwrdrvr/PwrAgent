import { createContext, useContext } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { isStaleStackLayer } from "@pwragent/shared/stacks/stack-status";

export const StackRailContext = createContext<((thread: NavigationThreadSummary) => void) | undefined>(undefined);

export function StackPositionChips({ thread }: { thread: NavigationThreadSummary }) {
  const openRail = useContext(StackRailContext);
  return thread.stacks?.map(({ stack, position }) => {
    const layer = stack.layers[position - 1];
    if (!layer) return null;
    const text = `${position}/${stack.layers.length}`;
    const detail = `${text} in ${stack.inferred ? "inferred " : ""}stack ${stack.name} · ${layer.health.replaceAll("_", " ")}`;
    const className = "thread-row__chip thread-row__chip--persistent thread-row__chip--essential stack-position-chip tooltip-target";
    const stale = isStaleStackLayer(layer.health) ? true : undefined;
    return openRail
      ? <button key={stack.key} type="button" className={className} data-stale={stale} data-tooltip={detail} aria-label={`Open stack ${detail}`} onClick={(event) => {
          event.stopPropagation();
          openRail(thread);
        }}>{text}</button>
      : <span key={stack.key} className={className} data-stale={stale} data-tooltip={detail}>{text}</span>;
  });
}

export function visibleStackTray(parent: NavigationThreadSummary, children: readonly NavigationThreadSummary[]): string | undefined {
  return parent.stacks?.find(({ stack }) => children.some((child) =>
    child.stacks?.some((entry) => entry.stack.key === stack.key)))?.stack.key;
}
