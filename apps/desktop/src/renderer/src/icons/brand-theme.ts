import { useSyncExternalStore } from "react";

/**
 * Resolved PwrAgent theme, for brand assets that ship one file per
 * colorway instead of a recolorable glyph.
 *
 * Vendor brand guidelines (Mattermost, GitHub, Git) forbid recoloring the
 * mark, so those icons cannot follow `currentColor` — they pick between
 * the vendor's own published variants. That choice needs the live theme,
 * and the theme lives on `<html data-theme>`: `light` when the light
 * theme is active, and the attribute is removed entirely for dark (see
 * `lib/appearance.ts`). This module is the one subscription all of those
 * icons share.
 */
export type BrandTheme = "light" | "dark";

/**
 * Pass `enabled: false` when the caller has an explicit variant and cannot
 * use the answer. A fixed-variant icon that still subscribed would add a
 * listener to the shared set and hold the document-wide MutationObserver
 * open for a value it ignores.
 */
export function useBrandTheme(enabled = true): BrandTheme {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeToNothing,
    readBrandTheme,
    readServerBrandTheme,
  );
}

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribeToNothing(_listener: () => void): () => void {
  return () => undefined;
}

function subscribe(listener: () => void): () => void {
  if (
    typeof document === "undefined"
    || typeof MutationObserver === "undefined"
  ) {
    return subscribeToNothing(listener);
  }

  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

function readBrandTheme(): BrandTheme {
  return typeof document !== "undefined"
    && document.documentElement.dataset.theme === "light"
    ? "light"
    : "dark";
}

/**
 * Dark is the base theme — `:root` in `app.css` is the dark palette and
 * light is the `[data-theme="light"]` override — so a render with no DOM
 * to read resolves dark.
 */
function readServerBrandTheme(): BrandTheme {
  return "dark";
}
