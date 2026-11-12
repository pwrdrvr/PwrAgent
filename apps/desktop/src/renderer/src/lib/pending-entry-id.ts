/**
 * Id prefix of a transcript entry this window holds while the owner has not
 * recorded it yet: the pending copy of a sent message, a launchpad
 * placeholder or a review request. The operator wrote each one here.
 */
export const PENDING_ENTRY_ID_PREFIX = "optimistic-";

export function isPendingEntryId(id: string): boolean {
  return id.startsWith(PENDING_ENTRY_ID_PREFIX);
}
