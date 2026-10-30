import type { NavigationThreadSummary } from "@pwragent/shared";
import { resolveThreadParentKey } from "@pwragent/shared";
import {
  federationTargetsEqual,
  threadSummaryIdentityKey,
  threadSupportsFederationCapability,
} from "../../lib/federated-thread-events";

/** Printed on the held card while a drop would nest it. */
export const NEST_DROP_LABEL = "Make sub-thread";

/** Mirrors the owner's own loop check, which has the final word. */
const MAX_PARENT_WALK = 64;

/**
 * Whether dropping `child` on `parent` makes a link the owner will keep.
 * The owner refuses a loop; the rest would be a no-op or a link that
 * belongs to another instance:
 *
 * - A sub-agent row is the provider's, not an ordinary thread.
 * - Both threads must live on one owner. The child's owner stores the
 *   link, and a window cannot write a link to another instance's thread.
 * - Dropping a child on the parent it already has changes nothing.
 * - A thread cannot move under one of its own sub-threads.
 */
export function canNestThread(
  child: NavigationThreadSummary,
  parent: NavigationThreadSummary,
  threadByKey: ReadonlyMap<string, NavigationThreadSummary>,
): boolean {
  const childKey = threadSummaryIdentityKey(child);
  const parentKey = threadSummaryIdentityKey(parent);
  if (childKey === parentKey) return false;
  if (child.codexNativeSubAgent !== undefined || parent.codexNativeSubAgent !== undefined) return false;
  if (
    !threadSupportsFederationCapability(child, "thread_grouping")
    || !threadSupportsFederationCapability(parent, "thread_grouping")
  ) {
    return false;
  }
  if (child.federation?.derivedFromMountedParent || parent.federation?.derivedFromMountedParent) return false;
  if (!federationTargetsEqual(child.federation?.ref.target, parent.federation?.ref.target)) return false;
  if (resolveThreadParentKey(child, threadByKey) === parentKey) return false;

  const seen = new Set<string>();
  let cursor: NavigationThreadSummary | undefined = parent;
  while (cursor && seen.size < MAX_PARENT_WALK) {
    const key = threadSummaryIdentityKey(cursor);
    if (key === childKey) return false;
    if (seen.has(key)) break;
    seen.add(key);
    const next: string | undefined = resolveThreadParentKey(cursor, threadByKey);
    cursor = next ? threadByKey.get(next) : undefined;
  }
  return true;
}

/**
 * The thread row under `point` that the dragged thread could nest under.
 * Only rows inside `root` count, so a drag in one list never lands in
 * another window region that happens to render rows.
 */
export function resolveThreadNestTarget(params: {
  point: { x: number; y: number };
  root: HTMLElement;
  childKey: string;
  threadByKey: ReadonlyMap<string, NavigationThreadSummary>;
}): { element: HTMLElement; parent: NavigationThreadSummary } | undefined {
  const element = threadRowShellAt(params.point, params.root);
  const parentKey = element?.dataset.threadKey;
  const parent = parentKey ? params.threadByKey.get(parentKey) : undefined;
  const child = params.threadByKey.get(params.childKey);
  if (!element || !parent || !child) return undefined;
  return canNestThread(child, parent, params.threadByKey)
    ? { element, parent }
    : undefined;
}

export function threadRowShellAt(
  point: { x: number; y: number },
  root: HTMLElement,
): HTMLElement | undefined {
  if (typeof document.elementFromPoint === "function") {
    const row = document.elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(".thread-row-shell[data-thread-key]");
    return row && root.contains(row) ? row : undefined;
  }
  // jsdom has no layout hit test; walk the rows' boxes instead.
  for (const row of root.querySelectorAll<HTMLElement>(".thread-row-shell[data-thread-key]")) {
    const bounds = row.getBoundingClientRect();
    if (
      bounds.right > bounds.left && bounds.bottom > bounds.top
      && point.x >= bounds.left && point.x <= bounds.right
      && point.y >= bounds.top && point.y <= bounds.bottom
    ) {
      return row;
    }
  }
  return undefined;
}

/**
 * The middle half of a pinned row nests; its top and bottom quarters keep
 * the pin-order line. A row that is not a reorder target nests anywhere.
 */
export function isInNestBand(element: HTMLElement, y: number): boolean {
  const bounds = element.getBoundingClientRect();
  const quarter = (bounds.bottom - bounds.top) / 4;
  return y >= bounds.top + quarter && y <= bounds.bottom - quarter;
}
