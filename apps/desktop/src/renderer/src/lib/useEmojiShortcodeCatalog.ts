import { useEffect, useState } from "react";
import type { ReactionEmojiCatalog } from "../features/navigation/reaction-emoji-catalog";
import { getCachedEmojiCatalog, loadEmojiCatalog } from "./emoji-shortcodes";

/**
 * Lazily warms the full Unicode emoji catalog when `active` is true, without
 * importing the dataset into the startup bundle or forcing unrelated surfaces
 * to re-render when another component loads it.
 */
export function useEmojiShortcodeCatalog(
  active: boolean,
): ReactionEmojiCatalog | undefined {
  const [catalog, setCatalog] = useState<ReactionEmojiCatalog | undefined>(() =>
    active ? getCachedEmojiCatalog() : undefined,
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const cached = getCachedEmojiCatalog();
    if (cached) {
      setCatalog(cached);
      return;
    }
    let cancelled = false;
    void loadEmojiCatalog()
      .then((loaded) => {
        if (!cancelled) {
          setCatalog(loaded);
        }
      })
      .catch(() => {
        // Keep base shortcodes usable; next activation retries.
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return active ? (catalog ?? getCachedEmojiCatalog()) : undefined;
}
