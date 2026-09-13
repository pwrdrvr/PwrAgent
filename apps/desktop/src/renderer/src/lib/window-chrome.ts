import { getDesktopApi } from "./desktop-api";

/**
 * Which platforms hide the native title bar and hand the strip to the
 * renderer to paint.
 *
 * macOS hides it too, but keeps a system menu bar at the top of the screen and
 * floats its stoplights over our content — so the shell window there keeps the
 * sidebar masthead and needs no painted strip. Windows and Linux lose the
 * native title bar AND the menu bar that lived in it, so both mount
 * `AppTitleBar`: the wordmark, the painted `AppMenuBar`, the masthead actions,
 * and the panel/Star Map/MSG cluster, all on one line.
 *
 * The two still differ in who draws min/max/close, which is what
 * `paintsOwnWindowControls` below answers.
 */
export function paintsAppTitleBar(
  platform: string | undefined = getDesktopApi()?.platform,
): boolean {
  return platform === "win32" || platform === "linux";
}

/**
 * Whether the renderer has to draw the caption buttons itself.
 *
 * Windows reserves a Window Controls Overlay at the strip's right edge and the
 * OS paints min/max/close into it; macOS floats its stoplights. A frameless
 * Linux window gets neither — `titleBarStyle: "hidden"` there is exactly
 * `frame: false` and there is no overlay API — so without `WindowControls` it
 * has no window buttons at all.
 */
export function paintsOwnWindowControls(
  platform: string | undefined = getDesktopApi()?.platform,
): boolean {
  return platform === "linux";
}
