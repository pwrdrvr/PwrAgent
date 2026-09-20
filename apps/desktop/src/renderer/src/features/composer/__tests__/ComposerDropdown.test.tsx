import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { ComposerDropdown } from "../ComposerDropdown";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderAccessMode() {
  return render(
    <div className="composer__setup" style={{ overflow: "hidden" }}>
      <ComposerDropdown
        ariaLabel="Access mode"
        onChange={vi.fn()}
        options={[
          { value: "default", label: "Default Access" },
          { value: "auto", label: "Auto" },
        ]}
        tooltip="Auto keeps the workspace sandbox."
        value="default"
      />
    </div>,
  );
}

describe("ComposerDropdown tooltip", () => {
  it("delays hover, escapes clipping, and stays within the composer bounds", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const left = this.classList.contains("composer__setup") ? 408 : 420;
        const width = this.classList.contains("composer__setup") ? 300 : 420;
        return {
          left, right: left + width, top: 700, bottom: 740,
          width, height: 40, x: left, y: 700, toJSON: () => ({}),
        };
      });
    const { container } = renderAccessMode();
    const button = screen.getByRole("button", { name: "Access mode" });
    fireEvent.mouseEnter(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const tooltip = screen.getByRole("tooltip");
    expect(container.contains(tooltip)).toBe(false);
    expect(tooltip).toHaveStyle({ left: "408px", maxWidth: "300px" });

    fireEvent.click(button);
    expect(screen.getByRole("listbox")).toBeVisible();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(button);
    fireEvent.focus(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("cancels a pending hover on click and supports keyboard focus after closing", () => {
    vi.useFakeTimers();
    renderAccessMode();
    const button = screen.getByRole("button", { name: "Access mode" });
    fireEvent.mouseEnter(button);
    fireEvent.click(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Auto keeps the workspace sandbox.");
    fireEvent.blur(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
