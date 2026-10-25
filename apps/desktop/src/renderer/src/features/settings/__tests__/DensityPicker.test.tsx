import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DensityPicker, densityLabel } from "../DensityPicker";

afterEach(cleanup);

describe("DensityPicker", () => {
  it("offers the three densities as one radio group", () => {
    render(<DensityPicker platform="darwin" value="compact" variant="settings" onChange={vi.fn()} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Mission controlEvery signal on every row",
      "CompactPull requests and reactions only",
      "MinimalOne line per thread",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // Roving focus: only the selected card is a Tab stop.
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("previews each density with real, inert thread rows", () => {
    const { container } = render(
      <DensityPicker platform="darwin" value="minimal" variant="settings" onChange={vi.fn()} />,
    );
    const previews = [...container.querySelectorAll<HTMLElement>(".density-preview")];
    expect(previews.map((preview) => preview.className)).toEqual([
      "density-picker__preview density-preview density-preview--mission-control",
      "density-picker__preview density-preview density-preview--compact",
      "density-picker__preview density-preview density-preview--minimal",
    ]);
    for (const preview of previews) {
      expect(preview).toHaveAttribute("inert");
      expect(preview).toHaveAttribute("aria-hidden", "true");
      expect(preview.querySelectorAll(".thread-row")).toHaveLength(4);
    }
    // The rollup chip the Minimal preview shows, and the Draft chip it keeps.
    expect(previews[2]!.querySelector("[data-pr-rollup]")).toHaveTextContent("3 PRs");
    expect(previews[2]!.querySelector("[data-thread-draft]")).not.toBeNull();
  });

  it("chooses on click and with the arrow keys", () => {
    const onChange = vi.fn();
    render(<DensityPicker platform="darwin" value="mission-control" variant="wizard" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Minimal/ }));
    expect(onChange).toHaveBeenLastCalledWith("minimal");
    fireEvent.keyDown(screen.getByRole("radio", { name: /^Mission control/ }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("minimal");
    fireEvent.keyDown(screen.getByRole("radio", { name: /^Mission control/ }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("compact");
  });

  it("names the X-ray key for the platform in the wizard copy", () => {
    const { rerender } = render(
      <DensityPicker platform="darwin" value="minimal" variant="wizard" onChange={vi.fn()} />,
    );
    expect(screen.getByText(/Hold ⌘ to x-ray every chip/)).toBeInTheDocument();
    rerender(<DensityPicker platform="win32" value="minimal" variant="wizard" onChange={vi.fn()} />);
    expect(screen.getByText(/Hold Ctrl to x-ray every chip/)).toBeInTheDocument();
  });

  it("labels each density", () => {
    expect(densityLabel("mission-control")).toBe("Mission control");
    expect(densityLabel("minimal")).toBe("Minimal");
  });
});
