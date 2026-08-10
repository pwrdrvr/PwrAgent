import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAVIGATION_BROWSE_MODE,
  NAVIGATION_BROWSE_MODES,
  normalizeNavigationBrowseMode,
} from "../navigation";

describe("normalizeNavigationBrowseMode", () => {
  it("accepts every declared lens", () => {
    for (const mode of NAVIGATION_BROWSE_MODES) {
      expect(normalizeNavigationBrowseMode(mode)).toBe(mode);
    }
  });

  it("accepts the two state lenses", () => {
    // Regression: preload carried its own hand-copied allowlist that omitted
    // `attention`, so an operator whose saved lens was Attention got Inbox at
    // first paint and then a visible jump. `drafts` is the newer state lens
    // and would have drifted the same way.
    expect(normalizeNavigationBrowseMode("attention")).toBe("attention");
    expect(normalizeNavigationBrowseMode("drafts")).toBe("drafts");
  });

  it("falls back to the default for anything else", () => {
    expect(DEFAULT_NAVIGATION_BROWSE_MODE).toBe("inbox");
    for (const value of [undefined, null, "", "unknown", 3, {}]) {
      expect(normalizeNavigationBrowseMode(value)).toBe(
        DEFAULT_NAVIGATION_BROWSE_MODE,
      );
    }
  });
});
