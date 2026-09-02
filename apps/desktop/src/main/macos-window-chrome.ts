import type { BrowserWindowConstructorOptions } from "electron";

/**
 * Where macOS draws the stoplights inside our `hiddenInset` windows.
 *
 * Both numbers are derived from the chrome they sit in, not tuned by eye:
 *
 * - **x = 16** is `--sidebar-rail-inset` (`.sidebar` in app.css). The
 *   stoplights are the first thing in the sidebar's top row, so they start
 *   on the same rail as the wordmark, the lens switch, and every thread
 *   row below them.
 * - **y = 16** puts the 14px button's centre at y=23, which is the
 *   wordmark's cap-height centre in the 44px masthead (`.sidebar__masthead`
 *   pads 10px above a 34px `.sidebar__icon-button` row). The masthead has
 *   no bottom border, so the wordmark — not the band — is what the eye
 *   lines the buttons up against. `.activity-titlebar` on the auxiliary
 *   windows is the same 44px box, so one value serves both.
 *
 * The group is 60px wide, so the buttons end at x=76 and the 80px
 * reservations in `.sidebar__masthead`, `.settings-nav__masthead`,
 * `.activity-titlebar`, and `.star-map__chrome` still clear them.
 *
 * This was `{ x: 20, y: 18 }` from May 2026 until Sept 2026, when
 * `.sidebar` still carried `padding: 42px 16px 0` and the buttons floated
 * in a dead strip above the masthead. The sidebar was rebuilt out from
 * under the number: 20 was 4px past the rail, and 18 left 18px above the
 * buttons against 12px below.
 */
export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 16 } as const;

/**
 * The macOS half of our window chrome: no native title bar, stoplights
 * floated over the renderer at the shared position above. The main window
 * and every auxiliary window spread this, so the two can't drift.
 */
export function macosTitleBarChrome(): Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition"
> {
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { ...MACOS_TRAFFIC_LIGHT_POSITION },
  };
}
