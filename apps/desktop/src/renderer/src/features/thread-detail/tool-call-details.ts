import type { AppServerThreadEntry } from "@pwragent/shared";

export function detailMatchesInvocationItem(
  detailId: string,
  itemId: string,
): boolean {
  return (
    detailId === itemId
    || detailId.startsWith(`${itemId}-`)
    || detailId.startsWith(`${itemId}:`)
  );
}

export function findTranscriptCommandDetailEntryIndex(
  entries: AppServerThreadEntry[],
  itemId: string,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "activity"
      && entry.details.some(
        (detail) =>
          Boolean(detail.command)
          && detailMatchesInvocationItem(detail.id, itemId),
      )
    ) {
      return index;
    }
  }
  return -1;
}
