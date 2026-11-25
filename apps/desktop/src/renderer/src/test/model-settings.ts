import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Drive `ModelSettingsPicker` the way an operator does: open the pill, then
 * pick in its panel. The pill's accessible name starts with its label
 * ("Model settings", "Model for the new thread", "Claude default model") and
 * a colon; its `data-model`, `data-effort`, `data-speed` and `data-provider`
 * carry the current values.
 */
type Scope = Pick<typeof screen, "getByRole" | "queryByRole" | "getAllByRole">;

const DEFAULT_LABEL = "Model settings";

function pillName(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::|$)`);
}

export function modelSettingsPill(label = DEFAULT_LABEL, scope: Scope = screen): HTMLElement {
  return scope.getByRole("button", { name: pillName(label) });
}

export function queryModelSettingsPill(label = DEFAULT_LABEL, scope: Scope = screen): HTMLElement | null {
  return scope.queryByRole("button", { name: pillName(label) });
}

/** Open the pill's panel (if closed) and return it. */
export function openModelSettings(label = DEFAULT_LABEL, scope: Scope = screen): HTMLElement {
  const pill = modelSettingsPill(label, scope);
  if (pill.getAttribute("aria-expanded") !== "true") fireEvent.click(pill);
  const id = pill.getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error(`The ${label} panel did not open.`);
  return panel;
}

/** Pick a row in the panel's Provider rail or Model list. */
export function chooseModelSettingsOption(
  list: "Provider" | "Model",
  optionName: string | RegExp,
  label = DEFAULT_LABEL,
  scope: Scope = screen,
): void {
  const panel = openModelSettings(label, scope);
  const listboxes = within(panel).getAllByRole("listbox")
    .filter((listbox) => {
      const name = listbox.getAttribute("aria-label") ?? "";
      return name === list || name.startsWith(`${list}: `);
    });
  const match = listboxes
    .flatMap((listbox) => within(listbox).queryAllByRole("option", { name: optionName }))[0];
  if (match) {
    fireEvent.click(match);
    return;
  }
  // The row may sit behind a disclosure (Other Models, Unavailable).
  for (const disclosure of panel.querySelectorAll<HTMLButtonElement>("button[aria-expanded='false']")) {
    fireEvent.click(disclosure);
  }
  const listbox = within(panel).getAllByRole("listbox")
    .filter((candidate) => (candidate.getAttribute("aria-label") ?? "").startsWith(list));
  const option = listbox.flatMap((candidate) => within(candidate).queryAllByRole("option", { name: optionName }))[0];
  if (!option) throw new Error(`No ${list} option ${String(optionName)}.`);
  fireEvent.click(option);
}

/** The option names a panel list offers, in order. */
export function modelSettingsOptionNames(list: "Provider" | "Model", label = DEFAULT_LABEL, scope: Scope = screen): string[] {
  const panel = openModelSettings(label, scope);
  const listbox = within(panel).getByRole("listbox", { name: list });
  return within(listbox).getAllByRole("option").map((option) =>
    option.querySelector(".model-settings__option-label")?.textContent ?? "");
}

/** Click (press and release) an effort stop on the bar. */
export function chooseEffort(effort: string, label = DEFAULT_LABEL, scope: Scope = screen): void {
  const panel = openModelSettings(label, scope);
  const stop = panel.querySelector<HTMLElement>(`[data-effort="${effort}"]`);
  if (stop) {
    fireEvent.pointerDown(stop, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(stop, { button: 0, pointerId: 1 });
    return;
  }
  // Not a level: the default chip.
  fireEvent.click(within(panel).getByRole("button", { name: effort }));
}

/** The efforts the bar offers, in order. */
export function effortStops(label = DEFAULT_LABEL, scope: Scope = screen): string[] {
  const panel = openModelSettings(label, scope);
  return [...panel.querySelectorAll<HTMLElement>("[data-effort]")].map((stop) => stop.dataset.effort ?? "");
}

/** Pick a speed: Standard, Fast or Ultrafast. */
export function chooseSpeed(speed: "Standard" | "Fast" | "Ultrafast", label = DEFAULT_LABEL, scope: Scope = screen): void {
  const panel = openModelSettings(label, scope);
  fireEvent.click(within(panel).getByRole("radio", { name: speed }));
}

/** The speeds the panel offers; empty when it has no Speed row. */
export function speedChoices(label = DEFAULT_LABEL, scope: Scope = screen): string[] {
  if (!queryModelSettingsPill(label, scope)) return [];
  const panel = openModelSettings(label, scope);
  return within(panel).queryAllByRole("radio").map((radio) => radio.textContent ?? "");
}
