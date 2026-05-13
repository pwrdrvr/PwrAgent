import type { DragEvent } from "react";

export type DropIndicatorPosition = "before" | "after";

export type DropIndicatorState = {
  position: DropIndicatorPosition;
  targetKey: string;
};

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
