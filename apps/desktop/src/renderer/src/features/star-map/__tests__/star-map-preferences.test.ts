import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STAR_MAP_PREFERENCES,
  readStoredPreferences,
} from "../star-map-preferences";

const STORAGE_KEY = "pwragent.starMap.viewPreferences";

function seed(value: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

/**
 * The default lens is a product decision (orbit shows the fleet as a
 * fleet), and it must have exactly one definition: the constant. Every
 * suite that renders the map either seeds a layout or deliberately runs
 * the default, so without these assertions a revert of the constant —
 * or a second default hiding in `readStoredPreferences`' fallback —
 * would ship fully green.
 */
describe("star map view preferences", () => {
  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("defaults a fresh profile to the orbit lens", () => {
    expect(DEFAULT_STAR_MAP_PREFERENCES.layout).toBe("orbit");
    expect(readStoredPreferences().layout).toBe("orbit");
  });

  it("keeps an explicitly stored layout, including lanes", () => {
    for (const layout of ["lanes", "orbit", "projects"] as const) {
      seed({ layout });
      expect(readStoredPreferences().layout).toBe(layout);
    }
  });

  it("falls back to the SAME default for a blob without a layout", () => {
    // The pre-facet blob shape (and any partial write) has no `layout`
    // key. It must resolve to the fresh-profile default, not to a
    // second hardcoded answer — an operator who never chose a lens gets
    // the default lens, stored blob or not.
    seed({ hideOfflineInstances: true });
    expect(readStoredPreferences().layout).toBe(
      DEFAULT_STAR_MAP_PREFERENCES.layout,
    );

    seed({ layout: "not-a-lens" });
    expect(readStoredPreferences().layout).toBe(
      DEFAULT_STAR_MAP_PREFERENCES.layout,
    );
  });

  it("merges stored card fields over the defaults", () => {
    seed({ layout: "lanes", cardFields: { provider: true } });
    const preferences = readStoredPreferences();
    expect(preferences.cardFields.provider).toBe(true);
    expect(preferences.cardFields.primaryDirectory).toBe(
      DEFAULT_STAR_MAP_PREFERENCES.cardFields.primaryDirectory,
    );
  });
});
