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
 * - **y = 13** centres the 14px button in `--chrome-band-h` (40px, in
 *   app.css): (40 - 14) / 2 = 13. That band is the one every top-of-window
 *   bar centres its content in, so the stoplights land on the same y=20
 *   centreline as the wordmark, the thread title, and the Activity and
 *   Settings breadcrumbs.
 *
 * The group is 60px wide, so the buttons end at x=76 and the 80px
 * reservations in `.sidebar__masthead`, `.settings-nav__masthead`,
 * `.activity-titlebar`, and `.star-map__chrome` still clear them.
 *
 * This was `{ x: 20, y: 18 }` from May 2026 until Sept 2026, when
 * `.sidebar` still carried `padding: 42px 16px 0` and the buttons floated
 * in a dead strip above the masthead. The sidebar was rebuilt out from
 * under the number: 20 was 4px past the rail, and 18 sat 5px below the
 * band's centre.
 */
export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 13 } as const;

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
