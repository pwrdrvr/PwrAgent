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

/**
 * Above the composer the panel opens over its pill, then stays put. A pick
 * can widen or narrow the chips before the pill (a provider with another
 * access mode), and a panel that followed the pill slid sideways under the
 * pointer choosing in it.
 */
describe("ModelSettingsPicker composer panel position", () => {
  it("holds the panel where it opened while the pill moves under it", async () => {
    let pillLeft = 300;
    const picker = (label: string) => (
      <ModelSettingsPicker
        model={{
          value: "opus", label, kind: "claude",
          models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }],
          onChange: () => undefined,
        }}
      />
    );
    const { rerender } = render(picker("Opus 5.5"));
    const pill = screen.getByRole("button", { name: /^Model settings/ });
    vi.spyOn(pill, "getBoundingClientRect").mockImplementation(() => ({
      left: pillLeft, right: pillLeft + 120, top: 600, bottom: 624, width: 120, height: 24,
      x: pillLeft, y: 600, toJSON: () => undefined,
    }));
    await act(async () => { fireEvent.click(pill); });
    const panel = screen.getByRole("dialog", { name: "Model settings" });
    const panelLeft = () => pillLeft + Number.parseFloat(panel.style.left || "0");
    expect(panelLeft()).toBe(300);

    for (const [left, label] of [[420, "Sonnet 5.5"], [180, "Opus 5.5"], [300, "Sonnet 5.5"]] as const) {
      pillLeft = left;
      await act(async () => { rerender(picker(label)); });
      expect(panelLeft()).toBe(300);
    }

    // Closed and opened again, it opens over the pill where the pill is now.
    pillLeft = 420;
    await act(async () => { fireEvent.click(pill); });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { fireEvent.click(pill); });
    expect(pillLeft + Number.parseFloat(screen.getByRole("dialog").style.left || "0")).toBe(420);
  });
});
