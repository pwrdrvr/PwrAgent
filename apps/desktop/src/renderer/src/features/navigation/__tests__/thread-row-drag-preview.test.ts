import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadRowPointerDragPreview } from "../thread-row-drag-preview";

function buildSource(): HTMLDivElement {
  const source = document.createElement("div");
  const row = document.createElement("div");
  row.className = "thread-row";
  source.appendChild(row);
  document.body.appendChild(source);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    bottom: 160,
    height: 60,
    left: 20,
    right: 320,
    toJSON: () => ({}),
    top: 100,
    width: 300,
    x: 20,
    y: 100,
  });
  return source;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("createThreadRowPointerDragPreview", () => {
  it("tilts the held card around the grab point", () => {
    const preview = createThreadRowPointerDragPreview(buildSource(), {
      x: 120,
      y: 130,
    });
    const card = document.body.querySelector<HTMLElement>(
      ".thread-row--drag-image",
    );

    // Grabbed 100px in and 30px down: the pivot sits under the pointer, so
    // the rotation cannot swing the card away from it.
    expect(card?.style.transformOrigin).toBe("100px 30px");
    expect(card?.style.transform).toContain("translate3d(20px, 100px, 0)");
    // The angle is a stylesheet variable, so the reduced-motion rule in
    // app.css can zero it.
    expect(card?.style.transform).toContain(
      "rotate(var(--thread-row-drag-tilt, 0deg))",
    );

    preview?.move({ x: 200, y: 40 });
    expect(card?.style.transform).toContain("translate3d(100px, 10px, 0)");
    expect(card?.style.transform).toContain(
      "rotate(var(--thread-row-drag-tilt, 0deg))",
    );
    expect(card?.style.transformOrigin).toBe("100px 30px");
  });
});
