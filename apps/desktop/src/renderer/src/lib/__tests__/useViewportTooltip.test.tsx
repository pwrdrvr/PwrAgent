import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useViewportTooltip } from "../useViewportTooltip";

afterEach(cleanup);

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
});
