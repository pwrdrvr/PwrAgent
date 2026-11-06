import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  placeAutomationRowMenu,
  ROW_MENU_EDGE,
  ROW_MENU_GAP,
} from "../automation-row-menu-placement";

/*
 * The rule a row's overflow menu promises:
 *
 *   The menu stays inside the window whenever it fits in it. It never
 *   covers its ⋮ trigger while the room above or below the trigger can hold
 *   it. Below is the first choice.
 *
 * The menu used to sit inside the table, which clips its rounded corners, so
 * the last row's menu was cut off. It is now a fixed portal, and this rule is
 * what its placement owes in place of the table's layout.
 *
 * The oracle checks each side's room from the geometry alone.
 */
const scene = fc
  .record({
    viewportWidth: fc.integer({ min: 200, max: 2400 }),
    viewportHeight: fc.integer({ min: 160, max: 1600 }),
    viewportTop: fc.integer({ min: 8, max: 60 }),
    menuWidth: fc.integer({ min: 132, max: 260 }),
    menuHeight: fc.integer({ min: 40, max: 400 }),
    triggerX: fc.double({ min: 0, max: 1, noNaN: true }),
    triggerY: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map((s) => {
    const right = 24 + Math.round(s.triggerX * (s.viewportWidth - 24));
    const top = s.viewportTop + Math.round(s.triggerY * (s.viewportHeight - s.viewportTop - 24));
    return { ...s, trigger: { top, bottom: top + 24, right } };
  });

describe("placeAutomationRowMenu", () => {
  it("stays in the window, keeps clear of its trigger when a side has room, and prefers below", () => {
    fc.assert(
      fc.property(scene, (s) => {
        const { left, top } = placeAutomationRowMenu(s);
        const floor = s.viewportHeight - ROW_MENU_EDGE;

        if (s.menuWidth <= s.viewportWidth - 2 * ROW_MENU_EDGE) {
          expect(left).toBeGreaterThanOrEqual(ROW_MENU_EDGE);
          expect(left + s.menuWidth).toBeLessThanOrEqual(s.viewportWidth - ROW_MENU_EDGE);
        }
        if (s.menuHeight <= floor - s.viewportTop) {
          expect(top).toBeGreaterThanOrEqual(s.viewportTop);
          expect(top + s.menuHeight).toBeLessThanOrEqual(floor);
        }

        const roomBelow = floor - (s.trigger.bottom + ROW_MENU_GAP);
        const roomAbove = s.trigger.top - ROW_MENU_GAP - s.viewportTop;
        const coversTrigger = top < s.trigger.bottom && top + s.menuHeight > s.trigger.top;
        if (roomBelow >= s.menuHeight) {
          expect(top).toBe(s.trigger.bottom + ROW_MENU_GAP);
        } else if (roomAbove >= s.menuHeight) {
          expect(coversTrigger).toBe(false);
        }
      }),
    );
  });

  it("takes the roomier side when neither fits", () => {
    // A short window with the trigger high: 70px below, 20px above, 100px menu.
    const placed = placeAutomationRowMenu({
      trigger: { top: 40, bottom: 64, right: 400 },
      menuWidth: 140,
      menuHeight: 100,
      viewportWidth: 800,
      viewportHeight: 146,
      viewportTop: 16,
    });
    // Below, clamped to the floor. Flipping up would pin it to the top of
    // the window and cover the trigger more.
    expect(placed.top).toBe(38);
  });
});
