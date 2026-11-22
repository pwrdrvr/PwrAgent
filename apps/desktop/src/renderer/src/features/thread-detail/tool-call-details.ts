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
