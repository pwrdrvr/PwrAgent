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
  const trigger = accessTrigger(scope);
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const id = trigger.getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error("The Access picker did not open.");
  return panel;
}

/** The stops' option values, least freedom first. */
export function accessStopValues(scope: Scope = screen): string[] {
  const panel = openAccessPicker(scope);
  return [...panel.querySelectorAll<HTMLElement>("[data-access]")].map((stop) => stop.dataset.access ?? "");
}

/** Click the stop for `value` (an option value such as `full-access`). */
export function chooseAccessStop(value: string, scope: Scope = screen): void {
  const panel = openAccessPicker(scope);
  const stop = panel.querySelector<HTMLElement>(`[data-access="${value}"]`);
  if (!stop) throw new Error(`No Access stop for ${value}.`);
  fireEvent.pointerDown(stop, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(stop, { button: 0, pointerId: 1 });
}

/** Click Allow on a stop waiting for the Full Access confirmation. */
export function allowAccessStop(scope: Scope = screen): void {
  const panel = openAccessPicker(scope);
  fireEvent.click(within(panel).getByRole("button", { name: /^Allow / }));
}
