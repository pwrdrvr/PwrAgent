import type { Locator, Page } from "@playwright/test";

/**
 * Where the window-level action buttons (Search / Automations / Settings / New
 * Thread) live on the platform the suite is running on.
 *
 * macOS keeps them in the sidebar masthead. Windows and Linux hide that
 * masthead (`app.css`) and paint them into the custom title strip instead,
 * because both hide the native title bar — and with it, on Linux, the frame
 * that Electron would have drawn a menu bar into. One accessible name, two
 * containers.
 *
 * A spec needs the container at all because these names are not unique: the
 * thread header renders its own relocated copy when the sidebar is hidden, and
 * "Search threads" is also the search view's own textbox. Two specs scoped
 * straight to `.sidebar__masthead-actions` and would have failed only on the
 * Linux CI lanes.
 */
export function mastheadActions(window: Page): Locator {
  return window.locator(".sidebar__masthead-actions, .app-titlebar__actions");
}

/** One masthead action button, wherever this platform keeps it. */
export function mastheadAction(window: Page, name: string): Locator {
  return mastheadActions(window).getByRole("button", { name });
}
