import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import {
  matchTypeahead,
  placeListbox,
  Select,
  type SelectOption,
} from "../Select";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OPTIONS: SelectOption[] = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days", disabled: true },
  { value: "weeks", label: "Weeks" },
  { value: "months", label: "Months" },
];

function Field(props: {
  initial?: string;
  options?: SelectOption[];
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(props.initial ?? "hours");
  return (
    <label>
      <span>Unit</span>
      <Select
        value={value}
        options={props.options ?? OPTIONS}
        onChange={(next) => {
          setValue(next);
          props.onChange?.(next);
        }}
      />
    </label>
  );
}

function setup(props: Parameters<typeof Field>[0] = {}) {
  const onChange = vi.fn();
  render(<Field {...props} onChange={onChange} />);
  const trigger = screen.getByRole("combobox", { name: "Unit" });
  return { onChange, trigger };
}

function key(target: HTMLElement, name: string) {
  fireEvent.keyDown(target, { key: name });
}

function activeOption(trigger: HTMLElement): HTMLElement | null {
  const id = trigger.getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id);
}

describe("Select", () => {
  it("is a collapsed combobox named by its label, showing the chosen label", () => {
    const { trigger } = setup();

    expect(screen.getByLabelText("Unit")).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");
    expect(trigger).toHaveAttribute("data-value", "hours");
    expect(trigger).toHaveTextContent("Hours");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens a named list on the current option, outside the field's DOM", () => {
    const { trigger } = setup();

    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "Unit" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", listbox.id);
    // Portalled, so a clipping Settings card cannot cut it off.
    expect(trigger.closest("label")).not.toContainElement(listbox);
    expect(
      within(listbox).getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Minutes", "Hours", "Days", "Weeks", "Months"]);
    expect(within(listbox).getByRole("option", { name: "Hours" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(listbox).getByRole("option", { name: "Minutes" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(activeOption(trigger)).toHaveTextContent("Hours");
    expect(activeOption(trigger)).toHaveClass("is-active");
  });

  it("chooses a clicked option, closes, and keeps focus on the field", () => {
    const { onChange, trigger } = setup();
    trigger.focus();

    fireEvent.click(trigger);
    const option = screen.getByRole("option", { name: "Weeks" });
    // The list refuses the press's focus change, so the field keeps it.
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledExactlyOnceWith("weeks");
    expect(trigger).toHaveTextContent("Weeks");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not report the current option as a change", () => {
    const { onChange, trigger } = setup();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Hours" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("never chooses a disabled option", () => {
    const { onChange, trigger } = setup();

    fireEvent.click(trigger);
    const days = screen.getByRole("option", { name: "Days" });
    expect(days).toHaveAttribute("aria-disabled", "true");
    fireEvent.pointerMove(days);
    fireEvent.click(days);

    expect(onChange).not.toHaveBeenCalled();
    expect(activeOption(trigger)).toHaveTextContent("Hours");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("keeps a press in the list from reaching what the field sits in", () => {
    // The list is portalled out of the field's DOM but not out of its React
    // tree, whose handlers would otherwise see the press.
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    render(
      <div onClick={onClick} onPointerDown={onPointerDown}>
        <Select
          aria-label="Unit"
          value="hours"
          options={OPTIONS}
          onChange={() => undefined}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Unit" }));
    onClick.mockClear();

    const option = screen.getByRole("option", { name: "Weeks" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);

    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("moves the keyboard cursor with the pointer", () => {
    const { trigger } = setup();

    fireEvent.click(trigger);
    fireEvent.pointerMove(screen.getByRole("option", { name: "Months" }));

    expect(activeOption(trigger)).toHaveTextContent("Months");
    key(trigger, "Enter");
    expect(trigger).toHaveTextContent("Months");
  });

  it("walks the options with the arrows, Home and End, stepping over disabled ones", () => {
    const { onChange, trigger } = setup();

    key(trigger, "ArrowDown");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(activeOption(trigger)).toHaveTextContent("Hours");

    key(trigger, "ArrowDown");
    expect(activeOption(trigger)).toHaveTextContent("Weeks");
    key(trigger, "ArrowDown");
    key(trigger, "ArrowDown");
    // No wrap at the end.
    expect(activeOption(trigger)).toHaveTextContent("Months");

    key(trigger, "Home");
    expect(activeOption(trigger)).toHaveTextContent("Minutes");
    key(trigger, "ArrowUp");
    expect(activeOption(trigger)).toHaveTextContent("Minutes");
    key(trigger, "End");
    expect(activeOption(trigger)).toHaveTextContent("Months");
    key(trigger, "ArrowUp");
    key(trigger, "ArrowUp");
    expect(activeOption(trigger)).toHaveTextContent("Hours");

    key(trigger, "PageDown");
    expect(activeOption(trigger)).toHaveTextContent("Months");
    key(trigger, "PageUp");
    expect(activeOption(trigger)).toHaveTextContent("Minutes");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens with Enter, Space, and the arrows, and chooses with Enter or Space", () => {
    const { onChange, trigger } = setup();

    for (const opener of ["Enter", " ", "ArrowUp", "ArrowDown"]) {
      // Prevented, so the button's own activation does not toggle it shut.
      expect(fireEvent.keyDown(trigger, { key: opener })).toBe(false);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      key(trigger, "Escape");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    }

    key(trigger, "End");
    expect(activeOption(trigger)).toHaveTextContent("Months");
    key(trigger, "ArrowUp");
    key(trigger, " ");
    expect(onChange).toHaveBeenLastCalledWith("weeks");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    key(trigger, "Home");
    key(trigger, "Enter");
    expect(onChange).toHaveBeenLastCalledWith("minutes");
  });

  it("closes on Escape without choosing, and leaves the key to nothing behind it", () => {
    const outerDismiss = vi.fn();
    function Dialog() {
      const surfaceRef = useRef<HTMLDivElement>(null);
      useDismissableLayer({ open: true, onDismiss: outerDismiss, surfaceRef });
      return (
        <div ref={surfaceRef}>
          <Field />
        </div>
      );
    }
    render(<Dialog />);
    const trigger = screen.getByRole("combobox", { name: "Unit" });
    trigger.focus();

    key(trigger, "ArrowDown");
    key(trigger, "ArrowDown");
    key(trigger, "Escape");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Hours");
    expect(trigger).toHaveFocus();
    // The list claimed that Escape, so the dialog holding it stayed open.
    expect(outerDismiss).not.toHaveBeenCalled();

    key(trigger, "Escape");
    expect(outerDismiss).toHaveBeenCalledTimes(1);
  });

  it("closes on Tab without choosing the option under the cursor", () => {
    const { onChange, trigger } = setup();

    key(trigger, "ArrowDown");
    key(trigger, "ArrowDown");
    // Not prevented: focus moves on as Tab always does.
    expect(fireEvent.keyDown(trigger, { key: "Tab" })).toBe(true);

    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when a press lands outside the field and the list", () => {
    const { trigger } = setup();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles from its label without a press on the label reopening it", () => {
    const { trigger } = setup();
    const labelText = screen.getByText("Unit");

    fireEvent.click(trigger);
    // A real press is a pointerdown and then a click the label forwards.
    fireEvent.pointerDown(labelText);
    fireEvent.click(labelText);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when focus leaves the field", () => {
    const { trigger } = setup();
    trigger.focus();

    fireEvent.click(trigger);
    fireEvent.blur(trigger, { relatedTarget: document.body });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on a typed letter's first match instead of choosing it", () => {
    const { onChange, trigger } = setup();

    key(trigger, "w");

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(activeOption(trigger)).toHaveTextContent("Weeks");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cycles one repeated letter and matches a typed prefix", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { trigger } = setup({ initial: "minutes" });

    key(trigger, "ArrowDown");
    key(trigger, "m");
    // One letter steps past the cursor's own option.
    expect(activeOption(trigger)).toHaveTextContent("Months");
    key(trigger, "m");
    expect(activeOption(trigger)).toHaveTextContent("Minutes");

    // A pause starts a new run.
    now.mockReturnValue(2_000);
    key(trigger, "h");
    expect(activeOption(trigger)).toHaveTextContent("Hours");

    now.mockReturnValue(3_000);
    key(trigger, "m");
    key(trigger, "o");
    expect(activeOption(trigger)).toHaveTextContent("Months");

    // Space inside a run is part of the query, not a choice.
    key(trigger, " ");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the placeholder while the value matches no option", () => {
    render(
      <Select
        aria-label="Provider"
        placeholder="Choose a provider"
        value="missing"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Provider" });
    expect(trigger).toHaveTextContent("Choose a provider");
    fireEvent.click(trigger);
    // With nothing chosen, the cursor starts on the first choosable option.
    expect(activeOption(trigger)).toHaveTextContent("Minutes");
    expect(screen.getByRole("listbox", { name: "Provider" })).toBeInTheDocument();
  });

  it("describes an option with its muted line, without renaming it", () => {
    render(
      <Select
        aria-label="Mode"
        value="fast"
        options={[
          { value: "fast", label: "Fast", description: "Cheaper, less thorough" },
          { value: "deep", label: "Deep" },
        ]}
        onChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Mode" }));

    const fast = screen.getByRole("option", { name: "Fast" });
    expect(fast).toHaveAccessibleDescription("Cheaper, less thorough");
  });

  it("forwards its ref to the trigger", () => {
    let node: HTMLButtonElement | null = null;
    render(
      <Select
        aria-label="Unit"
        ref={(element) => {
          node = element;
        }}
        value="hours"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );

    expect(node).toBe(screen.getByRole("combobox", { name: "Unit" }));
  });

  it("does not open while disabled", () => {
    render(
      <Select
        aria-label="Unit"
        disabled
        value="hours"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Unit" });

    fireEvent.click(trigger);
    key(trigger, "ArrowDown");

    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

describe("matchTypeahead", () => {
  it("matches a prefix from the cursor, the cursor's own option included", () => {
    expect(matchTypeahead(OPTIONS, "mo", 0)).toBe(4);
    expect(matchTypeahead(OPTIONS, "MI", 0)).toBe(0);
  });

  it("steps through options sharing a repeated first letter, wrapping", () => {
    expect(matchTypeahead(OPTIONS, "m", 0)).toBe(4);
    expect(matchTypeahead(OPTIONS, "mm", 4)).toBe(0);
  });

  it("skips disabled options and reports no match", () => {
    expect(matchTypeahead(OPTIONS, "d", 0)).toBe(-1);
    expect(matchTypeahead(OPTIONS, "x", 0)).toBe(-1);
    expect(matchTypeahead(OPTIONS, "w", -1)).toBe(3);
  });
});

describe("placeListbox", () => {
  const viewport = { width: 1200, height: 800, top: 40 };
  const trigger = (top: number, left = 100, width = 180) => ({
    top,
    bottom: top + 32,
    left,
    width,
  });

  it("opens below the trigger, at least as wide as it", () => {
    expect(
      placeListbox({ trigger: trigger(100), width: 150, contentHeight: 120, viewport }),
    ).toEqual({ top: 136, left: 100, minWidth: 180, maxHeight: 320, flipped: false });
  });

  it("stays below near the bottom while the list still fits there", () => {
    // 800 - 12 - 4 - 632 = 152 below: room for a 120px list.
    const placed = placeListbox({
      trigger: trigger(600),
      width: 150,
      contentHeight: 120,
      viewport,
    });
    expect(placed.flipped).toBe(false);
    expect(placed.maxHeight).toBe(152);
  });

  it("flips above when the list does not fit below and there is more room above", () => {
    const placed = placeListbox({
      trigger: trigger(700),
      width: 150,
      contentHeight: 200,
      viewport,
    });
    expect(placed.flipped).toBe(true);
    // Pinned by its bottom edge, 4px above the trigger.
    expect(placed.top).toBe(700 - 4 - 200);
    expect(placed.maxHeight).toBe(320);
  });

  it("keeps the larger side and scrolls when the list fits neither", () => {
    const placed = placeListbox({
      trigger: trigger(200),
      width: 150,
      contentHeight: 900,
      viewport,
    });
    expect(placed.flipped).toBe(false);
    expect(placed.maxHeight).toBe(320);

    const cramped = placeListbox({
      trigger: trigger(300),
      width: 150,
      contentHeight: 900,
      viewport: { width: 1200, height: 560, top: 40 },
    });
    // 256 above against 212 below.
    expect(cramped.flipped).toBe(true);
    expect(cramped.maxHeight).toBe(256);
    expect(cramped.top).toBe(300 - 4 - 256);
  });

  it("clamps a list wider than the room right of the trigger into the window", () => {
    const placed = placeListbox({
      trigger: trigger(100, 1000, 120),
      width: 400,
      contentHeight: 120,
      viewport,
    });
    expect(placed.left).toBe(1200 - 12 - 400);
  });
});
