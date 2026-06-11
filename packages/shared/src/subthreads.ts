import type { NavigationThreadSummary } from "./contracts/navigation";

type SubthreadParent = Pick<NavigationThreadSummary, "subthreadOrder">;
type SubthreadChild = Pick<NavigationThreadSummary, "id" | "createdAt">;

/**
 * Order a parent's child threads for display. Children explicitly listed in the
 * parent's `subthreadOrder` come first, in that order; any remaining children
 * fall back to newest-first by `createdAt`. This is the single source of truth
 * shared by the sidebar list views and the navigation hook so the "born here,
 * stays here" tray order stays consistent.
 */
export function sortSubthreadSummaries<T extends SubthreadChild>(
  parent: SubthreadParent,
  children: T[],
): T[] {
  const order = new Map(
    (parent.subthreadOrder ?? []).map((threadId, index) => [threadId, index]),
  );
  return [...children].sort((left, right) => {
    const leftRank = order.get(left.id);
    const rightRank = order.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      return (
        (leftRank ?? Number.MAX_SAFE_INTEGER) -
        (rightRank ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return (right.createdAt ?? 0) - (left.createdAt ?? 0);
  });
}

/**
 * Return a new child-id order with `newId` placed immediately after `sourceId`.
 * When `sourceId` is not in the list — i.e. the source card is the group root
 * rather than a sibling child — `newId` is prepended so the new child lands at
 * the top of the tray, directly below the root card. Any pre-existing instance
 * of `newId` is removed first so repeated inserts stay idempotent.
 */
export function insertSubthreadIdAfter(
  orderedChildIds: string[],
  sourceId: string,
  newId: string,
): string[] {
  const withoutNew = orderedChildIds.filter((id) => id !== newId);
  const sourceIndex = withoutNew.indexOf(sourceId);
  if (sourceIndex === -1) {
    return [newId, ...withoutNew];
  }
  return [
    ...withoutNew.slice(0, sourceIndex + 1),
    newId,
    ...withoutNew.slice(sourceIndex + 1),
  ];
}
