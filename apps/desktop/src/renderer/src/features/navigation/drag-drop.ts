import {
  useEffect,
  useState,
  type DragEvent,
} from "react";

export type DropIndicatorPosition = "before" | "after";

export type DropIndicatorState = {
  position: DropIndicatorPosition;
  targetKey: string;
};

/**
 * Moving an insertion line does not change application state. Keep it out of
 * React's render path so scrolling successive rows under a held card does not
 * rebuild the entire navigation tree for every new target.
 */
export type DropIndicatorController = {
  clear: () => void;
  show: (element: HTMLElement, next: DropIndicatorState) => void;
};

const DROP_INDICATOR_CLASSES = [
  "is-drop-target-before",
  "is-drop-target-after",
] as const;

export function createDropIndicatorController(): DropIndicatorController {
  let active:
    | { element: HTMLElement; state: DropIndicatorState }
    | undefined;

  const clear = (): void => {
    if (!active) return;
    active.element.classList.remove(...DROP_INDICATOR_CLASSES);
    active = undefined;
  };

  return {
    clear,
    show: (element, next) => {
      if (
        active?.element === element
        && active.state.targetKey === next.targetKey
        && active.state.position === next.position
      ) {
        return;
      }
      clear();
      element.classList.add(`is-drop-target-${next.position}`);
      active = { element, state: next };
    },
  };
}

export function useDropIndicatorController(): DropIndicatorController {
  const [controller] = useState(createDropIndicatorController);
  useEffect(
    () => () => controller.clear(),
    [controller],
  );
  return controller;
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
