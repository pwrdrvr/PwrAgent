import { release } from "node:os";
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
 * `app.dock.setIcon()` paints a bitmap literally, and macOS 26 applies
 * Liquid Glass only to a bundle's own Icon Composer icon, never to one set at
 * runtime, and has no API to switch a running app to another. So there are
 * two sets, each the finished tile for the macOS it is shown on:
 * `build/dock-icons/glass/<theme>.png` has macOS 26's glass rim and mark
 * shadow rendered in, and `build/dock-icons/<theme>.png` is the flat tile
 * macOS 15 and earlier draw. Both are written by
 * `scripts/generate-themed-dock-icons.swift` and packaged as
 * `Resources/dock-icons`.
 *
 * The glass set is the Default icon style's. The Dark, Clear, and Tinted
 * styles are kept by the window server behind private API, and a runtime
 * icon is not restyled by any of them, so a themed icon looks the same in
 * every style, as the flat one did.
 */

const log = getMainLogger("pwragent:dock-icon");

/**
 * Whether this Mac draws app icons in Liquid Glass: macOS 26 and later,
 * which is Darwin 25. The kernel release, as `federation-local-network.ts`
 * reads it, does not depend on the SDK the binary was built against.
 */
export function drawsLiquidGlassIcons(darwinRelease: string = release()): boolean {
  return Number(darwinRelease.split(".")[0]) >= 25;
}

/**
 * The icon file a dark theme shows, relative to the icon directory, or null
 * for the app's own icon.
 */
export function themedDockIconFile(
  darkTheme: DesktopDarkTheme,
  enabled: boolean,
  liquidGlass: boolean,
): string | null {
  if (!enabled || darkTheme === DESKTOP_DARK_THEME_DEFAULT) return null;
  return liquidGlass ? join("glass", `${darkTheme}.png`) : `${darkTheme}.png`;
}

/** The last file applied: undefined until one is, null for the app icon. */
let applied: string | null | undefined;

export function syncThemedDockIcon(appearance: {
  darkTheme: DesktopDarkTheme;
  themedDockIcon: boolean;
}): void {
  if (process.platform !== "darwin" || !app?.dock) return;
  const file = themedDockIconFile(
    appearance.darkTheme,
    appearance.themedDockIcon,
    drawsLiquidGlassIcons(),
  );
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
