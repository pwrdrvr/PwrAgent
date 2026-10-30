import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { useEventCallback } from "../../lib/useEventCallback";
import { useDropIndicatorController } from "./drag-drop";
import { beginPointerReorderDrag } from "./pointer-reorder-drag";
import { nestDropTarget, resolveThreadNestTarget, threadDragLane } from "./thread-nest-drop";
import type { ThreadRowRef } from "./ThreadRow";

/**
 * The drag a row gets when it has no order to change: an unpinned root in a
 * time-sorted lens. Its one drop makes it a sub-thread of the row it lands
 * on, with the same held card, ring, and Escape as every other sidebar drag.
 */
export function useThreadNestDrag(params: {
  threadByKey: ReadonlyMap<string, NavigationThreadSummary>;
  onNestThread?: (thread: NavigationThreadSummary, parent: NavigationThreadSummary) => void;
}) {
  const dropIndicator = useDropIndicatorController();
  const disposeDragRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => disposeDragRef.current?.(), []);

  return useEventCallback((event: ReactPointerEvent<HTMLDivElement>, row: ThreadRowRef) => {
    const nestThread = params.onNestThread;
    const thread = params.threadByKey.get(row.threadKey);
    if (event.button !== 0 || !nestThread || !thread) return;
    disposeDragRef.current?.();

    const source = event.currentTarget;
    const scrollElement = threadDragLane(source);
    const lane = scrollElement ?? source.parentElement ?? source;
    disposeDragRef.current = beginPointerReorderDrag({
      event,
      sourceElement: source,
      previewSource: source,
      clickSuppressionRoot: lane,
      scrollElement,
      dropIndicator,
      resolveTarget: (point) => {
        const nest = resolveThreadNestTarget({ point, root: lane, childKey: row.threadKey, threadByKey: params.threadByKey });
        return nest ? nestDropTarget(nest.element, nest.parent) : undefined;
      },
      onDrop: ({ value }) => nestThread(thread, value),
    });
  });
}
