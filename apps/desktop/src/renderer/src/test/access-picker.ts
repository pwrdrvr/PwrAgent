import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Drive the composer's `AccessPicker` the way an operator does: open the
 * shield, then click a stop on its level bar. The shield's accessible name is
 * "Access: <level>" and its `value` is the chosen option's value; each stop
 * carries its option value as `data-access`.
 */
type Scope = Pick<typeof screen, "getByRole" | "queryByRole" | "queryAllByRole">;

export const ACCESS_TRIGGER_NAME = /^Access: /;

export function accessTrigger(scope: Scope = screen): HTMLElement {
  return scope.getByRole("button", { name: ACCESS_TRIGGER_NAME });
}

export function queryAccessTriggers(scope: Scope = screen): HTMLElement[] {
  return scope.queryAllByRole("button", { name: ACCESS_TRIGGER_NAME });
}

/** Open the picker (if closed) and return its dialog. */
export function openAccessPicker(scope: Scope = screen): HTMLElement {
  return openAccessPickerFrom(accessTrigger(scope));
}

/**
 * Open the picker behind `trigger` (if closed) and return its dialog, for a
 * trigger named otherwise, such as a to-do card's "Access for the new
 * thread". A card's panel portals to the body; the trigger names it.
 */
export function openAccessPickerFrom(trigger: HTMLElement): HTMLElement {
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const id = trigger.getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error("The Access picker did not open.");
  return panel;
}

/** The stops' option values in an open panel, least freedom first. */
export function accessPanelStopValues(panel: HTMLElement): string[] {
  return [...panel.querySelectorAll<HTMLElement>("[data-access]")].map((stop) => stop.dataset.access ?? "");
}

/** Click the stop for `value` in an open panel. */
export function chooseAccessPanelStop(panel: HTMLElement, value: string): void {
  const stop = panel.querySelector<HTMLElement>(`[data-access="${value}"]`);
  if (!stop) throw new Error(`No Access stop for ${value}.`);
  fireEvent.pointerDown(stop, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(stop, { button: 0, pointerId: 1 });
}

/** The stops' option values, least freedom first. */
export function accessStopValues(scope: Scope = screen): string[] {
  return accessPanelStopValues(openAccessPicker(scope));
}

/** Click the stop for `value` (an option value such as `full-access`). */
export function chooseAccessStop(value: string, scope: Scope = screen): void {
  chooseAccessPanelStop(openAccessPicker(scope), value);
}

/** Click Allow on a stop waiting for the Full Access confirmation. */
export function allowAccessStop(scope: Scope = screen): void {
  const panel = openAccessPicker(scope);
  fireEvent.click(within(panel).getByRole("button", { name: /^Allow / }));
}
