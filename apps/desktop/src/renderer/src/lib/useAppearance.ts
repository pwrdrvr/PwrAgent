import { useCallback, useEffect, useState } from "react";

import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceAttributes,
  DEFAULT_APPEARANCE,
  readCachedAppearance,
  resolveTheme,
  writeCachedAppearance,
  type AppearancePreference,
  type DensityPreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./appearance";

export type AppearanceState = AppearancePreference & {
  /** Resolved theme actually in effect right now ("system" → "dark" | "light"). */
  resolvedTheme: ResolvedTheme;
};

export type AppearanceController = {
  appearance: AppearanceState;
  setTheme(theme: ThemePreference): void;
  setDensity(density: DensityPreference): void;
  setAppearance(preference: AppearancePreference): void;
};

/**
 * React hook owning the live appearance state. Mounts the matchMedia
 * listener so `theme: "system"` flips with the OS theme change, syncs
 * the localStorage cache (so the next bootstrap can apply attributes
 * synchronously pre-React), and exposes setters that the Settings UI
 * uses to update preferences.
 *
 * Source of truth for persistence is the main-process per-profile
 * config; the IPC wiring lands in Step 3 of issue #472. For now this
 * hook owns the renderer-side state and is agnostic to where the
 * preference comes from — pass in `initial` to override the localStorage
 * default when the IPC value lands.
 */
export function useAppearance(): AppearanceController {
  const [appearance, setAppearanceState] = useState<AppearanceState>(() => {
    const cached = readCachedAppearance();
    return {
      ...cached,
      resolvedTheme: resolveTheme(cached.theme),
    };
  });

  // Apply DOM attributes + persist cache whenever the preference changes.
  useEffect(() => {
    applyAppearanceAttributes(appearance.resolvedTheme, appearance.density);
    writeCachedAppearance({
      theme: appearance.theme,
      density: appearance.density,
    });
  }, [appearance.resolvedTheme, appearance.density, appearance.theme]);

  // Subscribe to prefers-color-scheme changes so `theme: "system"` flips
  // live when the OS theme changes. Unsubscribe on unmount.
  useEffect(() => {
    if (appearance.theme !== "system") return;
    if (
      typeof window === "undefined"
      || typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (): void => {
      setAppearanceState((current) => {
        if (current.theme !== "system") return current;
        return {
          ...current,
          resolvedTheme: resolveTheme("system"),
        };
      });
    };
    query.addEventListener("change", handleChange);
    return () => {
      query.removeEventListener("change", handleChange);
    };
  }, [appearance.theme]);

  // Cross-tab sync: another renderer window in the same profile changing
  // the appearance fires a `storage` event here. Mirror the change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== APPEARANCE_STORAGE_KEY) return;
      const next = readCachedAppearance();
      setAppearanceState({
        ...next,
        resolvedTheme: resolveTheme(next.theme),
      });
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const setTheme = useCallback((theme: ThemePreference) => {
    setAppearanceState((current) => ({
      ...current,
      theme,
      resolvedTheme: resolveTheme(theme),
    }));
  }, []);

  const setDensity = useCallback((density: DensityPreference) => {
    setAppearanceState((current) => ({
      ...current,
      density,
    }));
  }, []);

  const setAppearance = useCallback((preference: AppearancePreference) => {
    setAppearanceState({
      ...preference,
      resolvedTheme: resolveTheme(preference.theme),
    });
  }, []);

  return {
    appearance,
    setTheme,
    setDensity,
    setAppearance,
  };
}

export { DEFAULT_APPEARANCE };
export type { ThemePreference, DensityPreference, ResolvedTheme };
