import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

const HAIRLINE_SELECTOR =
  ':root[data-platform="linux"]:not([data-window-frame="maximized"]) #root::after';

/** Where the hairline's own declaration block sits in app.css. */
function hairlineRange(): { start: number; end: number } {
  const start = css.indexOf(`\n${HAIRLINE_SELECTOR} {`);
  expect(start, `app.css should declare ${HAIRLINE_SELECTOR}`).toBeGreaterThan(-1);
  return { start, end: css.indexOf("\n}", start) };
}

function hairlineBody(): string {
  const { start, end } = hairlineRange();
  return css.slice(start, end);
}

/**
 * The window's own edge on Linux, where Electron draws none: a frameless
 * window there gets an `OpaqueFrameView` with no border, no rounded corners,
 * and no drop shadow on X11.
 *
 * None of this is checkable from macOS, and the renderer suite never runs with
 * `data-platform="linux"`, so these assertions read the stylesheet.
 */
describe("Linux window edge hairline", () => {
  it("paints a hairline that costs no layout and swallows no clicks", () => {
    const body = hairlineBody();

    expect(body).toContain("position: fixed;");
    expect(body).toContain("inset: 0;");
    expect(body).toContain("border: 1px solid var(--border-strong);");
    // A frameless window is still resizable — `FramelessView::
    // ResizingBorderHitTest` uses an inside-bounds resize border with 16px
    // corner grabs, directly under this overlay. Without `pointer-events:
    // none` the hairline eats every resize drag and every click on whatever
    // sits at the window's edge.
    expect(body).toContain("pointer-events: none;");
  });

  it("keeps the edge above every layer in the file", () => {
    // The window's edge is chrome; no app layer should paint over it. Derived
    // rather than pinned to a number, so a new layer that outranks it fails
    // here instead of clipping the edge on a machine no one tests on.
    const hairline = /z-index:\s*(\d+);/.exec(hairlineBody());
    expect(hairline, "the hairline should declare a z-index").not.toBeNull();

    // Exclude the hairline's own declaration by POSITION, not by value:
    // filtering on the number would also drop a different rule that happened
    // to declare 10001, and the test would pass while that rule — later in
    // source order, so painted on top at equal z-index — covered the edge.
    const { start, end } = hairlineRange();
    const ceiling = Math.max(
      ...[...css.matchAll(/z-index:\s*(\d+)/g)]
        .filter((match) => (match.index ?? 0) < start || (match.index ?? 0) >= end)
        .map((match) => Number(match[1])),
    );
    expect(Number(hairline?.[1])).toBeGreaterThan(ceiling);
  });

  it("drops the edge when the window is flush with the screen", () => {
    // A maximized window has no edge to show, and `data-window-frame` follows
    // the WINDOW's maximize events rather than our caption button — Super+Up
    // and a tiling keybind maximize without going through it.
    expect(css).toContain(':not([data-window-frame="maximized"])');
  });

  it("gives the edge to every window, not only the one painting a strip", () => {
    // `#root`, not `.app-shell`: the auxiliary windows keep the native Linux
    // frame, whose GTK border vanishes against our own dark surfaces, and they
    // render no `.app-shell` at all.
    //
    // Read app.css for it. Asserting that HAIRLINE_SELECTOR — this file's own
    // constant — contains "#root::after" compares a literal to itself and
    // stays green however the stylesheet is rewritten.
    const declared = [
      ...css.matchAll(/\n(:root\[data-platform="linux"\][^\n{]*::after)\s*\{/g),
    ].map((match) => match[1]);

    expect(declared, "app.css should declare exactly one Linux edge").toEqual([
      HAIRLINE_SELECTOR,
    ]);
    expect(declared[0]).toContain("#root::after");
    expect(declared[0]).not.toContain(".app-shell");
  });

  it("stays square-cornered", () => {
    // There is no rounded-corner option for a frameless window: Electron
    // handles `roundedCorners` inside `#if BUILDFLAG(IS_WIN)`, and the only
    // way to round one is `transparent: true`, which Electron documents as
    // giving up resizing. A `border-radius` here would round the hairline
    // while the window itself stayed square, leaving the corner pixels
    // outside the line.
    expect(hairlineBody()).not.toContain("border-radius");
  });
});
