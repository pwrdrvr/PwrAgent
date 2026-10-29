import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { NavigationRelativeChildMove, NavigationThreadSummary } from "@pwragent/shared";
import { useEventCallback } from "../../lib/useEventCallback";
import { useDropIndicatorController } from "./drag-drop";
import { beginPointerReorderDrag, type Point, type PointerReorderTarget } from "./pointer-reorder-drag";
import type { ThreadRowRef } from "./ThreadRow";

/** How far above or below its tray the pointer can stray and still drop. */
const TRAY_DROP_SLACK_PX = 12;

type SubthreadMove = { anchorKey: string; placement: "before" | "after" };

/**
 * Reorder a tray's direct children with the same pointer drag as pins: the
 * tilted held card, an insertion line, Escape to cancel.
 *
 * The tray element carries `data-subthread-tray` (its owner's key) and each
 * row `data-nested-depth`, so one stable callback serves every row and the
 * memoized rows keep their props. Only direct children move: a parent's
 * `subthreadOrder` ranks its own children, and a grandchild travels with the
 * child that owns it, so the line is drawn between whole subtrees.
 */
export function useSubthreadReorderDrag(params: {
  threadByKey: ReadonlyMap<string, NavigationThreadSummary>;
  onUpdateSubthreadOrder?: (
    parent: NavigationThreadSummary,
    move: NavigationRelativeChildMove,
  ) => Promise<void>;
}) {
  const dropIndicator = useDropIndicatorController();
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelRef.current?.(), []);

  return useEventCallback((event: ReactPointerEvent<HTMLDivElement>, row: ThreadRowRef) => {
    const update = params.onUpdateSubthreadOrder;
    const source = event.currentTarget;
    const tray = source.closest<HTMLElement>("[data-subthread-tray]");
    const parent = tray?.dataset.subthreadTray ? params.threadByKey.get(tray.dataset.subthreadTray) : undefined;
    const child = params.threadByKey.get(row.threadKey);
    if (event.button !== 0 || !update || !tray || !parent || !child) return;
    cancelRef.current?.();

    const siblings = (): HTMLElement[] =>
      Array.from(tray.querySelectorAll<HTMLElement>(".thread-row-shell[data-nested-depth=\"1\"]"));
    const resolveTarget = (point: Point): PointerReorderTarget<SubthreadMove> | undefined => {
      const bounds = tray.getBoundingClientRect();
      if (
        point.x < bounds.left || point.x > bounds.right
        || point.y < bounds.top - TRAY_DROP_SLACK_PX || point.y > bounds.bottom + TRAY_DROP_SLACK_PX
      ) {
        return undefined;
      }
      const rows = siblings();
      const keys = rows.map((element) => element.dataset.threadKey ?? "");
      const sourceIndex = keys.indexOf(row.threadKey);
      const before = rows.findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return point.y < rect.top + rect.height / 2;
      });
      const insertAt = before < 0 ? rows.length : before;
      if (sourceIndex < 0 || insertAt === sourceIndex || insertAt === sourceIndex + 1) return undefined;
      if (before >= 0) {
        return { element: rows[before], key: `subthread:${keys[before]}`, position: "before",
          value: { anchorKey: keys[before], placement: "before" } };
      }
      // After the last child means after its whole subtree, which ends at the
      // tray's last row.
      const shells = tray.querySelectorAll<HTMLElement>(".thread-row-shell");
      const lastShell = shells[shells.length - 1] ?? rows[rows.length - 1];
      return { element: lastShell, key: `subthread-end:${keys[keys.length - 1]}`, position: "after",
        value: { anchorKey: keys[keys.length - 1], placement: "after" } };
    };

    cancelRef.current = beginPointerReorderDrag({
      event,
      sourceElement: source,
      previewSource: source,
      clickSuppressionRoot: tray,
      scrollElement: source.closest<HTMLElement>(".sidebar-list--dense") ?? undefined,
      dropIndicator,
      resolveTarget,
      onDrop: ({ value }) => {
        const anchor = params.threadByKey.get(value.anchorKey);
        if (!anchor) return;
        void update(parent, { threadId: child.id, anchorThreadId: anchor.id, placement: value.placement });
      },
    });
  });
}
