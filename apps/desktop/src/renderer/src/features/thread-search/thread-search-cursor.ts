/**
 * The destination picker's active row. Searches answer one after another and
 * replace the rows under the cursor, so the cursor keeps the row the operator
 * chose (with an arrow or the pointer) by key, and its position for when that
 * row is gone.
 *
 * - Typing starts over at the first row.
 * - The arrows move from the row on screen, and wrap.
 * - New rows keep the chosen row active wherever it moved. Without it, the
 *   highlight stays where it was, or on the last row if the list got shorter.
 */
export type DestinationCursor = {
  index: number;
  chosenKey?: string;
};

export const DESTINATION_CURSOR_START: DestinationCursor = { index: 0 };

/** The active row among `keys`, or -1 when there are none. */
export function activeDestinationIndex(cursor: DestinationCursor, keys: readonly string[]): number {
  if (keys.length === 0) return -1;
  const chosen = cursor.chosenKey === undefined ? -1 : keys.indexOf(cursor.chosenKey);
  return chosen >= 0 ? chosen : Math.min(cursor.index, keys.length - 1);
}

/** The cursor once `keys` replaced the rows, so a later list starts from here. */
export function settleDestinationCursor(cursor: DestinationCursor, keys: readonly string[]): DestinationCursor {
  const index = keys.length === 0 ? 0 : activeDestinationIndex(cursor, keys);
  return index === cursor.index ? cursor : { ...cursor, index };
}

export function stepDestinationCursor(
  cursor: DestinationCursor,
  keys: readonly string[],
  step: 1 | -1,
): DestinationCursor {
  if (keys.length === 0) return cursor;
  return pointDestinationCursor(keys, (activeDestinationIndex(cursor, keys) + step + keys.length) % keys.length);
}

export function pointDestinationCursor(keys: readonly string[], index: number): DestinationCursor {
  const chosenKey = keys[index];
  return chosenKey === undefined ? { index } : { index, chosenKey };
}
