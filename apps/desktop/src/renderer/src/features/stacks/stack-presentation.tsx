import { createContext, useContext } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { isStaleStackLayer, readCompactStackMemberships } from "@pwragent/shared/stacks/stack-status";

export const StackRailContext = createContext<((thread: NavigationThreadSummary) => void) | undefined>(undefined);

export function StackPositionChips({ thread }: { thread: NavigationThreadSummary }) {
  const openRail = useContext(StackRailContext);
  return readCompactStackMemberships(thread).map(({ key, position, count, inferred, name, health }) => {
    const text = health === "held" ? `${position}/${count} · Held` : `${position}/${count}`;
    const detail = `${text} in ${inferred ? "inferred " : ""}stack ${name} · ${health.replaceAll("_", " ")}`;
    const className = `thread-row__chip thread-row__chip--persistent thread-row__chip--essential stack-position-chip tooltip-target${health === "held" ? " thread-row__chip--held" : ""}`;
    const stale = isStaleStackLayer(health) ? true : undefined;
    return openRail
      ? <button key={key} type="button" className={className} data-stale={stale} data-tooltip={detail} aria-label={`Open stack ${detail}`} onClick={(event) => {
          event.stopPropagation();
          openRail(thread);
        }}>{text}</button>
      : <span key={key} className={className} data-stale={stale} data-tooltip={detail}>{text}</span>;
  });
}

export function visibleStackTray(parent: NavigationThreadSummary, children: readonly NavigationThreadSummary[]): string | undefined {
  const childKeys = new Set(children.flatMap((child) => readCompactStackMemberships(child).map(({ key }) => key)));
  return readCompactStackMemberships(parent).find(({ key }) => childKeys.has(key))?.key;
}
