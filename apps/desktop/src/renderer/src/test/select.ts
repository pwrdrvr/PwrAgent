import { fireEvent, within } from "@testing-library/react";

/**
 * Drive a `Select` (components/Select.tsx) the way the operator does.
 *
 * Its trigger is a button, so `fireEvent.change(trigger, { target: { value }
 * })`, which drove the native `<select>` it replaced, does nothing. Choose by
 * the label the operator reads, not the stored value.
 */

/** The open list a trigger controls. Throws while it is closed. */
export function selectListbox(trigger: HTMLElement): HTMLElement {
  const id = trigger.getAttribute("aria-controls");
  const listbox = id === null ? null : document.getElementById(id);
  if (listbox === null) {
    throw new Error("The Select is closed: its trigger controls no listbox.");
  }
  return listbox;
}

/** Open the list if it is closed, then click the option with this name. */
export function chooseSelectOption(
  trigger: HTMLElement,
  name: string | RegExp,
): void {
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  fireEvent.click(within(selectListbox(trigger)).getByRole("option", { name }));
}

/** Every option's label, in order. Leaves the list as it found it. */
export function selectOptionLabels(trigger: HTMLElement): string[] {
  const wasOpen = trigger.getAttribute("aria-expanded") === "true";
  if (!wasOpen) fireEvent.click(trigger);
  const labels = within(selectListbox(trigger))
    .getAllByRole("option")
    .map(
      (option) =>
        option.querySelector(".select-option__label")?.textContent ?? "",
    );
  if (!wasOpen) fireEvent.click(trigger);
  return labels;
}
