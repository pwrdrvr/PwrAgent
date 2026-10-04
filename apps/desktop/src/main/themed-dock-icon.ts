import { join } from "node:path";
import { app, nativeImage } from "electron";
import type { DesktopDarkTheme } from "@pwragent/shared";
import { DESKTOP_DARK_THEME_DEFAULT } from "@pwragent/shared";
import { getMainLogger } from "./log";

/**
 * macOS: a running instance's Dock icon follows its profile's dark theme, so
 * two instances on two profiles in two themes are told apart in the Dock.
 * Each instance is its own Dock tile (the Dock menu's Open Profile launches
 * with `createsNewApplicationInstance`), and each reads its own profile's
 * config, so the icon is per instance with no coordination.
 *
 * The dark theme, not the theme on screen: a profile's icon should not flip
 * with the OS appearance, and the shipped icon is a dark tile. Tangerine
 * keeps the app's own icon, and so does an instance with
 * `[general.appearance] themed_dock_icon = false`.
 *
 * Only the running Dock tile changes. The icon a stopped app shows is the
 * bundle's, which this does not touch.
 *
 * The icons are `build/dock-icons/<theme>.png`, written by
 * `scripts/generate-themed-dock-icons.swift` and packaged as
 * `Resources/dock-icons`.
 */

const log = getMainLogger("pwragent:dock-icon");

/** The icon file a dark theme shows, or null for the app's own icon. */
export function themedDockIconFile(
  darkTheme: DesktopDarkTheme,
  enabled: boolean,
): string | null {
  return enabled && darkTheme !== DESKTOP_DARK_THEME_DEFAULT
    ? `${darkTheme}.png`
    : null;
}

/** The last file applied: undefined until one is, null for the app icon. */
let applied: string | null | undefined;

export function syncThemedDockIcon(appearance: {
  darkTheme: DesktopDarkTheme;
  themedDockIcon: boolean;
}): void {
  if (process.platform !== "darwin" || !app?.dock) return;
  const file = themedDockIconFile(appearance.darkTheme, appearance.themedDockIcon);
  // Never touch the Dock to say "default" before anything changed it: the
  // packaged app's own icon is the Liquid Glass one macOS 26 draws from
  // Assets.car, and a PNG would replace it.
  if (file === applied || (file === null && applied === undefined)) return;

  let icon;
  if (file !== null) {
    const directory = app.isPackaged
      ? join(process.resourcesPath, "dock-icons")
      : join(app.getAppPath(), "build/dock-icons");
    icon = nativeImage.createFromPath(join(directory, file));
    if (icon.isEmpty()) {
      log.warn("themed dock icon missing", { file });
      return;
    }
  } else {
    // An empty image clears the override, so the bundle's icon returns. A
    // development build has no bundle icon of its own, so it goes back to
    // the padded development icon `installDevelopmentDockIcon` sets.
    icon = app.isPackaged
      ? nativeImage.createEmpty()
      : nativeImage.createFromPath(join(app.getAppPath(), "build/icon-macos.png"));
  }
  app.dock.setIcon(icon);
  applied = file;
  log.debug("dock icon synced", { file: file ?? "default" });
}

export function resetThemedDockIconForTests(): void {
  applied = undefined;
}
