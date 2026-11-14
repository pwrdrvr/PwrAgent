import { useLayoutEffect, useMemo, useRef } from "react";

const EMPTY_KEYS: Record<string, boolean> = Object.freeze({});

/** Project session membership without rebuilding records for transcript updates. */
export function projectSessionIndicatorKeys<T>(
  sessions: Readonly<Record<string, T>>,
  includes: (session: T) => boolean,
  previous: Record<string, boolean>,
): Record<string, boolean> {
  let next = previous;
  for (const key in sessions) {
    if (!Object.hasOwn(sessions, key)) continue;
    const included = includes(sessions[key]!);
    if (included === (previous[key] === true)) continue;
    if (next === previous) next = { ...previous };
    if (included) {
      Object.defineProperty(next, key, {
        value: true, enumerable: true, configurable: true, writable: true,
      });
    } else {
      delete next[key];
    }
  }
  for (const key in previous) {
    if (Object.hasOwn(sessions, key)) continue;
    if (next === previous) next = { ...previous };
    delete next[key];
  }
  return next;
}

export function useSessionIndicatorKeys<T>(
  sessions: Readonly<Record<string, T>>,
  includes: (session: T) => boolean,
): Record<string, boolean> {
  const committed = useRef(EMPTY_KEYS);
  const keys = useMemo(
    () => projectSessionIndicatorKeys(sessions, includes, committed.current),
    [sessions, includes],
  );
  // An abandoned render must not publish its projection as the baseline.
  useLayoutEffect(() => { committed.current = keys; }, [keys]);
  return keys;
}
