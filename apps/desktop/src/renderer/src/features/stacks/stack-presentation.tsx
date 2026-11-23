import { createContext, useContext } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { describeStackAutomationBlock } from "@pwragent/shared/stacks/stack-automation";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type { StartingTrayEntry } from "../navigation/StartingThreadRow";
import { isStaleStackLayer, readCompactStackMemberships } from "@pwragent/shared/stacks/stack-status";
import { resolveThreadParentKey } from "@pwragent/shared/subthreads";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";

export const StackRailContext = createContext<((thread: NavigationThreadSummary) => void) | undefined>(undefined);

export function StackPositionChips({ thread }: { thread: NavigationThreadSummary }) {
  const openRail = useContext(StackRailContext);
  return readCompactStackMemberships(thread).map(({ key, position, count, inferred, name, health, heldBy }) => {
    const hold = heldBy && describeStackAutomationBlock(heldBy, " · ");
    const text = hold ? `${position}/${count} · ${hold}` : health === "held" ? `${position}/${count} · Held` : `${position}/${count}`;
    const detail = `${text} in ${inferred ? "inferred " : ""}stack ${name}${hold ? "" : ` · ${health.replaceAll("_", " ")}`}`;
    const className = "thread-row__chip thread-row__chip--persistent thread-row__chip--essential stack-position-chip tooltip-target";
    const stale = !hold && isStaleStackLayer(health) ? true : undefined;
    const held = Boolean(hold) || health === "held" || undefined;
    return openRail
      ? <button key={key} type="button" className={className} data-stale={stale} data-held={held} data-tooltip={detail} aria-label={`Open stack ${detail}`} onClick={(event) => {
          event.stopPropagation();
          openRail(thread);
        }}>{text}</button>
      : <span key={key} className={className} data-stale={stale} data-held={held} data-tooltip={detail}>{text}</span>;
  });
}

export function visibleStackTray(parent: NavigationThreadSummary, children: readonly NavigationThreadSummary[]): string | undefined {
  const childKeys = new Set(children.flatMap((child) => readCompactStackMemberships(child).map(({ key }) => key)));
  return readCompactStackMemberships(parent).find(({ key }) => childKeys.has(key))?.key;
}

export function stackHoldForPr(thread: NavigationThreadSummary, pr: PrSummary) {
  const repository = `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase();
  return readCompactStackMemberships(thread).find((layer) => layer.repository === repository && layer.number === pr.number)?.heldBy;
}

function positionIn(stackKey: string, thread: NavigationThreadSummary) {
  return readCompactStackMemberships(thread).find(({ key }) => key === stackKey)?.position ?? 0;
}

/** Order stack siblings within each tray while carrying each sibling's subtree. */
export function orderStackTray(tray: StartingTrayEntry[], stackKey: string | undefined): StartingTrayEntry[] {
  if (!stackKey) return tray;
  const threads = new Map(tray.flatMap((entry) => entry.kind === "thread"
    ? [[threadSummaryIdentityKey(entry.thread), entry.thread] as const] : []));
  const children = new Map<string | undefined, StartingTrayEntry[]>();
  for (const entry of tray) {
    const parent = entry.kind === "thread"
      ? resolveThreadParentKey(entry.thread, threads) : entry.creation.parentThreadKey;
    const key = parent && threads.has(parent) ? parent : undefined;
    const siblings = children.get(key) ?? [];
    siblings.push(entry);
    children.set(key, siblings);
  }
  const position = (entry: StartingTrayEntry) => entry.kind === "thread" ? positionIn(stackKey, entry.thread) : 0;
  const ordered: StartingTrayEntry[] = [];
  const append = (parent: string | undefined) => {
    const siblings = children.get(parent) ?? [];
    const layers = siblings.filter((entry) => position(entry)).sort((a, b) => position(b) - position(a));
    let index = 0;
    for (const sibling of siblings) {
      const entry = position(sibling) ? layers[index++]! : sibling;
      ordered.push(entry);
      if (entry.kind === "thread") append(threadSummaryIdentityKey(entry.thread));
    }
  };
  append(undefined);
  return ordered.length === tray.length ? ordered : tray;
}

export function stackTrayPrecedesLead(parent: NavigationThreadSummary, children: readonly NavigationThreadSummary[]): boolean {
  const key = visibleStackTray(parent, children);
  return Boolean(key && positionIn(key, parent) === 1);
}

/** Keyboard ranges follow the same order as the rendered stack tray. */
export function stackGroupSelectionOrder(parent: NavigationThreadSummary, children: readonly NavigationThreadSummary[]) {
  const key = visibleStackTray(parent, children);
  if (!key) return [parent, ...children];
  const ordered = orderStackTray(children.map((thread) => ({ kind: "thread", thread })), key)
    .flatMap((entry) => entry.kind === "thread" ? [entry.thread] : []);
  return positionIn(key, parent) === 1 ? [...ordered, parent] : [parent, ...ordered];
}
