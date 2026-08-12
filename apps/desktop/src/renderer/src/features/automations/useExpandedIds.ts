import { useCallback, useMemo, useState } from "react";

export type ExpandedIds = {
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  expand: (id: string) => void;
};

/**
 * Disclosure state for a list where more than one row may be open.
 *
 * These lists used to hold a single open id, which made opening a second row
 * close the first — and closing a row that held a long run transcript removed
 * thousands of pixels from the page, so the browser clamped the scroll and
 * both the page and the run list jumped back to the top. Comparing two runs
 * was impossible for the same reason. A set costs nothing and none of that
 * happens: opening a row only ever adds content, below the row you clicked.
 */
export function useExpandedIds(): ExpandedIds {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  const isExpanded = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback((id: string) => {
    setIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const expand = useCallback((id: string) => {
    setIds((current) => (current.has(id) ? current : new Set(current).add(id)));
  }, []);

  return useMemo(
    () => ({ isExpanded, toggle, expand }),
    [isExpanded, toggle, expand],
  );
}
