import { expect, type Locator, type Page } from "@playwright/test";
import { openLaunchpadWherePanel } from "./launchpad-where";
import { tolerateTransientRpcFailure } from "./transient-rpc-poll";

/**
 * The composer's control row is one line. Controls that do not fit fold into
 * ⋮ (Thread options) in a fixed order: first the Details-bound controls
 * (editor and terminal apps, Plan, PR Auto-fix), then the Run split (the
 * environment, its commands and ▶), dictation and attach. Which ones fold
 * depends on the pane's width, so these helpers drive a control in the row
 * when it is there and through ⋮ when it has folded. The Where icon never
 * folds: a thread's directories and handoffs, and a new thread's project,
 * checkout and environment, are in its panel.
 */
export type ComposerFoldTier = "details" | "run" | "dictation" | "attach";

const FOLD_TIERS: readonly ComposerFoldTier[] = ["details", "run", "dictation", "attach"];

function composerRow(page: Page): Locator {
  return page.locator(".composer__setup").first();
}

/**
 * Whether `tier` is folded into ⋮, once `control` is in the row (folded or
 * not) and the row has stopped refolding. A control that arrives late (the
 * environment pickers load after the thread opens) folds a frame after it
 * appears, so neither its absence nor one read of the row settles it.
 */
export async function isComposerTierFolded(
  page: Page,
  tier: ComposerFoldTier,
  control: Locator,
): Promise<boolean> {
  const row = composerRow(page);
  await expect(control.first()).toBeAttached();
  await expect(row).toHaveAttribute("data-folded-tiers", /^\d$/);
  let previous = "";
  const settledFold = tolerateTransientRpcFailure(async () => {
    const current = await row.evaluate((element) =>
      `${element.getAttribute("data-folded-tiers")}:${element.querySelectorAll("[data-composer-fold]").length}`);
    const settled = current === previous;
    previous = current;
    return settled;
  });
  await expect
    .poll(settledFold.read, {
      intervals: [100, 150, 200, 250],
      message: "the composer row kept refolding",
    })
    .toBe(true)
    .catch(settledFold.rethrowWithLastFailure);
  return Number(await row.getAttribute("data-folded-tiers")) > FOLD_TIERS.indexOf(tier);
}

/** A row button by name, whether drawn or folded out of sight. */
export function composerRowButton(page: Page, name: RegExp | string): Locator {
  return composerRow(page).getByRole("button", { name, exact: true, includeHidden: true });
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

export async function closeComposerThreadOptions(page: Page): Promise<void> {
  const menu = page.getByRole("menu", { name: "Thread options" });
  if (await menu.isVisible()) await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

function isLaunchpadRow(page: Page): Promise<boolean> {
  return composerRow(page).evaluate((row) => row.getAttribute("aria-label") === "New thread settings");
}

/** Which of the Run split's radio groups a picker name means. */
function runSplitGroup(control: RegExp): "Environment" | "Command" {
  return /command/i.test(control.source) ? "Command" : "Environment";
}

/** The Run split's menu half; it is named for the thread's environment. */
function runSplitMenuButton(page: Page): Locator {
  return composerRow(page).locator(".composer-run__menu-button");
}

async function openRunSplitMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "Environment and commands" });
  if (!(await menu.isVisible())) await runSplitMenuButton(page).click();
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Chooses `option` for the environment or its command (`control` is the
 * Environment or Environment command name). A thread's are in the Run
 * split's menu, or ⋮ when it has folded; a new thread's environment is in
 * its Where panel.
 */
