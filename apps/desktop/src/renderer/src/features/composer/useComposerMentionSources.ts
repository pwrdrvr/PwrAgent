import { useCallback, useEffect, useState } from "react";
import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * How long a fetched population stays good enough for an autocomplete.
 *
 * The popover is not a view of the thread list — it is a picker, and a
 * thread created in the last few seconds is not worth a bridge round trip
 * per keystroke. Long enough that one composing burst reuses a single
 * fetch, short enough that a card opened minutes later sees a list the
 * operator recognizes.
 */
const NAVIGATION_STALE_MS = 10_000;

type NavigationPopulation = {
  directories: readonly NavigationDirectorySummary[];
  threads: readonly NavigationThreadSummary[];
};

const EMPTY_POPULATION: NavigationPopulation = {
  directories: [],
  threads: [],
};

/**
 * Module-level, not per hook instance: the star map can have a dozen chat
 * cards open, every one of them able to open an `@` or `#` popover, and
 * every one of them wants the same local snapshot. A per-card fetch would
 * turn one operator typing `@` into N identical bridge calls.
 */
let cachedPopulation: NavigationPopulation | undefined;
let cachedAt = 0;
let inFlight: Promise<void> | undefined;
const subscribers = new Set<(population: NavigationPopulation) => void>();

/** Test seam: drop the shared cache so specs do not leak into each other. */
export function resetComposerMentionSourcesCache(): void {
  cachedPopulation = undefined;
  cachedAt = 0;
  inFlight = undefined;
}

async function loadPopulation(desktopApi: DesktopApi | undefined): Promise<void> {
  const getNavigationSnapshot = desktopApi?.getNavigationSnapshot;
  if (!getNavigationSnapshot) {
    return;
  }

  try {
    const snapshot = await getNavigationSnapshot();
    cachedPopulation = {
      directories: snapshot.directories,
      threads: snapshot.threads,
    };
    cachedAt = Date.now();
    for (const subscriber of subscribers) {
      subscriber(cachedPopulation);
    }
  } catch {
    // A failed load leaves the popover with whatever it already had. An
    // autocomplete that cannot reach the bridge should offer nothing and
    // let the trigger stay literal, not raise an error over a transcript.
  }
}

/**
 * The tracked directories and local threads a compact composer's `@` and
 * `#` popovers pick from.
 *
 * Deliberately lazy and deliberately shared. Lazy because a chat card that
 * never types a trigger should cost nothing beyond its transcript; shared
 * because several cards are open at once and they all want one snapshot.
 * `ensureLoaded` is what a popover calls when it opens — the hook itself
 * fetches nothing on mount.
 *
 * Skills are NOT served from here. They are scoped to a thread's linked
 * directories, so two cards genuinely have different skill lists and
 * `useThreadSkills` already owns that per-thread fetch and its
 * `skills/changed` invalidation.
 */
export function useComposerMentionSources(params: {
  desktopApi?: DesktopApi;
}): {
  directories: readonly NavigationDirectorySummary[];
  ensureLoaded: () => void;
  threads: readonly NavigationThreadSummary[];
} {
  const { desktopApi } = params;
  const [population, setPopulation] = useState<NavigationPopulation>(
    () => cachedPopulation ?? EMPTY_POPULATION,
  );

  useEffect(() => {
    const subscriber = (next: NavigationPopulation): void => {
      setPopulation(next);
    };
    subscribers.add(subscriber);
    // A card mounted after another already loaded starts from the cache
    // rather than waiting for the next `ensureLoaded`.
    if (cachedPopulation) {
      setPopulation(cachedPopulation);
    }
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const ensureLoaded = useCallback((): void => {
    if (inFlight || Date.now() - cachedAt < NAVIGATION_STALE_MS) {
      return;
    }
    inFlight = loadPopulation(desktopApi).finally(() => {
      inFlight = undefined;
    });
  }, [desktopApi]);

  return {
    directories: population.directories,
    ensureLoaded,
    threads: population.threads,
  };
}
