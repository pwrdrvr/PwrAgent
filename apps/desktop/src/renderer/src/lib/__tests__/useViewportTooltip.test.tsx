import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useViewportTooltip } from "../useViewportTooltip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function TooltipFixture() {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <div>
      <div data-testid="sidebar-scroll-region">
        <button
          type="button"
          onMouseEnter={(event) =>
            tooltip.show(event.currentTarget, "Branch details")
          }
        >
          agent/keep-tooltip-open
        </button>
      </div>
      <div data-testid="transcript-scroll-region" />
      {tooltip.tooltipNode}
    </div>
  );
}

function rectangle(rect: Partial<DOMRect>): DOMRect {
  const x = rect.x ?? rect.left ?? 0;
  const y = rect.y ?? rect.top ?? 0;
  const width = rect.width ?? 0;
  const height = rect.height ?? 0;
  return {
    bottom: rect.bottom ?? y + height,
    height,
    left: rect.left ?? x,
    right: rect.right ?? x + width,
    top: rect.top ?? y,
    width,
    x,
    y,
    toJSON: () => undefined,
  };
}

describe("useViewportTooltip", () => {
  it("keeps a tooltip open when an unrelated pane scrolls", () => {
    render(<TooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Branch details");

    fireEvent.scroll(screen.getByTestId("transcript-scroll-region"));

    expect(screen.getByRole("tooltip")).toHaveTextContent("Branch details");
  });

  it("closes a tooltip when the scroll moves its anchor", () => {
    render(<TooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.scroll(screen.getByTestId("sidebar-scroll-region"));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("places the tooltip below its target when above would overlap the app shell boundary", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        if (this.classList.contains("app-shell")) {
          return rectangle({ top: 40, width: 1200, height: 760 });
        }
        if (this.getAttribute("role") === "tooltip") {
          return rectangle({ width: 300, height: 60 });
        }
        if (this.tagName === "BUTTON") {
          return rectangle({ left: 20, top: 82, width: 72, height: 26 });
        }
        return rectangle({});
      },
    );

    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 800);

    render(
      <div className="app-shell">
        <TooltipFixture />
      </div>,
    );

    fireEvent.mouseEnter(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveStyle({ top: "118px" });
    });
  });
});
