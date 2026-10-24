type Point = {
  x: number;
  y: number;
};

export type ThreadRowPointerDragPreview = {
  move: (point: Point) => void;
  remove: () => void;
  /**
   * Say on the held card what a drop will do. The card sits over the target
   * it is hovering, so a label on the target itself is hidden exactly when
   * it matters.
   */
  setDropLabel: (label: string | undefined) => void;
};

function buildThreadRowDragPreview(
  source: HTMLElement,
  options: { compact?: boolean } = {},
): { element: HTMLElement; rect: DOMRect } | undefined {
  const row = source.querySelector(".thread-row");
  if (!(row instanceof HTMLElement)) {
    return undefined;
  }

  const rect = row.getBoundingClientRect();
  const clone = row.cloneNode(true) as HTMLElement;
  clone.classList.add("thread-row--drag-image");
  // A project header is a compact row by design; a thread row's held card
  // shows its full chips.
  if (!options.compact) clone.classList.remove("thread-row--compact");
  // The hover controls go; the pin mark and the timestamp share the title
  // line's actions with them and stay, so the held card reads as the row.
  clone.querySelector(".thread-row__chip--add-reaction")?.remove();
  clone.querySelector(".thread-row__pin-button")?.remove();
  clone.querySelector(".thread-row__overflow-button")?.remove();
  clone.setAttribute("aria-hidden", "true");
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  document.body.appendChild(clone);
  return { element: clone, rect };
}

export function createThreadRowPointerDragPreview(
  source: HTMLElement,
  point: Point,
  options: { compact?: boolean } = {},
): ThreadRowPointerDragPreview | undefined {
  const preview = buildThreadRowDragPreview(source, options);
  if (!preview) return undefined;

  const offset = {
    x: Math.max(0, Math.min(point.x - preview.rect.left, preview.rect.width)),
    y: Math.max(0, Math.min(point.y - preview.rect.top, preview.rect.height)),
  };
  preview.element.style.willChange = "transform";
  // Tilt around the grab point, so the spot under the pointer stays put.
  preview.element.style.transformOrigin = `${offset.x}px ${offset.y}px`;

  // The tilt angle is a stylesheet custom property rather than a constant
  // here: this inline transform would override a `rotate()` declared in CSS,
  // and the reduced-motion rule that zeroes the tilt belongs in CSS too.
  const move = (nextPoint: Point): void => {
    const x = nextPoint.x - offset.x;
    const y = nextPoint.y - offset.y;
    preview.element.style.transform =
      `translate3d(${x}px, ${y}px, 0) rotate(var(--thread-row-drag-tilt, 0deg))`;
  };
  move(point);

  let dropLabel: HTMLSpanElement | undefined;
  const setDropLabel = (label: string | undefined): void => {
    if (!label) {
      dropLabel?.remove();
      dropLabel = undefined;
      return;
    }
    if (!dropLabel) {
      dropLabel = document.createElement("span");
      dropLabel.className = "thread-row__drop-label";
      preview.element.appendChild(dropLabel);
    }
    dropLabel.textContent = label;
  };

  return {
    move,
    remove: () => preview.element.remove(),
    setDropLabel,
  };
}
