import { describe, expect, it } from "vitest";
import { clampComposerPopover } from "../useComposerPopoverClamp";

// Geometry measured in headless Chromium on a thread with the sidebar at its
// default width and the context rail pinned. The Add reference popover is
// 440px wide and right-anchored to its "+" trigger.
describe("clampComposerPopover", () => {
  it("moves a popover out from under the sidebar and fits it to the settings row", () => {
    // 1280x800: the pane starts at 408 and the settings row spans 424..836,
    // so the unclamped popover (316..756) had 92px under the sidebar.
    expect(
      clampComposerPopover({
        bounds: { left: 424, right: 836 },
        naturalWidth: 0,
        right: 755.890625,
        shift: 0,
        viewportWidth: 1280,
        width: 440,
      }),
    ).toEqual({ naturalWidth: 440, shift: 80.109375, widthLimit: 412 });
  });

  it("narrows the popover to the whole row at the minimum window", () => {
    // 960x640: the sidebar caps at 360 and the row wraps, putting the
    // trigger's right edge at 434 in a 376..656 row.
    expect(
      clampComposerPopover({
        bounds: { left: 376, right: 656 },
        naturalWidth: 0,
        right: 434,
        shift: 0,
        viewportWidth: 960,
        width: 440,
      }),
    ).toEqual({ naturalWidth: 440, shift: 222, widthLimit: 280 });
  });

  it("returns the same clamp when re-measured after applying it", () => {
    expect(
      clampComposerPopover({
        bounds: { left: 424, right: 836 },
        naturalWidth: 440,
        right: 836,
        shift: 80.109375,
        viewportWidth: 1280,
        width: 412,
      }),
    ).toEqual({ naturalWidth: 440, shift: 80.109375, widthLimit: 412 });
  });

  it("gives back the natural width once the row is wide enough again", () => {
    // Re-measured at 1700x900 while the 1280 clamp is still applied: the
    // rect is 412px wide, so only the remembered natural width can lift the
    // cap.
    expect(
      clampComposerPopover({
        bounds: { left: 424, right: 1256 },
        naturalWidth: 440,
        right: 944.109375,
        shift: 80.109375,
        viewportWidth: 1700,
        width: 412,
      }),
    ).toEqual({ naturalWidth: 440, shift: 0, widthLimit: undefined });
  });

  it("leaves a popover that already fits the row alone", () => {
    expect(
      clampComposerPopover({
        bounds: { left: 424, right: 1256 },
        naturalWidth: 0,
        right: 864,
        shift: 0,
        viewportWidth: 1700,
        width: 440,
      }),
    ).toEqual({ naturalWidth: 440, shift: 0, widthLimit: undefined });
  });

  it("pulls a popover back from the row's right edge", () => {
    expect(
      clampComposerPopover({
        bounds: { left: 424, right: 836 },
        naturalWidth: 0,
        right: 900,
        shift: 0,
        viewportWidth: 1280,
        width: 360,
      }),
    ).toEqual({ naturalWidth: 360, shift: -64, widthLimit: undefined });
  });

  it("falls back to the window gutters without a settings row", () => {
    expect(
      clampComposerPopover({
        naturalWidth: 0,
        right: 1240,
        shift: 0,
        viewportWidth: 1024,
        width: 440,
      }),
    ).toEqual({ naturalWidth: 440, shift: -228, widthLimit: undefined });
    expect(
      clampComposerPopover({
        naturalWidth: 0,
        right: 390,
        shift: 0,
        viewportWidth: 1024,
        width: 440,
      }),
    ).toEqual({ naturalWidth: 440, shift: 62, widthLimit: undefined });
  });

  it("keeps the window gutters when the row runs past the window", () => {
    expect(
      clampComposerPopover({
        bounds: { left: -40, right: 1100 },
        naturalWidth: 0,
        right: 300,
        shift: 0,
        viewportWidth: 400,
        width: 440,
      }),
    ).toEqual({ naturalWidth: 440, shift: 88, widthLimit: 376 });
  });
});
