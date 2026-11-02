import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { NavigationRelativeChildMove, NavigationThreadSummary } from "@pwragent/shared";
import { useEventCallback } from "../../lib/useEventCallback";
import { useDropIndicatorController } from "./drag-drop";
import { beginPointerReorderDrag, type Point, type PointerReorderTarget } from "./pointer-reorder-drag";
import {
  canNestThread,
  isInNestBand,
  nestDropTarget,
  resolveThreadNestTarget,
  threadDragLane,
  type NestThreadHandler,
} from "./thread-nest-drop";
import type { ThreadRowRef } from "./ThreadRow";

/** How far above or below its tray the pointer can stray and still drop. */
const TRAY_DROP_SLACK_PX = 12;

type SubthreadDrop =
  | { kind: "reorder"; anchorKey: string; placement: "before" | "after" }
  | { kind: "nest"; parent: NavigationThreadSummary };

/**
 * Reorder a tray's direct children with the same pointer drag as pins: the
 * tilted held card, an insertion line, Escape to cancel.
 *
 * The tray element carries `data-subthread-tray` (its owner's key) and each
 * row `data-nested-depth`, so one stable callback serves every row and the
 * memoized rows keep their props. Only direct children reorder: a parent's
 * `subthreadOrder` ranks its own children, and a grandchild travels with the
 * child that owns it, so the line is drawn between whole subtrees.
 *
 * A deeper row is not among `siblings()`. Dropped in a gap between them, it
 * moves up to the tray's owner and lands in that gap: the owner takes the new
 * parent first, then the move anchored on the gap's neighbour.
 *
 * A child dropped on another row becomes that row's sub-thread instead:
 * anywhere on a row outside its tray, on a deeper row in it, or on the middle
 * third of a direct child, whose edges keep the reorder line.
 */
export function useSubthreadReorderDrag(params: {
  threadByKey: ReadonlyMap<string, NavigationThreadSummary>;
  onUpdateSubthreadOrder?: (
    parent: NavigationThreadSummary,
    move: NavigationRelativeChildMove,
  ) => Promise<void>;
  onNestThread?: NestThreadHandler;
}) {
  const dropIndicator = useDropIndicatorController();
  const disposeDragRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => disposeDragRef.current?.(), []);

  return useEventCallback((event: ReactPointerEvent<HTMLDivElement>, row: ThreadRowRef) => {
    const update = params.onUpdateSubthreadOrder;
    const nestThread = params.onNestThread;
    const source = event.currentTarget;
    const tray = source.closest<HTMLElement>("[data-subthread-tray]");
    const parent = tray?.dataset.subthreadTray ? params.threadByKey.get(tray.dataset.subthreadTray) : undefined;
    const child = params.threadByKey.get(row.threadKey);
    if (event.button !== 0 || (!update && !nestThread) || !tray || !parent || !child) return;
    disposeDragRef.current?.();

    // A deeper row lands in a gap only when it can move up to the owner.
    const movesUp = source.dataset.nestedDepth !== "1";
    const reachesGaps = Boolean(update)
      && (!movesUp || (Boolean(nestThread) && canNestThread(child, parent, params.threadByKey)));
    const lane = threadDragLane(source);
    const nestRoot = lane ?? tray;
    const siblings = (): HTMLElement[] =>
      Array.from(tray.querySelectorAll<HTMLElement>(".thread-row-shell[data-nested-depth=\"1\"]"));
    const resolveNest = (point: Point): PointerReorderTarget<SubthreadDrop> | undefined => {
      if (!nestThread) return undefined;
      const nest = resolveThreadNestTarget({ point, root: nestRoot, childKey: row.threadKey, threadByKey: params.threadByKey });
      return nest ? nestDropTarget<SubthreadDrop>(nest.element, { kind: "nest", parent: nest.parent }) : undefined;
    };
    const resolveTarget = (point: Point): PointerReorderTarget<SubthreadDrop> | undefined => {
      const bounds = tray.getBoundingClientRect();
      if (
        point.x < bounds.left || point.x > bounds.right
        || point.y < bounds.top - TRAY_DROP_SLACK_PX || point.y > bounds.bottom + TRAY_DROP_SLACK_PX
      ) {
        return resolveNest(point);
      }
      // In the tray's band, only its own rows nest: the slack past its
      // edges still means the top or end of this tray.
      const nest = resolveNest(point);
      if (nest && tray.contains(nest.element)
        && (nest.element.dataset.nestedDepth !== "1" || isInNestBand(nest.element, point.y))) {
        return nest;
      }
      if (!reachesGaps) return undefined;
      const rows = siblings();
      const keys = rows.map((element) => element.dataset.threadKey ?? "");
      const before = rows.findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return point.y < rect.top + rect.height / 2;
      });
      const insertAt = before < 0 ? rows.length : before;
      if (movesUp) {
        // Over its own row, a deeper thread is still where it was: no line,
        // so a drag that wanders back is a cancel, not a move up.
        const own = source.getBoundingClientRect();
        if (rows.length === 0 || (point.y >= own.top && point.y <= own.bottom)) return undefined;
      } else {
        const sourceIndex = keys.indexOf(row.threadKey);
        if (sourceIndex < 0 || insertAt === sourceIndex || insertAt === sourceIndex + 1) return undefined;
      }
      if (before >= 0) {
        return { element: rows[before], key: `subthread:${keys[before]}`, position: "before",
          value: { kind: "reorder", anchorKey: keys[before], placement: "before" } };
      }
      // After the last child means after its whole subtree, which ends at the
      // tray's last row. A deeper row leaving that subtree is not the end.
      const shells = [...tray.querySelectorAll<HTMLElement>(".thread-row-shell")]
        .filter((shell) => shell !== source);
      const lastShell = shells[shells.length - 1] ?? rows[rows.length - 1];
      return { element: lastShell, key: `subthread-end:${keys[keys.length - 1]}`, position: "after",
        value: { kind: "reorder", anchorKey: keys[keys.length - 1], placement: "after" } };
    };

    disposeDragRef.current = beginPointerReorderDrag({
      event,
      sourceElement: source,
      previewSource: source,
      clickSuppressionRoot: nestRoot,
      scrollElement: lane,
      dropIndicator,
      resolveTarget,
      onDrop: ({ value }) => {
        if (value.kind === "nest") {
          nestThread?.(child, value.parent);
          return;
        }
        const anchor = params.threadByKey.get(value.anchorKey);
        if (!anchor || !update) return;
        const move = { threadId: child.id, anchorThreadId: anchor.id, placement: value.placement };
        if (!movesUp) {
          void update(parent, move);
          return;
        }
        // The owner orders only its own children, so the new parent must
        // land before the move can name the thread.
        void (async () => {
          if (await nestThread?.(child, parent) === false) return;
          await update(parent, move);
        })();
      },
    });
  });
}
