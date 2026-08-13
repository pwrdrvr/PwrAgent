import { useCallback, useEffect, useRef, useState } from "react";

import type { DesktopSettingsConfigPatch } from "@pwragent/shared";
import {
  applyAppearanceAttributes,
  DEFAULT_APPEARANCE,
  readBridgedAppearance,
  resolveTheme,
  type AppearancePreference,
  type DensityPreference,
  type ResolvedTheme,
  type TextSizePreference,
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
  setSidebarTextSize(sidebarTextSize: TextSizePreference): void;
  setTranscriptTextSize(transcriptTextSize: TextSizePreference): void;
  setAppearance(preference: AppearancePreference): void;
};

export type UseAppearanceInput = {
  /** Authoritative preference from the per-profile settings snapshot.
   *  When this arrives (or changes — e.g. another window writes the
   *  TOML), the hook adopts it. Undefined while settings are still
   *  loading; the hook bootstraps from `window.__pwragentAppearance`
   *  in the meantime so the React state matches what the pre-mount
   *  bootstrap script already applied to `<html>`. */
  snapshotPreference: AppearancePreference | undefined;
  /** Writes the new appearance back to TOML via the existing
   *  writeSettingsConfig IPC. Returns true on success. */
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
};

/**
 * React hook owning the live appearance state. Source of truth is the
 * per-profile config.toml (read by the parent via the existing settings
 * snapshot and passed in via `snapshotPreference`). Setters call back
 * through `writeConfig` to update the TOML; the hook also applies the
 * change locally for immediate visual feedback so the user doesn't have
 * to wait for the IPC round-trip.
 *
 * Mounts a matchMedia listener so `theme: "system"` flips live with
 * the OS theme. The pre-React bootstrap script in `index.html` sets the
 * initial `<html data-*>` attributes synchronously from the preload-
 * bridged value (sourced from the same TOML in main process) — this
 * hook then keeps them in sync as the user toggles settings.
 */
export function useAppearance(input: UseAppearanceInput): AppearanceController {
  const { snapshotPreference, writeConfig } = input;
  const snapshotDensity = snapshotPreference?.density;
  const snapshotTheme = snapshotPreference?.theme;
  const snapshotSidebarTextSize = snapshotPreference?.sidebarTextSize;
  const snapshotTranscriptTextSize = snapshotPreference?.transcriptTextSize;

  const [appearance, setAppearanceState] = useState<AppearanceState>(() => {
    const initial = snapshotPreference ?? readBridgedAppearance();
    return {
      ...initial,
      resolvedTheme: resolveTheme(initial.theme),
    };
  });

  // When the authoritative snapshot arrives or changes (e.g. another
  // window writes the TOML and our settings hook re-reads), adopt it.
  // We compare by value to avoid stomping local in-flight writes that
  // haven't been re-read yet.
  useEffect(() => {
    if (
      !snapshotDensity
      || !snapshotTheme
      || !snapshotSidebarTextSize
      || !snapshotTranscriptTextSize
    ) {
      return;
    }
    setAppearanceState((current) => {
      if (
        current.theme === snapshotTheme
        && current.density === snapshotDensity
        && current.sidebarTextSize === snapshotSidebarTextSize
        && current.transcriptTextSize === snapshotTranscriptTextSize
      ) {
        return current;
      }
      return {
        density: snapshotDensity,
        resolvedTheme: resolveTheme(snapshotTheme),
        sidebarTextSize: snapshotSidebarTextSize,
        transcriptTextSize: snapshotTranscriptTextSize,
        theme: snapshotTheme,
      };
    });
  }, [
    snapshotDensity,
    snapshotTheme,
    snapshotSidebarTextSize,
    snapshotTranscriptTextSize,
  ]);

  // Apply DOM attributes whenever the resolved appearance changes. No
  // localStorage cache to maintain — the source of truth is TOML, the
  // synchronous first-paint hint is the preload-bridged value.
  useEffect(() => {
    applyAppearanceAttributes(
      appearance.resolvedTheme,
      appearance.density,
      appearance.sidebarTextSize,
      appearance.transcriptTextSize,
    );
  }, [
    appearance.resolvedTheme,
    appearance.density,
    appearance.sidebarTextSize,
    appearance.transcriptTextSize,
  ]);

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

  // Hold a ref to writeConfig so setters don't need it in deps (it
  // changes identity on every settings render, which would otherwise
  // recreate the setters every frame).
  const writeConfigRef = useRef(writeConfig);
  useEffect(() => {
    writeConfigRef.current = writeConfig;
  }, [writeConfig]);

  /* Persist ONLY the axes the caller changed. Writing all four from
     this hook's React state would let a window whose snapshot is stale
     (a peer window changed a setting after our mount) silently revert
     the other axes on its next unrelated write — the multi-window
     appearance race. A partial patch also removes the four same-typed
     positional arguments that invited transposition. */
  const persist = useCallback((patch: Partial<AppearancePreference>) => {
    void writeConfigRef.current({
      general: { appearance: patch },
    });
  }, []);

  /* One keyed updater serves every axis: bail if unchanged, persist the
     single changed field, merge into state (theme also re-resolves). */
  const updateAxis = useCallback(
    <K extends keyof AppearancePreference>(
      key: K,
      value: AppearancePreference[K],
    ) => {
      setAppearanceState((current) => {
        if (current[key] === value) return current;
        persist({ [key]: value } as Partial<AppearancePreference>);
        const next = { ...current, [key]: value };
        if (key === "theme") {
          next.resolvedTheme = resolveTheme(value as ThemePreference);
        }
        return next;
      });
    },
    [persist],
  );

  const setTheme = useCallback(
    (theme: ThemePreference) => updateAxis("theme", theme),
    [updateAxis],
  );

  const setDensity = useCallback(
    (density: DensityPreference) => updateAxis("density", density),
    [updateAxis],
  );

  const setSidebarTextSize = useCallback(
    (sidebarTextSize: TextSizePreference) =>
      updateAxis("sidebarTextSize", sidebarTextSize),
    [updateAxis],
  );

  const setTranscriptTextSize = useCallback(
    (transcriptTextSize: TextSizePreference) =>
      updateAxis("transcriptTextSize", transcriptTextSize),
    [updateAxis],
  );

  const setAppearance = useCallback(
    (preference: AppearancePreference) => {
      setAppearanceState((current) => {
        if (
          current.theme === preference.theme
          && current.density === preference.density
          && current.sidebarTextSize === preference.sidebarTextSize
          && current.transcriptTextSize === preference.transcriptTextSize
        ) {
          return current;
        }
        // Full-object path (onboarding wizard): the caller is explicitly
        // asserting every axis, so a complete patch is the intent.
        persist(preference);
        return {
          ...preference,
          resolvedTheme: resolveTheme(preference.theme),
        };
      });
    },
    [persist],
  );

  return {
    appearance,
    setTheme,
    setDensity,
    setSidebarTextSize,
    setTranscriptTextSize,
    setAppearance,
  };
}

export { DEFAULT_APPEARANCE };
export type {
  ThemePreference,
  DensityPreference,
  ResolvedTheme,
  TextSizePreference,
};
