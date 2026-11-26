import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Demand-driven catalog hook for transcript Markdown. Keeps a stable plugin
 * configuration across streaming chunks and only loads/re-renders once if a
 * prose text node encounters an unresolved boundary-safe `:shortcode:` before
 * the full catalog has been cached.
 */
export function useDeferredEmojiShortcodeCatalog(): {
  catalog: ReactionEmojiCatalog | undefined;
  requestCatalog: () => void;
} {
  const [catalog, setCatalog] = useState<ReactionEmojiCatalog | undefined>(() =>
    getCachedEmojiCatalog(),
  );
  const mountedRef = useRef(true);
  const requestedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    if (requestedRef.current && !catalog) {
      const cached = getCachedEmojiCatalog();
      if (cached) {
        setCatalog(cached);
      }
    }
    return () => {
      mountedRef.current = false;
    };
  }, [catalog]);

  const requestCatalog = useCallback(() => {
    if (requestedRef.current || getCachedEmojiCatalog()) {
      return;
    }
    requestedRef.current = true;
    void loadEmojiCatalog()
      .then((loaded) => {
        if (mountedRef.current) {
          setCatalog(loaded);
        }
      })
      .catch(() => {
        requestedRef.current = false;
      });
  }, []);

  return { catalog, requestCatalog };
}
