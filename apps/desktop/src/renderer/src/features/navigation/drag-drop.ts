import {
  useCallback,
  useState,
  type DragEvent,
} from "react";

export type DropIndicatorPosition = "before" | "after";

export type DropIndicatorState = {
  position: DropIndicatorPosition;
  targetKey: string;
};

/**
 * Native dragover fires continuously while the pointer remains over a row.
 * Preserve the current object when the visible indicator did not change so
 * React can bail out instead of rerendering the entire navigation list for
 * every event. This matters especially when a trackpad scroll is running at
 * the same time as the drag.
 */
export function resolveDropIndicatorState(
  current: DropIndicatorState | undefined,
  next: DropIndicatorState | undefined,
): DropIndicatorState | undefined {
  if (
    current?.targetKey === next?.targetKey
    && current?.position === next?.position
  ) {
    return current;
  }
  return next;
}

export function useDropIndicatorState(): readonly [
  DropIndicatorState | undefined,
  (next: DropIndicatorState | undefined) => void,
] {
  const [indicator, setIndicator] = useState<DropIndicatorState | undefined>();
  const updateIndicator = useCallback(
    (next: DropIndicatorState | undefined) => {
      setIndicator((current) => resolveDropIndicatorState(current, next));
    },
    [],
  );
  return [indicator, updateIndicator] as const;
}

export function getDropIndicatorPosition(
  event: DragEvent<HTMLElement>,
): DropIndicatorPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

export function didDragLeaveCurrentTarget(
  event: DragEvent<HTMLElement>,
): boolean {
  const relatedTarget = event.relatedTarget;
  return !(
    relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)
  );
}
