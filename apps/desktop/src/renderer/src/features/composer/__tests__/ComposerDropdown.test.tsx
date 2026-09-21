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

function renderAccessMode(showTriggerTooltip = true, autoDisabled = false) {
  return render(
    <div className="composer__setup" style={{ overflow: "hidden" }}>
      <ComposerDropdown
        ariaLabel="Access mode"
        onChange={vi.fn()}
        options={[
          { value: "default", label: "Default Access", tooltip: "Asks you to approve additional access." },
          {
            value: "auto", label: "Auto", disabled: autoDisabled,
            tooltip: autoDisabled ? "Requires Codex 0.153.0 or later." : "Codex reviews eligible permission requests.",
          },
        ]}
        tooltip={showTriggerTooltip ? "Auto keeps the workspace sandbox." : undefined}
        value="default"
      />
    </div>,
  );
}

describe("ComposerDropdown tooltip", () => {
  it("shows delayed help on disabled menu items without adding help to the trigger", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top = this.classList.contains("composer-dropdown__menu") ? 500 : 540;
        return {
          left: 420, right: 680, top, bottom: top + 40,
          width: 260, height: 40, x: 420, y: top, toJSON: () => ({}),
        };
      });
    renderAccessMode(false, true);
    const button = screen.getByRole("button", { name: "Access mode" });
    fireEvent.mouseEnter(button);
    fireEvent.focus(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(button);
    const auto = screen.getByRole("option", { name: "Auto" });
    expect(auto).toBeDisabled();
    fireEvent.mouseEnter(auto.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Requires Codex 0.153.0 or later.");
    // The popup starts at 500; help sits above the popup, not above a row.
    expect(screen.getByRole("tooltip")).toHaveStyle({ top: "450px" });

    fireEvent.mouseLeave(auto.parentElement!);
    const defaultAccess = screen.getByRole("option", { name: /Default Access/ });
    fireEvent.focus(defaultAccess);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Asks you to approve additional access.");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });


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
