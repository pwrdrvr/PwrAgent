import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { NavigationRelativePinMove, NavigationThreadSummary } from "@pwragent/shared";
import { comparePinnedThreads, isKeptAtTopThread, isPinnedThread, moveThreadKey } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { beginNativeDragInteraction, endNativeDragInteraction } from "../../lib/native-drag-interaction";
import type { DropIndicatorController } from "./drag-drop";
import { createThreadRowPointerDragPreview, type ThreadRowPointerDragPreview } from "./thread-row-drag-preview";

const POST_DRAG_CLICK_SUPPRESS_MS = 150;
const POINTER_DRAG_ACTIVATION_PX = 4;

/**
 * One place a pin section renders: a project in Directories, or the Pinned
 * group in Updated and Created. Pin order is one global rank, so every scope
 * edits the same order; a scope only decides which rows can be dragged or
 * anchored on.
 *
 * The scope's element carries `data-thread-pin-scope` and holds its pinned
 * rows, its Keep at top slot (`.directory-row__keep-top-slot`) and, where it
 * has one, its append slot (`.directory-row__pin-drop-slot`).
 */
export type ThreadPinScope = {
  /** Unique among rendered scopes; prefixes the drop indicator's target keys. */
  key: string;
  /** This scope renders the thread as a root row: a valid source or anchor. */
  admitsRoot: (threadKey: string) => boolean;
  /** The thread keys this scope shows as pins, in order. */
  pinnedKeys: () => string[];
};

type ThreadPinDragSession = {
  activated: boolean;
  appendTargetElement?: HTMLDivElement;
  canceled: boolean;
  scope: ThreadPinScope;
  scopeElement: HTMLElement;
  frame: number;
  keepAtTopTargetElement?: HTMLDivElement;
  lastPoint: { x: number; y: number };
  pointerId: number;
  preview?: ThreadRowPointerDragPreview;
  releaseClickSuppression?: () => void;
  removeListeners?: () => void;
  scrollElement?: HTMLElement;
  sourceElement: HTMLDivElement;
  sourceWasPinned: boolean;
  target?: ThreadPinPointerDropTarget;
  threadKey: string;
};

type ThreadPinPointerDropTarget =
  | {
      element: HTMLDivElement;
      kind: "append";
    }
  | {
      element: HTMLDivElement;
      kind: "keepAtTop";
    }
  | {
      element: HTMLDivElement;
      kind: "row";
      position: "before" | "after";
      threadKey: string;
    };

function setThreadPinAppendTargetActive(
  session: ThreadPinDragSession,
  active: boolean,
): void {
  for (const element of [session.appendTargetElement, session.keepAtTopTargetElement]) {
    element?.classList.toggle("is-drag-enabled", active);
    if (active) {
      element?.removeAttribute("aria-hidden");
    } else {
      element?.setAttribute("aria-hidden", "true");
    }
  }
}

function isPointInsideDragSource(
  session: ThreadPinDragSession,
  point: { x: number; y: number },
): boolean {
  const sourceBounds = session.sourceElement.getBoundingClientRect();
  if (
    sourceBounds.right <= sourceBounds.left
    || sourceBounds.bottom <= sourceBounds.top
  ) {
    return false;
  }
  return (
    point.x >= sourceBounds.left
    && point.x <= sourceBounds.right
    && point.y >= sourceBounds.top
    && point.y <= sourceBounds.bottom
  );
}

function getPointInsideElement(
  element: Element,
  point: { x: number; y: number },
): boolean {
  const bounds = element.getBoundingClientRect();
  return (
    bounds.right > bounds.left
    && bounds.bottom > bounds.top
    && point.x >= bounds.left
    && point.x <= bounds.right
    && point.y >= bounds.top
    && point.y <= bounds.bottom
  );
}

