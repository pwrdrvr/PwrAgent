import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsPicker } from "../ModelSettingsPicker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPicker() {
  render(
    <>
      <ModelSettingsPicker
        model={{
          value: "opus", label: "Opus 5.5", kind: "claude",
          models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }],
          onChange: () => undefined,
        }}
        effort={{ stops: ["low", "high"], value: "high", onChange: () => undefined }}
      />
      <textarea aria-label="Prompt" />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Model settings/ }));
  return screen.getByRole("dialog", { name: "Model settings" });
}

/**
 * The panel stays while the operator chooses in it. A composer once sent
 * focus to its prompt after every change, and the panel closed under the
 * cursor after one click.
 */
describe("ModelSettingsPicker focus", () => {
  it("stays open when code moves focus out of it, and closes when Tab leaves it", async () => {
    const panel = renderPicker();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    const option = screen.getByRole("option", { name: "Sonnet 5.5" });
    await act(async () => { fireEvent.blur(option, { relatedTarget: prompt }); });
    expect(screen.queryByRole("dialog")).toBe(panel);

    await act(async () => {
      fireEvent.keyDown(option, { key: "Tab" });
      fireEvent.blur(option, { relatedTarget: prompt });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a pointer press outside it", async () => {
    renderPicker();
    await act(async () => { fireEvent.pointerDown(screen.getByRole("textbox", { name: "Prompt" })); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * A portalled panel is hidden until it is placed, and a browser will not
 * focus into a hidden element. The panel once moved focus during that
 * hidden first render, so a to-do card opened with focus nowhere.
 */
describe("ModelSettingsPicker initial focus", () => {
  it("moves focus into a portalled panel only once it is visible", async () => {
    const seen: string[] = [];
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      const panel = this.closest<HTMLElement>(".model-settings__panel");
      if (panel) seen.push(panel.style.visibility || "visible");
      focus.call(this, options);
    });
    render(
      <ModelSettingsPicker
        size="card"
        model={{
          value: "opus", label: "Opus 5.5", kind: "claude",
          models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }],
          onChange: () => undefined,
        }}
      />,
    );
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Model settings/ })); });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain("hidden");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Opus 5.5" }));
  });
});

/**
 * While the pill is disabled (a save in flight), the open panel takes no
 * picks. Its handlers hold the last render's props, so a second pick sent
 * the old model back with the new effort and undid the first.
 */
describe("ModelSettingsPicker while disabled", () => {
  it("ignores picks in an open panel once the pill is disabled", async () => {
    const onModel = vi.fn();
    const onEffort = vi.fn();
    const picker = (disabled: boolean) => (
      <ModelSettingsPicker
        disabled={disabled}
        model={{
          value: "opus", label: "Opus 5.5", kind: "claude",
          models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }],
          onChange: onModel,
        }}
        effort={{ stops: ["low", "high"], value: "high", onChange: onEffort }}
      />
    );
    const { rerender } = render(picker(false));
    fireEvent.click(screen.getByRole("button", { name: /^Model settings/ }));
    rerender(picker(true));
    const panel = screen.getByRole("dialog", { name: "Model settings" });
    fireEvent.click(screen.getByRole("option", { name: "Sonnet 5.5" }));
    const slider = screen.getByRole("slider", { name: "Effort" });
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.pointerDown(panel.querySelector("[data-effort='low']")!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(panel.querySelector("[data-effort='low']")!, { button: 0, pointerId: 1 });
    expect(onModel).not.toHaveBeenCalled();
    expect(onEffort).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Model settings" })).toBe(panel);
    rerender(picker(false));
    fireEvent.click(screen.getByRole("option", { name: "Sonnet 5.5" }));
    expect(onModel).toHaveBeenCalledWith("sonnet");
  });

  it("names an effort the bar does not list as that effort, not the default", () => {
    render(
      <ModelSettingsPicker
        model={{ value: "m", label: "Model", kind: "claude", models: [], onChange: () => undefined }}
        effort={{ stops: ["low", "high"], value: "xhigh", defaultOption: { value: "default", label: "Default" }, onChange: () => undefined }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Model settings/ }));
    expect(screen.getByRole("slider", { name: "Effort" }).getAttribute("aria-valuetext")).toBe("xhigh");
  });
});
