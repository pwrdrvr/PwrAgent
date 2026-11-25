import { createContext } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { StartingTrayEntry } from "../navigation/StartingThreadRow";
import { readCompactStackMemberships } from "@pwragent/shared/stacks/stack-status";
import { resolveThreadParentKey } from "@pwragent/shared/subthreads";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";

export const StackRailContext = createContext<((thread: NavigationThreadSummary) => void) | undefined>(undefined);

export function visibleStackTray(parent: NavigationThreadSummary, children: readonly NavigationThreadSummary[]): string | undefined {
  const childKeys = new Set(children.flatMap((child) => readCompactStackMemberships(child).map(({ key }) => key)));
  return readCompactStackMemberships(parent).find(({ key }) => childKeys.has(key))?.key;
}

export { stackHoldForPr } from "./stack-pr-data";

function positionIn(stackKey: string, thread: NavigationThreadSummary) {
  return readCompactStackMemberships(thread).find(({ key }) => key === stackKey)?.position ?? 0;
}

/**
 * Order stack siblings within each tray while carrying each sibling's subtree.
 * The tray is drawn below its lead row like every other tray, so each group
 * of sibling layers is ordered by its distance in the stack from the row it
 * hangs under, nearest first: a lead on layer 1 reads 1, 2, 3 and a lead on
 * layer 3 reads 3, 2, 1. `lead` is the tray's own row.
 */
export function orderStackTray(
  tray: StartingTrayEntry[],
  stackKey: string | undefined,
  lead?: NavigationThreadSummary,
): StartingTrayEntry[] {
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
    const parentThread = parent === undefined ? lead : threads.get(parent);
    const from = parentThread ? positionIn(stackKey, parentThread) : 0;
    const distance = (entry: StartingTrayEntry) => Math.abs(position(entry) - from);
    const layers = siblings.filter((entry) => position(entry))
      .sort((a, b) => distance(a) - distance(b) || position(a) - position(b));
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

/** Keyboard ranges follow the same order as the rendered stack tray. */
export function stackGroupSelectionOrder(parent: NavigationThreadSummary, children: readonly NavigationThreadSummary[]) {
  const key = visibleStackTray(parent, children);
  if (!key) return [parent, ...children];
  const ordered = orderStackTray(children.map((thread) => ({ kind: "thread", thread })), key, parent)
    .flatMap((entry) => entry.kind === "thread" ? [entry.thread] : []);
  return [parent, ...ordered];
}