function resolveThreadPinPointerDropTarget(
  session: ThreadPinDragSession,
): ThreadPinPointerDropTarget | undefined {
  if (
    session.canceled
    || isPointInsideDragSource(session, session.lastPoint)
  ) {
    return undefined;
  }

  // The Keep at top slot is a box of its own between rows, never over one,
  // so only a drop inside it means "keep". The line above the first ordinary
  // pin stays that row's "before" target: the top of the ordinary pins.
  if (
    session.keepAtTopTargetElement
    && getPointInsideElement(session.keepAtTopTargetElement, session.lastPoint)
  ) {
    return { element: session.keepAtTopTargetElement, kind: "keepAtTop" };
  }

  if (!session.sourceWasPinned) {
    return session.appendTargetElement
      ? { element: session.appendTargetElement, kind: "append" }
      : undefined;
  }

  const buildRowTarget = (
    row: HTMLDivElement,
  ): ThreadPinPointerDropTarget | undefined => {
    const threadKey = row.dataset.threadPinKey;
    if (
      row === session.sourceElement
      || !threadKey
      || threadKey === session.threadKey
    ) {
      return undefined;
    }
    const bounds = row.getBoundingClientRect();
    return {
      element: row,
      kind: "row",
      position:
        session.lastPoint.y > bounds.top + bounds.height / 2
          ? "after"
          : "before",
      threadKey,
    };
  };

  if (typeof document.elementFromPoint === "function") {
    const hit = document.elementFromPoint(
      session.lastPoint.x,
      session.lastPoint.y,
    );
    const hitRow = hit?.closest<HTMLDivElement>(
      '.thread-row-shell[data-thread-pin-state="pinned"]',
    );
    if (
      hitRow
      && session.scopeElement.contains(hitRow)
    ) {
      return buildRowTarget(hitRow);
    }
    if (
      hit
      && session.appendTargetElement?.contains(hit)
    ) {
      return { element: session.appendTargetElement, kind: "append" };
    }
    return undefined;
  }

  const pinnedRows = session.scopeElement.querySelectorAll<HTMLDivElement>(
    '.thread-row-shell[data-thread-pin-state="pinned"]',
  );
  for (const row of pinnedRows) {
    if (
      !getPointInsideElement(row, session.lastPoint)
    ) {
      continue;
    }
    const target = buildRowTarget(row);
    if (target) return target;
  }

  if (
    session.appendTargetElement
    && getPointInsideElement(session.appendTargetElement, session.lastPoint)
  ) {
    return { element: session.appendTargetElement, kind: "append" };
  }
  return undefined;
}

/**
 * Pin ordering for every pin section: the pointer drag (with its Keep at top
 * slot), the drops it resolves to, and the ⌘⇧↑/↓ keyboard move. Directories
 * and the Pinned group both run it, so the two can never disagree
 * about what a gesture does to the one global order.
 */
