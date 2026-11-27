import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The composer's control row is one line. Controls that do not fit fold into
 * ⋮ (Thread options) in a fixed order: first the Details-bound controls
 * (environment, command, editor and terminal apps, workspace handoff), then
 * the environment ▶, dictation and attach. Which ones fold depends on the
 * pane's width, so these helpers drive a control in the row when it is there
 * and through ⋮ when it has folded.
 */
export type ComposerFoldTier = "details" | "run" | "dictation" | "attach";

const FOLD_TIERS: readonly ComposerFoldTier[] = ["details", "run", "dictation", "attach"];

function composerRow(page: Page): Locator {
  return page.locator(".composer__setup").first();
}

/**
 * Whether `tier` is folded into ⋮, once the row has stopped refolding. A
 * control that arrives late (an environment list, a running dictation) folds
 * a frame after it appears, so one read is not enough.
 */
export async function isComposerTierFolded(page: Page, tier: ComposerFoldTier): Promise<boolean> {
  const row = composerRow(page);
  await expect(row).toHaveAttribute("data-folded-tiers", /^\d$/);
  let previous = "";
  await expect
    .poll(async () => {
      const current = await row.evaluate((element) =>
        `${element.getAttribute("data-folded-tiers")}:${element.querySelectorAll("[data-composer-fold]").length}`);
      const settled = current === previous;
      previous = current;
      return settled;
    }, { intervals: [100, 150, 200, 250] })
    .toBe(true);
  return Number(await row.getAttribute("data-folded-tiers")) > FOLD_TIERS.indexOf(tier);
}

/** Opens ⋮ and returns its menu. */
export async function openComposerThreadOptions(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "Thread options" });
  if (!(await menu.isVisible())) {
    await composerRow(page).getByRole("button", { name: /^Thread options/ }).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

async function closeComposerThreadOptions(page: Page): Promise<void> {
  const menu = page.getByRole("menu", { name: "Thread options" });
  if (await menu.isVisible()) await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

/**
 * Chooses `option` from a Details-bound dropdown in the row (the Environment
 * or Environment command picker, by its accessible name), or from the same
 * choice's radio group in ⋮ when it has folded.
 */
export async function chooseComposerOption(page: Page, control: RegExp, option: string): Promise<void> {
  if (await isComposerTierFolded(page, "details")) {
    const menu = await openComposerThreadOptions(page);
    await menu.getByRole("menuitemradio", { name: option, exact: true }).click();
    await expect(menu).toBeHidden();
    return;
  }
  await composerRow(page).getByRole("button", { name: control, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/**
 * Expects a Details-bound dropdown to show `option`: its label in the row, or
 * the checked radio in ⋮ when it has folded.
 */
export async function expectComposerOption(page: Page, control: RegExp, option: string): Promise<void> {
  if (await isComposerTierFolded(page, "details")) {
    const menu = await openComposerThreadOptions(page);
    await expect(menu.getByRole("menuitemradio", { name: option, exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await closeComposerThreadOptions(page);
    return;
  }
  await expect(composerRow(page).getByRole("button", { name: control, exact: true }))
    .toContainText(option);
}

/** Expects the composer to offer no environment, in the row or in ⋮. */
export async function expectNoComposerEnvironment(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /^Environment(?::|$)/, exact: true })).toHaveCount(0);
  if (await isComposerTierFolded(page, "details")) {
    const menu = await openComposerThreadOptions(page);
    await expect(menu.getByRole("menuitemradio", { name: "No environment", exact: true })).toHaveCount(0);
    await closeComposerThreadOptions(page);
  }
}

/** Runs the selected environment command: the row's ▶, or its ▶ in ⋮. */
export async function runComposerCommand(page: Page): Promise<void> {
  if (await isComposerTierFolded(page, "run")) {
    const menu = await openComposerThreadOptions(page);
    await menu
      .locator(".composer-thread-options__command", { has: page.locator("[aria-checked='true']") })
      .getByRole("menuitem", { name: /^Run / })
      .click();
    await expect(menu).toBeHidden();
    return;
  }
  await composerRow(page).getByRole("button", { name: "Run", exact: true }).click();
}

/** Picks a workspace handoff action from the row's Workspace mode menu, or from ⋮. */
export async function chooseComposerWorkspaceAction(page: Page, action: string): Promise<void> {
  if (await isComposerTierFolded(page, "details")) {
    const menu = await openComposerThreadOptions(page);
    await menu.getByRole("menuitem", { name: action, exact: true }).click();
    return;
  }
  await composerRow(page).getByLabel(/^Workspace mode(?::|$)/).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
