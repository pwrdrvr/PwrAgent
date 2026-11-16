import { useLayoutEffect, useMemo, useRef } from "react";

const EMPTY_GROUPS: ReadonlyMap<string, never[]> = new Map();

/** Group in owner order, copying an array only when that thread changes. */
export function shareThreadItemGroups<T>(
  previous: ReadonlyMap<string, T[]>,
  items: readonly T[],
  keyOf: (item: T) => string,
  sameItem: (left: T, right: T) => boolean,
): ReadonlyMap<string, T[]> {
  if (items.length === 0) return previous.size === 0 ? previous : EMPTY_GROUPS;
  const next = new Map<string, T[]>();
  const lengths = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    const index = lengths.get(key) ?? 0;
    const old = previous.get(key);
    let group = next.get(key);
    if (!group) {
      group = old ?? [];
      next.set(key, group);
    }
    if (old && group === old) {
      if (index >= old.length || !sameItem(old[index]!, item)) {
        group = old.slice(0, index);
        group.push(item);
        next.set(key, group);
      }
    } else group.push(item);
    lengths.set(key, index + 1);
  }
  for (const [key, group] of next) {
    const length = lengths.get(key)!;
    if (group === previous.get(key) && group.length !== length) next.set(key, group.slice(0, length));
  }
  // Map iteration order also follows the owner; equal groups alone do not
  // justify retaining a differently ordered map.
  if (next.size === previous.size) {
    const entries = previous.entries();
    for (const [key, group] of next) {
      const old = entries.next().value!;
      if (old[0] !== key || old[1] !== group) return next;
    }
    return previous;
  }
  return next;
}

export function useThreadItemGroups<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  sameItem: (left: T, right: T) => boolean,
): ReadonlyMap<string, T[]> {
  const previous = useRef<ReadonlyMap<string, T[]>>(EMPTY_GROUPS);
  const groups = useMemo(() => shareThreadItemGroups(previous.current, items, keyOf, sameItem), [items, keyOf, sameItem]);
  // An interrupted render must not replace the committed projection's cache.
  useLayoutEffect(() => { previous.current = groups; }, [groups]);
  return groups;
}