export async function chooseComposerOption(page: Page, control: RegExp, option: string): Promise<void> {
  if (await isLaunchpadRow(page)) {
    await openLaunchpadWherePanel(page);
    await page.getByRole("dialog", { name: "Where this thread runs" })
      .getByRole("button", { name: control }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
    return;
  }
  if (await isComposerTierFolded(page, "run", runSplitMenuButton(page))) {
    const menu = await openComposerThreadOptions(page);
    await menu.getByRole("menuitemradio", { name: option, exact: true }).click();
    await expect(menu).toBeHidden();
    return;
  }
  const menu = await openRunSplitMenu(page);
  await menu.getByRole("group", { name: runSplitGroup(control) })
    .getByRole("menuitemradio", { name: option, exact: true }).click();
  await expect(menu).toBeHidden();
}

/** Expects the environment or its command to be `option`, wherever it is chosen. */
export async function expectComposerOption(page: Page, control: RegExp, option: string): Promise<void> {
  if (await isLaunchpadRow(page)) {
    await openLaunchpadWherePanel(page);
    await expect(page.getByRole("dialog", { name: "Where this thread runs" })
      .getByRole("button", { name: control })).toContainText(option);
    return;
  }
  if (await isComposerTierFolded(page, "run", runSplitMenuButton(page))) {
    const menu = await openComposerThreadOptions(page);
    await expect(menu.getByRole("menuitemradio", { name: option, exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await closeComposerThreadOptions(page);
    return;
  }
  const menu = await openRunSplitMenu(page);
  await expect(menu.getByRole("group", { name: runSplitGroup(control) })
    .getByRole("menuitemradio", { name: option, exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

/**
 * Expects the composer to offer no environment: no Run split in the row,
 * drawn or folded, so none in ⋮ either.
 */
export async function expectNoComposerEnvironment(page: Page): Promise<void> {
  await expect(composerRow(page)).toHaveAttribute("data-folded-tiers", /^\d$/);
  await expect(runSplitMenuButton(page)).toHaveCount(0);
}

/** Runs the selected environment command: the Run split's ▶, or its ▶ in ⋮. */
export async function runComposerCommand(page: Page): Promise<void> {
  if (await isComposerTierFolded(page, "run", runSplitMenuButton(page))) {
    const menu = await openComposerThreadOptions(page);
    await menu
      .locator(".composer-thread-options__command", { has: page.locator("[aria-checked='true']") })
      .getByRole("menuitem", { name: /^Run / })
      .click();
    await expect(menu).toBeHidden();
    return;
  }
  await composerRow(page).locator(".composer-run__run").click();
}

/** Opens a thread's Where panel: its directories, Add directory, and handoffs. */
export async function openComposerWherePanel(page: Page): Promise<Locator> {
  const panel = page.getByRole("dialog", { name: "Where this thread runs" });
  if (!(await panel.isVisible())) {
    await composerRow(page).getByRole("button", { name: /^Where:/ }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeComposerWherePanel(page: Page): Promise<void> {
  const panel = page.getByRole("dialog", { name: "Where this thread runs" });
  if (await panel.isVisible()) await composerRow(page).getByRole("button", { name: /^Where:/ }).click();
  await expect(panel).toBeHidden();
}

/** Picks a workspace handoff action from the thread's Where panel. */
export async function chooseComposerWorkspaceAction(page: Page, action: string): Promise<void> {
  const panel = await openComposerWherePanel(page);
  await panel.getByRole("button", { name: action, exact: true }).click();
}

/**
 * Starts dictation: the row's button, or ⋮'s item when dictation has folded.
 * A listening dictation never folds, so its Stop button is always in the row.
 */
export async function startComposerDictation(page: Page): Promise<void> {
  const name = "Dictate with OpenAI";
  if (await isComposerTierFolded(page, "dictation", composerRowButton(page, name))) {
    const menu = await openComposerThreadOptions(page);
    await menu.getByRole("menuitem", { name, exact: true }).click();
    await expect(menu).toBeHidden();
    return;
  }
  await composerRow(page).getByRole("button", { name, exact: true }).click();
}

/**
 * Turns Plan mode on for the next send: the row's toggle, or ⋮'s item when
 * it has folded. Once on, the toggle stays in the row.
 */
export async function enableComposerPlanMode(page: Page): Promise<void> {
  const name = "Plan mode";
  const toggle = composerRowButton(page, name);
  if (await isComposerTierFolded(page, "details", toggle)) {
    const menu = await openComposerThreadOptions(page);
    await menu.getByRole("menuitemcheckbox", { name, exact: true }).click();
    await expect(menu).toBeHidden();
  } else {
    await composerRow(page).getByRole("button", { name, exact: true }).click();
  }
  await expect(composerRow(page).getByRole("button", { name, exact: true }))
    .toHaveAttribute("aria-pressed", "true");
}