export function useThreadPinOrdering(params: {
  threads: readonly NavigationThreadSummary[];
  dropIndicator: DropIndicatorController;
  onReorderThreadPins?: (orderedThreadKeys: string[], move?: NavigationRelativePinMove) => Promise<void>;
  onSetThreadPin?: (thread: NavigationThreadSummary, pinned: boolean) => Promise<void>;
  /** A drop landed; callers suppress the click a browser synthesizes after it. */
  onDrop?: () => void;
}) {
  const { dropIndicator } = params;
  const threadPinDragSessionRef = useRef<ThreadPinDragSession | undefined>(
    undefined,
  );
  const threadPinDragCleanupRef = useRef<(() => void) | undefined>(undefined);
  const threadsByKey = useMemo(
    () =>
      new Map(
        params.threads.map((thread) => [
          threadSummaryIdentityKey(thread),
          thread,
        ]),
      ),
    [params.threads],
  );
  const pinnedThreadKeys = useMemo(
    () =>
      params.threads
        .filter(isPinnedThread)
        .sort(comparePinnedThreads)
        .map((thread) => threadSummaryIdentityKey(thread)),
    [params.threads],
  );

  // The owner resolves relative moves against its complete pin order.
  const reorderPins = (nextThreadKeys: string[], move?: NavigationRelativePinMove): void => {
    if (move) void params.onReorderThreadPins?.(nextThreadKeys, move);
  };

  const moveScopePin = (
    scope: ThreadPinScope,
    draggedKey: string,
    targetKey: string,
    position: "before" | "after",
  ): void => {
    if (!scope.admitsRoot(draggedKey) || !scope.admitsRoot(targetKey)) return;

    const draggedThread = threadsByKey.get(draggedKey);
    const targetThread = threadsByKey.get(targetKey);
    if (!draggedThread || !targetThread) {
      return;
    }

    const move = { key: draggedKey, anchorKey: targetKey, placement: position };
    if (pinnedThreadKeys.includes(draggedKey)) {
      reorderPins(moveThreadKey(pinnedThreadKeys, draggedKey, targetKey, position), move);
      return;
    }
    if (!params.onSetThreadPin) return;
    void (async () => {
      await params.onSetThreadPin!(draggedThread, true);
      await params.onReorderThreadPins?.([], move);
    })();
  };

  const dropThreadAfterScopePins = (
    scope: ThreadPinScope,
    draggedKey: string,
  ): void => {
    if (!scope.admitsRoot(draggedKey)) return;

    const draggedThread = threadsByKey.get(draggedKey);
    if (!draggedThread) return;

    // An anchor move adopts the anchor's tier, so the anchor must be an
    // ordinary pin: the append target sits below the pins kept at top.
    const scopePinnedThreadKeys = scope.pinnedKeys()
      .filter((threadKey) => {
        const thread = threadsByKey.get(threadKey);
        return Boolean(thread) && !isKeptAtTopThread(thread!);
      });
    const targetKey =
      scopePinnedThreadKeys[scopePinnedThreadKeys.length - 1];

    if (!targetKey) {
      if (pinnedThreadKeys.includes(draggedKey)) {
        // Every pin here is kept: below them, the drop leaves the kept tier.
        if (isKeptAtTopThread(draggedThread)) {
          void params.onReorderThreadPins?.([], { key: draggedKey, keepAtTop: false });
        }
        return;
      }
      void params.onSetThreadPin?.(draggedThread, true);
      return;
    }

    moveScopePin(scope, draggedKey, targetKey, "after");
  };

  const keepScopeThreadAtTop = (
    scope: ThreadPinScope,
    draggedKey: string,
  ): void => {
    if (!scope.admitsRoot(draggedKey)) return;
    const draggedThread = threadsByKey.get(draggedKey);
    if (!draggedThread) return;
    void (async () => {
      if (!pinnedThreadKeys.includes(draggedKey)) {
        if (!params.onSetThreadPin) return;
        await params.onSetThreadPin(draggedThread, true);
      }
      await params.onReorderThreadPins?.([], { key: draggedKey, keepAtTop: true });
    })();
  };

  const movePinnedThreadByKeyboard = (
    thread: NavigationThreadSummary,
    direction: "up" | "down",
  ): void => {
    // The adjacent pin can be unloaded. The owner resolves the neighbor and
    // revalidates membership before changing rank.
    void params.onReorderThreadPins?.([], { key: threadSummaryIdentityKey(thread), direction });
  };

  const deactivateThreadPinDrag = (session: ThreadPinDragSession): void => {
    if (session.frame) {
      cancelAnimationFrame(session.frame);
      session.frame = 0;
    }
    session.preview?.remove();
    session.preview = undefined;
    session.sourceElement.classList.remove("is-pointer-dragging");
    setThreadPinAppendTargetActive(session, false);
    dropIndicator.clear();
    session.target = undefined;
    if (session.activated) {
      endNativeDragInteraction();
      session.activated = false;
    }
  };

  const finishThreadPinDrag = (session: ThreadPinDragSession): void => {
    deactivateThreadPinDrag(session);
    session.removeListeners?.();
    session.removeListeners = undefined;
    session.releaseClickSuppression?.();
    session.releaseClickSuppression = undefined;
    if (threadPinDragSessionRef.current === session) {
      threadPinDragSessionRef.current = undefined;
    }
    if (threadPinDragCleanupRef.current) {
      threadPinDragCleanupRef.current = undefined;
    }
  };

  const updateThreadPinPointerTarget = (
    session: ThreadPinDragSession,
  ): void => {
    session.preview?.move(session.lastPoint);
    session.target = resolveThreadPinPointerDropTarget(session);
    session.preview?.setDropLabel(
      session.target?.kind === "keepAtTop" ? "Keep at top" : undefined,
    );
    if (!session.target) {
      dropIndicator.clear();
      return;
    }
    dropIndicator.show(session.target.element, {
      targetKey:
        session.target.kind === "row"
          ? `${session.scope.key}:${session.target.threadKey}`
          : session.target.kind === "keepAtTop"
            ? `pinned-keep-top:${session.scope.key}`
            : `pinned-append:${session.scope.key}`,
      position:
        session.target.kind === "row" ? session.target.position : "before",
    });
  };

  const scheduleThreadPinPointerTarget = (
    session: ThreadPinDragSession,
  ): void => {
    if (session.frame || !session.activated || session.canceled) return;
    session.frame = requestAnimationFrame(() => {
      session.frame = 0;
      updateThreadPinPointerTarget(session);
    });
  };

  /**
   * Thread pinning deliberately avoids native HTML drag-and-drop. Chromium's
   * drag processing model suppresses ordinary input events, and its macOS
   * trackpad path can queue momentum at scroll boundaries for seconds. A
   * pointer session leaves wheel scrolling browser-controlled while batching
   * our preview and hit testing to one update per animation frame.
   */
  const beginThreadPinPointerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    scope: ThreadPinScope,
    threadKey: string,
    sourceWasPinned: boolean,
  ): void => {
    if (event.button !== 0 || !params.onReorderThreadPins) return;
    threadPinDragCleanupRef.current?.();

    const sourceElement = event.currentTarget;
    const scopeElement = sourceElement.closest("[data-thread-pin-scope]");
    if (!(scopeElement instanceof HTMLElement)) return;

    const startPoint = { x: event.clientX, y: event.clientY };
    const session: ThreadPinDragSession = {
      activated: false,
      appendTargetElement:
        scopeElement.querySelector<HTMLDivElement>(
          ".directory-row__pin-drop-slot",
        ) ?? undefined,
      canceled: false,
      scope,
      scopeElement,
      frame: 0,
      keepAtTopTargetElement:
        scopeElement.querySelector<HTMLDivElement>(
          ".directory-row__keep-top-slot",
        ) ?? undefined,
      lastPoint: startPoint,
      pointerId: event.pointerId,
      // Both lenses scroll their dense lane (the Directories list carries
      // the same class), never the non-scrolling region around it.
      scrollElement:
        sourceElement.closest<HTMLElement>(".sidebar-list--dense") ?? undefined,
      sourceElement,
      sourceWasPinned,
      threadKey,
    };
    threadPinDragSessionRef.current = session;

    let suppressClickTimer: number | undefined;
    const removeClickSuppression = (): void => {
      session.scopeElement.removeEventListener(
        "click",
        suppressReleaseClick,
        true,
      );
      if (suppressClickTimer !== undefined) {
        window.clearTimeout(suppressClickTimer);
        suppressClickTimer = undefined;
      }
    };
    const suppressReleaseClick = (clickEvent: globalThis.MouseEvent): void => {
      clickEvent.preventDefault();
      clickEvent.stopImmediatePropagation();
      removeClickSuppression();
    };
    const armClickSuppression = (): void => {
      session.scopeElement.addEventListener(
        "click",
        suppressReleaseClick,
        true,
      );
      session.releaseClickSuppression = () => {
        suppressClickTimer = window.setTimeout(
          removeClickSuppression,
          POST_DRAG_CLICK_SUPPRESS_MS,
        );
      };
    };

    const activate = (): void => {
      if (session.activated || session.canceled) return;
      session.activated = true;
      beginNativeDragInteraction();
      session.sourceElement.classList.add("is-pointer-dragging");
      // Measure the held card before the targets open: the ghost Keep at
      // top slot takes layout space and pushes the source row down.
      session.preview = createThreadRowPointerDragPreview(
        session.sourceElement,
        startPoint,
      );
      setThreadPinAppendTargetActive(session, true);
      armClickSuppression();
      session.scrollElement?.addEventListener("scroll", onScroll, {
        passive: true,
      });
      scheduleThreadPinPointerTarget(session);
    };
    const move = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId !== session.pointerId || session.canceled) {
        return;
      }
      session.lastPoint = {
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
      };
      if (
        !session.activated
        && Math.hypot(
          session.lastPoint.x - startPoint.x,
          session.lastPoint.y - startPoint.y,
        ) < POINTER_DRAG_ACTIVATION_PX
      ) {
        return;
      }
      activate();
      pointerEvent.preventDefault();
      scheduleThreadPinPointerTarget(session);
    };
    const onScroll = (): void => scheduleThreadPinPointerTarget(session);
    const stop = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId !== session.pointerId) return;
      session.lastPoint = {
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
      };
      if (session.activated && !session.canceled) {
        if (session.frame) {
          cancelAnimationFrame(session.frame);
          session.frame = 0;
        }
        updateThreadPinPointerTarget(session);
      }
      const target = session.target;
      const wasActivated = session.activated;
      finishThreadPinDrag(session);
      if (!target || session.canceled || !wasActivated) return;

      params.onDrop?.();
      if (target.kind === "append") {
        dropThreadAfterScopePins(session.scope, session.threadKey);
        return;
      }
      if (target.kind === "keepAtTop") {
        keepScopeThreadAtTop(session.scope, session.threadKey);
        return;
      }
      if (session.sourceWasPinned) {
        moveScopePin(
          session.scope,
          session.threadKey,
          target.threadKey,
          target.position,
        );
      }
    };
    const cancel = (): void => {
      session.canceled = true;
      finishThreadPinDrag(session);
    };
    const cancelOnPointer = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId === session.pointerId) cancel();
    };
    const cancelOnEscape = (keyboardEvent: globalThis.KeyboardEvent): void => {
      if (keyboardEvent.key !== "Escape") return;
      session.canceled = true;
      deactivateThreadPinDrag(session);
    };
    const removeListeners = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancelOnPointer);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", cancelOnEscape);
      session.scrollElement?.removeEventListener("scroll", onScroll);
    };
    session.removeListeners = removeListeners;
    threadPinDragCleanupRef.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancelOnPointer);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", cancelOnEscape);
  };

  useEffect(
    () => () => threadPinDragCleanupRef.current?.(),
    [],
  );

  return {
    threadsByKey,
    pinnedThreadKeys,
    beginPointerDrag: beginThreadPinPointerDrag,
    movePinnedThreadByKeyboard,
  };
}
