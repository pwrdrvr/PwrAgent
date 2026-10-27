import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  it("includes a short selected name that is only part of the field name", () => {
    render(
      <ComposerDropdown
        ariaLabel="Machine"
        onChange={() => {}}
        options={[{ label: "Mac", value: "mac" }]}
        value="mac"
      />,
    );
    expect(screen.getByRole("button", { name: "Machine: Mac" })).toHaveTextContent("Mac");
  });

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
    const button = screen.getByRole("button", { name: /^Access mode(?::|$)/ });
    expect(button).toHaveAccessibleName("Access mode: Default Access");
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
    const button = screen.getByRole("button", { name: /^Access mode(?::|$)/ });
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
    const button = screen.getByRole("button", { name: /^Access mode(?::|$)/ });
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

describe("ComposerDropdown Other models", () => {
  it("opens older choices in a flyout and keeps the selected model label", () => {
    const onChange = vi.fn();
    render(
      <ComposerDropdown
        ariaLabel="Model"
        onChange={onChange}
        options={[
          { value: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
          { value: "gpt-6-sol", label: "GPT-6-Sol" },
        ]}
        otherOptions={[
          { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
          { value: "gpt-5.5", label: "GPT-5.5" },
        ]}
        value="gpt-5.6-sol"
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Model(?::|$)/ });
    expect(trigger).toHaveTextContent("GPT-5.6-Sol");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) =>
      option.querySelector(".composer-dropdown__option-label")?.textContent,
    )).toEqual(["GPT-6.1-Sol", "GPT-6-Sol", "Other"]);
    expect(screen.queryByRole("option", { name: "GPT-5.6-Sol" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Other" }));
    const other = screen.getByRole("listbox", { name: "Model: Other" });
    expect(other).toBeVisible();
    expect(within(other).getByRole("option", { name: "GPT-5.6-Sol" }))
      .toHaveAttribute("aria-selected", "true");
    expect(within(other).getByRole("option", { name: "GPT-5.6-Sol" })).toHaveFocus();
    expect(screen.getByRole("option", { name: "GPT-6.1-Sol" })).toBeVisible();

    fireEvent.click(screen.getByRole("option", { name: "Other" }));
    expect(screen.queryByRole("listbox", { name: "Model: Other" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Other" }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5.5" }));
    expect(onChange).toHaveBeenCalledWith("gpt-5.5");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ComposerDropdown provider groups", () => {
  it("titles each provider's models and shows the provider in the closed trigger", () => {
    const onChange = vi.fn();
    render(
      <ComposerDropdown
        ariaLabel="Model"
        onChange={onChange}
        optionsLabel="Codex"
        options={[{ label: "GPT-5.5", value: "gpt-5.5" }]}
        groups={[{
          label: "Refuseless",
          options: [{
            label: "glm-5.3-abliterated",
            selectedLabel: "Refuseless · glm-5.3-abliterated",
            value: "@refuseless/glm-5.3-abliterated",
          }],
        }]}
        value="@refuseless/glm-5.3-abliterated"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Model: Refuseless · glm-5.3-abliterated" });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Model" });
    const group = within(listbox).getByRole("group", { name: "Refuseless" });
    expect(within(group).getByRole("option", { name: "glm-5.3-abliterated" })).toHaveAttribute("aria-selected", "true");
    expect(listbox).toHaveTextContent("Codex");
    fireEvent.click(within(listbox).getByRole("option", { name: "GPT-5.5" }));
    expect(onChange).toHaveBeenCalledWith("gpt-5.5");
  });

  it("explains a filtered list in a note outside the listbox", () => {
    render(
      <ComposerDropdown
        ariaLabel="Model"
        onChange={vi.fn()}
        options={[{ label: "glm-5.3-abliterated", value: "@refuseless/glm-5.3-abliterated" }]}
        footnote="This thread runs on Refuseless. To use another provider, hand it off to a new thread."
        value="@refuseless/glm-5.3-abliterated"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Model/u }));
    const listbox = screen.getByRole("listbox", { name: "Model" });
    expect(listbox).not.toHaveTextContent("hand it off");
    expect(screen.getByText(/hand it off to a new thread/u)).toBeInTheDocument();
  });
});

describe("ComposerDropdown menu action", () => {
  function renderWithAction(menuPlacement?: "above" | "below") {
    const onSelect = vi.fn();
    render(
      <ComposerDropdown
        ariaLabel="Environment"
        menuAction={{ label: "Edit environments…", onSelect }}
        menuPlacement={menuPlacement}
        onChange={vi.fn()}
        options={[{ label: "No environment", value: "" }, { label: "PwrAgent", value: "env" }]}
        value=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Environment/u }));
    return {
      action: screen.getByRole("button", { name: "Edit environments…" }),
      listbox: screen.getByRole("listbox", { name: "Environment" }),
      onSelect,
    };
  }

  // The last row of a menu sits beside its trigger. A command there is the
  // row the pointer lands on first, so it goes to the far end instead.
  it("draws the command above the list when the menu opens up", () => {
    const { action, listbox, onSelect } = renderWithAction();
    expect(action.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(action);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Environment" })).not.toBeInTheDocument();
  });

  it("draws the command below the list when the menu opens down", () => {
    const { action, listbox } = renderWithAction("below");
    expect(action.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});
