import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  endNativeDragInteraction,
  NATIVE_DRAG_ACTIVE_ATTRIBUTE,
  useNativeDragInteractionGuard,
} from "../native-drag-interaction";
import { useViewportTooltip } from "../useViewportTooltip";

function DragTooltipHarness() {
  useNativeDragInteractionGuard();
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <aside className="sidebar">
      <div className="thread-row-shell" draggable>
        Drag source
      </div>
      <button
        type="button"
        onMouseEnter={(event) => tooltip.show(event.currentTarget, "Hover card")}
        onMouseLeave={tooltip.hide}
      >
        Hover target
      </button>
      {tooltip.tooltipNode}
    </aside>
  );
}

afterEach(() => {
  cleanup();
  endNativeDragInteraction();
});

describe("native drag interaction guard", () => {
  it("dismisses and blocks hover overlays until a card drag ends", () => {
    render(<DragTooltipHarness />);

    const target = screen.getByRole("button", { name: "Hover target" });
    const source = screen.getByText("Drag source");
    fireEvent.mouseEnter(target);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hover card");

    fireEvent.dragStart(source);
    expect(document.documentElement).toHaveAttribute(
      NATIVE_DRAG_ACTIVE_ATTRIBUTE,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(target);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.dragEnd(source);
    expect(document.documentElement).not.toHaveAttribute(
      NATIVE_DRAG_ACTIVE_ATTRIBUTE,
    );
    fireEvent.mouseEnter(target);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hover card");
  });

  it("clears drag interaction state on Escape", () => {
    render(<DragTooltipHarness />);
    const source = screen.getByText("Drag source");

    fireEvent.dragStart(source);
    expect(document.documentElement).toHaveAttribute(
      NATIVE_DRAG_ACTIVE_ATTRIBUTE,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.documentElement).not.toHaveAttribute(
      NATIVE_DRAG_ACTIVE_ATTRIBUTE,
    );
  });
});
