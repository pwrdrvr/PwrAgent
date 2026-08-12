import type { DragEvent } from "react";

type Point = {
  x: number;
  y: number;
};

export type ThreadRowPointerDragPreview = {
  move: (point: Point) => void;
  remove: () => void;
};

function buildThreadRowDragPreview(
  source: HTMLDivElement,
): { element: HTMLElement; rect: DOMRect } | undefined {
  const row = source.querySelector(".thread-row");
  if (!(row instanceof HTMLElement)) {
    return undefined;
  }

  const rect = row.getBoundingClientRect();
  const clone = row.cloneNode(true) as HTMLElement;
  clone.classList.add("thread-row--drag-image");
  clone.classList.remove("thread-row--compact");
  clone.querySelector(".thread-row__actions")?.remove();
  clone.querySelector(".thread-row__chip--add-reaction")?.remove();
  clone.querySelector(".thread-row__overflow-button")?.remove();
  clone.setAttribute("aria-hidden", "true");
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  document.body.appendChild(clone);
  return { element: clone, rect };
}

export function setThreadRowNativeDragPreview(
  event: DragEvent<HTMLDivElement>,
): void {
  const preview = buildThreadRowDragPreview(event.currentTarget);
  if (!preview) return;

  event.dataTransfer.setDragImage(
    preview.element,
    Math.max(
      0,
      Math.min(event.clientX - preview.rect.left, preview.rect.width),
    ),
    Math.max(
      0,
      Math.min(event.clientY - preview.rect.top, preview.rect.height),
    ),
  );

  window.setTimeout(() => preview.element.remove(), 0);
}

export function createThreadRowPointerDragPreview(
  source: HTMLDivElement,
  point: Point,
): ThreadRowPointerDragPreview | undefined {
  const preview = buildThreadRowDragPreview(source);
  if (!preview) return undefined;

  const offset = {
    x: Math.max(0, Math.min(point.x - preview.rect.left, preview.rect.width)),
    y: Math.max(0, Math.min(point.y - preview.rect.top, preview.rect.height)),
  };
  preview.element.style.willChange = "transform";

  const move = (nextPoint: Point): void => {
    const x = nextPoint.x - offset.x;
    const y = nextPoint.y - offset.y;
    preview.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  move(point);

  return {
    move,
    remove: () => preview.element.remove(),
  };
}
