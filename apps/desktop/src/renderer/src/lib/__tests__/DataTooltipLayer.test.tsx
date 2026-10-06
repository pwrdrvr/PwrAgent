import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTooltipLayer } from "../DataTooltipLayer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PLAN_TOOLTIP = "Plan mode — plan the work before making changes";

// jsdom has no PointerEvent constructor, and the bubbling over/out pair is
// what the layer delegates on. A MouseEvent carries the `relatedTarget` the
// enter/leave test reads.
function pointer(
  type: "pointerover" | "pointerout",
  target: Element,
  relatedTarget: Element | null,
): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));
  });
}

function enter(target: Element, from: Element | null = document.body): void {
  pointer("pointerout", from ?? document.body, target);
  pointer("pointerover", target, from);
}

function leave(target: Element, to: Element | null = document.body): void {
  pointer("pointerout", target, to);
  if (to) {
    pointer("pointerover", to, target);
  }
}

// jsdom's `:focus-visible` tracks only the first Tab of a run. Report the
// modality each test drives instead.
function focusVisibleWhile(visible: () => boolean): void {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    if (selector === ":focus-visible") {
      return visible() && this === document.activeElement;
    }
    return matches.call(this, selector);
  });
}

function ComposerToolbarFixture() {
  const [planMode, setPlanMode] = useState(false);
  return (
    <>
      {/* The composer's real shape: the toolbar sits in a pane that clips,
          beside a sidebar that would paint over anything inside it. */}
      <div data-testid="main-pane" style={{ overflow: "hidden" }}>
        <div className="composer__toolbar">
          <button
            type="button"
            aria-label="Plan mode"
            className="composer__toggle tooltip-target"
            data-tooltip={planMode ? "Plan mode is on" : PLAN_TOOLTIP}
            onClick={() => setPlanMode((current) => !current)}
          >
            <svg data-testid="plan-icon" />
          </button>
          <button
            type="button"
            aria-label="Fast mode"
            aria-describedby="fast-mode-help"
            className="composer__toggle tooltip-target"
            data-tooltip="Fast mode — faster, lower-latency responses"
          />
          <span
            className="composer__directory-reference tooltip-target"
            data-tooltip="~/github/PwrSuiteLab"
            data-testid="directory-reference"
          >
            PwrSuiteLab
            <button type="button" aria-label="Remove PwrSuiteLab" />
          </span>
          <button type="button" aria-label="Untipped" />
        </div>
      </div>
      <p id="fast-mode-help">Owned by the control</p>
      <DataTooltipLayer />
    </>
  );
}

describe("DataTooltipLayer", () => {
  it("draws a hovered data-tooltip on document.body, outside the clipping pane", () => {
    render(<ComposerToolbarFixture />);
    const plan = screen.getByRole("button", { name: "Plan mode" });

    enter(plan);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent(PLAN_TOOLTIP);
    expect(tooltip.parentElement).toBe(document.body);
    expect(screen.getByTestId("main-pane")).not.toContainElement(tooltip);
    expect(tooltip).toHaveClass("viewport-tooltip", "data-tooltip-layer");
    expect(plan).toHaveAttribute("aria-describedby", tooltip.id);

    leave(plan);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(plan).not.toHaveAttribute("aria-describedby");
  });

  it("treats a move between a target's own children as neither leave nor enter", () => {
    render(<ComposerToolbarFixture />);
    const plan = screen.getByRole("button", { name: "Plan mode" });
    const icon = screen.getByTestId("plan-icon");

    enter(plan);
    pointer("pointerout", plan, icon);
    pointer("pointerover", icon, plan);

    expect(screen.getByRole("tooltip")).toHaveTextContent(PLAN_TOOLTIP);
  });

  it("moves straight from one target to the next", () => {
    render(<ComposerToolbarFixture />);
    const plan = screen.getByRole("button", { name: "Plan mode" });
    const fast = screen.getByRole("button", { name: "Fast mode" });

    enter(plan);
    leave(plan, fast);

    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Fast mode");
    expect(plan).not.toHaveAttribute("aria-describedby");
  });

  it("does not reopen on a press until the pointer leaves and comes back", () => {
    render(<ComposerToolbarFixture />);
    const plan = screen.getByRole("button", { name: "Plan mode" });
    const icon = screen.getByTestId("plan-icon");

    enter(plan);
    fireEvent.pointerDown(plan);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    pointer("pointerout", plan, icon);
    pointer("pointerover", icon, plan);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    leave(plan);
    enter(plan);
    expect(screen.getByRole("tooltip")).toHaveTextContent(PLAN_TOOLTIP);
  });

  it("follows a rewritten data-tooltip while it shows", async () => {
    focusVisibleWhile(() => true);
    render(<ComposerToolbarFixture />);
    const plan = screen.getByRole("button", { name: "Plan mode" });

    act(() => plan.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent(PLAN_TOOLTIP);
    // Keyboard activation: focus stays, and the control relabels itself.
    fireEvent.click(plan);

    expect(await screen.findByText("Plan mode is on")).toHaveAttribute("role", "tooltip");
  });

  it("leaves a control's own aria-describedby alone", () => {
    render(<ComposerToolbarFixture />);
    const fast = screen.getByRole("button", { name: "Fast mode" });

    enter(fast);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Fast mode");
    leave(fast);

    expect(fast).toHaveAttribute("aria-describedby", "fast-mode-help");
  });

  it("opens for keyboard focus, including on a focusable child, and not for a click's focus", () => {
    let keyboard = true;
    focusVisibleWhile(() => keyboard);
    render(<ComposerToolbarFixture />);
    const remove = screen.getByRole("button", { name: "Remove PwrSuiteLab" });
    const untipped = screen.getByRole("button", { name: "Untipped" });

    act(() => remove.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("~/github/PwrSuiteLab");

    act(() => untipped.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    keyboard = false;
    act(() => screen.getByRole("button", { name: "Plan mode" }).focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("returns to the keyboard-focused target's tooltip when a hover elsewhere ends", () => {
    focusVisibleWhile(() => true);
    render(<ComposerToolbarFixture />);
    const plan = screen.getByRole("button", { name: "Plan mode" });
    const reference = screen.getByTestId("directory-reference");

    act(() => plan.focus());
    enter(reference);
    expect(screen.getByRole("tooltip")).toHaveTextContent("~/github/PwrSuiteLab");

    leave(reference);
    expect(screen.getByRole("tooltip")).toHaveTextContent(PLAN_TOOLTIP);

    act(() => plan.blur());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes when the hovered control drops its data-tooltip", async () => {
    function Removable() {
      const [tip, setTip] = useState<string | undefined>("Reset model");
      return (
        <>
          <button
            type="button"
            className="composer__toggle tooltip-target"
            data-tooltip={tip}
            onKeyDown={() => setTip(undefined)}
          >
            Reset
          </button>
          <DataTooltipLayer />
        </>
      );
    }
    render(<Removable />);
    const reset = screen.getByRole("button", { name: "Reset" });

    enter(reset);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Reset model");
    fireEvent.keyDown(reset, { key: "x" });

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });
});
