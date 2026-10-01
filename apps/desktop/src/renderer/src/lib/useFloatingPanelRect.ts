import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type FloatingPanelRect = { x: number; y: number; width: number; height: number };

export type FloatingPanelLimits = {
  minWidth: number;
  minHeight: number;
  /**
   * Kept clear at the top so the panel's handle never slides under the
   * title strip, where macOS draws the window controls inside the renderer.
   */
  topReserve: number;
};

type Viewport = { width: number; height: number };

const KEYBOARD_STEP_PX = 16;

/**
 * Keep a panel on screen: no smaller than its minimum, no larger than the
 * window, and placed wholly inside it below the reserved top strip.
 */
export function clampFloatingPanelRect(
  rect: FloatingPanelRect,
  viewport: Viewport,
  limits: FloatingPanelLimits,
): FloatingPanelRect {
  const width = Math.max(limits.minWidth, Math.min(rect.width, viewport.width));
  const height = Math.max(
    limits.minHeight,
    Math.min(rect.height, viewport.height - limits.topReserve),
  );
  const x = Math.max(0, Math.min(rect.x, viewport.width - width));
  const y = Math.max(limits.topReserve, Math.min(rect.y, viewport.height - height));
  return { x, y, width, height };
}

function readStoredRect(storageKey: string): FloatingPanelRect | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<FloatingPanelRect>;
    const values = [parsed.x, parsed.y, parsed.width, parsed.height];
    return values.every((value) => typeof value === "number" && Number.isFinite(value))
      ? (parsed as FloatingPanelRect)
      : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredRect(storageKey: string, rect: FloatingPanelRect): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(rect));
  } catch {
    // Storage can be blocked; the panel still works, it just forgets.
  }
}

function currentViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

type Gesture = {
  kind: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  startRect: FloatingPanelRect;
};

/**
 * Position and size for a floating panel the operator can drag by a handle
 * and resize from a corner grip. The geometry is remembered
 * in local storage and re-clamped whenever the window changes size.
 * The grip also answers arrow keys, so resizing does not need a pointer.
 */
export function useFloatingPanelRect(params: {
  storageKey: string;
  initial: (viewport: Viewport) => FloatingPanelRect;
  limits: FloatingPanelLimits;
}) {
  const { storageKey, limits } = params;
  const initialRef = useRef(params.initial);
  const [rect, setRect] = useState<FloatingPanelRect>(() => {
    const viewport = currentViewport();
    return clampFloatingPanelRect(
      readStoredRect(storageKey) ?? initialRef.current(viewport),
      viewport,
      limits,
    );
  });
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const gestureRef = useRef<Gesture | undefined>(undefined);
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  useEffect(() => {
    const onResize = () => {
      setRect((current) => clampFloatingPanelRect(current, currentViewport(), limitsRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const commit = useCallback((next: FloatingPanelRect) => {
    setRect(next);
    writeStoredRect(storageKey, next);
  }, [storageKey]);

  const begin = (kind: Gesture["kind"]) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // Controls inside the handle keep their own clicks.
    if (kind === "move" && (event.target as Element).closest("button, input, textarea, a, select")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gestureRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rectRef.current,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const start = gesture.startRect;
    const next = gesture.kind === "move"
      ? { ...start, x: start.x + dx, y: start.y + dy }
      : { ...start, width: start.width + dx, height: start.height + dy };
    setRect(clampFloatingPanelRect(next, currentViewport(), limitsRef.current));
  };

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    writeStoredRect(storageKey, rectRef.current);
  };

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = {
      ArrowLeft: [-KEYBOARD_STEP_PX, 0],
      ArrowRight: [KEYBOARD_STEP_PX, 0],
      ArrowUp: [0, -KEYBOARD_STEP_PX],
      ArrowDown: [0, KEYBOARD_STEP_PX],
    }[event.key];
    if (!step) return;
    event.preventDefault();
    const current = rectRef.current;
    commit(clampFloatingPanelRect(
      { ...current, width: current.width + step[0]!, height: current.height + step[1]! },
      currentViewport(),
      limitsRef.current,
    ));
  };

  return {
    rect,
    moveHandleProps: {
      onPointerDown: begin("move"),
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
    },
    resizeHandleProps: {
      onPointerDown: begin("resize"),
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onKeyDown: onResizeKeyDown,
    },
  };
}
