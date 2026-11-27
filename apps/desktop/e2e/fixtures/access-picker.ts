import type { Locator, Page } from "@playwright/test";

/**
 * The composer's access control: a shield button named "Access: <level>"
 * whose `data-value` is the chosen option, opening an "Access" dialog with a
 * stepped level bar. Each stop carries its option value as `data-access`.
 */
export function accessTrigger(scope: Page | Locator): Locator {
  return scope.getByRole("button", { name: /^Access: / });
}

/** Open the picker (if closed) and return its dialog. */
export async function openAccessPicker(scope: Page | Locator): Promise<Locator> {
  const trigger = accessTrigger(scope);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const panel = scope.locator(".access-picker__panel");
  await panel.waitFor({ state: "visible" });
  return panel;
}

/** Click the stop for an option value, such as `full-access`. */
export async function chooseAccessStop(scope: Page | Locator, value: string): Promise<Locator> {
  const panel = await openAccessPicker(scope);
  await panel.locator(`[data-access="${value}"]`).click();
  return panel;
}

/** Choose Full Access and click its inline Allow. */
export async function allowFullAccess(scope: Page | Locator): Promise<void> {
  const panel = await chooseAccessStop(scope, "full-access");
  await panel.getByRole("button", { name: "Allow Full Access" }).click();
}
