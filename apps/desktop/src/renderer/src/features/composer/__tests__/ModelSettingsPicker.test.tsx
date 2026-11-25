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
 * Above the composer the panel opens in line with its pill, over the whole
 * composer, then stays put. A pick can widen or narrow the chips before the
 * pill (a provider with another access mode) or wrap the toolbar so the pill
 * changes rows. A panel hung from the pill slid sideways and dropped under
 * the pointer choosing in it; one held over the pill covered the chips when
 * the pill moved back up a row.
 */
describe("ModelSettingsPicker composer panel position", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => undefined,
  });

  function renderInComposer() {
    const at = { pillLeft: 300, pillTop: 600, composerTop: 480 };
    const picker = (label: string) => (
      <form className="composer">
        <ModelSettingsPicker
          model={{
            value: "opus", label, kind: "claude",
            models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }],
            onChange: () => undefined,
          }}
        />
      </form>
    );
    const { container, rerender } = render(picker("Opus 5.5"));
    const pill = screen.getByRole("button", { name: /^Model settings/ });
    vi.spyOn(pill, "getBoundingClientRect").mockImplementation(() => rect(at.pillLeft, at.pillTop, 120, 24));
    vi.spyOn(container.querySelector("form")!, "getBoundingClientRect")
      .mockImplementation(() => rect(0, at.composerTop, 760, at.pillTop + 40 - at.composerTop));
    const move = async (next: Partial<typeof at>, label: string) => {
      Object.assign(at, next);
      await act(async () => { rerender(picker(label)); });
    };
    // Where the panel sits in the window: its left from the pill's, and its
    // foot `calc(100% + rise)` above the pill's top (the stylesheet's 8px
    // when no inline rule says otherwise), moved by any translation.
    const placed = (panel: HTMLElement) => {
      const rise = Number(/calc\(100% \+ (-?[\d.]+)px\)/.exec(panel.style.bottom)?.[1] ?? 8);
      const shift = Number(/translateY\((-?[\d.]+)px\)/.exec(panel.style.transform)?.[1] ?? 0);
      return { left: at.pillLeft + Number.parseFloat(panel.style.left || "0"), foot: at.pillTop - rise + shift };
    };
    return { at, pill, move, placed };
  }

  it("opens over the composer and holds there while the pill moves under it", async () => {
    const { at, pill, move, placed } = renderInComposer();
    await act(async () => { fireEvent.click(pill); });
    const panel = screen.getByRole("dialog", { name: "Model settings" });
    // A gap over the composer's top, not over the pill's.
    expect(placed(panel)).toEqual({ left: 300, foot: 472 });
    expect(panel.style.maxHeight).toBe("464px");

    for (const [pillLeft, pillTop, label] of [
      [420, 600, "Sonnet 5.5"],
      [180, 644, "Opus 5.5"],
      [24, 644, "Sonnet 5.5"],
      [300, 600, "Opus 5.5"],
    ] as const) {
      await move({ pillLeft, pillTop }, label);
      expect(placed(panel)).toEqual({ left: 300, foot: 472 });
    }

    // Closed and opened again, it opens in line with the pill where it is now.
    at.pillLeft = 420;
    await act(async () => { fireEvent.click(pill); });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { fireEvent.click(pill); });
    expect(placed(screen.getByRole("dialog"))).toEqual({ left: 420, foot: 472 });
  });

  it("rises when the composer grows up into it, and never drops back", async () => {
    const { pill, move, placed } = renderInComposer();
    await act(async () => { fireEvent.click(pill); });
    const panel = screen.getByRole("dialog", { name: "Model settings" });
    await move({ composerTop: 436 }, "Sonnet 5.5");
    expect(placed(panel).foot).toBe(428);
    await move({ composerTop: 480 }, "Opus 5.5");
    expect(placed(panel).foot).toBe(428);
  });
});
