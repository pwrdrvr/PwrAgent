import { describe, expect, it } from "vitest";

import { resolveScreenshotAppearance } from "../../../e2e/fixtures/screenshot-appearance";

describe("resolveScreenshotAppearance", () => {
  it("defaults to dark + mission-control when no env vars are set", () => {
    expect(resolveScreenshotAppearance({})).toEqual({
      theme: "dark",
      density: "mission-control",
    });
  });

  it("reads PWRAGENT_SCREENSHOT_THEME for theme overrides", () => {
    expect(
      resolveScreenshotAppearance({ PWRAGENT_SCREENSHOT_THEME: "light" }),
    ).toEqual({ theme: "light", density: "mission-control" });

    expect(
      resolveScreenshotAppearance({ PWRAGENT_SCREENSHOT_THEME: "system" }),
    ).toEqual({ theme: "system", density: "mission-control" });

    expect(
      resolveScreenshotAppearance({ PWRAGENT_SCREENSHOT_THEME: "dark" }),
    ).toEqual({ theme: "dark", density: "mission-control" });
  });

  it("reads PWRAGENT_SCREENSHOT_DENSITY for density overrides", () => {
    expect(
      resolveScreenshotAppearance({
        PWRAGENT_SCREENSHOT_DENSITY: "compact",
      }),
    ).toEqual({ theme: "dark", density: "compact" });
  });

  it("falls back to defaults for unrecognized values without throwing", () => {
    // Defensive: env vars are user-supplied strings. Garbage in shouldn't
    // crash the screenshot run — it should just behave as if the var
    // weren't set so the committed PNGs keep capturing under the same
    // baseline.
    expect(
      resolveScreenshotAppearance({
        PWRAGENT_SCREENSHOT_THEME: "high-contrast",
        PWRAGENT_SCREENSHOT_DENSITY: "ultra-tight",
      }),
    ).toEqual({ theme: "dark", density: "mission-control" });
  });

  it("combines both env vars independently", () => {
    expect(
      resolveScreenshotAppearance({
        PWRAGENT_SCREENSHOT_THEME: "light",
        PWRAGENT_SCREENSHOT_DENSITY: "compact",
      }),
    ).toEqual({ theme: "light", density: "compact" });
  });
});
